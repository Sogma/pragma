// A file previewed over the pane that lists it, inside the pane's box, so
// closing it returns to the same scroll and place: a picture or a clip in its
// frame, with the image view's overlay, or a document or a Table on its
// page. The pane hands over the list the arrows step through, and says what
// opening a file in place means there.
//
// The Info tab's "Selected …" section is built here too, one for every pane:
// a gallery fills it with its selected entry, and a pane with no selection
// of its own hands it to its preview, which keeps it on the file shown.
import { basenameOf } from "../src/protocol/rootedPath.ts";
import {
  rasterImageMediaTypeForPath,
  thumbnailKindForPath,
  vectorImageMediaTypeForPath,
} from "../src/protocol/types.ts";
import {
  type ClipHeaderResponse,
  type FileInfoResponse,
  type FileResponse,
  type FolderEntry,
  fetchFileRaw,
  getFileInfo,
  getPixelFormat,
  getVideoFormat,
  type PixelFormatResponse,
  rawFileUrl,
  type SelectedFile,
} from "./core/apiClient.ts";
import { fileTypeLabel, type PageKind, pageKind, wireEntryDrag } from "./core/paths.ts";
import { fileTypeAt, folderTotalsAt, readingResolvers } from "./core/spaceTree.ts";
import { type ContextView, createViewBinding } from "./lib/contextView.ts";
import { dateTimeLabel } from "./lib/dateText.ts";
import {
  appendMetaRow,
  createInspectorSection,
  formatDimensions,
  formatDuration,
  formatFileSize,
  formatFrameRate,
  must,
} from "./lib/dom.ts";
import { clipDetailRows, clipFormatText, pictureDetailRows, pixelFormatRows } from "./lib/mediaDetails.ts";
import {
  fitHud,
  type GuidesSwitch,
  guidesSwitch,
  hudBadges,
  hudCells,
  hudRoot,
  type LookBadge,
  lookBadge,
  mediaFrame,
  mediaMenuOn,
  showTransparency,
} from "./lib/mediaHud.ts";
import { type MoreOptionsButton, moreOptionsButton } from "./lib/moreOptionsButton.ts";
import { createPaneOverlay, swallowRest } from "./lib/paneOverlay.ts";
import { createPictureLayers, type PictureLayers } from "./lib/pictureLayers.ts";
import { frameZoom, shownPercent } from "./lib/pictureZoom.ts";
import { describeLoaded, readSvgStandInSize } from "./lib/svgSize.ts";
import { toggleGuides } from "./lib/videoGuides.ts";
import { toggleLook } from "./lib/videoLut.ts";
import { createVideoPlayer, type LoopChoice, type VideoPlayer, type VolumeChoice } from "./lib/videoPlayer.ts";
import { createPage, fitPage, loadPage, PAGE_PREVIEW_SCALE, releasePage } from "./notePreview.ts";
import { contextView } from "./services/contextViews.ts";
import type { DialogService } from "./services/dialog.ts";
import type { FormatRegistry } from "./services/formats.ts";
import { focusMediaField, mediaFieldPath, mediaStrip } from "./services/mediaField.ts";
import type { ContextMenuService } from "./services/menus.ts";
import { readableLineLength, type Setting, videoLoop, videoVolume } from "./services/settings.ts";
import { badgeMenus, MEDIA_MENU, moreOptionsMenu } from "./services/videoMenu.ts";

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
  /** Bytes. */
  size?: number;
  width?: number;
  height?: number;
}

/** Where a preview reads the files it shows, past the file on a page. */
export interface PreviewSources {
  rawFileUrl(path: string): string;
  /** A GET against the raw-file route, for an SVG's own text. */
  fetchFile(path: string): Promise<Response>;
  /** A file's size and date: the size a clip's bar shows, read for one its
   * list gives none. */
  fileInfo(path: string): Promise<FileInfoResponse>;
  /** A clip's header as the server reads it: what its bottom bar says of its
   * picture, and the rest its Info section lists. */
  videoFormat(path: string): Promise<ClipHeaderResponse>;
  /** Where the links and embeds in a previewed note at `docPath` lead. */
  readingResolvers: typeof readingResolvers;
  /** Settings → Editor's, which a previewed page is laid out by. */
  readableLineLength: Pick<Setting<boolean>, "subscribe">;
  /** The Loop a previewed clip's player shares with every other. */
  videoLoop: LoopChoice;
  /** The volume a previewed clip's player shares with every other. */
  videoVolume: VolumeChoice;
  /** Each context's guides and look, which a previewed still or clip shares
   * with every viewer seen in the same context. */
  views: (context: string) => ContextView;
}

/** What a "Selected …" section reads of an entry whose facts it lacks. */
export interface SelectedReads {
  /** A file's size and date. */
  fileInfo(path: string): Promise<FileInfoResponse>;
  /** A raster still's color mode, bit depth and source, read from its
   * header by the server. */
  pixelFormat(path: string): Promise<PixelFormatResponse>;
  /** What a folder holds, all the way down, in its tree row's words:
   * undefined where the tree counts nothing. */
  folderTotals(path: string): string | undefined;
}

/** The server's routes and this browser's settings, for a preview and the
 * section its pane keeps in the Info tab. */
export function servedPreviewSources(): PreviewSources & SelectedReads {
  return {
    rawFileUrl,
    fetchFile: fetchFileRaw,
    videoFormat: getVideoFormat,
    fileInfo: getFileInfo,
    pixelFormat: getPixelFormat,
    folderTotals: folderTotalsAt,
    readingResolvers,
    readableLineLength,
    videoLoop,
    videoVolume,
    views: contextView,
  };
}

/** What a "Selected …" section knows of an entry: a listing's facts, or
 * what a preview learns as it shows the file. A fact it lacks gets no row,
 * but a raster still's color mode and bit depth read "…" until its
 * `picture` arrives. */
export type SelectedEntry = Pick<FolderEntry, "path" | "name" | "type"> &
  Partial<Pick<FolderEntry, "size" | "modified" | "width" | "height" | "duration" | "clip" | "picture">>;

/** The Info tab's "Selected …" section: the file a pane points at apart
 * from its own, in the same rows and words on every pane. */
export interface SelectedSection {
  /** Hidden while nothing is selected. */
  readonly section: HTMLElement;
  /** Shows `entry`, or hides the section. A file's size and date, or a
   * raster still's pixels, that it lacks are read once and kept on it, so
   * showing it again reads nothing. */
  show(entry: SelectedEntry | undefined): void;
}

const isRasterStill = (entry: SelectedEntry) =>
  entry.type === "file" && rasterImageMediaTypeForPath(entry.path) !== undefined;

export function createSelectedSection(reads: SelectedReads): SelectedSection {
  const { section, body } = createInspectorSection("Selected");
  const title = must<HTMLElement>(".inspector-section-title", section);
  body.className = "meta-rows";
  let shown: SelectedEntry | undefined;
  const asked = new WeakSet<SelectedEntry>();

  function render(entry: SelectedEntry): void {
    body.replaceChildren();
    // Named for what is selected, by the name the tree's icon gives its kind.
    title.textContent =
      entry.type === "directory" ? "Selected Folder" : `Selected ${fileTypeLabel(fileTypeAt(entry.path)) ?? "File"}`;
    appendMetaRow(body, "Name", entry.name);
    if (entry.width && entry.height) appendMetaRow(body, "Dimensions", formatDimensions(entry.width, entry.height));
    if (entry.duration !== undefined) appendMetaRow(body, "Duration", formatDuration(entry.duration));
    const still = isRasterStill(entry);
    const rows = entry.clip
      ? [
          ...(entry.clip.frameRate === null ? [] : [{ label: "Frame rate", value: formatFrameRate(entry.clip) ?? "" }]),
          ...(entry.clip.codec === null ? [] : [{ label: "Codec", value: entry.clip.codec }]),
          ...clipDetailRows(entry.clip),
        ]
      : [
          ...(still ? pixelFormatRows(entry.picture?.pixels ?? null, entry.picture ? "Unknown" : "…") : []),
          ...(entry.picture ? pictureDetailRows(entry.picture) : []),
        ];
    for (const row of rows) appendMetaRow(body, row.label, row.value);
    if (entry.type === "file" && entry.size !== undefined) appendMetaRow(body, "Size", formatFileSize(entry.size));
    const totals = entry.type === "directory" ? reads.folderTotals(entry.path) : undefined;
    if (totals !== undefined) appendMetaRow(body, "Contains", totals);
    if (entry.modified !== undefined) appendMetaRow(body, "Modified", dateTimeLabel(entry.modified));
  }

  // An answer is kept on its entry even once another shows, and drawn only
  // while its own does.
  function keep(entry: SelectedEntry, facts: Partial<SelectedEntry>): void {
    Object.assign(entry, facts);
    if (shown === entry) render(entry);
  }

  function readWhatItLacks(entry: SelectedEntry): void {
    if (asked.has(entry)) return;
    asked.add(entry);
    if (entry.size === undefined || entry.modified === undefined) {
      reads.fileInfo(entry.path).then(
        ({ size, modified }) => keep(entry, { size, modified }),
        () => undefined,
      );
    }
    if (isRasterStill(entry) && !entry.picture) {
      reads.pixelFormat(entry.path).then(
        ({ sourceType, ...pixels }) => keep(entry, { picture: { sourceType, pixels } }),
        () => keep(entry, { picture: { sourceType: null, pixels: null } }),
      );
    }
  }

  return {
    section,
    show(entry) {
      shown = entry;
      section.hidden = entry === undefined;
      if (!entry) {
        body.replaceChildren();
        return;
      }
      readWhatItLacks(entry);
      render(entry);
    },
  };
}

/** A previewed page's More options, given `{ file, bookmark }`: the ways to
 * open the file, then its bookmark. */
export const PREVIEW_PAGE_MENU = "preview.page";

export interface FilePreviewDeps extends PreviewSources {
  /** The pane's box, which the preview fills. A run of clicks is told apart
   * by where its first press landed, here or on the preview. */
  host: HTMLElement;
  /** The context the pane's tab is seen in, whose guides and look a still or
   * clip shows, wherever the file lives. */
  context(): string;
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
  /** The Info tab's section, kept on the file shown while the preview is
   * open, for a pane with no selection of its own to show there. */
  details?: SelectedSection;
}

// A fact showing the file taught, for the Info section's entry.
type Learn = (update: (entry: SelectedEntry) => void) => void;

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

export function createFilePreview(deps: FilePreviewDeps): FilePreview {
  const overlay = createPaneOverlay({
    host: deps.host,
    stem: "file-preview",
    count: () => deps.count(),
    showable: (index) => previewableAt(index) !== undefined,
    render: (index) => renderPreview(index),
    release: () => stopPreviewMedia(),
    shown(index) {
      deps.shown?.(index);
      fitPreview();
    },
    // A clip pauses at once, before the fade.
    closing() {
      fitPreview = () => {};
      zoomPreview = () => false;
      described = undefined;
      deps.details?.show(undefined);
      for (const video of previewStage.querySelectorAll("video")) video.pause();
    },
    refocus: () => deps.refocus(),
  });
  const { element: preview, stage: previewStage, prev: previewPrev, next: previewNext } = overlay;
  const stopLineLength = deps.readableLineLength.subscribe((on) => preview.classList.toggle("wide-editor", !on));

  const view = createViewBinding(deps.views);
  const previewBadgeMenus = badgeMenus(deps.contextMenu, view.context, deps.views);
  let previewPlayer: VideoPlayer | undefined;
  let previewLook: LookBadge | undefined;
  let previewGuides: GuidesSwitch | undefined;
  let previewMore: MoreOptionsButton | undefined;
  let previewLayers: PictureLayers | undefined;
  // Opens the shown still's or clip's ⋮ menu at a point.
  let previewMenuAt: ((at: { x: number; y: number }) => void) | undefined;

  // The ⋮ that ends a still's or a page's bottom bar; a clip's is its
  // player's own.
  function fileMoreOptions(path: string, menu: string): HTMLButtonElement {
    const open = moreOptionsMenu(deps.contextMenu, path, { menu, context: view.context });
    const more = moreOptionsButton("media-hud-more", open);
    more.element.tabIndex = -1;
    previewMore = more;
    previewMenuAt = (at) => open(more.element, undefined, at);
    return more.element;
  }

  // A right-click on a shown still or clip opens its ⋮ menu where it lands,
  // and the menu key on the host, which holds focus while it shows, in the
  // middle of it. A page's text keeps the text menu.
  const stopMediaMenu = mediaMenuOn(
    deps.host,
    () => previewStage.querySelector<HTMLElement>(":scope > .file-preview-frame > :is(img, video)") ?? undefined,
    (at) => previewMenuAt?.(at),
  );

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
    previewGuides?.dispose();
    previewGuides = undefined;
    previewMore?.dispose();
    previewMore = undefined;
    previewMenuAt = undefined;
    previewLayers?.dispose();
    previewLayers = undefined;
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

  // The Info section's entry for the file shown, from what the pane's list
  // gave. A file stepped past can still finish decoding, so what it teaches
  // lands only while its own entry is the one described.
  let described: SelectedEntry | undefined;
  function describe(file: PreviewFile): Learn {
    const details = deps.details;
    if (!details) return () => undefined;
    const entry: SelectedEntry = {
      path: file.path,
      name: file.name,
      type: "file",
      width: file.width,
      height: file.height,
    };
    described = entry;
    details.show(entry);
    return (update) => {
      if (described !== entry) return;
      update(entry);
      details.show(entry);
    };
  }

  function renderPreview(index: number): HTMLElement {
    const shown = previewableAt(index);
    if (!shown) throw new Error(`no preview at ${index}`);
    view.bind(deps.context());
    const learn = describe(shown.file);
    return isPageKind(shown.kind) ? pagePreview(shown.file, shown.kind) : mediaPreview(shown.file, shown.kind, learn);
  }

  function stillBar(file: PreviewFile): HTMLElement[] {
    const [name] = hudCells(1);
    name.className = "media-hud-name";
    name.textContent = file.name;
    return [name, fileMoreOptions(file.path, MEDIA_MENU)];
  }

  // A clip's bottom bar: what its header says of its picture at the left,
  // and its size at the right, from its list or else read. Its ⋮ is its
  // pill's. The header teaches the Info section too.
  function clipBar(file: PreviewFile, learn: Learn): HTMLElement[] {
    const [details, size] = hudCells(2);
    details.className = "media-hud-details";
    deps.videoFormat(file.path).then(
      (clip) => {
        details.textContent = clipFormatText(clip);
        learn((entry) => {
          entry.clip = clip;
          if (!entry.width && clip.width && clip.height)
            Object.assign(entry, { width: clip.width, height: clip.height });
          if (entry.duration === undefined && clip.duration !== null) entry.duration = clip.duration;
        });
      },
      () => undefined,
    );
    const showSize = (bytes: number) => {
      size.textContent = formatFileSize(bytes);
    };
    if (file.size !== undefined) showSize(file.size);
    else {
      deps.fileInfo(file.path).then(
        (info) => showSize(info.size),
        () => undefined,
      );
    }
    return [details, size];
  }

  // The image view's overlay, in the previewed picture's own frame: the
  // dimensions with their ratio along the top, as the image and video views
  // write them, then the guides switch and the LOOK badge where a look can
  // apply, and the display scale. Along the bottom, a still's name and ⋮,
  // or a clip's details and size.
  //
  // The decoded media has the last word on its size, and on whether bars fit.
  // A clip's header stands in, in the Info section, for one never decoded.
  function mediaPreview(file: PreviewFile, kind: PreviewKind, learn: Learn): HTMLElement {
    const isVideo = kind === "video";
    const rasterType = rasterImageMediaTypeForPath(file.path);
    const [dimensions, scale] = hudCells(2);
    previewLook = isVideo || rasterType ? lookBadge(view.look, previewBadgeMenus.looks) : undefined;
    previewGuides = guidesSwitch(view.guides, previewBadgeMenus.guides);
    const top = [dimensions, hudBadges(previewGuides.element, previewLook?.element), scale];
    const hud = hudRoot(top, isVideo ? clipBar(file, learn) : stillBar(file));
    const fill = (width = 0, height = 0) => {
      if (width <= 0 || height <= 0) return;
      dimensions.textContent = formatDimensions(width, height, "");
    };
    fill(file.width, file.height);

    let media: HTMLImageElement | HTMLVideoElement;
    let layers: PictureLayers | undefined;
    let decoded = false;
    let fullWidth = 0;
    if (isVideo) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", () => {
        decoded = true;
        fullWidth = video.videoWidth;
        fill(video.videoWidth, video.videoHeight);
        learn((entry) => {
          Object.assign(entry, { width: video.videoWidth, height: video.videoHeight });
          if (Number.isFinite(video.duration)) entry.duration = video.duration;
        });
        fitPreview();
      });
      // A stream can change its frame size mid-clip.
      video.addEventListener("resize", () => {
        fullWidth = video.videoWidth;
        fitPreview();
      });
      media = video;
    } else {
      const img = document.createElement("img");
      img.alt = file.name;
      showTransparency(img, file.path);
      const standIn = kind === "svg" ? readSvgStandInSize(deps.fetchFile, file.path) : undefined;
      const stillLayers = createPictureLayers(img, {
        guides: view.guides,
        lut: rasterType ? view.look : undefined,
        type: rasterType,
      });
      layers = stillLayers;
      previewLayers = stillLayers;
      describeLoaded(img, standIn, (width, height) => {
        decoded = true;
        fullWidth = width;
        fill(width, height);
        learn((entry) => Object.assign(entry, { width, height }));
        stillLayers.setSize(width, height);
        fitPreview();
      });
      // One that never decodes has no size to fit, and keeps its ⋮.
      img.addEventListener("error", () => fitHud(hud, 0, 0));
      media = img;
    }
    // The overlay follows the media: `:is(img, video):hover + .media-hud`.
    // Its bars lie in bands of the mat (media-bands.css).
    const frame = mediaFrame(media, hud, "file-preview-frame has-bands has-mat");
    if (layers) frame.append(layers.element);
    if (media instanceof HTMLVideoElement) {
      previewPlayer = createVideoPlayer(media, {
        layout: "pill",
        loop: deps.videoLoop,
        volume: deps.videoVolume,
        guides: view.guides,
        lut: view.look,
        moreOptions: moreOptionsMenu(deps.contextMenu, file.path, { context: view.context }),
      });
      frame.append(previewPlayer.element);
      const player = previewPlayer;
      previewMenuAt = (at) => player.openMenuAt(at);
    }
    const zoom =
      media instanceof HTMLImageElement
        ? frameZoom(frame, media, () => fitPreview(), layers ? [layers.element] : [])
        : undefined;
    if (media instanceof HTMLImageElement) wireEntryDrag(media, () => ({ path: file.path, type: "file" }));
    // The picture, or zoomed the frame, mat and all.
    zoomPreview = (target, at) => zoom !== undefined && (target === media || target === frame) && zoom.click(at);
    fitPreview = () => {
      if (!decoded || !media.isConnected) return;
      const shown = media.getBoundingClientRect();
      if (fullWidth > 0 && shown.width > 0) scale.textContent = `${shownPercent(shown.width, fullWidth)}%`;
      fitHud(hud, shown.width, shown.height);
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
    const hud = hudRoot([name, count, fileMoreOptions(file.path, PREVIEW_PAGE_MENU)]);
    const load = pageLoad;
    void loadPage(page, file.path, kind, deps, () => load !== pageLoad).then((counted) => {
      if (counted !== undefined) count.textContent = counted;
    });
    const frame = mediaFrame(page, hud, "file-preview-document");
    frame.style.setProperty("--page-scale", String(PAGE_PREVIEW_SCALE));
    fitPreview = () => {
      if (!page.isConnected) return;
      fitPage(frame, page);
      fitHud(hud, frame.clientWidth, frame.clientHeight);
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
    overlay.close();
    swallowRest();
  });

  // A fresh press starts a new run, and notes whether the preview was
  // already up when it began.
  let pressedInPreview = false;
  deps.host.addEventListener(
    "mousedown",
    (event) => {
      if (event.detail < 2) pressedInPreview = overlay.shownIndex() !== undefined;
    },
    true,
  );
  // A double-click begun on what opened the preview presses nothing on a
  // clip, its controls, its LOOK badge, its guides switch or a ⋮, where it
  // would pause the clip, turn the shared Loop, look or guides, or open a menu.
  previewStage.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const pressable =
        target instanceof HTMLVideoElement ||
        (target instanceof Element &&
          target.closest(".video-player, .media-hud-badge, .media-hud-guides, .media-hud-more") !== null);
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
      const index = overlay.shownIndex();
      if (!onArrow && index !== undefined) deps.openInPlace?.(index);
    },
    true,
  );
  // One begun outside that lands on the backdrop still reaches this listener:
  // a stop holds back other elements, never the one the event is on.
  preview.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!pressedInPreview || !(target instanceof Element) || target === previewPrev || target === previewNext) return;
    if (target.closest(".file-preview-frame, .file-preview-document")) return;
    const index = overlay.shownIndex();
    if (index !== undefined) deps.openInPlace?.(index);
  });

  return {
    shownIndex: () => overlay.shownIndex(),
    show: (index) => overlay.show(index),
    close: (refocus) => overlay.close(refocus),
    moved: (index) => overlay.moved(index),
    key(key) {
      const index = overlay.shownIndex();
      if (index === undefined) return false;
      if (key === "ArrowRight") overlay.step(1);
      else if (key === "ArrowLeft") overlay.step(-1);
      else if (key === " ") overlay.close();
      else if (key === "Enter" && deps.openInPlace) deps.openInPlace(index);
      else if ((key === "d" || key === "D") && previewLook) toggleLook(view.look);
      else if ((key === "g" || key === "G") && (previewPlayer || previewLayers)) toggleGuides(view.guides);
      else return scrollPage(key);
      return true;
    },
    fit: () => fitPreview(),
    dispose() {
      overlay.dispose();
      stopLineLength();
      stopMediaMenu();
    },
  };
}

/** The file a pane points at when its preview's is the only one it can. */
export function previewedFile(path: string | undefined): SelectedFile | undefined {
  return path === undefined ? undefined : { path, previewing: true };
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
  /** The file shown, while open. */
  shownPath(): string | undefined;
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
    shownPath() {
      const index = preview.shownIndex();
      return index === undefined ? undefined : fileOf(strip[index])?.path;
    },
    close: (refocus) => preview.close(refocus),
    dispose() {
      resize?.disconnect();
      preview.dispose();
    },
  };
}
