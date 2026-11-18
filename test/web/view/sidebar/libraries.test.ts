// @vitest-environment jsdom
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { LibraryRow, SpaceTreeNode } from "../../../../web/core/apiClient.ts";
import { isWritableRoot } from "../../../../web/core/libraries.ts";
import type { ListItemTarget } from "../../../../web/lib/listItemMenu.ts";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import type { DialogService, FormOptions, PromptOptions } from "../../../../web/services/dialog.ts";
import { setLocalSort } from "../../../../web/services/folderSorts.ts";
import { createMenus, type MenuOpenOptions } from "../../../../web/services/menus.ts";
import * as settings from "../../../../web/services/settings.ts";
import type { TreeRenderContext } from "../../../../web/view/fileTreeView.ts";
import {
  createLibrariesView,
  createLibraryManager,
  type LibrariesViewDeps,
  type LibraryLocationBridge,
  type LibraryTreeActions,
} from "../../../../web/view/sidebar/libraries.ts";

vi.mock("../../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/core/apiClient.ts")>()),
  postLocalSort: vi.fn(async () => undefined),
}));

function library(id: string, missing = false, access: LibraryRow["access"] = "read-only"): LibraryRow {
  return { id, label: `Library ${id}`, path: `/media/${id}`, access, missing };
}

const tree: SpaceTreeNode[] = [{ name: "a.png", path: "a.png", type: "file" } as SpaceTreeNode];

// The glyph before a dialog's title, from the options it was opened with.
const iconOf = (options: unknown) => (options as { icon?: { glyph?: string } }).icon?.glyph;

type DrawTree = (nodes: SpaceTreeNode[], listPath: string, ctx: TreeRenderContext) => void;
type TestDeps = LibrariesViewDeps & { renderTree: Mock<DrawTree> };

function deps(overrides: Partial<LibrariesViewDeps> = {}): TestDeps {
  // Every tree the panel creates draws through this one spy, so a test reads
  // what was drawn, and under which list path, without holding the tree.
  const renderTree = vi.fn<DrawTree>();
  return {
    fetchLibraries: vi.fn(async () => ({ libraries: [library("one"), library("two")] })),
    // Every folder lists the same entries unless a test says otherwise.
    fetchLibraryFolder: vi.fn(async () => ({ entries: tree, changes: "1.0" })),
    forgetLibraryTree: vi.fn(),
    onChanged: vi.fn(),
    followLibrary: vi.fn(() => vi.fn()),
    createTree: vi.fn((listPath: string) => {
      const element = document.createElement("ul");
      element.className = "rendered";
      const render = (nodes: SpaceTreeNode[], ctx: TreeRenderContext) => renderTree(nodes, listPath, ctx);
      return { element, render, hasRow: () => false, reveal: () => false, dispose: vi.fn() };
    }),
    renderTree,
    showExtensions: () => false,
    createMenuButton: vi.fn(() => document.createElement("button")),
    openTreeMenu: vi.fn(),
    createEntry: vi.fn(async (parentPath: string, name: string, type: "file" | "directory") => ({
      path: `${parentPath}/${name}`,
      type,
    })),
    moveEntry: vi.fn(async () => undefined),
    notify: vi.fn(),
    importFiles: vi.fn(async (files: readonly File[], dir: string) => ({
      imported: files.map((file) => `${dir}/${file.name}`),
      refused: [],
      failed: [],
      cancelled: false,
    })),
    openItem: vi.fn(),
    openDirectory: vi.fn(),
    show: vi.fn(),
    collapsed: { isCollapsed: vi.fn(() => true), setCollapsed: vi.fn(), expand: vi.fn(), reveal: vi.fn(() => false) },
    ...overrides,
  };
}

async function shown(d: LibrariesViewDeps) {
  const libraries = createLibrariesView(d);
  libraries.view.onShow?.();
  await vi.waitFor(() => expect(d.fetchLibraries).toHaveBeenCalled());
  await Promise.resolve();
  return libraries;
}

function headers(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(".list-item"));
}

function bodyOf(header: HTMLElement): HTMLElement {
  return header.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  settings.sidebarLibrary.set("");
});

describe("createLibrariesView", () => {
  it("renders one row per library, name over path", async () => {
    const { view } = await shown(deps());
    const rows = headers(view.panel);
    expect(rows.map((r) => r.querySelector(".list-item-title")?.textContent)).toEqual(["Library one", "Library two"]);
    expect(rows.map((r) => r.querySelector(".list-item-subtitle")?.textContent)).toEqual(["/media/one", "/media/two"]);
    expect(view.id).toBe("library");
    expect(view.label).toBe("Libraries");
  });

  // Properties stops typing at 80 characters; one written by hand past that
  // is cut in the tooltip alone, never in the file.
  it("shows a library's description as its row's tooltip, cut at 80 characters", async () => {
    const long = `${"word ".repeat(20)}end`;
    const d = deps({
      fetchLibraries: vi.fn(async () => ({
        libraries: [
          { ...library("one"), description: "Frames from the shoot" },
          { ...library("two"), description: long },
          library("three"),
        ],
      })),
    });
    const { view } = await shown(d);
    const [described, cut, plain] = headers(view.panel);

    expect(described.dataset.tooltip).toBe("Frames from the shoot");
    expect(cut.dataset.tooltip).toBe(`${long.slice(0, 79).trimEnd()}…`);
    expect(Array.from(cut.dataset.tooltip ?? "").length).toBeLessThanOrEqual(80);
    expect(plain.dataset.tooltip).toBeUndefined();
    expect(vi.mocked(d.createMenuButton).mock.calls[0][1]).toMatchObject({ description: "Frames from the shoot" });
  });

  // A library root lives outside the space, so it can vanish while the space
  // is perfectly intact — an unmounted drive, a moved folder, or a space
  // synced to a second machine where none of the paths exist. The row has to
  // degrade into something fixable rather than something mysterious.
  it("marks a library whose folder is gone, and refuses to expand it", async () => {
    const d = deps({ fetchLibraries: vi.fn(async () => ({ libraries: [library("one", true), library("two")] })) });
    const { view } = await shown(d);
    const [gone, fine] = headers(view.panel);

    expect(gone.classList.contains("is-unavailable")).toBe(true);
    expect(gone.querySelector(".list-item-subtitle")?.textContent).toBe("Folder not found: /media/one");
    expect(fine.classList.contains("is-unavailable")).toBe(false);

    // Nothing to walk, so the click is inert — the row stays collapsed and
    // no request goes out for a tree that cannot exist.
    gone.click();
    await Promise.resolve();
    expect(d.fetchLibraryFolder).not.toHaveBeenCalled();
    expect(gone.getAttribute("aria-expanded")).toBe("false");
  });

  // The space travels and its folders don't: on a computer that has never
  // located a library, the row says so, with no path to show and nothing to
  // expand, and its ⋮ keeps Locate.
  it("marks a library this computer hasn't located", async () => {
    const unlocated: LibraryRow = { id: "one", label: "Library one", access: "read-only", missing: true };
    const d = deps({ fetchLibraries: vi.fn(async () => ({ libraries: [unlocated] })) });
    const { view } = await shown(d);
    const [row] = headers(view.panel);

    expect(row.classList.contains("is-unavailable")).toBe(true);
    expect(row.querySelector(".list-item-subtitle")?.textContent).toBe("Not located on this computer");
    expect(vi.mocked(d.createMenuButton).mock.calls[0][1]).toEqual({
      kind: "library",
      id: "one",
      label: "Library one",
      path: undefined,
      access: "read-only",
      missing: true,
    });
    row.click();
    await Promise.resolve();
    expect(d.fetchLibraryFolder).not.toHaveBeenCalled();
  });

  // Locate is the only way back for a missing library, and it lives on the
  // row's own ⋮ menu — so the row has to say which library it is, and that
  // it is missing, for the command's `when` to gate on.
  it("passes each row's identity and state to its menu button", async () => {
    const d = deps({ fetchLibraries: vi.fn(async () => ({ libraries: [library("one", true), library("two")] })) });
    await shown(d);

    expect(vi.mocked(d.createMenuButton).mock.calls.map(([, target]) => target)).toEqual([
      { kind: "library", id: "one", label: "Library one", path: "/media/one", access: "read-only", missing: true },
      { kind: "library", id: "two", label: "Library two", path: "/media/two", access: "read-only", missing: false },
    ]);
  });

  // Adding a library means picking a folder outside the space, which
  // only the Electron shell can do — so the button exists exactly when that
  // capability does, rather than being drawn and then failing.
  it("offers the add button only when a way to add one was supplied", async () => {
    const withAdd = await shown(deps({ addLibrary: vi.fn(async () => undefined) }));
    expect(withAdd.view.panel.querySelector(".sidebar-title-action")).not.toBeNull();

    const without = await shown(deps());
    expect(without.view.panel.querySelector(".sidebar-title-action")).toBeNull();
  });

  // Handed the button, which the add menu opens under.
  it("the add button runs the supplied add", async () => {
    const addLibrary = vi.fn(async () => undefined);
    const { view } = await shown(deps({ addLibrary }));
    const button = view.panel.querySelector<HTMLButtonElement>(".sidebar-title-action");
    button?.click();
    expect(addLibrary).toHaveBeenCalledWith(button);
  });

  it("shows the empty and failure states", async () => {
    const emptyView = await shown(deps({ fetchLibraries: vi.fn(async () => ({ libraries: [] })) }));
    expect(emptyView.view.panel.querySelector(".sidebar-panel-empty")?.textContent).toBe(
      "No libraries in this space yet.",
    );

    // A `_libraries.json` that doesn't read says why, where the list would be.
    const problem = "_libraries.json doesn't parse: Unexpected token";
    const broken = await shown(deps({ fetchLibraries: vi.fn(async () => ({ libraries: [], problem })) }));
    expect(broken.view.panel.querySelector(".sidebar-panel-empty")?.textContent).toBe(problem);

    const failed = await shown(deps({ fetchLibraries: vi.fn(async () => Promise.reject(new Error("x"))) }));
    expect(failed.view.panel.querySelector(".sidebar-panel-empty")?.textContent).toBe("Failed to load libraries.");
  });

  it("expanding a row fetches its tree and renders it read-only", async () => {
    const d = deps();
    const { view } = await shown(d);
    const [one] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(bodyOf(one).querySelector(".rendered")).not.toBeNull());

    expect(d.fetchLibraryFolder).toHaveBeenCalledWith("one", "");
    // The list's own rooted path, not "": a library's top level is
    // `lib:<id>`, which is what a create row under it has to match.
    expect(d.renderTree).toHaveBeenCalledWith(tree, "lib:one", expect.objectContaining({ readOnly: true }));
    expect(one.getAttribute("aria-expanded")).toBe("true");
  });

  // The panel names the root once instead of re-rooting each path on the way
  // out; composing the rooted form per row is the tree's job.
  it("tells the tree which library it is rendering", async () => {
    const d = deps();
    const { view } = await shown(d);
    headers(view.panel)[1].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());

    expect(vi.mocked(d.renderTree).mock.calls[0][2].root).toEqual({ library: "two" });
  });

  // Opening is a read, so the read-only tree still reports clicks; what a
  // click may open is this panel's rule. The walk already narrowed the tree
  // to kinds that render read-only, so the panel opens whatever it was given
  // rather than filtering twice.
  it("opens every kind the tree listed, at the path the tree reported", async () => {
    const d = deps();
    const { view } = await shown(d);
    headers(view.panel)[0].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());
    const ctx = vi.mocked(d.renderTree).mock.calls[0][2];

    for (const path of ["lib:one/notes.md", "lib:one/shots.table.html", "lib:one/looks.class.html"]) {
      ctx.onOpen(path, document.createElement("div"));
    }
    expect(vi.mocked(d.openItem).mock.calls.map(([p]) => p)).toEqual([
      "lib:one/notes.md",
      "lib:one/shots.table.html",
      "lib:one/looks.class.html",
    ]);
  });

  // A read-only library's folder opens too: its gallery only reads.
  it("opens a folder's gallery at the path the tree reported", async () => {
    const d = deps();
    const { view } = await shown(d);
    headers(view.panel)[0].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());
    const ctx = vi.mocked(d.renderTree).mock.calls[0][2];
    expect(ctx.readOnly).toBe(true);

    ctx.onOpenDirectory?.("lib:one/shots");
    expect(d.openDirectory).toHaveBeenCalledWith("lib:one/shots");
  });

  // A library's tree lists by name, so a sort picked for one of its folders
  // re-lists what shows it, the galleries, and leaves the tree as it is.
  it("re-lists the galleries, not its tree, when a library folder's sort changes", async () => {
    const d = deps();
    const { view } = await shown(d);
    headers(view.panel)[0].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());
    const listed = vi.mocked(d.fetchLibraryFolder).mock.calls.length;
    vi.mocked(d.onChanged).mockClear();

    await setLocalSort("lib:one/shots", { by: "name", order: "desc" });
    expect(d.onChanged).toHaveBeenCalledTimes(1);
    expect(d.fetchLibraryFolder).toHaveBeenCalledTimes(listed);
    await setLocalSort("shots", null);
    expect(d.onChanged).toHaveBeenCalledTimes(1);
  });

  // Collapse state is shared with the space tree, so it has to survive the
  // panel being switched away from and back.
  it("shares one collapse store with the rest of the app and never clears it", async () => {
    const collapsed = {
      isCollapsed: vi.fn(() => true),
      setCollapsed: vi.fn(),
      expand: vi.fn(),
      reveal: vi.fn(() => false),
    };
    const d = deps({ collapsed });
    const { view } = await shown(d);
    const [one, two] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());
    const ctx = vi.mocked(d.renderTree).mock.calls[0][2];
    expect(ctx.isCollapsed).toBe(collapsed.isCollapsed);

    two.click();
    await vi.waitFor(() => expect(bodyOf(two).querySelector(".rendered")).not.toBeNull());
    expect(collapsed.setCollapsed).not.toHaveBeenCalled();
  });

  // Where the user was survives a reload and a trip to another panel: the
  // open library is remembered per browser, and collapsing it is remembered
  // as "open nothing".
  it("re-opens the library it last had open, and forgets it once collapsed", async () => {
    settings.sidebarLibrary.set("two");
    const d = deps();
    const libraries = await shown(d);
    await vi.waitFor(() => expect(d.fetchLibraryFolder).toHaveBeenCalledWith("two", ""));
    expect(headers(libraries.view.panel)[1].getAttribute("aria-expanded")).toBe("true");

    headers(libraries.view.panel)[1].click(); // collapse it
    expect(settings.sidebarLibrary.get()).toBe("");
    headers(libraries.view.panel)[0].click();
    await vi.waitFor(() => expect(settings.sidebarLibrary.get()).toBe("one"));

    // A remembered library that is no longer registered opens nothing.
    settings.sidebarLibrary.set("gone");
    const again = await shown(deps());
    await Promise.resolve();
    expect(headers(again.view.panel).every((row) => row.getAttribute("aria-expanded") === "false")).toBe(true);
  });

  // An explicit reveal wins over the memory, once.
  it("reveal() opens the asked-for library over the remembered one", async () => {
    settings.sidebarLibrary.set("one");
    const d = deps();
    const libraries = await shown(d);
    libraries.reveal("two");
    libraries.view.onShow?.();
    await vi.waitFor(() => expect(d.fetchLibraryFolder).toHaveBeenCalledWith("two", ""));
  });

  // A library's name shown elsewhere (the status bar's path root) navigates
  // here: the panel comes to the front with that library already open.
  it("reveal shows the panel and expands that library", async () => {
    const d = deps();
    const libraries = await shown(d);

    libraries.reveal("two");
    expect(d.show).toHaveBeenCalled();
    // Showing the panel re-lists the libraries, so the expansion has to
    // survive that refresh rather than being applied before it.
    libraries.view.onShow?.();
    await vi.waitFor(() => expect(d.fetchLibraryFolder).toHaveBeenCalledWith("two", ""));
    await vi.waitFor(() => expect(headers(libraries.view.panel)[1].getAttribute("aria-expanded")).toBe("true"));
  });

  // A folder bookmark comes up here as a space one does in the Space view.
  // Its row waits for every open folder to list: "a", above it, listing
  // after it would push the row back out of view.
  it("revealFolder opens a folder in its library, then centres and flashes its row once", async () => {
    const listed: Record<string, SpaceTreeNode[]> = {
      "": [
        { name: "a", path: "a", type: "directory" },
        { name: "shots", path: "shots", type: "directory" },
      ],
      shots: [{ name: "day1", path: "shots/day1", type: "directory" }],
      "shots/day1": [{ name: "b.png", path: "shots/day1/b.png", type: "file" }],
    };
    let listA: (value: { entries: SpaceTreeNode[] }) => void = () => {};
    const fetchLibraryFolder = vi.fn((_id: string, dir: string) =>
      dir === "a"
        ? new Promise<{ entries: SpaceTreeNode[] }>((resolve) => {
            listA = resolve;
          })
        : Promise.resolve({ entries: listed[dir] }),
    );
    const collapsed = { isCollapsed: vi.fn(() => false), setCollapsed: vi.fn(), expand: vi.fn(), reveal: vi.fn() };
    const label = document.createElement("span");
    label.className = "node-label";
    label.dataset.path = "lib:two/shots/day1";
    const render = vi.fn<(nodes: SpaceTreeNode[], ctx: TreeRenderContext) => void>();
    const reveal = vi.fn(() => true);
    const createTree = vi.fn(() => {
      const element = document.createElement("ul");
      element.append(label);
      return { element, render, hasRow: () => true, reveal, dispose: vi.fn() };
    });
    const d = deps({ fetchLibraryFolder, collapsed, createTree });
    const libraries = await shown(d);

    libraries.revealFolder("lib:two/shots/day1");
    expect(collapsed.reveal).toHaveBeenCalledWith("lib:two/shots/day1");
    expect(collapsed.expand).toHaveBeenCalledWith("lib:two/shots/day1");
    expect(d.show).toHaveBeenCalled();
    libraries.view.onShow?.();
    await vi.waitFor(() =>
      expect(render).toHaveBeenLastCalledWith(
        [listed[""][0], { ...listed[""][1], children: [{ ...listed.shots[0], children: listed["shots/day1"] }] }],
        expect.anything(),
      ),
    );
    expect(headers(libraries.view.panel)[1].getAttribute("aria-expanded")).toBe("true");
    expect(reveal).not.toHaveBeenCalled();

    listA({ entries: [] });
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("lib:two/shots/day1"));
    expect(label.classList.contains("flash")).toBe(true);

    // A folder opened afterwards lists without pulling the view back.
    render.mock.calls[0][1].onToggleCollapse("lib:two/shots/day1", false);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("collapsing or switching clears the previous body", async () => {
    const d = deps();
    const { view } = await shown(d);
    const [one, two] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(bodyOf(one).querySelector(".rendered")).not.toBeNull());

    two.click();
    expect(bodyOf(one).childElementCount).toBe(0);
    expect(bodyOf(one).hidden).toBe(true);
    await vi.waitFor(() => expect(bodyOf(two).querySelector(".rendered")).not.toBeNull());

    two.click();
    expect(bodyOf(two).childElementCount).toBe(0);
    expect(two.getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores a tree that arrives after the row was switched away from", async () => {
    type Listing = { entries: SpaceTreeNode[] };
    let resolveOne: (value: Listing) => void = () => {};
    const fetchLibraryFolder = vi.fn((id: string) =>
      id === "one"
        ? new Promise<Listing>((resolve) => {
            resolveOne = resolve;
          })
        : Promise.resolve({ entries: tree }),
    );
    const d = deps({ fetchLibraryFolder });
    const { view } = await shown(d);
    const [one, two] = headers(view.panel);

    one.click();
    two.click();
    resolveOne({ entries: tree });
    await vi.waitFor(() => expect(bodyOf(two).querySelector(".rendered")).not.toBeNull());

    expect(bodyOf(one).childElementCount).toBe(0);
    expect(d.renderTree).toHaveBeenCalledTimes(1);
  });

  it("reports a failed tree fetch inside the row, naming what went wrong", async () => {
    const d = deps({ fetchLibraryFolder: vi.fn(async () => Promise.reject(new Error("Unknown library"))) });
    const { view } = await shown(d);
    const [one] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(bodyOf(one).textContent).toBe("Unknown library"));
  });

  // A library lists a folder at a time: only its top level until a folder
  // opens, so how big it is never decides how fast it opens.
  it("lists a folder when it opens, and draws its entries under it", async () => {
    const top: SpaceTreeNode[] = [{ name: "shots", path: "shots", type: "directory" }];
    const shots: SpaceTreeNode[] = [{ name: "a.png", path: "shots/a.png", type: "file" }];
    const fetchLibraryFolder = vi.fn(async (_id: string, dir: string) => ({ entries: dir === "" ? top : shots }));
    const collapsed = {
      isCollapsed: vi.fn(() => true),
      setCollapsed: vi.fn(),
      expand: vi.fn(),
      reveal: vi.fn(() => false),
    };
    const d = deps({ fetchLibraryFolder, collapsed });
    const { view } = await shown(d);

    headers(view.panel)[0].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalledWith(top, "lib:one", expect.anything()));
    expect(fetchLibraryFolder).toHaveBeenCalledTimes(1);

    const ctx = d.renderTree.mock.calls[0][2];
    collapsed.isCollapsed.mockReturnValue(false);
    ctx.onToggleCollapse("lib:one/shots", false);
    expect(collapsed.setCollapsed).toHaveBeenCalledWith("lib:one/shots", false);
    await vi.waitFor(() => expect(fetchLibraryFolder).toHaveBeenCalledWith("one", "shots"));
    await vi.waitFor(() =>
      expect(d.renderTree).toHaveBeenLastCalledWith([{ ...top[0], children: shots }], "lib:one", expect.anything()),
    );
  });

  const nested: Record<string, SpaceTreeNode[]> = {
    "": [{ name: "shots", path: "shots", type: "directory" }],
    shots: [{ name: "day1", path: "shots/day1", type: "directory" }],
    "shots/day1": [{ name: "a.png", path: "shots/day1/a.png", type: "file" }],
  };

  it("lists the folders it remembers open, as soon as their parents list", async () => {
    const fetchLibraryFolder = vi.fn(async (_id: string, dir: string) => ({ entries: nested[dir] }));
    const collapsed = {
      isCollapsed: vi.fn(() => false),
      setCollapsed: vi.fn(),
      expand: vi.fn(),
      reveal: vi.fn(() => false),
    };
    const d = deps({ fetchLibraryFolder, collapsed });
    const { view } = await shown(d);

    headers(view.panel)[0].click();
    await vi.waitFor(() =>
      expect(d.renderTree).toHaveBeenLastCalledWith(
        [{ ...nested[""][0], children: [{ ...nested.shots[0], children: nested["shots/day1"] }] }],
        "lib:one",
        expect.anything(),
      ),
    );
  });

  // A change made outside this window lands the way a write here does.
  it("follows the open library for outside changes, and re-lists it when one comes", async () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    let changed = () => {};
    let read = () => undefined as string | undefined;
    const followLibrary = vi.fn((_id: string, readAt: () => string | undefined, onChanged: () => void) => {
      read = readAt;
      changed = onChanged;
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const d = deps({ followLibrary });
    const { view } = await shown(d);
    const [one, two] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(d.fetchLibraryFolder).toHaveBeenCalledWith("one", ""));
    expect(followLibrary).toHaveBeenLastCalledWith("one", expect.any(Function), expect.any(Function));
    // Followed from the version its listing was read at.
    expect(read()).toBe("1.0");

    vi.mocked(d.fetchLibraryFolder).mockClear();
    changed();
    await vi.waitFor(() => expect(d.fetchLibraryFolder).toHaveBeenCalledWith("one", ""));

    two.click();
    expect(stops[0]).toHaveBeenCalled();
    expect(followLibrary).toHaveBeenLastCalledWith("two", expect.any(Function), expect.any(Function));
  });

  it("re-lists every listed folder on a reload, and forgets the tree its links resolve against", async () => {
    const fetchLibraryFolder = vi.fn(async (_id: string, dir: string) => ({ entries: nested[dir] }));
    const collapsed = {
      isCollapsed: vi.fn(() => false),
      setCollapsed: vi.fn(),
      expand: vi.fn(),
      reveal: vi.fn(() => false),
    };
    const d = deps({ fetchLibraryFolder, collapsed });
    const libraries = await shown(d);
    headers(libraries.view.panel)[0].click();
    await vi.waitFor(() => expect(fetchLibraryFolder).toHaveBeenCalledWith("one", "shots/day1"));
    await Promise.resolve();

    fetchLibraryFolder.mockClear();
    await libraries.tree.reload();
    expect(fetchLibraryFolder.mock.calls.map(([, dir]) => dir).sort()).toEqual(["", "shots", "shots/day1"]);
    expect(d.forgetLibraryTree).toHaveBeenCalledWith("one");
  });

  it("says it is loading while a slow library has listed nothing yet", async () => {
    vi.useFakeTimers();
    try {
      let resolveFull: (value: { entries: SpaceTreeNode[] }) => void = () => {};
      const d = deps({
        fetchLibraryFolder: vi.fn(
          () =>
            new Promise<{ entries: SpaceTreeNode[] }>((resolve) => {
              resolveFull = resolve;
            }),
        ),
      });
      const { view } = await shown(d);
      const [one] = headers(view.panel);

      one.click();
      expect(bodyOf(one).querySelector(".tree-loading")).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(bodyOf(one).querySelector(".tree-loading")?.textContent).toBe("Loading…");

      resolveFull({ entries: tree });
      await vi.advanceTimersByTimeAsync(0);
      expect(bodyOf(one).querySelector(".tree-loading")).toBeNull();
      expect(bodyOf(one).querySelector(".rendered")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a generic message when the failure carries none", async () => {
    const d = deps({ fetchLibraryFolder: vi.fn(async () => Promise.reject("nope")) });
    const { view } = await shown(d);
    const [one] = headers(view.panel);

    one.click();
    await vi.waitFor(() => expect(bodyOf(one).textContent).toBe("Failed to load library contents."));
  });
});

// The row actions live on commands rather than in the panel, so they are
// exercised through the registries the app wires them into.
describe("createLibraryManager", () => {
  const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

  function target(overrides: Partial<Extract<ListItemTarget, { kind: "library" }>> = {}): ListItemTarget {
    return {
      kind: "library",
      id: "one",
      label: "Library one",
      path: "/media/one",
      access: "read-only",
      missing: false,
      ...overrides,
    };
  }

  // A dialog that answers the way the real one does: the form runs `submit`
  // with every field's value and resolves them, and confirm resolves
  // `confirmed`. `choose` is the permission chosen, undefined standing for
  // Cancel, and `describeAs` is typed into the description.
  //
  // `renameTo` is what the Rename prompt is answered with: null cancels it,
  // and undefined submits the name it opened with.
  function manager(
    choose: string | undefined,
    {
      withBridge = true,
      confirmed = true,
      renameTo = undefined as string | null | undefined,
      describeAs = undefined as string | undefined,
    } = {},
  ) {
    const commands = createCommands();
    const menus = createMenus(commands);
    const form = vi.fn(async (options: FormOptions) => {
      if (choose === undefined) return null;
      const values = Object.fromEntries(options.fields.map((field) => [field.id, field.value ?? ""]));
      if ("access" in values) values.access = choose;
      if (describeAs !== undefined) values.description = describeAs;
      await options.submit?.(values);
      return values;
    });
    const confirm = vi.fn(async () => confirmed);
    const prompt = vi.fn(async (options: PromptOptions) => {
      if (renameTo === null) return null;
      const value = renameTo ?? options.value ?? "";
      await options.submit?.(value);
      return value;
    });
    const setLibraryLabel = vi.fn(async () => undefined);
    const setLibraryDescription = vi.fn(async () => undefined);
    const bridge: LibraryLocationBridge = {
      libraryOffers: vi.fn(async () => []),
      addLibrary: vi.fn(async () => undefined),
      relocateLibrary: vi.fn(async () => undefined),
    };
    const contextMenu = { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) };
    const setLibraryAccess = vi.fn(async () => undefined);
    const removeLibrary = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const deleteEntry = vi.fn(async () => undefined);
    const onDeleted = vi.fn();
    const reveal = vi.fn();
    const trash = { on: true };
    const tree: LibraryTreeActions = {
      startCreate: vi.fn(),
      startRename: vi.fn(),
      create: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
    };
    const { addLibrary } = createLibraryManager({
      commands,
      menus,
      dialog: () => ({ form, confirm, prompt }) as unknown as DialogService,
      bridge: withBridge ? bridge : undefined,
      contextMenu,
      setLibraryAccess,
      setLibraryLabel,
      setLibraryDescription,
      removeLibrary,
      deleteEntry,
      moveToTrash: () => trash.on,
      onDeleted,
      tree,
      refresh,
      reveal,
    });
    return {
      trash,
      commands,
      menus,
      form,
      confirm,
      prompt,
      setLibraryAccess,
      setLibraryLabel,
      setLibraryDescription,
      removeLibrary,
      refresh,
      deleteEntry,
      onDeleted,
      reveal,
      tree,
      bridge,
      contextMenu,
      addLibrary,
    };
  }

  // A folder another space uses is one click away; a menu holding only
  // Choose folder… would stand between the button and the picker.
  describe("adding from the button", () => {
    const button = () => document.createElement("button");
    const offer = (space: string, id: string, label: string) => ({ space, id, label, path: `/media/${id}` });

    it("opens the picker straight away when no other space has a folder to offer", async () => {
      const { bridge, contextMenu, addLibrary } = manager(undefined);
      await addLibrary(button());
      expect(bridge.libraryOffers).toHaveBeenCalledOnce();
      expect(contextMenu.open).not.toHaveBeenCalled();
      expect(bridge.addLibrary).toHaveBeenCalledWith();
    });

    it("offers the folders other spaces use above Choose folder…, adding a pick by its space and id", async () => {
      const { bridge, contextMenu, addLibrary, reveal } = manager(undefined);
      vi.mocked(bridge.libraryOffers).mockResolvedValueOnce([
        offer("spc_a", "personas", "Personas"),
        offer("spc_b", "art", "Art"),
      ]);
      vi.mocked(bridge.addLibrary).mockResolvedValueOnce({
        id: "personas",
        label: "Personas",
        path: "/media/personas",
        access: "read-only",
      });
      const anchor = button();
      await addLibrary(anchor);

      expect(bridge.addLibrary).not.toHaveBeenCalled();
      const options = contextMenu.open.mock.calls[0][0] as MenuOpenOptions;
      expect(options).toMatchObject({ anchor, ariaLabel: "Add library" });
      const items = options.items ?? [];
      expect(items.map((item) => [item.label, item.description, item.group])).toEqual([
        ["Personas", "/media/personas", "offers"],
        ["Art", "/media/art", "offers"],
        ["Choose folder…", undefined, "picker"],
      ]);

      await items[0].run?.(context, undefined);
      expect(bridge.addLibrary).toHaveBeenLastCalledWith({ space: "spc_a", id: "personas" });
      expect(reveal).toHaveBeenCalledWith("personas");
      await items[2].run?.(context, undefined);
      expect(bridge.addLibrary).toHaveBeenLastCalledWith();
    });

    it("closes its menu when the button is clicked again, asking for nothing", async () => {
      const { bridge, contextMenu, addLibrary } = manager(undefined);
      contextMenu.isOpen.mockReturnValueOnce(true);
      await addLibrary(button());
      expect(contextMenu.close).toHaveBeenCalledOnce();
      expect(bridge.libraryOffers).not.toHaveBeenCalled();
      expect(bridge.addLibrary).not.toHaveBeenCalled();
    });

    it("says why an offer couldn't be added", async () => {
      const { bridge, contextMenu, addLibrary, confirm } = manager(undefined);
      vi.mocked(bridge.libraryOffers).mockResolvedValueOnce([offer("spc_a", "art", "Art")]);
      vi.mocked(bridge.addLibrary).mockRejectedValueOnce(new Error("No other space on this computer has that library"));
      await addLibrary(button());
      await (contextMenu.open.mock.calls[0][0] as MenuOpenOptions).items?.[0].run?.(context, undefined);
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Add library", message: "No other space on this computer has that library" }),
      );
    });
  });

  // A plain re-read would open the library the panel last had open, leaving
  // the one just picked shut at the bottom of the list.
  it("opens a library once it is added, and nothing when the picker is cancelled", async () => {
    const added = manager(undefined);
    vi.mocked(added.bridge.addLibrary).mockResolvedValueOnce({
      id: "new",
      label: "new",
      path: "/media/new",
      access: "read-only",
    });
    await added.addLibrary();
    expect(added.reveal).toHaveBeenCalledWith("new");

    const cancelled = manager(undefined);
    await cancelled.addLibrary();
    expect(cancelled.reveal).not.toHaveBeenCalled();
    expect(cancelled.refresh).not.toHaveBeenCalled();
  });

  // The status bar's path names a library by its top folder. Only the top:
  // a reveal opens the library, never a folder inside it.
  it("offers Show in Libraries on a library's top folder alone, and reveals that library", async () => {
    const { commands, reveal } = manager("read-only");
    expect(commands.isEnabled("library.show", context, { folder: "lib:one", ownView: true })).toBe(true);
    expect(commands.isEnabled("library.show", context, { folder: "lib:one/batch", ownView: true })).toBe(false);
    expect(commands.isEnabled("library.show", context, { folder: "notes", ownView: true })).toBe(false);
    expect(commands.isEnabled("library.show", context, target())).toBe(false);
    await commands.run("library.show", context, { folder: "lib:one", ownView: true });
    expect(reveal).toHaveBeenCalledWith("one");
  });

  // Rename, Properties and Remove name no path, so they are offered on every
  // target; only Locate needs the native picker.
  it("offers Rename, Properties and Remove on a library row, with or without the bridge", () => {
    const { commands, menus } = manager("read-only");
    expect(commands.isEnabled("library.properties", context, target())).toBe(true);
    expect(commands.isEnabled("library.properties", context, { kind: "site", path: "x" })).toBe(false);
    expect(commands.isEnabled("library.properties", context, undefined)).toBe(false);
    // The description is the space's, so even a library never located here
    // has Properties to edit it in.
    expect(commands.isEnabled("library.properties", context, target({ missing: true }))).toBe(true);
    expect(commands.isEnabled("library.properties", context, target({ missing: true, path: undefined }))).toBe(true);
    expect(
      menus.resolve("listItem", context, target({ missing: true, path: undefined })).map((item) => item.label),
    ).toEqual(["Rename…", "Locate…", "Properties…", "Remove from list"]);
    expect(menus.resolve("listItem", context, target()).map((item) => item.label)).toEqual([
      "Rename…",
      "Properties…",
      "Remove from list",
    ]);
    expect(menus.resolve("listItem", context, target({ missing: true })).map((item) => item.label)).toEqual([
      "Rename…",
      "Locate…",
      "Properties…",
      "Remove from list",
    ]);

    const { menus: withoutBridge } = manager("read-only", { withBridge: false });
    expect(withoutBridge.resolve("listItem", context, target({ missing: true })).map((item) => item.label)).toEqual([
      "Rename…",
      "Properties…",
      "Remove from list",
    ]);
  });

  // Only the label changes: the id every `lib:<id>/…` path was written with
  // stays, and the folder keeps its name.
  it("renames a library through a prompt, a missing one too, then re-reads the panel", async () => {
    const { commands, prompt, setLibraryLabel, refresh } = manager("read-only", { renameTo: "Archive" });
    expect(commands.isEnabled("library.rename", context, target({ missing: true }))).toBe(true);
    expect(commands.isEnabled("library.rename", context, { kind: "site", path: "x" })).toBe(false);
    await commands.run("library.rename", context, target());
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: "Rename library", value: "Library one" }));
    expect(iconOf(prompt.mock.calls[0][0])).toBe("library");
    expect(setLibraryLabel).toHaveBeenCalledWith("one", "Archive");
    expect(refresh).toHaveBeenCalled();
  });

  it("writes nothing for a cancelled or unchanged name", async () => {
    const cancelled = manager("read-only", { renameTo: null });
    await cancelled.commands.run("library.rename", context, target());
    expect(cancelled.setLibraryLabel).not.toHaveBeenCalled();
    expect(cancelled.refresh).not.toHaveBeenCalled();

    const unchanged = manager("read-only");
    await unchanged.commands.run("library.rename", context, target());
    expect(unchanged.setLibraryLabel).not.toHaveBeenCalled();
  });

  it("offers New Folder at a writable library's root only", async () => {
    const { commands, menus, tree } = manager("read-only");
    const writable = target({ access: "read-write" });
    expect(commands.isEnabled("library.newFolder", context, target())).toBe(false);
    expect(commands.isEnabled("library.newFolder", context, target({ access: "read-write", missing: true }))).toBe(
      false,
    );
    expect(menus.resolve("listItem", context, writable).map((item) => item.label)).toEqual([
      "New Folder",
      "Rename…",
      "Properties…",
      "Remove from list",
    ]);

    await commands.run("library.newFolder", context, writable);
    expect(tree.startCreate).toHaveBeenCalledWith({ libraryId: "one", node: null }, "directory");
  });

  it("opens on the row's description and access, both permission choices on offer", async () => {
    const { commands, form } = manager(undefined);
    await commands.run("library.properties", context, target({ access: "read-write", description: "Frames" }));

    const options = form.mock.calls[0][0];
    expect(options.title).toBe("Library properties");
    expect(iconOf(options)).toBe("library");
    expect(options.message).toBe("Library one (/media/one)");
    const [description, access] = options.fields;
    expect(options.fields).toHaveLength(2);
    expect(description).toMatchObject({ id: "description", label: "Description", value: "Frames", maxLength: 80 });
    expect(access).toMatchObject({ id: "access", value: "read-write", description: "This computer only." });
    expect(access.choices?.map((choice) => choice.value)).toEqual(["read-only", "read-write"]);
  });

  it("opens on the description alone for a library this computer hasn't located", async () => {
    const { commands, form } = manager(undefined);
    await commands.run("library.properties", context, target({ missing: true, path: undefined }));

    const options = form.mock.calls[0][0];
    expect(options.message).toBe("Library one (Not located on this computer)");
    expect(options.fields.map((field) => field.id)).toEqual(["description"]);
  });

  it("saves a changed description, trimmed, then re-reads the panel", async () => {
    const { commands, setLibraryDescription, setLibraryAccess, refresh } = manager("read-only", {
      describeAs: "  Frames from the shoot  ",
    });
    await commands.run("library.properties", context, target());

    expect(setLibraryDescription).toHaveBeenCalledWith("one", "Frames from the shoot");
    expect(setLibraryAccess).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("takes a description away when it is emptied, located here or not", async () => {
    const { commands, setLibraryDescription } = manager("read-only", { describeAs: " " });
    await commands.run("library.properties", context, target({ description: "Frames" }));
    await commands.run("library.properties", context, target({ description: "Reels", path: undefined }));

    expect(setLibraryDescription.mock.calls).toEqual([
      ["one", ""],
      ["one", ""],
    ]);
  });

  it("saves a changed permission, then re-reads the panel", async () => {
    const { commands, setLibraryAccess, refresh } = manager("read-write");
    await commands.run("library.properties", context, target());

    expect(setLibraryAccess).toHaveBeenCalledWith("one", "read-write");
    // The row carries its permission into the next open, so it has to be
    // rebuilt from the registry.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the description and permission are left as they were", async () => {
    const { commands, setLibraryAccess, setLibraryDescription, refresh } = manager("read-only");
    await commands.run("library.properties", context, target({ description: "Frames" }));

    expect(setLibraryAccess).not.toHaveBeenCalled();
    expect(setLibraryDescription).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("writes nothing on cancel", async () => {
    const { commands, setLibraryAccess, setLibraryDescription, refresh } = manager(undefined, { describeAs: "New" });
    await commands.run("library.properties", context, target());

    expect(setLibraryAccess).not.toHaveBeenCalled();
    expect(setLibraryDescription).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes a library after confirmation, then re-reads the panel", async () => {
    const { commands, confirm, removeLibrary, refresh } = manager(undefined);
    await commands.run("library.remove", context, target());

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(iconOf((confirm.mock.calls[0] as unknown[])[0])).toBe("library");
    expect(removeLibrary).toHaveBeenCalledWith("one");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // The half that makes a delete safe: a tab still pointing at the file
  // would recreate it on its next save, so the editor is told, with the
  // rooted path every tab holds.
  it("deletes a library entry into its trash and drops the tabs on it", async () => {
    const { commands, confirm, deleteEntry, onDeleted, tree } = manager(undefined);
    const node = { name: "a.md", path: "batch/a.md", type: "file" } as SpaceTreeNode;
    await commands.run("libraryTree.delete", context, { libraryId: "one", node, writable: true });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(deleteEntry).toHaveBeenCalledWith("lib:one/batch/a.md", expect.any(Boolean));
    expect(onDeleted).toHaveBeenCalledWith("lib:one/batch/a.md");
    expect(tree.reload).toHaveBeenCalledTimes(1);
  });

  // Red stays either way: the Trash has no Restore, so a trashed file can't
  // simply be put back. Only the words follow the setting.
  it("names the delete after the trash setting, in the menu and the dialog", async () => {
    const { commands, confirm, deleteEntry, menus, trash } = manager(undefined);
    const node = { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode;
    const arg = { libraryId: "one", node, writable: true };
    const deleteItem = () => menus.resolve("libraryTree", context, arg).find((item) => item.danger);
    expect(deleteItem()?.label).toBe("Move to Trash");
    await commands.run("libraryTree.delete", context, arg);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Move a.md to Trash", confirmLabel: "Move to Trash", danger: true }),
    );
    expect(deleteEntry).toHaveBeenLastCalledWith("lib:one/a.md", true);

    trash.on = false;
    expect(deleteItem()?.label).toBe("Delete");
    await commands.run("libraryTree.delete", context, arg);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Delete a.md", confirmLabel: "Delete", danger: true }),
    );
    expect(deleteEntry).toHaveBeenLastCalledWith("lib:one/a.md", false);
  });

  // The setting is the server's and can change while a confirmation is open:
  // the delete does what that confirmation said, never what the setting says
  // by the time it is accepted.
  it("deletes the way the confirmation said, even if the setting changed meanwhile", async () => {
    const { commands, confirm, deleteEntry, trash } = manager(undefined);
    confirm.mockImplementationOnce(async () => {
      trash.on = false;
      return true;
    });
    await commands.run("libraryTree.delete", context, {
      libraryId: "one",
      node: { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode,
      writable: true,
    });
    expect(deleteEntry).toHaveBeenCalledWith("lib:one/a.md", true);
  });

  it("drops no tab when the delete itself failed", async () => {
    const { commands, deleteEntry, onDeleted } = manager(undefined);
    vi.mocked(deleteEntry).mockRejectedValueOnce(new Error("Not found"));
    await commands.run("libraryTree.delete", context, {
      libraryId: "one",
      node: { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode,
      writable: true,
    });
    expect(deleteEntry).toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  // The tree's menu opens on a read-only library's folders too, so every
  // action that writes answers for itself; a target without the flag is
  // read-only.
  it("offers no write on a target drawn read-only", () => {
    const { commands } = manager(undefined);
    const folder = { name: "batch", path: "batch", type: "directory" } as SpaceTreeNode;
    for (const id of ["libraryTree.newNote", "libraryTree.newFolder", "libraryTree.rename", "libraryTree.delete"]) {
      expect(commands.isEnabled(id, context, { libraryId: "one", node: folder, writable: false }), id).toBe(false);
      expect(commands.isEnabled(id, context, { libraryId: "one", node: folder }), id).toBe(false);
      expect(commands.isEnabled(id, context, { libraryId: "one", node: folder, writable: true }), id).toBe(true);
    }
  });

  // Opened from a gallery tile, the tree's menu has the name typed there.
  it("types a rename or a create on the surface that opened the menu", async () => {
    const { commands, tree } = manager(undefined);
    const naming = { rename: vi.fn(), create: vi.fn() };
    const node = { name: "a.md", path: "notes/a.md", type: "file" } as SpaceTreeNode;
    const folder = { name: "batch", path: "batch", type: "directory" } as SpaceTreeNode;

    const onFile = { libraryId: "one", node, writable: true, naming };
    await commands.run("libraryTree.rename", context, onFile);
    expect(tree.startRename).not.toHaveBeenCalled();
    expect(naming.rename).toHaveBeenCalledWith("lib:one/notes/a.md", expect.any(Function));
    naming.rename.mock.calls[0][1]("b.md");
    expect(tree.rename).toHaveBeenCalledWith(onFile, "b.md");

    await commands.run("libraryTree.newFolder", context, { libraryId: "one", node: folder, writable: true, naming });
    expect(tree.startCreate).not.toHaveBeenCalled();
    expect(naming.create).toHaveBeenCalledWith(
      { parentPath: "lib:one/batch", type: "directory" },
      expect.any(Function),
    );
    naming.create.mock.calls[0][1]("Shots");
    expect(tree.create).toHaveBeenCalledWith("lib:one/batch", "directory", "Shots");
  });

  it("removes nothing when the confirmation is declined", async () => {
    const { commands, removeLibrary, refresh } = manager(undefined, { confirmed: false });
    await commands.run("library.remove", context, target());

    expect(removeLibrary).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// Permission drives what the tree offers. A read-only library renders
// exactly as it always did; a read-write one gets the inline inputs and the
// context menu, and every path it names is rooted.
describe("a writable library's tree", () => {
  const writableDeps = (overrides: Partial<LibrariesViewDeps> = {}) =>
    deps({ fetchLibraries: vi.fn(async () => ({ libraries: [library("one", false, "read-write")] })), ...overrides });

  async function expanded(d: TestDeps) {
    const libraries = await shown(d);
    headers(libraries.view.panel)[0].click();
    await vi.waitFor(() => expect(d.renderTree).toHaveBeenCalled());
    return libraries;
  }

  const contextOf = (d: TestDeps) =>
    vi.mocked(d.renderTree).mock.calls[vi.mocked(d.renderTree).mock.calls.length - 1][2];

  it("renders unlocked, and a read-only one stays locked", async () => {
    const writable = writableDeps();
    await expanded(writable);
    expect(contextOf(writable).readOnly).toBe(false);

    const readOnly = deps();
    await expanded(readOnly);
    expect(contextOf(readOnly).readOnly).toBe(true);
  });

  // The tab lock reads the same listing this panel draws from, so a library
  // opened in the editor is editable exactly when its rows are.
  it("publishes the permissions it listed, so the tab lock agrees", async () => {
    await shown(writableDeps());
    expect(isWritableRoot({ library: "one" })).toBe(true);

    await shown(deps());
    expect(isWritableRoot({ library: "one" })).toBe(false);
    // The space is always writable; nothing about a library changes that.
    expect(isWritableRoot("space")).toBe(true);
  });

  // A read-only library's folders still open as a gallery from the menu; its
  // files have nothing to offer, so they open none.
  it("opens the tree menu with the permission it drew, and a read-only one on folders only", async () => {
    const writable = writableDeps();
    await expanded(writable);
    const node: SpaceTreeNode = { name: "a.md", path: "notes/a.md", type: "file" } as SpaceTreeNode;
    const folder: SpaceTreeNode = { name: "notes", path: "notes", type: "directory" } as SpaceTreeNode;
    contextOf(writable).onContextMenu(new MouseEvent("contextmenu"), node);
    expect(writable.openTreeMenu).toHaveBeenCalledWith(expect.any(MouseEvent), {
      libraryId: "one",
      node,
      writable: true,
    });

    const readOnly = deps();
    await expanded(readOnly);
    contextOf(readOnly).onContextMenu(new MouseEvent("contextmenu"), node);
    expect(readOnly.openTreeMenu).not.toHaveBeenCalled();
    contextOf(readOnly).onContextMenu(new MouseEvent("contextmenu"), folder);
    expect(readOnly.openTreeMenu).toHaveBeenCalledWith(expect.any(MouseEvent), {
      libraryId: "one",
      node: folder,
      writable: false,
    });
  });

  // The space tree acts on the node its own dragstart reported, so a library
  // row reporting none is what keeps it inert when dropped there.
  it("never reports a drag start, writable or not", async () => {
    const d = writableDeps();
    await expanded(d);
    const node: SpaceTreeNode = { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode;
    expect(contextOf(d).onDragStart([node])).toBeUndefined();
  });

  // jsdom has no DragEvent; a drop is a plain event carrying a file list.
  function fileDrop(...names: string[]): DragEvent {
    const event = new Event("drop") as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: names.map((name) => new File([new Uint8Array(8)], name)), types: ["Files"] },
    });
    return event;
  }

  // The gesture the feature exists for: a take dragged off the desktop
  // lands in the folder it was dropped on, or beside the file it was dropped
  // on, in that library's own root — then the tree is re-read and the file
  // opened.
  it("copies dropped desktop files into the dropped-on folder and opens the last", async () => {
    const d = writableDeps();
    await expanded(d);
    const folder = { name: "batch", path: "batch", type: "directory", children: [] } as SpaceTreeNode;
    contextOf(d).onDrop(fileDrop("take.mp4", "still.png"), folder, "into");
    await vi.waitFor(() => expect(d.importFiles).toHaveBeenCalled());
    const [files, dir] = vi.mocked(d.importFiles).mock.calls[0];
    expect(dir).toBe("lib:one/batch");
    expect(files.map((f) => f.name)).toEqual(["take.mp4", "still.png"]);
    await vi.waitFor(() => expect(d.openItem).toHaveBeenCalledWith("lib:one/batch/still.png"));
    expect(d.fetchLibraryFolder).toHaveBeenCalledTimes(2);

    const file = { name: "one.md", path: "batch/one.md", type: "file" } as SpaceTreeNode;
    contextOf(d).onDrop(fileDrop("b.mp4"), file, "before");
    await vi.waitFor(() => expect(d.importFiles).toHaveBeenCalledTimes(2));
    expect(vi.mocked(d.importFiles).mock.calls[1][1]).toBe("lib:one/batch");
  });

  // A tree row's drag carries its rooted path as text/plain.
  function rowDrop(rootedPath: string): DragEvent {
    const event = new Event("drop") as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [], types: ["text/plain"], getData: () => rootedPath },
    });
    return event;
  }

  it("moves a row dropped into another folder of the same library", async () => {
    const d = writableDeps();
    await expanded(d);
    const folder = { name: "batch", path: "batch", type: "directory", children: [] } as SpaceTreeNode;
    contextOf(d).onDrop(rowDrop("lib:one/notes/a.md"), folder, "into");
    await vi.waitFor(() => expect(d.moveEntry).toHaveBeenCalledWith("lib:one/notes/a.md", "lib:one/batch/a.md"));

    const sibling = { name: "b.md", path: "b.md", type: "file" } as SpaceTreeNode;
    contextOf(d).onDrop(rowDrop("lib:one/notes/a.md"), sibling, "after");
    await vi.waitFor(() => expect(d.moveEntry).toHaveBeenCalledWith("lib:one/notes/a.md", "lib:one/a.md"));
    expect(d.importFiles).not.toHaveBeenCalled();
  });

  // Between roots a move is a copy, which the move route refuses; a library
  // keeps no binder order, so a drop beside a sibling changes nothing.
  it("ignores a row from another root, into its own folder, or into itself", async () => {
    const d = writableDeps();
    await expanded(d);
    const folder = { name: "batch", path: "batch", type: "directory", children: [] } as SpaceTreeNode;
    const nested = { name: "inner", path: "batch/inner", type: "directory", children: [] } as SpaceTreeNode;
    const sibling = { name: "b.md", path: "notes/b.md", type: "file" } as SpaceTreeNode;
    contextOf(d).onDrop(rowDrop("notes/a.md"), folder, "into");
    contextOf(d).onDrop(rowDrop("lib:two/a.md"), folder, "into");
    contextOf(d).onDrop(rowDrop("lib:one/notes/a.md"), sibling, "before");
    contextOf(d).onDrop(rowDrop("lib:one/batch"), nested, "into");
    contextOf(d).onDrop(rowDrop("lib:one/batch"), folder, "into");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.moveEntry).not.toHaveBeenCalled();
  });

  it("reports a move the server refused", async () => {
    const d = writableDeps({ moveEntry: vi.fn(async () => Promise.reject(new Error("nope"))) });
    await expanded(d);
    const folder = { name: "batch", path: "batch", type: "directory", children: [] } as SpaceTreeNode;
    contextOf(d).onDrop(rowDrop("lib:one/a.md"), folder, "into");
    await vi.waitFor(() => expect(d.notify).toHaveBeenCalledWith("nope"));
  });

  it("a row dropped on the panel outside the rows moves to the library's root", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);
    libraries.view.panel.dispatchEvent(rowDrop("lib:one/notes/a.md"));
    await vi.waitFor(() => expect(d.moveEntry).toHaveBeenCalledWith("lib:one/notes/a.md", "lib:one/a.md"));
  });

  it("tells the person what did not land", async () => {
    const d = writableDeps({
      importFiles: vi.fn(async () => ({ imported: [], refused: ["x.zip"], failed: [], cancelled: false })),
    });
    await expanded(d);
    contextOf(d).onDrop(fileDrop("x.zip"), { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode, "into");
    await vi.waitFor(() => expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("x.zip")));
  });

  // A drop that misses every writable row must not fall through to the
  // browser, which would open the file in place of the app.
  it("catches a drop on a read-only library's panel and says why", async () => {
    const d = deps();
    const libraries = await expanded(d);
    libraries.view.panel.dispatchEvent(fileDrop("take.mp4"));
    expect(d.importFiles).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("read-only"));
  });

  it("a drop on the panel outside the rows lands in the open writable library's root", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);
    libraries.view.panel.dispatchEvent(fileDrop("take.mp4"));
    await vi.waitFor(() => expect(d.importFiles).toHaveBeenCalled());
    expect(vi.mocked(d.importFiles).mock.calls[0][1]).toBe("lib:one");
  });

  it("creates under the clicked folder, in that library's root, then opens the file", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);
    const folder: SpaceTreeNode = { name: "notes", path: "notes", type: "directory", children: [] } as SpaceTreeNode;

    libraries.tree.startCreate({ libraryId: "one", node: folder }, "file");
    expect(contextOf(d).pendingCreate).toEqual({ parentPath: "lib:one/notes", type: "file" });

    contextOf(d).onCreateSubmit({ parentPath: "lib:one/notes", type: "file" }, "  take  ");
    await vi.waitFor(() => expect(d.createEntry).toHaveBeenCalled());
    expect(d.createEntry).toHaveBeenCalledWith("lib:one/notes", "take", "file");
    // The tree is re-read rather than patched, so what shows is what the
    // filesystem answered.
    await vi.waitFor(() => expect(d.openItem).toHaveBeenCalledWith("lib:one/notes/take"));
    expect(d.fetchLibraryFolder).toHaveBeenCalledTimes(2);
  });

  // A file holds no children, so a create started on one lands beside it.
  it("creates beside a file, and at the library root for the empty area", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);

    libraries.tree.startCreate(
      { libraryId: "one", node: { name: "a.md", path: "notes/a.md", type: "file" } as SpaceTreeNode },
      "directory",
    );
    expect(contextOf(d).pendingCreate).toEqual({ parentPath: "lib:one/notes", type: "directory" });

    libraries.tree.startCreate({ libraryId: "one", node: null }, "file");
    expect(contextOf(d).pendingCreate).toEqual({ parentPath: "lib:one", type: "file" });
  });

  // Started from a collapsed row's ⋮, the input row needs a tree to sit in.
  it("opens the library first when a create starts on a collapsed one", async () => {
    const d = writableDeps();
    const libraries = await shown(d);
    expect(d.renderTree).not.toHaveBeenCalled();

    await libraries.tree.startCreate({ libraryId: "one", node: null }, "directory");
    expect(d.fetchLibraryFolder).toHaveBeenCalledWith("one", "");
    expect(headers(libraries.view.panel)[0].getAttribute("aria-expanded")).toBe("true");
    expect(contextOf(d).pendingCreate).toEqual({ parentPath: "lib:one", type: "directory" });
  });

  it("renames in place, naming both ends rooted", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);
    const node: SpaceTreeNode = { name: "a.md", path: "notes/a.md", type: "file" } as SpaceTreeNode;

    libraries.tree.startRename({ libraryId: "one", node });
    expect(contextOf(d).editingPath).toBe("lib:one/notes/a.md");

    contextOf(d).onRenameSubmit(node, "b.md");
    await vi.waitFor(() => expect(d.moveEntry).toHaveBeenCalled());
    expect(d.moveEntry).toHaveBeenCalledWith("lib:one/notes/a.md", "lib:one/notes/b.md");
  });

  it("writes nothing when a rename is emptied or unchanged", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);
    const node: SpaceTreeNode = { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode;

    libraries.tree.startRename({ libraryId: "one", node });
    contextOf(d).onRenameSubmit(node, "   ");
    contextOf(d).onRenameSubmit(node, "a.md");
    await Promise.resolve();
    expect(d.moveEntry).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of leaving the row half-renamed", async () => {
    const d = writableDeps({ moveEntry: vi.fn(async () => Promise.reject(new Error("Already exists"))) });
    const libraries = await expanded(d);
    const node: SpaceTreeNode = { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode;

    libraries.tree.startRename({ libraryId: "one", node });
    contextOf(d).onRenameSubmit(node, "b.md");
    await vi.waitFor(() => expect(d.notify).toHaveBeenCalledWith("Already exists"));
  });

  it("cancelling clears the inline input without writing", async () => {
    const d = writableDeps();
    const libraries = await expanded(d);

    libraries.tree.startCreate({ libraryId: "one", node: null }, "file");
    contextOf(d).onCreateCancel();
    expect(contextOf(d).pendingCreate).toBeUndefined();

    libraries.tree.startRename({
      libraryId: "one",
      node: { name: "a.md", path: "a.md", type: "file" } as SpaceTreeNode,
    });
    contextOf(d).onRenameCancel();
    expect(contextOf(d).editingPath).toBeUndefined();
    expect(d.createEntry).not.toHaveBeenCalled();
    expect(d.moveEntry).not.toHaveBeenCalled();
  });

  // A gallery tile's name is typed on the tile, so the library needn't be
  // open here; a gallery lists from disk too, and is told the library changed.
  it("writes a name typed elsewhere, and says the library changed", async () => {
    const d = writableDeps();
    const libraries = await shown(d);
    const node: SpaceTreeNode = { name: "a.md", path: "notes/a.md", type: "file" } as SpaceTreeNode;

    await libraries.tree.rename({ libraryId: "one", node }, "b.md");
    expect(d.moveEntry).toHaveBeenCalledWith("lib:one/notes/a.md", "lib:one/notes/b.md");

    await libraries.tree.create("lib:one/notes", "file", "take");
    expect(d.createEntry).toHaveBeenCalledWith("lib:one/notes", "take", "file");
    expect(d.openItem).toHaveBeenCalledWith("lib:one/notes/take");
    expect(d.onChanged).toHaveBeenCalledTimes(1);
  });
});
