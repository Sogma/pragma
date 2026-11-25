// The Libraries view: the space's libraries as an accordion, each
// expandable in place into its tree. What a tree offers
// comes from the entry's access, never from its being a library
// (docs/architecture.md's Space identity and state ownership) — the server's write doorway refuses
// regardless, so these affordances are cosmetic.
//
// The tree is told its root rather than handed library-relative paths, so
// collapse state can share the space tree's store: every key is rooted, so
// same-named folders never clash.
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryPath,
  isLibraryRoot,
  parseRootedPath,
  sameRoot,
} from "../../../src/protocol/rootedPath.ts";
import {
  type Access,
  type CreateEntryResponse,
  deleteLibrary,
  fetchLibraryFolder,
  type LibraryEntry,
  type LibraryOffer,
  postCreateEntry,
  postDeleteEntry,
  postLibraryAccess,
  postLibraryDescription,
  postLibraryLabel,
  postUploadFile,
  type SpaceLibrariesResponse,
  type SpaceTreeNode,
} from "../../core/apiClient.ts";
import { setLibraryPermissions } from "../../core/libraries.ts";
import { desktopFiles, readDraggedPath, removalLabel } from "../../core/paths.ts";
import { onWritten } from "../../core/spaceTree.ts";
import { buildAccordionRow, setRowExpanded } from "../../lib/accordion.ts";
import { copyPathItem } from "../../lib/copyPath.ts";
import { renderTreeLoading } from "../../lib/dom.ts";
import { flash } from "../../lib/flash.ts";
import type { NamingSurface, PendingCreate } from "../../lib/inlineEdit.ts";
import { createInlineError } from "../../lib/inlineError.ts";
import type { ListItemTarget } from "../../lib/listItemMenu.ts";
import { createListItemMenuButton } from "../../lib/listItemMenu.ts";
import { oneAtATime } from "../../lib/oneAtATime.ts";
import type { CollapsedFolders } from "../../services/collapsedFolders.ts";
import type { CommandContext, CommandRegistry } from "../../services/commands.ts";
import type { DialogService } from "../../services/dialog.ts";
import { onFolderSortChanged } from "../../services/folderSorts.ts";
import { type DroppedImportResult, describeImportProblems, importDroppedFiles } from "../../services/mediaImport.ts";
import type { ContextMenuService, MenuRegistry } from "../../services/menus.ts";
import { presetFolderItems } from "../../services/presetMenu.ts";
import * as settings from "../../services/settings.ts";
import type { SidebarView } from "../../services/sidebarViews.ts";
import { spaceChanges } from "../../services/spaceChanges.ts";
import type { Tabs } from "../../services/tabs.ts";
import type { ContextMenu } from "../contextMenu.ts";
import type { DropZone, TreeRenderContext, TreeView } from "../fileTreeView.ts";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2 21 6.5 12 11 3 6.5Z"/>
  <path d="M3 12 12 16.5 21 12"/>
  <path d="M3 17.5 12 22 21 17.5"/>
</svg>`;

// A library's description is one short line: Properties stops typing at this
// many characters, and the header's tooltip shows no more, so one written by
// hand past it is cut there, never in the file.
const DESCRIPTION_LIMIT = 80;

function tooltipDescription(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= DESCRIPTION_LIMIT) return text;
  const kept = chars.slice(0, DESCRIPTION_LIMIT - 1).join("");
  return `${kept.trimEnd()}…`;
}

const LOADING_DELAY_MS = 150;

export interface LibrariesViewDeps {
  fetchLibraries: () => Promise<SpaceLibrariesResponse>;
  // One folder's own entries, "" for the library's top level. A library is
  // listed a folder at a time as its folders open, so how big it is, or how
  // slow its drive, never decides how fast it opens.
  fetchLibraryFolder: (id: string, dir: string) => Promise<{ entries: SpaceTreeNode[]; changes?: string }>;
  // Drops the whole tree the library's documents resolve links against,
  // once a write may have changed it (web/core/spaceTree.ts).
  forgetLibraryTree: (id: string) => void;
  // A write here, or one from outside that the open library's feed saw:
  // whatever else lists a library from disk lists it again.
  onChanged: () => void;
  // Calls `onChanged` when the library's version moves past the one its
  // listings were read at, until the returned function is called
  // (web/services/spaceChanges.ts).
  followLibrary: (id: string, readAt: () => string | undefined, onChanged: () => void) => () => void;
  // Calls the listener with the rooted paths this window wrote
  // (web/core/spaceTree.ts).
  onWritten: (listener: (paths: readonly string[]) => void) => () => void;
  createTree: (listPath: string) => TreeView;
  showExtensions: () => boolean;
  createMenuButton: (label: string, target: ListItemTarget) => HTMLButtonElement;
  // Adds a library from the button it is handed, which a menu of the folders
  // other spaces use opens under. Injected rather than imported because
  // adding one means picking a
  // folder outside the space, which only the Electron shell can do — absent
  // here on every other target, which is what leaves the button off.
  addLibrary?: (anchor: HTMLElement) => Promise<void>;
  // Shared with the space tree: one store, keyed by rooted path, which is
  // also what knows a library folder starts collapsed.
  collapsed: Pick<CollapsedFolders, "isCollapsed" | "setCollapsed" | "expand" | "reveal">;
  // Brings this panel to the front — supplied by whoever registered the
  // view, since a view doesn't know the rail it sits on.
  show: () => void;
  // Read at use: the tab service is built after this view. Each open takes
  // a rooted path (`lib:<id>/…`), not a space-relative one: the same
  // dispatcher the space tree opens through, since the image pane's
  // raw-file URL carries a rooted path unchanged.
  tabs(): Pick<Tabs, "openEntry" | "openEntryBeside" | "openFolder">;
  // The tree's own context menu. Opened for a read-only library too, which
  // still opens a folder as a gallery; every action that writes checks the
  // target's `writable` itself.
  openTreeMenu: (event: MouseEvent, target: LibraryTreeTarget) => void;
  // The two writes the inline tree inputs commit. Injected rather than
  // imported so the panel's tests drive them without a server, like the
  // library list fetch.
  createEntry: (parentPath: string, name: string, type: "file" | "directory") => Promise<CreateEntryResponse>;
  // Moves the entry and settles everything that has to follow — the pending
  // save flushed, open tabs and models re-pointed, this panel re-read — and
  // reports its own refusals. The panel only clears its input; a tab left
  // on the old path would recreate the file on its next save.
  moveEntry: (from: string, to: string) => Promise<unknown>;
  // Reports a failed write. A tree action has nowhere of its own to show
  // one — the menu that started it is gone by the time the call settles.
  notify: (message: string) => void;
  // Copies files dropped from outside pragma into a folder, with its own
  // progress surface, and says what became of each.
  importFiles: (files: readonly File[], dir: string) => Promise<DroppedImportResult>;
}

/** What a library tree's context menu acts on: the row under the pointer,
 * or null for the empty area below the rows, plus which library's tree it
 * was. The id is carried because a node's own `path` is relative to its
 * library, and every write names the rooted form. `writable` is the entry's
 * access as the tree was drawn; absent reads as read-only.
 *
 * `naming` is set when another surface opened the menu (a gallery tile),
 * which then takes the name a rename or create asks for. */
export interface LibraryTreeTarget {
  libraryId: string;
  node: SpaceTreeNode | null;
  writable?: boolean;
  naming?: NamingSurface;
}

/** Where a create from `target` lands, rooted: inside a folder, beside a
 * file, at the library's top for the empty area. */
function createParentOf({ libraryId, node }: LibraryTreeTarget): string {
  const parent = node === null ? "" : node.type === "directory" ? node.path : dirnameOf(node.path);
  return formatRootedPath({ root: { library: libraryId }, path: parent });
}

/** The tree actions the panel's own context menu drives. Exposed rather
 * than registered here because commands register once at startup while the
 * rows they act on are rebuilt on every refresh — the same split
 * createLibraryManager already draws. */
export interface LibraryTreeActions {
  startCreate(target: LibraryTreeTarget, type: "file" | "directory"): Promise<void>;
  startRename(target: LibraryTreeTarget): void;
  /** The writes the inline inputs commit, for a name typed elsewhere. The
   * create's parent is rooted. */
  create(parentPath: string, type: "file" | "directory", name: string): Promise<void>;
  rename(target: LibraryTreeTarget, name: string): Promise<void>;
  /** Re-lists the open library's listed folders after a write made elsewhere. */
  reload(): Promise<void>;
}

export interface LibrariesView {
  view: SidebarView;
  tree: LibraryTreeActions;
  /** Shows this panel with that library expanded — what a library's name
   * elsewhere in the UI navigates to. */
  reveal(id: string): void;
  /** Shows this panel with the folder at a rooted path open in its library,
   * its row centred and flashed, as a folder bookmark brings it up. */
  revealFolder(path: string): void;
  /** The same for a file: its folders open, its row centred and flashed. */
  revealFile(path: string): void;
  /** Re-reads the library list. Called after a row action changes it —
   * those live on commands (see createLibraryManager), which don't own this
   * panel's DOM. */
  refresh(): Promise<void>;
}

interface Row {
  header: HTMLDivElement;
  body: HTMLDivElement;
  writable: boolean;
}

// The library a rooted path is in: none for a space path.
function libraryOf(rootedPath: string): string[] {
  try {
    const { root } = parseRootedPath(rootedPath);
    return isLibraryRoot(root) ? [root.library] : [];
  } catch {
    return [];
  }
}

export function createLibrariesView(deps: LibrariesViewDeps): LibrariesView {
  const panel = document.createElement("section");
  panel.className = "sidebar-panel";
  panel.hidden = true;
  // The title shares a row with the add button rather than sitting alone as
  // the other panels' titles do — this is the first sidebar panel with an
  // action of its own, and the row is what keeps the title's own metrics
  // (see .sidebar-title) untouched by it.
  const titleRow = document.createElement("div");
  titleRow.className = "sidebar-title-row";
  const title = document.createElement("h2");
  title.className = "sidebar-title";
  title.textContent = "Libraries";
  titleRow.append(title);
  if (deps.addLibrary) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "icon-button sidebar-title-action";
    add.setAttribute("aria-label", "Add library");
    const addIcon = document.createElement("span");
    addIcon.className = "sidebar-title-action-icon";
    add.append(addIcon);
    add.addEventListener("click", () => void deps.addLibrary?.(add));
    titleRow.append(add);
  }
  const empty = document.createElement("p");
  empty.className = "sidebar-panel-empty";
  const list = document.createElement("div");
  list.className = "sidebar-list";
  // Its rows' hints wait their delay, as the tree's do.
  list.dataset.tooltipWait = "";
  list.hidden = true;
  panel.append(titleRow, empty, list);

  const rows = new Map<string, Row>();
  let expandedId: string | undefined;
  // The open library's folders listed so far, by library-relative path, ""
  // for its top level. A folder not here draws as loading while it is open.
  const listings = new Map<string, SpaceTreeNode[]>();
  const listing = new Set<string>();
  // The open library's tree, kept across its redraws and dropped with it.
  let expandedView: TreeView | undefined;
  let unfollow: (() => void) | undefined;
  // The library version the listings were read at; "" when listings read
  // together came back at different versions, which the next answer settles.
  let readAt: string | undefined;
  // What the next listing of the libraries opens in place of the remembered
  // one: a library, and a file or folder in it to bring into view.
  let revealing: { id: string; entry?: string } | undefined;
  // That entry, rooted, until the open library has listed down to it.
  let unrevealed: string | undefined;
  // Both are rooted paths, matching what the tree compares them against.
  let editingPath: string | undefined;
  let pendingCreate: PendingCreate | undefined;

  const rootedIn = (libraryId: string, relativePath: string): string =>
    formatRootedPath({ root: { library: libraryId }, path: relativePath });

  function showEmpty(message: string): void {
    empty.textContent = message;
    empty.hidden = false;
    list.hidden = true;
  }

  // Every kind the library tree lists can be opened: the walk already
  // narrowed it to the ones whose pane renders read-only, and a tab under a
  // library root opens locked (web/core/paths.ts). The path arrives already
  // rooted, because the tree was told its root.
  function renderContext(libraryId: string, writable: boolean): TreeRenderContext {
    return {
      root: { library: libraryId },
      onOpen: (rootedPath) => void deps.tabs().openEntry(rootedPath),
      onOpenDirectory: (rootedPath) => void deps.tabs().openFolder(rootedPath),
      // A read-only library's file rows offer nothing, so only its folders
      // open a menu — the one that opens them as a gallery.
      onContextMenu: (event, node) => {
        if (writable || node.type === "directory") deps.openTreeMenu(event, { libraryId, node, writable });
      },
      // Never reported: a move within a library is read off the drop's own
      // payload, which names its root, so a row dragged from another library
      // or the space can be told apart and refused — carrying an entry
      // between roots is a copy, which the move route refuses.
      onDragStart: () => undefined,
      onDrop: writable ? (event, node, zone) => void handleDrop(libraryId, event, node, zone) : () => undefined,
      isCollapsed: deps.collapsed.isCollapsed,
      onToggleCollapse: (rootedPath, collapsed) => {
        deps.collapsed.setCollapsed(rootedPath, collapsed);
        if (!collapsed) listOpenFolders(libraryId);
      },
      showExtensions: deps.showExtensions(),
      editingPath,
      onRenameSubmit: (node, value) => void commitRename(libraryId, node, value),
      onRenameCancel: () => {
        editingPath = undefined;
        renderExpanded();
      },
      pendingCreate,
      onCreateSubmit: (pending, value) => void commitCreate(pending.parentPath, pending.type, value),
      onCreateCancel: () => {
        pendingCreate = undefined;
        renderExpanded();
      },
      readOnly: !writable,
    };
  }

  // ---- writes -------------------------------------------------------------

  /** Re-lists every folder of the open library listed so far, and redraws
   * it. Every write ends here rather than patching the rendered tree, so
   * what is on screen is what the filesystem answered. A folder that no
   * longer lists is gone, and its parent's new listing leaves it out. */
  async function reload(): Promise<void> {
    deps.onChanged();
    if (expandedId === undefined) return;
    const id = expandedId;
    deps.forgetLibraryTree(id);
    const dirs = [...listings.keys()];
    const listed = await Promise.allSettled(dirs.map((dir) => deps.fetchLibraryFolder(id, dir)));
    if (expandedId !== id) return; // the panel moved on while this was in flight
    const versions = new Set<string | undefined>();
    dirs.forEach((dir, index) => {
      const result = listed[index];
      if (result.status === "fulfilled") {
        listings.set(dir, result.value.entries);
        versions.add(result.value.changes);
      } else if (dir !== "") listings.delete(dir);
    });
    const [version] = versions;
    readAt = versions.size === 1 ? version : "";
    renderExpanded();
    listOpenFolders(id);
  }

  const reloadOnce = oneAtATime(reload);

  // A file this window wrote in a library shows at once: the open library
  // lists again, and for another its cached tree goes and whatever lists it
  // from disk lists it again, as for a change from outside.
  deps.onWritten((paths) => {
    const written = new Set(paths.flatMap(libraryOf));
    if (written.size === 0) return;
    for (const id of written) if (id !== expandedId) deps.forgetLibraryTree(id);
    if (expandedId !== undefined && written.has(expandedId)) reloadOnce();
    else deps.onChanged();
  });

  // A library's tree lists by name, so a sort picked for one of its folders
  // shows only in a gallery, which lists it again; the tree stays as it is.
  onFolderSortChanged((path) => {
    if (isLibraryPath(path)) deps.onChanged();
  });

  function report(error: unknown, fallback: string): void {
    deps.notify(error instanceof Error ? error.message : fallback);
  }

  // The listed tree, each folder's entries under it where it has been listed.
  function nodesOf(dir: string): SpaceTreeNode[] | undefined {
    return listings
      .get(dir)
      ?.map((node) =>
        node.type === "directory" && listings.has(node.path) ? { ...node, children: nodesOf(node.path) } : node,
      );
  }

  async function listFolder(id: string, dir: string): Promise<void> {
    if (listing.has(dir)) return;
    listing.add(dir);
    try {
      const { entries } = await deps.fetchLibraryFolder(id, dir);
      if (expandedId !== id) return;
      listings.set(dir, entries);
    } catch (error) {
      if (expandedId !== id) return;
      // Listed as empty, so the folder stops showing as loading; why it
      // failed goes where every other failed write in this panel does.
      listings.set(dir, []);
      report(error, "Failed to list the folder.");
    } finally {
      listing.delete(dir);
    }
    renderExpanded();
    listOpenFolders(id);
  }

  // Lists every folder showing open whose entries are not here yet: one the
  // collapse store remembers open, or one just opened. Once none is left to
  // list, the folder a reveal asked for has its row, if it is there at all.
  function listOpenFolders(id: string): void {
    const visit = (dir: string): void => {
      for (const node of listings.get(dir) ?? []) {
        if (node.type !== "directory" || deps.collapsed.isCollapsed(rootedIn(id, node.path))) continue;
        if (listings.has(node.path)) visit(node.path);
        else void listFolder(id, node.path);
      }
    };
    visit("");
    if (listing.size === 0) revealAsked();
  }

  // Not before every open folder has listed: one above the row listing later
  // would push it back out of view.
  function revealAsked(): void {
    const path = unrevealed;
    unrevealed = undefined;
    if (path === undefined || !expandedView?.reveal(path)) return;
    const label = expandedView.element.querySelector<HTMLElement>(`.node-label[data-path="${CSS.escape(path)}"]`);
    if (label) flash(label);
  }

  async function commitCreate(parentPath: string, type: "file" | "directory", rawValue: string): Promise<void> {
    pendingCreate = undefined;
    renderExpanded();
    await createNamed(parentPath, type, rawValue);
  }

  // The write behind a create, whichever surface its name was typed on.
  async function createNamed(parentPath: string, type: "file" | "directory", rawValue: string): Promise<void> {
    const name = rawValue.trim();
    if (!name) return;

    try {
      const created = await deps.createEntry(parentPath, name, type);
      await reload();
      // In a new tab, as every file just made opens (docs/architecture.md, Files and views).
      if (created.type === "file") void deps.tabs().openEntryBeside(created.path);
    } catch (error) {
      report(error, `Failed to create ${type === "file" ? "note" : "folder"}.`);
    }
  }

  async function commitRename(libraryId: string, node: SpaceTreeNode, rawValue: string): Promise<void> {
    editingPath = undefined;
    renderExpanded();
    await renameNamed(libraryId, node, rawValue);
  }

  // The write behind a rename, whichever surface its name was typed on.
  async function renameNamed(libraryId: string, node: SpaceTreeNode, rawValue: string): Promise<void> {
    const name = rawValue.trim();
    if (!name || name === basenameOf(node.path)) return;

    // Only the last segment changes: a rename keeps the entry where it is,
    // and the move route refuses anything that would change root anyway.
    const parent = dirnameOf(node.path);
    try {
      await deps.moveEntry(rootedIn(libraryId, node.path), rootedIn(libraryId, parent ? `${parent}/${name}` : name));
    } catch (error) {
      report(error, "Rename failed.");
    }
  }

  async function handleDrop(libraryId: string, event: DragEvent, node: SpaceTreeNode, zone: DropZone): Promise<void> {
    const folder = zone === "into" && node.type === "directory" ? node.path : dirnameOf(node.path);
    const files = desktopFiles(event);
    if (files.length) {
      await importInto(libraryId, folder, files);
      return;
    }

    await moveDraggedInto(libraryId, event, folder);
  }

  // A library keeps no binder order, so a drop inside the dragged entry's
  // own folder changes nothing and is ignored. A folder never moves into
  // itself or its own descendants.
  async function moveDraggedInto(libraryId: string, event: DragEvent, folder: string): Promise<void> {
    const dragged = readDraggedPath(event);
    if (!dragged || !sameRoot(dragged.root, { library: libraryId }) || !dragged.path) return;
    if (dirnameOf(dragged.path) === folder) return;
    if (folder === dragged.path || folder.startsWith(`${dragged.path}/`)) return;
    const name = basenameOf(dragged.path);
    try {
      await deps.moveEntry(rootedIn(libraryId, dragged.path), rootedIn(libraryId, folder ? `${folder}/${name}` : name));
    } catch (error) {
      report(error, "Move failed.");
    }
  }

  async function importInto(libraryId: string, folder: string, files: readonly File[]): Promise<void> {
    const dir = rootedIn(libraryId, folder);
    // Opened first, so the rows about to land in it are visible when the
    // tree is re-read.
    deps.collapsed.expand(dir);
    const result = await deps.importFiles(files, dir);
    await reload();
    const last = result.imported.at(-1);
    if (last) void deps.tabs().openEntry(last);
    const problems = describeImportProblems(result);
    if (problems) deps.notify(problems);
  }

  // A file dropped anywhere else on this panel — a read-only library's rows,
  // the space under the rows — has no handler of its own, and the browser's
  // default for a dropped file is to open it in place of the app. Caught
  // here instead: into the open library's root when it is writable, and
  // said so when it is not, rather than swallowed or navigated away.
  panel.addEventListener("dragover", (event) => event.preventDefault());
  panel.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = desktopFiles(event);
    const open = expandedId !== undefined ? rows.get(expandedId) : undefined;
    if (!files.length) {
      if (expandedId !== undefined && open?.writable) void moveDraggedInto(expandedId, event, "");
      return;
    }
    if (expandedId !== undefined && open?.writable) {
      void importInto(expandedId, "", files);
      return;
    }
    deps.notify(
      open
        ? "This library is read-only. Set it to Read & write in its Properties to drop files into it."
        : "Open a library that allows writing, then drop the files onto it.",
    );
  });

  const tree: LibraryTreeActions = {
    async startCreate(target, type) {
      const { libraryId } = target;
      // The input row is drawn inside its parent's list, so a collapsed
      // target — or a library whose row isn't open, when started from its
      // ⋮ — has to be opened first or the row appears nowhere.
      if (expandedId !== libraryId) await setExpanded(libraryId);
      if (expandedId !== libraryId) return;
      const parentPath = createParentOf(target);
      deps.collapsed.expand(parentPath);
      pendingCreate = { parentPath, type };
      editingPath = undefined;
      renderExpanded();
      listOpenFolders(libraryId);
    },
    startRename({ libraryId, node }) {
      if (!node) return;
      editingPath = rootedIn(libraryId, node.path);
      pendingCreate = undefined;
      renderExpanded();
    },
    create: createNamed,
    rename: async ({ libraryId, node }, name) => {
      if (node) await renameNamed(libraryId, node, name);
    },
    reload,
  };

  function renderExpanded(): void {
    if (expandedId === undefined) return;
    const row = rows.get(expandedId);
    const nodes = nodesOf("");
    if (!row || !nodes) return;
    // The list's own rooted path, not "": a library's top level is
    // `lib:<id>`, which is what a create row under it has to match.
    expandedView ??= deps.createTree(rootedIn(expandedId, ""));
    if (expandedView.element.parentNode !== row.body) row.body.replaceChildren(expandedView.element);
    expandedView.render(nodes, renderContext(expandedId, row.writable));
  }

  async function setExpanded(id: string | undefined, entry?: string): Promise<void> {
    expandedId = id;
    listings.clear();
    listing.clear();
    unfollow?.();
    readAt = undefined;
    // A change from outside re-lists what is listed, as a write here does.
    unfollow = id === undefined ? undefined : deps.followLibrary(id, () => readAt, reloadOnce);
    expandedView?.dispose();
    expandedView = undefined;
    editingPath = undefined;
    pendingCreate = undefined;
    unrevealed = entry;
    // Remembered per browser, so the panel comes back to the same library
    // — after a reload, and after switching away and back. Collapsing it is
    // remembered too: "" means open nothing next time.
    settings.sidebarLibrary.set(id ?? "");
    for (const [rowId, row] of rows) {
      const expanded = rowId === id;
      setRowExpanded(row, expanded);
      if (!expanded) row.body.replaceChildren();
    }
    if (id === undefined) return;

    const row = rows.get(id);
    if (!row) return;

    // Delayed so a library that lists at once doesn't flash it.
    const loading = window.setTimeout(() => {
      if (expandedId === id && !listings.has("")) row.body.replaceChildren(renderTreeLoading("p"));
    }, LOADING_DELAY_MS);

    let top: { entries: SpaceTreeNode[]; changes?: string };
    try {
      top = await deps.fetchLibraryFolder(id, "");
    } catch (thrown) {
      if (expandedId !== id) return;
      // The route says what went wrong — "Unknown library" for an id the
      // space no longer declares — and a fixed string here would hide it.
      const message = thrown instanceof Error ? thrown.message : "Failed to load library contents.";
      row.body.replaceChildren(createInlineError({ message }));
      return;
    } finally {
      window.clearTimeout(loading);
    }
    // The row may have collapsed, or another expanded, while this fetch was
    // in flight — only render into the one the user is still looking at.
    if (expandedId !== id) return;
    listings.set("", top.entries);
    readAt = top.changes;
    renderExpanded();
    listOpenFolders(id);
  }

  async function refresh(): Promise<void> {
    rows.clear();
    list.replaceChildren();
    // Nothing shows until the fetch settles — neither a stale list nor an
    // empty-state message that may turn out to be wrong.
    empty.hidden = true;
    list.hidden = true;
    expandedId = undefined;
    listings.clear();
    listing.clear();
    unfollow?.();
    unfollow = undefined;
    expandedView?.dispose();
    expandedView = undefined;

    let answer: SpaceLibrariesResponse;
    try {
      answer = await deps.fetchLibraries();
    } catch {
      showEmpty("Failed to load libraries.");
      return;
    }
    const { libraries, problem } = answer;
    // The one listing the app fetches, so the tab lock reads the same
    // access this panel draws from.
    setLibraryPermissions(libraries);
    if (problem !== undefined || libraries.length === 0) {
      showEmpty(problem ?? "No libraries in this space yet.");
      return;
    }
    empty.hidden = true;
    list.hidden = false;

    for (const library of libraries) {
      const { item, header, body } = buildAccordionRow(
        library.label,
        // State first, path second — the opposite order to a Manage Spaces
        // row, which says the same thing in a dialog wide enough to finish
        // the sentence. The sidebar ellipsizes a long absolute path well
        // before its end, which would hide the very word the row exists to
        // show.
        library.path === undefined
          ? "Not located on this computer"
          : library.missing
            ? `Folder not found: ${library.path}`
            : library.path,
        deps.createMenuButton("Library options", {
          kind: "library",
          id: library.id,
          label: library.label,
          description: library.description,
          path: library.path,
          access: library.access,
          missing: library.missing,
        }),
        // A library whose root is gone, or was never located here, doesn't
        // expand: there is nothing to walk, and an error inside the accordion
        // would say less than the row already does. It stays listed and keeps
        // its ⋮, where Locate lives under Electron.
        () => {
          if (library.missing) return;
          void setExpanded(expandedId === library.id ? undefined : library.id);
        },
      );
      if (library.missing) header.classList.add("is-unavailable");
      if (library.description) header.dataset.tooltip = tooltipDescription(library.description);
      list.append(item);
      rows.set(library.id, { header, body, writable: library.access === "read-write" });
    }

    // A reveal is honoured once — a request to open this library now — and
    // otherwise the panel returns to the library it last had open. A
    // remembered library the space no longer declares opens nothing.
    const asked = revealing;
    revealing = undefined;
    const wanted = asked?.id ?? (settings.sidebarLibrary.get() || undefined);
    if (wanted !== undefined && rows.has(wanted)) await setExpanded(wanted, asked?.entry);
  }

  // The folders above the entry, and a folder itself, are opened before the
  // panel shows too, so the listing that showing starts lists down to it.
  function revealEntry(path: string, isFolder: boolean): void {
    const { root } = parseRootedPath(path);
    if (!isLibraryRoot(root)) return;
    deps.collapsed.reveal(path);
    if (isFolder) deps.collapsed.expand(path);
    revealing = { id: root.library, entry: path };
    deps.show();
  }

  return {
    view: { id: "library", label: "Libraries", icon: ICON, panel, onShow: () => void refresh() },
    tree,
    // The id is recorded before the panel is shown, because showing it
    // re-lists the libraries and would otherwise collapse whatever was open.
    reveal: (id: string) => {
      revealing = { id };
      deps.show();
    },
    revealFolder: (path: string) => revealEntry(path, true),
    revealFile: (path: string) => revealEntry(path, false),
    refresh,
  };
}

// The Electron preload bridge's library half, when running in the desktop
// app; absent everywhere else, which is what leaves these actions off.
export interface LibraryLocationBridge {
  libraryOffers(): Promise<LibraryOffer[]>;
  addLibrary(from?: Pick<LibraryOffer, "space" | "id">): Promise<LibraryEntry | undefined>;
  relocateLibrary(id: string): Promise<string | undefined>;
}

// The Properties dialog's access choices. Typed against the config's
// own union so a value the form hands back is narrowed by looking it up
// here, never by casting the select's string.
const ACCESS_CHOICES: readonly { value: Access; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "read-write", label: "Read & write" },
];

export interface LibraryManagerDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  // A getter, not the service: these commands register while the sidebar is
  // built, which is before the dialog service exists, and none of them needs
  // it until something is clicked.
  dialog(): DialogService;
  bridge?: LibraryLocationBridge;
  // Opens the add button's menu.
  contextMenu: Pick<ContextMenuService, "open" | "close" | "isOpen">;
  // The writes that name no path — routes on every target.
  // Injected like the library list fetch, so the panel's tests drive them
  // without a server.
  setLibraryAccess(id: string, access: Access): Promise<void>;
  setLibraryLabel(id: string, label: string): Promise<void>;
  setLibraryDescription(id: string, description: string): Promise<void>;
  removeLibrary(id: string): Promise<void>;
  // The open library's tree, for the row actions to drive and re-read.
  tree: LibraryTreeActions;
  deleteEntry(path: string, trash: boolean): Promise<unknown>;
  // Whether Delete offers the trash, read as each menu and confirmation opens.
  moveToTrash(): boolean;
  // Drops the tabs a deleted entry leaves behind; without it the open
  // document keeps saving and the file comes back.
  onDeleted(path: string): void;
  // Re-reads the Libraries panel after an action changes a library. Held as
  // a callback because the panel is built alongside this, not before it.
  refresh(): Promise<void>;
  // Shows the panel with that library open: one just added, or one whose
  // name was clicked elsewhere in the UI.
  reveal(id: string): void;
  // Shows the panel open down to the folder or file at a rooted path, its
  // row flashed.
  revealFolder(path: string): void;
  revealFile(path: string): void;
}

export interface LibraryManager {
  /** Adds a library, then shows it open in the panel: one another space
   * uses, from a menu under `anchor`, or a folder from the native picker,
   * which opens straight away when no other space has one to offer. The
   * Libraries panel's add button runs this; a no-op with no bridge, which is
   * also when the button isn't drawn. */
  addLibrary(anchor?: HTMLElement): Promise<void>;
}

/** Owns the Libraries row actions on the "⋮" menu. Separate from the panel
 * because commands register once at startup, while the rows they act on are
 * rebuilt on every refresh.
 *
 * Locate goes through the Electron bridge, not a route: a library's folder is
 * outside the space, so only a native picker in the main process can name it
 * (docs/architecture.md's Document writes and reference integrity section). Properties
 * and Remove name no path and are routes, on every target. */
export function createLibraryManager(deps: LibraryManagerDeps): LibraryManager {
  type LibraryTarget = Extract<ListItemTarget, { kind: "library" }>;
  const libraryTarget = (arg: ListItemTarget): LibraryTarget => arg as LibraryTarget;

  // The main process refuses a folder already one of the space's libraries,
  // and there's no form open to show that on — same message-only confirm the
  // Site Settings load failure uses.
  async function report(title: string, error: unknown, fallback: string): Promise<void> {
    await deps.dialog().confirm({
      title,
      message: error instanceof Error ? error.message : fallback,
      confirmLabel: "OK",
    });
  }

  async function add(pick: () => Promise<LibraryEntry | undefined>): Promise<void> {
    try {
      const added = await pick();
      // Revealed, not just re-read: a plain re-read opens the library the
      // panel last had open, which leaves the new one shut.
      if (added) deps.reveal(added.id);
    } catch (error) {
      await report("Add library", error, "Failed to add that library.");
    }
  }

  async function addLibrary(anchor?: HTMLElement): Promise<void> {
    const bridge = deps.bridge;
    if (!bridge) return;
    if (anchor && deps.contextMenu.isOpen(anchor)) return deps.contextMenu.close();
    // A menu of one choice would only stand between the button and the
    // picker, so with nothing on offer the picker opens straight away.
    const offers = anchor ? await bridge.libraryOffers().catch((): LibraryOffer[] => []) : [];
    if (!anchor || offers.length === 0) return add(() => bridge.addLibrary());
    deps.contextMenu.open({
      anchor,
      align: "end",
      ariaLabel: "Add library",
      items: [
        ...offers.map((offer) => ({
          label: offer.label,
          description: offer.path,
          group: "offers",
          run: () => add(() => bridge.addLibrary({ space: offer.space, id: offer.id })),
        })),
        { label: "Choose folder…", group: "picker", run: () => add(() => bridge.addLibrary()) },
      ],
    });
  }

  deps.commands.register({
    id: "library.locate",
    label: "Locate…",
    // Only for a row whose folder is gone, or never located on this
    // computer: a space opened on a new machine finds its libraries here.
    //
    // Unlike a space, pragma can leave no marker in a library folder to find
    // it by — it is someone's photo archive or a sibling repo, possibly
    // read-only — so a picker is the only mechanism there is.
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "library" && arg.missing && deps.bridge !== undefined,
    run: async (_, arg: ListItemTarget) => {
      try {
        // Repoints the existing id, never adding the folder afresh:
        // every `lib:<id>/…` path already written in this space's documents
        // depends on that id surviving the move.
        const located = await deps.bridge?.relocateLibrary(libraryTarget(arg).id);
        if (located) await deps.refresh();
      } catch (error) {
        await report("Locate library", error, "Failed to relocate that library.");
      }
    },
  });

  deps.commands.register({
    id: "library.show",
    label: "Reveal in library",
    when: (_, arg) => libraryEntryOf(arg) !== undefined,
    run: (_, arg) => {
      const entry = libraryEntryOf(arg);
      if (entry === undefined) return;
      if (entry.type === "file") deps.revealFile(formatRootedPath(entry));
      else if (entry.path === "") deps.reveal(entry.root.library);
      else deps.revealFolder(formatRootedPath(entry));
    },
  });

  // Only the label: the id every `lib:<id>/…` path was written with stays,
  // and the folder keeps its own name. Offered for a missing library too,
  // since the name is the entry's, not the folder's.
  deps.commands.register({
    id: "library.rename",
    label: "Rename…",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "library",
    run: async (_, arg: ListItemTarget) => {
      const target = libraryTarget(arg);
      const renamed = await deps.dialog().prompt({
        title: "Rename library",
        icon: { glyph: "library" },
        message:
          "A display name for this library. The folder on disk keeps its name, and an empty name goes back to it.",
        value: target.label,
        submitLabel: "Rename",
        busyLabel: "Renaming…",
        failureMessage: "Failed to rename the library.",
        submit: async (value) => {
          if (value.trim() !== target.label) await deps.setLibraryLabel(target.id, value);
        },
      });
      if (renamed !== null) await deps.refresh();
    },
  });

  deps.commands.register({
    id: "library.properties",
    label: "Properties…",
    // Offered for every library: the description is the space's, as the
    // label is. Permission needs a folder on this computer, so a library
    // never located here shows none; a missing one keeps it, since an access
    // set while the drive is unplugged holds once it is back.
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "library",
    run: async (_, arg: ListItemTarget) => {
      const target = libraryTarget(arg);
      const located = target.path !== undefined;
      let changed = false;
      await deps.dialog().form({
        title: "Library properties",
        icon: { glyph: "library" },
        message: `${target.label} (${target.path ?? "Not located on this computer"})`,
        fields: [
          {
            id: "description",
            label: "Description",
            value: target.description ?? "",
            maxLength: DESCRIPTION_LIMIT,
          },
          ...(located
            ? [
                {
                  id: "access",
                  label: "Permission",
                  choices: ACCESS_CHOICES,
                  value: target.access,
                  description: "This computer only.",
                },
              ]
            : []),
        ],
        submitLabel: "Save",
        busyLabel: "Saving…",
        failureMessage: "Failed to save the library's properties.",
        submit: async (values) => {
          const description = (values.description ?? "").trim();
          if (description !== (target.description ?? "")) {
            await deps.setLibraryDescription(target.id, description);
            changed = true;
          }
          const access = ACCESS_CHOICES.find((choice) => choice.value === values.access)?.value;
          if (!located || access === undefined || access === target.access) return;
          await deps.setLibraryAccess(target.id, access);
          changed = true;
        },
      });
      // The row carries its description and access into the next Properties
      // open, so it has to be rebuilt from the listing once either changed.
      if (changed) await deps.refresh();
    },
  });

  deps.commands.register({
    id: "library.newFolder",
    label: "New Folder",
    // The row's ⋮ is the one way to reach a library's top level: the tree's
    // own menu opens on a row, which aims a create inside or beside it.
    when: (_, arg: ListItemTarget | undefined) =>
      arg?.kind === "library" && arg.access === "read-write" && !arg.missing,
    run: (_, arg: ListItemTarget) =>
      deps.tree.startCreate({ libraryId: libraryTarget(arg).id, node: null }, "directory"),
  });

  deps.commands.register({
    id: "library.remove",
    label: "Remove from list",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "library",
    run: async (_, arg: ListItemTarget) => {
      const target = libraryTarget(arg);
      const confirmed = await deps.dialog().confirm({
        title: "Remove from list",
        icon: { glyph: "library" },
        // Every computer, not only this one: the library leaves the space's
        // `_libraries.json`, which travels with the space.
        message: `Pragma takes “${target.label}” out of this space, on every computer that opens it. The folder and its files are left alone, but anything in the space that references it stops resolving.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await deps.removeLibrary(target.id);
      } catch (error) {
        await report("Remove from list", error, "Failed to remove that library.");
      }
      await deps.refresh();
    },
  });

  // "Remove from list" sits in its own group so a separator divides it from
  // Locate, matching the Manage Spaces menu's shape.
  deps.menus.register("listItem", [
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
    { command: "library.newFolder", group: "create" },
    { command: "library.rename" },
    { command: "library.locate" },
    { command: "library.properties" },
    ...presetFolderItems(
      (arg) =>
        isLibraryRow(arg) && !arg.missing ? formatRootedPath({ root: { library: arg.id }, path: "" }) : undefined,
      (message) => window.alert(message),
    ),
    { command: "library.remove", group: "destructive", danger: true },
  ]);

  // ---- a library's own tree ---------------------------------------------
  //
  // Every action here writes, so each applies only to a target drawn as
  // writable. The set is deliberately smaller than the space tree's: binder
  // order, Context, Find in context and New Site are all space machinery a
  // library never gets, whatever it may be written to.
  const treeTarget = (arg: ListItemTarget | LibraryTreeTarget | undefined): LibraryTreeTarget =>
    arg as LibraryTreeTarget;
  const isLibraryTreeTarget = (arg: unknown): arg is LibraryTreeTarget =>
    typeof arg === "object" && arg !== null && "libraryId" in arg;
  // A file holds no children, so the create actions give way to Rename;
  // only an actual row renames or deletes.
  const notFile = (_: CommandContext, arg: unknown) =>
    isLibraryTreeTarget(arg) && arg.writable === true && arg.node?.type !== "file";
  const isRow = (_: CommandContext, arg: unknown) =>
    isLibraryTreeTarget(arg) && arg.writable === true && arg.node !== null;
  // A name another surface asked for is typed there; the tree's own input
  // row otherwise.
  const createFrom = async (target: LibraryTreeTarget, type: "file" | "directory") => {
    if (!target.naming) return deps.tree.startCreate(target, type);
    const parentPath = createParentOf(target);
    target.naming.create({ parentPath, type }, (name) => void deps.tree.create(parentPath, type, name));
  };

  deps.commands.register({
    id: "libraryTree.newNote",
    label: "New Note",
    when: notFile,
    run: (_, arg) => createFrom(treeTarget(arg as LibraryTreeTarget), "file"),
  });
  deps.commands.register({
    id: "libraryTree.newFolder",
    label: "New Folder",
    when: notFile,
    run: (_, arg) => createFrom(treeTarget(arg as LibraryTreeTarget), "directory"),
  });
  deps.commands.register({
    id: "libraryTree.rename",
    label: "Rename…",
    when: isRow,
    run: (_, arg) => {
      const target = treeTarget(arg as LibraryTreeTarget);
      const { libraryId, node, naming } = target;
      if (!naming || !node) return deps.tree.startRename(target);
      const path = formatRootedPath({ root: { library: libraryId }, path: node.path });
      naming.rename(path, (name) => void deps.tree.rename(target, name));
    },
  });
  deps.commands.register({
    id: "libraryTree.delete",
    label: "Delete",
    when: isRow,
    run: async (_, arg) => {
      const { libraryId, node } = treeTarget(arg as LibraryTreeTarget);
      if (!node) return;
      const trash = deps.moveToTrash();
      const confirmed = await deps.dialog().confirm({
        title: trash ? `Move ${node.name} to Trash` : `Delete ${node.name}`,
        // Named as this library's own trash, because that is where it goes:
        // a library's deletions stay in the library, never in the space.
        message: trash
          ? `“${node.name}” moves to the .trash folder inside this library.`
          : `“${node.name}” is deleted from disk. This can't be undone.`,
        confirmLabel: trash ? "Move to Trash" : "Delete",
        danger: true,
      });
      if (!confirmed) return;
      const rooted = formatRootedPath({ root: { library: libraryId }, path: node.path });
      try {
        await deps.deleteEntry(rooted, trash);
        deps.onDeleted(rooted);
      } catch (error) {
        await (trash
          ? report("Move to Trash", error, "Moving to the Trash failed.")
          : report("Delete", error, "Delete failed."));
      }
      await deps.tree.reload();
    },
  });

  deps.menus.register("libraryTree", [
    { command: "gallery.openFolder", group: "open" },
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
    { command: "libraryTree.rename", group: "bookmark" },
    { command: "bookmarks.add", group: "bookmark" },
    { command: "bookmarks.remove", group: "bookmark" },
    ...presetFolderItems(
      (arg) =>
        isLibraryTreeTarget(arg) && arg.node?.type === "directory"
          ? formatRootedPath({ root: { library: arg.libraryId }, path: arg.node.path })
          : undefined,
      (message) => window.alert(message),
    ),
    { command: "libraryTree.newNote", group: "create" },
    { command: "libraryTree.newFolder", group: "create" },
    copyPathItem({ group: "copy" }),
    {
      command: "libraryTree.delete",
      group: "delete",
      label: () => removalLabel(deps.moveToTrash()),
      danger: true,
    },
  ]);

  return { addLibrary };
}

export interface LibrariesPanelDeps
  extends Omit<
      LibrariesViewDeps,
      | "createMenuButton"
      | "addLibrary"
      | "openTreeMenu"
      | "createEntry"
      | "notify"
      | "importFiles"
      | "fetchLibraryFolder"
      | "followLibrary"
      | "onWritten"
    >,
    Omit<
      LibraryManagerDeps,
      | "refresh"
      | "reveal"
      | "revealFolder"
      | "revealFile"
      | "setLibraryAccess"
      | "setLibraryLabel"
      | "setLibraryDescription"
      | "removeLibrary"
      | "tree"
      | "deleteEntry"
    > {
  // Both menus this panel opens are built from it: the row's own "⋮" and
  // the tree's context menu.
  contextMenu: ContextMenu;
}

/** The Libraries feature whole: the panel and its row actions, one entry
 * point because the panel's add button runs the manager's and every manager
 * action re-reads the panel.
 *
 * With no bridge there is no native picker to name a folder outside the
 * space, so the add button isn't drawn and Locate doesn't apply; Properties
 * and Remove need no path and are offered everywhere. */
export function createLibrariesPanel(deps: LibrariesPanelDeps): LibrariesView {
  const view = createLibrariesView({
    ...deps,
    createMenuButton: (label, target) => createListItemMenuButton(deps.contextMenu, label, target),
    openTreeMenu: (event, target) => {
      event.preventDefault();
      deps.contextMenu.open({
        menu: "libraryTree",
        arg: target,
        at: { x: event.clientX, y: event.clientY },
        ariaLabel: "Library actions",
      });
    },
    createEntry: postCreateEntry,
    // Straight to the route, never through the tree the library's links
    // resolve against: that cache has to hold the whole library, and a
    // listing is one folder of it.
    fetchLibraryFolder,
    followLibrary: spaceChanges.followLibrary,
    onWritten,
    importFiles: (files, dir) =>
      importDroppedFiles(files, dir, { dialog: deps.dialog(), createEntry: postCreateEntry, upload: postUploadFile }),
    // The same surface the space tree reports a failed write on. A tree
    // action's own menu is gone by the time the call settles, so there is
    // nowhere in the panel to put it.
    notify: (message) => window.alert(message),
    addLibrary: deps.bridge && ((anchor) => manager.addLibrary(anchor)),
  });
  const manager = createLibraryManager({
    ...deps,
    setLibraryAccess: postLibraryAccess,
    setLibraryLabel: postLibraryLabel,
    setLibraryDescription: postLibraryDescription,
    removeLibrary: deleteLibrary,
    deleteEntry: postDeleteEntry,
    tree: view.tree,
    refresh: () => view.refresh(),
    reveal: (id) => view.reveal(id),
    revealFolder: (path) => view.revealFolder(path),
    revealFile: (path) => view.revealFile(path),
  });
  return view;
}

function isLibraryRow(arg: unknown): arg is Extract<ListItemTarget, { kind: "library" }> {
  return typeof arg === "object" && arg !== null && (arg as { kind?: unknown }).kind === "library";
}

// The library entry a menu's `{ file }` or `{ folder }` names, a folder's
// top or anything inside it: a tab's file or folder, a status bar path's
// folder, or a preset folder.
function libraryEntryOf(
  arg: unknown,
): { root: { library: string }; path: string; type: "file" | "directory" } | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const named = "file" in arg ? arg.file : "folder" in arg ? arg.folder : undefined;
  if (typeof named !== "string") return undefined;
  try {
    const { root, path } = parseRootedPath(named);
    return isLibraryRoot(root) ? { root, path, type: "file" in arg ? "file" : "directory" } : undefined;
  } catch {
    return undefined;
  }
}
