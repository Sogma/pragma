// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThumbnailRenderer, fitWithin, frameTime } from "../../../web/services/thumbnails.ts";

describe("sizing", () => {
  it("fits the longest edge within the limit, and never enlarges", () => {
    expect(fitWithin(6000, 4000, 512)).toEqual({ width: 512, height: 341 });
    expect(fitWithin(1080, 1920, 512)).toEqual({ width: 288, height: 512 });
    expect(fitWithin(200, 100, 512)).toEqual({ width: 200, height: 100 });
    expect(fitWithin(10_000, 1, 512)).toEqual({ width: 512, height: 1 });
  });

  it("takes a clip's frame a tenth in, no later than ten seconds", () => {
    expect(frameTime(5)).toBe(0.5);
    expect(frameTime(3600)).toBe(10);
    expect(frameTime(Number.NaN)).toBe(0);
    expect(frameTime(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// jsdom decodes and encodes nothing: the bitmap, the canvas and its encoder
// stand in, each recording what it was asked for.
describe("the renderer", () => {
  let encodes: string[];
  let encodable: Set<string>;

  beforeEach(() => {
    encodes = [];
    encodable = new Set(["image/webp", "image/jpeg"]);
    globalThis.createImageBitmap = vi.fn(async (_source: unknown, options?: ImageBitmapOptions) => ({
      width: options?.resizeWidth ?? 4000,
      height: options?.resizeHeight ?? 3000,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      encodes.push(type ?? "");
      callback(new Blob(["pixels"], { type: encodable.has(type ?? "") ? type : "image/png" }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const image = { path: "lib:footage/frame.png", version: "1-9", kind: "image" as const };

  function renderer(fetchImpl: typeof fetch = async () => new Response(new Blob(["bytes"]))) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    const upload = vi.fn(async () => undefined);
    return { renderer: createThumbnailRenderer({ rawFileUrl: (path) => `/raw?path=${path}`, upload }), upload };
  }

  it("scales an image to fit, encodes it as WebP, and hands it to the host with its size", async () => {
    const { renderer: thumbnails, upload } = renderer();
    const rendered = await thumbnails.render(image).result;

    expect(fetch).toHaveBeenCalledWith("/raw?path=lib:footage/frame.png", expect.anything());
    expect(createImageBitmap).toHaveBeenLastCalledWith(expect.anything(), {
      resizeWidth: 512,
      resizeHeight: 384,
      resizeQuality: "high",
    });
    expect(rendered).toEqual({ image: expect.any(Blob), width: 4000, height: 3000 });
    expect(rendered.image.type).toBe("image/webp");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledWith("lib:footage/frame.png", "1-9", rendered));
  });

  // A canvas that can't encode WebP hands back PNG, which the host refuses.
  it("falls back to JPEG where WebP can't be encoded", async () => {
    encodable.delete("image/webp");
    const { renderer: thumbnails } = renderer();
    const { image: encoded } = await thumbnails.render(image).result;
    expect(encodes).toEqual(["image/webp", "image/jpeg"]);
    expect(encoded.type).toBe("image/jpeg");
  });

  it("runs two images at a time, and drops a waiting one that is cancelled", async () => {
    const started: string[] = [];
    const { renderer: thumbnails, upload } = renderer(
      (input, init) =>
        new Promise((_, reject) => {
          started.push(String(input));
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const jobs = ["a", "b", "c"].map((name) => thumbnails.render({ ...image, path: name }));
    expect(started).toEqual(["/raw?path=a", "/raw?path=b"]);

    jobs[2].cancel();
    await expect(jobs[2].result).rejects.toThrow("cancelled");
    jobs[0].cancel();
    await expect(jobs[0].result).rejects.toThrow("aborted");
    expect(started).toEqual(["/raw?path=a", "/raw?path=b"]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports a file it couldn't read, and stores nothing", async () => {
    const { renderer: thumbnails, upload } = renderer(async () => new Response(null, { status: 404 }));
    await expect(thumbnails.render(image).result).rejects.toThrow("404");
    expect(upload).not.toHaveBeenCalled();
  });

  // jsdom plays nothing: the clip's header is stood in for, and its events
  // are sent by hand. Each seek is recorded.
  function clipPlayer(header: { duration: number; width: number; height: number }) {
    const created: HTMLVideoElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (element instanceof HTMLVideoElement) created.push(element);
      return element;
    }) as typeof document.createElement);
    const seeks: number[] = [];
    const video = () => {
      const [clip] = created;
      Object.defineProperty(clip, "duration", { value: header.duration, configurable: true });
      Object.defineProperty(clip, "videoWidth", { value: header.width, configurable: true });
      Object.defineProperty(clip, "videoHeight", { value: header.height, configurable: true });
      Object.defineProperty(clip, "currentTime", {
        get: () => seeks.at(-1) ?? 0,
        set: (time: number) => seeks.push(time),
        configurable: true,
      });
      return clip;
    };
    return { video, seeks };
  }

  const clip = { path: "lib:takes/a.mp4", version: "1-9", kind: "video" as const };

  it("reads only a clip's header, seeks a tenth in, and lets the clip go before encoding its frame", async () => {
    const { video, seeks } = clipPlayer({ duration: 64, width: 1920, height: 1080 });
    const { renderer: thumbnails, upload } = renderer();
    const job = thumbnails.render(clip);
    const player = video();
    expect(player.preload).toBe("metadata");
    expect(player.getAttribute("src")).toBe("/raw?path=lib:takes/a.mp4");

    player.dispatchEvent(new Event("loadedmetadata"));
    expect(seeks).toEqual([6.4]);
    let sourceAtEncode: string | null = "";
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      sourceAtEncode = player.getAttribute("src");
      callback(new Blob(["pixels"], { type }));
    });
    player.dispatchEvent(new Event("seeked"));

    const rendered = await job.result;
    expect(sourceAtEncode).toBeNull();
    expect(rendered).toEqual({ image: expect.any(Blob), width: 1920, height: 1080, duration: 64 });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledWith("lib:takes/a.mp4", "1-9", rendered));
  });

  it("seeks to the first frame of a clip whose header names no length, and gives none", async () => {
    const { video, seeks } = clipPlayer({ duration: Number.POSITIVE_INFINITY, width: 320, height: 180 });
    const { renderer: thumbnails } = renderer();
    const job = thumbnails.render(clip);
    const player = video();

    player.dispatchEvent(new Event("loadedmetadata"));
    expect(seeks).toEqual([0]);
    player.dispatchEvent(new Event("seeked"));
    expect(await job.result).toEqual({ image: expect.any(Blob), width: 320, height: 180 });
  });

  it("reports a clip the browser can't play, and stores nothing", async () => {
    const { video } = clipPlayer({ duration: 12, width: 1920, height: 1080 });
    const { renderer: thumbnails, upload } = renderer();
    const job = thumbnails.render(clip);
    video().dispatchEvent(new Event("error"));
    await expect(job.result).rejects.toThrow("This browser can't play this video's format");
    expect(upload).not.toHaveBeenCalled();
  });
});
