// A file previewed over the pane that lists it, inside the pane's box, so
// closing it returns to the same scroll and place: a picture or a clip in its
// frame, with the image view's overlay, or a document or a Table on its
// page. The pane hands over the list the arrows step through, and says what
// opening a file in place means there.
import { basenameOf } from "../src/protocol/rootedPath.ts";
import {
  rasterImageMediaTypeForPath,
  thumbnailKindForPath,
  vectorImageMediaTypeForPath,
} from "../src/protocol/types.ts";
import {
  type FileResponse,
  fetchFileRaw,
  getPixelFormat,
  getVideoFormat,
  type PixelFormatResponse,
  rawFileUrl,
  type VideoFormatResponse,
} from "./core/apiClient.ts";
import { wireEntryDrag } from "./core/paths.ts";
import { readingResolvers } from "./core/spaceTree.ts";
import { formatDimensions, formatFrameRate } from "./lib/dom.ts";
import { pixelFormatText } from "./lib/mediaDetails.ts";
import { hudCells, hudFits, hudRoot, type LookBadge, lookBadge, mediaFrame, showTransparency } from "./lib/mediaHud.ts";
import { type MoreOptionsButton, moreOptionsButton } from "./lib/moreOptionsButton.ts";
import { canAnimate, frameZoom } from "./lib/pictureZoom.ts";
import { describeLoaded, readSvgStandInSize } from "./lib/svgSize.ts";
import type { GuidesChoice } from "./lib/videoGuides.ts";
import { type LutChoice, toggleLook } from "./lib/videoLut.ts";
import { createVideoPlayer, type LoopChoice, type VideoPlayer, type VolumeChoice } from "./lib/videoPlayer.ts";
import {
  createPage,
  fitPage,
  loadPage,
  PAGE_PREVIEW_SCALE,
  type PageKind,
  pageKind,
  releasePage,
} from "./notePreview.ts";
import type { DialogService } from "./services/dialog.ts";
import type { FormatRegistry } from "./services/formats.ts";
import { focusMediaField, mediaFieldPath, mediaStrip } from "./services/mediaField.ts";
import type { ContextMenuService } from "./services/menus.ts";
import {
  readableLineLength,
  type Setting,
  videoGuides,
  videoLoop,
  videoLut,
  videoVolume,
} from "./services/settings.ts";

export type PreviewKind = "image" | "svg" | "video" | PageKind;

/** How the file at `path` previews, or undefined for a kind that doesn't. */
export function previewKind(path: string): PreviewKind | undefined {
  const page = pageKind(path);
  if (page) return page;
  if (vectorImageMediaTypeForPath(path)) return "svg";
  return thumbnailKindForPath(path);
}

const isPageKind = (kind: PreviewKind): kind is PageKind => kind === "note" || kind === "table" || kind === "editor";

/** A file to preview, with what a listing already knows of it. */
export interface PreviewFile {
  path: string;
  name: string;
  width?: number;
  height?: number;
}

/** Where a preview reads the files it shows, past the file on a page. */
export interface PreviewSources {
  rawFileUrl(path: string): string;
  /** A GET against the raw-file route, for an SVG's own text. */
  fetchFile(path: string): Promise<Response>;
  /** A clip's codec and frame rate, read from its header by the server. */
  videoFormat(path: string): Promise<VideoFormatResponse>;
  /** A raster still's color mode and bit depth, read from its header by the server. */
  pixelFormat(path: string): Promise<PixelFormatResponse>;
  /** Where the links and embeds in a previewed note at `docPath` lead. */
  readingResolvers: typeof readingResolvers;
  /** Settings → Editor's, which a previewed page is laid out by. */
  readableLineLength: Pick<Setting<boolean>, "subscribe">;
  /** The Loop a previewed clip's player shares with every other. */
  videoLoop: LoopChoice;
  /** The volume a previewed clip's player shares with every other. */
  videoVolume: VolumeChoice;
  /** The guides a previewed clip's player shares with every other. */
  videoGuides: GuidesChoice;
  /** The LUT a previewed clip's player shares with every other. */
  videoLut: LutChoice;
}

/** The server's routes and this browser's settings. */
export function servedPreviewSources(): PreviewSources {
  return {
    rawFileUrl,
    fetchFile: fetchFileRaw,
    videoFormat: getVideoFormat,
    pixelFormat: getPixelFormat,
    readingResolvers,
    readableLineLength,
    videoLoop,
    videoVolume,
    videoGuides,
    videoLut,
  };
}

/** A previewed clip's More options, given `{ file, bookmark }`: the ways to
 * open the clip, its guides and looks, then its bookmark. */
export const PREVIEW_CLIP_MENU = "preview.clip";

/** A previewed still's or page's More options, given `{ file, bookmark }`:
 * the ways to open the file, then its bookmark. */
export const PREVIEW_FILE_MENU = "preview.file";

export interface FilePreviewDeps extends PreviewSources {
  /** The pane's box, which the preview fills. A run of clicks is told apart
   * by where its first press landed, here or on the preview. */
  host: HTMLElement;
  /** Puts focus back when a press or a key closes the preview. */
  refocus(): void;
  /** The list the arrows step through: its length, and its file at `index`,
   * undefined where there is nothing to preview. */
  count(): number;
  fileAt(index: number): PreviewFile | undefined;
  /** A file as a document route reads it, for its page. */
  loadFile(path: string): Promise<FileResponse>;
  /** What draws a document of another type on its page. */
  formats: Pick<FormatRegistry, "get">;
  /** Draws the ⋮'s menus, and those a page opens. */
  contextMenu: ContextMenuService;
  /** Where a previewed Table's picture that has gone says why. */
  dialog: DialogService;
  /** A space link, a path cell or a picture clicked on a previewed page,
   * opened as reading view opens a link. */
  openPath(path: string): void;
  /** A double-click or Enter on the preview: the file at `index`, in place.
   * A pane that leaves it out opens nothing on either. */
  openInPlace?(index: number): void;
  /** The file at `index` is the one shown. */
  shown?(index: number): void;
}

export interface FilePreview {
  /** The index of the file shown, or undefined while closed. */
  shownIndex(): number | undefined;
  show(index: number): void;
  close(refocus?: boolean): void;
  /** The list changed under the preview, and its file is at `index` now. */
  moved(index: number): void;
  /** A key pressed on the focused pane while the preview is open: true when
   * the preview took it. */
  key(key: string): boolean;
  /** Fits the file shown to the stage again. */
  fit(): void;
  dispose(): void;
}

// Out of the tab order, and a click never takes focus: the pane's keys step
// the preview only while the pane itself is focused.
function previewButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.tabIndex = -1;
  button.setAttribute("aria-label", label);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

// A still's or a page's overlay shows whatever the file's size: where its
// facts don't fit, its ⋮ stays, alone, so the file can still be opened.
function showOverlay(hud: HTMLElement, factsFit: boolean): void {
  hud.hidden = false;
  hud.classList.toggle("is-bare", !factsFit);
}

// The rest of a click run whose first click closed the preview lands on
// whatever lies there now: what the pane lists, or a button of the group's
// toolbar the backdrop covered. None of it may press anything, so the window
// takes it until a press starts a new run.
function swallowRest(): void {
  const swallow = (event: MouseEvent) => {
    if (event.detail < 2) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const disarm = (event: MouseEvent) => {
    if (event.detail > 1) return;
    for (const type of ["click", "dblclick"] as const) window.removeEventListener(type, swallow, true);
    window.removeEventListener("mousedown", disarm, true);
  };
  for (const type of ["click", "dblclick"] as const) window.addEventListener(type, swallow, true);
  window.addEventListener("mousedown", disarm, true);
}

// Opening, the backdrop and its controls fade in as the file grows from just
// under its size; closing runs the same way back, a little quicker. A step
// to another file swaps at once, so browsing stays quick.
const OPENING: KeyframeAnimationOptions = { duration: 150, easing: "cubic-bezier(0.33, 1, 0.68, 1)" };
const CLOSING: KeyframeAnimationOptions = { duration: 120, easing: "cubic-bezier(0.32, 0, 0.67, 0)", fill: "forwards" };
const AWAY: Keyframe = { opacity: 0, transform: "scale(0.95)" };
const ARRIVED: Keyframe = { opacity: 1, transform: "none" };

export function createFilePreview(deps: FilePreviewDeps): FilePreview {
  const preview = document.createElement("div");
  preview.className = "file-preview";
  preview.hidden = true;
  const previewStage = document.createElement("div");
  previewStage.className = "file-preview-stage";
  const previewPrev = previewButton("file-preview-nav is-prev", "Previous");
  const previewNext = previewButton("file-preview-nav is-next", "Next");
  preview.append(previewPrev, previewStage, previewNext);
  deps.host.append(preview);
  const stopLineLength = deps.readableLineLength.subscribe((on) => preview.classList.toggle("wide-editor", !on));

  let previewIndex: number | undefined;
  let previewPlayer: VideoPlayer | undefined;
  let previewLook: LookBadge | undefined;
  let previewMore: MoreOptionsButton | undefined;

  // The shown file's menu under its ⋮, or closed there.
  function openMoreOptions(anchor: HTMLElement, path: string, menu: string): void {
    if (deps.contextMenu.isOpen(anchor)) deps.contextMenu.close();
    else {
      deps.contextMenu.open({
        menu,
        arg: { file: path, bookmark: path },
        anchor,
        align: "end",
        ariaLabel: "More options",
      });
    }
  }

  // The ⋮ that ends a still's or a page's bottom bar; a clip's is its
  // player's own.
  function fileMoreOptions(path: string): HTMLButtonElement {
    previewMore = moreOptionsButton("media-hud-more", (anchor) => openMoreOptions(anchor, path, PREVIEW_FILE_MENU));
    previewMore.element.tabIndex = -1;
    return previewMore.element;
  }

  // The file at `index`, when it is one a preview shows.
  function previewableAt(index: number): { file: PreviewFile; kind: PreviewKind } | undefined {
    const file = deps.fileAt(index);
    const kind = file === undefined ? undefined : previewKind(file.path);
    return file && kind ? { file, kind } : undefined;
  }

  function stopPreviewMedia(): void {
    pageLoad++;
    zoomPreview = () => false;
    previewPlayer?.dispose();
    previewPlayer = undefined;
    previewLook?.dispose();
    previewLook = undefined;
    previewMore?.dispose();
    previewMore = undefined;
    for (const video of previewStage.querySelectorAll("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const page of previewStage.querySelectorAll<HTMLElement>(".preview-page")) releasePage(page);
    previewStage.replaceChildren();
  }

  let fitPreview = () => {};
  // A click on the previewed still: true when it zoomed in or out.
  let zoomPreview: (target: Element, at: MouseEvent) => boolean = () => false;
  // Counts the pages shown, so a file arriving after a step is dropped.
  let pageLoad = 0;

  function showPreview(index: number): void {
    const shown = previewableAt(index);
    if (!shown) return;
    const opening = previewIndex === undefined;
    settleClose();
    stopPreviewMedia();
    const frame = isPageKind(shown.kind) ? pagePreview(shown.file, shown.kind) : mediaPreview(shown.file, shown.kind);
    previewStage.append(frame);
    preview.hidden = false;
    previewIndex = index;
    markEnds(index);
    deps.shown?.(index);
    fitPreview();
    if (opening && canAnimate(preview)) {
      preview.animate([{ opacity: 0 }, { opacity: 1 }], OPENING);
      frame.animate([AWAY, ARRIVED], OPENING);
    }
  }

  function markEnds(index: number): void {
    previewPrev.setAttribute("aria-disabled", String(previewableFrom(index, -1) === undefined));
    previewNext.setAttribute("aria-disabled", String(previewableFrom(index, 1) === undefined));
  }

  // The image view's overlay, in the previewed picture's own frame: the
  // dimensions with their ratio along the top, as the image and video views
  // write them, then a clip's LOOK badge and frame rate or a still's color
  // mode; a still's name and ⋮ along the bottom, a clip's length and ⋮ left
  // to the pill.
  //
  // The decoded media has the last word on its size, and on whether bars fit.
  function mediaPreview(file: PreviewFile, kind: PreviewKind): HTMLElement {
    const isVideo = kind === "video";
    const [name, dimensions, format] = hudCells(3);
    name.className = "media-hud-name";
    name.textContent = file.name;
    previewLook = isVideo ? lookBadge(deps.videoLut) : undefined;
    const hud = previewLook
      ? hudRoot([dimensions, previewLook.element, format])
      : hudRoot([dimensions, format], [name, fileMoreOptions(file.path)]);
    const fill = (width = 0, height = 0) => {
      if (width <= 0 || height <= 0) return;
      dimensions.textContent = formatDimensions(width, height, "");
    };
    fill(file.width, file.height);
    if (isVideo) {
      deps.videoFormat(file.path).then(
        (clip) => {
          format.textContent = formatFrameRate(clip) ?? "";
        },
        () => undefined,
      );
    } else if (rasterImageMediaTypeForPath(file.path)) {
      deps.pixelFormat(file.path).then(
        (pixels) => {
          format.textContent = pixelFormatText(pixels);
        },
        () => undefined,
      );
    }

    let media: HTMLImageElement | HTMLVideoElement;
    let decoded = false;
    let fullWidth = 0;
    if (isVideo) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", () => {
        decoded = true;
        fill(video.videoWidth, video.videoHeight);
        fitPreview();
      });
      video.addEventListener("resize", () => fitPreview());
      media = video;
    } else {
      const img = document.createElement("img");
      img.alt = file.name;
      showTransparency(img, file.path);
      const standIn = kind === "svg" ? readSvgStandInSize(deps.fetchFile, file.path) : undefined;
      describeLoaded(img, standIn, (width, height) => {
        decoded = true;
        fullWidth = width;
        fill(width, height);
        fitPreview();
      });
      // One that never decodes has no size to fit, and keeps its ⋮.
      img.addEventListener("error", () => showOverlay(hud, false));
      media = img;
    }
    // The overlay follows the media: `:is(img, video):hover + .media-hud`.
    const frame = mediaFrame(media, hud, "file-preview-frame");
    if (media instanceof HTMLVideoElement) {
      previewPlayer = createVideoPlayer(media, {
        layout: "pill",
        loop: deps.videoLoop,
        volume: deps.videoVolume,
        guides: deps.videoGuides,
        lut: deps.videoLut,
        moreOptions: (anchor) => openMoreOptions(anchor, file.path, PREVIEW_CLIP_MENU),
      });
      frame.append(previewPlayer.element);
    }
    const zoom = media instanceof HTMLImageElement ? frameZoom(frame, media, () => fitPreview()) : undefined;
    if (media instanceof HTMLImageElement) wireEntryDrag(media, () => ({ path: file.path, type: "file" }));
    // The picture, or zoomed the frame, mat and all.
    zoomPreview = (target, at) => zoom !== undefined && (target === media || target === frame) && zoom.click(at);
    fitPreview = () => {
      if (!decoded || !media.isConnected) return;
      const shown = media.getBoundingClientRect();
      if (isVideo) hud.hidden = !hudFits(shown.width, shown.height);
      else showOverlay(hud, hudFits(shown.width, shown.height));
      zoom?.fit(shown.width, fullWidth);
    };
    // Measured again as the overlay is about to show, so a layout change no
    // observer saw can't leave it on a picture too small for it.
    media.addEventListener("pointerenter", () => fitPreview());
    media.src = deps.rawFileUrl(file.path);
    return frame;
  }

  // A document or a Table as its reading view, on a page that scrolls on its
  // own, with one bar along the bottom: its name, its size and its ⋮. A
  // document's size is the count the status bar gives it once it is open.
  function pagePreview(file: PreviewFile, kind: PageKind): HTMLElement {
    const page = createPage(kind);
    page.classList.add("file-preview-page");
    const [name, count] = hudCells(2);
    name.className = "media-hud-name";
    name.textContent = file.name;
    const hud = hudRoot([name, count, fileMoreOptions(file.path)]);
    const load = pageLoad;
    void loadPage(page, file.path, kind, deps, () => load !== pageLoad).then((counted) => {
      if (counted !== undefined) count.textContent = counted;
    });
    const frame = mediaFrame(page, hud, "file-preview-document");
    frame.style.setProperty("--page-scale", String(PAGE_PREVIEW_SCALE));
    fitPreview = () => {
      if (!page.isConnected) return;
      fitPage(frame, page);
      showOverlay(hud, hudFits(frame.clientWidth, frame.clientHeight));
    };
    return frame;
  }

  // A previewed page scrolls by the keys a focused scroller takes: focus
  // stays on the pane, where the preview's other keys listen.
  function scrollPage(key: string): boolean {
    const page = previewStage.querySelector<HTMLElement>(".file-preview-page");
    if (!page) return false;
    const line = 40;
    const screen = Math.max(line, page.clientHeight - line);
    if (key === "ArrowDown") page.scrollTop += line;
    else if (key === "ArrowUp") page.scrollTop -= line;
    else if (key === "PageDown") page.scrollTop += screen;
    else if (key === "PageUp") page.scrollTop -= screen;
    else if (key === "Home") page.scrollTop = 0;
    else if (key === "End") page.scrollTop = page.scrollHeight;
    else return false;
    return true;
  }

  // A close's fade, until it ends or a new preview cuts it short.
  let closing: Animation[] | undefined;

  // Closing, the preview takes no pointer or focus and hands focus back at
  // once, so its fade never catches what follows (dialog.css says why a
  // dialog doesn't fade out). A clip pauses at once; the file is let go,
  // and the fade's held end dropped, once it ends.
  function closePreview(refocus = true): void {
    if (previewIndex === undefined) return;
    fitPreview = () => {};
    zoomPreview = () => false;
    previewIndex = undefined;
    const frame = previewStage.firstElementChild;
    if (frame instanceof HTMLElement && canAnimate(preview)) {
      for (const video of previewStage.querySelectorAll("video")) video.pause();
      preview.inert = true;
      const fades = [preview.animate([{ opacity: 0 }], CLOSING), frame.animate([AWAY], CLOSING)];
      closing = fades;
      Promise.all(fades.map((fade) => fade.finished)).then(
        () => {
          if (closing === fades) settleClose();
        },
        () => undefined,
      );
    } else {
      stopPreviewMedia();
      preview.hidden = true;
    }
    if (refocus) deps.refocus();
  }

  function settleClose(): void {
    const fades = closing;
    if (!fades) return;
    closing = undefined;
    stopPreviewMedia();
    preview.hidden = true;
    preview.inert = false;
    for (const fade of fades) fade.cancel();
  }

  function previewableFrom(index: number, direction: 1 | -1): number | undefined {
    for (let next = index + direction; next >= 0 && next < deps.count(); next += direction) {
      if (previewableAt(next)) return next;
    }
    return undefined;
  }

  function stepPreview(direction: 1 | -1): void {
    const next = previewIndex === undefined ? undefined : previewableFrom(previewIndex, direction);
    if (next !== undefined) showPreview(next);
  }

  previewPrev.addEventListener("click", () => stepPreview(-1));
  previewNext.addEventListener("click", () => stepPreview(1));

  // A click on the backdrop closes the preview, as one on a still already at
  // full size does; a still shrunk to fit zooms instead. A player keeps its
  // clicks, which play and pause it, and a page its, which select text and
  // follow links: a link to a space file opens it here, as reading view does.
  //
  // A click opens the preview, so a double-click's second click lands on it:
  // that one must not close or zoom it, play or pause a clip, nor open a
  // menu from a ⋮. The double-click opens the file as one does everywhere
  // else, or nothing in a pane that opens nothing in place.
  //
  // A double-click begun on an open page, on a still that zooms, on a ⋮ or
  // on a clip is theirs: it selects a word, zooms in and out, is one press of
  // the ⋮, or goes full screen. An arrow's is two steps.
  preview.addEventListener("click", (event) => {
    const target = event.target as Element;
    const link = target.closest<HTMLElement>(".file-preview-page a[data-space-path]");
    if (link) {
      event.preventDefault();
      deps.openPath(link.dataset.spacePath ?? "");
      return;
    }
    if (pressedInPreview && zoomPreview(target, event)) return;
    const onPage = target.closest(".file-preview-page") !== null;
    if (event.detail > 1 || onPage || !(target === preview || target instanceof HTMLImageElement)) return;
    closePreview();
    swallowRest();
  });

  // A fresh press starts a new run, and notes whether the preview was
  // already up when it began.
  let pressedInPreview = false;
  deps.host.addEventListener(
    "mousedown",
    (event) => {
      if (event.detail < 2) pressedInPreview = previewIndex !== undefined;
    },
    true,
  );
  // A double-click begun on what opened the preview presses nothing on a
  // clip, its controls, its LOOK badge or a ⋮, where it would pause the clip,
  // turn the shared Loop or look, or open a menu.
  previewStage.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const pressable =
        target instanceof HTMLVideoElement ||
        (target instanceof Element && target.closest(".video-player, .media-hud-badge, .media-hud-more") !== null);
      if (pressable && event.detail > 1 && !pressedInPreview) event.stopPropagation();
    },
    true,
  );
  // Its double-click is taken before what it lands on can act on it: a
  // clip's own would go full screen.
  preview.addEventListener(
    "dblclick",
    (event) => {
      if (pressedInPreview) return;
      event.stopPropagation();
      const onArrow = event.target === previewPrev || event.target === previewNext;
      if (!onArrow && previewIndex !== undefined) deps.openInPlace?.(previewIndex);
    },
    true,
  );
  // One begun outside that lands on the backdrop still reaches this listener:
  // a stop holds back other elements, never the one the event is on.
  preview.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!pressedInPreview || !(target instanceof Element) || target === previewPrev || target === previewNext) return;
    if (target.closest(".file-preview-frame, .file-preview-document")) return;
    if (previewIndex !== undefined) deps.openInPlace?.(previewIndex);
  });

  return {
    shownIndex: () => previewIndex,
    show: showPreview,
    close: closePreview,
    moved(index) {
      previewIndex = index;
      markEnds(index);
    },
    key(key) {
      if (previewIndex === undefined) return false;
      if (key === "ArrowRight") stepPreview(1);
      else if (key === "ArrowLeft") stepPreview(-1);
      else if (key === " ") closePreview();
      else if (key === "Enter" && deps.openInPlace) deps.openInPlace(previewIndex);
      else if ((key === "d" || key === "D") && previewPlayer) toggleLook(deps.videoLut);
      else return scrollPage(key);
      return true;
    },
    fit: () => fitPreview(),
    dispose() {
      closePreview(false);
      settleClose();
      stopLineLength();
      preview.remove();
    },
  };
}

export interface MediaPreviewDeps
  extends Omit<FilePreviewDeps, "refocus" | "count" | "fileAt" | "openInPlace" | "shown"> {
  /** Where the pane draws its media fields. */
  fields: HTMLElement;
}

export interface MediaPreview {
  /** A click on a media field showing `path`: the file over the pane, or in
   * place where there is no preview of it. */
  open(path: string, field: HTMLElement): void;
  isOpen(): boolean;
  close(refocus?: boolean): void;
  dispose(): void;
}

/** A Table's or a Class's preview of what its media fields show. The arrows
 * step through the clicked field's strip in the order drawn, and Enter or a
 * double-click opens the file in place. While it shows, the pane's box holds
 * focus for its keys; closed, focus goes to the field it ended on. */
export function createMediaPreview({ fields, ...deps }: MediaPreviewDeps): MediaPreview {
  let strip: HTMLElement[] = [];
  let last: HTMLElement | undefined;
  const fileOf = (field: HTMLElement | undefined): PreviewFile | undefined => {
    const path = mediaFieldPath(field);
    return path === undefined ? undefined : { path, name: basenameOf(path) };
  };
  const preview = createFilePreview({
    ...deps,
    count: () => strip.length,
    fileAt: (index) => fileOf(strip[index]),
    openInPlace: (index) => {
      const file = fileOf(strip[index]);
      if (file) deps.openPath(file.path);
    },
    shown: (index) => {
      last = strip[index];
      deps.host.focus({ preventScroll: true });
    },
    refocus: () => {
      if (last?.isConnected) focusMediaField(last);
      else deps.host.focus();
    },
  });
  deps.host.tabIndex = -1;
  deps.host.addEventListener("keydown", (event) => {
    if (event.target !== deps.host || event.metaKey || event.ctrlKey) return;
    if (preview.key(event.key)) event.preventDefault();
  });
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => preview.fit());
  resize?.observe(deps.host);
  return {
    open(path, field) {
      if (previewKind(path) === undefined || fileOf(field) === undefined) {
        deps.openPath(path);
        return;
      }
      strip = mediaStrip(fields, field);
      preview.show(strip.indexOf(field));
    },
    isOpen: () => preview.shownIndex() !== undefined,
    close: (refocus) => preview.close(refocus),
    dispose() {
      resize?.disconnect();
      preview.dispose();
    },
  };
}
