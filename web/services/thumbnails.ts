// Thumbnails the browser renders when the host's cache has none: an image
// decoded and scaled down, a video's frame grabbed, each encoded small and
// handed to the host to keep (docs/architecture.md's Space identity and state
// ownership). The browser is pragma's decoder of record — the protocol lists as
// media only what one decodes — so every picture a gallery shows is made here.
//
// Two queues, because the two costs differ: an image is a whole download
// and a full decode, a video a seek over byte ranges and one frame.
import { THUMBNAIL_MAX_EDGE } from "../../src/protocol/types.ts";

export interface ThumbnailTarget {
  path: string;
  /** The file's version in its folder listing, named back on upload. */
  version: string;
  kind: "image" | "video";
}

/** A rendered thumbnail and what the browser decoded of its file: the size
 * it displays at, and a video's length when it has one. */
export interface RenderedThumbnail {
  image: Blob;
  width: number;
  height: number;
  duration?: number;
}

export interface ThumbnailJob {
  /** The rendered thumbnail; rejects with an AbortError once cancelled. */
  readonly result: Promise<RenderedThumbnail>;
  /** Drops a job still waiting, and stops one under way. */
  cancel(): void;
}

export interface ThumbnailRenderer {
  render(target: ThumbnailTarget): ThumbnailJob;
}

export interface ThumbnailRendererDeps {
  rawFileUrl(path: string): string;
  upload(path: string, version: string, rendered: RenderedThumbnail): Promise<void>;
}

/** `width`×`height` scaled to fit within `edge` on both sides, never up. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Seconds into a clip the frame comes from: far enough to clear a fade from
// black, near enough to the start to be the shot a person remembers.
export function frameTime(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration * 0.1, 10) : 0;
}

const abortError = () => new DOMException("Thumbnail cancelled", "AbortError");

// WebP where the canvas can encode it, JPEG where it can't: a canvas asked
// for a type it doesn't support quietly hands back PNG, which the host
// refuses.
async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const toBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await toBlob("image/webp", 0.82);
  if (webp?.type === "image/webp") return webp;
  const jpeg = await toBlob("image/jpeg", 0.85);
  if (!jpeg) throw new Error("This browser can't encode a thumbnail");
  return jpeg;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas to render a thumbnail on");
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

// The full decode and the resize are both createImageBitmap calls, which a
// browser runs off the page's thread; only the small draw happens on it.
async function renderImage(url: string, signal: AbortSignal): Promise<RenderedThumbnail> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Couldn't read the image (${response.status})`);
  const full = await createImageBitmap(await response.blob());
  try {
    if (signal.aborted) throw abortError();
    const size = fitWithin(full.width, full.height, THUMBNAIL_MAX_EDGE);
    const small = await createImageBitmap(full, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: "high",
    });
    const { canvas, context } = canvasOf(size.width, size.height);
    context.drawImage(small, 0, 0);
    small.close();
    return { image: await encode(canvas), width: full.width, height: full.height };
  } finally {
    full.close();
  }
}

const VIDEO_TIMEOUT_MS = 20_000;

// A detached, muted player reading the clip in ranges: its header, then the
// stretch around one frame. Only the header is preloaded, and the clip is let
// go the moment its frame is drawn: a player left to buffer reads on ahead,
// a short clip whole, for a frame it already has. A codec the browser can't
// decode errors here the same way it does in the video pane.
function renderVideo(url: string, signal: AbortSignal): Promise<RenderedThumbnail> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The video took too long to show a frame")), VIDEO_TIMEOUT_MS);

    // Dropping the source is what releases the decoder and the connection.
    function release(): void {
      video.removeAttribute("src");
      video.load();
    }

    function finish(outcome: Error | RenderedThumbnail): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      release();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    }
    const onAbort = () => finish(abortError());
    signal.addEventListener("abort", onAbort);

    function draw(): void {
      const { videoWidth: width, videoHeight: height, duration } = video;
      const size = fitWithin(width, height, THUMBNAIL_MAX_EDGE);
      const { canvas, context } = canvasOf(size.width, size.height);
      context.drawImage(video, 0, 0, size.width, size.height);
      release();
      encode(canvas).then(
        (image) => finish({ image, width, height, ...(Number.isFinite(duration) ? { duration } : {}) }),
        finish,
      );
    }

    video.addEventListener("error", () => finish(new Error("This browser can't play this video's format")));
    // Sought even to its first frame: the header carries no frame, and a
    // seek is what asks for one.
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.addEventListener("seeked", draw, { once: true });
        video.currentTime = frameTime(video.duration);
      },
      { once: true },
    );
    video.src = url;
  });
}

interface Queued {
  target: ThumbnailTarget;
  controller: AbortController;
  resolve(rendered: RenderedThumbnail): void;
  reject(error: unknown): void;
}

function createLane(limit: number, run: (target: ThumbnailTarget, signal: AbortSignal) => Promise<RenderedThumbnail>) {
  const waiting: Queued[] = [];
  let running = 0;

  function pump(): void {
    while (running < limit && waiting.length > 0) {
      const job = waiting.shift() as Queued;
      running++;
      run(job.target, job.controller.signal)
        .then(job.resolve, job.reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    add(job: Queued): void {
      waiting.push(job);
      pump();
    },
    drop(job: Queued): boolean {
      const index = waiting.indexOf(job);
      if (index === -1) return false;
      waiting.splice(index, 1);
      return true;
    },
  };
}

// Two images at a time: each holds a full-resolution decode until it is
// scaled, so more would trade memory for little. One video: a seek is
// mostly waiting on the network, and players are heavy.
export function createThumbnailRenderer(deps: ThumbnailRendererDeps): ThumbnailRenderer {
  const lanes = {
    image: createLane(2, (target, signal) => renderImage(deps.rawFileUrl(target.path), signal)),
    video: createLane(1, (target, signal) => renderVideo(deps.rawFileUrl(target.path), signal)),
  };

  return {
    render(target) {
      const lane = lanes[target.kind];
      let resolve: (rendered: RenderedThumbnail) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const result = new Promise<RenderedThumbnail>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
      const queued: Queued = { target, controller: new AbortController(), resolve, reject };
      lane.add(queued);
      // Kept even when nothing on screen still wants it: the next visit to
      // this folder, from any device, gets it from the host instead.
      result.then(
        (rendered) => deps.upload(target.path, target.version, rendered).catch(() => undefined),
        () => undefined,
      );
      return {
        result,
        cancel() {
          if (lane.drop(queued)) queued.reject(abortError());
          else queued.controller.abort();
        },
      };
    },
  };
}
