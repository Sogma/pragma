// The gallery pane: one folder's entries as a grid of tiles or cards, in the
// space or a library (docs/architecture.md's Workspace and UI ownership section). A folder of
// thousands stays light: only the rows on screen exist, and a thumbnail is
// made once, by whichever browser first shows it, then kept by the host.
//
// A click on a picture, video or note previews it over the grid, a note as
// its reading view, and on anything else selects it; a double-click or Enter
// opens it in this tab, and Back comes back here. A tile's right-click menu
// is its tree row's, with any name it asks for typed on the tile; the space
// around the tiles has the toolbar's. A card is a tile in all of this.
//
// Tiles come in the order the folder shows, the tree's, which a drag
// arranges while that is manual order.
import type { FolderLayout } from "../../../src/protocol/localSort.ts";
import { dirnameOf, formatRootedPath, isLibraryRoot, parseRootedPath } from "../../../src/protocol/rootedPath.ts";
import { hasKnownKind, rasterImageMediaTypeForPath } from "../../../src/protocol/types.ts";
import {
  type ClipFactsResponse,
  type FileResponse,
  type FolderEntry,
  type FolderListingResponse,
  type FolderOrder,
  fetchFile,
  fetchFileRaw,
  fetchFolder,
  getPixelFormat,
  getVideoFormat,
  type PixelFormatResponse,
  postClipFacts,
  putThumbnail,
  rawFileUrl,
  thumbnailUrl,
  type VideoFormatResponse,
} from "../../core/apiClient.ts";
import { shownSort, showsManualOrder } from "../../core/folderOrder.ts";
import { isWritableRoot } from "../../core/libraries.ts";
import {
  CANT_OPEN,
  displayName,
  draggedPathInFlight,
  type EntryIcon,
  extensionOf,
  fileTypeLabel,
  folderContentsLabel,
  folderTitle,
  OPEN_FOLDER,
  OPEN_IN_NEW_TAB,
  pendingFileType,
  stripExtension,
  wireEntryDrag,
} from "../../core/paths.ts";
import { entryIconAt, fileTypeAt, findEntry, readingResolvers } from "../../core/spaceTree.ts";
import { contextOfTab } from "../../core/tabContext.ts";
import { createFilePreview, type PreviewKind, previewKind } from "../../filePreview.ts";
import type { ContextView } from "../../lib/contextView.ts";
import { dateTimeLabel } from "../../lib/dateText.ts";
import {
  appendMetaRow,
  createInspectorSection,
  formatDimensions,
  formatDuration,
  formatFileSize,
  formatFrameRate,
  must,
  setEntryIcon,
} from "../../lib/dom.ts";
import {
  attachEditInputHandlers,
  createPlaceholder,
  type NamingSurface,
  type PendingCreate,
} from "../../lib/inlineEdit.ts";
import { createInlineError } from "../../lib/inlineError.ts";
import { clipDetailRows, pictureDetailRows, pixelFormatRows } from "../../lib/mediaDetails.ts";
import { type ThumbnailHud, thumbnailHud } from "../../lib/mediaHud.ts";
import type { LoopChoice, VolumeChoice } from "../../lib/videoPlayer.ts";
import type { CommandRegistry } from "../../services/commands.ts";
import { contextView } from "../../services/contextViews.ts";
import type { DialogService } from "../../services/dialog.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import { type SortByTarget, setFolderLayout, setLocalSort, sortByItems } from "../../services/folderSorts.ts";
import type { FormatRegistry } from "../../services/formats.ts";
import type { ContextMenuService, MenuItem, MenuRegistry } from "../../services/menus.ts";
import type { Setting } from "../../services/settings.ts";
import * as settings from "../../services/settings.ts";
import type { OpenSource, Tabs } from "../../services/tabs.ts";
import { createThumbnailRenderer, type ThumbnailJob, type ThumbnailRenderer } from "../../services/thumbnails.ts";

// The narrowest a tile may get; the columns that fit are then widened to
// fill the row, so a resize never leaves a ragged gap at the right.
export const GALLERY_TILE_SIZES = [
  { id: "small", label: "Small", width: 112 },
  { id: "medium", label: "Medium", width: 168 },
  { id: "large", label: "Large", width: 248 },
] as const;
export type GalleryTileSize = (typeof GALLERY_TILE_SIZES)[number]["id"];

export function parseGalleryTileSize(stored: string): GalleryTileSize {
  return GALLERY_TILE_SIZES.find((size) => size.id === stored)?.id ?? "medium";
}

// The narrowest a card may get, widened to fill the row as tiles are.
const CARD_WIDTH = 286;

/** The Layout menu's entries: a tile size, one setting every folder shares,
 * or cards, which the folder keeps. */
const GALLERY_LAYOUTS: readonly { id: string; label: string; group: string }[] = [
  ...GALLERY_TILE_SIZES.map(({ id, label }) => ({ id: `tiles-${id}`, label: `${label} tiles`, group: "tiles" })),
  { id: "cards", label: "Cards", group: "cards" },
];

/** The same entries in the same order, each at the same version. */
function sameListing(a: readonly FolderEntry[], b: readonly FolderEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.path === b[i].path && entry.version === b[i].version);
}

const GAP = 12;
const PADDING = 16;
const LABEL_HEIGHT = 22;
// Rows drawn beyond each edge of the viewport, so a scroll shows tiles that
// already exist rather than ones being built.
const OVERSCAN_ROWS = 2;

export interface GridLayout {
  columns: number;
  /** A tile's width, which is also its picture's height. */
  tile: number;
  rowHeight: number;
  height: number;
}

/** `height` is an item's own, a card's; a tile's is its square and name. */
export function gridLayout(width: number, count: number, minTile: number, height?: number): GridLayout {
  const inner = Math.max(minTile, width - PADDING * 2);
  const columns = Math.max(1, Math.floor((inner + GAP) / (minTile + GAP)));
  const tile = Math.floor((inner - GAP * (columns - 1)) / columns);
  const rowHeight = (height ?? tile + LABEL_HEIGHT) + GAP;
  const rows = Math.ceil(count / columns);
  return { columns, tile, rowHeight, height: rows === 0 ? 0 : PADDING * 2 + rows * rowHeight - GAP };
}

/** The entries whose tiles should exist for this scroll position:
 * `[start, end)` in the sorted list. */
export function visibleRange(
  layout: GridLayout,
  scrollTop: number,
  viewportHeight: number,
  count: number,
): { start: number; end: number } {
  const firstRow = Math.max(0, Math.floor((scrollTop - PADDING) / layout.rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.ceil((scrollTop + viewportHeight - PADDING) / layout.rowHeight) + OVERSCAN_ROWS;
  return { start: Math.min(count, firstRow * layout.columns), end: Math.min(count, (lastRow + 1) * layout.columns) };
}

type TileKind = "directory" | PreviewKind | "other";

function tileKind(entry: FolderEntry): TileKind {
  if (entry.type === "directory") return "directory";
  return previewKind(entry.path) ?? "other";
}

const previewable = (entry: FolderEntry) => entry.type === "file" && previewKind(entry.path) !== undefined;

const cantOpen = (entry: FolderEntry) => entry.type === "file" && !hasKnownKind(entry.name);

// The tooltip a tile or card carries: its full name, and for a file Pragma
// can't open, that it can't.
const tileTooltip = (entry: FolderEntry) => (cantOpen(entry) ? `${entry.name}\n${CANT_OPEN}` : entry.name);

/** The folder above, in the same root; undefined at a root itself. */
export function parentFolder(folderPath: string): string | undefined {
  const { root, path } = parseRootedPath(folderPath);
  return path ? formatRootedPath({ root, path: dirnameOf(path) }) : undefined;
}

/** A tile's square, holding the entry's icon until a thumbnail covers it.
 * A plain file draws a page: a tile has nothing else to show. */
function tileFrame(icon: EntryIcon): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "gallery-tile-frame";
  const glyph = document.createElement("span");
  glyph.className = "gallery-tile-icon";
  setEntryIcon(glyph, { ...icon, glyph: icon.glyph ?? "file" });
  frame.append(glyph);
  return frame;
}

interface CardText {
  text: string;
  excerpt: boolean;
}

function cardText(entry: FolderEntry): CardText | undefined {
  if (entry.description) return { text: entry.description, excerpt: false };
  return entry.excerpt ? { text: entry.excerpt, excerpt: true } : undefined;
}

/** A card: the entry's icon and name over its description, or a note's
 * opening where it has none. */
function cardElement(icon: EntryIcon, name: HTMLElement, about: CardText | undefined): HTMLElement {
  const card = document.createElement("div");
  card.className = "card gallery-tile is-card";
  const head = document.createElement("div");
  head.className = "gallery-card-head";
  const glyph = document.createElement("span");
  glyph.className = "gallery-card-icon";
  setEntryIcon(glyph, { ...icon, glyph: icon.glyph ?? "file" });
  head.append(glyph, name);
  card.append(head);
  if (about) {
    const text = document.createElement("p");
    text.className = "gallery-card-description";
    text.classList.toggle("is-excerpt", about.excerpt);
    text.textContent = about.text;
    card.append(text);
  }
  return card;
}

export interface GalleryPaneDeps {
  listFolder(path: string): Promise<FolderListingResponse>;
  thumbnailUrl(path: string): string;
  rawFileUrl(path: string): string;
  /** A GET against the raw-file route, for an SVG's own text. */
  fetchFile(path: string): Promise<Response>;
  /** For a clip the browser couldn't decode, its facts from its header, kept
   * by the host in place of a thumbnail. */
  clipFacts(path: string, version: string): Promise<ClipFactsResponse>;
  /** A previewed clip's codec and frame rate, read from its header by the server. */
  videoFormat(path: string): Promise<VideoFormatResponse>;
  /** For a still listed without its header's facts, as one whose thumbnail
   * this browser made is: its color mode, bit depth and source, read from
   * its header by the server. */
  pixelFormat(path: string): Promise<PixelFormatResponse>;
  /** A file as a document route reads it, for its page. */
  loadFile(path: string): Promise<FileResponse>;
  /** Where the links and embeds in a previewed note at `docPath` lead. */
  readingResolvers: typeof readingResolvers;
  /** What draws a previewed document of another type on its page. */
  formats: Pick<FormatRegistry, "get">;
  renderer: ThumbnailRenderer;
  /** A file, shown in this tab in place of the folder. */
  openEntry(path: string, from?: OpenSource): void;
  /** A space link, a path cell or a picture clicked on a previewed page,
   * opened as reading view opens a link. */
  openPath(path: string): void;
  /** A folder, shown in this tab in place of the one it shows now. */
  openFolder(path: string): void;
  /** A right-click: on a tile, the menu its tree row has, with any name it
   * asks for typed through `naming`; on the space around them, the
   * toolbar's. */
  openMenu(at: { x: number; y: number }, tile?: { entry: FolderEntry; naming: NamingSurface }): void;
  /** Draws the menu of a preview's open button, and those a page opens. */
  contextMenu: ContextMenuService;
  /** Where a previewed Table's picture that has gone says why. */
  dialog: DialogService;
  showExtensions: Pick<Setting<boolean>, "get" | "subscribe">;
  /** Settings → Editor's, which a previewed note is laid out by. */
  readableLineLength: Pick<Setting<boolean>, "subscribe">;
  /** The Loop a previewed clip's player shares with every other. */
  videoLoop: LoopChoice;
  /** The volume a previewed clip's player shares with every other. */
  videoVolume: VolumeChoice;
  /** Each context's guides and look; a previewed still or clip shows the
   * ones of the context the gallery's tab is seen in. */
  views: (context: string) => ContextView;
  tileSize: Pick<Setting<string>, "get" | "set" | "subscribe">;
  /** Lays the folder out as tiles or cards on this install; every gallery
   * showing it lists it again. */
  setLayout(path: string, layout: FolderLayout): Promise<void>;
  /** The pane shows a new folder: its title is placed again. */
  onRendered(): void;
  /** Its line in the status bar, where a document's count goes. */
  reportReadout(text: string): void;
}

export interface GalleryPane extends EditorPane {
  readonly kind: "gallery";
  /** Lists the folder again, keeping the place in it. */
  refresh(): void;
  /** The folder shown, for its Sort by; undefined until it is listed. */
  sortTarget(): SortByTarget | undefined;
}

export function isGalleryPane(pane: EditorPane): pane is GalleryPane {
  return pane.kind === "gallery";
}

interface TileView {
  element: HTMLElement;
  dispose(): void;
}

// A name the tree's menu asked this gallery for: a listed entry's new name,
// or a new entry's, whose tile is a stand-in (`slot`) until the listing has it.
type Asked =
  | { kind: "rename"; path: string; submit(name: string): void }
  | { kind: "create"; pending: PendingCreate; submit(name: string): void; slot: FolderEntry };

export function createGalleryPane(deps: GalleryPaneDeps): GalleryPane {
  const element = document.createElement("div");
  element.className = "editor-gallery";
  element.tabIndex = 0;

  const scroller = document.createElement("div");
  scroller.className = "gallery-scroll";
  const canvas = document.createElement("div");
  canvas.className = "gallery-canvas";
  const status = document.createElement("div");
  status.className = "gallery-status";
  status.hidden = true;
  scroller.append(status, canvas);
  element.append(scroller);

  const details = createInspectorSection("Selected");
  const detailsTitle = must<HTMLElement>(".inspector-section-title", details.section);
  details.body.className = "meta-rows";

  let folderPath: string | undefined;
  let context = "";
  let listed: FolderEntry[] = [];
  let order: FolderOrder | undefined;
  let entries: FolderEntry[] = [];
  let selected: number | undefined;
  let layout: GridLayout | undefined;
  let folderLayout: FolderLayout = "tiles";
  let loadToken = 0;
  const tiles = new Map<number, TileView>();
  // Where each folder was left, for the session: stepping into another
  // folder and back should land where the browsing stopped.
  const places = new Map<string, { scrollTop: number; selectedPath?: string }>();
  // The name being typed on a tile, and what waited for its field to close.
  let asked: Asked | undefined;
  let field: { input: HTMLInputElement; whole(value: string): string } | undefined;
  let refreshWanted = false;
  let redrawWanted = false;

  // Over the grid, stepping through the folder's entries; the one shown is
  // the selected tile.
  const preview = createFilePreview({
    host: element,
    refocus: () => element.focus(),
    count: () => entries.length,
    fileAt: (index) => {
      const entry = entries[index];
      return entry && previewable(entry) ? entry : undefined;
    },
    rawFileUrl: deps.rawFileUrl,
    fetchFile: deps.fetchFile,
    videoFormat: deps.videoFormat,
    loadFile: deps.loadFile,
    readingResolvers: deps.readingResolvers,
    formats: deps.formats,
    contextMenu: deps.contextMenu,
    dialog: deps.dialog,
    readableLineLength: deps.readableLineLength,
    videoLoop: deps.videoLoop,
    videoVolume: deps.videoVolume,
    views: deps.views,
    context: () => context,
    openPath: deps.openPath,
    openInPlace: (index) => open(index),
    shown: (index) => select(index),
  });

  function remember(): void {
    if (folderPath === undefined) return;
    places.set(folderPath, {
      scrollTop: scroller.scrollTop,
      selectedPath: selected === undefined ? undefined : entries[selected]?.path,
    });
  }

  function showStatus(message: string | undefined, failed = false): void {
    if (failed && message !== undefined) status.replaceChildren(createInlineError({ message }));
    else status.textContent = message ?? "";
    status.hidden = message === undefined;
  }

  function renderDetails(): void {
    details.body.replaceChildren();
    const entry = selected === undefined ? undefined : entries[selected];
    details.section.hidden = entry === undefined;
    if (!entry) return;
    // Named for what is selected, by the name the tree's icon gives its kind.
    detailsTitle.textContent =
      entry.type === "directory" ? "Selected Folder" : `Selected ${fileTypeLabel(fileTypeAt(entry.path)) ?? "File"}`;
    appendMetaRow(details.body, "Name", entry.name);
    if (entry.width && entry.height)
      appendMetaRow(details.body, "Dimensions", formatDimensions(entry.width, entry.height));
    if (entry.duration !== undefined) appendMetaRow(details.body, "Duration", formatDuration(entry.duration));
    const still = entry.type === "file" && rasterImageMediaTypeForPath(entry.path) !== undefined;
    if (still && !entry.picture) readPicture(entry);
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
    for (const row of rows) appendMetaRow(details.body, row.label, row.value);
    if (entry.type === "file") appendMetaRow(details.body, "Size", formatFileSize(entry.size));
    appendMetaRow(details.body, "Modified", dateTimeLabel(entry.modified));
  }

  // A still whose thumbnail this browser made was listed without its
  // header's facts. They are read once, when it is first selected, and kept
  // on the entry, as a clip's are.
  const readingPictures = new WeakSet<FolderEntry>();
  function readPicture(entry: FolderEntry): void {
    if (readingPictures.has(entry)) return;
    readingPictures.add(entry);
    const keep = (picture: NonNullable<FolderEntry["picture"]>) => {
      Object.assign(entry, { picture });
      if (selected !== undefined && entries[selected] === entry) renderDetails();
    };
    deps.pixelFormat(entry.path).then(
      ({ sourceType, ...pixels }) => keep({ sourceType, pixels }),
      () => keep({ sourceType: null, pixels: null }),
    );
  }

  // ---- tiles ------------------------------------------------------------

  function placeTile(tile: HTMLElement, index: number): void {
    if (!layout) return;
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    tile.style.width = `${layout.tile}px`;
    tile.style.transform = `translate(${PADDING + column * (layout.tile + GAP)}px, ${PADDING + row * layout.rowHeight}px)`;
    if (folderLayout === "cards") tile.style.height = `${layout.rowHeight - GAP}px`;
    else tile.style.setProperty("--gallery-tile-size", `${layout.tile}px`);
  }

  function nameLine(entry: FolderEntry): HTMLElement {
    const name = document.createElement("div");
    name.className = "caption gallery-tile-name";
    name.classList.toggle("cant-open", cantOpen(entry));
    name.textContent = displayName(entry, deps.showExtensions.get());
    return name;
  }

  // A new entry's stand-in: its kind's glyph over the field its name is typed
  // in. It leaves with the field; the listing then has the real one.
  function buildSlotTile(pending: PendingCreate, input: HTMLInputElement, index: number): TileView {
    const icon: EntryIcon = { glyph: pending.type === "directory" ? "folder" : pendingFileType(pending) };
    let tile: HTMLElement;
    if (folderLayout === "cards") tile = cardElement(icon, input, undefined);
    else {
      tile = document.createElement("div");
      tile.className = "gallery-tile";
      tile.append(tileFrame(icon), input);
    }
    tile.dataset.index = String(index);
    return { element: tile, dispose: () => tile.remove() };
  }

  function buildCard(entry: FolderEntry, index: number): TileView {
    const renaming = field && asked?.kind === "rename" && asked.path === entry.path ? field.input : undefined;
    const card = cardElement(entryIconAt(entry.path, entry.type), renaming ?? nameLine(entry), cardText(entry));
    card.classList.toggle("is-selected", index === selected);
    card.dataset.index = String(index);
    card.dataset.tooltip = tileTooltip(entry);
    card.draggable = renaming === undefined;
    return { element: card, dispose: () => card.remove() };
  }

  // Every card in a folder is as tall as its tallest, so the rows keep one
  // height and only those on screen need exist. Measured on a hidden stand-in
  // at the cards' width, once for a width and a listing.
  let measured: { width: number; entries: FolderEntry[]; height: number } | undefined;
  function cardHeight(width: number): number {
    if (measured?.width === width && measured.entries === entries) return measured.height;
    const name = document.createElement("div");
    name.className = "caption gallery-tile-name";
    name.textContent = "\u00a0";
    const probe = cardElement({}, name, { text: "\u00a0", excerpt: false });
    const description = probe.querySelector<HTMLElement>(".gallery-card-description");
    probe.style.visibility = "hidden";
    probe.style.width = `${width}px`;
    canvas.append(probe);
    let height = 0;
    const seen = new Set<string>();
    for (const about of entries.map(cardText)) {
      const key = about ? `${about.excerpt}\n${about.text}` : "";
      if (seen.has(key)) continue;
      seen.add(key);
      if (description) {
        description.hidden = about === undefined;
        description.textContent = about?.text ?? "";
        description.classList.toggle("is-excerpt", about?.excerpt === true);
      }
      height = Math.max(height, probe.offsetHeight);
    }
    probe.remove();
    measured = { width, entries, height };
    return height;
  }

  function buildTile(entry: FolderEntry, index: number): TileView {
    const kind = tileKind(entry);
    const tile = document.createElement("div");
    tile.className = "gallery-tile";
    tile.classList.toggle("is-selected", index === selected);
    tile.dataset.index = String(index);
    tile.dataset.tooltip = tileTooltip(entry);
    const renaming = field && asked?.kind === "rename" && asked.path === entry.path ? field.input : undefined;
    tile.draggable = renaming === undefined;

    const frame = tileFrame(entryIconAt(entry.path, entry.type));
    tile.append(frame, renaming ?? nameLine(entry));

    let job: ThumbnailJob | undefined;
    let made: string | undefined;
    let disposed = false;
    let image: HTMLImageElement | undefined;
    let hud: ThumbnailHud | undefined;
    if (kind === "image" || kind === "svg" || kind === "video") {
      const img = document.createElement("img");
      image = img;
      img.className = "gallery-tile-thumb";
      img.alt = "";
      img.decoding = "async";
      // A thumbnail's bytes would pass for the file's in an app outside
      // Pragma, so the tile drags as its entry alone.
      img.draggable = false;
      img.addEventListener("load", () => tile.classList.add("has-thumbnail"));
      // Made here when the host has none for this version — or had one the
      // listing promised and has since lost — shown at once, and handed to
      // the host by the renderer for every later visit.
      const make = (thumbnailKind: "image" | "video") => {
        if (job || disposed) return;
        job = deps.renderer.render({ path: entry.path, version: entry.version, kind: thumbnailKind });
        job.result.then(
          ({ image: blob, width, height, duration }) => {
            // Kept on the entry, so the tile drawn for it after a scroll, and
            // the Info tab, know what this one learned.
            Object.assign(entry, { width, height, ...(duration === undefined ? {} : { duration }) });
            if (disposed) return;
            hud?.fill(entry);
            if (selected !== undefined && entries[selected] === entry) renderDetails();
            made = URL.createObjectURL(blob);
            img.src = made;
          },
          () => {
            tile.classList.add("no-thumbnail");
            // A clip the browser can't decode gets its facts from its header
            // instead, kept by the host for the folder's next listing.
            if (disposed || thumbnailKind !== "video" || entry.clip) return;
            deps.clipFacts(entry.path, entry.version).then(
              (facts) => {
                Object.assign(entry, facts);
                if (disposed) return;
                hud?.fill(entry);
                if (selected !== undefined && entries[selected] === entry) renderDetails();
              },
              () => undefined,
            );
          },
        );
      };
      if (kind === "svg") img.src = deps.rawFileUrl(entry.path);
      else if (!entry.thumbnail) make(kind);
      else {
        img.addEventListener("error", () => make(kind), { once: true });
        // The version rides along so a file changed in this session gets a
        // new URL, never the image the page already holds for the old one.
        img.src = `${deps.thumbnailUrl(entry.path)}&v=${encodeURIComponent(entry.version)}`;
      }
      frame.append(img);
    }
    if (kind === "video") {
      const badge = document.createElement("span");
      badge.className = "gallery-tile-badge";
      frame.append(badge);
    }
    // Last in the square, over the picture and the badge.
    if (kind === "image" || kind === "svg" || kind === "video") {
      hud = thumbnailHud(frame);
      hud.fill(entry);
    }
    // A still's scale is measured as the pointer enters the tile, whose hover
    // shows the bars: the square follows the pane's width.
    if (kind === "image" || kind === "svg") tile.addEventListener("pointerenter", () => hud?.measure());

    return {
      element: tile,
      dispose() {
        disposed = true;
        job?.cancel();
        image?.removeAttribute("src");
        if (made) URL.revokeObjectURL(made);
        tile.remove();
      },
    };
  }

  function clearTiles(): void {
    for (const tile of tiles.values()) tile.dispose();
    tiles.clear();
  }

  // The title scrolls in the same region, above the canvas, so the grid's
  // own offset is the region's less the canvas's top. Tile coordinates are
  // the grid's.
  const gridScroll = () => scroller.scrollTop - canvas.offsetTop;

  // The tile the field is on, which stays while scrolled away: what was
  // typed lives in it.
  function fieldIndex(): number {
    const ask = asked;
    if (!field || !ask) return -1;
    return ask.kind === "create" ? entries.indexOf(ask.slot) : entries.findIndex((entry) => entry.path === ask.path);
  }

  function renderWindow(): void {
    if (!layout) return;
    const { start, end } = visibleRange(layout, gridScroll(), scroller.clientHeight, entries.length);
    const pinned = fieldIndex();
    for (const [index, tile] of tiles) {
      if ((index < start || index >= end) && index !== pinned) {
        tile.dispose();
        tiles.delete(index);
      }
    }
    for (let index = start; index < end; index++) {
      if (tiles.has(index)) continue;
      const entry = entries[index];
      const tile =
        asked?.kind === "create" && entry === asked.slot && field
          ? buildSlotTile(asked.pending, field.input, index)
          : folderLayout === "cards"
            ? buildCard(entry, index)
            : buildTile(entry, index);
      placeTile(tile.element, index);
      canvas.append(tile.element);
      tiles.set(index, tile);
    }
  }

  // A change of columns keeps the first row on screen at the top, rather
  // than the scroll offset, which would land on unrelated rows. The grid's
  // first row goes back to the very top, title and all.
  function relayout(): void {
    if (folderPath === undefined || scroller.clientWidth === 0) return;
    const size = GALLERY_TILE_SIZES.find(({ id }) => id === parseGalleryTileSize(deps.tileSize.get()));
    const before = layout;
    const anchor = before ? Math.round(Math.max(0, gridScroll()) / before.rowHeight) * before.columns : 0;
    const width = scroller.clientWidth;
    layout =
      folderLayout === "cards"
        ? gridLayout(width, entries.length, CARD_WIDTH, cardHeight(gridLayout(width, entries.length, CARD_WIDTH).tile))
        : gridLayout(width, entries.length, size?.width ?? 168);
    canvas.style.height = `${layout.height}px`;
    if (before && (before.columns !== layout.columns || before.tile !== layout.tile)) {
      const row = Math.floor(anchor / layout.columns);
      scroller.scrollTop = row === 0 ? 0 : canvas.offsetTop + row * layout.rowHeight;
    }
    for (const [index, tile] of tiles) placeTile(tile.element, index);
    renderWindow();
  }

  const selectedPath = (): string | undefined => (selected === undefined ? undefined : entries[selected]?.path);

  // A new entry's stand-in goes where the listing will put it: last in a
  // manual or property order, which list what they don't name or value
  // last; else first among its kind, folders leading.
  function withSlot(listing: FolderEntry[]): FolderEntry[] {
    if (!field || asked?.kind !== "create" || asked.pending.parentPath !== folderPath) return listing;
    const mixed = order !== undefined && ["manual", "property"].includes(shownSort(order).by);
    const folders = listing.filter((entry) => entry.type === "directory").length;
    const at = mixed ? listing.length : asked.pending.type === "directory" ? 0 : folders;
    return [...listing.slice(0, at), asked.slot, ...listing.slice(at)];
  }

  /** Redraws every tile, with the selection on `keep`'s entry. */
  function rebuild(keep = selectedPath()): void {
    const previewIndex = preview.shownIndex();
    const previewed = previewIndex === undefined ? undefined : entries[previewIndex]?.path;
    entries = withSlot(listed);
    const index = keep === undefined ? -1 : entries.findIndex((entry) => entry.path === keep);
    selected = index === -1 ? undefined : index;
    // The preview follows its entry to wherever the listing put it, and goes
    // with it, leaving focus where it was: a refresh is nobody's keypress.
    const shown = previewed === undefined ? -1 : entries.findIndex((entry) => entry.path === previewed);
    if (shown !== -1) preview.moved(shown);
    else if (previewed !== undefined) preview.close(false);
    clearTiles();
    deps.reportReadout(folderContentsLabel(listed));
    renderDetails();
    showStatus(entries.length === 0 ? "Nothing in this folder to show." : undefined);
    relayout();
  }

  let frameRequested = false;
  scroller.addEventListener("scroll", () => {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      renderWindow();
    });
  });
  const resize = new ResizeObserver(() => {
    relayout();
    preview.fit();
  });
  resize.observe(scroller);

  // ---- selection and opening --------------------------------------------

  function select(index: number | undefined): void {
    if (selected !== undefined) tiles.get(selected)?.element.classList.remove("is-selected");
    selected = index === undefined ? undefined : Math.max(0, Math.min(entries.length - 1, index));
    if (selected !== undefined) {
      tiles.get(selected)?.element.classList.add("is-selected");
      revealIndex(selected);
    }
    renderDetails();
  }

  // The first row comes into view with the title above it, as it opened.
  function revealIndex(index: number): void {
    if (!layout) return;
    const row = Math.floor(index / layout.columns);
    const top = canvas.offsetTop + PADDING + row * layout.rowHeight;
    const bottom = top + layout.rowHeight - GAP;
    if (top < scroller.scrollTop) scroller.scrollTop = row === 0 ? 0 : top - PADDING;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight + PADDING;
    }
  }

  function open(index: number): void {
    const entry = entries[index];
    if (!entry) return;
    const tile = tiles.get(index)?.element;
    if (entry.type === "directory") deps.openFolder(entry.path);
    else deps.openEntry(entry.path, tile ? { anchor: tile, marked: true } : undefined);
  }

  function goUp(): void {
    const parent = folderPath === undefined ? undefined : parentFolder(folderPath);
    if (parent !== undefined) deps.openFolder(parent);
  }

  // ---- naming -----------------------------------------------------------
  //
  // A rename or a create from a tile's menu is typed on the tile. While the
  // field is up, a refresh or a redraw waits for it to close: rebuilt, the
  // tile would take what was typed with it.

  function nameField(value: string, placeholder: string, whole: (value: string) => string) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "gallery-tile-field";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    attachEditInputHandlers(
      input,
      () => {
        if (field?.input === input) closeField(true);
      },
      () => {
        if (field?.input === input) closeField(false);
      },
    );
    // A double-click in the field selects a word; on its tile it would open.
    input.addEventListener("dblclick", (event) => event.stopPropagation());
    return { input, whole };
  }

  // Draws the field once its tile can exist: a rename's entry listed (a
  // duplicate's copy lists a moment after it is asked for), a create's
  // folder shown. With `relist`, a rename whose entry isn't listed yet asks
  // for a listing; without, it is dropped.
  function showAsked(relist: boolean): void {
    const ask = asked;
    if (!ask || field || folderPath === undefined) return;
    let index: number;
    if (ask.kind === "create") {
      if (ask.pending.parentPath !== folderPath) return;
      field = nameField(ask.pending.initialName ?? "", createPlaceholder(ask.pending), (value) => value);
      rebuild();
      index = entries.indexOf(ask.slot);
    } else {
      index = entries.findIndex((entry) => entry.path === ask.path);
      if (index === -1) {
        if (relist) void load(true);
        else asked = undefined;
        return;
      }
      const entry = entries[index];
      const full = deps.showExtensions.get() || entry.type === "directory" || cantOpen(entry);
      const extension = full ? "" : extensionOf(entry.name);
      field = nameField(full ? entry.name : stripExtension(entry.name), "", (value) => value + extension);
      select(index);
    }
    revealIndex(index);
    renderWindow();
    const tile = tiles.get(index)?.element;
    tile?.querySelector(".gallery-tile-name")?.replaceWith(field.input);
    if (tile) tile.draggable = false;
    field.input.focus();
    field.input.select();
  }

  // Puts the tile back and runs what waited, then hands a committed name to
  // whoever asked. Focus returns to the grid only when the field still had
  // it (Enter, Escape), never taken from wherever a click put it.
  function closeField(commit: boolean): void {
    const ask = asked;
    const shown = field;
    if (!ask || !shown) return;
    const refocus = document.activeElement === shown.input;
    asked = undefined;
    field = undefined;
    if (ask.kind === "create" || redrawWanted) rebuild();
    else {
      const index = entries.findIndex((entry) => entry.path === ask.path);
      const tile = tiles.get(index)?.element;
      if (tile?.contains(shown.input)) {
        shown.input.replaceWith(nameLine(entries[index]));
        tile.draggable = true;
      }
      renderWindow();
    }
    redrawWanted = false;
    if (refocus) element.focus({ preventScroll: true });
    if (refreshWanted) {
      refreshWanted = false;
      void load(true);
    }
    if (commit) ask.submit(shown.whole(shown.input.value));
  }

  const naming: NamingSurface = {
    rename(path, submit) {
      closeField(true);
      asked = { kind: "rename", path, submit };
      showAsked(true);
    },
    // Asked for inside a folder tile, it steps into that folder first, as the
    // tree opens a folder to show its new row; the field waits for the listing.
    create(pending, submit) {
      closeField(true);
      const slot: FolderEntry = {
        name: "",
        path: "",
        type: pending.type,
        size: 0,
        modified: "",
        version: "",
        thumbnail: false,
      };
      asked = { kind: "create", pending, submit, slot };
      if (pending.parentPath === folderPath) showAsked(true);
      else deps.openFolder(pending.parentPath);
    },
  };

  // ---- input ------------------------------------------------------------

  // The listed entry a tile event is on: never a new entry's stand-in, nor a
  // tile the press that began the event already redrew away.
  const tileIndexOf = (event: Event): number | undefined => {
    const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>(".gallery-tile");
    if (!tile?.isConnected || tile.dataset.index === undefined) return undefined;
    const index = Number(tile.dataset.index);
    return asked?.kind === "create" && entries[index] === asked.slot ? undefined : index;
  };

  canvas.addEventListener("click", (event) => {
    const index = tileIndexOf(event);
    if (index !== undefined && previewable(entries[index])) preview.show(index);
    else select(index);
  });
  canvas.addEventListener("dblclick", (event) => {
    const index = tileIndexOf(event);
    if (index !== undefined) open(index);
  });
  // A tile's menu is its tree row's, the tile selected first so the Info tab
  // shows what the menu acts on; the browser's would offer to save the
  // thumbnail as if it were the file. The space around the tiles has the
  // toolbar's menu, and the name field gets the text menu.
  scroller.addEventListener("contextmenu", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    const index = tileIndexOf(event);
    if (index === undefined) deps.openMenu(at);
    else {
      select(index);
      deps.openMenu(at, { entry: entries[index], naming });
    }
  });
  // A tile drags like the tree row for the same file: into a note, a media
  // field or a Load Image node. Never a move to another folder: the only
  // drop a gallery takes is one of its own entries, or that entry's tree
  // row, arranging a folder shown in manual order.
  wireEntryDrag(canvas, (event) => {
    const index = tileIndexOf(event);
    return index === undefined ? undefined : entries[index];
  });

  let marked: HTMLElement | undefined;
  function mark(tile: HTMLElement | undefined, after = false): void {
    marked?.classList.remove("drop-before", "drop-after");
    marked = tile;
    tile?.classList.add(after ? "drop-after" : "drop-before");
  }

  // Before or after the tile under the pointer, by the half it is over.
  function dropAt(
    event: DragEvent,
  ): { dragged: FolderEntry; target: FolderEntry; after: boolean; tile: HTMLElement } | undefined {
    const inFlight = draggedPathInFlight();
    if (!order || !showsManualOrder(order) || !inFlight) return undefined;
    const path = formatRootedPath(inFlight);
    const dragged = listed.find((entry) => entry.path === path);
    const index = tileIndexOf(event);
    const target = index === undefined ? undefined : entries[index];
    const tile = (event.target as HTMLElement).closest<HTMLElement>(".gallery-tile");
    if (!dragged || !target || target === dragged || !tile) return undefined;
    const box = tile.getBoundingClientRect();
    return { dragged, target, after: event.clientX > box.left + box.width / 2, tile };
  }

  canvas.addEventListener("dragover", (event) => {
    const drop = dropAt(event);
    mark(drop?.tile, drop?.after);
    if (!drop) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  canvas.addEventListener("dragleave", (event) => {
    if (!canvas.contains(event.relatedTarget as Node | null)) mark(undefined);
  });
  canvas.addEventListener("drop", (event) => {
    const drop = dropAt(event);
    mark(undefined);
    if (!drop || folderPath === undefined) return;
    event.preventDefault();
    const names = listed.filter((entry) => entry !== drop.dragged).map((entry) => entry.name);
    names.splice(names.indexOf(drop.target.name) + (drop.after ? 1 : 0), 0, drop.dragged.name);
    // On this install only, until the folder's Sort by sets it as default.
    setLocalSort(folderPath, { by: "manual" }, names).catch((error: unknown) =>
      window.alert(error instanceof Error ? error.message : "Failed to reorder."),
    );
  });
  canvas.addEventListener("dragend", () => mark(undefined));

  element.addEventListener("keydown", (event) => {
    if (event.target !== element || event.metaKey || event.ctrlKey) return;
    const columns = layout?.columns ?? 1;
    const last = entries.length - 1;
    const from = selected ?? -1;
    let handled = true;
    if (preview.shownIndex() !== undefined) handled = preview.key(event.key);
    else if (event.key === "ArrowRight") select(Math.min(last, from + 1));
    else if (event.key === "ArrowLeft") select(Math.max(0, from - 1));
    else if (event.key === "ArrowDown" && !event.altKey) select(Math.min(last, from + columns));
    else if (event.key === "ArrowUp" && event.altKey) goUp();
    else if (event.key === "ArrowUp") select(Math.max(0, from - columns));
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(last);
    else if (event.key === "Enter" && selected !== undefined) open(selected);
    else if (event.key === " " && selected !== undefined) preview.show(selected);
    else if (event.key === "Backspace") goUp();
    else handled = false;
    if (handled) event.preventDefault();
  });

  // Each fires once on subscribe, before any folder is shown; relayout and
  // rebuild do nothing until one is.
  const unsubscribe = [
    deps.tileSize.subscribe(() => relayout()),
    deps.showExtensions.subscribe(() => {
      if (field) redrawWanted = true;
      else {
        clearTiles();
        renderWindow();
      }
    }),
  ];

  /** Lists the folder and draws it. A fresh open lands where this session
   * last left the folder; a refresh stays where it is. */
  async function load(keepPlace: boolean): Promise<void> {
    if (folderPath === undefined) return;
    const path = folderPath;
    const token = ++loadToken;
    if (!keepPlace) showStatus("Loading…");
    let listing: FolderListingResponse;
    try {
      listing = await deps.listFolder(path);
    } catch (error) {
      if (token !== loadToken) return;
      listed = [];
      entries = [];
      clearTiles();
      canvas.style.height = "0";
      deps.reportReadout("");
      showStatus(error instanceof Error ? error.message : "Failed to list this folder.", true);
      return;
    }
    if (token !== loadToken) return;
    if (keepPlace && field) {
      refreshWanted = true;
      return;
    }
    order = listing.order;
    const relaid = (listing.layout ?? "tiles") !== folderLayout;
    folderLayout = listing.layout ?? "tiles";
    // A refresh runs on every window focus and space change. One that finds
    // the folder unchanged keeps its tiles, or every thumbnail redraws. An
    // empty listing still redraws, to clear a failed load's message.
    if (!keepPlace || relaid || listed.length === 0 || !sameListing(listed, listing.entries)) {
      const place = keepPlace ? { scrollTop: scroller.scrollTop, selectedPath: selectedPath() } : places.get(path);
      listed = listing.entries;
      rebuild(place?.selectedPath);
      scroller.scrollTop = place?.scrollTop ?? 0;
      renderWindow();
    }
    // A create asked for inside a folder tile waited for that folder; any
    // other folder opening means the person went elsewhere instead.
    if (!keepPlace && asked?.kind === "create" && asked.pending.parentPath !== path) asked = undefined;
    showAsked(false);
  }

  function clearInput(): void {
    // Leaving the folder is a click away from a field, which commits it.
    refreshWanted = false;
    redrawWanted = false;
    closeField(true);
    remember();
    preview.close();
    loadToken++;
    clearTiles();
    folderPath = undefined;
    listed = [];
    order = undefined;
    entries = [];
    selected = undefined;
    layout = undefined;
    folderLayout = "tiles";
    details.section.hidden = true;
  }

  return {
    kind: "gallery",
    element,
    inspector: details.section,
    async setInput(tab) {
      if (tab.kind !== "gallery") throw new Error(`the gallery pane can't show a "${tab.kind}" tab`);
      clearInput();
      folderPath = tab.path;
      context = contextOfTab(tab);
      canvas.style.height = "0";
      deps.onRendered();
      await load(false);
    },
    clearInput,
    title: () => (folderPath === undefined ? undefined : folderTitle(folderPath)),
    titleHost: () => scroller, // scrolls away with the tiles
    refresh: () => void load(true),
    sortTarget() {
      if (folderPath === undefined || !order) return undefined;
      return {
        path: folderPath,
        name: folderTitle(folderPath),
        order,
        shown: () => listed.map((entry) => entry.name),
        keepsOrder: !isLibraryRoot(parseRootedPath(folderPath).root),
      };
    },
    // A tile size is one setting for every folder; picking one also lays
    // this folder out as tiles.
    layout: {
      current: () => (folderLayout === "cards" ? "cards" : `tiles-${parseGalleryTileSize(deps.tileSize.get())}`),
      available: () => GALLERY_LAYOUTS,
      set(id) {
        const path = folderPath;
        if (path === undefined) return;
        const size = GALLERY_TILE_SIZES.find((option) => `tiles-${option.id}` === id);
        if (size) deps.tileSize.set(size.id);
        const next: FolderLayout = id === "cards" ? "cards" : "tiles";
        if (next === folderLayout) return;
        deps.setLayout(path, next).then(
          () => load(true),
          (error: unknown) => window.alert(error instanceof Error ? error.message : "Failed to change the layout."),
        );
      },
    },
    hasTransient: () => preview.shownIndex() !== undefined,
    dismissTransient: () => preview.close(),
    // The preview selects each file it shows, so the tile is the file either way.
    selectedFile() {
      const path = selectedPath();
      return path ? { path, previewing: preview.shownIndex() !== undefined } : undefined;
    },
    dispose() {
      clearInput();
      preview.dispose();
      for (const stop of unsubscribe) stop();
      resize.disconnect();
      element.remove();
    },
  };
}

// ---- wiring ---------------------------------------------------------------

/** What a menu's argument names as a folder to open as a gallery: a tree
 * row that is a folder (the space's, a site's, a library's), the space
 * tree's empty area for the space itself, a Libraries row for that
 * library's root, or the `{ folder }` of a Flow chip or the status bar's
 * path. Undefined for anything else, which hides the item. */
export function galleryFolderOf(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("folder" in arg && typeof arg.folder === "string") return arg.folder;
  const target = arg as {
    kind?: string;
    id?: string;
    missing?: boolean;
    libraryId?: string;
    node?: { type: string; path: string } | null;
  };
  if (target.kind === "library" && target.id !== undefined) {
    return target.missing ? undefined : formatRootedPath({ root: { library: target.id }, path: "" });
  }
  if (!("node" in target)) return undefined;
  const { node, libraryId } = target;
  if (node === null || node === undefined) return libraryId === undefined ? "" : undefined;
  if (node.type !== "directory") return undefined;
  return libraryId === undefined ? node.path : formatRootedPath({ root: { library: libraryId }, path: node.path });
}

export interface GalleryWiring {
  commands: CommandRegistry;
  menus: MenuRegistry;
  contextMenu: ContextMenuService;
  /** A getter: the tab session is built after the panes are registered. */
  tabs(): Pick<Tabs, "openEntry" | "openFolder" | "openFolderToSide" | "openSpacePath">;
  /** For Sort by's property picker. */
  dialog(): DialogService;
  formats: Pick<FormatRegistry, "get">;
}

/** The menu an entry's tree row has, and the argument that row passes, its
 * names typed on `naming`: a command run with it answers for the entry as
 * it does in the tree. */
export function treeRowMenu(
  entry: Pick<FolderEntry, "name" | "path" | "type">,
  naming: NamingSurface,
): { menu: "tree" | "libraryTree"; arg: unknown } {
  const { root, path } = parseRootedPath(entry.path);
  const node = { name: entry.name, path, type: entry.type };
  if (isLibraryRoot(root)) {
    return { menu: "libraryTree", arg: { libraryId: root.library, node, writable: isWritableRoot(root), naming } };
  }
  // The tree's own node where it lists one: Properties and a folder's delete
  // warning read what it carries.
  return { menu: "tree", arg: { node: findEntry(path) ?? node, naming } };
}

/** What a right-click opens: on a tile, its tree row's menu; on the space
 * around the tiles, the toolbar's. */
export function galleryMenu(tile?: { entry: FolderEntry; naming: NamingSurface }): {
  menu: string;
  arg?: unknown;
  ariaLabel: string;
} {
  if (!tile) return { menu: "editor.toolbar", ariaLabel: "More options" };
  const row = treeRowMenu(tile.entry, tile.naming);
  return { ...row, ariaLabel: row.menu === "tree" ? "Tree actions" : "Library actions" };
}

/** A folder's Open, Open in new tab and Open to the side, which folder menus
 * name by id in their own lists, and the gallery's own item on the toolbar
 * menu, its order. Its layout is the chrome's Layout menu, from the pane. */
function registerGalleryCommands(wiring: GalleryWiring): void {
  const { commands, menus } = wiring;

  // Open is a folder row's Open button: the folder in the focused tab's
  // place, a step Back returns from. The other two carry the labels a file's
  // row has.
  commands.register({
    id: "gallery.openFolder",
    label: OPEN_FOLDER,
    when: (_, arg) => galleryFolderOf(arg) !== undefined,
    run: (_, arg) => {
      const folder = galleryFolderOf(arg);
      if (folder !== undefined) void wiring.tabs().openFolder(folder);
    },
  });
  commands.register({
    id: "gallery.openFolderInNewTab",
    label: OPEN_IN_NEW_TAB,
    when: (_, arg) => galleryFolderOf(arg) !== undefined,
    run: (_, arg) => {
      const folder = galleryFolderOf(arg);
      if (folder !== undefined) void wiring.tabs().openFolder(folder, true);
    },
  });
  commands.register({
    id: "gallery.openFolderToSide",
    label: "Open to the side",
    when: (_, arg) => galleryFolderOf(arg) !== undefined,
    run: (_, arg) => {
      const folder = galleryFolderOf(arg);
      if (folder !== undefined) void wiring.tabs().openFolderToSide(folder);
    },
  });

  // Sort by is the folder's, the same as on its tree row. No group: the
  // chrome's Layout follows it with no line between.
  const sortBy: MenuItem = {
    label: "Sort by",
    submenu: (context) => {
      const target = context.pane && isGalleryPane(context.pane) ? context.pane.sortTarget() : undefined;
      return target ? sortByItems(target, wiring.dialog) : [];
    },
  };
  menus.register("editor.toolbar", (context) => (context.tab.kind === "gallery" ? [sortBy] : []));
}

const CHROME = { toolbar: true, readingView: false, statusbar: true, actions: [] } as const;

/** The gallery's pane and its commands. The routes, the renderer and the
 * settings are bound here; the pane factory still takes them as deps, for
 * tests. */
export function galleryPane(wiring: GalleryWiring): EditorPaneDescriptor {
  registerGalleryCommands(wiring);
  const renderer = createThumbnailRenderer({ rawFileUrl, upload: putThumbnail });
  const deps: Omit<GalleryPaneDeps, "dialog" | "onRendered" | "reportReadout"> = {
    listFolder: fetchFolder,
    thumbnailUrl,
    rawFileUrl,
    fetchFile: fetchFileRaw,
    clipFacts: postClipFacts,
    videoFormat: getVideoFormat,
    pixelFormat: getPixelFormat,
    loadFile: fetchFile,
    readingResolvers,
    formats: wiring.formats,
    renderer,
    openEntry: (path, from) => void wiring.tabs().openEntry(path, { from }),
    openPath: (path) => void wiring.tabs().openSpacePath(path),
    openFolder: (path) => void wiring.tabs().openFolder(path),
    openMenu: (at, tile) => wiring.contextMenu.open({ ...galleryMenu(tile), at }),
    contextMenu: wiring.contextMenu,
    showExtensions: settings.showExtensions,
    readableLineLength: settings.readableLineLength,
    videoLoop: settings.videoLoop,
    videoVolume: settings.videoVolume,
    views: contextView,
    tileSize: settings.galleryTileSize,
    setLayout: setFolderLayout,
  };
  return {
    kind: "gallery",
    chrome: CHROME,
    create: (group) =>
      createGalleryPane({
        ...deps,
        dialog: wiring.dialog(),
        onRendered: () => group.rendered(),
        reportReadout: (text) => group.reportReadout(text),
      }),
  };
}
