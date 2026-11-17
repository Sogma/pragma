import { NAME_ORDER, sameSortChoice } from "../../src/protocol/folderSort.ts";
import { dirnameOf, formatRootedPath, type PathRoot } from "../../src/protocol/rootedPath.ts";
import { hasKnownKind } from "../../src/protocol/types.ts";
import type { SpaceTreeNode } from "../core/apiClient.ts";
import { ownSortOf } from "../core/folderOrder.ts";
import {
  CANT_OPEN,
  CONFINED_DRAG_TYPE,
  carriesDesktopFiles,
  displayName,
  entryIcon,
  extensionOf,
  fileTypeLabel,
  nodeFileType,
  noteDragInFlight,
  OPEN_GALLERY,
  pendingFileType,
  pragmaFileLabel,
  SELECTION_DRAG_TYPE,
  stripExtension,
  treeTakesDrag,
  treeTotalsLabel,
  writeEntryDrag,
} from "../core/paths.ts";
import { cursorRing } from "../lib/cursorRing.ts";
import { DisposableStore, listen } from "../lib/disposable.ts";
import { renderTreeIcon, renderTreeLoading } from "../lib/dom.ts";
import { attachEditInputHandlers, createPlaceholder, type PendingCreate } from "../lib/inlineEdit.ts";
import { describeSort } from "../services/folderSorts.ts";
import { currentPlatform } from "../services/keybindings.ts";
import type { ActiveRowMarker } from "./treeRows.ts";

export type DropZone = "before" | "after" | "into";

// Directories get a 25/50/25 split (top/bottom quarters reorder as a
// sibling, the big middle band reparents into the folder, the conventional
// tree behavior). Files have nothing meaningful an
// "into" drop could mean, so they get a plain 50/50 before/after split.
function dropZoneFor(event: DragEvent, label: HTMLElement, targetIsDirectory: boolean): DropZone {
  const rect = label.getBoundingClientRect();
  const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height;
  if (targetIsDirectory) {
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "into";
  }
  return ratio < 0.5 ? "before" : "after";
}

function dropZoneClass(zone: DropZone): string {
  return zone === "before" ? "drag-over-top" : zone === "after" ? "drag-over-bottom" : "drag-over";
}

const DROP_ZONE_CLASSES = ["drag-over", "drag-over-top", "drag-over-bottom"];

// Delete, and on macOS Cmd+Backspace too, the system's chord for deleting
// a file.
function isDeleteKey(event: KeyboardEvent, mac: boolean): boolean {
  if (event.altKey || event.ctrlKey || event.shiftKey) return false;
  if (event.key === "Delete") return !event.metaKey;
  return mac && event.metaKey && event.key === "Backspace";
}

export interface TreeRenderContext {
  onOpen: (filePath: string, labelEl: HTMLElement) => void;
  // A folder's row draws its Open button only in a tree given this.
  onOpenDirectory?: (rootedPath: string) => void;
  // `selection` comes only with a right-click on one of several selected
  // rows: every entry selected, the clicked one among them.
  onContextMenu: (event: MouseEvent, node: SpaceTreeNode, selection?: SpaceTreeNode[]) => void;
  // The grabbed row's entry, or the selection's when it is one of several.
  onDragStart: (nodes: SpaceTreeNode[]) => void;
  onDrop: (event: DragEvent, node: SpaceTreeNode, zone: DropZone) => void;
  // Shift+click and Ctrl+click (Cmd+click on macOS) select several rows only
  // in a tree given this; elsewhere they are plain clicks.
  selectsMany?: boolean;
  // Delete, or Cmd+Backspace on macOS, in the focused list: the selection's
  // entries, else the cursor's row's.
  onDelete?: (nodes: SpaceTreeNode[]) => void;
  // Both keyed by the row's rooted path. Which folders start collapsed is
  // the caller's rule, never the tree's.
  isCollapsed: (rootedPath: string) => boolean;
  onToggleCollapse: (rootedPath: string, collapsed: boolean) => void;
  showExtensions: boolean;
  // The one node currently swapped for an inline rename `<input>`, if any.
  editingPath: string | undefined;
  onRenameSubmit: (node: SpaceTreeNode, rawValue: string) => void;
  onRenameCancel: () => void;
  // The one "new file/folder" input row currently shown, if any — rendered
  // as the first child of whichever directory's list matches its parentPath
  // (or the root list, for parentPath "").
  pendingCreate: PendingCreate | undefined;
  onCreateSubmit: (pending: PendingCreate, rawValue: string) => void;
  onCreateCancel: () => void;
  // Library trees (view/sidebar/libraries.ts): no mutation affordances
  // against an external, read-only-registered folder — no drop target, no
  // context menu, no sorting. Opening and dragging out are reads, so this
  // flag never blocks them; what a library click can open is the caller's
  // rule, not the tree's. Absent for every space-rooted tree.
  readOnly?: boolean;
  // Which root this tree's nodes are relative to; absent means the space,
  // where the rooted spelling and the bare path are the same string. The tree
  // composes the rooted form once per row and hands *that* to everything
  // outside itself: the row's data attribute, the drag payload, the open
  // callbacks.
  root?: PathRoot;
  // A folder's tooltip totals the files and folders under it, all the way
  // down. Only a tree listed whole asks for it: one listed a folder at a
  // time would undercount every folder not yet opened.
  countsFolders?: boolean;
  // A drag carries no path, so no editor, canvas or other tree can take it:
  // only this tree's own drop, which knows its drag from its own state.
  confinedDrags?: boolean;
  // Folders scrolled past stay pinned over the top of the viewport. The pins
  // stick to the scroller's top edge, so only a tree at the top of a scroller
  // of its own asks: under an accordion's header they would cover it.
  pinsFolders?: boolean;
}

// The icon the entry will have once created: a folder's, a kind's, or none
// for a note, matching a bare New Note. A copy of a template takes the
// template's kind.
function renderCreateRow(
  pendingCreate: PendingCreate,
  onSubmit: (value: string) => void,
  onCancel: () => void,
): HTMLLIElement {
  const item = document.createElement("li");
  const fileType = pendingFileType(pendingCreate);
  item.className = `tree-row ${pendingCreate.type === "file" && fileType ? `file ${fileType}` : pendingCreate.type}`;

  const label = document.createElement("span");
  label.className = "node-label editing";
  const glyph = pendingCreate.type === "directory" ? "folder" : fileType;
  label.appendChild(renderTreeIcon({ glyph }, undefined));
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = createPlaceholder(pendingCreate);
  input.value = pendingCreate.initialName ?? "";
  label.appendChild(input);
  item.appendChild(label);

  attachEditInputHandlers(input, onSubmit, onCancel);
  return item;
}

// Pointer-only, so no tab stop: the folder's menu holds the same Open for
// the keyboard.
function renderOpenButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button node-open";
  button.tabIndex = -1;
  button.setAttribute("aria-label", OPEN_GALLERY);
  return button;
}

function createRowKey(pendingCreate: PendingCreate): string {
  const { parentPath, type, kind, template } = pendingCreate;
  return `${parentPath}\n${type}\n${kind ?? ""}\n${template?.path ?? ""}`;
}

// Puts `list`'s children in `items`' order, moving only what is out of place:
// a scroll that brings one row in inserts that row, rather than re-inserting
// every row after it and restyling them all.
function setChildrenInPlace(list: HTMLElement, items: readonly Element[]): void {
  const keep = new Set<Element>(items);
  for (const child of Array.from(list.children)) {
    if (!keep.has(child)) child.remove();
  }
  let cursor = list.firstElementChild;
  for (const item of items) {
    if (item === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(item, cursor);
  }
}

// Rows drawn past each edge of the viewport, so a fast scroll finds them
// already on the page.
const OVERSCAN_PX = 300;
// What a tree with no viewport to measure draws — a hidden panel, a test
// document: its first rows, never all of them.
const UNMEASURED_ROWS = 200;
// The pitch until a row can be measured: its set line and padding
// (file-tree.css).
const DEFAULT_ROW_HEIGHT = 24;
// The caps on the folders pinned over a tree: seven rows, and none reaching
// past 40% of the viewport, so a deep folder in a short panel still leaves
// rows to read.
const MOST_PINNED = 7;
const PINNED_SHARE = 0.4;

// How many depths of folders pin in a viewport `height` tall.
function pinLimit(height: number, pitch: number): number {
  return Math.min(MOST_PINNED, Math.floor((height * PINNED_SHARE) / pitch));
}

// A folder sliding open or shut, in step with its chevron's turn: both take
// their timing from scale.css, this as each slide starts.
function slideTiming(): KeyframeAnimationOptions {
  const tokens = getComputedStyle(document.documentElement);
  const duration = tokens.getPropertyValue("--folder-slide-duration").trim();
  return {
    duration: Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) || 0,
    easing: tokens.getPropertyValue("--folder-slide-easing").trim() || "linear",
  };
}

export interface TreeView {
  /** The root list. A host attaches it before rendering, inside the element
   * that scrolls it, so the render can find its viewport and focus an input. */
  readonly element: HTMLUListElement;
  /** Draws `nodes` under `ctx`, keeping every row whose entry is still listed. */
  render(nodes: SpaceTreeNode[], ctx: TreeRenderContext): void;
  /** Whether `rootedPath` has a row: listed, under folders that are all open.
   * A row scrolled out of view has one, though nothing of it is on the page. */
  hasRow(rootedPath: string): boolean;
  /** Moves the keyboard cursor to `rootedPath`'s row and, when the row is not
   * wholly in view, scrolls it to the middle; false if it has no row. */
  reveal(rootedPath: string): boolean;
  /** Stops following the element the tree scrolls in. */
  dispose(): void;
}

export interface TreeViewOptions {
  /** The active tab's highlight: whether a row drawn now carries it, and
   * whether a folder's guide is drawn darker for holding its row. Rows
   * already drawn are re-marked by whoever moves the highlight. */
  active?: Pick<ActiveRowMarker, "has" | "holds">;
}

interface Row {
  node: SpaceTreeNode;
  rootedPath: string;
  /** A folder's: whether its entries are listed under it. */
  open: boolean;
  /** Present only while the row is on the page. */
  item?: HTMLLIElement;
  label?: HTMLSpanElement;
  /** What the label was last drawn from, so an unchanged row is never redrawn. */
  drawn: string;
}

// `parent` is the rooted path of the folder the slot is listed in.
type Slot =
  | { kind: "row"; row: Row; depth: number; parent: string }
  | { kind: "create"; pending: PendingCreate; depth: number; parent: string }
  | { kind: "loading"; key: string; depth: number; parent: string };

// A folder opening or shutting: one row after the folder's, holding as many
// of the folder's rows as can show, while its height animates.
interface Transition {
  /** The folder's slot, which the transition row follows. */
  after: number;
  item: HTMLLIElement;
  /** Its rows' height: the furthest it pushes the rows below it. */
  full: number;
  opening: boolean;
  animation?: Animation;
}

// The chevron leads the label's content, up to its icon. The padding before
// it holds the row's indent, which a click mustn't take for the chevron.
function onChevron(event: MouseEvent, label: HTMLElement): boolean {
  const icon = label.querySelector(".node-icon");
  if (!icon) return false;
  const start = label.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(label).paddingLeft);
  return event.clientX >= start && event.clientX < icon.getBoundingClientRect().left;
}

// Moved down off its own place in the list: a pinned folder's row the
// scroll has stuck over the rows it holds.
function isStuck(label: HTMLElement): boolean {
  const place = label.closest(".tree-pin");
  return place !== null && label.getBoundingClientRect().top > place.getBoundingClientRect().top;
}

// What the scroller shows, in the list's own coordinates.
interface Viewport {
  top: number;
  bottom: number;
}

// A shutting folder's row as it slides away: nothing can address it by
// path, and its transition row is inert, so a click or a selector only ever
// finds a real row.
function retire(item: HTMLLIElement): HTMLLIElement {
  for (const marked of item.querySelectorAll("[data-path]")) marked.removeAttribute("data-path");
  for (const marked of item.querySelectorAll("[data-folder]")) marked.removeAttribute("data-folder");
  return item;
}

/** `listPath` is the *rooted* path of the list being drawn — `""` for the
 * space's own top level, `lib:<id>` for a library's (in a space tree rooted
 * and relative are the same string). Rooted because `editingPath` is matched
 * rooted too, and one tree handing out two spellings of the same idea is how
 * a library row ends up matching a space row of the same relative name.
 *
 * A function gives it for a list whose spelling can change between renders:
 * the templates folder, found in any case.
 *
 * A row exists while every folder above it is open, but only the rows near
 * the viewport are on the page: in order, each one measured pitch tall, with
 * a spacer for each run left out, so a tree costs what is on screen rather
 * than what it lists. A render patches the drawn rows in place; their events
 * are handled on the root list. */
export function createTreeView(listPath: string | (() => string), options: TreeViewOptions = {}): TreeView {
  const element = document.createElement("ul");
  element.className = "tree-list";
  // Nearly every row has a hint, so each waits its delay: following on at
  // once would pop one per row as the pointer crosses the list.
  element.dataset.tooltipWait = "";
  element.tabIndex = 0;
  // Every listed row, by rooted path; the label and item lookups are for the
  // handlers and for taking a row off the page.
  const rows = new Map<string, Row>();
  const rowOf = new WeakMap<Element, Row>();
  // Each item's indent guides, drawn once: an item is keyed by its path, so
  // its depth never changes.
  const guidesOf = new WeakMap<HTMLLIElement, HTMLSpanElement>();
  const loadingItems = new Map<string, HTMLLIElement>();
  // What is on the page, by slot index.
  let onPage = new Map<HTMLLIElement, number>();
  let slots: Slot[] = [];
  let listed: SpaceTreeNode[] = [];
  let ctx: TreeRenderContext | undefined;
  // The pending-create input row outlives a render while it is still asked
  // for, so a refresh mid-typing doesn't clear what was typed.
  let createRow: { key: string; item: HTMLLIElement } | undefined;
  let inputToFocus: HTMLInputElement | undefined;
  // A drag that actually left the ground (dragstart fired) still ends up
  // delivering a `click` afterward on some browser/input combos (notably
  // short trackpad drags) — without this guard that click reopens or
  // toggles whatever the user was mid-drag away from.
  //
  // Reset on dragend is deferred a tick so a same-tick trailing click still
  // sees the flag; the click handler also consumes it directly.
  let justDragged = false;
  // The dragged row stays on the page for the whole drag: a source scrolled
  // away would be removed, and a removed source never hears its dragend.
  let draggedRow: Row | undefined;
  // The keyboard cursor is a path, and focus sits on the list rather than a
  // row: the cursor's row can be scrolled off the page with nothing of it
  // drawn, and a focused row that scrolls away is removed, dropping focus to
  // the page.
  let cursor: string | undefined;
  // The rows selected together, by rooted path, and the row a Shift+click or
  // Shift+arrow selects from. One row is only where a selection would start:
  // two or more are drawn, dragged and handed over as one.
  let selection = new Set<string>();
  let anchor: string | undefined;
  // Every row the drag in flight carries: none of them, nor any row inside a
  // folder among them, takes its drop.
  let dragging = new Set<string>();
  // Cmd on macOS, where Ctrl+click opens the row's menu.
  const mac = currentPlatform() === "mac";
  let rowHeight = 0;
  let scroller: HTMLElement | undefined;
  let scrollerListeners = new DisposableStore();
  let disposed = false;
  // Kept on the page wherever it is, as an input row is, so no spacer ever
  // needs a height that changes mid-animation.
  let transition: Transition | undefined;
  // Stand-ins for the runs of rows left out, reused in the order the runs fall.
  const spacers: HTMLLIElement[] = [];
  let paintedSlots = 0;
  // Each pinning folder row's place in the list and the box it sticks in.
  const pins = new WeakMap<HTMLLIElement, { place: HTMLLIElement; box: HTMLUListElement }>();

  function pitch(): number {
    return rowHeight || DEFAULT_ROW_HEIGHT;
  }

  // Rows take their height from the platform's font, so it is measured off
  // an unplaced row once the tree is on a visible page, never assumed.
  function measureRowHeight(): void {
    if (rowHeight || !element.isConnected) return;
    const probe = document.createElement("li");
    probe.className = "tree-row file";
    probe.style.visibility = "hidden";
    const label = document.createElement("span");
    label.className = "node-label";
    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = "Probe";
    label.appendChild(name);
    probe.appendChild(label);
    element.appendChild(probe);
    rowHeight = Math.round(label.getBoundingClientRect().height);
    probe.remove();
  }

  // The nearest scrolling ancestor, followed for as long as it holds the
  // tree. A host that sits the tree in no scrolling element gets its first
  // rows only.
  function followScroller(): void {
    if (disposed || scroller?.contains(element)) return;
    scrollerListeners.dispose();
    scrollerListeners = new DisposableStore();
    scroller = undefined;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        scroller = parent;
        break;
      }
    }
    if (!scroller) return;
    scrollerListeners.add(listen(scroller, "scroll", () => paint(), { passive: true }));
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => paint());
      observer.observe(scroller);
      scrollerListeners.add(() => observer.disconnect());
    }
  }

  function viewport(): Viewport | undefined {
    if (!scroller || scroller.clientHeight === 0) return undefined;
    const top = scroller.getBoundingClientRect().top + scroller.clientTop - element.getBoundingClientRect().top;
    return { top, bottom: top + scroller.clientHeight };
  }

  function focusNewInput(): void {
    if (inputToFocus?.isConnected) {
      uncover(inputToFocus);
      inputToFocus.focus();
      inputToFocus.select();
    }
    inputToFocus = undefined;
  }

  function drawRow(context: TreeRenderContext, row: Row, item: HTMLLIElement, label: HTMLSpanElement): void {
    const { node, rootedPath } = row;
    const editing = context.editingPath === rootedPath;
    const cantOpen = node.type === "file" && !hasKnownKind(node.name);
    const showFullName = context.showExtensions || node.type === "directory" || cantOpen;
    const tooltip = [
      node.type === "directory" && node.site ? `Site: ${node.site.name}` : "",
      node.type === "directory" && context.countsFolders ? treeTotalsLabel(node.children ?? []) : "",
      cantOpen ? CANT_OPEN : "",
    ]
      .filter(Boolean)
      .join("\n");
    // An open rename input is redrawn only by leaving the edit, so a refresh
    // mid-typing keeps what was typed.
    const own = node.type === "directory" ? ownSortOf(node) : undefined;
    const icon = entryIcon(node);
    const opens = node.type === "directory" && context.onOpenDirectory !== undefined;
    const drawn = editing
      ? `editing ${showFullName}`
      : JSON.stringify([own, icon, tooltip, context.showExtensions, opens]);
    if (row.drawn === drawn) return;
    row.drawn = drawn;

    item.className = `tree-row ${node.type}`;
    const typeClass = node.type === "file" ? nodeFileType(node) : undefined;
    if (typeClass) item.classList.add(typeClass);
    if (cantOpen) item.classList.add("cant-open");
    if (node.type === "directory") item.classList.toggle("sortable", own?.by === "manual");

    label.className = "node-label";
    label.classList.toggle("active", options.active?.has(rootedPath) ?? false);
    if (tooltip) label.dataset.tooltip = tooltip;
    else delete label.dataset.tooltip;
    // A scope's folder wears its AGENTS.md's colours, so its icon is named the
    // same; one of Pragma's files names the job it does.
    const iconLabel = node.pragmaFile
      ? pragmaFileLabel(node.pragmaFile)
      : fileTypeLabel(icon.scope ? "scope" : typeClass);
    const parts: HTMLElement[] = [renderTreeIcon(icon, iconLabel)];

    if (editing) {
      label.classList.add("editing");
      label.draggable = false;
      const input = document.createElement("input");
      input.type = "text";
      input.value = showFullName ? node.name : stripExtension(node.name);
      attachEditInputHandlers(
        input,
        (value) => ctx?.onRenameSubmit(row.node, showFullName ? value : value + extensionOf(row.node.name)),
        () => ctx?.onRenameCancel(),
      );
      parts.push(input);
      inputToFocus = input;
    } else {
      // Dragging a row *out* is a read, so every tree is a drag source,
      // read-only ones included. What makes that safe is the payload naming
      // its own root: a drop target that only understands the space can tell
      // a foreign path apart (core/paths.ts) instead of resolving it against
      // the wrong one.
      label.draggable = true;
      // The name gets its own span so only it truncates to an ellipsis; the
      // badge after it stays visible. Its tooltip is the full name, only
      // while it is cut off — otherwise the row's own shows: a site root's
      // name, a folder's totals.
      const name = document.createElement("span");
      name.className = "node-name";
      name.textContent = displayName(node, context.showExtensions);
      name.dataset.tooltipOverflow = "";
      parts.push(name);
      // The sort badge is a real child element, not ::after: a
      // pseudo-element renders after every real child, so it would land
      // after the Open button.
      //
      // A site root has no trailing badge: its icon is a globe in place of
      // the folder, and the row carries the "Site: …" tooltip.
      //
      // The sort badge marks the folder's own order, the one the tree lists,
      // whenever it isn't by name from A: a sort picked on this install is
      // its gallery's alone.
      if (own && !sameSortChoice(own, NAME_ORDER)) {
        const sortBadge = document.createElement("span");
        sortBadge.className = "node-sort-badge";
        sortBadge.dataset.tooltip = describeSort(own);
        parts.push(sortBadge);
      }
      if (opens) parts.push(renderOpenButton());
    }
    label.replaceChildren(...parts);
  }

  function createRowItem(pendingCreate: PendingCreate): HTMLLIElement {
    const key = createRowKey(pendingCreate);
    if (createRow?.key === key) return createRow.item;
    const item = renderCreateRow(
      pendingCreate,
      (value) => ctx?.onCreateSubmit(pendingCreate, value),
      () => ctx?.onCreateCancel(),
    );
    createRow = { key, item };
    inputToFocus = item.querySelector("input") ?? undefined;
    return item;
  }

  function slotItem(context: TreeRenderContext, slot: Slot): HTMLLIElement {
    if (slot.kind === "create") return createRowItem(slot.pending);
    if (slot.kind === "loading") {
      let item = loadingItems.get(slot.key);
      if (!item) {
        item = document.createElement("li");
        item.className = "tree-row";
        item.appendChild(renderTreeLoading("p"));
        loadingItems.set(slot.key, item);
      }
      return item;
    }
    const { row } = slot;
    if (!row.item || !row.label) {
      row.item = document.createElement("li");
      row.label = document.createElement("span");
      row.label.dataset.path = row.rootedPath;
      row.item.appendChild(row.label);
      rowOf.set(row.label, row);
      rowOf.set(row.item, row);
      row.drawn = "";
    }
    drawRow(context, row, row.item, row.label);
    row.item.classList.toggle("collapsed", row.node.type === "directory" && !row.open);
    row.label.classList.toggle("cursor", row.rootedPath === cursor);
    row.label.classList.toggle("selected", selection.size > 1 && selection.has(row.rootedPath));
    return row.item;
  }

  // A guide per folder above the row, each under that folder's chevron and
  // named for it, so moving the highlight can find the open file's folder.
  // No element holds a folder's rows, so every row draws its own stretch of
  // each line; rows abut, so the stretches join.
  //
  // Marked on every paint: the input and loading rows keep their items off
  // the page, where moving the highlight never finds them.
  function drawGuides(item: HTMLLIElement, slot: Slot): void {
    if (slot.depth === 0) return;
    let guides = guidesOf.get(item);
    if (!guides) {
      guides = document.createElement("span");
      guides.className = "tree-guides";
      let folder = slot.parent;
      for (let level = 0; level < slot.depth; level++) {
        const line = document.createElement("span");
        line.dataset.folder = folder;
        guides.prepend(line);
        folder = dirnameOf(folder);
      }
      item.appendChild(guides);
      guidesOf.set(item, guides);
    }
    for (const line of guides.querySelectorAll<HTMLElement>(":scope > span")) {
      line.classList.toggle("active", options.active?.holds(line.dataset.folder ?? "") ?? false);
    }
  }

  // A row replaced under the same path (a file become a folder) must not take
  // its successor out of the index with it.
  function dropRow(row: Row): void {
    if (rows.get(row.rootedPath) === row) rows.delete(row.rootedPath);
    if (row.item) {
      row.item.remove();
      onPage.delete(row.item);
    }
    row.item = undefined;
    row.label = undefined;
  }

  // The tree as the rows it lists, in order. A render reads each folder's
  // state from the collapse store; a click has just set it on the row.
  function flatten(context: TreeRenderContext, readCollapsed: boolean): void {
    const next: Slot[] = [];
    const seen = new Set<Row>();
    const loading = new Set<string>();
    const root = context.root ?? "space";
    const pending = context.pendingCreate;
    const walk = (nodes: SpaceTreeNode[] | undefined, depth: number, path: string): void => {
      if (pending?.parentPath === path) next.push({ kind: "create", pending, depth, parent: path });
      // No children means a shallow read that stopped above this folder, so
      // it opens onto a line saying its contents are on the way.
      if (!nodes) {
        next.push({ kind: "loading", key: path, depth, parent: path });
        loading.add(path);
        return;
      }
      for (const node of nodes) {
        const rootedPath = formatRootedPath({ root, path: node.path });
        let row = rows.get(rootedPath);
        if (row && row.node.type !== node.type) {
          dropRow(row);
          row = undefined;
        }
        if (!row) {
          row = { node, rootedPath, open: false, drawn: "" };
          rows.set(rootedPath, row);
          if (node.type === "directory") row.open = !context.isCollapsed(rootedPath);
        } else {
          row.node = node;
          if (readCollapsed && node.type === "directory") row.open = !context.isCollapsed(rootedPath);
        }
        seen.add(row);
        next.push({ kind: "row", row, depth, parent: path });
        if (node.type === "directory" && row.open) walk(node.children, depth + 1, rootedPath);
      }
    };
    walk(listed, 0, typeof listPath === "string" ? listPath : listPath());
    for (const row of rows.values()) if (!seen.has(row)) dropRow(row);
    for (const [key, item] of loadingItems) {
      if (loading.has(key)) continue;
      item.remove();
      loadingItems.delete(key);
    }
    slots = next;
    // A row a folder folded away leaves the selection, so nothing done to it
    // reaches a row out of sight.
    for (const path of selection) if (!rows.has(path)) selection.delete(path);
  }

  function drawSlot(context: TreeRenderContext, slot: Slot): HTMLLIElement {
    const item = slotItem(context, slot);
    item.style.setProperty("--depth", String(slot.depth));
    drawGuides(item, slot);
    return item;
  }

  function spacer(nth: number, rowCount: number, height: number): HTMLLIElement {
    let item = spacers[nth];
    if (!item) {
      item = document.createElement("li");
      item.className = "tree-spacer";
      item.setAttribute("aria-hidden", "true");
      spacers[nth] = item;
    }
    item.style.height = `${rowCount * height}px`;
    return item;
  }

  // An open folder's row, as deep as folders pin, set in a box as tall as the
  // rows it holds, where file-tree.css sticks it. Shallower folders stack
  // above deeper ones, so a row its folder's end pushes up slides under its
  // parent's.
  function pin(item: HTMLLIElement, rowsHeight: number, stacking: number): HTMLLIElement {
    let pinned = pins.get(item);
    if (!pinned) {
      const place = document.createElement("li");
      place.className = "tree-pin";
      place.setAttribute("role", "none");
      const box = document.createElement("ul");
      box.setAttribute("role", "none");
      place.appendChild(box);
      pinned = { place, box };
      pins.set(item, pinned);
    }
    if (item.parentElement !== pinned.box) pinned.box.appendChild(item);
    pinned.box.style.height = `${rowsHeight}px`;
    pinned.place.style.zIndex = String(stacking);
    return pinned.place;
  }

  function paint(): void {
    const context = ctx;
    if (!context) return;
    followScroller();
    measureRowHeight();
    const height = pitch();
    element.style.setProperty("--tree-row-height", `${height}px`);

    const view = viewport();
    const moving = transition;
    // A transition row pushes the rows below it down by up to its full
    // height, so the rows drawn reach as far up as it could put them at its
    // tallest, and as far down as at its shortest.
    const pushed = moving && view && view.top - OVERSCAN_PX > (moving.after + 1) * height ? moving.full : 0;
    const first = view ? Math.max(0, Math.floor((view.top - OVERSCAN_PX - pushed) / height)) : 0;
    const last = view
      ? Math.min(slots.length, Math.ceil((view.bottom + OVERSCAN_PX) / height))
      : Math.min(slots.length, UNMEASURED_ROWS);
    // How many depths of folders pin: none without a viewport to pin them in.
    const pinDepths = context.pinsFolders && view ? pinLimit(view.bottom - view.top, height) : 0;
    const indexes: number[] = [];
    for (let index = first; index < last; index++) indexes.push(index);
    const held = new Set<number>();
    // A pinned folder's row stays on the page while any row it holds does:
    // the folders above the first row drawn.
    if (pinDepths > 0) {
      let depth = slots[first]?.depth ?? 0;
      for (let index = first - 1; index >= 0 && depth > 0; index--) {
        if (slots[index].depth >= depth) continue;
        depth = slots[index].depth;
        if (depth < pinDepths) held.add(index);
      }
    }
    // A row holding an input or the drag stays on the page wherever it is.
    if (context.pendingCreate || context.editingPath !== undefined || draggedRow) {
      slots.forEach((slot, index) => {
        if (index >= first && index < last) return;
        const holds =
          slot.kind === "create" ||
          (slot.kind === "row" && (slot.row === draggedRow || slot.row.rootedPath === context.editingPath));
        if (holds) held.add(index);
      });
    }
    if (held.size > 0) {
      indexes.push(...held);
      indexes.sort((a, b) => a - b);
    }
    // A pinned folder's box spans its rows, and a transition row among them
    // at the height it has now.
    const gap = moving && pinDepths > 0 ? moving.item.getBoundingClientRect().height : 0;
    const rowsHeight = (index: number): number => {
      const end = subtreeEnd(index);
      return (end - index) * height + (moving && index <= moving.after && moving.after < end ? gap : 0);
    };

    const next = new Map<HTMLLIElement, number>();
    const items: HTMLLIElement[] = [];
    let drawnTo = 0;
    let runs = 0;
    const skipTo = (index: number) => {
      if (index > drawnTo) items.push(spacer(runs++, index - drawnTo, height));
      drawnTo = index;
    };
    // The transition row follows its folder's slot, whether that is drawn or not.
    let placed = !moving;
    const place = () => {
      if (!moving) return;
      skipTo(moving.after + 1);
      items.push(moving.item);
      placed = true;
    };
    for (const index of indexes) {
      if (moving && !placed && index > moving.after) place();
      skipTo(index);
      const slot = slots[index];
      const item = drawSlot(context, slot);
      next.set(item, index);
      // An open folder holding rows, at a depth that pins.
      const pinning = slot.depth < pinDepths && slot.kind === "row" && (slots[index + 1]?.depth ?? 0) > slot.depth;
      items.push(pinning ? pin(item, rowsHeight(index), pinDepths - slot.depth) : item);
      drawnTo = index + 1;
    }
    if (!placed) place();
    skipTo(slots.length);
    for (const item of onPage.keys()) {
      if (next.has(item)) continue;
      const row = rowOf.get(item);
      if (row?.item === item) {
        row.item = undefined;
        row.label = undefined;
      }
    }
    setChildrenInPlace(element, items);
    onPage = next;
    focusNewInput();
    // A list drawn shorter than before can leave the scroll position past its
    // new end, where the browser pulls it back: draw again for where it lands,
    // or the rows just drawn are for a place no longer shown.
    const shrank = slots.length < paintedSlots;
    paintedSlots = slots.length;
    const now = shrank && view ? viewport() : undefined;
    if (now && now.top !== view?.top) paint();
  }

  // A shutting folder's row, kept to slide under it but no longer listed:
  // taken from all that would otherwise drop it from the page.
  function leave(context: TreeRenderContext, slot: Slot): HTMLLIElement {
    const item = slotItem(context, slot);
    onPage.delete(item);
    if (slot.kind === "row") {
      slot.row.item = undefined;
      slot.row.label = undefined;
    } else if (slot.kind === "loading") loadingItems.delete(slot.key);
    return slot.kind === "create" ? item : retire(item);
  }

  // Past the last slot listed under the folder at `index`.
  function subtreeEnd(index: number): number {
    const depth = slots[index].depth;
    let end = index + 1;
    while (end < slots.length && slots[end].depth > depth) end++;
    return end;
  }

  // A shutting folder's list must never measure shorter than it was, or the
  // browser pulls the scroll position up before the animation holds it open:
  // the transition row takes its rows' place, at its first height, before
  // they move into it. It rests at its last height once the animation lets
  // go, until its end draws the list without it.
  function startTransition(after: number, held: HTMLLIElement[], opening: boolean): void {
    const item = document.createElement("li");
    item.className = "tree-transition";
    item.inert = !opening;
    const full = held.length * pitch();
    const [from, to] = opening ? [0, full] : [full, 0];
    item.style.height = `${from}px`;
    // Before the list's own item holding the first row, which for a pinned
    // folder's row is its place.
    let anchor: Element | null | undefined = held[0];
    while (anchor && anchor.parentElement !== element) anchor = anchor.parentElement;
    if (anchor) element.insertBefore(item, anchor);
    const list = document.createElement("ul");
    list.append(...held);
    item.appendChild(list);
    const moving: Transition = { after, item, full, opening };
    transition = moving;
    paint();
    moving.animation = item.animate([{ height: `${from}px` }, { height: `${to}px` }], slideTiming());
    item.style.height = `${to}px`;
    moving.animation.addEventListener("finish", () => {
      if (transition === moving) finishTransition();
    });
  }

  function stopTransition(): Transition | undefined {
    const running = transition;
    transition = undefined;
    running?.animation?.cancel();
    return running;
  }

  // A click or a key acts on the listing as it will stand, so either ends a
  // running transition first; a new listing replaces it outright.
  function finishTransition(): void {
    const running = stopTransition();
    if (!running || !ctx) return;
    if (running.opening) flatten(ctx, false);
    paint();
  }

  // WAAPI sits outside the stylesheet's reduced-motion override, so the
  // preference is read here.
  function canSlide(): boolean {
    return typeof element.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  function toggle(context: TreeRenderContext, row: Row): void {
    finishTransition();
    const view = viewport();
    const height = pitch();
    const at = slots.findIndex((slot) => slot.kind === "row" && slot.row === row);
    // As many of its rows as fit in view under the folder, rounded up; with
    // none, it opens or shuts at once.
    const fits = view && at !== -1 && canSlide() ? Math.ceil((view.bottom - (at + 1) * height) / height) : 0;
    const opening = !row.open;
    row.open = opening;
    if (opening) flatten(context, false);
    const end = at === -1 ? at : subtreeEnd(at);
    const under = fits > 0 ? slots.slice(at + 1, Math.min(end, at + 1 + fits)) : [];
    if (under.length === 0) {
      if (!opening) flatten(context, false);
      paint();
      return;
    }
    const held = under.map((slot) => (opening ? drawSlot(context, slot) : leave(context, slot)));
    // An opening folder's rows join the listing once its transition ends.
    if (opening) slots = [...slots.slice(0, at + 1), ...slots.slice(end)];
    else flatten(context, false);
    startTransition(at, held, opening);
  }

  // The row under an event, if it is one a person can act on: an editing
  // label is its input's, and the create row has no entry behind it.
  function rowAt(event: Event): { row: Row; label: HTMLElement } | undefined {
    if (!(event.target instanceof Element)) return undefined;
    const label = event.target.closest<HTMLElement>(".node-label");
    if (!label || label.classList.contains("editing")) return undefined;
    const row = rowOf.get(label);
    return row ? { row, label } : undefined;
  }

  function endDrag(): void {
    draggedRow = undefined;
    dragging = new Set();
    noteDragInFlight(undefined);
    setTimeout(() => {
      justDragged = false;
    }, 0);
  }

  // How far below the viewport's top a row must sit to clear the pins: a row
  // per folder above it, as many as pin. A row brought there leaves only its
  // own folders pinned, all above it.
  function pinnedOver(index: number, view: Viewport): number {
    if (!ctx?.pinsFolders) return 0;
    return Math.min(slots[index]?.depth ?? 0, pinLimit(view.bottom - view.top, pitch())) * pitch();
  }

  // Brings the slot at `index` fully into view, scrolling no further than that.
  function scrollToSlot(index: number): void {
    const view = viewport();
    if (!scroller || !view) return;
    const top = index * pitch();
    const clear = view.top + pinnedOver(index, view);
    if (top < clear) scroller.scrollTop -= clear - top;
    else if (top + pitch() > view.bottom) scroller.scrollTop += top + pitch() - view.bottom;
  }

  // A row reached from elsewhere lands mid-viewport, with its neighbours in
  // sight, where a step of the cursor scrolls only as far as the next row.
  function centerSlot(index: number): void {
    const view = viewport();
    if (!scroller || !view) return;
    const top = index * pitch();
    const clear = pinnedOver(index, view);
    if (top >= view.top + clear && top + pitch() <= view.bottom) return;
    // Clear of the pins still, in a viewport too short for the middle to be.
    scroller.scrollTop += top - view.top - Math.max(clear, (view.bottom - view.top - pitch()) / 2);
  }

  // An input's row comes down from under the pins before the input takes
  // focus: the focus's own scroll knows nothing of them, and would leave what
  // is typed out of sight. One below the viewport is the focus's to bring up.
  function uncover(input: HTMLInputElement): void {
    const view = viewport();
    if (!scroller || !view) return;
    for (const [item, index] of onPage) {
      if (!item.contains(input)) continue;
      const clear = view.top + pinnedOver(index, view);
      if (index * pitch() < clear) scroller.scrollTop -= clear - index * pitch();
      return;
    }
  }

  function slotOf(rootedPath: string | undefined): number {
    return slots.findIndex((slot) => slot.kind === "row" && slot.row.rootedPath === rootedPath);
  }

  // `selecting` leaves the anchor and the selection to the Shift or Ctrl
  // that moved the cursor.
  function placeCursor(index: number, selecting = false): void {
    const slot = slots[index];
    if (slot?.kind !== "row") return;
    cursor = slot.row.rootedPath;
    if (!selecting) settle(cursor);
    scrollToSlot(index);
    paint();
  }

  // The cursor moved without Shift or Ctrl makes its row the anchor and,
  // unless several rows are selected, the row a Ctrl+click adds to.
  function settle(rootedPath: string): void {
    anchor = rootedPath;
    if (selection.size < 2) selection = new Set([rootedPath]);
  }

  function toggleSelected(row: Row): void {
    if (!selection.delete(row.rootedPath)) selection.add(row.rootedPath);
    anchor = row.rootedPath;
  }

  // Every row from the anchor to the one at `index`, in place of the run of
  // selected rows the anchor sits in: rows a Ctrl+click added elsewhere stay,
  // and a second Shift+click from the same anchor can shrink the range.
  function selectTo(index: number): void {
    let from = slotOf(anchor);
    if (from === -1) {
      from = slotOf(cursor) === -1 ? index : slotOf(cursor);
      const start = slots[from];
      if (start.kind === "row") anchor = start.row.rootedPath;
    }
    for (const step of [-1, 1]) {
      for (let at = from; at >= 0 && at < slots.length; at += step) {
        const slot = slots[at];
        if (slot.kind !== "row") continue;
        if (at !== from && !selection.has(slot.row.rootedPath)) break;
        selection.delete(slot.row.rootedPath);
      }
    }
    for (let at = Math.min(from, index); at <= Math.max(from, index); at++) {
      const slot = slots[at];
      if (slot.kind === "row") selection.add(slot.row.rootedPath);
    }
  }

  // What a drag, a menu or Delete takes together: the selection, if it holds
  // `row` and another, in the tree's order, less any row inside a selected
  // folder, which goes with it.
  function selectedWith(row: Row | undefined): Row[] | undefined {
    if (!ctx?.selectsMany || selection.size < 2 || (row && !selection.has(row.rootedPath))) return undefined;
    const together: Row[] = [];
    let folder: string | undefined;
    for (const slot of slots) {
      if (slot.kind !== "row" || !selection.has(slot.row.rootedPath)) continue;
      if (folder !== undefined && slot.row.rootedPath.startsWith(`${folder}/`)) continue;
      together.push(slot.row);
      if (slot.row.node.type === "directory") folder = slot.row.rootedPath;
    }
    return together;
  }

  function activate(context: TreeRenderContext, row: Row, label: HTMLElement): void {
    if (row.node.type === "file") {
      context.onOpen(row.rootedPath, label);
      return;
    }
    // A folder only folds. Opening it is its Open button's, so expanding a
    // folder to reach a file never replaces the tab being read.
    toggle(context, row);
    context.onToggleCollapse(row.rootedPath, !row.open);
  }

  // A press on the Open button takes no focus off the list, and starts no
  // drag of its row.
  element.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest(".node-open")) event.preventDefault();
  });

  const ring = cursorRing(element);

  element.addEventListener("click", (event) => {
    const hit = rowAt(event);
    const context = ctx;
    if (!hit || !context) return;
    if (justDragged) {
      justDragged = false;
      return;
    }
    // The Open button only opens: the folder stays folded or open, the
    // cursor stays put, and a pinned row stays pinned.
    if (event.target instanceof Element && event.target.closest(".node-open")) {
      context.onOpenDirectory?.(hit.row.rootedPath);
      return;
    }
    // Shift and Ctrl only select: nothing opens or folds.
    if (context.selectsMany && (event.shiftKey || (mac ? event.metaKey : event.ctrlKey))) {
      finishTransition();
      const at = slotOf(hit.row.rootedPath);
      if (at === -1) return;
      if (event.shiftKey) selectTo(at);
      else toggleSelected(hit.row);
      placeCursor(at, true);
      return;
    }
    // A folder's row stuck over its rows comes out from under the pins, where
    // it was stuck, and only its chevron folds the folder too. Read first:
    // bringing the row out unsticks it.
    const revealsOnly = isStuck(hit.label) && !onChevron(event, hit.label);
    finishTransition();
    // A plain click lets go of any selection, and starts the next at its row.
    selection = new Set([hit.row.rootedPath]);
    placeCursor(slotOf(hit.row.rootedPath));
    if (!revealsOnly) activate(context, hit.row, hit.label);
  });

  // A modified key is left to the app's shortcuts, but for Shift with an
  // arrow, which selects, and the delete chord. An arrow's default is
  // prevented because the scroller would otherwise scroll by itself as well.
  element.addEventListener("keydown", (event) => {
    const context = ctx;
    if (!context || event.target !== element) return;
    const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    if (context.onDelete && isDeleteKey(event, mac)) {
      const row = cursor === undefined ? undefined : rows.get(cursor);
      const nodes = (selectedWith(undefined) ?? (row ? [row] : [])).map((each) => each.node);
      if (nodes.length === 0) return;
      event.preventDefault();
      context.onDelete(nodes);
      return;
    }
    // Escape lets go of a selection; with none, the key is the app's.
    if (event.key === "Escape" && !modified) {
      if (selection.size < 2) return;
      event.preventDefault();
      selection = new Set();
      paint();
      return;
    }
    const extending = event.shiftKey && context.selectsMany === true;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && !extending)) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 && (event.key !== "Enter" || extending)) return;
    event.preventDefault();
    ring.show();
    finishTransition();
    const at = slotOf(cursor);
    // No cursor yet, or its row has gone: the first key only places it, on
    // the open file's row if the tree lists one.
    if (at === -1) {
      const active = slots.findIndex((slot) => slot.kind === "row" && options.active?.has(slot.row.rootedPath));
      placeCursor(active !== -1 ? active : slots.findIndex((slot) => slot.kind === "row"));
      return;
    }
    if (step === 0) {
      placeCursor(at);
      const slot = slots[at];
      if (slot.kind !== "row" || !slot.row.label) return;
      // A file opened selects its row, as a click does. A folder only folds,
      // and the ring is all that marks the cursor on it.
      if (slot.row.node.type === "file") ring.hide();
      activate(context, slot.row, slot.row.label);
      return;
    }
    let next = at + step;
    while (next >= 0 && next < slots.length && slots[next].kind !== "row") next += step;
    if (extending && slots[next]?.kind === "row") selectTo(next);
    placeCursor(next, extending);
  });

  // Asking for a row's menu is a read too: what a read-only tree's menu
  // offers is the context's to decide.
  element.addEventListener("contextmenu", (event) => {
    const hit = rowAt(event);
    if (!hit || !ctx) return;
    event.preventDefault();
    event.stopPropagation();
    const together = selectedWith(hit.row);
    if (together)
      ctx.onContextMenu(
        event,
        hit.row.node,
        together.map((row) => row.node),
      );
    else ctx.onContextMenu(event, hit.row.node);
  });

  // A drag of several rows shows how many by the pointer, in place of the
  // grabbed row's picture: drawn off-screen for the browser to copy as the
  // drag starts, then taken away.
  function showCount(event: DragEvent, count: number): void {
    if (typeof event.dataTransfer?.setDragImage !== "function") return;
    const badge = document.createElement("span");
    badge.className = "count-badge tree-drag-count";
    const text = document.createElement("span");
    text.textContent = `${count.toLocaleString()} item${count === 1 ? "" : "s"}`;
    badge.appendChild(text);
    document.body.appendChild(badge);
    event.dataTransfer.setDragImage(badge, -10, -10);
    setTimeout(() => badge.remove(), 0);
  }

  element.addEventListener("dragstart", (event) => {
    const hit = rowAt(event);
    if (!hit || !ctx) return;
    const { row, label } = hit;
    event.stopPropagation();
    justDragged = true;
    draggedRow = row;
    const together = selectedWith(row);
    dragging = new Set((together ?? [row]).map((each) => each.rootedPath));
    // Something has to be set, or a browser never starts the drag.
    if (ctx.confinedDrags) event.dataTransfer?.setData(CONFINED_DRAG_TYPE, row.node.type);
    else if (together) event.dataTransfer?.setData(SELECTION_DRAG_TYPE, String(together.length));
    else if (event.dataTransfer) writeEntryDrag(event.dataTransfer, row.rootedPath, row.node.type);
    if (together) showCount(event, together.length);
    // "move" is what a within-space drag does. A read-only tree can only
    // ever be copied out of, and saying so is what stops the OS cursor
    // promising a move that will never happen.
    if (event.dataTransfer) event.dataTransfer.effectAllowed = ctx.readOnly ? "copy" : "move";
    label.addEventListener("dragend", endDrag, { once: true });
    ctx.onDragStart((together ?? [row]).map((each) => each.node));
  });

  function carried(rootedPath: string): boolean {
    for (const path of dragging) if (rootedPath === path || rootedPath.startsWith(`${path}/`)) return true;
    return false;
  }

  // A read-only tree is no drop target, so its drag events reach whatever
  // holds it untouched.
  element.addEventListener("dragover", (event) => {
    const hit = rowAt(event);
    if (!hit || !ctx || ctx.readOnly || !treeTakesDrag(event, ctx.confinedDrags === true)) return;
    const { row, label } = hit;
    event.preventDefault();
    event.stopPropagation();
    // A row the drag carries takes no drop, and lets none through to the
    // empty area under the tree, which would take it into the top folder.
    if (carried(row.rootedPath)) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      label.classList.remove(...DROP_ZONE_CLASSES);
      return;
    }
    if (event.dataTransfer) {
      // An OS-file drag copies into the space rather than moving the
      // dragged item, unlike an internal tree-node drag.
      event.dataTransfer.dropEffect = carriesDesktopFiles(event) ? "copy" : "move";
    }
    const zone = dropZoneFor(event, label, row.node.type === "directory");
    label.classList.remove(...DROP_ZONE_CLASSES);
    label.classList.add(dropZoneClass(zone));
  });
  element.addEventListener("dragleave", (event) => {
    rowAt(event)?.label.classList.remove(...DROP_ZONE_CLASSES);
  });
  element.addEventListener("drop", (event) => {
    const hit = rowAt(event);
    if (!hit || !ctx || ctx.readOnly || !treeTakesDrag(event, ctx.confinedDrags === true)) return;
    const { row, label } = hit;
    event.preventDefault();
    event.stopPropagation();
    if (carried(row.rootedPath)) return;
    const zone = dropZoneFor(event, label, row.node.type === "directory");
    label.classList.remove(...DROP_ZONE_CLASSES);
    ctx.onDrop(event, row.node, zone);
  });

  return {
    element,
    render(nodes, next) {
      stopTransition();
      ctx = next;
      listed = nodes;
      const pending = next.pendingCreate;
      if (createRow && (!pending || createRow.key !== createRowKey(pending))) {
        createRow.item.remove();
        onPage.delete(createRow.item);
        createRow = undefined;
      }
      flatten(next, true);
      paint();
    },
    hasRow: (rootedPath) => rows.has(rootedPath),
    reveal(rootedPath) {
      finishTransition();
      const index = slotOf(rootedPath);
      if (index === -1) return false;
      cursor = rootedPath;
      settle(rootedPath);
      centerSlot(index);
      paint();
      return true;
    },
    dispose() {
      disposed = true;
      stopTransition();
      scrollerListeners.dispose();
    },
  };
}
