// Space paths as the interface shows them: an entry's name, file type and
// icon, whether a tab is foreign or read-only, and what a dragged entry
// carries.
import type { FolderEntry } from "../../src/protocol/api.ts";
import type { PragmaFileRole } from "../../src/protocol/pragmaFiles.ts";
import {
  basenameOf,
  formatRootedPath,
  isLibraryPath,
  isLibraryRoot,
  type PathRoot,
  parseRootedPath,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";
import { isAgentsFile, isReadme } from "../../src/protocol/scopes.ts";
import {
  documentTypeFor,
  fileKindForPath,
  hasKnownKind,
  imageMediaTypeForPath,
  isLutFile,
  isMarkdownFile,
  isTableFile,
  pdfMediaTypeForPath,
  splitDocumentName,
  vectorImageMediaTypeForPath,
  videoMediaTypeForPath,
} from "../../src/protocol/types.ts";
import { countText } from "../lib/dom.ts";
import type { PendingCreate } from "../lib/inlineEdit.ts";
import type { SpaceTreeNode } from "./apiClient.ts";
import { isWritableRoot, libraryName } from "./libraries.ts";

// The whole extension comes off, compound ones included — the tree's icon
// already says what kind of document this is, so a stranded ".table" or
// ".applet" on the displayed name would be redundant as well as wrong.
export function stripExtension(name: string): string {
  return splitDocumentName(name).stem;
}

/** What a row, tile or menu says of a file Pragma can't open. */
export const CANT_OPEN = "Pragma can't open this file";

/** What a folder's menu calls opening it in the focused tab's place, where
 * Open in new tab and Open to the side follow it. */
export const OPEN_FOLDER = "Open";

/** The same action on a folder row's Open button. Alone on the row, "Open"
 * wouldn't say what opens, so the two labels differ on purpose. */
export const OPEN_GALLERY = "Open gallery";

/** What a menu calls opening a file or folder in a new tab after the
 * focused one, and a gallery preview's open button, which does the same. */
export const OPEN_IN_NEW_TAB = "Open in new tab";

/** The `{ file }` or `{ folder }` the open commands read, for a path as a
 * link writes it: a folder's ends in `/`, which the folder commands' path
 * doesn't. */
export function linkedEntry(path: string): { file: string } | { folder: string } {
  return path.endsWith("/") ? { folder: path.slice(0, -1) } : { file: path };
}

/** What a menu calls removing an entry, which Settings → Files → Move to
 * Trash sends to the Trash or deletes. */
export function removalLabel(trash: boolean): string {
  return trash ? "Move to Trash" : "Delete";
}

// Extensions are hidden by default, with no per-file override — only a
// document-type distinction. A file Pragma can't open keeps its extension,
// which is all that says what it is.
export function displayName(node: Pick<SpaceTreeNode, "name" | "type">, showExtensions: boolean): string {
  if (showExtensions || node.type === "directory" || !hasKnownKind(node.name)) return node.name;
  return stripExtension(node.name);
}

// The suffix the displayed name drops, e.g. ".md" or the compound
// ".table.html" — reattached after an extension-hidden rename.
export function extensionOf(name: string): string {
  return splitDocumentName(name).extension;
}

export function joinSpacePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

/** What a root is called in text, as the status bar names it: a library by
 * its display name, the id standing in until that is read, the space as
 * "Space". */
export function rootName(root: PathRoot): string {
  return isLibraryRoot(root) ? (libraryName(root.library) ?? root.library) : "Space";
}

/** A folder view's title: the folder's own name, whole, since a folder has no
 * extension to drop, or a root's name. */
export function folderTitle(dirPath: string): string {
  const { root, path } = parseRootedPath(dirPath);
  return path ? basenameOf(path) : rootName(root);
}

/** What a folder view says it shows, in the status bar: "2 folders · 7
 * files", a part with none left out. Empty for an empty folder, which the
 * view says itself. */
export function folderContentsLabel(entries: readonly { type: "file" | "directory" }[]): string {
  const folders = entries.filter((entry) => entry.type === "directory").length;
  const files = entries.length - folders;
  return [folders > 0 && countText(folders, "folder"), files > 0 && countText(files, "file")]
    .filter(Boolean)
    .join(" · ");
}

/** A Table's size, wherever one is said: "3 columns · 12 rows", its shape
 * before its length, an empty one's "0 rows" included. */
export function tableContentsLabel(columns: number, rows: number): string {
  return `${countText(columns, "column")} · ${countText(rows, "row")}`;
}

/** Everything listed under `entries`, all the way down, as a folder's tree
 * row counts it in its tooltip: "3 files, 2 folders". */
export function treeTotalsLabel(entries: readonly SpaceTreeNode[]): string {
  const { files, folders } = treeTotals(entries);
  return `${countText(files, "file")}, ${countText(folders, "folder")}`;
}

// Kept per entries array: a refresh brings new ones, and a redraw against
// the same tree never walks a folder twice.
const totalsOf = new WeakMap<readonly SpaceTreeNode[], { files: number; folders: number }>();

function treeTotals(entries: readonly SpaceTreeNode[]): { files: number; folders: number } {
  const known = totalsOf.get(entries);
  if (known) return known;
  const totals = { files: 0, folders: 0 };
  for (const entry of entries) {
    if (entry.type === "file") {
      totals.files += 1;
      continue;
    }
    const below = treeTotals(entry.children ?? []);
    totals.files += below.files;
    totals.folders += 1 + below.folders;
  }
  totalsOf.set(entries, totals);
  return totals;
}

// Flattens a space tree into every file's space-relative path, in tree order.
export function flattenTreeFilePaths(nodes: SpaceTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") paths.push(node.path);
    else if (node.children) paths.push(...flattenTreeFilePaths(node.children));
  }
  return paths;
}

/** The tab kind a media file opens as, or undefined for anything that is
 * not one. These are the kinds with no text to fetch: a click hands the path
 * straight to a pane, which reads the bytes from the raw-file route. The
 * tree's icon names the same kind, or a vector image for an SVG, so the two
 * can never disagree about what a given extension is. */
export function mediaTabKind(path: string): "image" | "video" | "pdf" | undefined {
  if (imageMediaTypeForPath(path)) return "image";
  if (videoMediaTypeForPath(path)) return "video";
  if (pdfMediaTypeForPath(path)) return "pdf";
  return undefined;
}

/** The tab kind a file opens as when its pane reads it from the raw-file
 * route itself: media, or a LUT. */
export function rawTabKind(path: string): "image" | "video" | "pdf" | "lut" | undefined {
  return mediaTabKind(path) ?? (isLutFile(path) ? "lut" : undefined);
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

/** What a link to the file at `path` says while the pointer rests on it: its
 * path, unless a page of the file shows instead, which the hint would open
 * over, or the link's `text` says it already. */
export function pathHint(path: string, text: string): string | undefined {
  return pageKind(path) !== undefined || text === path ? undefined : path;
}

export type FileType =
  | "image"
  | "vector-image"
  | "video"
  | "pdf"
  | "lut"
  | "markdown"
  | "readme"
  | "fountain"
  | "table"
  | "class"
  | "flow"
  | "applet"
  | "agents"
  | "scope"
  | "json"
  | "pragma-file";

// The per-extension class that drives a file's icon, shared by every surface
// that draws one so none can drift on which extension maps to which glyph.
// An AGENTS.md or README is known by its name.
//
// An AGENTS.md opening a scope and a JSON file Pragma reads wear Pragma's
// colours instead, which only the tree knows: a surface holding a tree node
// asks below, any other through core/spaceTree.ts.
export function fileTypeClass(path: string): FileType | undefined {
  if (isAgentsFile(path)) return "agents";
  if (isReadme(path)) return "readme";
  const kind = fileKindForPath(path);
  if (kind === "note") return "markdown";
  if (kind === "screenplay") return "fountain";
  if (kind === "image" && vectorImageMediaTypeForPath(path)) return "vector-image";
  return kind ?? (isJsonFile(path) ? "json" : undefined);
}

/** Whether `path` names a JSON file, which Pragma lists with every file type
 * shown but never opens. */
export function isJsonFile(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}

/** The class a listed file's icon wears. */
export function nodeFileType(node: SpaceTreeNode): FileType | undefined {
  if (node.pragmaFile) return "pragma-file";
  return node.opensScope ? "scope" : fileTypeClass(node.path);
}

/** The class a file being created wears before it has a name: its
 * template's, else its kind's. A note is Markdown, the extension the server
 * gives a file named without one. */
export function pendingFileType(pending: PendingCreate): FileType | undefined {
  if (pending.template) return fileTypeClass(pending.template.path);
  const kind = pending.kind ?? "note";
  return kind === "note" ? "markdown" : kind;
}

/** Whether a listed folder is a scope's: its AGENTS.md opens one over it. */
export function hasScope(node: SpaceTreeNode): boolean {
  return node.children?.some((child) => child.opensScope === true) ?? false;
}

/** The glyph an entry's icon draws (web/styles/entry-icons.css): a file
 * kind, a folder, a site root's globe, the folder a scope's World setting
 * names, a library's root, the space or Pragma named as a source beside
 * libraries, or a plain file's page, which only a surface that must show
 * something for one asks for. */
export type EntryGlyph = FileType | "folder" | "site" | "world" | "library" | "space" | "pragma" | "file";

export interface EntryIcon {
  // Absent for a plain file, which most surfaces leave bare.
  glyph?: EntryGlyph;
  // A folder a scope opens over.
  scope?: boolean;
}

/** A listed entry's icon, the one every surface that shows it draws. */
export function entryIcon(node: SpaceTreeNode): EntryIcon {
  if (node.type === "file") return { glyph: nodeFileType(node) };
  return { glyph: node.site ? "site" : node.world ? "world" : "folder", scope: hasScope(node) };
}

const FILE_TYPE_LABELS: Record<FileType, string> = {
  image: "Image",
  "vector-image": "Vector image",
  video: "Video",
  pdf: "PDF",
  lut: "LUT",
  markdown: "Note",
  readme: "Readme",
  fountain: "Screenplay",
  table: "Table",
  class: "Class",
  flow: "Flow",
  applet: "Applet",
  agents: "Agent instructions",
  scope: "Pragma scope",
  json: "JSON",
  "pragma-file": "Pragma file",
};

const PRAGMA_FILE_LABELS: Record<PragmaFileRole, string> = {
  order: "Pragma order",
  properties: "Pragma folder properties",
  tags: "Pragma tags",
  libraries: "Pragma libraries",
  presets: "Pragma presets",
  site: "Pragma site",
  queue: "Pragma publishing queue",
};

/** What one of Pragma's files does, named for its icon's tooltip. */
export function pragmaFileLabel(role: PragmaFileRole): string {
  return PRAGMA_FILE_LABELS[role];
}

/** What a file's icon stands for, named for its tooltip. Undefined exactly
 * when the file has no glyph to explain: a plain file. */
export function fileTypeLabel(type: FileType | undefined): string | undefined {
  return type && FILE_TYPE_LABELS[type];
}

/** Whether a tab's file lives under a root that isn't the space. Root
 * identity, and nothing else: it stays the same answer whether or not that
 * root is writable, which is why the tab accent keyed to it can't start
 * lying once a library becomes writable.
 *
 * Structural on purpose: every Tab shape satisfies it, including the ones
 * with no path at all (an empty tab, which is in no root) — hence the
 * `kind`, which every variant has and this never reads. */
export function isForeignRootTab(tab: { kind: string; path?: string }): boolean {
  // An unparseable path is the server's to reject, not this function's to
  // guess about — the library check answers false for one, and guessing
  // otherwise would mislabel a space file.
  return tab.path !== undefined && isLibraryPath(tab.path);
}

/** Whether the file behind a tab can be edited — read from the root's
 * registry entry, not assumed from its identity. Unlike the foreign-root
 * accent, this flips the moment a library's permission does, so it is derived
 * on every render, never captured at open. An unparseable path is the
 * server's to reject, so it reads as editable. */
export function isReadOnlyTab(tab: { kind: string; path?: string }): boolean {
  if (tab.path === undefined) return false;
  try {
    return !isWritableRoot(parseRootedPath(tab.path).root);
  } catch {
    return false;
  }
}

// ---- What a tree row puts on a drag, and how a drop target reads it back ----

/** The dragged tree row's node type, `"file"` or `"directory"`, set beside
 * its rooted path: the path alone can't say which, and a target that only
 * takes folders has to know. Its presence in `dataTransfer.types` during
 * `dragover` is also what marks a drag as an entry's. */
export const DRAGGED_ENTRY_TYPE = "application/x-pragma-entry-type";

/** What a confined tree's row drag carries in place of a path: no editor,
 * canvas or other tree reads it, so the drag lands only on the tree it came
 * from. */
export const CONFINED_DRAG_TYPE = "application/x-pragma-confined-entry";

/** What a Trash row's drag carries in place of a path. With its path on it,
 * a note would take the drop as a link to a file under `.trash/`, which
 * nothing can name; this way only the space tree takes it, and a confined
 * tree refuses it as it refuses every drag not its own. */
export const TRASH_DRAG_TYPE = "application/x-pragma-trash-entry";

/** What a drag of several selected rows carries in place of their paths. An
 * editor, canvas or field takes one path, so none of them reads it: it lands
 * only on a tree, whose host was handed the rows as the drag started. */
export const SELECTION_DRAG_TYPE = "application/x-pragma-selection";

/** The path a drag carries, parsed. A tree row writes its rooted path as
 * `text/plain` on purpose, so a drop into an ordinary text field still pastes
 * something readable. Undefined covers both "no path" and "not a path" — an
 * OS file drag, or App Mode's reorder payload, a node id that must keep
 * falling through untouched. */
export function readDraggedPath(event: DragEvent): RootedPath | undefined {
  const text = event.dataTransfer?.getData("text/plain");
  if (!text) return undefined;
  try {
    return parseRootedPath(text);
  } catch {
    return undefined;
  }
}

/** Whether a drag brings files from outside Pragma, told by its types alone,
 * as `dragover` has to. A dragged picture of an entry carries the browser's
 * copy of its bytes beside the entry, and the drop is the entry's: that copy
 * is never a file to import. */
export function carriesDesktopFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return types.includes("Files") && !types.includes(DRAGGED_ENTRY_TYPE);
}

/** The files a drop brings from outside Pragma, by that same rule. */
export function desktopFiles(event: DragEvent): File[] {
  return carriesDesktopFiles(event) ? Array.from(event.dataTransfer?.files ?? []) : [];
}

/** Whether a tree takes a drag: a confined drag lands only on a confined
 * tree, and a confined tree takes nothing else but files from the desktop. */
export function treeTakesDrag(event: DragEvent, confined: boolean): boolean {
  const types = event.dataTransfer?.types ?? [];
  return carriesDesktopFiles(event) || types.includes(CONFINED_DRAG_TYPE) === confined;
}

/** The rooted path of the drag in flight, for a target deciding *whether to
 * accept a drop* during `dragover`, where `dataTransfer.getData` returns ""
 * until the drop itself. Same-document drags only: an OS file drag leaves it
 * undefined. Never the authority on what was dropped — the drop's own payload
 * is — so a stale value can only cost a wrong cursor, never a wrong file. */
let dragInFlight: string | undefined;

export function noteDragInFlight(rootedPath: string | undefined): void {
  dragInFlight = rootedPath;
}

/** Puts an entry on a drag as its tree row does: its rooted path as text,
 * its type beside it, and the path for targets deciding during `dragover`.
 * Whatever starts the drag clears that on `dragend`. */
export function writeEntryDrag(transfer: DataTransfer, rootedPath: string, type: "file" | "directory"): void {
  transfer.setData("text/plain", rootedPath);
  transfer.setData(DRAGGED_ENTRY_TYPE, type);
  noteDragInFlight(rootedPath);
}

/** Makes each drag `source` starts carry the entry `entryAt` finds for it,
 * unless something claimed the drag first, as a zoomed picture's pan does.
 *
 * A picture wired here keeps its own drag, never `draggable = false`: the
 * copy of its bytes a browser adds to it is what an app outside Pragma takes. */
export function wireEntryDrag(
  source: HTMLElement,
  entryAt: (event: DragEvent) => Pick<FolderEntry, "path" | "type"> | undefined,
): void {
  source.addEventListener("dragstart", (event) => {
    const entry = event.defaultPrevented ? undefined : entryAt(event);
    if (!entry || !event.dataTransfer) return;
    writeEntryDrag(event.dataTransfer, entry.path, entry.type);
    event.dataTransfer.effectAllowed = "copyMove";
  });
  source.addEventListener("dragend", () => noteDragInFlight(undefined));
}

export function draggedPathInFlight(): RootedPath | undefined {
  if (!dragInFlight) return undefined;
  try {
    return parseRootedPath(dragInFlight);
  } catch {
    return undefined;
  }
}

/** Whether a drop is one of Pragma's own entry drags, which name a file a
 * person picked from what this window shows, rather than text that only reads
 * as a path: a link dragged out of a note, or a drag from another app. Only
 * the first stands for consent. Read during the drop: its drag end clears it. */
export function isEntryDrop(event: DragEvent): boolean {
  const dropped = readDraggedPath(event);
  const own = draggedPathInFlight();
  return dropped !== undefined && own !== undefined && formatRootedPath(dropped) === formatRootedPath(own);
}

/** What a drop target that only understands the space should say when it is
 * handed a library path. One message in one place, because every such target
 * refuses for the identical reason and a person dragging between panels
 * should not get a different explanation per drop zone. */
export const LIBRARY_DROP_REFUSAL = "A library file can only go in a note, a media field or a Load Image node.";

/** Reads a drag for a target that resolves paths against the space only:
 * the space-relative path, or undefined — after passing LIBRARY_DROP_REFUSAL
 * to `refuse` if the drag came from a library. Omitting `refuse` only drops
 * the message; a library path is still never run through space resolution,
 * where it would name a plausible, wrong file. */
export function readDraggedSpacePath(event: DragEvent, refuse?: (message: string) => void): string | undefined {
  const dragged = readDraggedPath(event);
  if (!dragged) return undefined;
  if (isLibraryRoot(dragged.root)) {
    refuse?.(LIBRARY_DROP_REFUSAL);
    return undefined;
  }
  return dragged.path;
}

/** An address as the space tree spells it: a space entry with no `space:`,
 * a library's with its `lib:`. */
export function treePath(stored: string): string {
  try {
    const rooted = parseRootedPath(stored);
    return isLibraryRoot(rooted.root) ? stored : rooted.path;
  } catch {
    return stored;
  }
}
