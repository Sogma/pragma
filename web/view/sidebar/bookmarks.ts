// The Bookmarks view: the entries the space keeps in `.pragma/bookmarks.json`,
// in its order, drawn as the tree draws their rows. A file opens on a click,
// and a folder comes up opened in the tree that lists it, the Space view's or
// its library's. A bookmark whose entry is gone stays, shown as missing,
// until removed.
//
// Its commands are every menu's Bookmark and Remove from Bookmarks:
// the tree's, a library's, a tab's and the palette's name them, so each
// reads its target from the argument that menu hands over.
import type { SpaceBookmark, SpaceBookmarkChangeRequestBody } from "../../../src/protocol/api.ts";
import { sameBookmark } from "../../../src/protocol/bookmarks.ts";
import { entryNameKey } from "../../../src/protocol/entryName.ts";
import { basenameOf, dirnameOf, isLibraryRoot, parseRootedPath } from "../../../src/protocol/rootedPath.ts";
import { fileTypeLabel, noteDragInFlight, stripExtension, writeEntryDrag } from "../../core/paths.ts";
import { entryIconAt, fileTypeAt } from "../../core/spaceTree.ts";
import { el, renderTreeIcon } from "../../lib/dom.ts";
import { type Bookmarks, bookmarkTargetOf, bookmarks as spaceBookmarks } from "../../services/bookmarks.ts";
import type { CommandContext, CommandRegistry } from "../../services/commands.ts";
import { COMMAND_PALETTE, type ContextMenuService, type MenuRegistry } from "../../services/menus.ts";
import * as settings from "../../services/settings.ts";
import type { SidebarView } from "../../services/sidebarViews.ts";
import type { OpenSource } from "../../services/tabs.ts";
import type { ActiveRowMarker } from "../treeRows.ts";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19 21 12 17 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
</svg>`;

export interface BookmarksViewDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  contextMenu: ContextMenuService;
  // The open file's highlight, which a bookmark row carries as a tree row does.
  active: Pick<ActiveRowMarker, "subscribe">;
  open(path: string, from: OpenSource): void;
  // Brings a folder into view, open, wherever it is listed.
  revealFolder(path: string): void;
  // The app's own list, and its setting for names, unless a test hands in others.
  bookmarks?: Bookmarks;
  showExtensions?(): boolean;
}

// What marks a row's drag as one this list reorders. Its entry rides beside
// it, as on the tree row's drag, so a note, a Flow or a field takes the
// bookmark as that file; a missing one carries the mark alone.
const BOOKMARK_DRAG_TYPE = "application/x-pragma-bookmark";

const BOOKMARK_MENU = "bookmark";

// The folder a bookmark's entry sits in, by name, to tell two bookmarks of
// one name apart: "" at the space's top level, a library's id at its own.
function folderName(path: string): string {
  const { root, path: within } = parseRootedPath(path);
  const parent = dirnameOf(within);
  if (parent) return basenameOf(parent);
  return isLibraryRoot(root) ? root.library : "";
}

/** Where a row dragged onto `target` lands, as the bookmark it then comes
 * before: undefined for last, null when it would stay where it is. */
export function dropPlace(
  paths: readonly string[],
  dragged: string,
  target: string,
  below: boolean,
): string | undefined | null {
  const at = paths.findIndex((path) => sameBookmark(path, target));
  const before = below ? paths[at + 1] : target;
  const after = paths[paths.findIndex((path) => sameBookmark(path, dragged)) + 1];
  if (before !== undefined && sameBookmark(before, dragged)) return null;
  if (before === undefined ? after === undefined : after !== undefined && sameBookmark(before, after)) return null;
  return before;
}

export function createBookmarksView(deps: BookmarksViewDeps): SidebarView {
  const bookmarks = deps.bookmarks ?? spaceBookmarks;
  const showExtensions = deps.showExtensions ?? (() => settings.showExtensions.get());
  const panel = el("section", "sidebar-panel file-tree");
  panel.hidden = true;
  const message = el("p", "sidebar-panel-empty");
  message.hidden = true;
  const list = el("ul", "bookmarks-list");
  // Its rows' hints wait their delay, as the tree's do.
  list.dataset.tooltipWait = "";
  list.hidden = true;
  panel.append(el("h2", "sidebar-title", "Bookmarks"), message, list);

  let activePath: string | undefined;
  deps.active.subscribe((path) => {
    activePath = path;
  });

  // A row redrawn mid-drag would leave the browser carrying a detached one,
  // whose dragend never reaches the document, so a redraw waits for the drop.
  let dragged: string | undefined;
  let redrawAfterDrag = false;
  const ourDrag = (event: DragEvent) =>
    dragged !== undefined && [...(event.dataTransfer?.types ?? [])].includes(BOOKMARK_DRAG_TYPE);
  const endDrag = () => {
    if (dragged !== undefined) noteDragInFlight(undefined);
    dragged = undefined;
    for (const marked of list.querySelectorAll(".drag-over-top, .drag-over-bottom")) {
      marked.classList.remove("drag-over-top", "drag-over-bottom");
    }
    if (redrawAfterDrag) render();
  };
  document.addEventListener("dragend", endDrag);

  async function apply(change: SpaceBookmarkChangeRequestBody): Promise<void> {
    try {
      await bookmarks.change(change);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Changing the bookmarks failed");
    }
  }

  // Nothing shows until the list's first answer: neither an empty list nor a
  // message that may turn out to be wrong.
  function render(): void {
    if (!bookmarks.loaded()) return;
    if (dragged !== undefined) {
      redrawAfterDrag = true;
      return;
    }
    redrawAfterDrag = false;
    // A file that doesn't read holds nothing and takes no changes, so the
    // view says why instead of listing any.
    const problem = bookmarks.problem();
    const listed = bookmarks.list();
    const text = problem ?? (listed.length === 0 ? "No bookmarks in this space yet." : undefined);
    message.textContent = text ?? "";
    message.hidden = text === undefined;
    list.hidden = text !== undefined;
    const names = listed.map((bookmark) => nameOf(bookmark));
    const shared = (name: string) => names.filter((other) => entryNameKey(other) === entryNameKey(name)).length > 1;
    list.replaceChildren(...listed.map((bookmark, index) => row(bookmark, names[index], shared(names[index]))));
  }

  function nameOf(bookmark: SpaceBookmark): string {
    const name = basenameOf(bookmark.path);
    return bookmark.type === "directory" || showExtensions() ? name : stripExtension(name);
  }

  function row(bookmark: SpaceBookmark, name: string, showFolder: boolean): HTMLLIElement {
    const missing = bookmark.type === undefined;
    const item = el("li", "tree-row file bookmark-row");
    item.classList.toggle("missing", missing);
    const label = el("span", "node-label");
    label.dataset.path = bookmark.path;
    label.dataset.tooltip = missing ? `Not found: ${bookmark.path}` : bookmark.path;
    label.classList.toggle("active", bookmark.path === activePath);
    label.tabIndex = 0;
    const type = bookmark.type ?? "file";
    label.append(
      renderTreeIcon(
        entryIconAt(bookmark.path, type),
        type === "directory" ? "Folder" : fileTypeLabel(fileTypeAt(bookmark.path)),
      ),
      el("span", "node-name", name),
    );
    const folder = showFolder ? folderName(bookmark.path) : "";
    if (folder) label.append(el("span", "bookmark-folder", folder));
    label.addEventListener("click", () => activate(bookmark, label));
    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      activate(bookmark, label);
    });
    label.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // A menu key's event has no pointer to open at, so it opens on the row.
      const at = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
      deps.contextMenu.open({
        menu: BOOKMARK_MENU,
        arg: rowTarget(bookmark),
        ...(at ? { at } : { anchor: label }),
        ariaLabel: "Bookmark actions",
      });
    });
    wireDrag(label, bookmark);
    item.append(label);
    return item;
  }

  function activate(bookmark: SpaceBookmark, label: HTMLElement): void {
    if (bookmark.type === "file") deps.open(bookmark.path, { anchor: label });
    else if (bookmark.type === "directory") deps.revealFolder(bookmark.path);
  }

  // What the row's menu hands its commands: the file or folder for the open
  // items, as the tree's rows do, and the bookmark itself for Remove. A
  // missing one has nothing to open.
  function rowTarget(bookmark: SpaceBookmark): Record<string, string> {
    if (bookmark.type === "file") return { bookmark: bookmark.path, file: bookmark.path };
    if (bookmark.type === "directory") return { bookmark: bookmark.path, folder: bookmark.path };
    return { bookmark: bookmark.path };
  }

  function wireDrag(label: HTMLElement, bookmark: SpaceBookmark): void {
    label.draggable = true;
    const below = (event: DragEvent) => {
      const box = label.getBoundingClientRect();
      return event.clientY > box.top + box.height / 2;
    };
    label.addEventListener("dragstart", (event) => {
      dragged = bookmark.path;
      const transfer = event.dataTransfer;
      if (!transfer) return;
      transfer.setData(BOOKMARK_DRAG_TYPE, bookmark.path);
      if (bookmark.type !== undefined) writeEntryDrag(transfer, bookmark.path, bookmark.type);
      transfer.effectAllowed = "move";
    });
    label.addEventListener("dragover", (event) => {
      if (!ourDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const lower = below(event);
      label.classList.toggle("drag-over-top", !lower);
      label.classList.toggle("drag-over-bottom", lower);
    });
    label.addEventListener("dragleave", () => label.classList.remove("drag-over-top", "drag-over-bottom"));
    label.addEventListener("drop", (event) => {
      if (!ourDrag(event) || dragged === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      drop(dragged, bookmark.path, below(event));
    });
  }

  // The room under the last row takes a drop too, as the list's end.
  list.addEventListener("dragover", (event) => {
    if (ourDrag(event)) event.preventDefault();
  });
  list.addEventListener("drop", (event) => {
    if (!ourDrag(event) || dragged === undefined) return;
    event.preventDefault();
    const paths = bookmarks.list().map((bookmark) => bookmark.path);
    const last = paths.at(-1);
    if (last !== undefined) drop(dragged, last, true);
  });

  function drop(path: string, target: string, below: boolean): void {
    const paths = bookmarks.list().map((bookmark) => bookmark.path);
    const before = dropPlace(paths, path, target, below);
    endDrag();
    if (before === null) return;
    void apply(before === undefined ? { move: path } : { move: path, before });
  }

  const target = (context: CommandContext, arg: unknown) => bookmarkTargetOf(arg, context);
  deps.commands.register({
    id: "bookmarks.add",
    label: "Bookmark",
    when: (context, arg) => {
      const path = target(context, arg);
      return path !== undefined && bookmarks.problem() === undefined && !bookmarks.has(path);
    },
    run: (context, arg) => {
      const path = target(context, arg);
      if (path !== undefined) void apply({ add: path });
    },
  });
  deps.commands.register({
    id: "bookmarks.remove",
    label: "Remove from Bookmarks",
    when: (context, arg) => {
      const path = target(context, arg);
      return path !== undefined && bookmarks.has(path);
    },
    run: (context, arg) => {
      const path = target(context, arg);
      if (path !== undefined) void apply({ remove: path });
    },
  });
  deps.menus.register(COMMAND_PALETTE, [{ command: "bookmarks.add" }, { command: "bookmarks.remove" }]);
  deps.menus.register(BOOKMARK_MENU, [
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
    { command: "bookmarks.remove", group: "remove" },
  ]);

  bookmarks.subscribe(render);

  return {
    id: "bookmarks",
    label: "Bookmarks",
    icon: ICON,
    panel,
    // The app re-reads the list as the space changes. Showing the view reads
    // it too, for an edit another window made, which no change feed reports.
    onShow: () => void bookmarks.read(),
  };
}
