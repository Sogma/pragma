// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLibraryRoot } from "../../../src/protocol/rootedPath.ts";
import { CLASS_EXTENSION, FLOW_EXTENSION, TABLE_EXTENSION } from "../../../src/protocol/types.ts";
import {
  type LibraryRow,
  postCreateEntry,
  postDeleteEntry,
  postDuplicateEntry,
  type SpaceTreeNode,
  type Tab,
} from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import { DRAGGED_ENTRY_TYPE, noteDragInFlight } from "../../../web/core/paths.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import type { ConfirmOptions, DialogService } from "../../../web/services/dialog.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { importDroppedFiles } from "../../../web/services/mediaImport.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createTreeActions, type TreeHost, type TreeTarget } from "../../../web/services/treeActions.ts";
import { fakeDrag } from "../support/drag.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/core/apiClient.ts")>()),
  postCreateEntry: vi.fn(async (parentPath: string, name: string, type: "file" | "directory") => ({
    path: parentPath ? `${parentPath}/${name}` : name,
    type,
  })),
  postDeleteEntry: vi.fn(async () => ({ pendingUnpublish: 0 })),
  postDuplicateEntry: vi.fn(async () => ({ path: "notes/a 2.md", type: "file" })),
  fetchFolderRows: vi.fn(async () => []),
}));

vi.mock("../../../web/services/mediaImport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/services/mediaImport.ts")>()),
  importDroppedFiles: vi.fn(async (files: readonly File[], dir: string) => ({
    imported: files.map((file) => `${dir}/${file.name}`),
    refused: [],
    failed: [],
    cancelled: false,
  })),
}));

const file = (path: string): SpaceTreeNode => ({ name: path.split("/").at(-1) ?? path, path, type: "file" });
const folder = (path: string, children: SpaceTreeNode[] = []): SpaceTreeNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type: "directory",
  children,
});

const note = file("notes/a.md");
const notes = folder("notes", [note, file("notes/b.md")]);
const other = folder("other", [file("other/c.md")]);
const listing = [notes, other];
// A library's tree lists a folder at a time, and answers in rooted paths.
const libraryNote = file("lib:one/notes/a.md");
const libraryNotes = folder("lib:one/notes", [libraryNote]);
const libraryListing = [libraryNotes, folder("lib:one/batch")];
const one = { library: "one" };

function find(nodes: readonly SpaceTreeNode[], path: string): SpaceTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const inside = node.children && find(node.children, path);
    if (inside) return inside;
  }
  return undefined;
}

const emptyContext: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const tabOn = (path: string): CommandContext => ({
  tab: { kind: "document", path, documentType: "note" } as Tab,
  pane: undefined,
});

// A dialog that answers the way the real one does: a confirm with an action
// runs it, stays open on a throw (then cancelled here), and resolves true once
// it succeeds. `confirmed` answers a confirm without one.
function harness(host: Partial<TreeHost> = {}, { confirmed = true, library = {} as Partial<TreeHost> } = {}) {
  const commands = createCommands();
  const menus = createMenus(commands);
  const keybindings = createKeybindings(commands);
  const thrown: unknown[] = [];
  const confirm = vi.fn(async (options: ConfirmOptions) => {
    if (!options.action) return confirmed;
    try {
      await options.action();
      return true;
    } catch (error) {
      thrown.push(error);
      return false;
    }
  });
  const trash = { on: true };
  const tree: TreeHost = {
    findEntry: (path) => find(listing, path),
    children: (path) => find(listing, path)?.children,
    hasRow: vi.fn(() => true),
    render: vi.fn(),
    refresh: vi.fn(async () => undefined),
    bringIntoView: vi.fn(),
    expand: vi.fn(),
    listsWhole: true,
    trashName: "the Trash",
    ...host,
  };
  const libraryTree: TreeHost = {
    findEntry: (path) => find(libraryListing, path),
    children: (path) => find(libraryListing, path)?.children,
    hasRow: vi.fn(() => true),
    render: vi.fn(),
    refresh: vi.fn(async () => undefined),
    bringIntoView: vi.fn(),
    expand: vi.fn(),
    listsWhole: false,
    trashName: "the .trash folder inside this library",
    ...library,
  };
  const deps = {
    commands,
    menus,
    keybindings,
    dialog: () => ({ confirm }) as unknown as DialogService,
    moveToTrash: { get: () => trash.on },
    open: vi.fn(async () => undefined),
    openBeside: vi.fn(async () => undefined),
    move: vi.fn(async (moves: readonly { from: string; to: string }[], refreshTree: () => Promise<unknown>) => {
      await refreshTree();
      return moves.map(({ to }) => ({ path: to }));
    }),
    onDeleted: vi.fn(),
    templateSources: () => [],
  };
  const actions = createTreeActions(deps);
  actions.attach((root) => root === "space", tree);
  actions.attach(isLibraryRoot, libraryTree);
  return { actions, tree, libraryTree, deps, commands, menus, confirm, thrown, trash };
}

const alert = vi.fn();
beforeEach(() => {
  vi.stubGlobal("alert", alert);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("creating", () => {
  it("opens the folder it is typed in, then draws the name field there", () => {
    const { actions, tree } = harness();
    actions.startCreate("notes", "file", "note");
    expect(tree.expand).toHaveBeenCalledWith("notes");
    expect(tree.render).toHaveBeenCalled();
    expect(actions.editing().pendingCreate).toEqual({ parentPath: "notes", type: "file", kind: "note" });
  });

  it("titles a note by a typed name no file can carry, and names the file from it", async () => {
    const { actions } = harness();
    actions.startCreate("notes", "file", "note");
    const { pendingCreate, onCreateSubmit } = actions.editing();
    if (!pendingCreate) throw new Error("no name field");
    onCreateSubmit(pendingCreate, "Part 1: Intro");
    await vi.waitFor(() =>
      expect(postCreateEntry).toHaveBeenCalledWith("notes", "Part 1 - Intro.md", "file", "# Part 1: Intro\n"),
    );
    expect(actions.editing().pendingCreate).toBeUndefined();
  });

  it("makes a note with a legal name as typed, trimmed, and nothing for an empty one", async () => {
    const { actions } = harness();
    actions.startCreate("notes", "file", "note");
    const { pendingCreate, onCreateSubmit } = actions.editing();
    if (!pendingCreate) throw new Error("no name field");
    onCreateSubmit(pendingCreate, "   ");
    onCreateSubmit(pendingCreate, "  Plain  ");
    await vi.waitFor(() => expect(postCreateEntry).toHaveBeenCalledWith("notes", "Plain", "file", undefined));
    expect(postCreateEntry).toHaveBeenCalledTimes(1);
  });

  it("gives a Table, a Flow and a Class their extensions", async () => {
    const { commands, actions } = harness();
    for (const [command, name] of [
      ["tree.newTable", "Shots"],
      ["tree.newFlow", "Run"],
      ["tree.newClass", "People"],
    ]) {
      commands.run(command, emptyContext, { node: notes } satisfies TreeTarget);
      const { pendingCreate, onCreateSubmit } = actions.editing();
      if (!pendingCreate) throw new Error("no name field");
      onCreateSubmit(pendingCreate, name);
    }
    await vi.waitFor(() => expect(postCreateEntry).toHaveBeenCalledTimes(3));
    const names = vi.mocked(postCreateEntry).mock.calls.map(([, name]) => name);
    expect(names).toEqual([`Shots${TABLE_EXTENSION}`, `Run${FLOW_EXTENSION}`, `People${CLASS_EXTENSION}`]);
  });

  it("opens the new file beside, but only once its tree drew a row for it", async () => {
    const drawn = harness();
    drawn.actions.startCreate("notes", "file", "note");
    const field = drawn.actions.editing();
    if (!field.pendingCreate) throw new Error("no name field");
    field.onCreateSubmit(field.pendingCreate, "New");
    await vi.waitFor(() => expect(drawn.deps.openBeside).toHaveBeenCalledWith("notes/New"));
    expect(drawn.tree.refresh).toHaveBeenCalled();

    const hidden = harness({ hasRow: () => false });
    hidden.actions.startCreate("notes", "file", "note");
    const unseen = hidden.actions.editing();
    if (!unseen.pendingCreate) throw new Error("no name field");
    unseen.onCreateSubmit(unseen.pendingCreate, "New");
    await vi.waitFor(() => expect(hidden.tree.refresh).toHaveBeenCalled());
    expect(hidden.deps.openBeside).not.toHaveBeenCalled();
  });

  it("creates in the focused file's folder when no row is named, bringing that folder into view", () => {
    const { commands, actions, tree } = harness();
    commands.run("tree.newNote", tabOn("notes/a.md"));
    expect(tree.bringIntoView).toHaveBeenCalledWith("notes");
    expect(actions.editing().pendingCreate).toEqual({ parentPath: "notes", type: "file", kind: "note" });
  });
});

describe("renaming", () => {
  it("draws the name field on the row, and moves the entry to the trimmed name", async () => {
    const { actions, deps } = harness();
    actions.startRename(note);
    expect(actions.editing().editingPath).toBe("notes/a.md");
    actions.editing().onRenameSubmit(note, "  b2.md ");
    expect(actions.editing().editingPath).toBeUndefined();
    await vi.waitFor(() =>
      expect(deps.move).toHaveBeenCalledWith([{ from: "notes/a.md", to: "notes/b2.md" }], expect.any(Function)),
    );
  });

  it("writes nothing for an emptied or unchanged name", async () => {
    const { actions, deps } = harness();
    actions.editing().onRenameSubmit(note, "   ");
    actions.editing().onRenameSubmit(note, "a.md");
    await Promise.resolve();
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("refuses a note name no file can carry, pointing at the heading", async () => {
    const { actions, deps } = harness();
    actions.editing().onRenameSubmit(note, "Part 1: Intro");
    await vi.waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toMatch(/A note's title can hold any text: edit its heading instead\.$/);
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("leaves a folder's name to the server's rule", async () => {
    const { actions, deps } = harness();
    actions.editing().onRenameSubmit(notes, "Part 1: Intro");
    await vi.waitFor(() =>
      expect(deps.move).toHaveBeenCalledWith([{ from: "notes", to: "Part 1: Intro" }], expect.any(Function)),
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it("renames the focused file from a key, bringing its row into view", () => {
    const { commands, actions, tree } = harness();
    expect(commands.get("tree.rename")?.when?.(tabOn("notes/a.md"), undefined)).toBe(true);
    expect(commands.get("tree.rename")?.when?.(tabOn("elsewhere.md"), undefined)).toBe(false);
    commands.run("tree.rename", tabOn("notes/a.md"));
    expect(tree.bringIntoView).toHaveBeenCalledWith("notes/a.md");
    expect(actions.editing().editingPath).toBe("notes/a.md");
  });
});

describe("duplicating", () => {
  it("opens the copy beside, then names it in place", async () => {
    const copy = file("notes/a 2.md");
    const { commands, actions, deps, tree } = harness({
      children: (path) => (path === "notes" ? [...(notes.children ?? []), copy] : undefined),
    });
    commands.run("tree.duplicate", emptyContext, { node: note } satisfies TreeTarget);
    await vi.waitFor(() => expect(actions.editing().editingPath).toBe("notes/a 2.md"));
    expect(postDuplicateEntry).toHaveBeenCalledWith("notes/a.md");
    expect(tree.refresh).toHaveBeenCalled();
    expect(deps.openBeside).toHaveBeenCalledWith("notes/a 2.md");
  });
});

describe("dropping", () => {
  const drop = (files: File[] = []) => fakeDrag("drop", { files }).event;

  it("imports desktop files into the folder, opening the last once its row is drawn", async () => {
    const { actions, deps, tree } = harness();
    const photo = new File(["x"], "photo.png");
    actions.editing().onDrop(drop([photo]), notes, "into");
    await vi.waitFor(() => expect(deps.open).toHaveBeenCalledWith("notes/photo.png"));
    expect(tree.expand).toHaveBeenCalledWith("notes");
    expect(vi.mocked(importDroppedFiles).mock.calls[0][1]).toBe("notes");
  });

  it("lets the tree's owner take a drop of its own before the rows' drag", () => {
    const takeDrop = vi.fn(() => true);
    const { actions, deps } = harness({ takeDrop });
    actions.editing().onDragStart([note]);
    actions.editing().onDrop(drop(), other, "into");
    expect(takeDrop).toHaveBeenCalledWith(expect.anything(), "other");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("moves only the entries not already in the folder dropped into", () => {
    const { actions, deps } = harness();
    actions.editing().onDragStart([note, file("other/c.md")]);
    actions.editing().onDrop(drop(), other, "into");
    expect(deps.move).toHaveBeenCalledWith([{ from: "notes/a.md", to: "other/a.md" }], expect.any(Function));
  });

  it("refuses a folder dropped into itself or below it, the whole drop", () => {
    const inner = folder("notes/inner");
    const { actions, deps } = harness();
    actions.editing().onDragStart([notes, file("other/c.md")]);
    actions.editing().onDrop(drop(), inner, "into");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("hands a before or after drop in the rows' own folder to the owner's reorder", () => {
    const reorder = vi.fn();
    const { actions, deps } = harness({ reorder });
    const b = file("notes/b.md");
    actions.editing().onDragStart([note]);
    actions.editing().onDrop(drop(), b, "after");
    expect(reorder).toHaveBeenCalledWith([note], b, "after");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("moves a drop on the empty area into the tree's top folder", () => {
    const { actions, deps } = harness();
    actions.editing().onDragStart([note]);
    actions.dropInto(drop(), "");
    expect(deps.move).toHaveBeenCalledWith([{ from: "notes/a.md", to: "a.md" }], expect.any(Function));
  });

  it("forgets a drag that ended without a drop", () => {
    const { actions, deps } = harness();
    actions.editing().onDragStart([note]);
    document.dispatchEvent(new Event("dragend"));
    actions.editing().onDrop(drop(), other, "into");
    expect(deps.move).not.toHaveBeenCalled();
  });
});

describe("deleting", () => {
  it("names a file and where it goes, after the trash setting", async () => {
    const { actions, confirm, trash } = harness();
    await actions.confirmDelete([note]);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Move "a.md" to Trash',
      message: "This file will be moved to the Trash.",
      confirmLabel: "Move to Trash",
      danger: true,
    });
    trash.on = false;
    await actions.confirmDelete([note]);
    expect(confirm.mock.calls[1][0]).toMatchObject({
      title: 'Delete "a.md"',
      message: "This permanently deletes the file. This cannot be undone.",
      confirmLabel: "Delete",
    });
  });

  it("warns what a folder holds, with the owner's own line after", async () => {
    const { actions, confirm } = harness({ removalWarning: async () => "It is published." });
    await actions.confirmDelete([notes]);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Move "notes" folder to Trash',
      warning:
        "This folder is not empty. If you continue, the 2 files inside this folder will be moved to the Trash too. It is published.",
    });
  });

  it("names the first ten of several, then how many more", async () => {
    const many = Array.from({ length: 12 }, (_, index) => file(`notes/${index}.md`));
    const { actions, confirm } = harness();
    await actions.confirmDelete(many);
    const { title, message } = confirm.mock.calls[0][0];
    expect(title).toBe("Move 12 Items to Trash");
    expect(message).toBe(
      `These 12 items will be moved to the Trash: ${many
        .slice(0, 10)
        .map((node) => `"${node.name}"`)
        .join(", ")} and 2 more.`,
    );
  });

  it("deletes the way the dialog said, re-lists, then lets go of each path", async () => {
    const { actions, tree, deps, trash } = harness();
    trash.on = false;
    await actions.confirmDelete([note]);
    expect(postDeleteEntry).toHaveBeenCalledWith("notes/a.md", false);
    expect(tree.refresh).toHaveBeenCalled();
    expect(deps.onDeleted).toHaveBeenCalledWith("notes/a.md");
  });

  it("closes once some are gone and reports the rest", async () => {
    vi.mocked(postDeleteEntry)
      .mockResolvedValueOnce({ path: "notes/a.md", pendingUnpublish: 0 })
      .mockRejectedValueOnce(new Error("nope"));
    const { actions, deps } = harness();
    await actions.confirmDelete([note, file("notes/b.md")]);
    expect(deps.onDeleted).toHaveBeenCalledWith("notes/a.md");
    expect(deps.onDeleted).not.toHaveBeenCalledWith("notes/b.md");
    expect(alert).toHaveBeenCalledWith("Couldn't move everything to the Trash.\n\nb.md: nope");
  });

  it("stays open on why when nothing went", async () => {
    vi.mocked(postDeleteEntry).mockRejectedValueOnce(new Error("locked")).mockRejectedValueOnce(new Error("locked"));
    const { actions, deps, thrown } = harness();
    await actions.confirmDelete([note, file("notes/b.md")]);
    expect(thrown).toHaveLength(1);
    expect(deps.onDeleted).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("counts a selection in its menu's one item", () => {
    const { menus } = harness();
    const selection = [note, file("notes/b.md"), file("other/c.md")];
    const [item] = menus.resolve("tree-selection", emptyContext, { node: note, selection } satisfies TreeTarget);
    expect(item.label).toBe("Move 3 Items to Trash");
  });

  it("moves to the Trash for chat's Undo, asking only when the owner warns", async () => {
    const plain = harness();
    expect(await plain.actions.trash("notes/a.md")).toEqual({ unpublishNote: undefined });
    expect(plain.confirm).not.toHaveBeenCalled();
    expect(postDeleteEntry).toHaveBeenCalledWith("notes/a.md", true);
    expect(plain.deps.onDeleted).toHaveBeenCalledWith("notes/a.md");

    vi.mocked(postDeleteEntry).mockClear();
    const warned = harness({ removalWarning: async () => "It is published." }, { confirmed: false });
    expect(await warned.actions.trash("notes/a.md")).toBeUndefined();
    expect(warned.confirm).toHaveBeenCalled();
    expect(postDeleteEntry).not.toHaveBeenCalled();
  });
});

// A library's tree runs the same actions on its own root: a writable one
// takes what the space does, less what only the space keeps.
describe("a library's tree", () => {
  const writable = { id: "one", label: "One", path: "/media/one", access: "read-write", missing: false };
  beforeEach(() => setLibraryPermissions([writable as LibraryRow]));
  afterEach(() => setLibraryPermissions([]));
  const onRow = (node: SpaceTreeNode | null, naming?: TreeTarget["naming"]): TreeTarget => ({
    root: one,
    node,
    naming,
  });

  it("offers the writes a writable library takes, and none on a read-only one", () => {
    const { commands, menus } = harness();
    const labels = (target: TreeTarget) => menus.resolve("tree", emptyContext, target).map((item) => item.label);
    expect(labels(onRow(libraryNotes))).toEqual([
      "New Note",
      "New Folder",
      "Rename…",
      "Add to Presets",
      "Move to Trash",
    ]);
    expect(labels(onRow(libraryNote))).toEqual(["Duplicate", "Rename…", "Move to Trash"]);
    for (const id of ["tree.newTable", "tree.newFlow", "tree.newClass"]) {
      expect(commands.isEnabled(id, emptyContext, onRow(libraryNotes)), id).toBe(false);
    }

    // Adding a folder to Presets writes the space's list, not the library.
    setLibraryPermissions([{ ...writable, access: "read-only" } as LibraryRow]);
    expect(labels(onRow(libraryNotes))).toEqual(["Add to Presets"]);
  });

  it("names the library's own trash, and what a folder holds without a count", async () => {
    const { actions, confirm, trash } = harness();
    await actions.confirmDelete([libraryNote]);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Move "a.md" to Trash',
      message: "This file will be moved to the .trash folder inside this library.",
    });
    await actions.confirmDelete([libraryNotes]);
    expect(confirm.mock.calls[1][0]).toMatchObject({
      title: 'Move "notes" folder to Trash',
      message: "This folder will be moved to the .trash folder inside this library.",
      warning: "Everything inside it will be moved too.",
    });
    trash.on = false;
    await actions.confirmDelete([libraryNotes]);
    expect(confirm.mock.calls[2][0]).toMatchObject({ warning: "Everything inside it will be deleted." });
  });

  it("deletes several from the Delete key, naming them and the library's trash", async () => {
    const { actions, confirm, deps } = harness();
    actions.editing(one).onDelete?.([file("notes/a.md"), folder("batch")]);
    await vi.waitFor(() => expect(deps.onDeleted).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: "Move 2 Items to Trash",
      message: 'These 2 items will be moved to the .trash folder inside this library: "a.md" and "batch".',
      warning: "Everything inside the folder among them will be moved too.",
    });
    expect(postDeleteEntry).toHaveBeenCalledWith("lib:one/batch", true);
  });

  it("picks one row at a time in a library that takes no writes", () => {
    const { actions } = harness();
    expect(actions.editing(one)).toMatchObject({ selectsMany: true });
    setLibraryPermissions([{ ...writable, access: "read-only" } as LibraryRow]);
    expect(actions.editing(one)).toMatchObject({ selectsMany: false, onDelete: undefined });
  });

  it("deletes into the library, re-lists its tree, then lets go of the path", async () => {
    const { actions, libraryTree, tree, deps } = harness();
    await actions.confirmDelete([libraryNote]);
    expect(postDeleteEntry).toHaveBeenCalledWith("lib:one/notes/a.md", true);
    expect(libraryTree.refresh).toHaveBeenCalled();
    expect(tree.refresh).not.toHaveBeenCalled();
    expect(deps.onDeleted).toHaveBeenCalledWith("lib:one/notes/a.md");
  });

  it("roots the nodes its tree hands over, for a rename and a drop", async () => {
    const { actions, libraryTree, deps } = harness();
    const editing = actions.editing(one);
    editing.onRenameSubmit(file("notes/a.md"), "b.md");
    await vi.waitFor(() =>
      expect(deps.move).toHaveBeenCalledWith(
        [{ from: "lib:one/notes/a.md", to: "lib:one/notes/b.md" }],
        expect.any(Function),
      ),
    );
    expect(libraryTree.refresh).toHaveBeenCalled();

    editing.onDragStart([file("notes/a.md")]);
    editing.onDrop(fakeDrag("drop").event, folder("batch"), "into");
    expect(deps.move).toHaveBeenLastCalledWith(
      [{ from: "lib:one/notes/a.md", to: "lib:one/batch/a.md" }],
      expect.any(Function),
    );
  });

  it("draws the name field in the library's tree, and leaves the space's", () => {
    const { actions, tree, libraryTree } = harness();
    actions.startRename(note);
    expect(tree.render).toHaveBeenCalledTimes(1);
    actions.startCreate("lib:one/notes", "file", "note");
    expect(libraryTree.expand).toHaveBeenCalledWith("lib:one/notes");
    expect(tree.render).toHaveBeenCalledTimes(2);
    expect(libraryTree.render).toHaveBeenCalledTimes(1);
    expect(actions.editing(one)).toMatchObject({
      editingPath: undefined,
      pendingCreate: { parentPath: "lib:one/notes", type: "file", kind: "note" },
    });
  });

  it("titles a note typed in its tree by a name no file can carry, and opens it once drawn", async () => {
    const { actions, deps } = harness();
    actions.startCreate("lib:one/notes", "file", "note");
    const { pendingCreate, onCreateSubmit } = actions.editing(one);
    if (!pendingCreate) throw new Error("no name field");
    onCreateSubmit(pendingCreate, "Part 1: Intro");
    await vi.waitFor(() => expect(deps.openBeside).toHaveBeenCalledWith("lib:one/notes/Part 1 - Intro.md"));
    expect(postCreateEntry).toHaveBeenCalledWith("lib:one/notes", "Part 1 - Intro.md", "file", "# Part 1: Intro\n");
  });

  it("refuses a note name no file can carry, pointing at the heading", async () => {
    const { actions, deps } = harness();
    actions.editing(one).onRenameSubmit(file("notes/a.md"), "Part 1: Intro");
    await vi.waitFor(() => expect(alert).toHaveBeenCalled());
    expect(deps.move).not.toHaveBeenCalled();
  });

  // A tile's name is typed on the tile, and the library's tree may not list
  // that folder, so the file opens wherever it landed.
  it("types a rename or a create on the surface that opened the menu, and opens what it made", async () => {
    const { commands, deps } = harness();
    const naming = { rename: vi.fn(), create: vi.fn() };
    await commands.run("tree.rename", emptyContext, onRow(libraryNote, naming));
    expect(naming.rename).toHaveBeenCalledWith("lib:one/notes/a.md", expect.any(Function));
    naming.rename.mock.calls[0][1]("b.md");
    await vi.waitFor(() =>
      expect(deps.move).toHaveBeenCalledWith(
        [{ from: "lib:one/notes/a.md", to: "lib:one/notes/b.md" }],
        expect.any(Function),
      ),
    );

    await commands.run("tree.newNote", emptyContext, onRow(folder("lib:one/far"), naming));
    expect(naming.create).toHaveBeenCalledWith(
      { parentPath: "lib:one/far", type: "file", kind: "note" },
      expect.any(Function),
    );
    naming.create.mock.calls[0][1]("take");
    await vi.waitFor(() => expect(deps.openBeside).toHaveBeenCalledWith("lib:one/far/take"));
  });

  // The setting is the server's and can change while a confirmation is open:
  // the delete does what that confirmation said.
  it("deletes the way the confirmation said, even if the setting changed meanwhile", async () => {
    const { actions, confirm, trash } = harness();
    confirm.mockImplementationOnce(async (options: ConfirmOptions) => {
      trash.on = false;
      await options.action?.();
      return true;
    });
    await actions.confirmDelete([libraryNote]);
    expect(postDeleteEntry).toHaveBeenCalledWith("lib:one/notes/a.md", true);
  });

  it("lets go of no path when the delete itself failed", async () => {
    vi.mocked(postDeleteEntry).mockRejectedValueOnce(new Error("Not found"));
    const { actions, deps, thrown } = harness();
    await actions.confirmDelete([libraryNote]);
    expect(thrown).toHaveLength(1);
    expect(deps.onDeleted).not.toHaveBeenCalled();
  });

  it("lists Duplicate, then Rename… directly above Bookmark, in one group", () => {
    const { commands, menus } = harness();
    commands.register({ id: "bookmarks.add", label: "Bookmark", run: vi.fn() });
    const items = menus.resolve("tree", emptyContext, onRow(libraryNote));
    expect(items.map((item) => [item.label, item.group])).toEqual([
      ["Duplicate", "bookmark"],
      ["Rename…", "bookmark"],
      ["Bookmark", "bookmark"],
      ["Move to Trash", "delete"],
    ]);
  });

  it("duplicates a library's file, opens the copy beside, then names it in place", async () => {
    vi.mocked(postDuplicateEntry).mockResolvedValueOnce({ path: "lib:one/notes/a 2.md", type: "file" });
    const copy = file("lib:one/notes/a 2.md");
    const { commands, actions, deps, libraryTree } = harness(
      {},
      { library: { children: (path) => (path === "lib:one/notes" ? [libraryNote, copy] : undefined) } },
    );
    await commands.run("tree.duplicate", emptyContext, onRow(libraryNote));
    await vi.waitFor(() => expect(actions.editing(one).editingPath).toBe("lib:one/notes/a 2.md"));
    expect(postDuplicateEntry).toHaveBeenCalledWith("lib:one/notes/a.md");
    expect(libraryTree.refresh).toHaveBeenCalled();
    expect(deps.openBeside).toHaveBeenCalledWith("lib:one/notes/a 2.md");
  });

  // A tile's folder may be one the library's tree hasn't listed.
  it("names a copy on the surface that asked, listed or not", async () => {
    vi.mocked(postDuplicateEntry).mockResolvedValueOnce({ path: "lib:one/far/x 2.md", type: "file" });
    const { commands } = harness({}, { library: { findEntry: () => undefined } });
    const naming = { rename: vi.fn(), create: vi.fn() };
    await commands.run("tree.duplicate", emptyContext, onRow(file("lib:one/far/x.md"), naming));
    await vi.waitFor(() => expect(naming.rename).toHaveBeenCalledWith("lib:one/far/x 2.md", expect.any(Function)));
  });

  it("keeps a row dragged from one root out of another's tree", () => {
    const { actions, deps } = harness();
    actions.editing(one).onDragStart([file("notes/a.md")]);
    actions.editing().onDrop(fakeDrag("drop").event, other, "into");
    actions.editing().onDragStart([note]);
    actions.editing(one).onDrop(fakeDrag("drop").event, folder("batch"), "into");
    expect(deps.move).not.toHaveBeenCalled();
  });
});

describe("an entry another surface drags", () => {
  // A gallery tile writes its rooted path and kind, as a tree row does.
  function tileDrop(path: string, own = true): DragEvent {
    const { event } = fakeDrag("drop", { data: { "text/plain": path, [DRAGGED_ENTRY_TYPE]: "file" } });
    if (own) noteDragInFlight(path);
    return event;
  }
  afterEach(() => noteDragInFlight(undefined));

  it("moves into the folder of the space tree it is dropped on", () => {
    const { actions, deps } = harness();
    actions.editing().onDrop(tileDrop("notes/a.md"), other, "into");
    expect(deps.move).toHaveBeenCalledWith([{ from: "notes/a.md", to: "other/a.md" }], expect.any(Function));
  });

  it("never moves for text that only reads as a path", () => {
    const { actions, deps } = harness();
    actions.editing().onDrop(tileDrop("notes/a.md", false), other, "into");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("stays out of another root's tree", () => {
    const { actions, deps } = harness();
    actions.editing().onDrop(tileDrop("lib:one/notes/a.md"), other, "into");
    expect(deps.move).not.toHaveBeenCalled();
  });
});

// F2, the palette and the menu bar hand no row: the focused tab's file
// stands in, a library's as the space's, wherever its library can write.
describe("a key on a library's tab", () => {
  const writable = { id: "one", label: "One", path: "/media/one", access: "read-write", missing: false };
  beforeEach(() => setLibraryPermissions([writable as LibraryRow]));
  afterEach(() => setLibraryPermissions([]));
  const tabOf = (kind: "document" | "gallery", path: string): CommandContext => ({
    tab: (kind === "gallery" ? { kind, path } : { kind, path, documentType: "note" }) as Tab,
    pane: undefined,
  });

  it("renames the tab's file in its library's tree, bringing the row up", async () => {
    const { commands, actions, libraryTree } = harness();
    const context = tabOf("document", "lib:one/notes/a.md");
    expect(commands.get("tree.rename")?.when?.(context, undefined)).toBe(true);
    await commands.run("tree.rename", context);
    expect(libraryTree.bringIntoView).toHaveBeenCalledWith("lib:one/notes/a.md");
    expect(actions.editing(one).editingPath).toBe("lib:one/notes/a.md");
  });

  it("trashes the tab's file though the library's tree hasn't listed it", async () => {
    const { commands, confirm, deps } = harness({}, { library: { findEntry: () => undefined } });
    await commands.run("tree.delete", tabOf("document", "lib:one/far/x.md"));
    await vi.waitFor(() => expect(deps.onDeleted).toHaveBeenCalledWith("lib:one/far/x.md"));
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Move "x.md" to Trash' });
    expect(postDeleteEntry).toHaveBeenCalledWith("lib:one/far/x.md", true);
  });

  it("offers neither for a read-only library's tab, nor for a folder's", () => {
    const { commands } = harness();
    for (const id of ["tree.rename", "tree.delete"]) {
      expect(commands.get(id)?.when?.(tabOf("gallery", "lib:one/notes"), undefined), id).toBe(false);
    }
    setLibraryPermissions([{ ...writable, access: "read-only" } as LibraryRow]);
    for (const id of ["tree.rename", "tree.delete"]) {
      expect(commands.get(id)?.when?.(tabOf("document", "lib:one/notes/a.md"), undefined), id).toBe(false);
    }
  });

  it("makes a key's new note at the space's top, as before", async () => {
    const { commands, actions, tree } = harness();
    await commands.run("tree.newNote", tabOf("document", "lib:one/notes/a.md"));
    expect(tree.bringIntoView).toHaveBeenCalledWith("");
    expect(actions.editing().pendingCreate).toEqual({ parentPath: "", type: "file", kind: "note" });
  });
});
