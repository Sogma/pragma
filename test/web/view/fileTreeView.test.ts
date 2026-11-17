// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceTreeNode } from "../../../web/core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE, SELECTION_DRAG_TYPE, TRASH_DRAG_TYPE } from "../../../web/core/paths.ts";
import { createTreeView, type TreeRenderContext, type TreeView } from "../../../web/view/fileTreeView.ts";
import { createActiveRowMarker } from "../../../web/view/treeRows.ts";

function baseCtx(overrides: Partial<TreeRenderContext> = {}): TreeRenderContext {
  return {
    onOpen: vi.fn(),
    onOpenDirectory: vi.fn(),
    onContextMenu: vi.fn(),
    onDragStart: vi.fn(),
    onDrop: vi.fn(),
    isCollapsed: () => false,
    onToggleCollapse: vi.fn(),
    showExtensions: false,
    editingPath: undefined,
    onRenameSubmit: vi.fn(),
    onRenameCancel: vi.fn(),
    pendingCreate: undefined,
    onCreateSubmit: vi.fn(),
    onCreateCancel: vi.fn(),
    ...overrides,
  };
}

// The active-tab highlight as a tree reads it, on `path`, marking nothing on
// any page.
function activeAt(path: string) {
  const marker = createActiveRowMarker(document.createElement("div"));
  marker.set(path);
  return marker;
}

// One tree, drawn once: what most behavior below needs.
function drawTree(nodes: SpaceTreeNode[], listPath: string, ctx: TreeRenderContext): HTMLUListElement {
  const tree = createTreeView(listPath);
  tree.render(nodes, ctx);
  return tree.element;
}

const FILE: SpaceTreeNode = { name: "note.md", path: "note.md", type: "file" };
const DIR: SpaceTreeNode = {
  name: "projects",
  path: "projects",
  type: "directory",
  sortable: true,
  children: [{ name: "a.md", path: "projects/a.md", type: "file" }],
};
const NESTED: SpaceTreeNode = {
  name: "a",
  path: "a",
  type: "directory",
  children: [
    { name: "b", path: "a/b", type: "directory", children: [{ name: "c.md", path: "a/b/c.md", type: "file" }] },
  ],
};

describe("createTreeView — basic structure", () => {
  it("renders one flat row per listed entry, with the right type class", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    const items = list.querySelectorAll(":scope > li.tree-row");
    expect([...items].map((item) => item.querySelector<HTMLElement>(".node-label")?.dataset.path)).toEqual([
      "note.md",
      "projects",
      "projects/a.md",
    ]);
    expect(items[0].className).toContain("file");
    expect(items[1].className).toContain("directory");
  });

  it("hides the extension by default and shows it when showExtensions is true", () => {
    const hidden = drawTree([FILE], "", baseCtx({ showExtensions: false }));
    expect(hidden.querySelector(".node-label")?.textContent).toBe("note");

    const shown = drawTree([FILE], "", baseCtx({ showExtensions: true }));
    expect(shown.querySelector(".node-label")?.textContent).toBe("note.md");
  });

  it("keeps the extension on a file Pragma can't open, and says it can't", () => {
    const other: SpaceTreeNode = { name: "budget.csv", path: "budget.csv", type: "file" };
    const list = drawTree([FILE, other], "", baseCtx({ showExtensions: false, editingPath: undefined }));
    const [note, csv] = list.querySelectorAll<HTMLElement>(":scope > li.tree-row");
    expect(csv.classList.contains("cant-open")).toBe(true);
    expect(csv.querySelector(".node-label")?.textContent).toBe("budget.csv");
    expect(csv.querySelector<HTMLElement>(".node-label")?.dataset.tooltip).toBe("Pragma can't open this file");
    expect(note.classList.contains("cant-open")).toBe(false);
    expect(note.querySelector<HTMLElement>(".node-label")?.dataset.tooltip).toBeUndefined();

    const renaming = drawTree([other], "", baseCtx({ editingPath: "budget.csv" }));
    expect(renaming.querySelector("input")?.value).toBe("budget.csv");
  });

  it("marks a collapsed directory and draws nothing inside it", () => {
    const collapsed = drawTree([DIR], "", baseCtx({ isCollapsed: (path) => path === "projects" }));
    expect(collapsed.querySelector("li.directory")?.className).toContain("collapsed");
    expect(collapsed.querySelector(".node-label")?.textContent).toBe("projects");
    expect(collapsed.querySelectorAll(".node-label")).toHaveLength(1);
  });

  it("draws an open directory's children after it, one step deeper", () => {
    const open = drawTree([DIR], "", baseCtx());
    const [folder, child] = open.querySelectorAll<HTMLElement>(":scope > li.tree-row");
    expect(child.querySelector(".node-label")?.textContent).toBe("a");
    expect(folder.style.getPropertyValue("--depth")).toBe("0");
    expect(child.style.getPropertyValue("--depth")).toBe("1");
  });

  it("gives each row one indent guide per folder above it, and redraws none", () => {
    const tree = createTreeView("");
    const guides = () =>
      [...tree.element.querySelectorAll(":scope > li.tree-row")].map(
        (item) => item.querySelectorAll(":scope > .tree-guides > span").length,
      );
    tree.render([NESTED], baseCtx());
    expect(guides()).toEqual([0, 1, 2]);
    tree.render([NESTED], baseCtx());
    expect(guides()).toEqual([0, 1, 2]);
  });

  it("names each guide for its folder, rooted, and darkens the open file's", () => {
    const tree = createTreeView("lib:footage", { active: activeAt("lib:footage/a/b/c.md") });
    tree.render([NESTED], baseCtx({ root: { library: "footage" } }));
    const row = tree.element.querySelector('.node-label[data-path="lib:footage/a/b/c.md"]')?.parentElement;
    const lines = [...(row?.querySelectorAll<HTMLElement>(":scope > .tree-guides > span") ?? [])];
    expect(lines.map((line) => line.dataset.folder)).toEqual(["lib:footage/a", "lib:footage/a/b"]);
    expect(lines.map((line) => line.classList.contains("active"))).toEqual([false, true]);
  });

  it("adds a sort badge for a sortable directory", () => {
    const list = drawTree([DIR], "", baseCtx());
    expect(list.querySelector(".node-sort-badge")).not.toBeNull();
  });

  // The badge marks the folder's own order, the one the tree lists, in the
  // words of its Sort by row, whenever that isn't by name from A.
  it("badges a folder's own order unless it is by name from A, naming it", () => {
    const badgeOf = (folder: SpaceTreeNode) =>
      drawTree([folder], "", baseCtx({ isCollapsed: () => true })).querySelector<HTMLElement>(".node-sort-badge")
        ?.dataset.tooltip;
    const plain: SpaceTreeNode = { ...DIR, sortable: false };
    expect(badgeOf(DIR)).toBe("Manual order");
    expect(badgeOf({ ...plain, sort: { by: "property", property: "date", order: "desc" } })).toBe(
      "Sorted by date (descending)",
    );
    expect(badgeOf({ ...plain, sort: { by: "modified", order: "desc" } })).toBe("Sorted by date modified (descending)");
    expect(badgeOf({ ...plain, sort: { by: "name", order: "desc" } })).toBe("Sorted by name (descending)");
    expect(badgeOf({ ...plain, sort: { by: "name", order: "asc" } })).toBeUndefined();
    expect(badgeOf(plain)).toBeUndefined();
  });

  it("draws a folder's icon, and a site root's globe in its place", () => {
    const site: SpaceTreeNode = { name: "blog", path: "blog", type: "directory", children: [], site: { name: "Blog" } };
    const list = drawTree([DIR, site, FILE], "", baseCtx({ isCollapsed: () => true }));
    const icons = list.querySelectorAll<HTMLElement>(":scope > li > .node-label > .node-icon");
    expect([...icons].map((icon) => icon.dataset.entryIcon)).toEqual(["folder", "site", "markdown"]);
  });

  it("names a file's kind on its icon, and leaves a plain file's and a plain folder's without one", () => {
    const flow: SpaceTreeNode = { name: "plot.flow.html", path: "plot.flow.html", type: "file" };
    const plain: SpaceTreeNode = { name: "todo.txt", path: "todo.txt", type: "file" };
    const list = drawTree([flow, FILE, plain, DIR], "", baseCtx({ isCollapsed: () => true }));
    const icons = list.querySelectorAll<HTMLElement>(":scope > li > .node-label > .node-icon");
    expect([...icons].map((icon) => icon.dataset.tooltip)).toEqual(["Flow", "Note", undefined, undefined]);
  });
});

describe("createTreeView — interaction callbacks", () => {
  it("calls onOpen with the file's path when a file label is clicked", () => {
    const ctx = baseCtx();
    const list = drawTree([FILE], "", ctx);
    (list.querySelector(".node-label") as HTMLElement).click();
    expect(ctx.onOpen).toHaveBeenCalledWith("note.md", expect.any(HTMLElement));
  });

  it("toggles the collapsed class and calls onToggleCollapse when a directory label is clicked", () => {
    const ctx = baseCtx();
    const list = drawTree([DIR], "", ctx);
    const dirLabel = list.querySelector(".node-label") as HTMLElement;
    dirLabel.click();
    expect(list.querySelector("li.directory")?.className).toContain("collapsed");
    expect(list.querySelectorAll(".node-label")).toHaveLength(1);
    expect(ctx.onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(ctx.onToggleCollapse).toHaveBeenCalledWith("projects", true);
    dirLabel.click();
    expect(ctx.onToggleCollapse).toHaveBeenLastCalledWith("projects", false);
    expect(list.querySelectorAll(".node-label")).toHaveLength(2);
  });

  it("toggles a folder a shallow read didn't list, onto a loading line, never opening it as a file", () => {
    const ctx = baseCtx();
    const unlisted: SpaceTreeNode = { name: "shots", path: "shots", type: "directory" };
    const list = drawTree([unlisted], "", ctx);
    expect(list.querySelector("li.tree-row > .tree-loading")?.textContent).toBe("Loading…");

    (list.querySelector(".node-label") as HTMLElement).click();
    expect(ctx.onToggleCollapse).toHaveBeenCalledWith("shots", true);
    expect(ctx.onOpen).not.toHaveBeenCalled();
  });

  // A folder's Open button opens it, so reaching a file inside one never
  // replaces the tab being read.
  it("only folds a folder on a click, whatever its order", () => {
    const byName: SpaceTreeNode = { ...DIR, sortable: false };
    for (const folder of [DIR, byName]) {
      const ctx = baseCtx();
      drawTree([folder], "", ctx).querySelector<HTMLElement>(".node-label")?.click();
      expect(ctx.onToggleCollapse).toHaveBeenCalledWith("projects", true);
      expect(ctx.onOpenDirectory).not.toHaveBeenCalled();
    }
  });

  it("draws an Open button on a folder's row, only in a tree that can open one", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(".node-open")];
    expect(buttons.map((button) => button.closest<HTMLElement>(".node-label")?.dataset.path)).toEqual(["projects"]);
    expect(buttons[0].getAttribute("aria-label")).toBe("Open gallery");
    expect(buttons[0].tabIndex).toBe(-1);

    const unopenable = drawTree([DIR], "", baseCtx({ onOpenDirectory: undefined }));
    expect(unopenable.querySelector(".node-open")).toBeNull();
  });

  it("opens the folder from its Open button, and folds nothing and moves no cursor", () => {
    const ctx = baseCtx();
    const list = drawTree([FILE, DIR], "", ctx);
    list.querySelector<HTMLElement>('[data-path="note.md"]')?.click();

    list.querySelector<HTMLElement>(".node-open")?.click();
    expect(ctx.onOpenDirectory).toHaveBeenCalledWith("projects");
    expect(ctx.onToggleCollapse).not.toHaveBeenCalled();
    expect(list.querySelectorAll(".node-label")).toHaveLength(3);
    expect(list.querySelector<HTMLElement>(".node-label.cursor")?.dataset.path).toBe("note.md");
  });

  it("keeps a press on the Open button from taking focus or starting a drag", () => {
    const list = drawTree([DIR], "", baseCtx());
    const press = (target: Element | null) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target?.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(list.querySelector(".node-open"))).toBe(true);
    expect(press(list.querySelector(".node-name"))).toBe(false);
  });

  it("calls onContextMenu on right-click", () => {
    const ctx = baseCtx();
    const list = drawTree([FILE], "", ctx);
    const label = list.querySelector(".node-label") as HTMLElement;
    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(ctx.onContextMenu).toHaveBeenCalledWith(expect.any(MouseEvent), FILE);
  });
});

describe("createTreeView — inline rename", () => {
  it("swaps the label for an input pre-filled with the stripped name when editingPath matches", () => {
    const list = drawTree([FILE], "", baseCtx({ editingPath: "note.md" }));
    const input = list.querySelector(".node-label input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("note");
  });

  it("pre-fills the full name (no strip) when showExtensions is true", () => {
    const list = drawTree([FILE], "", baseCtx({ editingPath: "note.md", showExtensions: true }));
    const input = list.querySelector(".node-label input") as HTMLInputElement;
    expect(input.value).toBe("note.md");
  });

  it("re-appends the stripped extension on rename submit when extensions are hidden", () => {
    const ctx = baseCtx({ editingPath: "note.md", showExtensions: false });
    const list = drawTree([FILE], "", ctx);
    const input = list.querySelector(".node-label input") as HTMLInputElement;
    input.value = "renamed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ctx.onRenameSubmit).toHaveBeenCalledWith(FILE, "renamed.md");
  });

  it("calls onRenameCancel on Escape", () => {
    const ctx = baseCtx({ editingPath: "note.md" });
    const list = drawTree([FILE], "", ctx);
    const input = list.querySelector(".node-label input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(ctx.onRenameCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps a folder's icon before its rename input", () => {
    const list = drawTree([DIR], "", baseCtx({ editingPath: "projects" }));
    const label = list.querySelector('[data-path="projects"]');
    expect([...(label?.children ?? [])].map((child) => child.className || child.tagName)).toEqual([
      "node-icon",
      "INPUT",
    ]);
  });
});

describe("createTreeView — pending create row", () => {
  it("renders a create row as the first child when pendingCreate matches this list's parentPath", () => {
    const ctx = baseCtx({ pendingCreate: { parentPath: "", type: "file" } });
    const list = drawTree([FILE], "", ctx);
    const first = list.querySelector(":scope > li:first-child");
    expect(first?.querySelector("input")).not.toBeNull();
    expect(first?.querySelector("input")?.placeholder).toBe("Note name");
  });

  it("does not render a create row for a different directory's list", () => {
    const ctx = baseCtx({ pendingCreate: { parentPath: "projects", type: "file" } });
    const list = drawTree([FILE], "", ctx);
    expect(list.querySelector("input")).toBeNull();
  });

  it("submits the create with the typed name on Enter", () => {
    const ctx = baseCtx({ pendingCreate: { parentPath: "", type: "directory" } });
    const list = drawTree([], "", ctx);
    const input = list.querySelector("input") as HTMLInputElement;
    input.value = "New Folder";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ctx.onCreateSubmit).toHaveBeenCalledWith({ parentPath: "", type: "directory" }, "New Folder");
  });

  it("gives a new folder's row the icon a folder's row has", () => {
    const list = drawTree([], "", baseCtx({ pendingCreate: { parentPath: "", type: "directory" } }));
    expect(list.querySelector(":scope > li.directory > .node-label > .node-icon + input")).not.toBeNull();
  });

  it("gives a copy of a template its template's kind, and asks by the template's name", () => {
    const template = { path: "_templates/Screenplay/Scene.fountain", label: "Scene" };
    const list = drawTree([], "", baseCtx({ pendingCreate: { parentPath: "", type: "file", template } }));
    const input = list.querySelector<HTMLInputElement>(":scope > li.file.fountain > .node-label > .node-icon + input");
    expect(input?.placeholder).toBe("Scene name");
  });
});

// Dragging a row out is a read, so it survives readOnly — and the payload
// is what keeps a foreign root from being mistaken for a space path
// downstream. Asking for a row's menu is a read too; what it offers is the
// context's to decide.
describe("createTreeView — drag source", () => {
  // jsdom implements neither DragEvent nor DataTransfer, so both are stood
  // up by hand — enough of one to record what the handler wrote.
  function fakeTransfer(): { data: Map<string, string>; effectAllowed: string } {
    const data = new Map<string, string>();
    return {
      data,
      effectAllowed: "",
      setData(type: string, value: string) {
        data.set(type, value);
      },
      getData: (type: string) => data.get(type) ?? "",
    } as unknown as { data: Map<string, string>; effectAllowed: string };
  }

  function dispatchDrag(label: Element, type: string): { data: Map<string, string>; effectAllowed: string } {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = fakeTransfer();
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    label.dispatchEvent(event);
    return dataTransfer;
  }

  function labelOf(ctx: TreeRenderContext, node: SpaceTreeNode = FILE): HTMLElement {
    return drawTree([node], "", ctx).querySelector(".node-label") as HTMLElement;
  }

  it("puts a space row's own path on the drag, and calls it a move", () => {
    const label = labelOf(baseCtx());
    expect(label.draggable).toBe(true);
    const dataTransfer = dispatchDrag(label, "dragstart");
    expect(dataTransfer.data.get("text/plain")).toBe("note.md");
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("sends a library tree's rooted path, as a copy rather than a move", () => {
    const label = labelOf(baseCtx({ readOnly: true, root: { library: "footage" } }));
    expect(label.draggable).toBe(true);
    const dataTransfer = dispatchDrag(label, "dragstart");
    // The rooted spelling, not the library-relative path the node carries:
    // bare, it would name a space file that was never there.
    expect(dataTransfer.data.get("text/plain")).toBe("lib:footage/note.md");
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  // Nothing but its own tree can read the drag, so a template row lands only
  // among the templates.
  it("puts no path on a confined tree's drag", () => {
    const dataTransfer = dispatchDrag(labelOf(baseCtx({ confinedDrags: true })), "dragstart");
    expect([...dataTransfer.data.keys()]).toEqual(["application/x-pragma-confined-entry"]);
  });

  it("drops a confined drag only on a confined tree, which takes nothing else but files", () => {
    const dropOn = (ctx: TreeRenderContext, types: string[]) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types, files: [] } });
      labelOf(ctx).dispatchEvent(event);
      return ctx.onDrop;
    };
    const confined = "application/x-pragma-confined-entry";
    expect(dropOn(baseCtx(), [confined])).not.toHaveBeenCalled();
    expect(dropOn(baseCtx(), ["text/plain"])).toHaveBeenCalled();
    expect(dropOn(baseCtx({ confinedDrags: true }), ["text/plain"])).not.toHaveBeenCalled();
    expect(dropOn(baseCtx({ confinedDrags: true }), [confined])).toHaveBeenCalled();
    expect(dropOn(baseCtx({ confinedDrags: true }), ["Files"])).toHaveBeenCalled();
    // A picture dragged from Pragma brings a copy of its bytes, but is an entry's drag.
    expect(dropOn(baseCtx({ confinedDrags: true }), ["Files", DRAGGED_ENTRY_TYPE])).not.toHaveBeenCalled();
    // A Trash row lands in the space tree, never among the templates.
    expect(dropOn(baseCtx(), [TRASH_DRAG_TYPE])).toHaveBeenCalled();
    expect(dropOn(baseCtx({ confinedDrags: true }), [TRASH_DRAG_TYPE])).not.toHaveBeenCalled();
  });

  it("keeps a read-only row out of the drop path, and still reports a right-click", () => {
    const ctx = baseCtx({ readOnly: true, root: { library: "footage" } });
    const label = labelOf(ctx);
    dispatchDrag(label, "drop");
    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(ctx.onDrop).not.toHaveBeenCalled();
    expect(ctx.onContextMenu).toHaveBeenCalledWith(expect.any(MouseEvent), FILE);
  });

  describe("several rows selected", () => {
    const OTHER: SpaceTreeNode = { name: "other.md", path: "other.md", type: "file" };
    const at = (list: HTMLElement, path: string) =>
      list.querySelector<HTMLElement>(`.node-label[data-path="${path}"]`) as HTMLElement;
    function selecting(paths: string[]): { list: HTMLElement; ctx: TreeRenderContext } {
      const ctx = baseCtx({ selectsMany: true });
      const list = drawTree([DIR, FILE, OTHER], "", ctx);
      for (const path of paths) {
        at(list, path).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      }
      return { list, ctx };
    }
    function over(label: HTMLElement, type: "dragover" | "drop"): Event & { dataTransfer: { dropEffect: string } } {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: [SELECTION_DRAG_TYPE], files: [], dropEffect: "" },
      });
      label.dispatchEvent(event);
      return event as Event & { dataTransfer: { dropEffect: string } };
    }

    // Each would take one path and drop the rest without a word.
    it("carries every selected row, less one inside a selected folder, with no path for a note or canvas", () => {
      const { list, ctx } = selecting(["projects", "projects/a.md", "note.md"]);
      const dataTransfer = dispatchDrag(at(list, "note.md"), "dragstart");
      expect(ctx.onDragStart).toHaveBeenCalledWith([DIR, FILE]);
      expect([...dataTransfer.data.keys()]).toEqual([SELECTION_DRAG_TYPE]);
      expect(dataTransfer.effectAllowed).toBe("move");
    });

    it("shows how many by the pointer", () => {
      const { list } = selecting(["note.md", "other.md"]);
      const event = new Event("dragstart", { bubbles: true, cancelable: true });
      const setDragImage = vi.fn((image: Element) => {
        expect(image.isConnected).toBe(true);
      });
      Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn(), setDragImage } });
      at(list, "note.md").dispatchEvent(event);
      expect(setDragImage).toHaveBeenCalledWith(expect.objectContaining({ textContent: "2 items" }), -10, -10);
    });

    it("carries only the grabbed row when it is outside the selection", () => {
      const { list, ctx } = selecting(["note.md", "other.md"]);
      const dataTransfer = dispatchDrag(at(list, "projects/a.md"), "dragstart");
      expect(ctx.onDragStart).toHaveBeenCalledWith([DIR.children?.[0]]);
      expect(dataTransfer.data.get("text/plain")).toBe("projects/a.md");
    });

    // Under the tree's last row lies the drop into its top folder.
    it("takes no drop on a row the drag carries, and lets none through to what holds the tree", () => {
      const { list, ctx } = selecting(["projects", "note.md"]);
      const holder = vi.fn();
      list.parentElement?.addEventListener("dragover", holder);
      dispatchDrag(at(list, "note.md"), "dragstart");

      for (const path of ["note.md", "projects/a.md"]) {
        const event = over(at(list, path), "dragover");
        expect(event.defaultPrevented).toBe(true);
        expect(event.dataTransfer.dropEffect).toBe("none");
        over(at(list, path), "drop");
      }
      expect(ctx.onDrop).not.toHaveBeenCalled();
      over(at(list, "other.md"), "drop");
      expect(ctx.onDrop).toHaveBeenCalledWith(expect.any(Event), OTHER, expect.any(String));
      expect(holder).not.toHaveBeenCalled();
    });
  });
});

// One root, composed once per row, is what every consumer outside the tree
// sees. A space tree's rooted spelling is its bare path, so all of this is a
// no-op there and only libraries are affected.
describe("createTreeView — the tree's root", () => {
  const LIBRARY = { library: "footage" } as const;

  it("roots the row's data attribute, so two roots can't collide in the DOM", () => {
    const space = drawTree([FILE], "", baseCtx());
    const library = drawTree([FILE], "", baseCtx({ root: LIBRARY }));
    expect(space.querySelector<HTMLElement>(".node-label")?.dataset.path).toBe("note.md");
    expect(library.querySelector<HTMLElement>(".node-label")?.dataset.path).toBe("lib:footage/note.md");
  });

  it("hands onOpen the rooted path, so the caller re-roots nothing", () => {
    const ctx = baseCtx({ root: LIBRARY });
    drawTree([FILE], "", ctx).querySelector<HTMLElement>(".node-label")?.click();
    expect(ctx.onOpen).toHaveBeenCalledWith("lib:footage/note.md", expect.anything());
  });

  it("hands onOpenDirectory the rooted path too", () => {
    const ctx = baseCtx({ root: LIBRARY });
    drawTree([DIR], "", ctx).querySelector<HTMLElement>(".node-open")?.click();
    expect(ctx.onOpenDirectory).toHaveBeenCalledWith("lib:footage/projects");
  });

  it("keys collapse state by the rooted path, so one store serves every tree", () => {
    const ctx = baseCtx({ root: LIBRARY });
    const list = drawTree([DIR], "", ctx);
    list.querySelector<HTMLElement>(".node-label")?.click();
    expect(ctx.onToggleCollapse).toHaveBeenCalledWith("lib:footage/projects", true);
  });

  it("asks with that same rooted key when deciding what starts collapsed", () => {
    const isCollapsed = vi.fn((path: string) => path === "lib:footage/projects");
    const collapsed = drawTree([DIR], "", baseCtx({ root: LIBRARY, isCollapsed }));
    expect(collapsed.querySelector("li.directory")?.className).toContain("collapsed");
    // Never the bare path, which names a space folder of the same name.
    expect(isCollapsed).not.toHaveBeenCalledWith("projects");
  });
});

// A tree keeps its rows: a render patches what changed against the last one,
// and a folder's rows exist only while it is open. That is what keeps a
// refresh of a large library cheap, and what lets an inline input, a
// highlight or a hover survive one.
describe("createTreeView — rows kept across renders", () => {
  const file = (path: string): SpaceTreeNode => ({ name: path.split("/").pop() ?? path, path, type: "file" });
  const labels = (tree: { element: HTMLElement }) =>
    Array.from(tree.element.querySelectorAll<HTMLElement>(".node-label")).map((label) => label.dataset.path);

  it("keeps a row's elements while its entry is still listed", () => {
    const tree = createTreeView("");
    tree.render([file("a.md"), file("b.md")], baseCtx());
    const before = tree.element.querySelector('[data-path="a.md"]');

    tree.render([file("a.md"), file("b.md")], baseCtx());
    expect(tree.element.querySelector('[data-path="a.md"]')).toBe(before);
  });

  it("adds, drops and reorders rows in place, leaving the rest untouched", () => {
    const tree = createTreeView("");
    tree.render([file("a.md"), file("b.md"), file("c.md")], baseCtx());
    const a = tree.element.querySelector('[data-path="a.md"]');
    const c = tree.element.querySelector('[data-path="c.md"]');

    tree.render([file("c.md"), file("a.md"), file("d.md")], baseCtx());
    expect(labels(tree)).toEqual(["c.md", "a.md", "d.md"]);
    expect(tree.element.querySelector('[data-path="a.md"]')).toBe(a);
    expect(tree.element.querySelector('[data-path="c.md"]')).toBe(c);
    expect(tree.hasRow("b.md")).toBe(false);
  });

  it("redraws a row whose drawing changed, on the same element", () => {
    const tree = createTreeView("");
    tree.render([DIR], baseCtx());
    const label = tree.element.querySelector<HTMLElement>('[data-path="projects"]');

    tree.render([{ ...DIR, sortable: false }], baseCtx());
    expect(tree.element.querySelector('[data-path="projects"]')).toBe(label);
    expect(label?.querySelector(".node-sort-badge")).toBeNull();
    expect(tree.element.querySelector("li.directory")?.classList.contains("sortable")).toBe(false);
  });

  it("wears Pragma's mark on a README once it opens a scope, on the same row", () => {
    const readme: SpaceTreeNode = { name: "README.md", path: "README.md", type: "file" };
    const tree = createTreeView("");
    tree.render([readme], baseCtx());
    const row = tree.element.querySelector(":scope > li");
    expect(row?.classList.contains("scope")).toBe(false);

    tree.render([{ ...readme, opensScope: true }], baseCtx());
    expect(tree.element.querySelector(":scope > li")).toBe(row);
    expect(row?.classList.contains("scope")).toBe(true);
    expect(row?.querySelector<HTMLElement>(".node-icon")?.dataset.tooltip).toBe("Pragma scope");
  });

  it("names the job one of Pragma's files does in its icon's tooltip", () => {
    const tree = createTreeView("");
    tree.render([{ name: "_structure.json", path: "_structure.json", type: "file", pragmaFile: "order" }], baseCtx());
    const icon = tree.element.querySelector<HTMLElement>(":scope > li .node-icon");
    expect(icon?.dataset.entryIcon).toBe("pragma-file");
    expect(icon?.dataset.tooltip).toBe("Pragma order");
  });

  it("marks a folder as its scope's once its README opens one, on the same row", () => {
    const readme: SpaceTreeNode = { name: "README.md", path: "world/README.md", type: "file" };
    const folder: SpaceTreeNode = { name: "world", path: "world", type: "directory", children: [readme] };
    const tree = createTreeView("");
    tree.render([folder], baseCtx());
    const row = tree.element.querySelector(":scope > li.directory");
    const icon = () => row?.querySelector<HTMLElement>(".node-icon");
    expect(icon()?.dataset.entryIcon).toBe("folder");
    expect(icon()?.hasAttribute("data-scope")).toBe(false);
    expect(icon()?.dataset.tooltip).toBeUndefined();

    tree.render([{ ...folder, children: [{ ...readme, opensScope: true }] }], baseCtx());
    expect(tree.element.querySelector(":scope > li.directory")).toBe(row);
    expect(icon()?.hasAttribute("data-scope")).toBe(true);
    expect(icon()?.dataset.tooltip).toBe("Pragma scope");
  });

  it("replaces a row whose entry changed kind under the same path", () => {
    const tree = createTreeView("");
    tree.render([file("shots")], baseCtx());
    tree.render([{ name: "shots", path: "shots", type: "directory", children: [file("shots/1.png")] }], baseCtx());

    expect(tree.element.querySelector(":scope > li")?.classList.contains("directory")).toBe(true);
    expect(tree.hasRow("shots/1.png")).toBe(true);
  });

  it("builds a folder's rows when it opens and drops them when it closes", () => {
    const folded = new Set(["projects"]);
    const ctx = baseCtx({
      isCollapsed: (path) => folded.has(path),
      onToggleCollapse: (path, collapsed) => (collapsed ? folded.add(path) : folded.delete(path)),
    });
    const tree = createTreeView("");
    tree.render([DIR], ctx);
    expect(tree.element.querySelector('[data-path="projects/a.md"]')).toBeNull();
    expect(tree.hasRow("projects/a.md")).toBe(false);

    tree.element.querySelector<HTMLElement>('[data-path="projects"]')?.click();
    expect(tree.hasRow("projects/a.md")).toBe(true);
    expect(tree.element.querySelector('[data-path="projects/a.md"]')).not.toBeNull();

    tree.element.querySelector<HTMLElement>('[data-path="projects"]')?.click();
    expect(tree.hasRow("projects/a.md")).toBe(false);
    expect(tree.element.querySelector('[data-path="projects/a.md"]')).toBeNull();
  });

  it("opens and closes folders a render finds changed in the collapse store", () => {
    const folded = new Set<string>();
    const ctx = baseCtx({ isCollapsed: (path) => folded.has(path) });
    const tree = createTreeView("");
    tree.render([DIR], ctx);
    expect(tree.hasRow("projects/a.md")).toBe(true);

    folded.add("projects");
    tree.render([DIR], ctx);
    expect(tree.hasRow("projects/a.md")).toBe(false);
  });

  it("keeps what was typed into a rename across a refresh", () => {
    const ctx = baseCtx({ editingPath: "note.md" });
    const tree = createTreeView("");
    tree.render([FILE], ctx);
    const input = tree.element.querySelector("input") as HTMLInputElement;
    input.value = "half-typed";

    tree.render([{ ...FILE }], ctx);
    expect(tree.element.querySelector("input")).toBe(input);
    expect(input.value).toBe("half-typed");
  });

  it("keeps the create row across a refresh, and drops it once nothing is pending", () => {
    const pending = baseCtx({ pendingCreate: { parentPath: "", type: "file" } });
    const tree = createTreeView("");
    tree.render([FILE], pending);
    const input = tree.element.querySelector("input") as HTMLInputElement;
    input.value = "New note";

    tree.render([FILE], pending);
    expect(tree.element.querySelector("input")).toBe(input);

    tree.render([FILE], baseCtx());
    expect(tree.element.querySelector("input")).toBeNull();
    expect(labels(tree)).toEqual(["note.md"]);
  });

  it("focuses a new inline input once, not again on every render", () => {
    const ctx = baseCtx({ editingPath: "note.md" });
    const tree = createTreeView("");
    document.body.appendChild(tree.element);
    tree.render([FILE], ctx);
    const input = tree.element.querySelector("input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    tree.render([FILE], ctx);
    expect(document.activeElement).toBe(elsewhere);
    tree.element.remove();
    elsewhere.remove();
  });

  it("marks the active row as it draws it", () => {
    const tree = createTreeView("", { active: activeAt("projects/a.md") });
    tree.render([DIR], baseCtx());
    expect(tree.element.querySelector('[data-path="projects/a.md"]')?.classList.contains("active")).toBe(true);
    expect(tree.element.querySelector('[data-path="projects"]')?.classList.contains("active")).toBe(false);
  });

  it("hands a right-click the entry as last drawn, not as first drawn", () => {
    const ctx = baseCtx();
    const tree = createTreeView("");
    tree.render([DIR], ctx);
    const latest: SpaceTreeNode = { ...DIR, sortable: false };
    tree.render([latest], ctx);

    tree.element
      .querySelector('[data-path="projects"]')
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(ctx.onContextMenu).toHaveBeenCalledWith(expect.any(MouseEvent), latest);
  });
});

describe("createTreeView — the keyboard cursor", () => {
  const press = (list: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    list.dispatchEvent(event);
    return event;
  };
  const cursorAt = (list: HTMLElement) => list.querySelector<HTMLElement>(".node-label.cursor")?.dataset.path;

  it("places the cursor on the open file's row with the first key, then steps down and up", () => {
    const tree = createTreeView("", { active: activeAt("projects/a.md") });
    tree.render([FILE, DIR], baseCtx());

    press(tree.element, "ArrowDown");
    expect(cursorAt(tree.element)).toBe("projects/a.md");
    press(tree.element, "ArrowUp");
    expect(cursorAt(tree.element)).toBe("projects");
    press(tree.element, "ArrowUp");
    press(tree.element, "ArrowUp");
    expect(cursorAt(tree.element)).toBe("note.md");
  });

  it("starts on the first row when the open file isn't listed", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    press(list, "ArrowDown");
    expect(cursorAt(list)).toBe("note.md");
  });

  it("steps over a folder's loading line", () => {
    const unlisted: SpaceTreeNode = { name: "shots", path: "shots", type: "directory" };
    const list = drawTree([unlisted, FILE], "", baseCtx());
    press(list, "ArrowDown");
    press(list, "ArrowDown");
    expect(cursorAt(list)).toBe("note.md");
  });

  it("moves to a clicked row", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    list.querySelector<HTMLElement>('[data-path="projects/a.md"]')?.click();
    press(list, "ArrowUp");
    expect(cursorAt(list)).toBe("projects");
  });

  it("rings the cursor once a key moves it, and not after a click", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    const row = list.querySelector<HTMLElement>('[data-path="projects/a.md"]') as HTMLElement;
    const pressPointer = () => row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    pressPointer();
    row.click();
    expect(list.classList.contains("keyboard-cursor")).toBe(false);

    press(list, "ArrowUp");
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
    pressPointer();
    expect(list.classList.contains("keyboard-cursor")).toBe(false);
  });

  it("opens a file and toggles a folder on Enter, as a click does", () => {
    const ctx = baseCtx();
    const list = drawTree([FILE, DIR], "", ctx);
    press(list, "ArrowDown");
    press(list, "Enter");
    expect(ctx.onOpen).toHaveBeenCalledWith("note.md", expect.any(HTMLElement));

    press(list, "ArrowDown");
    press(list, "Enter");
    expect(ctx.onToggleCollapse).toHaveBeenCalledWith("projects", true);
    expect(list.querySelectorAll(".node-label")).toHaveLength(2);
  });

  it("drops the ring when Enter opens a file, and keeps it when Enter folds a folder", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    press(list, "ArrowDown");
    press(list, "Enter");
    expect(list.classList.contains("keyboard-cursor")).toBe(false);

    press(list, "ArrowDown");
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
    press(list, "Enter");
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
  });

  it("leaves a modified key to the app's shortcuts", () => {
    const list = drawTree([FILE, DIR], "", baseCtx());
    expect(press(list, "ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
    expect(cursorAt(list)).toBeUndefined();
  });
});

// Shift selects a range from the anchor and Ctrl one row more; only two or
// more rows selected are drawn, dragged or handed over together.
describe("createTreeView — several rows selected", () => {
  const FILES: SpaceTreeNode[] = ["a", "b", "c", "d", "e"].map((name) => ({
    name: `${name}.md`,
    path: `${name}.md`,
    type: "file",
  }));
  const labelAt = (list: HTMLElement, path: string) =>
    list.querySelector<HTMLElement>(`.node-label[data-path="${path}"]`) as HTMLElement;
  const click = (list: HTMLElement, path: string, init: MouseEventInit = {}) =>
    labelAt(list, path).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const press = (list: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    list.dispatchEvent(event);
    return event;
  };
  const selected = (list: HTMLElement) =>
    [...list.querySelectorAll<HTMLElement>(".node-label.selected")].map((label) => label.dataset.path);
  const rightClick = (list: HTMLElement, path: string) =>
    labelAt(list, path).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

  it("selects every row from the one clicked to the one Shift+clicked, and opens nothing more", () => {
    const ctx = baseCtx({ selectsMany: true });
    const list = drawTree(FILES, "", ctx);
    click(list, "b.md");
    click(list, "d.md", { shiftKey: true });
    expect(selected(list)).toEqual(["b.md", "c.md", "d.md"]);
    expect(ctx.onOpen).toHaveBeenCalledTimes(1);
  });

  it("adds a row with Ctrl+click and takes one out, the clicked row among them", () => {
    const ctx = baseCtx({ selectsMany: true });
    const list = drawTree(FILES, "", ctx);
    click(list, "a.md");
    click(list, "c.md", { ctrlKey: true });
    expect(selected(list)).toEqual(["a.md", "c.md"]);
    click(list, "e.md", { ctrlKey: true });
    click(list, "a.md", { ctrlKey: true });
    expect(selected(list)).toEqual(["c.md", "e.md"]);
    // One row left is no selection to draw.
    click(list, "c.md", { ctrlKey: true });
    expect(selected(list)).toEqual([]);
    expect(ctx.onOpen).toHaveBeenCalledTimes(1);
  });

  it("toggles a row with Cmd on macOS, where Ctrl+click is the menu's", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      const list = drawTree(FILES, "", baseCtx({ selectsMany: true }));
      click(list, "a.md");
      click(list, "b.md", { metaKey: true });
      expect(selected(list)).toEqual(["a.md", "b.md"]);
      click(list, "c.md", { ctrlKey: true });
      expect(selected(list)).toEqual([]);
    } finally {
      platform.mockRestore();
    }
  });

  it("shrinks a range from the same anchor, keeping rows Ctrl+clicked outside it", () => {
    const list = drawTree(FILES, "", baseCtx({ selectsMany: true }));
    click(list, "a.md");
    click(list, "c.md", { ctrlKey: true });
    click(list, "e.md", { shiftKey: true });
    expect(selected(list)).toEqual(["a.md", "c.md", "d.md", "e.md"]);
    click(list, "d.md", { shiftKey: true });
    expect(selected(list)).toEqual(["a.md", "c.md", "d.md"]);
  });

  it("grows and shrinks the selection with Shift and an arrow, and keeps it on a plain one", () => {
    const list = drawTree(FILES, "", baseCtx({ selectsMany: true }));
    click(list, "b.md");
    press(list, "ArrowDown", { shiftKey: true });
    press(list, "ArrowDown", { shiftKey: true });
    expect(selected(list)).toEqual(["b.md", "c.md", "d.md"]);
    expect(press(list, "ArrowUp", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(selected(list)).toEqual(["b.md", "c.md"]);
    press(list, "ArrowDown");
    expect(selected(list)).toEqual(["b.md", "c.md"]);
  });

  it("lets go of a selection on Escape, and leaves Escape to the app without one", () => {
    const list = drawTree(FILES, "", baseCtx({ selectsMany: true }));
    click(list, "a.md");
    expect(press(list, "Escape").defaultPrevented).toBe(false);
    click(list, "b.md", { shiftKey: true });
    expect(press(list, "Escape").defaultPrevented).toBe(true);
    expect(selected(list)).toEqual([]);
  });

  it("lets go of a selection on a plain click, which opens as it always has", () => {
    const ctx = baseCtx({ selectsMany: true });
    const list = drawTree(FILES, "", ctx);
    click(list, "a.md");
    click(list, "c.md", { shiftKey: true });
    click(list, "e.md");
    expect(selected(list)).toEqual([]);
    expect(ctx.onOpen).toHaveBeenLastCalledWith("e.md", expect.any(HTMLElement));
  });

  it("drops a folded folder's rows from the selection", () => {
    const tree = createTreeView("");
    let folded = false;
    const ctx = baseCtx({ selectsMany: true, isCollapsed: () => folded });
    tree.render([DIR, FILE], ctx);
    for (const path of ["projects", "projects/a.md", "note.md"]) click(tree.element, path, { ctrlKey: true });
    expect(selected(tree.element)).toEqual(["projects", "projects/a.md", "note.md"]);

    folded = true;
    tree.render([DIR, FILE], ctx);
    expect(selected(tree.element)).toEqual(["projects", "note.md"]);
    folded = false;
    tree.render([DIR, FILE], ctx);
    expect(selected(tree.element)).toEqual(["projects", "note.md"]);
  });

  it("starts a selection at the row a reveal brought into view", () => {
    const tree = createTreeView("");
    tree.render(FILES, baseCtx({ selectsMany: true }));
    tree.reveal("b.md");
    click(tree.element, "d.md", { ctrlKey: true });
    expect(selected(tree.element)).toEqual(["b.md", "d.md"]);
  });

  it("takes Shift and Ctrl for plain clicks in a tree that selects one row", () => {
    const ctx = baseCtx();
    const list = drawTree(FILES, "", ctx);
    click(list, "a.md");
    click(list, "c.md", { shiftKey: true });
    click(list, "d.md", { ctrlKey: true });
    expect(selected(list)).toEqual([]);
    expect(ctx.onOpen).toHaveBeenCalledTimes(3);
    expect(press(list, "ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("hands a right-click on a selected row every entry selected, less those inside a selected folder", () => {
    const ctx = baseCtx({ selectsMany: true });
    const list = drawTree([DIR, FILE], "", ctx);
    for (const path of ["projects", "projects/a.md", "note.md"]) click(list, path, { ctrlKey: true });
    rightClick(list, "projects/a.md");
    expect(ctx.onContextMenu).toHaveBeenLastCalledWith(expect.any(MouseEvent), DIR.children?.[0], [DIR, FILE]);
  });

  it("gives a right-click outside the selection that row alone", () => {
    const ctx = baseCtx({ selectsMany: true });
    const list = drawTree(FILES, "", ctx);
    click(list, "a.md");
    click(list, "b.md", { shiftKey: true });
    rightClick(list, "d.md");
    expect(vi.mocked(ctx.onContextMenu).mock.lastCall).toEqual([expect.any(MouseEvent), FILES[3]]);
  });

  it("hands Delete the selection's entries, else the cursor's row's", () => {
    const onDelete = vi.fn();
    const list = drawTree(FILES, "", baseCtx({ selectsMany: true, onDelete }));
    click(list, "b.md");
    expect(press(list, "Delete").defaultPrevented).toBe(true);
    expect(onDelete).toHaveBeenLastCalledWith([FILES[1]]);
    click(list, "d.md", { shiftKey: true });
    press(list, "Delete");
    expect(onDelete).toHaveBeenLastCalledWith([FILES[1], FILES[2], FILES[3]]);
    expect(press(list, "Delete", { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("deletes with Cmd+Backspace on macOS, never with Backspace alone", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      const onDelete = vi.fn();
      const list = drawTree(FILES, "", baseCtx({ selectsMany: true, onDelete }));
      click(list, "b.md");
      press(list, "Backspace");
      expect(onDelete).not.toHaveBeenCalled();
      press(list, "Backspace", { metaKey: true });
      expect(onDelete).toHaveBeenCalledWith([FILES[1]]);
    } finally {
      platform.mockRestore();
    }
  });

  it("leaves Delete to the app in a tree that deletes nothing", () => {
    const list = drawTree(FILES, "", baseCtx({ selectsMany: true }));
    click(list, "b.md");
    expect(press(list, "Delete").defaultPrevented).toBe(false);
  });
});

// A tree draws only the rows near its viewport, each placed by its index, in
// a list as tall as every listed row. jsdom lays nothing out, so the
// scroller's height and both boxes are stood up by hand at the default pitch.
describe("createTreeView — only the rows near the viewport are drawn", () => {
  const PITCH = 24;
  const files = (count: number): SpaceTreeNode[] =>
    Array.from({ length: count }, (_, i) => ({ name: `f${i}.md`, path: `f${i}.md`, type: "file" }));
  const drawn = (tree: TreeView) =>
    Array.from(tree.element.querySelectorAll<HTMLElement>(".node-label")).map((label) => label.dataset.path);
  const isSpacer = (item: Element | undefined) => item?.classList.contains("tree-spacer") ?? false;
  // The list's height as layout would give it: a spacer's or a transition
  // row's own, and one pitch for a row or a pinned folder's place.
  const listHeight = (tree: TreeView) =>
    Array.from(tree.element.children).reduce(
      (sum, item) =>
        sum +
        (item.matches(".tree-spacer, .tree-transition")
          ? Number.parseFloat((item as HTMLElement).style.height)
          : PITCH),
      0,
    );

  // As a browser's would, the scroller never stays scrolled past the list's end.
  function inScroller(tree: TreeView, height: number): { scrollTo: (top: number) => void; remove: () => void } {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    let scrollTop = 0;
    const laidOut = () => {
      scrollTop = Math.min(scrollTop, Math.max(0, listHeight(tree) - height));
      return scrollTop;
    };
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => height });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: laidOut,
      set: (top: number) => {
        scrollTop = top;
      },
    });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    tree.element.getBoundingClientRect = () => ({ top: -laidOut() }) as DOMRect;
    scroller.appendChild(tree.element);
    document.body.appendChild(scroller);
    return {
      scrollTo(top) {
        scrollTop = top;
        scroller.dispatchEvent(new Event("scroll"));
      },
      remove: () => scroller.remove(),
    };
  }

  it("draws the rows near the viewport, with spacers making up the rest", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());

    expect(drawn(tree).length).toBeLessThan(40);
    expect(drawn(tree)[0]).toBe("f0.md");
    expect(listHeight(tree)).toBe(1000 * PITCH);
    view.remove();
  });

  it("stands a spacer in for the rows above the ones in view", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());

    view.scrollTo(500 * PITCH);
    const above = tree.element.children[0] as HTMLElement;
    const firstDrawn = Number(drawn(tree)[0]?.slice(1, -".md".length));
    expect(isSpacer(above)).toBe(true);
    expect(above.style.height).toBe(`${firstDrawn * PITCH}px`);
    expect(listHeight(tree)).toBe(1000 * PITCH);
    view.remove();
  });

  it("draws again for where the scroll position lands when the list shrinks under it", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());
    view.scrollTo(990 * PITCH);

    tree.render(files(100), baseCtx());
    expect(drawn(tree)).toContain("f90.md");
    expect(drawn(tree)).toContain("f99.md");
    expect(listHeight(tree)).toBe(100 * PITCH);
    view.remove();
  });

  it("draws the rows a scroll brings near, and takes the rest off the page", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());

    view.scrollTo(500 * PITCH);
    expect(drawn(tree)).toContain("f500.md");
    expect(drawn(tree)).not.toContain("f0.md");
    // Still a row, though nothing of it is on the page.
    expect(tree.hasRow("f0.md")).toBe(true);
    view.remove();
  });

  it("keeps a row holding an input on the page however far it scrolls", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx({ editingPath: "f0.md" }));
    const input = tree.element.querySelector("input");

    view.scrollTo(500 * PITCH);
    expect(tree.element.querySelector("input")).toBe(input);
    expect(input?.isConnected).toBe(true);
    // In its own place, with a spacer between it and the rows in view.
    expect(tree.element.children[0]?.contains(input)).toBe(true);
    expect(isSpacer(tree.element.children[1])).toBe(true);
    expect(listHeight(tree)).toBe(1000 * PITCH);
    view.remove();
  });

  it("scrolls just far enough to bring the cursor's row into view", () => {
    const tree = createTreeView("", { active: activeAt("f9.md") });
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());
    const scroller = tree.element.parentElement as HTMLElement;

    tree.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(scroller.scrollTop).toBe(0);
    tree.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(scroller.scrollTop).toBe(PITCH);
    expect(tree.element.querySelector<HTMLElement>(".node-label.cursor")?.dataset.path).toBe("f10.md");
    view.remove();
  });

  it("reveals an off-screen row in the middle of the view, and leaves one in view where it is", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());
    const scroller = tree.element.parentElement as HTMLElement;

    expect(tree.reveal("f500.md")).toBe(true);
    expect(scroller.scrollTop).toBe(500 * PITCH + PITCH / 2 - 5 * PITCH);
    expect(tree.element.querySelector<HTMLElement>(".node-label.cursor")?.dataset.path).toBe("f500.md");
    expect(tree.reveal("f503.md")).toBe(true);
    expect(scroller.scrollTop).toBe(500 * PITCH + PITCH / 2 - 5 * PITCH);
    expect(tree.reveal("missing.md")).toBe(false);
    view.remove();
  });

  it("stops following its scroller once disposed", () => {
    const tree = createTreeView("");
    const view = inScroller(tree, 10 * PITCH);
    tree.render(files(1000), baseCtx());

    tree.dispose();
    view.scrollTo(500 * PITCH);
    expect(drawn(tree)).toContain("f0.md");
    expect(drawn(tree)).not.toContain("f500.md");
    view.remove();
  });

  it("draws only its first rows when it has no viewport to measure", () => {
    const tree = createTreeView("");
    tree.render(files(1000), baseCtx());

    expect(drawn(tree)).toHaveLength(200);
    expect(tree.hasRow("f999.md")).toBe(true);
  });

  describe("a folder opening or shutting", () => {
    // jsdom has no Web Animations: a stand-in that ends only when told to.
    type Started = { keyframes: Keyframe[]; cancelled: boolean; finish: () => void };
    let started: Started[] = [];
    const last = () => started[started.length - 1];
    const animate = HTMLElement.prototype.animate;
    beforeEach(() => {
      started = [];
      HTMLElement.prototype.animate = (keyframes) => {
        const onFinish: (() => void)[] = [];
        const animation = {
          keyframes: keyframes as Keyframe[],
          cancelled: false,
          finish: () => {
            for (const listener of onFinish) listener();
          },
          cancel: () => {
            animation.cancelled = true;
          },
          addEventListener: (type: string, listener: () => void) => {
            if (type === "finish") onFinish.push(listener);
          },
        };
        started.push(animation);
        return animation as unknown as Animation;
      };
    });
    afterEach(() => {
      if (animate) HTMLElement.prototype.animate = animate;
      else delete (HTMLElement.prototype as { animate?: unknown }).animate;
    });

    const folder = (count: number): SpaceTreeNode => ({
      name: "a",
      path: "a",
      type: "directory",
      children: Array.from({ length: count }, (_, i) => ({
        name: `f${i}.md`,
        path: `a/f${i}.md`,
        type: "file" as const,
      })),
    });
    const transitionRow = (tree: TreeView) => tree.element.querySelector<HTMLLIElement>(":scope > .tree-transition");
    const click = (tree: TreeView, path: string) =>
      tree.element.querySelector<HTMLElement>(`.node-label[data-path="${path}"]`)?.click();

    it("slides a folder shut in a transition row holding its rows on show", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render([folder(20), ...files(5)], baseCtx());
      const shown = tree.element.querySelector('[data-path="a/f0.md"]')?.parentElement;

      click(tree, "a");
      const row = transitionRow(tree);
      // Right after the folder, holding the nine rows that fit under it in
      // view: the same elements, no longer addressable, and inert.
      expect(row?.previousElementSibling?.querySelector(".node-label")?.getAttribute("data-path")).toBe("a");
      expect(row?.querySelectorAll(".tree-row")).toHaveLength(9);
      expect(row?.querySelector(".tree-row")).toBe(shown);
      expect(row?.querySelector("[data-path]")).toBeNull();
      expect(row?.inert).toBe(true);
      expect(tree.hasRow("a/f0.md")).toBe(false);
      expect(last()?.keyframes).toEqual([{ height: `${9 * PITCH}px` }, { height: "0px" }]);

      last()?.finish();
      expect(transitionRow(tree)).toBeNull();
      expect(drawn(tree)).toEqual(["a", "f0.md", "f1.md", "f2.md", "f3.md", "f4.md"]);
      view.remove();
    });

    it("slides a folder open with live rows, then lists the same rows in place", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render([folder(20), ...files(5)], baseCtx({ isCollapsed: () => true }));

      click(tree, "a");
      const row = transitionRow(tree);
      expect(row?.querySelectorAll(".tree-row")).toHaveLength(9);
      expect(row?.inert).toBe(false);
      expect(tree.hasRow("a/f0.md")).toBe(true);
      expect(last()?.keyframes).toEqual([{ height: "0px" }, { height: `${9 * PITCH}px` }]);
      const first = row?.querySelector('[data-path="a/f0.md"]')?.parentElement;

      last()?.finish();
      expect(transitionRow(tree)).toBeNull();
      expect(tree.element.querySelector('[data-path="a/f0.md"]')?.parentElement).toBe(first);
      expect(drawn(tree).slice(0, 3)).toEqual(["a", "a/f0.md", "a/f1.md"]);
      view.remove();
    });

    it("keeps a transition through a scroll, however far", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render([folder(20), ...files(1000)], baseCtx());

      click(tree, "a");
      const row = transitionRow(tree);
      view.scrollTo(500 * PITCH);
      expect(transitionRow(tree)).toBe(row);
      expect(last()?.cancelled).toBe(false);
      expect(drawn(tree)).toContain("f500.md");
      expect(listHeight(tree)).toBe(1001 * PITCH);
      view.remove();
    });

    it("ends a running transition before acting on a click", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      const ctx = baseCtx();
      tree.render([folder(20), ...files(5)], ctx);

      click(tree, "a");
      const shutting = last();
      click(tree, "f0.md");
      expect(shutting?.cancelled).toBe(true);
      expect(transitionRow(tree)).toBeNull();
      expect(ctx.onOpen).toHaveBeenCalledWith("f0.md", expect.anything());
      view.remove();
    });

    it("ends a running transition when a new listing arrives", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render([folder(20), ...files(5)], baseCtx());

      click(tree, "a");
      tree.render([folder(20), ...files(6)], baseCtx({ isCollapsed: (path) => path === "a" }));
      expect(last()?.cancelled).toBe(true);
      expect(transitionRow(tree)).toBeNull();
      expect(drawn(tree)).toEqual(["a", "f0.md", "f1.md", "f2.md", "f3.md", "f4.md", "f5.md"]);
      view.remove();
    });

    it("holds the list's height when the first row it shuts is a pinned folder's", () => {
      // c/ last in the list, holding d/ and its eight rows, scrolled as far
      // down as the list goes, where a shorter list would pull the view up.
      const shut: SpaceTreeNode = {
        name: "c",
        path: "c",
        type: "directory",
        children: [
          {
            name: "d",
            path: "c/d",
            type: "directory",
            children: Array.from({ length: 8 }, (_, i) => ({
              name: `f${i}.md`,
              path: `c/d/f${i}.md`,
              type: "file" as const,
            })),
          },
        ],
      };
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render([...files(32), shut], baseCtx({ pinsFolders: true }));
      view.scrollTo(32 * PITCH);
      expect(tree.element.querySelector('[data-path="c/d"]')?.closest(".tree-pin")).not.toBeNull();
      // Every scroll position the tree reads on the way: the stand-in
      // animation never holds the row's first height, so only these can tell.
      const read: number[] = [];
      const listTop = tree.element.getBoundingClientRect;
      tree.element.getBoundingClientRect = () => {
        const rect = listTop();
        read.push(-rect.top);
        return rect;
      };

      click(tree, "c");
      expect(transitionRow(tree)?.previousElementSibling?.querySelector(".node-label")?.getAttribute("data-path")).toBe(
        "c",
      );
      expect(Math.min(...read)).toBe(32 * PITCH);
      view.remove();
    });

    it("opens or shuts at once when none of the folder's rows can show", () => {
      const tree = createTreeView("");
      const view = inScroller(tree, PITCH);
      tree.render([folder(20)], baseCtx());

      click(tree, "a");
      expect(transitionRow(tree)).toBeNull();
      expect(started).toHaveLength(0);
      expect(tree.hasRow("a/f0.md")).toBe(false);
      view.remove();
    });
  });

  describe("folders pinned over the rows they hold", () => {
    // a/ holds twenty files, then b/ holding thirty; thirty more follow a/.
    // Scrolled to row 30, a/ pins at the top and b/ under it.
    const nodes = (): SpaceTreeNode[] => [
      {
        name: "a",
        path: "a",
        type: "directory",
        children: [
          ...Array.from({ length: 20 }, (_, i) => ({ name: `x${i}.md`, path: `a/x${i}.md`, type: "file" as const })),
          {
            name: "b",
            path: "a/b",
            type: "directory",
            children: Array.from({ length: 30 }, (_, i) => ({
              name: `f${i}.md`,
              path: `a/b/f${i}.md`,
              type: "file" as const,
            })),
          },
        ],
      },
      ...files(30),
    ];
    const B_ROW = 21;
    const label = (tree: TreeView, path: string) =>
      tree.element.querySelector<HTMLElement>(`.node-label[data-path="${path}"]`) as HTMLElement;
    // The folders whose rows sit in a place of their own in the list.
    const pinned = (tree: TreeView) =>
      [...tree.element.querySelectorAll<HTMLElement>(":scope > .tree-pin .node-label")].map((pin) => pin.dataset.path);
    const placeOf = (tree: TreeView, path: string) =>
      label(tree, path).closest<HTMLElement>(".tree-pin") as HTMLElement;
    const cursorPath = (tree: TreeView) =>
      tree.element.querySelector<HTMLElement>(".node-label.cursor[data-path]")?.dataset.path;
    // Where the browser's sticking would put a scrolled-past folder's row:
    // at the top of the view, below its own place.
    function stick(tree: TreeView, path: string): HTMLElement {
      const stuck = label(tree, path);
      stuck.getBoundingClientRect = () => ({ top: PITCH, left: 0 }) as DOMRect;
      placeOf(tree, path).getBoundingClientRect = () => ({ top: -9 * PITCH }) as DOMRect;
      return stuck;
    }

    function pinnedTree(ctx = baseCtx({ pinsFolders: true })) {
      const tree = createTreeView("");
      const view = inScroller(tree, 10 * PITCH);
      tree.render(nodes(), ctx);
      return { tree, view, scroller: tree.element.parentElement as HTMLElement, ctx };
    }

    it("sets each open folder's own row in a box as tall as the rows it holds", () => {
      const { tree, view } = pinnedTree();
      expect(pinned(tree)).toEqual(["a", "a/b"]);
      const box = (path: string) => placeOf(tree, path).firstElementChild as HTMLElement;
      expect(box("a").style.height).toBe(`${52 * PITCH}px`);
      expect(box("a/b").style.height).toBe(`${31 * PITCH}px`);
      // Shallower above deeper, so a row pushed out slides under its parent's.
      expect(Number(placeOf(tree, "a").style.zIndex)).toBeGreaterThan(Number(placeOf(tree, "a/b").style.zIndex));
      // Each a row like any other: dragged, and found by its path.
      expect(label(tree, "a/b").draggable).toBe(true);
      expect(listHeight(tree)).toBe(82 * PITCH);
      view.remove();
    });

    it("keeps a pinned folder's row on the page while any row it holds is", () => {
      const { tree, view } = pinnedTree();
      view.scrollTo(40 * PITCH);
      // Far above the rows drawn, with spacers between.
      expect(pinned(tree)).toEqual(["a", "a/b"]);
      expect(tree.element.firstElementChild).toBe(placeOf(tree, "a"));
      expect(isSpacer(tree.element.children[1])).toBe(true);
      expect(listHeight(tree)).toBe(82 * PITCH);

      view.scrollTo(70 * PITCH);
      expect(pinned(tree)).toEqual([]);
      view.remove();
    });

    it("pins nothing in a tree that doesn't ask", () => {
      const { tree, view } = pinnedTree(baseCtx());
      view.scrollTo(30 * PITCH);
      expect(tree.element.querySelector(".tree-pin")).toBeNull();
      view.remove();
    });

    it("pins no deeper than seven folders, nor past 40% of the view", () => {
      const pathTo = (depth: number) => Array.from({ length: depth + 1 }, (_, i) => `d${i}`).join("/");
      // d0/d1/…/d8, each holding the next, the last a file.
      const chain = (depth: number): SpaceTreeNode => ({
        name: `d${depth}`,
        path: pathTo(depth),
        type: "directory",
        children: [
          depth < 8 ? chain(depth + 1) : { name: "f.md", path: `${pathTo(depth)}/f.md`, type: "file" as const },
        ],
      });
      const tall = createTreeView("");
      const tallView = inScroller(tall, 100 * PITCH);
      tall.render([chain(0)], baseCtx({ pinsFolders: true }));
      expect(pinned(tall)).toEqual([0, 1, 2, 3, 4, 5, 6].map(pathTo));
      tallView.remove();

      const short = createTreeView("");
      const shortView = inScroller(short, 5 * PITCH);
      short.render([chain(0)], baseCtx({ pinsFolders: true }));
      expect(pinned(short)).toEqual(["d0", "d0/d1"]);
      shortView.remove();
    });

    it("brings a stuck row out from under the pins, where it was, folding nothing", () => {
      const { tree, view, scroller, ctx } = pinnedTree();
      view.scrollTo(30 * PITCH);

      stick(tree, "a/b").click();
      // b/'s own place now sits just under a/'s row.
      expect(scroller.scrollTop).toBe((B_ROW - 1) * PITCH);
      expect(cursorPath(tree)).toBe("a/b");
      expect(ctx.onToggleCollapse).not.toHaveBeenCalled();
      expect(tree.hasRow("a/b/f0.md")).toBe(true);
      view.remove();
    });

    // b/'s label as file-tree.css lays it out: its padding holds the row's
    // indent, then the chevron runs up to the icon.
    function layOutChevron(stuck: HTMLElement): void {
      stuck.style.paddingLeft = "14px";
      (stuck.querySelector(".node-icon") as HTMLElement).getBoundingClientRect = () => ({ left: 31 }) as DOMRect;
    }

    it("folds a stuck row's folder from its chevron, after bringing the row out", () => {
      const { tree, view, scroller, ctx } = pinnedTree();
      view.scrollTo(30 * PITCH);
      const stuck = stick(tree, "a/b");
      layOutChevron(stuck);

      stuck.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20 }));
      expect(scroller.scrollTop).toBe((B_ROW - 1) * PITCH);
      expect(ctx.onToggleCollapse).toHaveBeenCalledWith("a/b", true);
      expect(tree.hasRow("a/b/f0.md")).toBe(false);
      view.remove();
    });

    it("only brings a stuck row out when its indent is clicked, left of the chevron", () => {
      const { tree, view, scroller, ctx } = pinnedTree();
      view.scrollTo(30 * PITCH);
      const stuck = stick(tree, "a/b");
      layOutChevron(stuck);

      stuck.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 8 }));
      expect(scroller.scrollTop).toBe((B_ROW - 1) * PITCH);
      expect(ctx.onToggleCollapse).not.toHaveBeenCalled();
      expect(tree.hasRow("a/b/f0.md")).toBe(true);
      view.remove();
    });

    it("folds a pinned folder clicked in its own place, as any folder", () => {
      const { tree, view, ctx } = pinnedTree();
      label(tree, "a/b").click();
      expect(ctx.onToggleCollapse).toHaveBeenCalledWith("a/b", true);
      view.remove();
    });

    it("keeps the cursor's row clear of the pins", () => {
      const { tree, view, scroller } = pinnedTree();
      view.scrollTo(30 * PITCH);
      // The first row clear of both copies: in view, so nothing scrolls.
      expect(tree.reveal("a/b/f10.md")).toBe(true);
      expect(scroller.scrollTop).toBe(30 * PITCH);

      tree.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(cursorPath(tree)).toBe("a/b/f9.md");
      expect(scroller.scrollTop).toBe(29 * PITCH);
      view.remove();
    });

    it("reveals a row under the pins as one out of view, in the middle", () => {
      const { tree, view, scroller } = pinnedTree();
      view.scrollTo(30 * PITCH);
      expect(tree.reveal("a/b/f9.md")).toBe(true);
      expect(scroller.scrollTop).toBe(31 * PITCH - (10 * PITCH - PITCH) / 2);
      view.remove();
    });

    it("brings a rename input out from under the pins before it takes focus", () => {
      const { tree, view, scroller } = pinnedTree();
      view.scrollTo(30 * PITCH);

      tree.render(nodes(), baseCtx({ pinsFolders: true, editingPath: "a/b" }));
      expect(scroller.scrollTop).toBe((B_ROW - 1) * PITCH);
      expect(document.activeElement?.closest(".node-label")?.getAttribute("data-path")).toBe("a/b");
      view.remove();
    });
  });
});

// A folder's tooltip totals what is under it, all the way down — free for
// the space's tree, which is listed whole. A tree listed a folder at a time
// counts nothing, since it would undercount every folder not yet opened.
describe("createTreeView — a folder's totals", () => {
  const nested: SpaceTreeNode = {
    name: "projects",
    path: "projects",
    type: "directory",
    children: [
      { name: "a.md", path: "projects/a.md", type: "file" },
      { name: "b.md", path: "projects/b.md", type: "file" },
      {
        name: "drafts",
        path: "projects/drafts",
        type: "directory",
        children: [
          { name: "c.md", path: "projects/drafts/c.md", type: "file" },
          { name: "old", path: "projects/drafts/old", type: "directory", children: [] },
        ],
      },
    ],
  };
  const tooltipOf = (tree: TreeView, path: string) =>
    tree.element.querySelector<HTMLElement>(`[data-path="${path}"]`)?.dataset.tooltip;

  it("counts every file and folder under it, in its tooltip", () => {
    const tree = createTreeView("");
    tree.render([nested], baseCtx({ countsFolders: true }));
    expect(tooltipOf(tree, "projects")).toBe("3 files, 2 folders");
    expect(tooltipOf(tree, "projects/drafts")).toBe("1 file, 1 folder");
    expect(tooltipOf(tree, "projects/drafts/old")).toBe("0 files, 0 folders");
    expect(tooltipOf(tree, "projects/a.md")).toBeUndefined();
  });

  it("counts a collapsed folder too", () => {
    const tree = createTreeView("");
    tree.render([nested], baseCtx({ countsFolders: true, isCollapsed: () => true }));
    expect(tooltipOf(tree, "projects")).toBe("3 files, 2 folders");
  });

  it("puts a site root's name above its totals", () => {
    const tree = createTreeView("");
    tree.render([{ ...nested, site: { name: "Blog" } }], baseCtx({ countsFolders: true }));
    expect(tooltipOf(tree, "projects")).toBe("Site: Blog\n3 files, 2 folders");
  });

  it("counts nothing in a tree that doesn't ask", () => {
    const tree = createTreeView("");
    tree.render(
      [nested, { name: "blog", path: "blog", type: "directory", children: [], site: { name: "Blog" } }],
      baseCtx(),
    );
    expect(tooltipOf(tree, "projects")).toBeUndefined();
    expect(tooltipOf(tree, "blog")).toBe("Site: Blog");
  });

  it("follows the tree when what is under a folder changes", () => {
    const tree = createTreeView("");
    const ctx = baseCtx({ countsFolders: true });
    tree.render([nested], ctx);
    const label = tree.element.querySelector('[data-path="projects"]');

    const grown = {
      ...nested,
      children: [...(nested.children ?? []), { name: "d.md", path: "projects/d.md", type: "file" as const }],
    };
    tree.render([grown], ctx);
    expect(tree.element.querySelector('[data-path="projects"]')).toBe(label);
    expect(tooltipOf(tree, "projects")).toBe("4 files, 2 folders");
  });
});
