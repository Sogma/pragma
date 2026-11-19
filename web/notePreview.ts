// A note, a Table, or a document of another type in its format's locked
// editor, shown on a plain page as its reading view: the gallery's preview of
// its tile, the one a link to it opens while the pointer rests on the link,
// and a tab's (view/tabPreview.ts). Each shows at most at a set share of full
// size; the gallery's and a link's with a control that opens the file.
//
// The page lays out at a note's measure, narrower than the editor's, and is
// zoomed to the size shown, so a note's lines break at the same words
// whatever size it shows at; below a legible floor it rewraps. A Table's
// page is the same size, and a grid wider than it scrolls sideways in it.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { documentTypeFor, isMarkdownFile, isTableFile } from "../src/protocol/types.ts";
import type { FileResponse, TableFileResponse, TextFileResponse } from "./core/apiClient.ts";
import { countWordsAndChars, formatWordCount, splitDocumentProperties, titleBarOf } from "./core/documentContent.ts";
import { OPEN_IN_NEW_TAB, shownTitle, tableContentsLabel } from "./core/paths.ts";
import type { readingResolvers } from "./core/spaceTree.ts";
import { createCell, createTableForm } from "./lib/dataGrid.ts";
import { type Disposable, DisposableStore, listen } from "./lib/disposable.ts";
import { addCodeBlockCopyButtons, createTitleBar } from "./lib/dom.ts";
import { createInlineError } from "./lib/inlineError.ts";
import { renderMarkdown } from "./markdownRender.ts";
import type { DialogService } from "./services/dialog.ts";
import type { FormatContext, FormatRegistry } from "./services/formats.ts";
import type { ContextMenuService } from "./services/menus.ts";
import { tableCellControls } from "./tableCells.ts";

/** The share of full size a preview's page shows at, at most. */
export const PAGE_PREVIEW_SCALE = 0.9;

// Below this the text would be too small to read, so the page keeps the
// size shown and rewraps instead.
const MIN_PAGE_ZOOM = 0.75;

/** How far a page, laid out `natural` px wide at the preview's measure, is
 * zoomed to show `shown` px wide: enough to keep a note's line breaks,
 * within a legible floor and full size. */
export function pageZoom(shown: number, natural: number): number {
  return Math.max(MIN_PAGE_ZOOM, Math.min(1, shown / natural));
}

/** What a preview draws on a page: a note rendered, a Table, or a document of
 * another type in its format's locked editor. */
export type PageKind = "note" | "table" | "editor";

/** How the file at `path` shows on a page, or undefined for a kind that
 * doesn't. */
export function pageKind(path: string): PageKind | undefined {
  if (isMarkdownFile(path)) return "note";
  if (isTableFile(path)) return "table";
  if (documentTypeFor(path) !== "note") return "editor";
  return undefined;
}

/** An empty page (web/styles/note-preview.css) for a file of `kind`,
 * scrolling on its own. */
export function createPage(kind: PageKind): HTMLElement {
  const page = document.createElement("article");
  page.className = `preview-page ${kind}-page`;
  return page;
}

/** Fits a page into the size its frame shows, measured at its own laid-out
 * width each time. */
export function fitPage(frame: HTMLElement, page: HTMLElement): void {
  for (const property of ["zoom", "width", "height"]) page.style.removeProperty(property);
  const natural = page.offsetWidth;
  const { clientWidth: width, clientHeight: height } = frame;
  if (natural === 0 || width === 0) return;
  const zoom = pageZoom(width, natural);
  page.style.setProperty("zoom", String(zoom));
  page.style.width = `${width / zoom}px`;
  page.style.height = `${height / zoom}px`;
}

// The note as reading view draws it, with its count over the text the
// editor would hold, in the status bar's words.
function fillNotePage(
  page: HTMLElement,
  path: string,
  file: TextFileResponse,
  resolvers: typeof readingResolvers,
): string {
  const split = splitDocumentProperties(file);
  const title = titleBarOf(file.documentType, split, path);
  if (title) {
    const { bar, input } = createTitleBar();
    input.readOnly = true;
    input.value = title.text;
    input.placeholder = title.placeholder;
    page.append(bar);
  }
  const body = document.createElement("div");
  body.className = "prose editor-reading-content";
  const fragment = renderMarkdown(file.content, resolvers(path), { omitLeadingH1: title !== undefined });
  addCodeBlockCopyButtons(fragment);
  body.append(fragment);
  page.append(body);
  // The editor's text only ever holds "\n".
  return formatWordCount(countWordsAndChars(split.body.replace(/\r\n?/g, "\n")));
}

// The Table as its tab draws it in reading view, in the layout it opens in.
function fillTablePage(page: HTMLElement, path: string, file: TableFileResponse, source: PageSource): string {
  const { bar, input } = createTitleBar();
  input.readOnly = true;
  input.value = shownTitle(file.name, path);
  const controls = tableCellControls({
    tablePath: () => path,
    openMedia: (target) => source.openPath(target),
    openPath: source.openPath,
    dialog: source.dialog,
    contextMenu: source.contextMenu,
  });
  const form = createTableForm({
    columns: file.columns,
    rows: file.rows,
    layout: file.localLayout ?? file.layout ?? "list",
    locked: file.locked,
    version: file.version,
    editable: false,
    readOnly: true,
    cell: (column, row) => createCell(column, row.values[column.id] ?? "", () => undefined, true, controls),
  });
  page.append(bar, form);
  return tableContentsLabel(file.columns.length, file.rows.length);
}

// A document of another type as its reading view shows it: its format's text
// in an editor locked against edits, which lives until the page is released.
function fillEditorPage(page: HTMLElement, path: string, file: TextFileResponse, source: PageSource): string {
  const format = source.formats.get(file.documentType);
  const context: FormatContext = {
    path: () => path,
    showLinkMenu: () => undefined,
    openPath: (target) => source.openPath(target),
    searchTag: () => undefined,
  };
  const { body } = splitDocumentProperties(file);
  new EditorView({
    parent: page,
    state: EditorState.create({
      doc: body,
      extensions: [
        format.extensions(context),
        format.formatting?.(context) ?? [],
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    }),
  });
  return formatWordCount(countWordsAndChars(body.replace(/\r\n?/g, "\n")));
}

/** Lets go of a page that is no longer shown: an editor on it listens to the
 * window until it is destroyed. */
export function releasePage(page: HTMLElement): void {
  for (const editor of page.querySelectorAll<HTMLElement>(".cm-editor")) EditorView.findFromDOM(editor)?.destroy();
}

function showPageError(page: HTMLElement, message: string): void {
  const line = document.createElement("div");
  line.className = "editor-reading-content";
  line.append(createInlineError({ message }));
  page.replaceChildren(line);
}

/** Where a preview reads the file on its page from, and what a click on the
 * page opens. */
export interface PageSource {
  /** A file as a document route reads it. */
  loadFile(path: string): Promise<FileResponse>;
  /** Where the links and embeds in the note at `docPath` lead. */
  readingResolvers: typeof readingResolvers;
  /** What draws a document of another type on its page. */
  formats: Pick<FormatRegistry, "get">;
  /** What a Table's path cell names, or the picture a media cell shows,
   * clicked on its page. */
  openPath(path: string): void;
  /** Where a Table's picture that has gone says why. */
  dialog: DialogService;
  /** Draws the menus a page opens. */
  contextMenu: ContextMenuService;
}

/** Reads the file at `path` onto a page of its `kind`, or says there why it
 * couldn't, unless `stale()` once the read lands. Resolves with the line its
 * size is given in, or undefined when there is none to show. */
export async function loadPage(
  page: HTMLElement,
  path: string,
  kind: PageKind,
  source: PageSource,
  stale: () => boolean,
): Promise<string | undefined> {
  try {
    const file = await source.loadFile(path);
    if (stale()) return undefined;
    if (kind === "note" && file.kind === "text") return fillNotePage(page, path, file, source.readingResolvers);
    if (kind === "table" && file.kind === "table") return fillTablePage(page, path, file, source);
    if (kind === "editor" && file.kind === "text") return fillEditorPage(page, path, file, source);
    throw new Error("Failed to load file");
  } catch (error) {
    if (!stale()) showPageError(page, error instanceof Error ? error.message : "Failed to load file");
    return undefined;
  }
}

/** The menu a preview's open button has on a right-click, given `{ file }`:
 * the ways to open the file beside what is shown. */
export const PREVIEW_OPEN_MENU = "preview.open";

/** What a preview's open button opens, on a click and from its menu. */
export interface OpenTarget {
  path: string;
  open(): void;
  contextMenu: Pick<ContextMenuService, "open">;
}

/** A preview's button that opens what it shows in a new tab, on a link's
 * page or the gallery's toolbar, so what holds the preview keeps its tab.
 * Out of the tab order, and a press never takes focus or a text selection
 * from what holds the preview. */
export function createOpenButton(target: OpenTarget): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button preview-open";
  button.tabIndex = -1;
  button.setAttribute("aria-label", OPEN_IN_NEW_TAB);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => target.open());
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    target.contextMenu.open({
      menu: PREVIEW_OPEN_MENU,
      arg: { file: target.path },
      at: { x: event.clientX, y: event.clientY },
      ariaLabel: OPEN_IN_NEW_TAB,
    });
  });
  return button;
}

/** A page's open button, in its corner over the page. */
export function createOpenControl(target: OpenTarget): HTMLElement {
  const element = document.createElement("div");
  element.className = "preview-page-toolbar";
  element.append(createOpenButton(target));
  return element;
}

/** How long the pointer rests on what a page previews before the page
 * shows. */
export const PREVIEW_DELAY_MS = 300;
// How long a shown page waits once the pointer has left it and its link:
// time to cross the gap from the link onto the page.
const CLOSE_DELAY_MS = 300;
// Between the link and the page, and between the page and its bounds.
const GAP = 6;
const MARGIN = 8;
// Never taller than a Letter page (8.5 by 11) of its width, as the gallery's.
const PAGE_RATIO = 11 / 8.5;
// The room the link keeps around its text in the muted note, and its corners.
const HOLE_ROOM = 3;
const HOLE_RADIUS = 4;
// Held alone, a modifier types nothing.
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta"]);

/** Sizes a page shown beside what opened it: as wide as its share of full
 * size within `span` px, and as tall as its file within a Letter page of
 * that width and `room` px. Returns the width it shows at, 0 for a page not
 * laid out. */
export function sizePage(page: HTMLElement, span: number, room: number): number {
  for (const property of ["zoom", "width", "max-height"]) page.style.removeProperty(property);
  const natural = page.offsetWidth;
  if (natural === 0) return 0;
  const width = Math.min(span, natural * PAGE_PREVIEW_SCALE);
  const zoom = pageZoom(width, natural);
  page.style.setProperty("zoom", String(zoom));
  page.style.width = `${width / zoom}px`;
  page.style.maxHeight = `${Math.min(width * PAGE_RATIO, room) / zoom}px`;
  return width;
}

export interface LinkPreviewDeps extends PageSource {
  /** Opens a link on the page as a click on a link in the container opens one. */
  openPath(path: string): void;
  /** The page's open button: the file in a new tab after this one. */
  openBeside(path: string): void;
  /** What the page stays within top to bottom, and mutes while it shows.
   * Positioned, and not what scrolls: the veil fills it, and would scroll
   * away with the area's content. */
  area: HTMLElement;
  /** Which way the page may run past the area: right from its left edge to
   * the window's, for a pane, never left of it; or left from its right edge,
   * for a column against the window's right edge. */
  runs: "right" | "left";
  /** Draws the menu of the page's open button. While any menu is open, the
   * page stays and leaves Escape to the menu. */
  contextMenu: ContextMenuService;
}

export interface LinkPreview extends Disposable {
  /** Takes down a shown preview, and the wait for one. */
  close(): void;
}

interface Preview {
  link: HTMLElement;
  frame: HTMLElement;
  page: HTMLElement;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** A `clip-path` covering `width` by `height` px but for a rounded hole over
 * each of `holes`, in the same coordinates. */
export function veilPath(width: number, height: number, holes: readonly Box[]): string {
  const n = (value: number) => Math.round(value * 10) / 10;
  const cut = holes.map(({ left, top, width: w, height: h }) => {
    const [x, y] = [left - HOLE_ROOM, top - HOLE_ROOM];
    const [right, bottom] = [x + w + 2 * HOLE_ROOM, y + h + 2 * HOLE_ROOM];
    const r = Math.min(HOLE_RADIUS, (w + 2 * HOLE_ROOM) / 2, (h + 2 * HOLE_ROOM) / 2);
    const arc = (to: [number, number]) => `A${n(r)} ${n(r)} 0 0 1 ${n(to[0])} ${n(to[1])}`;
    return (
      `M${n(x + r)} ${n(y)}H${n(right - r)}${arc([right, y + r])}V${n(bottom - r)}${arc([right - r, bottom])}` +
      `H${n(x + r)}${arc([x, bottom - r])}V${n(y + r)}${arc([x + r, y])}Z`
    );
  });
  return `path(evenodd, "M0 0H${n(width)}V${n(height)}H0Z${cut.join("")}")`;
}

/** While the pointer rests on a link in `container` to a file a page draws,
 * shows the file beside it. The pointer can move onto the page to scroll it,
 * select its text or follow its links; a link on the page previews nothing.
 * Escape, a key typed in `container`, a press or a wheel elsewhere, or a
 * scroll of what holds the link takes it down. */
export function installLinkPreview(container: HTMLElement, deps: LinkPreviewDeps): LinkPreview {
  const store = new DisposableStore();
  // The link the pointer rests on, until its page shows or the pointer leaves.
  let pending: HTMLElement | undefined;
  let openTimer = 0;
  let shown: Preview | undefined;
  let closeTimer = 0;
  // Counts the reads started, so a file arriving after the pointer moved on is dropped.
  let reads = 0;
  let pointerY = 0;

  // The area behind a shown page, muted but for the link it came from, one
  // hole per line the link runs over. Under the editor's toolbar, so the
  // controls stay as they are; it takes no pointer, so the link and the text
  // around it still hover, select and click.
  const veil = document.createElement("div");
  veil.className = "link-preview-veil";
  deps.area.append(veil);
  store.add(() => veil.remove());

  // A link is any element carrying a space path, a button as well as an anchor.
  function pageLink(target: EventTarget | null): HTMLElement | undefined {
    const link = target instanceof Element ? target.closest<HTMLElement>("[data-space-path]") : null;
    if (!link || !container.contains(link)) return undefined;
    return pageKind(link.dataset.spacePath ?? "") ? link : undefined;
  }

  function forget(): void {
    window.clearTimeout(openTimer);
    pending = undefined;
    reads++;
  }

  function hide(): void {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    if (shown) releasePage(shown.page);
    shown?.frame.remove();
    shown = undefined;
    veil.classList.remove("is-shown");
  }

  // A menu opened over the page draws the pointer off it, onto the menu.
  function hideSoon(): void {
    if (shown && !closeTimer && !deps.contextMenu.isOpen()) closeTimer = window.setTimeout(hide, CLOSE_DELAY_MS);
  }

  function keep(): void {
    window.clearTimeout(closeTimer);
    closeTimer = 0;
  }

  function wait(link: HTMLElement): void {
    forget();
    pending = link;
    openTimer = window.setTimeout(() => void open(link), PREVIEW_DELAY_MS);
  }

  // A link or a cell followed from the page, which goes first.
  function follow(path: string): void {
    hide();
    deps.openPath(path);
  }

  async function open(link: HTMLElement): Promise<void> {
    const read = ++reads;
    const path = link.dataset.spacePath ?? "";
    const kind = pageKind(path);
    if (!kind) return;
    const preview = build(link, path, kind);
    await loadPage(preview.page, path, kind, { ...deps, openPath: follow }, () => read !== reads);
    if (read !== reads || !link.isConnected) {
      releasePage(preview.page);
      return;
    }
    pending = undefined;
    hide();
    shown = preview;
    document.body.append(preview.frame);
    place(preview);
    mute(link);
  }

  function build(link: HTMLElement, path: string, kind: PageKind): Preview {
    const frame = document.createElement("div");
    frame.className = "link-preview";
    const page = createPage(kind);
    const open = createOpenControl({
      path,
      open: () => {
        hide();
        deps.openBeside(path);
      },
      contextMenu: deps.contextMenu,
    });
    frame.append(page, open);
    frame.addEventListener("click", (event) => {
      const target = (event.target as Element).closest<HTMLElement>("a[data-space-path]");
      if (!target) return;
      event.preventDefault();
      follow(target.dataset.spacePath ?? "");
    });
    return { link, frame, page };
  }

  // A link that wraps has a box per line: the page goes by the one the
  // pointer is on.
  function lineBox(link: HTMLElement): Pick<DOMRect, "top" | "bottom" | "left" | "right"> {
    const boxes = [...link.getClientRects()];
    return (
      boxes.find((box) => pointerY >= box.top && pointerY <= box.bottom) ?? boxes[0] ?? link.getBoundingClientRect()
    );
  }

  // Centred below the link, unless the page is taller than the room there and
  // there is more room above, and shifted only as far as its bounds make it.
  // Pinned by the edge nearest the link, so a picture on the page that loads
  // late grows the page away from it.
  function place(preview: Preview): void {
    const box = lineBox(preview.link);
    const area = deps.area.getBoundingClientRect();
    const span =
      deps.runs === "right"
        ? { left: area.left + MARGIN, right: window.innerWidth - MARGIN }
        : { left: MARGIN, right: area.right - MARGIN };
    const below = area.bottom - MARGIN - box.bottom - GAP;
    const above = box.top - GAP - area.top - MARGIN;
    const fitsBelow = size(preview, span, Number.POSITIVE_INFINITY).height <= below;
    const side = fitsBelow || below >= above ? "below" : "above";
    const { width } = size(preview, span, side === "below" ? below : above);
    const { frame } = preview;
    const centred = (box.left + box.right) / 2 - width / 2;
    frame.style.left = `${clamp(centred, span.left, span.right - width)}px`;
    if (side === "below") frame.style.top = `${box.bottom + GAP}px`;
    else frame.style.bottom = `${window.innerHeight - box.top + GAP}px`;
  }

  // The page sized within `span` and `room`, and the height its frame takes.
  function size(
    preview: Preview,
    span: { left: number; right: number },
    room: number,
  ): { width: number; height: number } {
    const width = sizePage(preview.page, span.right - span.left, room);
    return { width, height: width === 0 ? 0 : preview.frame.getBoundingClientRect().height };
  }

  // A wait starts on a move only: a link redrawn or scrolled under a still
  // pointer gets an over and no move, and in an editor that is a pointer left
  // resting while its text is typed. Never mid-press: a press is a selection
  // or a drag. A shown page stays while the pointer is on it or its link.
  store.add(
    listen(document, "pointerover", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === "touch") return;
      const target = pointer.target as Node;
      if (shown?.link.contains(target) || shown?.frame.contains(target)) keep();
      else if (pointer.buttons === 0) hideSoon();
    }),
  );
  store.add(
    listen(document, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === "touch" || pointer.buttons !== 0) return;
      pointerY = pointer.clientY;
      const link = pageLink(pointer.target);
      if (link === pending) return;
      if (link && link !== shown?.link) wait(link);
      else forget();
    }),
  );
  store.add(
    listen(document, "pointerout", (event) => {
      if ((event as PointerEvent).relatedTarget !== null) return;
      forget();
      hideSoon();
    }),
  );
  // A selection dragged off the page ends wherever the pointer was let go.
  store.add(
    listen(document, "pointerup", (event) => {
      const target = event.target as Node;
      if (!shown?.link.contains(target) && !shown?.frame.contains(target)) hideSoon();
    }),
  );
  const outside = (event: Event) => {
    if (shown?.frame.contains(event.target as Node)) return;
    forget();
    hide();
  };
  for (const type of ["pointerdown", "wheel", "dragstart"]) {
    store.add(listen(document, type, outside, { capture: true, passive: true }));
  }
  // Only a scroll that moves the link: the copilot's chat scrolls as it writes.
  store.add(
    listen(
      document,
      "scroll",
      (event) => {
        const target = event.target;
        const link = shown?.link ?? pending;
        if (target === document || (link && target instanceof Node && target.contains(link))) outside(event);
      },
      { capture: true, passive: true },
    ),
  );
  store.add(
    listen(
      document,
      "keydown",
      (event) => {
        forget();
        const { key, target } = event as KeyboardEvent;
        // Heard before the menu's own: it closes the menu first.
        if (!shown || deps.contextMenu.isOpen()) return;
        if (key === "Escape") {
          hide();
          event.preventDefault();
          event.stopPropagation();
        } else if (!MODIFIER_KEYS.has(key) && target instanceof Node && container.contains(target)) {
          // Only a key typed where the link is, which may write under the
          // page: a copy of text selected on the page is typed elsewhere.
          hide();
        }
      },
      { capture: true },
    ),
  );
  for (const type of ["blur", "resize"]) {
    store.add(
      listen(window, type, () => {
        forget();
        hide();
      }),
    );
  }

  function mute(link: HTMLElement): void {
    const area = deps.area.getBoundingClientRect();
    const holes = [...link.getClientRects()].map((box) => ({
      left: box.left - area.left,
      top: box.top - area.top,
      width: box.width,
      height: box.height,
    }));
    veil.style.setProperty("clip-path", veilPath(area.width, area.height, holes));
    veil.classList.add("is-shown");
  }

  const close = () => {
    forget();
    hide();
  };
  store.add(close);
  return { close, dispose: () => store.dispose() };
}
