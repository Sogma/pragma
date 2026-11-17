// The media panes: an image preview and a video player, one family whose
// content is bytes, pointed straight at the raw-file route instead of
// fetched as JSON. Neither is editable, and neither has a reading view to
// toggle: the reading view *is* what they render.
//
// The hover overlay of glanceable facts is two bars on an image but one
// along a video's top edge, since the player's controls take the bottom on
// hover; the player sits in a stage element its overlay is positioned against.
import { basenameOf } from "../../../src/protocol/rootedPath.ts";
import { vectorImageMediaTypeForPath } from "../../../src/protocol/types.ts";
import {
  type ClipHeaderResponse,
  fetchFileRaw,
  getPixelFormat,
  getVideoFormat,
  headFileRaw,
  type PixelFormatResponse,
  rawFileUrl,
} from "../../core/apiClient.ts";
import { wireEntryDrag } from "../../core/paths.ts";
import {
  appendMetaRow,
  createInspectorSection,
  formatDimensions,
  formatDuration,
  formatFileSize,
  formatFrameRate,
  must,
} from "../../lib/dom.ts";
import {
  bitDepthText,
  clipDetailRows,
  colorModeName,
  pictureDetailRows,
  pixelFormatText,
} from "../../lib/mediaDetails.ts";
import { hudCells, hudFits, hudRoot, lookBadge, mediaFrame, showTransparency } from "../../lib/mediaHud.ts";
import { dragToScroll, keepClickedPoint, shownPercent, zoomFrom } from "../../lib/pictureZoom.ts";
import { describeLoaded, readSvgStandInSize } from "../../lib/svgSize.ts";
import type { GuidesChoice } from "../../lib/videoGuides.ts";
import type { LutChoice } from "../../lib/videoLut.ts";
import { createVideoPlayer, type LoopChoice, type VideoPlayer, type VolumeChoice } from "../../lib/videoPlayer.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import type { ContextMenuService } from "../../services/menus.ts";
import { videoGuides, videoLoop, videoLut, videoVolume } from "../../services/settings.ts";
import { videoMoreOptions } from "../../services/videoMenu.ts";

export interface MediaPaneDeps {
  // The raw-file route: a `src` for the bytes, and a HEAD against the same
  // URL — its Content-Length is the image overlay's size, and it tells a
  // file that is gone from one the player cannot decode.
  rawFileUrl: (path: string) => string;
  headFile: (path: string) => Promise<Response>;
}

export interface ImagePaneDeps extends MediaPaneDeps {
  // Color model and bit depth, read from the file's header by the server.
  pixelFormat: (path: string) => Promise<PixelFormatResponse>;
  // A GET against the raw-file route, for an SVG's own text.
  fetchFile: (path: string) => Promise<Response>;
}

export interface VideoPaneDeps extends MediaPaneDeps {
  // Codec and frame rate, read from the container's header by the server.
  videoFormat: (path: string) => Promise<ClipHeaderResponse>;
  loop: LoopChoice;
  volume: VolumeChoice;
  guides: GuidesChoice;
  lut: LutChoice;
  // Where the player's More options menu opens.
  contextMenu: ContextMenuService;
}

const CHROME = { toolbar: false, readingView: false, statusbar: true, actions: [] } as const;

/** The pane's Info-tab section: the facts only the loaded bytes can answer.
 * Size, modified time and SHA-256 are the Info tab's own, for every kind. The
 * rows are created up front, empty, so whichever lookup finishes first cannot
 * decide the order they appear in. Returns each one's value element, by
 * label. */
function fillDetails(body: HTMLElement, labels: readonly string[]): Map<string, HTMLElement> {
  body.replaceChildren();
  const values = new Map<string, HTMLElement>();
  for (const label of labels) values.set(label, appendMetaRow(body, label, "…"));
  return values;
}

function detailsSection(title: string): { section: HTMLElement; body: HTMLElement } {
  const details = createInspectorSection(title);
  details.body.className = "meta-rows";
  return details;
}

/** A HEAD against the URL the element already points at: whether the file
 * is there at all — the one thing the element's own error event cannot tell
 * apart from bytes it cannot decode. A network failure is no answer, which
 * counts as there: it says nothing about the file. */
async function headOf(deps: MediaPaneDeps, path: string): Promise<Response | undefined> {
  try {
    return await deps.headFile(path);
  } catch {
    return undefined;
  }
}

// The routes are bound here, not handed in by the bootstrap: they are all
// either pane needs from the app. The pane factories still take them as
// deps, for tests.
export function imagePane(): EditorPaneDescriptor {
  const deps = { rawFileUrl, headFile: headFileRaw, pixelFormat: getPixelFormat, fetchFile: fetchFileRaw };
  return { kind: "image", chrome: CHROME, create: () => createImagePane(deps) };
}

export function videoPane(contextMenu: ContextMenuService): EditorPaneDescriptor {
  const deps = {
    rawFileUrl,
    headFile: headFileRaw,
    videoFormat: getVideoFormat,
    loop: videoLoop,
    volume: videoVolume,
    guides: videoGuides,
    lut: videoLut,
    contextMenu,
  };
  return { kind: "video", chrome: CHROME, create: () => createVideoPane(deps) };
}

/** The image's overlay: dimensions, display scale and color mode along the
 * top edge, file name and size along the bottom. */
function createImageHud() {
  const [name, size, dimensions, mode, scale] = hudCells(5);
  name.className = "media-hud-name";
  const root = hudRoot([dimensions, scale, mode], [name, size]);
  return { root, name, size, dimensions, mode, scale };
}

/** The video's overlay: dimensions, codec, display scale, the LOOK badge
 * once a look has been picked, and frame rate, along the top edge only. The
 * player's own controls show the duration. */
function createVideoHud(lut: LutChoice) {
  const [dimensions, codec, scale, frameRate] = hudCells(4);
  const look = lookBadge(lut);
  const root = hudRoot([dimensions, codec, scale, look.element, frameRate]);
  return { root, dimensions, codec, frameRate, look, scale };
}

// The display scale beside the facts, as a whole percent, and whether the
// media is shown big enough to carry the bars at all. The scale counts CSS
// pixels, the way a browser's own image view does.
function measureScaledHud(
  hud: { root: HTMLElement; scale: HTMLElement },
  media: HTMLElement,
  naturalWidth: number,
): number | undefined {
  if (!naturalWidth) return undefined; // not decoded yet
  const shown = media.getBoundingClientRect();
  hud.root.hidden = !hudFits(shown.width, shown.height);
  const percent = shownPercent(shown.width, naturalWidth);
  hud.scale.textContent = `${percent}%`;
  return percent;
}

export function createImagePane(deps: ImagePaneDeps): EditorPane {
  const element = document.createElement("div");
  element.className = "editor-image";
  // The bars ride in the picture's own frame. At actual size they stick to
  // the scroller's edges (web/styles/media-panes.css), so they stay in view
  // while the picture scrolls beneath them.
  const scroller = document.createElement("div");
  scroller.className = "editor-image-scroller";
  const details = detailsSection("Image");
  const detailsTitle = must<HTMLElement>(".inspector-section-title", details.section);
  const hud = createImageHud();
  let shown: HTMLImageElement | undefined;
  // The width the picture counts as at 100%: its own, or an SVG's stand-in.
  let fullWidth = 0;
  // A click shows a shrunk picture at 100% and the next one fits it again.
  let actualSize = false;
  let zoomable = false;
  // Ends the zoom still running, where it was going.
  let settleZoom: (() => void) | undefined;

  // The picture is centred, so a resize moves it even when its own size
  // holds; the observer is on the scroller for that reason, not the image,
  // and its content box also narrows when a scrollbar appears.
  const place = () => {
    if (!shown) return;
    const percent = measureScaledHud(hud, shown, fullWidth);
    zoomable = !actualSize && percent !== undefined && percent < 100;
    element.classList.toggle("is-zoomable", zoomable);
  };
  const resize = new ResizeObserver(place);
  resize.observe(scroller);
  // Only the picture is grabbed: the margin around it keeps the arrow.
  dragToScroll(scroller, (event) => actualSize && !settleZoom && event.target === shown);

  const setActualSize = (on: boolean) => {
    actualSize = on;
    zoomable = false; // until the next place() measures the new picture
    element.classList.toggle("is-actual-size", on);
    element.classList.remove("is-zoomable");
  };

  // A click acts on the picture as it will stand, so a zoom still running
  // ends first. While one runs, the picture moves by a transform over the
  // layout it ends in, and its overlay and scrollbars wait for it.
  const toggleActualSize = (img: HTMLImageElement, event: MouseEvent) => {
    settleZoom?.();
    if (!actualSize && !zoomable) return;
    const before = img.getBoundingClientRect();
    element.classList.add("is-zooming");
    setActualSize(!actualSize);
    if (actualSize) keepClickedPoint(img, before, scroller, event);
    settleZoom = zoomFrom(img, before, () => {
      settleZoom = undefined;
      element.classList.remove("is-zooming");
      place();
    });
  };

  return {
    kind: "image",
    element,
    inspector: details.section,
    async setInput(tab, ctx) {
      if (tab.kind !== "image") throw new Error(`the image pane can't show a "${tab.kind}" tab`);
      settleZoom?.();
      element.replaceChildren();
      setActualSize(false);

      // A vector image has no pixel format, so it gets no rows for one.
      const raster = vectorImageMediaTypeForPath(tab.path) === undefined;
      detailsTitle.textContent = raster ? "Image" : "Vector image";
      const values = fillDetails(details.body, raster ? ["Dimensions", "Color mode", "Bit depth"] : ["Dimensions"]);
      details.section.hidden = false;

      const name = basenameOf(tab.path);
      hud.root.hidden = true;
      hud.name.textContent = name;
      for (const cell of [hud.size, hud.dimensions, hud.mode, hud.scale]) cell.textContent = "";

      const img = document.createElement("img");
      img.src = deps.rawFileUrl(tab.path);
      img.alt = name;
      showTransparency(img, tab.path);
      shown = img;
      fullWidth = 0;
      const standIn = raster ? undefined : readSvgStandInSize(deps.fetchFile, tab.path);
      describeLoaded(img, standIn, (width, height) => {
        if (!ctx.isCurrent()) return; // the pane moved on before the bytes arrived
        fullWidth = width;
        const dimensions = values.get("Dimensions");
        if (dimensions) dimensions.textContent = formatDimensions(width, height);
        hud.dimensions.textContent = formatDimensions(width, height, "");
        place();
      });
      img.addEventListener("click", (event) => toggleActualSize(img, event));
      wireEntryDrag(img, () => ({ path: tab.path, type: "file" }));
      // Measured again as the overlay is about to show, so a layout change no
      // observer saw can't leave it showing a stale scale.
      img.addEventListener("pointerenter", place);
      // The overlay follows the image: `.media-frame > img:hover + .media-hud`.
      scroller.replaceChildren(mediaFrame(img, hud.root, "editor-image-frame"));
      element.append(scroller);

      // A missing or failed answer leaves the size out; the Info tab has
      // its own lookup and says so there.
      deps.headFile(tab.path).then(
        (response) => {
          const length = response.headers.get("content-length");
          if (ctx.isCurrent() && response.ok && length !== null) hud.size.textContent = formatFileSize(Number(length));
        },
        () => {},
      );

      if (!raster) return;
      const colorMode = values.get("Color mode");
      const bitDepth = values.get("Bit depth");
      deps.pixelFormat(tab.path).then(
        (format) => {
          if (!ctx.isCurrent()) return;
          if (colorMode) colorMode.textContent = colorModeName(format);
          if (bitDepth)
            bitDepth.textContent = bitDepthText(format.bitDepth, format.colorModel === "indexed" ? "pixel" : "channel");
          hud.mode.textContent = pixelFormatText(format);
          for (const row of pictureDetailRows(format)) appendMetaRow(details.body, row.label, row.value);
        },
        () => {
          if (!ctx.isCurrent()) return;
          if (colorMode) colorMode.textContent = "Unknown";
          if (bitDepth) bitDepth.textContent = "Unknown";
        },
      );
    },
    clearInput: () => {
      settleZoom?.();
      shown = undefined;
      fullWidth = 0;
      setActualSize(false);
      element.replaceChildren();
      details.body.replaceChildren();
      details.section.hidden = true;
    },
    title: () => undefined, // the tab names it; no title bar
    dispose: () => {
      resize.disconnect();
      element.remove();
    },
  };
}

export function createVideoPane(deps: VideoPaneDeps): EditorPane {
  const element = document.createElement("div");
  element.className = "editor-video";
  const details = detailsSection("Video");
  const hud = createVideoHud(deps.lut);
  let mounted: HTMLVideoElement | undefined;
  let player: VideoPlayer | undefined;

  // The player's keys go to the pane, so a press anywhere in it, a control's
  // included, puts focus here.
  element.tabIndex = 0;
  element.addEventListener("pointerdown", () => element.focus({ preventScroll: true }));
  element.addEventListener("keydown", (event) => {
    if (event.target !== element || event.metaKey || event.ctrlKey || event.altKey) return;
    if (player?.key(event.key)) event.preventDefault();
  });

  // As the image's: the player is centred, so the observer is on the pane.
  const place = () => {
    if (mounted) measureScaledHud(hud, mounted, mounted.videoWidth);
  };
  const resize = new ResizeObserver(place);
  resize.observe(element);

  // Taking the element out of the DOM is not enough to guarantee the sound
  // stops, and a clip still audible after its tab was switched away from is
  // the failure that costs the most trust. Dropping the source is what
  // releases the decoder and the connection the player still holds open.
  function stop(): void {
    player?.dispose();
    player = undefined;
    if (!mounted) return;
    mounted.pause();
    mounted.removeAttribute("src");
    mounted.load();
    mounted = undefined;
  }

  return {
    kind: "video",
    element,
    inspector: details.section,
    async setInput(tab, ctx) {
      if (tab.kind !== "video") throw new Error(`the video pane can't show a "${tab.kind}" tab`);
      stop();
      element.replaceChildren();

      const values = fillDetails(details.body, ["Dimensions", "Duration", "Frame rate", "Codec"]);
      details.section.hidden = false;
      hud.root.hidden = true;
      for (const cell of [hud.dimensions, hud.codec, hud.frameRate, hud.scale]) cell.textContent = "";

      const video = document.createElement("video");
      // Metadata only. Opening a tab costs a header, not the clip; the
      // player asks for the rest as it plays, in ranges.
      video.preload = "metadata";
      video.src = deps.rawFileUrl(tab.path);
      mounted = video;
      player = createVideoPlayer(video, {
        layout: "review",
        loop: deps.loop,
        volume: deps.volume,
        guides: deps.guides,
        lut: deps.lut,
        rangeKey: tab.path,
        moreOptions: videoMoreOptions(deps.contextMenu, tab.path),
      });
      // The overlay follows the player: `video:hover + .media-hud`.
      const frame = mediaFrame(video, hud.root, "editor-video-stage");
      frame.append(player.element);
      element.append(frame);

      // An extension names a container, never a codec, so a file the tree
      // lists and the route serves can still be undecodable here — ProRes
      // or HEVC inside a `.mov` is the ordinary case, not an exotic one.
      // Saying so beats a blank player, and the codec, once the header read
      // names it, goes into the message: it is the reason.
      //
      // The element's error event says the same for a file that is simply
      // gone (a tab restored after the file was deleted), so the HEAD below
      // gets the last word on which of the two it was.
      const failure = document.createElement("p");
      failure.className = "editor-video-error inline-error";
      failure.hidden = true;
      element.append(failure);
      let codec: string | null = null;
      let unplayable = false;
      const unplayableText = () =>
        `This browser can't play ${codec ? `${codec} video` : "this video's format"}. The file itself is untouched.`;
      // The codec and frame rate come from the header, which reads fine when
      // the picture doesn't; so do the size and length of a clip the browser
      // can't decode, whichever of the two answers comes first.
      let header: ClipHeaderResponse | undefined;
      const fromHeader = () => {
        const dimensions = values.get("Dimensions");
        const duration = values.get("Duration");
        if (dimensions) {
          dimensions.textContent =
            header?.width && header.height ? formatDimensions(header.width, header.height) : "Unknown";
        }
        if (duration) duration.textContent = header?.duration ? formatDuration(header.duration) : "Unknown";
      };
      const dash = () => {
        fromHeader();
        hud.root.hidden = true;
      };

      video.addEventListener("loadedmetadata", () => {
        if (!ctx.isCurrent()) return; // the pane moved on before the header arrived
        const dimensions = values.get("Dimensions");
        if (dimensions) dimensions.textContent = formatDimensions(video.videoWidth, video.videoHeight);
        const duration = values.get("Duration");
        if (duration) duration.textContent = formatDuration(video.duration);
        hud.dimensions.textContent = formatDimensions(video.videoWidth, video.videoHeight, "");
        place();
      });
      // A stream can change its frame size mid-clip.
      video.addEventListener("resize", () => {
        if (ctx.isCurrent()) place();
      });
      video.addEventListener("error", () => {
        if (!ctx.isCurrent() || !failure.hidden) return;
        unplayable = true;
        failure.textContent = unplayableText();
        failure.hidden = false;
        dash();
      });

      const frameRate = values.get("Frame rate");
      const codecRow = values.get("Codec");
      deps.videoFormat(tab.path).then(
        (format) => {
          if (!ctx.isCurrent()) return;
          codec = format.codec;
          header = format;
          if (unplayable) fromHeader();
          player?.setFrameRate(format.frameRate);
          if (codecRow) codecRow.textContent = format.codec ?? "Unknown";
          if (frameRate) frameRate.textContent = formatFrameRate(format) ?? "Unknown";
          hud.codec.textContent = format.codec ?? "";
          hud.frameRate.textContent = formatFrameRate(format) ?? "";
          if (unplayable) failure.textContent = unplayableText();
          for (const row of clipDetailRows(format)) appendMetaRow(details.body, row.label, row.value);
        },
        () => {
          if (!ctx.isCurrent()) return;
          if (codecRow) codecRow.textContent = "Unknown";
          if (frameRate) frameRate.textContent = "Unknown";
        },
      );

      const head = await headOf(deps, tab.path);
      if (!ctx.isCurrent()) return;
      if (head && !head.ok) {
        unplayable = false;
        failure.textContent = "This file isn't there any more. It may have been moved or deleted.";
        failure.hidden = false;
        dash();
      }
    },
    clearInput: () => {
      stop();
      element.replaceChildren();
      details.body.replaceChildren();
      details.section.hidden = true;
    },
    title: () => undefined, // the tab names it; no title bar
    dispose: () => {
      stop();
      resize.disconnect();
      hud.look.dispose();
      element.remove();
    },
  };
}
