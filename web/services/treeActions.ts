// What a tree's rows take besides opening: create, from scratch or from a
// template, duplicate, rename, drag to move or reorder, drop files in from
// the desktop, and delete with its confirmation, with the commands and
// right-click menu that run them, for every root. Each tree's owner draws its
// rows and answers what it lists; one name field and one drag are held here.
import type { CreateEntryResponse } from "../../src/protocol/api.ts";
import { suggestedFields, THIS_FOLDER } from "../../src/protocol/class.ts";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import { entryNameForTitle, illegalEntryNameReason } from "../../src/protocol/entryName.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  type PathRoot,
  parseRootedPath,
  sameRoot,
} from "../../src/protocol/rootedPath.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import {
  CLASS_EXTENSION,
  type ClassRule,
  emptyClass,
  emptyTable,
  FLOW_EXTENSION,
  isClassFile,
  isFlowFile,
  isMarkdownFile,
  isTableFile,
  TABLE_EXTENSION,
} from "../../src/protocol/types.ts";
import {
  fetchFolderRows,
  fetchTemplateStartingName,
  postCreateEntry,
  postCreateFromTemplate,
  postDeleteEntry,
  postDuplicateEntry,
  postUploadFile,
  type SpaceTreeNode,
} from "../core/apiClient.ts";
import { isWritableRoot } from "../core/libraries.ts";
import {
  carriesDesktopFiles,
  DRAGGED_ENTRY_TYPE,
  desktopFiles,
  flattenTreeFilePaths,
  isEntryDrop,
  joinSpacePath,
  readDraggedPath,
  removalLabel,
  treeTakesDrag,
} from "../core/paths.ts";
import { isPresetPath } from "../core/presets.ts";
import { copyPathItem } from "../lib/copyPath.ts";
import { countText } from "../lib/dom.ts";
import { createDragHold } from "../lib/dragHold.ts";
import type { CreateKind, NamingSurface, PendingCreate } from "../lib/inlineEdit.ts";
import type { DropZone, TreeRenderContext } from "../view/fileTreeView.ts";
import type { CommandContext, CommandRegistry } from "./commands.ts";
import type { DialogService } from "./dialog.ts";
import type { EntryMove } from "./entryMove.ts";
import type { KeybindingRegistry } from "./keybindings.ts";
import { describeImportProblems, importDroppedFiles as importDropped } from "./mediaImport.ts";
import { COMMAND_PALETTE, type MenuItem, type MenuRegistry } from "./menus.ts";
import { type PresetRow, type PresetSource, presetFolderItems, presetMenuItems, presetSearch } from "./presetMenu.ts";
import type { Setting } from "./settings.ts";
import type { OpenOptions } from "./tabs.ts";

/** What a tree's owner answers for the actions on its rows. Every path is
 * rooted, which for the space is the bare path. */
export interface TreeHost {
  findEntry(path: string): SpaceTreeNode | undefined;
  /** A folder's entries, in the order its tree lists them. */
  children(path: string): SpaceTreeNode[] | undefined;
  /** Whether the tree drew a row for the entry: one in a collapsed folder has none. */
  hasRow(path: string): boolean;
  render(): void;
  /** Lists the tree again after a write, and redraws it. */
  refresh(): Promise<void>;
  /** Shows the tree with the folders above `path` open, for a name typed
   * into a row there by a command started away from it. */
  bringIntoView(path: string): void;
  /** Opens a folder, so a create row drawn in it shows. */
  expand(path: string): void;
  /** Whether every folder's entries are listed, so a folder's files can be
   * counted and an entry the listing lacks isn't there. A tree listed a
   * folder at a time can say neither. */
  listsWhole: boolean;
  /** Where a trashed entry goes, as the delete confirmation says it. */
  trashName: string;
  /** A drop only this tree takes: true once it has taken it. */
  takeDrop?(event: DragEvent, folder: string): boolean;
  /** Rows dropped before or after a row of the folder they are already in. */
  reorder?(dragged: readonly SpaceTreeNode[], target: SpaceTreeNode, position: "before" | "after"): void;
  /** A line the delete confirmation warns with, or undefined for none. */
  removalWarning?(nodes: readonly SpaceTreeNode[], trash: boolean): Promise<string | undefined>;
}

export interface TreeActionsDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  /** Read at use, not construction: the dialog service is built later. */
  dialog(): DialogService;
  /** Whether Delete offers the trash, read as each menu and confirmation opens. */
  moveToTrash: Pick<Setting<boolean>, "get">;
  open(path: string, options?: OpenOptions): Promise<void>;
  /** Where a file just made opens: a new tab after the current one, so the
   * file the writer was in stays open (docs/architecture.md, Files and views). */
  openBeside(path: string): Promise<void>;
  /** The whole move of each entry, as one action — the server rename, and
   * every tab and model displaced by it. Resolves once `refreshTree` has
   * run, to where each entry landed, or undefined for one that didn't move. */
  move(moves: readonly EntryMove[], refreshTree: () => Promise<unknown>): Promise<({ path: string } | undefined)[]>;
  /** After `path` is gone from disk and the tree: whatever the editor has to
   * do about tabs that pointed at it. */
  onDeleted(path: string): void;
  /** The templates New ▸ Template offers. */
  templateSources(): PresetSource[];
}

/** The fields of a tree's render context that write. */
export type TreeEditing = Pick<
  TreeRenderContext,
  | "onDragStart"
  | "onDrop"
  | "selectsMany"
  | "onDelete"
  | "editingPath"
  | "onRenameSubmit"
  | "onRenameCancel"
  | "pendingCreate"
  | "onCreateSubmit"
  | "onCreateCancel"
>;

export interface TreeActions {
  /** The tree listing every root `owns` answers true for: its rows' writes,
   * and the commands run on them, go through `host`. */
  attach(owns: (root: PathRoot) => boolean, host: TreeHost): void;
  /** For a tree of `root`, whose nodes' paths are relative to it. */
  editing(root?: PathRoot): TreeEditing;
  startCreate(parentPath: string, type: "file" | "directory", kind?: CreateKind): void;
  startRename(node: SpaceTreeNode): void;
  /** Refreshes and opens the new file — only if the refreshed tree actually
   * drew a row for it: a create into a collapsed folder draws none, and that
   * file isn't pulled onto screen behind the writer's back. */
  revealCreated(created: CreateEntryResponse): Promise<void>;
  confirmDelete(nodes: readonly SpaceTreeNode[]): Promise<void>;
  /** Moves `path` to the Trash for an action whose own click was the
   * confirmation: chat's Undo of something the copilot created. It asks first
   * only when the move would also unpublish, since the click named the Trash,
   * not taking a page offline, and resolves undefined when the writer says no. */
  trash(path: string): Promise<{ unpublishNote?: string } | undefined>;
  /** The empty area below the rows, which takes a drop into `folder`. */
  acceptDrag(event: DragEvent): void;
  dropInto(event: DragEvent, folder: string): void;
}

// The argument is the row under the pointer — null for empty tree space. A
// document can't contain children, so the create actions give way to
// Duplicate and Rename; only a directory sorts, has properties, or scopes
// Find in context; only an actual row renames or deletes. The disruptive actions sit last:
// a rename can break links into a note, and the other two destroy.
//
// `naming` is set when another surface opened this menu on its own drawing
// of the entry (a gallery tile): a name asked for is typed there.
// `selection` is set when the row is one of several selected together.
// `root` is the tree's, absent for the space; every path is rooted.
export type TreeTarget = {
  root?: PathRoot;
  node: SpaceTreeNode | null;
  naming?: NamingSurface;
  selection?: SpaceTreeNode[];
};

// A directory is its own target; a file's is its parent, so right-clicking
// a file acts on the folder it is already in.
export function parentPathOf(node: SpaceTreeNode | null, root: PathRoot = "space"): string {
  if (!node) return formatRootedPath({ root, path: "" });
  return node.type === "directory" ? node.path : dirnameOf(node.path);
}

/** A node a tree of `root` hands over, its path rooted. */
export function rootedNode(root: PathRoot, node: SpaceTreeNode): SpaceTreeNode {
  return isLibraryRoot(root) ? { ...node, path: formatRootedPath({ root, path: node.path }) } : node;
}

const rootOf = (arg?: TreeTarget): PathRoot => arg?.root ?? "space";
export const notFile = (_: CommandContext, arg?: TreeTarget) => arg?.node?.type !== "file";
export const isDirectory = (_: CommandContext, arg: TreeTarget) => arg.node?.type === "directory";
const isRow = (_: CommandContext, arg: TreeTarget) => arg.node !== null;
// Space bookkeeping refuses a library whatever its access, so what only the
// space keeps (New Site, a folder's context, kinds made from a seed) asks this.
export const inSpace = (arg?: TreeTarget) => !isLibraryRoot(rootOf(arg));
// A copy made in a preset folder would count as a preset, never as the
// space's content.
export const amongPresets = (arg?: TreeTarget) => isPresetPath(parentPathOf(arg?.node ?? null, rootOf(arg)));

// New ▸ Table/Class/Flow's seed content. A table gets one starter "Name"
// text column, written by the same serializer every real save uses. A
// Class's depends on its folder, so it is made as the Class is, and a flow's
// empty file is already a valid canvas.
function seedForKind(kind: CreateKind | undefined, name: string): { fileName: string; content?: string } {
  if (kind === "table") {
    return {
      fileName: isTableFile(name) ? name : `${name}${TABLE_EXTENSION}`,
      content: serializeTableFile({ ...emptyTable(), columns: [{ id: "name", type: "text", label: "Name" }] }),
    };
  }
  if (kind === "class") return { fileName: isClassFile(name) ? name : `${name}${CLASS_EXTENSION}` };
  if (kind === "flow") {
    return { fileName: isFlowFile(name) ? name : `${name}${FLOW_EXTENSION}` };
  }
  // A note's typed name that no file can carry (`Part 1: Intro`) is its
  // title: the heading keeps it verbatim and the file takes a name derived
  // from it. Only then — a legal name still makes an empty note titled by its
  // filename, not a heading that repeats it. Nothing derivable leaves the
  // name as typed, for the server to refuse with the rule it broke.
  const derived = illegalEntryNameReason(name) ? entryNameForTitle(name) : "";
  if (derived) return { fileName: `${derived}.md`, content: `# ${name}\n` };
  return { fileName: name };
}

export function createTreeActions(deps: TreeActionsDeps): TreeActions {
  const hosts: { owns: (root: PathRoot) => boolean; host: TreeHost }[] = [];
  const hostOf = (root: PathRoot): TreeHost | undefined => hosts.find((entry) => entry.owns(root))?.host;
  const hostFor = (path: string): TreeHost | undefined => hostOf(parseRootedPath(path).root);
  // A command runs only where a tree answers for the root, and writes only
  // where the root's access allows it.
  const writable = (arg?: TreeTarget) => hostOf(rootOf(arg)) !== undefined && isWritableRoot(rootOf(arg));

  const drag = createDragHold<SpaceTreeNode[]>();
  // Inline-edit state — at most one of these is active at a time, driving
  // the input row the renderer draws in place of a normal label.
  let editingPath: string | undefined;
  let pendingCreate: PendingCreate | undefined;
  // The tree drawing that row, redrawn when it moves to another.
  let fieldHost: TreeHost | undefined;

  function showField(host: TreeHost | undefined, field: { editingPath?: string; pendingCreate?: PendingCreate }) {
    const before = fieldHost;
    editingPath = field.editingPath;
    pendingCreate = field.pendingCreate;
    fieldHost = host;
    if (before && before !== host) before.render();
    host?.render();
  }

  function editing(root: PathRoot = "space"): TreeEditing {
    const rooted = (node: SpaceTreeNode) => rootedNode(root, node);
    return {
      onDragStart: (nodes) => drag.start(nodes.map(rooted)),
      onDrop: (event, node, zone) => handleDrop(event, rooted(node), zone, root),
      selectsMany: true,
      onDelete: (nodes) => void confirmDelete(nodes.map(rooted)),
      editingPath,
      onRenameSubmit: (node, rawValue) => commitRename(rooted(node), rawValue),
      onRenameCancel: cancelRename,
      pendingCreate,
      onCreateSubmit: commitCreate,
      onCreateCancel: cancelCreate,
    };
  }

  // `shown` says whether the writer can see where the new file landed: the
  // tree drew a row for it, or another surface drew the name field.
  async function revealCreated(created: CreateEntryResponse, shown?: (path: string) => boolean): Promise<void> {
    const host = hostFor(created.path);
    if (!host) return;
    await host.refresh();
    if (created.type !== "file") return;
    if (shown ? shown(created.path) : host.hasRow(created.path)) void deps.openBeside(created.path);
  }

  // A name typed on another surface drew no row: the file shows wherever the
  // listing holds it, and a tree listed a folder at a time can't tell.
  const isListed = (path: string) => {
    const host = hostFor(path);
    return host !== undefined && (!host.listsWhole || host.findEntry(path) !== undefined);
  };

  // ---- create ------------------------------------------------------------

  function startCreate(parentPath: string, type: "file" | "directory", kind?: CreateKind): void {
    beginCreate({ parentPath, type, kind });
  }

  function beginCreate(pending: PendingCreate): void {
    const host = hostFor(pending.parentPath);
    if (!host) return;
    // The input row is drawn as a child of `parentPath`'s list, so a
    // collapsed target needs expanding first or the row is created invisibly.
    host.expand(pending.parentPath);
    showField(host, { pendingCreate: pending });
  }

  function cancelCreate(): void {
    showField(undefined, {});
  }

  async function commitCreate(pending: PendingCreate, rawValue: string): Promise<void> {
    const host = hostFor(pending.parentPath);
    showField(undefined, {});
    await createNamed(pending, rawValue, (path) => host?.hasRow(path) ?? false);
  }

  // The write behind a create, whichever surface its name was typed on.
  async function createNamed(
    { parentPath, type, kind, template }: PendingCreate,
    rawValue: string,
    shown: (path: string) => boolean,
  ): Promise<void> {
    const name = rawValue.trim();
    if (!name) return;

    try {
      if (template) {
        const created = await postCreateFromTemplate(template.path, parentPath, name, template.source);
        await hostFor(parentPath)?.refresh();
        // A folder opens at its README, the one file every folder template has.
        const opened = created.type === "file" ? created.path : `${created.path}/README.md`;
        if (shown(created.path)) void deps.openBeside(opened);
        return;
      }
      const seeded = type === "file" ? seedForKind(kind, name) : { fileName: name, content: undefined };
      const { fileName } = seeded;
      const content = type === "file" && kind === "class" ? await classSeed(parentPath) : seeded.content;
      const created = await postCreateEntry(parentPath, fileName, type, content);
      await revealCreated(created, shown);
    } catch (error) {
      const kindLabel = template ? template.label : (kind ?? (type === "file" ? "note" : "folder"));
      window.alert(error instanceof Error ? error.message : `Failed to create ${kindLabel}.`);
    }
  }

  // A Class made in a folder reads its own folder, its fields the keys the
  // folder's notes already use. It names it `this.file.folder`, not by path,
  // so a moved Class or a template's copy reads the folder it lands in. One
  // made at the space's top reads the whole space, so it starts with no
  // field: the top folder's keys say little of it.
  async function classSeed(parentPath: string): Promise<string> {
    const filter: ClassRule[] =
      parentPath === "" ? [] : [{ property: "file.folder", test: "is", values: [THIS_FOLDER] }];
    const fields = parentPath === "" ? [] : suggestedFields(await fetchFolderRows(parentPath).catch(() => []));
    return serializeClassFile({ ...emptyClass(), filter, fields });
  }

  // ---- rename ------------------------------------------------------------

  function startRename(node: SpaceTreeNode): void {
    showField(hostFor(node.path), { editingPath: node.path });
  }

  function cancelRename(): void {
    showField(undefined, {});
  }

  function commitRename(node: SpaceTreeNode, rawValue: string): void {
    // Closes the input immediately rather than waiting on the network — the
    // label reverts to its old name until (if the rename succeeds) the
    // move's own refresh shows the new one.
    showField(undefined, {});
    void renameNamed(node, rawValue);
  }

  // The write behind a rename, whichever surface its name was typed on.
  // Resolves to where the entry is afterwards, moved or not.
  async function renameNamed(node: SpaceTreeNode, rawValue: string): Promise<string> {
    const newName = rawValue.trim();
    if (!newName || newName === node.name) return node.path;

    // Refused here rather than left to the server, whose message can't know
    // the entry is a note — and so can't point at the heading, which takes
    // the characters the name can't.
    const illegal = node.type === "file" && isMarkdownFile(node.name) ? illegalEntryNameReason(newName) : null;
    if (illegal) {
      window.alert(`${illegal}. A note's title can hold any text: edit its heading instead.`);
      return node.path;
    }

    const host = hostFor(node.path);
    if (!host) return node.path;
    const to = joinSpacePath(dirnameOf(node.path), newName);
    const [moved] = await deps.move([{ from: node.path, to }], () => host.refresh());
    return moved?.path ?? node.path;
  }

  // ---- duplicate ---------------------------------------------------------

  // The copy opens straight into rename: the server's `name 2` is a
  // placeholder, and naming the copy is nearly always the next step. The
  // rename starts after the open settles, or the editor takes focus from it.
  //
  // Named on another surface, the copy opens once named instead: opened
  // first, it would hide the field it is being named in.
  async function duplicate(node: SpaceTreeNode, naming?: NamingSurface): Promise<void> {
    const host = hostFor(node.path);
    if (!host) return;
    try {
      const created = await postDuplicateEntry(node.path);
      await host.refresh();
      if (naming) {
        const listed = host.findEntry(created.path);
        if (listed) naming.rename(listed.path, (name) => void renameNamed(listed, name).then(deps.openBeside));
        return;
      }
      if (!host.hasRow(created.path)) return;
      await deps.openBeside(created.path);
      const copy = host.children(dirnameOf(created.path))?.find((row) => row.path === created.path);
      if (copy) startRename(copy);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to duplicate.");
    }
  }

  // ---- drag: move, reorder, import ---------------------------------------

  // An entry already in the folder stays where it is.
  function moveEntries(host: TreeHost, nodes: readonly SpaceTreeNode[], destinationParentPath: string) {
    const moves = nodes
      .filter((node) => dirnameOf(node.path) !== destinationParentPath)
      .map((node) => ({ from: node.path, to: joinSpacePath(destinationParentPath, basenameOf(node.path)) }));
    return deps.move(moves, () => host.refresh());
  }

  // OS-file counterpart to create: a drop from the desktop delivers real
  // `File` objects rather than a tree node's text/plain path. Only `.md` is
  // accepted — the one extension a bare drop can adopt without guessing at
  // frontmatter. A name collision (409) is reported but doesn't abort the
  // rest of the drop.
  async function importDroppedFiles(host: TreeHost, files: readonly File[], parentPath: string): Promise<void> {
    host.expand(parentPath);
    const result = await importDropped(files, parentPath, {
      dialog: deps.dialog(),
      createEntry: postCreateEntry,
      upload: postUploadFile,
    });
    await host.refresh();
    const last = result.imported.at(-1);
    if (last && host.hasRow(last)) void deps.open(last);
    const problems = describeImportProblems(result);
    if (problems) window.alert(problems);
  }

  // What a drop on a tree of `root` moves: the rows a tree's own drag holds,
  // else the entry another surface's drag names (a gallery tile, a
  // bookmark), never text that only reads as a path. Entries of another root
  // stay where they are: carried across, a move would be a copy.
  function draggedInto(event: DragEvent, root: PathRoot): SpaceTreeNode[] | undefined {
    const dragged = drag.take() ?? entryDragged(event);
    if (!dragged?.length) return undefined;
    return dragged.every((entry) => sameRoot(parseRootedPath(entry.path).root, root)) ? dragged : undefined;
  }

  function entryDragged(event: DragEvent): SpaceTreeNode[] | undefined {
    const named = isEntryDrop(event) ? readDraggedPath(event) : undefined;
    if (!named?.path) return undefined;
    const type = event.dataTransfer?.getData(DRAGGED_ENTRY_TYPE) === "directory" ? "directory" : "file";
    return [{ name: basenameOf(named.path), path: formatRootedPath(named), type }];
  }

  function handleDrop(event: DragEvent, node: SpaceTreeNode, zone: DropZone, root: PathRoot): void {
    const host = hostOf(root);
    if (!host) return;
    // "into" only ever applies to a directory target — the destination is
    // the directory itself. Otherwise the drop is a sibling placement next
    // to `node`, so the destination is the folder containing `node`, even
    // when `node` is a directory — it is not its own container here.
    const destinationParentPath = zone === "into" ? node.path : dirnameOf(node.path);

    // A drop carrying real OS files is unrelated to the in-tree drag state
    // below, which only the tree's own dragstart ever sets.
    const files = desktopFiles(event);
    if (files.length) {
      void importDroppedFiles(host, files, destinationParentPath);
      return;
    }

    if (host.takeDrop?.(event, destinationParentPath)) return;

    const dragged = draggedInto(event, root);
    if (!dragged || dragged.some((entry) => entry.path === node.path)) return;

    // Refuse to drop a folder into itself or one of its own descendants,
    // whichever zone got us to that destination: the whole drop, never the
    // rest of what was dragged without it.
    const intoItself = (entry: SpaceTreeNode) =>
      entry.type === "directory" &&
      (destinationParentPath === entry.path || destinationParentPath.startsWith(`${entry.path}/`));
    if (dragged.some(intoItself)) return;

    if (zone !== "into" && dragged.every((entry) => dirnameOf(entry.path) === destinationParentPath)) {
      host.reorder?.(dragged, node, zone);
      return;
    }

    void moveEntries(host, dragged, destinationParentPath);
  }

  // By the rule the rows follow: the tree's own drags, and files.
  function acceptDrag(event: DragEvent): void {
    if (!treeTakesDrag(event, false)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = carriesDesktopFiles(event) ? "copy" : "move";
  }

  function dropInto(event: DragEvent, folder: string): void {
    event.preventDefault();
    const { root } = parseRootedPath(folder);
    const host = hostOf(root);
    if (!host) return;
    const files = desktopFiles(event);
    if (files.length) {
      void importDroppedFiles(host, files, folder);
      return;
    }
    if (host.takeDrop?.(event, folder)) return;
    const dragged = draggedInto(event, root);
    if (dragged) void moveEntries(host, dragged, folder);
  }

  // ---- the right-click menu ---------------------------------------------

  // A key, the palette or the menu bar hands no row, so the entry open in the
  // focused group stands in: a create lands in its folder (the space root for
  // a tab outside the tree), and Rename and Delete take it when it is a file.
  // For a name, the tree comes up, since it is typed into a row there. Only
  // the space's tree answers for a tab.
  const focusedEntry = (context: CommandContext): SpaceTreeNode | null =>
    (context.tab.kind === "empty" ? undefined : hostOf("space")?.findEntry(context.tab.path)) ?? null;
  const creates = (type: "file" | "directory", kind?: CreateKind) => (context: CommandContext, arg?: TreeTarget) => {
    const parentPath = parentPathOf(arg ? arg.node : focusedEntry(context), rootOf(arg));
    if (arg?.naming) {
      const pending = { parentPath, type, kind };
      arg.naming.create(pending, (name) => void createNamed(pending, name, isListed));
      return;
    }
    if (!arg) hostFor(parentPath)?.bringIntoView(parentPath);
    startCreate(parentPath, type, kind);
  };
  // New ▸ Template's items, as the templates hold them: a group is a
  // submenu, and each template is made where New was chosen.
  // A template's row in New ▸ Template: a copy of it made where New was
  // chosen, a folder template copied whole.
  function templateLeaf(row: PresetRow, target: TreeTarget): MenuItem {
    const type = row.icon.glyph === "folder" ? "directory" : "file";
    const source = row.pragma ? "pragma" : undefined;
    return {
      label: row.label,
      run: () => void createFromTemplate({ path: row.path, label: row.label, source }, type, target),
    };
  }
  // The name a copy starts with is asked for before the field is drawn, so
  // nothing typed is ever replaced by its arrival.
  async function createFromTemplate(
    template: { path: string; label: string; source?: "pragma" },
    type: "file" | "directory",
    target: TreeTarget,
  ): Promise<void> {
    const initialName = await fetchTemplateStartingName(template.path, template.source).catch(() => "");
    const pending: PendingCreate = { parentPath: parentPathOf(target.node, rootOf(target)), type, template };
    if (initialName) pending.initialName = initialName;
    if (target.naming) target.naming.create(pending, (name) => void createNamed(pending, name, isListed));
    else beginCreate(pending);
  }
  const { commands, menus } = deps;
  const createsHere = (context: CommandContext, arg?: TreeTarget) => notFile(context, arg) && writable(arg);
  const seedsHere = (context: CommandContext, arg?: TreeTarget) => notFile(context, arg) && inSpace(arg);
  commands.register({ id: "tree.newNote", label: "New Note", when: createsHere, run: creates("file", "note") });
  commands.register({ id: "tree.newFolder", label: "New Folder", when: createsHere, run: creates("directory") });
  commands.register({ id: "tree.newTable", label: "New Table", when: seedsHere, run: creates("file", "table") });
  commands.register({ id: "tree.newFlow", label: "New Flow", when: seedsHere, run: creates("file", "flow") });
  commands.register({
    id: "tree.newClass",
    label: "New Class",
    when: seedsHere,
    run: creates("file", "class"),
  });
  commands.register({
    id: "tree.duplicate",
    label: "Duplicate",
    when: (_, arg: TreeTarget) => arg.node?.type === "file" && inSpace(arg),
    run: (_, arg: TreeTarget) => {
      if (arg.node) void duplicate(arg.node, arg.naming);
    },
  });
  commands.register({
    id: "tree.rename",
    label: "Rename…",
    when: (context, arg?: TreeTarget) =>
      arg ? isRow(context, arg) && writable(arg) : focusedEntry(context)?.type === "file",
    run: (context, arg?: TreeTarget) => {
      const node = arg ? arg.node : focusedEntry(context);
      if (!node) return;
      if (arg?.naming) {
        arg.naming.rename(node.path, (name) => void renameNamed(node, name));
        return;
      }
      if (!arg) hostFor(node.path)?.bringIntoView(node.path);
      startRename(node);
    },
  });
  commands.register({
    id: "tree.delete",
    label: "Delete",
    when: (context, arg?: TreeTarget) => {
      if (!arg) return focusedEntry(context)?.type === "file";
      if (!writable(arg)) return false;
      return arg.selection ? arg.selection.length > 0 : isRow(context, arg);
    },
    run: (context, arg?: TreeTarget) => {
      const node = arg ? arg.node : focusedEntry(context);
      void confirmDelete(arg?.selection ?? (node ? [node] : []));
    },
  });
  const isFolderRow = (context: CommandContext, arg: unknown) => isDirectory(context, arg as TreeTarget);
  const notFolderRow = (context: CommandContext, arg: unknown) => !isFolderRow(context, arg);
  menus.register("tree", [
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    // A file's Duplicate, Rename… and Bookmark sit after the ways to open it,
    // and a folder's Rename… and Bookmark after its own.
    { command: "tree.duplicate", group: "bookmark" },
    { command: "tree.rename", group: "bookmark", when: notFolderRow },
    { command: "bookmarks.add", group: "bookmark", when: notFolderRow },
    { command: "bookmarks.remove", group: "bookmark", when: notFolderRow },
    { command: "tree.newNote", group: "create" },
    { command: "tree.newFolder", group: "create" },
    {
      label: "New",
      group: "new",
      // No Applet here: an Applet is code, written or copied in, so there is
      // no empty one worth seeding.
      submenu: [
        { command: "tree.newTable", label: "Table" },
        { command: "tree.newFlow", label: "Flow" },
        { command: "tree.newClass", label: "Class" },
        {
          label: "Template",
          group: "template",
          when: (context, arg) => seedsHere(context, arg as TreeTarget) && !amongPresets(arg as TreeTarget),
          search: (_, arg) =>
            presetSearch(deps.templateSources(), "Search templates", (row) => templateLeaf(row, arg as TreeTarget)),
          submenu: (_, arg) => presetMenuItems(deps.templateSources(), (row) => templateLeaf(row, arg as TreeTarget)),
        },
      ],
    },
    { command: "tree.newSite", group: "site" },
    { command: "gallery.openFolder", group: "view", when: isDirectory },
    { command: "gallery.openFolderInNewTab", group: "view" },
    { command: "gallery.openFolderToSide", group: "view" },
    { command: "tree.rename", group: "folder-bookmark", when: isFolderRow },
    { command: "bookmarks.add", group: "folder-bookmark", when: isFolderRow },
    { command: "bookmarks.remove", group: "folder-bookmark", when: isFolderRow },
    ...presetFolderItems(
      (arg) => {
        const node = (arg as TreeTarget | undefined)?.node;
        return node?.type === "directory" ? node.path : undefined;
      },
      (message) => window.alert(message),
      "folder-bookmark",
    ),
    { command: "tree.context", group: "folder" },
    { command: "search.inFolder", group: "folder", when: (_, arg) => inSpace(arg as TreeTarget) },
    { command: "tree.findContext", group: "folder" },
    copyPathItem({ group: "copy" }),
    {
      command: "tree.delete",
      group: "delete",
      label: () => removalLabel(deps.moveToTrash.get()),
      danger: true,
    },
  ]);
  // A right-click on one of several selected rows: only what acts on them all.
  menus.register("tree-selection", [
    {
      command: "tree.delete",
      label: (_, arg) => {
        const count = (arg as TreeTarget).selection?.length ?? 0;
        const items = countText(count, "Item");
        return deps.moveToTrash.get() ? `Move ${items} to Trash` : `Delete ${items}`;
      },
      danger: true,
    },
  ]);
  deps.keybindings.register({ key: "F2", command: "tree.rename" });
  // A browser opens a window of its own on Mod+N and never hands it to the
  // page, so only the desktop app binds it.
  if (window.pragmaElectron) deps.keybindings.register({ key: "Mod+N", command: "tree.newNote" });
  menus.register(COMMAND_PALETTE, [
    { command: "tree.newNote" },
    { command: "tree.newFolder" },
    { command: "tree.newTable" },
    { command: "tree.newFlow" },
    { command: "tree.newClass" },
    { command: "tree.rename", label: "Rename File…" },
  ]);

  // ---- delete ------------------------------------------------------------

  // Bumped on every request so a slower, earlier pre-check can't open a
  // dialog for a node the user has since moved on from.
  let deleteConfirmToken = 0;

  // The removal itself already succeeded: Unpublish just didn't go through
  // for some documents, which stay queued in their site's _queue.json.
  function queuedUnpublishNote(pending: number): string {
    return pending === 1
      ? "1 published document couldn't be unpublished from its site yet. It remains queued for later."
      : `${pending} published documents couldn't be unpublished from their sites yet. They remain queued for later.`;
  }

  // The entries a removal names, quoted as its title quotes one: the first
  // ten, then how many more.
  function quotedNames(nodes: readonly SpaceTreeNode[]): string {
    const names = nodes.slice(0, 10).map((node) => `"${node.name}"`);
    const more = nodes.length - names.length;
    if (more > 0) return `${names.join(", ")} and ${more.toLocaleString()} more`;
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }

  // What removing `nodes` asks before they go, the same from the delete
  // dialog and from chat's Undo. A tree listed a folder at a time can't count
  // a folder's files, so it says what goes without a number.
  function removalPrompt(
    host: TreeHost,
    nodes: readonly SpaceTreeNode[],
    trash: boolean,
    unpublishWarning: string | undefined,
  ) {
    const [node] = nodes;
    const { trashName, listsWhole } = host;
    const count = `${nodes.length.toLocaleString()} Items`;
    let message: string;
    const warnings: string[] = [];
    if (nodes.length > 1) {
      const names = quotedNames(nodes);
      message = trash
        ? `These ${count.toLowerCase()} will be moved to ${trashName}: ${names}.`
        : `This permanently deletes these ${count.toLowerCase()}: ${names}. This cannot be undone.`;
      const folders = nodes.filter((each) => each.type === "directory");
      const fileCount = folders.reduce((sum, folder) => sum + flattenTreeFilePaths(folder.children ?? []).length, 0);
      if (listsWhole && fileCount > 0) {
        const holds = folders.length === 1 ? "The folder among them holds" : "The folders among them hold";
        const files = countText(fileCount, "file");
        warnings.push(`${holds} ${files}, which will be ${trash ? `moved to ${trashName}` : "deleted"} too.`);
      } else if (!listsWhole && folders.length > 0) {
        const inside = folders.length === 1 ? "the folder" : "the folders";
        warnings.push(`Everything inside ${inside} among them will be ${trash ? "moved" : "deleted"} too.`);
      }
    } else if (node.type === "directory") {
      const fileCount = flattenTreeFilePaths(node.children ?? []).length;
      message = trash ? `This folder will be moved to ${trashName}.` : "Are you sure you want to delete this folder?";
      if (!listsWhole) {
        warnings.push(trash ? "Everything inside it will be moved too." : "Everything inside it will be deleted.");
      } else if (fileCount > 0) {
        warnings.push(
          trash
            ? `This folder is not empty. If you continue, the ${countText(fileCount, "file")} inside this folder will be moved to ${trashName} too.`
            : `This folder is not empty. If you continue, the ${countText(fileCount, "file")} inside this folder will be deleted.`,
        );
      }
    } else {
      message = trash
        ? `This file will be moved to ${trashName}.`
        : "This permanently deletes the file. This cannot be undone.";
    }
    if (unpublishWarning) warnings.push(unpublishWarning);
    const target = nodes.length > 1 ? count : node.type === "directory" ? `"${node.name}" folder` : `"${node.name}"`;
    return {
      title: trash ? `Move ${target} to Trash` : `Delete ${target}`,
      message,
      warning: warnings.join(" ") || undefined,
      confirmLabel: trash ? "Move to Trash" : "Delete",
      busyLabel: trash ? "Moving…" : "Deleting…",
      danger: true,
      failureMessage: trash ? "Failed to move to the Trash." : "Failed to delete.",
    };
  }

  // Async only because of the published-document pre-check.
  async function confirmDelete(nodes: readonly SpaceTreeNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const host = hostFor(nodes[0].path);
    if (!host) return;
    const token = ++deleteConfirmToken;
    const trash = deps.moveToTrash.get();
    const unpublishWarning = await host.removalWarning?.(nodes, trash);
    if (token !== deleteConfirmToken) return; // a newer delete request has since started

    let pendingUnpublish = 0;
    let failed: string[] = [];
    const deleted = await deps.dialog().confirm({
      ...removalPrompt(host, nodes, trash, unpublishWarning),
      action: async () => {
        pendingUnpublish = 0;
        failed = [];
        const removed: string[] = [];
        for (const node of nodes) {
          try {
            // The setting as read when the dialog opened, so the action is the one its labels name.
            const result = await postDeleteEntry(node.path, trash);
            removed.push(node.path);
            pendingUnpublish += result.pendingUnpublish;
          } catch (error) {
            if (nodes.length === 1) throw error;
            const reason =
              error instanceof Error ? error.message : trash ? "Failed to move to the Trash." : "Failed to delete.";
            failed.push(`${node.name}: ${reason}`);
          }
        }
        // With nothing gone the dialog stays open on why, to try again; with
        // some gone, it closes and the rest are reported after.
        if (removed.length === 0) throw new Error(failed.join("; "));
        await host.refresh();
        for (const path of removed) deps.onDeleted(path);
      },
    });
    if (!deleted) return;
    const notes: string[] = [];
    if (failed.length > 0) {
      const heading = trash ? "Couldn't move everything to the Trash." : "Couldn't delete everything.";
      notes.push(`${heading}\n\n${failed.join("\n")}`);
    }
    if (pendingUnpublish > 0) {
      notes.push(`${trash ? "Moved to the Trash." : "Deleted."} ${queuedUnpublishNote(pendingUnpublish)}`);
    }
    if (notes.length > 0) window.alert(notes.join("\n\n"));
  }

  async function trash(path: string): Promise<{ unpublishNote?: string } | undefined> {
    const host = hostFor(path);
    const node = host?.findEntry(path);
    const unpublishWarning = host && node && (await host.removalWarning?.([node], true));
    if (host && node && unpublishWarning) {
      if (!(await deps.dialog().confirm(removalPrompt(host, [node], true, unpublishWarning)))) return undefined;
    }
    const result = await postDeleteEntry(path, true);
    await host?.refresh();
    deps.onDeleted(path);
    return { unpublishNote: result.pendingUnpublish > 0 ? queuedUnpublishNote(result.pendingUnpublish) : undefined };
  }

  return {
    attach: (owns, host) => {
      hosts.push({ owns, host });
    },
    editing,
    startCreate,
    startRename,
    revealCreated,
    confirmDelete,
    trash,
    acceptDrag,
    dropInto,
  };
}
