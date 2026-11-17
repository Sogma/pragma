import { describe, expect, it, vi } from "vitest";
import type { FileResponse, HistoryVersion, LayoutTab, Tab, TextFileResponse } from "../../../web/core/apiClient.ts";
import type { Tabs, TabsDeps } from "../../../web/services/tabs.ts";

// The one group a fresh workspace module seeds.
const GROUP = "group-1";

function noteFile(path: string): TextFileResponse {
  return {
    kind: "text",
    path,
    revision: "rev-1",
    documentType: "note",
    content: "# Song\n",
    toolkits: [],
    classLinks: [],
  };
}

// What /api/space/layout answers: the groups, left to right.
function persisted(
  groups: { tabs: LayoutTab[]; activeTabIndex: number; readingView?: boolean; sourceMode?: boolean }[],
  focusedGroup = 0,
) {
  return vi.fn(async () => ({ groups, focusedGroup, collapsedFolders: [], expandedFolders: [] }));
}

// The launch main.ts runs: the saved tabs, then, with the tree drawn, what
// each group shows.
async function launch(tabs: Tabs): Promise<void> {
  await tabs.restore();
  await tabs.showRestored();
}

// Files served at once but for `slow`, which answers only once `arrive` is
// called: a read still under way when the writer clicks.
function heldBack(slow: string) {
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const loadFile = vi.fn(async (path: string): Promise<FileResponse> => {
    if (path === slow) await arrived;
    return noteFile(path);
  });
  return { arrive, loadFile };
}

// workspace is a module-level singleton, so each test gets a fresh module
// graph — the service binds to the same fresh instance the test inspects.
async function setup(overrides: Partial<TabsDeps> = {}) {
  vi.resetModules();
  const workspace = await import("../../../web/core/workspace.ts");
  const { createTabs } = await import("../../../web/services/tabs.ts");

  // Every call the service makes outward, in order, so a test can assert
  // sequencing rather than only counts.
  const log: string[] = [];
  const deps: TabsDeps = {
    documents: {
      adopt: vi.fn((file: TextFileResponse) => {
        log.push(`adopt ${file.path}`);
        return {} as never;
      }),
      release: vi.fn(async (path: string) => void log.push(`release ${path}`)),
      get: vi.fn(() => undefined),
    },
    loadFile: vi.fn(async (path: string): Promise<FileResponse> => noteFile(path)),
    loadLayout: persisted([]),
    saveGroups: vi.fn(async () => undefined),
    flush: vi.fn(async () => void log.push("flush")),
    mount: vi.fn(
      async (_group: unknown, tab: Tab) => void log.push(`mount ${tab.kind}${"path" in tab ? ` ${tab.path}` : ""}`),
    ),
    renderStrip: vi.fn(() => void log.push("strip")),
    revealInTree: vi.fn(() => true),
    notify: vi.fn(),
    openElsewhere: vi.fn(),
    ...overrides,
  };
  const tabs = createTabs(deps);
  tabs.onActivate((_group, tab) => log.push(`activate ${tab.kind}`));
  const closed = vi.fn(() => void log.push("group closed"));
  tabs.onGroupClosed(closed);
  return { tabs, deps, workspace, log, closed };
}

describe("restore", () => {
  it("falls back to one empty tab, announced but not mounted, when nothing is persisted", async () => {
    const { tabs, workspace, log } = await setup();
    await launch(tabs);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "empty" }]);
    expect(log).toEqual(["activate empty", "strip"]);
  });

  it("restores every tab reading no file, then reads only the one each group shows", async () => {
    const { tabs, workspace, log, deps } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "b.md" },
            { kind: "document", path: "data.zip" },
            { kind: "pdf", path: "c.pdf" },
            { kind: "document", path: "a.fountain" },
          ],
          activeTabIndex: 3,
        },
      ]),
    });
    await tabs.restore();
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "document", path: "b.md", documentType: "note", deferred: true },
      { kind: "pdf", path: "c.pdf" },
      { kind: "document", path: "a.fountain", documentType: "screenplay", deferred: true },
    ]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(2);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(log).toEqual([]);

    await tabs.showRestored();
    expect(deps.loadFile).toHaveBeenCalledExactlyOnceWith("a.fountain");
    expect(deps.documents.adopt).toHaveBeenCalledTimes(1);
    expect(workspace.activeTab()).toEqual({ kind: "document", path: "a.fountain", documentType: "screenplay" });
    expect(log.slice(-3)).toEqual(["activate document", "strip", "mount document a.fountain"]);
  });

  it("brings back a document's saved place, dropping one that doesn't read as a place", async () => {
    const place = { line: 40.25, caret: { line: 42, column: 7 } };
    const { tabs, workspace } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md", place },
            { kind: "document", path: "b.md", place: { line: "top" } } as unknown as LayoutTab,
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await tabs.restore();
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "document", path: "a.md", documentType: "note", deferred: true, place },
      { kind: "document", path: "b.md", documentType: "note", deferred: true },
    ]);
  });

  it("saves a document tab's place with the layout once a pane writes one", async () => {
    const { tabs, workspace, deps } = await setup();
    await tabs.openEntry("a.md");
    vi.mocked(deps.saveGroups).mockClear();
    const tab = workspace.activeTab();
    if (tab.kind !== "document") throw new Error("a.md isn't open");
    tab.place = { line: 3, caret: { line: 4, column: 0 } };
    tabs.placeChanged();
    expect(deps.saveGroups).toHaveBeenCalledExactlyOnceWith(
      [
        {
          tabs: [{ kind: "document", path: "a.md", place: { line: 3, caret: { line: 4, column: 0 } } }],
          activeTabIndex: 0,
          readingView: false,
          sourceMode: false,
        },
      ],
      0,
    );
  });

  it("brings back a Flow's saved view, dropping one that doesn't read as a view", async () => {
    const viewport = { x: -120, y: 40.5, zoom: 0.75 };
    const { tabs, workspace } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "flow", path: "a.flow.html", viewport },
            { kind: "flow", path: "b.flow.html", viewport: { x: 0, y: 0, zoom: 0 } },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await tabs.restore();
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "flow", path: "a.flow.html", viewport },
      { kind: "flow", path: "b.flow.html" },
    ]);
  });

  it("saves a Flow tab's view with the layout once its pane writes one", async () => {
    const { tabs, workspace, deps } = await setup({
      loadLayout: persisted([{ tabs: [{ kind: "flow", path: "a.flow.html" }], activeTabIndex: 0 }]),
    });
    await tabs.restore();
    vi.mocked(deps.saveGroups).mockClear();
    const tab = workspace.activeTab();
    if (tab.kind !== "flow") throw new Error("a.flow.html isn't open");
    tab.viewport = { x: 40, y: -20, zoom: 2 };
    tabs.placeChanged();
    expect(deps.saveGroups).toHaveBeenCalledExactlyOnceWith(
      [
        {
          tabs: [{ kind: "flow", path: "a.flow.html", viewport: { x: 40, y: -20, zoom: 2 } }],
          activeTabIndex: 0,
          readingView: false,
          sourceMode: false,
        },
      ],
      0,
    );
  });

  it("reads a restored tab's file when it is switched to, announcing it once the model is in", async () => {
    const { tabs, workspace, log, deps } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md" },
            { kind: "document", path: "b.md" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await launch(tabs);
    log.length = 0;
    await tabs.switchTo(GROUP, 1);

    expect(deps.loadFile).toHaveBeenLastCalledWith("b.md");
    expect(deps.documents.adopt).toHaveBeenCalledTimes(2);
    expect(deps.documents.release).not.toHaveBeenCalled();
    expect(workspace.focusedGroup().tabs[1]).toEqual({ kind: "document", path: "b.md", documentType: "note" });
    expect(log).toEqual(["flush", "strip", "adopt b.md", "activate document", "strip", "mount document b.md"]);
  });

  it("empties a tab whose file is gone as it shows, saying why only when the writer switched to it", async () => {
    const gone = vi.fn(async (path: string): Promise<FileResponse> => {
      if (path.startsWith("gone")) throw new Error(`File not found: ${path}`);
      return noteFile(path);
    });
    const { tabs, workspace, deps } = await setup({
      loadFile: gone,
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "gone-1.md" },
            { kind: "document", path: "gone-2.md" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await launch(tabs);
    expect(workspace.focusedGroup().tabs[0]).toEqual({ kind: "empty" });
    expect(deps.notify).not.toHaveBeenCalled();

    await tabs.switchTo(GROUP, 1);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "empty" }, { kind: "empty" }]);
    expect(deps.notify).toHaveBeenCalledExactlyOnceWith("File not found: gone-2.md");
    expect(deps.documents.adopt).not.toHaveBeenCalled();
  });

  it("leaves a group a tree click reached before the restored tabs showed as the click made it", async () => {
    const { tabs, workspace, deps, log } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md" },
            { kind: "image", path: "b.png" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await tabs.restore();
    await tabs.openEntry("clicked.md");
    await tabs.showRestored();

    expect(workspace.focusedGroup().tabs.map((tab) => (tab.kind === "empty" ? "empty" : tab.path))).toEqual([
      "clicked.md",
      "b.png",
    ]);
    expect(deps.loadFile).toHaveBeenCalledExactlyOnceWith("clicked.md");
    expect(deps.documents.release).not.toHaveBeenCalled(); // the restored tab it replaced held nothing
    expect(log.filter((entry) => entry.startsWith("mount"))).toEqual(["mount document clicked.md"]);
    expect(tabs.canGo("back")).toBe(true); // to the restored tab, as after any click in place
  });

  it("lets an open win over a restored tab still reading its file", async () => {
    const read = heldBack("a.md");
    const { tabs, workspace, deps, log } = await setup({
      loadFile: read.loadFile,
      loadLayout: persisted([{ tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0 }]),
    });
    await tabs.restore();
    const showing = tabs.showRestored();
    await vi.waitFor(() => expect(read.loadFile).toHaveBeenCalledWith("a.md"));
    await tabs.openEntry("clicked.md");
    read.arrive();
    await showing;

    expect(workspace.activeTab()).toMatchObject({ kind: "document", path: "clicked.md" });
    expect(deps.documents.adopt).toHaveBeenCalledTimes(1);
    expect(log.filter((entry) => entry.startsWith("mount"))).toEqual(["mount document clicked.md"]);
  });

  it("releases nothing for a restored tab never shown, closed or replaced", async () => {
    const { tabs, deps } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md" },
            { kind: "document", path: "b.md" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await launch(tabs);
    await tabs.close(GROUP, 1);
    await tabs.close(GROUP, 0);
    expect(deps.documents.release).toHaveBeenCalledExactlyOnceWith("a.md");
  });

  it("reads a restored tab's file before moving it to the other group", async () => {
    const { tabs, workspace, deps, log } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md" },
            { kind: "document", path: "b.md" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await launch(tabs);
    await tabs.moveToOtherGroup(GROUP, 1);

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(right.tabs).toEqual([{ kind: "document", path: "b.md", documentType: "note" }]);
    expect(deps.documents.adopt).toHaveBeenCalledTimes(2);
    expect(log.at(-1)).toBe("mount document b.md");
  });
});

describe("a file Pragma can't open", () => {
  it("never becomes a tab: what else it can do shows beside the element it came from", async () => {
    const { tabs, workspace, deps } = await setup();
    await launch(tabs);
    const from = { anchor: {} as HTMLElement, marked: true };
    await tabs.openEntry("data/budget.zip", { from });
    expect(deps.openElsewhere).toHaveBeenCalledWith("data/budget.zip", from);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "empty" }]);
  });

  it("is reached from a link like any path the tree reveals", async () => {
    const { tabs, deps } = await setup();
    await launch(tabs);
    await tabs.openSpacePath("budget.csv");
    expect(deps.revealInTree).toHaveBeenCalledWith("budget.csv");
    expect(deps.openElsewhere).toHaveBeenCalledWith("budget.csv", undefined);
  });

  it("opens no side group to show nothing in", async () => {
    const { tabs, workspace, deps } = await setup();
    await launch(tabs);
    await tabs.openToSide("budget.zip");
    expect(deps.openElsewhere).toHaveBeenCalledWith("budget.zip", undefined);
    expect(workspace.groups()).toHaveLength(1);
  });

  it("never comes back from a saved session", async () => {
    const { tabs, workspace, deps } = await setup({
      loadLayout: persisted([
        {
          tabs: [
            { kind: "document", path: "a.md" },
            { kind: "document", path: "renamed.zip" },
          ],
          activeTabIndex: 0,
        },
      ]),
    });
    await launch(tabs);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(deps.loadFile).not.toHaveBeenCalledWith("renamed.zip");
  });
});

describe("a Class", () => {
  it("opens in a tab of its own kind, and comes back from the layout as one", async () => {
    const classFile = { kind: "class", path: "shots/shots.class.html", revision: "rev-1" };
    const { tabs, workspace, log } = await setup({
      loadFile: vi.fn(async (path: string) =>
        path.endsWith(".class.html") ? (classFile as unknown as FileResponse) : noteFile(path),
      ),
    });
    await tabs.openEntry("shots/shots.class.html");
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "class", path: "shots/shots.class.html" }]);
    expect(log.at(-1)).toBe("mount class shots/shots.class.html");

    const restored = await setup({
      loadLayout: persisted([{ tabs: [{ kind: "class", path: "shots/shots.class.html" }], activeTabIndex: 0 }]),
    });
    await launch(restored.tabs);
    expect(restored.workspace.focusedGroup().tabs).toEqual([{ kind: "class", path: "shots/shots.class.html" }]);
  });
});

describe("recentPaths", () => {
  it("starts from the restored tabs, active first, and moves each activation to the front", async () => {
    const { tabs } = await setup({
      loadLayout: persisted([
        {
          tabs: [{ kind: "document", path: "a.md" }, { kind: "empty" }, { kind: "image", path: "b.png" }],
          activeTabIndex: 2,
        },
      ]),
    });
    await launch(tabs);
    expect(tabs.recentPaths()).toEqual(["b.png", "a.md"]);
    await tabs.openEntry("c.md");
    await tabs.openEntry("a.md");
    expect(tabs.recentPaths()).toEqual(["a.md", "c.md", "b.png"]);
  });
});

describe("openAppletCode", () => {
  it("converts the tab already showing the applet instead of opening it a second time", async () => {
    const applet = { kind: "applet", path: "tools/a.applet.html", source: "<html></html>" } as unknown as FileResponse;
    const { tabs, workspace } = await setup({ loadFile: vi.fn(async () => applet) });
    await tabs.openEntry("tools/a.applet.html");
    await tabs.openNew(GROUP);
    await tabs.openAppletCode("tools/a.applet.html");
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "applet-source", path: "tools/a.applet.html" },
      { kind: "empty" },
    ]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
  });

  it("Run Applet writes the code's queued edit before the running view reads the file", async () => {
    const applet = { kind: "applet", path: "tool.applet.html", revision: "rev-1" } as unknown as FileResponse;
    const { tabs, workspace, log } = await setup({
      loadFile: vi.fn(async () => {
        log.push("load");
        return applet;
      }),
    });
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    log.length = 0;

    await tabs.runApplet("tool.applet.html");
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(log.indexOf("flush")).toBeLessThan(log.indexOf("load"));
    expect(log.at(-1)).toBe("mount applet tool.applet.html");
  });
});

describe("an open's view", () => {
  it("opens an Applet asked for as code straight into Edit code, fetched once", async () => {
    const applet = { kind: "applet", path: "tool.applet.html", revision: "rev-1" } as unknown as FileResponse;
    const { tabs, workspace, deps } = await setup({ loadFile: vi.fn(async () => applet) });
    await tabs.openEntry("tool.applet.html", { view: "code" });
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(deps.loadFile).toHaveBeenCalledTimes(1);
    expect(deps.mount).toHaveBeenCalledTimes(1);
  });

  it("opens a file whose kind has no such view as it would have", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md", { view: "code" });
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
  });
});

describe("openEntry", () => {
  it("adopts the model, announces before mounting, and hands the pane the fetched file", async () => {
    const { tabs, deps, workspace, log } = await setup();
    await tabs.openEntry("notes/a.md");
    expect(workspace.activeTab()).toEqual({ kind: "document", path: "notes/a.md", documentType: "note" });
    expect(log).toEqual(["flush", "adopt notes/a.md", "activate document", "strip", "mount document notes/a.md"]);
    expect(deps.mount).toHaveBeenCalledWith(workspace.focusedGroup(), workspace.activeTab(), noteFile("notes/a.md"));
  });

  it("routes an image path to the image pane with no file fetch", async () => {
    const { tabs, deps, log } = await setup();
    await tabs.openEntry("pic.png");
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(log).toEqual(["flush", "activate image", "strip", "mount image pic.png"]);
  });

  it("routes a PDF path to the PDF pane with no file fetch", async () => {
    const { tabs, deps, log } = await setup();
    await tabs.openEntry("refs/paper.PDF");
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(log).toEqual(["flush", "activate pdf", "strip", "mount pdf refs/paper.PDF"]);
  });

  it("discards an open whose fetch resolves after a newer one started", async () => {
    let resolveSlow: (file: FileResponse) => void = () => {};
    const { tabs, deps, workspace } = await setup({
      loadFile: vi.fn(
        (path: string): Promise<FileResponse> =>
          path === "slow.md" ? new Promise((resolve) => (resolveSlow = resolve)) : Promise.resolve(noteFile(path)),
      ),
    });
    const slow = tabs.openEntry("slow.md");
    await tabs.openEntry("fast.md");
    resolveSlow(noteFile("slow.md"));
    await slow;
    expect(workspace.activeTab()).toEqual({ kind: "document", path: "fast.md", documentType: "note" });
    expect(deps.mount).toHaveBeenCalledTimes(1);
    expect(deps.documents.adopt).toHaveBeenCalledTimes(1);
  });

  it("reports a failed open instead of letting the rejection escape", async () => {
    const { tabs, deps } = await setup({
      loadFile: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
    });
    await expect(tabs.openEntry("a.md")).resolves.toBeUndefined();
    expect(deps.notify).toHaveBeenCalledWith("disk on fire");
  });
});

describe("one tab per file", () => {
  // Two tabs: `a.md` in the first, and a blank one active beside it.
  async function withOpenFile() {
    const context = await setup();
    await context.tabs.openEntry("a.md");
    await context.tabs.openNew(GROUP);
    context.log.length = 0;
    vi.mocked(context.deps.loadFile).mockClear();
    return context;
  }

  it("focuses the tab already holding the file, even from a blank tab, and leaves the blank tab", async () => {
    const { tabs, deps, workspace, log } = await withOpenFile();
    await tabs.openEntry("a.md");
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "document", path: "a.md", documentType: "note" },
      { kind: "empty" },
    ]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(log).toEqual(["flush", "activate document", "strip", "mount document a.md"]);
  });

  it("counts a different view of the same file as the same file", async () => {
    const { tabs, deps, workspace } = await setup({
      loadFile: vi.fn(
        async (path: string): Promise<FileResponse> =>
          ({ kind: "applet", path, revision: "rev-1", source: "", html: "" }) as unknown as FileResponse,
      ),
    });
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    await tabs.openNew(GROUP);
    vi.mocked(deps.loadFile).mockClear();

    await tabs.openEntry("tool.applet.html");
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
    expect(workspace.activeTab().kind).toBe("applet-source");
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("re-opening the active tab's own file does nothing", async () => {
    const { tabs, deps, log } = await setup();
    await tabs.openEntry("a.md");
    log.length = 0;
    vi.mocked(deps.loadFile).mockClear();
    await tabs.openEntry("a.md");
    expect(log).toEqual([]);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("does not treat a Find Context results tab as its folder", async () => {
    const { tabs, workspace } = await setup();
    await tabs.pushFindContext("notes", { results: [] } as never);
    await tabs.openFolder("notes");
    expect(workspace.activeTab()).toMatchObject({ kind: "gallery", path: "notes" });
  });
});

// A version History kept of a file: read against the file, so beside it.
describe("a version", () => {
  const kept = (id: string): HistoryVersion => ({ id, time: 1, source: "edit" });
  const shown = (tabs: readonly Tab[]) =>
    tabs.map((tab) => (tab.kind === "version" ? `${tab.path}@${tab.version.id}` : tab.kind));

  it("opens beside the current tab, one tab per version, reading no file", async () => {
    const { tabs, workspace, deps } = await setup();
    await tabs.openEntry("a.md");
    vi.mocked(deps.loadFile).mockClear();

    await tabs.openEntry("a.md", { version: kept("v1") });
    await tabs.switchTo(GROUP, 0);
    await tabs.openEntry("a.md", { version: kept("v1") });
    expect(shown(workspace.focusedGroup().tabs)).toEqual(["document", "a.md@v1"]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);

    await tabs.openEntry("a.md", { version: kept("v2") });
    expect(shown(workspace.focusedGroup().tabs)).toEqual(["document", "a.md@v1", "a.md@v2"]);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("is never its file's tab: the file opens beside it, as Restore opens it", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md", { version: kept("v1") });
    await tabs.openEntryBeside("a.md");
    expect(shown(workspace.focusedGroup().tabs)).toEqual(["a.md@v1", "document"]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
  });

  it("is left out of the saved layout", async () => {
    const { tabs, deps } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("a.md", { version: kept("v1") });
    expect(deps.saveGroups).toHaveBeenLastCalledWith(
      [
        {
          tabs: [{ kind: "document", path: "a.md" }, { kind: "empty" }],
          activeTabIndex: 1,
          readingView: false,
          sourceMode: false,
        },
      ],
      0,
    );
  });

  it("stays open when its file is deleted, and follows it when it moves", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("a.md", { version: kept("v1") });
    tabs.repath("a.md", "b.md");
    expect(shown(workspace.focusedGroup().tabs)).toEqual(["document", "b.md@v1"]);

    tabs.dropDeleted("b.md");
    expect(shown(workspace.focusedGroup().tabs)).toEqual(["empty", "b.md@v1"]);
  });
});

// A gallery keeps its tab: what it opens goes in a new one right after it.
describe("openEntryBeside", () => {
  it("opens the file in a new tab after the current one, leaving it as it was", async () => {
    const { tabs, workspace, deps } = await setup();
    await tabs.openFolder("stills");
    await tabs.openNew(GROUP);
    await tabs.switchTo(GROUP, 0);
    await tabs.openEntryBeside("stills/a.png");
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "gallery", path: "stills" },
      { kind: "image", path: "stills/a.png" },
      { kind: "empty" },
    ]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);

    await tabs.switchTo(GROUP, 0);
    await tabs.openEntryBeside("notes.md");
    expect(workspace.focusedGroup().tabs.map((tab) => tab.kind)).toEqual(["gallery", "document", "image", "empty"]);
    expect(deps.documents.release).not.toHaveBeenCalled();
  });

  it("focuses a file already open rather than opening it twice", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openFolder("stills");
    await tabs.openEntryBeside("stills/a.png");
    await tabs.switchTo(GROUP, 0);
    await tabs.openEntryBeside("stills/a.png");
    expect(workspace.focusedGroup().tabs).toHaveLength(2);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
  });

  it("replaces a blank current tab rather than keeping it beside the file", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntryBeside("b.md");
    expect(workspace.focusedGroup().tabs.map((tab) => ("path" in tab ? tab.path : tab.kind))).toEqual(["a.md", "b.md"]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
  });
});

// A folder shows as a gallery, in one tab however it is asked for.
describe("openFolder", () => {
  it("opens a gallery in place of the current tab, as a step Back returns from", async () => {
    const { tabs, workspace, log } = await setup();
    await tabs.openEntry("a.md");
    log.length = 0;
    await tabs.openFolder("lib:footage/day 1");
    expect(workspace.focusedGroup().tabs).toMatchObject([{ kind: "gallery", path: "lib:footage/day 1" }]);
    expect(log).toEqual(["flush", "release a.md", "activate gallery", "strip", "mount gallery lib:footage/day 1"]);
    expect(tabs.canGo("back")).toBe(true);
  });

  it("opens beside the current tab when asked, leaving it as it was", async () => {
    const { tabs, workspace, deps } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openFolder("notes", true);
    expect(workspace.focusedGroup().tabs).toMatchObject([
      { kind: "document", path: "a.md" },
      { kind: "gallery", path: "notes" },
    ]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
    expect(deps.documents.release).not.toHaveBeenCalled();
  });

  it("focuses a tab already showing the folder, rather than opening another", async () => {
    const { tabs, workspace, log } = await setup();
    await tabs.openFolder("notes");
    await tabs.openNew(GROUP);
    log.length = 0;
    await tabs.openFolder("notes", true);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "notes" }, { kind: "empty" }]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
    expect(log).toEqual(["flush", "activate gallery", "strip", "mount gallery notes"]);
  });

  it("restores a saved corkboard tab as its folder's gallery", async () => {
    const { tabs, workspace } = await setup({
      loadLayout: persisted([{ tabs: [{ kind: "corkboard", path: "scenes" }], activeTabIndex: 0 }]),
    });
    await launch(tabs);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "scenes" }]);
  });

  // The space's own root is the one folder whose path is empty.
  it("restores a gallery of the space's root", async () => {
    const { tabs, workspace } = await setup({
      loadLayout: persisted([{ tabs: [{ kind: "gallery", path: "" }], activeTabIndex: 0 }]),
    });
    await launch(tabs);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "" }]);
  });
});

describe("openSpacePath", () => {
  it("reports a path the tree can't reveal and opens nothing", async () => {
    const { tabs, deps } = await setup({ revealInTree: vi.fn(() => false) });
    await tabs.openSpacePath("missing/x.md");
    expect(deps.notify).toHaveBeenCalledWith("File not found: missing/x.md");
    expect(deps.mount).not.toHaveBeenCalled();
  });

  it("skips the tree for a file under another root", async () => {
    const { tabs, deps } = await setup();
    await tabs.openSpacePath("lib:abc/x.md");
    expect(deps.revealInTree).not.toHaveBeenCalled();
    expect(deps.mount).toHaveBeenCalledTimes(1);
  });

  // A link writes a folder with its `/`, and opening one shows its gallery.
  it("opens a path ending in `/` as its folder's gallery, the root's and a library's included", async () => {
    const { tabs, workspace } = await setup();
    await launch(tabs);
    await tabs.openSpacePath("projects/a/");
    expect(workspace.focusedGroup().tabs.at(-1)).toMatchObject({ kind: "gallery", path: "projects/a" });
    await tabs.openSpacePath("lib:abc/stills/");
    expect(workspace.focusedGroup().tabs.at(-1)).toMatchObject({ kind: "gallery", path: "lib:abc/stills" });
    await tabs.openSpacePath("/");
    expect(workspace.focusedGroup().tabs.at(-1)).toMatchObject({ kind: "gallery", path: "" });
  });

  // While every type isn't shown, a file of no kind is in no tree.
  it("opens a file of no kind the tree doesn't draw where such a file goes", async () => {
    const { tabs, deps } = await setup({ revealInTree: vi.fn(() => false) });
    await tabs.openSpacePath("data/budget.csv");
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.openElsewhere).toHaveBeenCalledWith("data/budget.csv", undefined);
  });
});

describe("close", () => {
  it("replaces the last tab with an empty one and mounts it", async () => {
    const { tabs, workspace, log } = await setup();
    await tabs.openEntry("a.md");
    log.length = 0;
    await tabs.close(GROUP, 0);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "empty" }]);
    expect(log).toEqual(["flush", "release a.md", "activate empty", "strip", "mount empty"]);
  });

  it("closing an inactive tab keeps the active pane and shifts the index", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "image", path: "a.png" },
      { kind: "image", path: "b.png" },
      { kind: "image", path: "c.png" },
    ];
    workspace.focusedGroup().activeTabIndex = 2;
    await tabs.close(GROUP, 0);
    expect(workspace.focusedGroup().tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["b.png", "c.png"]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
    expect(log).toEqual(["flush", "strip"]);
  });
});

describe("dropGone", () => {
  it("empties every affected tab, releases documents, and re-renders only if the active one went", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "document", path: "a.md", documentType: "note" },
      { kind: "image", path: "keep.png" },
      { kind: "gallery", path: "dir" },
    ];
    workspace.focusedGroup().activeTabIndex = 1;
    tabs.dropGone(["a.md", "dir"]);
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "empty" },
      { kind: "image", path: "keep.png" },
      { kind: "empty" },
    ]);
    expect(log).toEqual(["release a.md", "strip"]);

    log.length = 0;
    tabs.dropGone(["keep.png"]);
    await Promise.resolve();
    expect(log).toEqual(["activate empty", "strip", "mount empty"]);
  });
});

describe("openCopies", () => {
  it("names every document's file, and only the active one of a pane that keeps its own copy", async () => {
    const { tabs, workspace } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "document", path: "a.md", documentType: "note" },
      { kind: "table", path: "background.table.html" },
      { kind: "image", path: "still.png" },
      { kind: "flow", path: "shown.flow.html" },
      { kind: "document", path: "a.md", documentType: "note" },
      { kind: "applet", path: "running.applet.html" },
    ];
    workspace.focusedGroup().activeTabIndex = 3;
    expect(tabs.openCopies()).toEqual(["a.md", "shown.flow.html"]);

    workspace.focusedGroup().activeTabIndex = 2;
    expect(tabs.openCopies()).toEqual(["a.md"]);

    workspace.focusedGroup().activeTabIndex = 5;
    expect(tabs.openCopies()).toEqual(["a.md", "running.applet.html"]);
  });
});

// A flow, table or applet saves to the path its pane was opened at, so
// after a rename that pane has to read the file again at the new one.
describe("followMove", () => {
  it("re-mounts a tab whose pane keeps its own copy of the file", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [{ kind: "flow", path: "renamed.flow.html" }];
    workspace.focusedGroup().activeTabIndex = 0;
    await tabs.followMove("renamed.flow.html");
    expect(log).toEqual(["activate flow", "strip", "mount flow renamed.flow.html"]);
  });

  it("leaves a document mounted, since its model was re-keyed in place", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [{ kind: "document", path: "renamed.md", documentType: "note" }];
    workspace.focusedGroup().activeTabIndex = 0;
    await tabs.followMove("renamed.md");
    expect(log).toEqual([]);
  });
});

describe("dropDeleted", () => {
  it("empties every tab under the entry, releases their documents, and lands the active one on the parent's gallery", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "document", path: "dir/a.md", documentType: "note" },
      { kind: "image", path: "keep.png" },
      { kind: "document", path: "dir/sub/b.md", documentType: "note" },
      // A sibling that merely shares the prefix is not inside the folder.
      { kind: "document", path: "dir2/c.md", documentType: "note" },
    ];
    workspace.focusedGroup().activeTabIndex = 0;
    tabs.dropDeleted("dir");

    await vi.waitFor(() =>
      expect(workspace.focusedGroup().tabs).toEqual([
        { kind: "gallery", path: "" },
        { kind: "image", path: "keep.png" },
        { kind: "empty" },
        { kind: "document", path: "dir2/c.md", documentType: "note" },
      ]),
    );
    expect(log).toContain("release dir/a.md");
    expect(log).toContain("release dir/sub/b.md");
    expect(log).not.toContain("release dir2/c.md");
  });

  it("lands on the parent folder's gallery", async () => {
    const { tabs, workspace } = await setup();
    workspace.focusedGroup().tabs = [{ kind: "table", path: "notes/one.table.html" }];
    workspace.focusedGroup().activeTabIndex = 0;
    tabs.dropDeleted("notes/one.table.html");
    await vi.waitFor(() => expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "notes" }]));
  });

  it("focuses a tab already showing the parent", async () => {
    const { tabs, workspace } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "gallery", path: "scenes" },
      { kind: "document", path: "scenes/a.md", documentType: "note" },
    ];
    workspace.focusedGroup().activeTabIndex = 1;
    tabs.dropDeleted("scenes/a.md");
    await vi.waitFor(() => expect(workspace.focusedGroup().activeTabIndex).toBe(0));
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "scenes" }, { kind: "empty" }]);
  });

  it("only re-lists when the active tab was not affected", async () => {
    const { tabs, workspace, log } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "image", path: "keep.png" },
      { kind: "document", path: "gone.md", documentType: "note" },
    ];
    workspace.focusedGroup().activeTabIndex = 0;
    tabs.dropDeleted("gone.md");
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "image", path: "keep.png" }, { kind: "empty" }]);
    expect(log).toEqual(["release gone.md", "strip"]);
  });

  it("lands under a library on the parent's gallery", async () => {
    const { tabs, workspace } = await setup();
    workspace.focusedGroup().tabs = [{ kind: "document", path: "lib:takes/batch/notes.md", documentType: "note" }];
    workspace.focusedGroup().activeTabIndex = 0;
    tabs.dropDeleted("lib:takes/batch");
    await vi.waitFor(() => expect(workspace.focusedGroup().tabs).toEqual([{ kind: "gallery", path: "lib:takes" }]));
  });
});

describe("listChanged", () => {
  it("persists the thin shape: an Edit code tab as Edit code, a Find Context tab as empty", async () => {
    const { tabs, workspace, deps } = await setup();
    workspace.focusedGroup().tabs = [
      { kind: "applet-source", path: "tool.applet.html", state: {} as never },
      { kind: "find-context", path: "dir", result: { candidates: [], prompt: "", model: undefined } as never },
      { kind: "document", path: "a.md", documentType: "note" },
    ];
    workspace.focusedGroup().activeTabIndex = 2;
    tabs.listChanged();
    expect(deps.saveGroups).toHaveBeenCalledWith(
      [
        {
          tabs: [
            { kind: "applet-source", path: "tool.applet.html" },
            { kind: "empty" },
            { kind: "document", path: "a.md" },
          ],
          activeTabIndex: 2,
          readingView: false,
          sourceMode: false,
        },
      ],
      0,
    );
  });

  it("restores an Edit code tab as Edit code, with no fetch until it shows", async () => {
    const { tabs, workspace, deps } = await setup({
      loadLayout: persisted([
        { tabs: [{ kind: "applet-source", path: "tool.applet.html" }, { kind: "empty" }], activeTabIndex: 1 },
      ]),
    });
    await launch(tabs);
    expect(workspace.focusedGroup().tabs).toEqual([
      { kind: "applet-source", path: "tool.applet.html" },
      { kind: "empty" },
    ]);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });
});

describe("reading view", () => {
  it("restores each group's own, and a group saved without one opens editing", async () => {
    const { tabs, workspace } = await setup({
      loadLayout: persisted([
        { tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0, readingView: true },
        { tabs: [{ kind: "document", path: "b.md" }], activeTabIndex: 0 },
      ]),
    });
    await launch(tabs);
    expect(workspace.groups().map((group) => group.readingView)).toEqual([true, false]);
  });

  it("saves a change with the group's tabs, and nothing when it holds", async () => {
    const { tabs, workspace, deps } = await setup();
    await launch(tabs);
    vi.mocked(deps.saveGroups).mockClear();
    tabs.setReadingView(GROUP, true);
    expect(workspace.focusedGroup().readingView).toBe(true);
    expect(deps.saveGroups).toHaveBeenCalledWith(
      [{ tabs: [{ kind: "empty" }], activeTabIndex: 0, readingView: true, sourceMode: false }],
      0,
    );
    tabs.setReadingView(GROUP, true);
    expect(deps.saveGroups).toHaveBeenCalledTimes(1);
  });
});

describe("Source mode", () => {
  it("restores each group's own, and a group saved without one opens formatted", async () => {
    const { tabs, workspace } = await setup({
      loadLayout: persisted([
        { tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0, sourceMode: true },
        { tabs: [{ kind: "document", path: "b.md" }], activeTabIndex: 0 },
      ]),
    });
    await launch(tabs);
    expect(workspace.groups().map((group) => group.sourceMode)).toEqual([true, false]);
  });

  it("saves a change with the group's tabs, and nothing when it holds", async () => {
    const { tabs, workspace, deps } = await setup();
    await launch(tabs);
    vi.mocked(deps.saveGroups).mockClear();
    tabs.setSourceMode(GROUP, true);
    expect(workspace.focusedGroup().sourceMode).toBe(true);
    expect(deps.saveGroups).toHaveBeenCalledWith(
      [{ tabs: [{ kind: "empty" }], activeTabIndex: 0, readingView: false, sourceMode: true }],
      0,
    );
    tabs.setSourceMode(GROUP, true);
    expect(deps.saveGroups).toHaveBeenCalledTimes(1);
  });
});

// A table's pane keeps its own copy of the file, as an Applet's Edit code
// does; a document or a running Applet two groups may share.
function servedFile(path: string): FileResponse {
  if (path.endsWith(".table.html")) return { kind: "table", path, revision: "rev-1" } as unknown as FileResponse;
  if (path.endsWith(".flow.html")) return { kind: "flow", path, revision: "rev-1" } as unknown as FileResponse;
  if (path.endsWith(".applet.html")) return { kind: "applet", path, revision: "rev-1" } as unknown as FileResponse;
  return noteFile(path);
}

// What a run opens beside the document or Flow it came from: the group
// beside that one, focus left alone.
describe("openBeside", () => {
  async function withFocus(overrides: Partial<TabsDeps> = {}) {
    const context = await setup({ loadFile: vi.fn(async (path: string) => servedFile(path)), ...overrides });
    const focused: string[] = [];
    context.tabs.onFocus((tab) => focused.push(tab.kind === "empty" ? "empty" : tab.path));
    return { ...context, focused };
  }
  const paths = (tabs: Tab[]) => tabs.map((tab) => ("path" in tab ? tab.path : tab.kind));

  it("opens beside the given group, a new group the first time, and leaves focus where it is", async () => {
    const { tabs, workspace, focused } = await withFocus();
    await tabs.openEntry("a.md");
    focused.length = 0;
    await tabs.openBeside("b.md", GROUP);

    const [left, right] = workspace.groups();
    expect(paths(left.tabs)).toEqual(["a.md"]);
    expect(paths(right.tabs)).toEqual(["b.md"]);
    expect(workspace.focusedGroup()).toBe(left);
    expect(focused).toEqual([]);
  });

  it("opens into the group beside the given one wherever focus is, as a tab beside its current", async () => {
    const { tabs, workspace } = await withFocus();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    const [left, right] = workspace.groups();

    // The writer clicked into the other group while the run went on.
    await tabs.openBeside("c.md", left.id);
    expect(paths(right.tabs)).toEqual(["b.md", "c.md"]);
    expect(right.activeTabIndex).toBe(1);
    expect(workspace.focusedGroup()).toBe(right);

    await tabs.openBeside("d.md", right.id);
    expect(paths(left.tabs)).toEqual(["a.md", "d.md"]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("brings a file the other group shows to the front there, opening it once", async () => {
    const { tabs, workspace, deps } = await withFocus();
    await tabs.openEntry("a.md");
    await tabs.openBeside("b.md", GROUP);
    await tabs.openBeside("c.md", GROUP);
    vi.mocked(deps.loadFile).mockClear();

    await tabs.openBeside("b.md", GROUP);
    const [left, right] = workspace.groups();
    expect(paths(right.tabs)).toEqual(["b.md", "c.md"]);
    expect(right.activeTabIndex).toBe(0);
    expect(deps.loadFile).not.toHaveBeenCalled();
    expect(workspace.focusedGroup()).toBe(left);
  });

  it("moves a table open behind the given group's document across, that group still showing its document", async () => {
    const { tabs, workspace } = await withFocus();
    await tabs.openEntry("t.table.html");
    await tabs.openEntryBeside("a.md");

    await tabs.openBeside("t.table.html", GROUP);
    const [left, right] = workspace.groups();
    expect(paths(left.tabs)).toEqual(["a.md"]);
    expect(left.activeTabIndex).toBe(0);
    expect(paths(right.tabs)).toEqual(["t.table.html"]);
    expect(workspace.focusedGroup()).toBe(left);
  });

  it("tells its listeners where each open landed, and nothing when nothing opened", async () => {
    const { tabs, workspace } = await withFocus({
      loadFile: vi.fn(async (path: string) => {
        if (path === "gone.md") throw new Error('No file at "gone.md"');
        return servedFile(path);
      }),
    });
    const landed: string[] = [];
    tabs.onOpenedBeside((group) => landed.push(group.id));
    await tabs.openEntry("a.md");
    await tabs.openBeside("b.md", GROUP);
    await expect(tabs.openBeside("gone.md", GROUP)).rejects.toThrow();
    expect(landed).toEqual([workspace.groups()[1].id]);
  });

  it("leaves a Flow where it is when its own group shows it", async () => {
    const { tabs, workspace } = await withFocus();
    await tabs.openEntry("tool.flow.html");
    await tabs.openBeside("tool.flow.html", GROUP);
    expect(workspace.groups()).toHaveLength(1);
    expect(paths(workspace.groups()[0].tabs)).toEqual(["tool.flow.html"]);
  });

  it("rejects naming why when the file can't be read, and closes a group opened for it", async () => {
    const { tabs, workspace, deps } = await withFocus({
      loadFile: vi.fn(async (path: string) => {
        if (path === "gone.md") throw new Error('No file at "gone.md"');
        return servedFile(path);
      }),
    });
    await tabs.openEntry("a.md");

    await expect(tabs.openBeside("gone.md", GROUP)).rejects.toThrow('No file at "gone.md"');
    expect(workspace.groups()).toHaveLength(1);
    expect(deps.notify).not.toHaveBeenCalled();
  });
});

describe("two groups", () => {
  async function withGroups(overrides: Partial<TabsDeps> = {}) {
    const context = await setup({ loadFile: vi.fn(async (path: string) => servedFile(path)), ...overrides });
    const focused: string[] = [];
    context.tabs.onFocus((tab) => focused.push(tab.kind === "empty" ? "empty" : tab.path));
    return { ...context, focused };
  }

  it("split shows the focused document in a new group, in place of its blank tab, and focuses it", async () => {
    const { tabs, workspace, deps, focused } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.split();

    const [left, right] = workspace.groups();
    expect(workspace.groups()).toHaveLength(2);
    expect(workspace.focusedGroup()).toBe(right);
    expect(left.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(right.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(deps.documents.adopt).toHaveBeenCalledTimes(2); // one reference per tab
    expect(focused).toEqual(["a.md", "empty", "a.md"]);
  });

  it("split leaves a table in its group, and the new group starts blank", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("t.table.html");
    await tabs.split();

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "table", path: "t.table.html" }]);
    expect(right.tabs).toEqual([{ kind: "empty" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("opening a table the other group shows focuses it there instead of opening it twice", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("t.table.html");
    await tabs.split();
    vi.mocked(deps.loadFile).mockClear();

    await tabs.openEntry("t.table.html");
    const [left, right] = workspace.groups();
    expect(workspace.focusedGroup()).toBe(left);
    expect(right.tabs).toEqual([{ kind: "empty" }]);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("opens a document the other group shows as a second view, leaving focus where it was", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.split();
    await tabs.openEntry("b.md");
    expect(deps.documents.release).toHaveBeenCalledWith("a.md"); // the right group's reference only

    await tabs.openEntry("a.md");
    const [left, right] = workspace.groups();
    expect(workspace.focusedGroup()).toBe(right);
    expect(left.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(right.tabs).toMatchObject([{ kind: "document", path: "a.md", documentType: "note" }]);
  });

  it("closing a group's last tab closes the group and hands focus to the other", async () => {
    const { tabs, workspace, focused, log, closed } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.split();
    const [left, right] = workspace.groups();
    log.length = 0;
    focused.length = 0;

    await tabs.close(right.id, 0);
    expect(workspace.groups()).toEqual([left]);
    expect(workspace.focusedGroup()).toBe(left);
    expect(closed).toHaveBeenCalledWith(right);
    expect(log).toEqual(["flush", "release a.md", "group closed", "strip"]);
    expect(focused).toEqual(["a.md"]);
  });

  it("opens a file to the side: a new group the first time, a new tab beside the current after", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    const [left, right] = workspace.groups();
    expect(right.tabs).toEqual([{ kind: "document", path: "b.md", documentType: "note" }]);
    expect(workspace.focusedGroup()).toBe(right);

    tabs.focusGroup(left.id);
    await tabs.openToSide("c.md");
    expect(right.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["b.md", "c.md"]);
    expect(right.activeTabIndex).toBe(1);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("opens to the side from the right group into the left one", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    await tabs.openToSide("c.md");
    const [left, right] = workspace.groups();
    expect(left.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["a.md", "c.md"]);
    expect(right.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["b.md"]);
    expect(workspace.focusedGroup()).toBe(left);
  });

  it("opens a folder to the side: a new group the first time, then beside that group's current tab", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openFolderToSide("notes");
    const [left, right] = workspace.groups();
    expect(left.tabs).toMatchObject([{ kind: "document", path: "a.md" }]);
    expect(right.tabs).toEqual([{ kind: "gallery", path: "notes" }]);
    expect(workspace.focusedGroup()).toBe(right);

    tabs.focusGroup(left.id);
    await tabs.openFolderToSide("lib:footage");
    expect(right.tabs).toEqual([
      { kind: "gallery", path: "notes" },
      { kind: "gallery", path: "lib:footage" },
    ]);
    expect(right.activeTabIndex).toBe(1);

    // One the side group already shows is focused there, not opened again.
    tabs.focusGroup(left.id);
    await tabs.openFolderToSide("notes");
    expect(right.tabs).toHaveLength(2);
    expect(right.activeTabIndex).toBe(0);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("opening to the side a table already open focuses it, and opens no group", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("t.table.html");
    await tabs.openNew(GROUP);
    await tabs.openToSide("t.table.html");
    expect(workspace.groups()).toHaveLength(1);
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
  });

  it("split runs an Applet in the new group too", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.split();

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("runs an Applet in one group while its code is open in the other", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    await tabs.split();
    await tabs.openEntry("tool.applet.html");

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("opens an Applet to the side of its own code, running", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    await tabs.openToSide("tool.applet.html");

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("Edit code goes to the code open in the other group, leaving this tab running", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.split();
    await tabs.openAppletCode("tool.applet.html");
    const [left, right] = workspace.groups();
    tabs.focusGroup(left.id);
    vi.mocked(deps.mount).mockClear();

    await tabs.openAppletCode("tool.applet.html");
    expect(left.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
    expect(deps.mount).not.toHaveBeenCalled();
  });

  it("opens an Applet's code to the side, leaving it running here", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.openToSide("tool.applet.html", { view: "code" });

    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("switches the other group's running tab to its code, rather than opening a second", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.split();
    const [left, right] = workspace.groups();
    tabs.focusGroup(left.id);

    await tabs.openToSide("tool.applet.html", { view: "code" });
    expect(left.tabs).toEqual([{ kind: "applet", path: "tool.applet.html" }]);
    expect(right.tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("asked for an Applet's code to the side, focuses the code where it already is", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    await tabs.openToSide("tool.applet.html", { view: "code" });

    expect(workspace.groups()).toHaveLength(1);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html" }]);
  });

  // The group an open was loading into is gone by the time the file arrives.
  it("lands nothing in a group closed while an open into it was loading", async () => {
    let resolveSlow: (file: FileResponse) => void = () => {};
    const { tabs, workspace, deps } = await withGroups({
      loadFile: vi.fn((path: string) =>
        path === "slow.md"
          ? new Promise<FileResponse>((resolve) => (resolveSlow = resolve))
          : Promise.resolve(noteFile(path)),
      ),
    });
    await tabs.openEntry("a.md");
    const opening = tabs.openToSide("slow.md");
    await vi.waitFor(() => expect(workspace.groups()).toHaveLength(2));
    const right = workspace.groups()[1];
    await tabs.close(right.id, 0);
    vi.mocked(deps.mount).mockClear();
    resolveSlow(noteFile("slow.md"));
    await opening;

    expect(workspace.groups()).toHaveLength(1);
    expect(deps.mount).not.toHaveBeenCalled();
    expect(deps.documents.adopt).not.toHaveBeenCalledWith(noteFile("slow.md"));
  });

  it("moves, deletions and gone files reach every group", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("notes/a.md");
    await tabs.split();
    const [left, right] = workspace.groups();

    expect(tabs.repath("notes", "drafts")).toBe(true);
    expect([left.tabs, right.tabs]).toEqual([
      [{ kind: "document", path: "drafts/a.md", documentType: "note" }],
      [{ kind: "document", path: "drafts/a.md", documentType: "note" }],
    ]);

    tabs.dropDeleted("drafts/a.md");
    await vi.waitFor(() =>
      expect([left.tabs, right.tabs]).toEqual([
        [{ kind: "gallery", path: "drafts" }],
        [{ kind: "gallery", path: "drafts" }],
      ]),
    );
  });

  it("persists every group and which one has focus", async () => {
    const { tabs, deps } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.split();
    expect(deps.saveGroups).toHaveBeenLastCalledWith(
      [
        { tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0, readingView: false, sourceMode: false },
        { tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0, readingView: false, sourceMode: false },
      ],
      1,
    );
  });

  it("restores both groups and the focus, rendering the focused group last", async () => {
    const { tabs, workspace, log } = await withGroups({
      loadLayout: persisted(
        [
          { tabs: [{ kind: "document", path: "a.md" }], activeTabIndex: 0 },
          {
            tabs: [
              { kind: "image", path: "b.png" },
              { kind: "image", path: "c.png" },
            ],
            activeTabIndex: 1,
          },
        ],
        0,
      ),
    });
    await launch(tabs);
    const [left, right] = workspace.groups();
    expect(right.tabs).toEqual([
      { kind: "image", path: "b.png" },
      { kind: "image", path: "c.png" },
    ]);
    expect(right.activeTabIndex).toBe(1);
    expect(workspace.focusedGroup()).toBe(left);
    expect(log.filter((entry) => entry.startsWith("mount"))).toEqual(["mount image c.png", "mount document a.md"]);
  });

  it("moves a tab to the other group, opening one, and back again, closing the group it empties", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");

    await tabs.moveToOtherGroup(GROUP, 0);
    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "document", path: "b.md", documentType: "note" }]);
    expect(right.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(workspace.focusedGroup()).toBe(right);
    expect(deps.documents.release).not.toHaveBeenCalled(); // the reference travels with the tab

    await tabs.moveToOtherGroup(right.id, 0);
    expect(workspace.groups()).toEqual([left]);
    expect(left.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["b.md", "a.md"]);
    expect(left.activeTabIndex).toBe(1);
    expect(workspace.focusedGroup()).toBe(left);
  });

  it("a dropped tab lands where it was dropped among the other group's tabs", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");
    await tabs.openToSide("c.md");
    tabs.focusGroup(workspace.groups()[0].id);
    await tabs.openToSide("d.md");
    const [left, right] = workspace.groups();

    await tabs.moveToOtherGroup(left.id, 0, 1);
    const paths = (group: typeof left) => group.tabs.map((tab) => ("path" in tab ? tab.path : ""));
    expect(paths(right)).toEqual(["c.md", "a.md", "d.md"]);
    expect(right.activeTabIndex).toBe(1);
    expect(paths(left)).toEqual(["b.md"]);
    expect(workspace.focusedGroup()).toBe(right);
  });

  it("a tab dropped on a group showing only a blank takes the blank's place", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.split(); // from the blank tab, so the new group starts blank
    const [left, right] = workspace.groups();
    expect(right.tabs).toEqual([{ kind: "empty" }]);

    await tabs.moveToOtherGroup(left.id, 0, 3);
    expect(right.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
  });

  it("moves a blank tab as it does any other, closing the group it leaves empty", async () => {
    const { tabs, workspace, log } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.split(); // from the blank tab, so the new group starts blank
    const [left, right] = workspace.groups();
    const [, blank] = left.tabs;
    const [moved] = right.tabs;
    expect(moved).toEqual({ kind: "empty" });

    await tabs.moveToOtherGroup(right.id, 0, 0);
    expect(workspace.groups()).toEqual([left]);
    expect(left.tabs).toHaveLength(3);
    expect(left.tabs[0]).toBe(moved);
    expect(left.tabs[2]).toBe(blank);
    expect(left.activeTabIndex).toBe(0);
    expect(workspace.focusedGroup()).toBe(left);
    expect(log.at(-1)).toBe("mount empty");
  });

  it("reorders a tab along its own strip, the group still showing what it showed", async () => {
    const { tabs, workspace, log } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("c.md");
    const group = workspace.focusedGroup();
    const paths = () => group.tabs.map((tab) => ("path" in tab ? tab.path : ""));
    log.length = 0;

    tabs.reorder(GROUP, 2, 0);
    expect(paths()).toEqual(["c.md", "a.md", "b.md"]);
    expect(group.activeTabIndex).toBe(0);
    tabs.reorder(GROUP, 1, 3);
    expect(paths()).toEqual(["c.md", "b.md", "a.md"]);
    expect(group.activeTabIndex).toBe(0);
    expect(log).toEqual(["strip", "strip"]); // redrawn and saved, nothing activated or mounted
  });

  it("leaves the strip alone for a drop either side of the tab itself", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");
    vi.mocked(deps.saveGroups).mockClear();

    tabs.reorder(GROUP, 1, 1);
    tabs.reorder(GROUP, 1, 2);
    expect(workspace.focusedGroup().tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["a.md", "b.md"]);
    expect(deps.saveGroups).not.toHaveBeenCalled();
  });

  it("moving a table is how it reaches the other group: it is then open only there", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("t.table.html");
    await tabs.openNew(GROUP);
    await tabs.moveToOtherGroup(GROUP, 0);
    const [left, right] = workspace.groups();
    expect(left.tabs).toEqual([{ kind: "empty" }]);
    expect(right.tabs).toEqual([{ kind: "table", path: "t.table.html" }]);

    tabs.focusGroup(left.id);
    vi.mocked(deps.loadFile).mockClear();
    await tabs.openEntry("t.table.html");
    expect(workspace.focusedGroup()).toBe(right);
    expect(deps.loadFile).not.toHaveBeenCalled();
  });

  it("moving a document the other group already shows focuses that tab and drops this one's reference", async () => {
    const { tabs, workspace, deps } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.split();
    const [left, right] = workspace.groups();

    await tabs.moveToOtherGroup(left.id, 0);
    expect(workspace.groups()).toEqual([right]);
    expect(right.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(deps.documents.release).toHaveBeenCalledTimes(1);
  });

  // Its cached editor state is the old pane's, wired to that pane's saves.
  it("moving an Edit code tab leaves its view state behind, so the new pane reads the file again", async () => {
    const { tabs, workspace } = await withGroups();
    workspace.focusedGroup().tabs = [
      { kind: "applet-source", path: "tool.applet.html", state: {} as never },
      { kind: "empty" },
    ];
    await tabs.moveToOtherGroup(GROUP, 0);
    expect(workspace.groups()[1].tabs).toEqual([{ kind: "applet-source", path: "tool.applet.html", state: undefined }]);
  });

  it("closes every tab but one, releasing their documents and showing the one kept", async () => {
    const { tabs, workspace, deps, log } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");
    await tabs.openNew(GROUP);
    log.length = 0;

    await tabs.closeOthers(GROUP, 0);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
    expect(deps.documents.release).toHaveBeenCalledWith("b.md");
    expect(log).toContain("mount document a.md");
  });

  it("splits from a pill: the tab right-clicked, not the active one", async () => {
    const { tabs, workspace } = await withGroups();
    await tabs.openEntry("a.md");
    await tabs.openNew(GROUP);
    await tabs.openEntry("b.md");

    await tabs.split({ groupId: GROUP, index: 0 });
    const [left, right] = workspace.groups();
    expect(left.tabs[left.activeTabIndex]).toEqual({ kind: "document", path: "b.md", documentType: "note" });
    expect(right.tabs).toEqual([{ kind: "document", path: "a.md", documentType: "note" }]);
  });

  it("drops a restored group none of whose tabs survive, focusing the one that does", async () => {
    const { tabs, workspace } = await withGroups({
      loadLayout: persisted(
        [
          { tabs: [{ kind: "document", path: "data.zip" }], activeTabIndex: 0 },
          { tabs: [{ kind: "image", path: "b.png" }], activeTabIndex: 0 },
        ],
        0,
      ),
    });
    await launch(tabs);
    expect(workspace.groups()).toHaveLength(1);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "image", path: "b.png" }]);
  });
});

describe("a pair that scrolls as one", () => {
  // Two groups on a.md, the right one focused, as a split leaves them. The
  // pair holds until `unpair`: the editor area's answer, which it reads off
  // the panes.
  async function pair() {
    let paired = true;
    const context = await setup({
      loadFile: vi.fn(async (path: string) => servedFile(path)),
      scrollPartner: (group) => (paired ? context.workspace.groups().find((other) => other !== group) : undefined),
    });
    await context.tabs.openEntry("a.md");
    await context.tabs.split();
    const shows = () =>
      context.workspace.groups().map((group) => {
        const tab = context.workspace.activeTabOf(group);
        return tab.kind === "empty" ? "empty" : tab.path;
      });
    const unpair = () => {
      paired = false;
    };
    return { ...context, shows, unpair };
  }

  it("opens a note opened in place on either side on the other side too, focus staying put", async () => {
    const { tabs, workspace, shows } = await pair();
    const [left, right] = workspace.groups();
    await tabs.openEntry("b.md");
    expect(shows()).toEqual(["b.md", "b.md"]);
    expect(workspace.focusedGroup()).toBe(right);

    tabs.focusGroup(left.id);
    await tabs.openSpacePath("c.md");
    expect(shows()).toEqual(["c.md", "c.md"]);
    expect(workspace.focusedGroup()).toBe(left);
    expect([left.tabs.length, right.tabs.length]).toEqual([1, 1]);
  });

  it("takes the other side along on Back", async () => {
    const { tabs, shows } = await pair();
    await tabs.openEntry("b.md");
    await tabs.go("back");
    expect(shows()).toEqual(["a.md", "a.md"]);
  });

  it("brings the other side to its own tab of the note when it has one", async () => {
    const { tabs, workspace, shows } = await pair();
    const [left] = workspace.groups();
    left.tabs.push({ kind: "document", path: "c.md", documentType: "note" });
    await tabs.openEntry("c.md");
    expect(shows()).toEqual(["c.md", "c.md"]);
    expect(left.tabs.map((tab) => tab.kind !== "empty" && tab.path)).toEqual(["a.md", "c.md"]);
  });

  it("leaves the other side for a new tab, anything but a note, a note only ever read, and no pair", async () => {
    const { tabs, shows, unpair } = await pair();
    await tabs.openEntryBeside("b.md");
    expect(shows()).toEqual(["a.md", "b.md"]);
    await tabs.openEntry("t.table.html");
    expect(shows()).toEqual(["a.md", "t.table.html"]);
    await tabs.openSpacePath("lib:abc/x.md");
    expect(shows()).toEqual(["a.md", "lib:abc/x.md"]);
    unpair();
    await tabs.openEntry("d.md");
    expect(shows()).toEqual(["a.md", "d.md"]);
  });

  it("leaves the other side alone when it moved on while the open was loading", async () => {
    const { tabs, workspace, shows, deps } = await pair();
    const [left] = workspace.groups();
    let release = () => {};
    vi.mocked(deps.loadFile).mockImplementationOnce(async (path: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return servedFile(path);
    });
    const opening = tabs.openEntry("b.md");
    tabs.focusGroup(left.id);
    await tabs.openEntryBeside("c.md");
    release();
    await opening;
    expect(shows()).toEqual(["c.md", "b.md"]);
  });
});

describe("Back and Forward", () => {
  const paths = (workspace: { activeTab(): Tab }) => {
    const tab = workspace.activeTab();
    return tab.kind === "empty" ? "empty" : tab.path;
  };

  it("walks the places an open replaced in place, and a new open drops what lay ahead", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    await tabs.openEntry("c.md");
    expect([tabs.canGo("back"), tabs.canGo("forward")]).toEqual([true, false]);

    await tabs.go("back");
    await tabs.go("back");
    expect(paths(workspace)).toBe("a.md");
    expect([tabs.canGo("back"), tabs.canGo("forward")]).toEqual([false, true]);
    await tabs.go("forward");
    expect(paths(workspace)).toBe("b.md");

    await tabs.openEntry("d.md");
    expect(tabs.canGo("forward")).toBe(false);
    await tabs.go("back");
    expect(paths(workspace)).toBe("b.md");
    expect(workspace.focusedGroup().tabs).toHaveLength(1);
  });

  it("keeps one history per tab, and a new tab starts with none", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    await tabs.openNew(GROUP);
    expect(tabs.canGo("back")).toBe(false);
    await tabs.openEntry("c.md");
    expect(tabs.canGo("back")).toBe(false);
    await tabs.switchTo(GROUP, 0);
    expect(tabs.canGo("back")).toBe(true);
    expect(workspace.focusedGroup().tabs.map((tab) => tab.kind !== "empty" && tab.path)).toEqual(["b.md", "c.md"]);
  });

  it("takes another view of the same place for no step", async () => {
    const applet = { kind: "applet", path: "tool.applet.html", source: "", html: "" } as unknown as FileResponse;
    const { tabs } = await setup({ loadFile: vi.fn(async () => applet) });
    await tabs.openEntry("tool.applet.html");
    await tabs.openAppletCode("tool.applet.html");
    expect(tabs.canGo("back")).toBe(false);
  });

  it("lands a document where it was left", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    // What the pane writes back as the next tab mounts.
    const a = workspace.activeTab();
    await tabs.openEntry("b.md");
    if (a.kind === "document") {
      a.scrollTop = 420;
      a.readingScrollTop = 900;
    }
    await tabs.go("back");
    expect(workspace.activeTab()).toMatchObject({
      kind: "document",
      path: "a.md",
      scrollTop: 420,
      readingScrollTop: 900,
    });
  });

  it("brings a Find Context answer back from the history, with nothing to fetch", async () => {
    const { tabs, workspace, deps } = await setup();
    const result = { candidates: [] } as never;
    await tabs.pushFindContext("notes", result);
    await tabs.openEntry("notes/a.md");
    await tabs.go("back");
    expect(workspace.activeTab()).toMatchObject({ kind: "find-context", path: "notes", result });
    expect(deps.loadFile).toHaveBeenCalledTimes(1);
  });

  it("focuses another tab already showing the place, leaving this one as it was", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    await tabs.openEntryBeside("a.md");
    await tabs.switchTo(GROUP, 0);
    await tabs.go("back");
    expect(workspace.focusedGroup().activeTabIndex).toBe(1);
    expect(workspace.focusedGroup().tabs[0]).toMatchObject({ path: "b.md" });
    await tabs.switchTo(GROUP, 0);
    expect(tabs.canGo("back")).toBe(true);
  });

  it("follows a move and forgets a delete", async () => {
    const { tabs, workspace, deps } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    await tabs.openEntry("c.md");
    tabs.repath("a.md", "moved/a.md");
    tabs.dropDeleted("b.md");
    await tabs.go("back");
    expect(paths(workspace)).toBe("moved/a.md");
    expect(deps.loadFile).toHaveBeenLastCalledWith("moved/a.md");
    expect(tabs.canGo("back")).toBe(false);
  });

  it("keeps the way back for a tab whose file was deleted", async () => {
    const { tabs, workspace } = await setup();
    await tabs.openEntry("notes/a.md");
    await tabs.openEntry("notes/b.md");
    tabs.dropDeleted("notes/b.md");
    await vi.waitFor(() => expect(workspace.activeTab()).toMatchObject({ kind: "gallery", path: "notes" }));
    await tabs.go("back");
    expect(paths(workspace)).toBe("notes/a.md");
  });

  it("tells its listeners when what a step would do may have changed", async () => {
    const { tabs } = await setup();
    const changed = vi.fn();
    tabs.onHistoryChange(changed);
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    changed.mockClear();
    tabs.dropDeleted("a.md");
    expect(changed).toHaveBeenCalled();
    expect(tabs.canGo("back")).toBe(false);
  });
});

// Whoever wrote a file read again may have written others the listing
// lacks: a Flow's picture beside the row it added.
describe("reloadPath", () => {
  it("keeps the space's listing from calling a file gone until it is read again", async () => {
    const { tabs } = await setup();
    const spaceTree = await import("../../../web/core/spaceTree.ts");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(String(url).startsWith("/api/space/paths") ? { files: [], folders: [], scopes: [] } : []),
      ),
    );
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("shots/one.png")).toBe(true);
    await tabs.reloadPath("shots/shots.table.html");
    expect(spaceTree.listedAsGone("shots/one.png")).toBe(false);
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("shots/one.png")).toBe(true);
    vi.unstubAllGlobals();
  });
});
