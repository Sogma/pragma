// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SpaceTreeNode } from "../../../src/protocol/api.ts";
import type { PathForm } from "../../../src/protocol/relativeReference.ts";
import type { RootedPath } from "../../../src/protocol/rootedPath.ts";
import { DRAGGED_ENTRY_TYPE } from "../../../web/core/paths.ts";
import type { WritePathOptions } from "../../../web/core/spaceTree.ts";
import type { ContextMenuService, MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";
import { createPathField, type PathFieldSpec } from "../../../web/services/pathField.ts";
import { showExtensions } from "../../../web/services/settings.ts";

// The entries the space's listing holds, by rooted path, and the folders its
// scopes open over.
const listing = vi.hoisted(() => ({
  entries: new Map<string, "file" | "directory">(),
  scopes: new Set<string>(),
  folders: new Map<string, SpaceTreeNode>(),
}));

vi.mock("../../../web/core/spaceTree.ts", async (importOriginal) => {
  const { formatWrittenPath, readWrittenPath } = await import("../../../src/protocol/relativeReference.ts");
  const { formatRootedPath } = await import("../../../src/protocol/rootedPath.ts");
  const { dirnameOf } = await import("../../../src/protocol/rootedPath.ts");
  const kept = (type: "file" | "directory") =>
    [...listing.entries].filter(([, each]) => each === type).map(([path]) => path);
  return {
    ...(await importOriginal<typeof import("../../../web/core/spaceTree.ts")>()),
    resolvePathFrom: (docPath: string, written: string, form: PathForm) => {
      const read = readWrittenPath(dirnameOf(docPath), written, form);
      const path = read && formatRootedPath(read.target);
      const type = path === undefined ? undefined : listing.entries.get(path);
      return path !== undefined && type ? { path, type } : undefined;
    },
    scopesOf: () => listing.scopes,
    writePathFrom: (docDir: string, target: RootedPath, options: WritePathOptions = {}) =>
      formatWrittenPath(docDir, target, {
        form: options.form ?? "markdown",
        folder: options.folder,
        scopes: options.scopes ?? listing.scopes,
      }),
    linkScope: (docPath: string) => ({
      docPath,
      files: kept("file"),
      folders: kept("directory"),
      scopes: listing.scopes,
    }),
    libraryFiles: async () => [],
    findDirectoryNode: (path: string) => listing.folders.get(path),
    findDirectoryChildren: (path: string) => listing.folders.get(path)?.children,
  };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(value: string, overrides: Partial<PathFieldSpec> = {}, entries: [string, "file" | "directory"][] = []) {
  listing.entries = new Map([
    ["notes/a.md", "file"],
    ["refs", "directory"],
    ["shots/log.table.html", "file"],
    ...entries,
  ]);
  listing.scopes = new Set();
  const contextMenu = { open: vi.fn<(options: MenuOpenOptions) => void>(), close: vi.fn(), isOpen: vi.fn(() => false) };
  const spec: PathFieldSpec = {
    docPath: "shots/log.table.html",
    value,
    readOnly: false,
    onChange: vi.fn(),
    openPath: vi.fn(),
    notify: vi.fn(),
    contextMenu: contextMenu as ContextMenuService,
    ...overrides,
  };
  const field = createPathField(spec);
  const part = (name: string) => field.querySelector(`.path-field-${name}`) as HTMLElement;
  return { spec, field, contextMenu, part };
}

function drop(target: HTMLElement, path: string, type = "file"): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  const data: Record<string, string> = { "text/plain": path, [DRAGGED_ENTRY_TYPE]: type };
  Object.defineProperty(event, "dataTransfer", { value: { getData: (key: string) => data[key] ?? "", files: [] } });
  target.dispatchEvent(event);
}

describe("a path field", () => {
  it("names a file as the tree does and opens it with a click, as a link opens", () => {
    const { spec, part } = setup("../notes/a.md");
    expect(part("name").textContent).toBe("a");
    expect(part("entry").dataset.tooltip).toBe("notes/a.md");
    part("entry").click();
    expect(spec.openPath).toHaveBeenCalledWith("notes/a.md");
  });

  it("shows a file's extension when the setting does, and always for a file of no kind", () => {
    expect(setup("../refs/data.csv", {}, [["refs/data.csv", "file"]]).part("name").textContent).toBe("data.csv");
    showExtensions.set(true);
    try {
      expect(setup("../notes/a.md").part("name").textContent).toBe("a.md");
    } finally {
      showExtensions.set(false);
    }
  });

  it("opens a folder as its folder", () => {
    const { spec, part } = setup("../refs/");
    expect(part("name").textContent).toBe("refs");
    part("entry").click();
    expect(spec.openPath).toHaveBeenCalledWith("refs/");
  });

  it("says when its entry is gone, or its path names nothing, and opens neither", () => {
    const gone = setup("../gone.md");
    expect(gone.field.classList.contains("is-missing")).toBe(true);
    expect(gone.part("name").textContent).toBe("Missing: gone");
    expect((gone.part("entry") as HTMLButtonElement).disabled).toBe(true);

    const above = setup("../../../x.md");
    expect(above.field.classList.contains("is-unreadable")).toBe(true);
    expect(above.part("name").textContent).toBe("Unreadable path");
    expect((above.part("entry") as HTMLButtonElement).disabled).toBe(true);

    const there = setup("../notes/a.md");
    expect(["is-empty", "is-missing", "is-unreadable"].some((state) => there.field.classList.contains(state))).toBe(
      false,
    );
  });

  it("starts no selection where its entry is pressed, which only opens it", () => {
    const { part } = setup("../notes/a.md");
    const press = new Event("selectstart", { bubbles: true, cancelable: true });
    part("name").firstChild?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  // Firefox sends the click to the name a press started on, wherever it ends.
  it("opens on a click, not on a press dragged off its name", () => {
    const { spec, part } = setup("../notes/a.md");
    const press = (downX: number, upX: number) => {
      part("name").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: downX, clientY: 5 }));
      part("name").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: upX, clientY: 5 }));
    };
    press(10, 40);
    expect(spec.openPath).not.toHaveBeenCalled();
    press(10, 12);
    expect(spec.openPath).toHaveBeenCalledTimes(1);
    // A keyboard's click has no press of its own to have travelled.
    part("entry").click();
    expect(spec.openPath).toHaveBeenCalledTimes(2);
  });

  it("takes a tree's drop by the scope rule, a folder with its slash", () => {
    const { spec, field } = setup("");
    drop(field, "notes/a.md");
    drop(field, "refs", "directory");
    listing.scopes = new Set(["shots"]);
    drop(field, "notes/a.md");
    expect(vi.mocked(spec.onChange).mock.calls).toEqual([["../notes/a.md"], ["../refs/"], ["/notes/a.md"]]);
  });

  it("offers what a link could name to choose from, the current pick checked", async () => {
    const { spec, part, contextMenu } = setup("../refs/");
    part("choose").click();
    await tick();
    const items = contextMenu.open.mock.calls[0][0].items as MenuItem[];
    expect(items.map((item) => item.label)).toEqual(["a", "refs"]);
    const checked = (item: MenuItem) => item.checked?.(undefined as never, undefined);
    expect(items.map(checked)).toEqual([false, true]);
    items[0].run?.(undefined as never, undefined);
    expect(spec.onChange).toHaveBeenCalledWith("../notes/a.md");
    expect(part("name").textContent).toBe("a");
  });

  it("opens the chooser from an empty field's own slot, and clears a set one", async () => {
    const empty = setup("");
    expect(empty.part("name").textContent).toBe("None");
    empty.part("entry").click();
    await tick();
    expect(empty.contextMenu.open).toHaveBeenCalled();

    const set = setup("../notes/a.md");
    set.part("clear").click();
    expect(set.spec.onChange).toHaveBeenCalledWith("");
    expect(set.part("name").textContent).toBe("None");
  });

  it("read-only, only opens", () => {
    const { spec, field, part } = setup("../notes/a.md", { readOnly: true });
    expect(part("choose")).toBeNull();
    expect(part("clear")).toBeNull();
    drop(field, "refs", "directory");
    expect(spec.onChange).not.toHaveBeenCalled();
    part("entry").click();
    expect(spec.openPath).toHaveBeenCalledWith("notes/a.md");
  });
});

describe("a setting's folder field", () => {
  const folder = (path: string, children: SpaceTreeNode[] = []): SpaceTreeNode => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "directory",
    children,
  });

  function folderSetup(value: string, inherited?: { path: string; scope: string; from: string }) {
    const world = folder("film/story/world");
    const story = folder("film/story", [folder("film/story/screenplay"), world]);
    listing.folders = new Map([
      ["film", folder("film", [folder("film/shots"), story])],
      ["film/story", story],
      ["film/story/world", world],
    ]);
    const openFolder = vi.fn();
    const result = setup(
      value,
      {
        docPath: "film/AGENTS.md",
        folders: { within: "film", isOpen: (path) => path === "film/story", openFolder, inherited },
      },
      [
        ["film", "directory"],
        ["film/story/world", "directory"],
      ],
    );
    return { ...result, openFolder };
  }

  const chooser = () => document.body.querySelector(".folder-chooser");
  const rowNames = () =>
    [...(chooser()?.querySelectorAll(".node-label") ?? [])].map((row) => row.querySelector(".node-name")?.textContent);

  it("opens a chooser over the context's own folders from its whole name, open as the sidebar is", () => {
    const { part } = folderSetup("");
    part("entry").click();
    expect(rowNames()).toEqual(["shots", "story", "screenplay", "world"]);
    chooser()?.remove();
  });

  it("writes a picked folder from its AGENTS.md, by the scope rule", () => {
    const { part, spec } = folderSetup("");
    part("entry").click();
    const shots = [...(chooser()?.querySelectorAll<HTMLElement>(".node-label") ?? [])].find(
      (row) => row.dataset.path === "film/shots",
    );
    shots?.click();
    expect(spec.onChange).toHaveBeenCalledWith("shots/");
    expect(chooser()).toBeNull();
  });

  it("searches folder names, keeping the folders above a match", () => {
    const { part } = folderSetup("");
    part("entry").click();
    const search = chooser()?.querySelector("input") as HTMLInputElement;
    search.value = "wor";
    search.dispatchEvent(new Event("input"));
    expect(rowNames()).toEqual(["story", "world"]);
    chooser()?.remove();
  });

  const value = (field: HTMLElement) => field.querySelector(".context-setting-value");

  it("shows its folder as the path from its context, the context's own by its name", () => {
    expect(value(folderSetup("story/world/").field)?.textContent).toBe("story/world");
    expect(value(folderSetup("./").field)?.textContent).toBe("film");
  });

  it("says when its folder is gone, still from its context, and when it names none inside it", () => {
    const gone = value(folderSetup("story/drafts/").field);
    expect(gone?.classList.contains("is-missing")).toBe(true);
    expect(gone?.firstChild?.textContent).toBe("Missing:");
    expect(gone?.querySelector(".path-label")?.textContent).toBe("story/drafts");
    const { field } = folderSetup("../notes/");
    expect(value(field)?.textContent).toBe("Names no folder here");
    expect(field.classList.contains("is-empty")).toBe(false);
  });

  it("shows what an enclosing context gives while it holds nothing, from that context, with nothing to clear", () => {
    const { field } = folderSetup("", { path: "film/story/world", scope: "", from: "the space" });
    expect(value(field)?.classList.contains("is-inherited")).toBe(true);
    expect(value(field)?.querySelector(".path-label")?.textContent).toBe("film/story/world");
    expect(value(field)?.querySelector(".context-setting-from")?.textContent).toBe("from the space");
    expect(field.classList.contains("is-empty")).toBe(true);
  });

  it("goes back to None once cleared", () => {
    const { field, part } = folderSetup("story/world/");
    part("clear").click();
    expect(value(field)?.textContent).toBe("None");
    expect(field.classList.contains("is-empty")).toBe(true);
  });

  it("takes only a folder from inside its context when one is dropped on it", () => {
    const { field, spec } = folderSetup("");
    drop(field, "film/notes.md");
    drop(field, "elsewhere/", "directory");
    expect(spec.onChange).not.toHaveBeenCalled();
    expect(spec.notify).toHaveBeenCalledTimes(2);
    drop(field, "film/shots", "directory");
    expect(spec.onChange).toHaveBeenCalledWith("shots/");
  });
});
