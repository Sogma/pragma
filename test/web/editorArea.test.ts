// @vitest-environment jsdom
// The editor area over the real tab session and real document panes: what
// moves between groups, and what follows which one has focus.
import { foldEffect, foldedRanges } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { NAME_ORDER, type SortChoice } from "../../src/protocol/folderSort.ts";
import type { FileResponse, Tab, TextFileResponse } from "../../web/core/apiClient.ts";
import { PREVIEW_PAGE_MENU } from "../../web/filePreview.ts";
import { CHIP_MENU, CLEAR_CHIP } from "../../web/flow/flowMenus.ts";
import type { NamingSurface } from "../../web/lib/inlineEdit.ts";
import { installPathChipMenu } from "../../web/lib/pathChipMenu.ts";
import { PREVIEW_OPEN_MENU } from "../../web/notePreview.ts";
import type { DialogService } from "../../web/services/dialog.ts";
import { COMMAND_PALETTE } from "../../web/services/menus.ts";
import type { SaveQueue } from "../../web/services/saveQueue.ts";
import type { Setting } from "../../web/services/settings.ts";
import { MEDIA_MENU } from "../../web/services/videoMenu.ts";
import type { ContextMenu } from "../../web/view/contextMenu.ts";
import type { DocumentPane } from "../../web/view/panes/documentPane.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";
import { testLayout } from "./support/editorLayout.ts";
import { testFormats } from "./support/formats.ts";

polyfillRangeRects();
// jsdom lays nothing out, so there is no resize to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom lays nothing out, so the header's row is laid out here while a tab
// is dragged: every pill and gap 100px wide in DOM order, each strip 300px,
// side by side, the drag layer 6px down a 40px header.
function layOutStrips(stripHost: HTMLElement): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  const strips = () => [...stripHost.querySelectorAll(":scope > .editor-group-tabs")];
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("editor-tab-drag-layer")) return box(0, 6, 600, 34);
    if (this.classList.contains("editor-group-tabs")) return box(strips().indexOf(this) * 300, 0, 300, 40);
    const strip = this.parentElement;
    if (strip?.classList.contains("editor-group-tabs") && this.matches(".editor-tab, .editor-tab-gap")) {
      const items = [...strip.children].filter((child) => child.matches(".editor-tab, .editor-tab-gap"));
      return box(strips().indexOf(strip) * 300 + items.indexOf(this) * 100, 6, 100, 34);
    }
    return box(0, 0, 0, 0);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

// A press on the pill, a move to `x` along the header, and a release there.
async function carryTab(pill: Element, x: number): Promise<void> {
  const from = pill.getBoundingClientRect();
  const at = (type: string, clientX: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY: 20 });
  pill.dispatchEvent(at("pointerdown", from.left + 50));
  window.dispatchEvent(at("pointermove", x));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  window.dispatchEvent(at("pointerup", x));
}

const paths = (tabs: readonly { kind: string; path?: string }[]) => tabs.map((tab) => tab.path ?? tab.kind);

function noteFile(path: string, body: string): TextFileResponse {
  return {
    kind: "text",
    path,
    revision: "rev-1",
    documentType: "note",
    content: `# Title\n\n${body}\n`,
    toolkits: [],
    classLinks: [],
  };
}

// A library no listing has named is read-only.
const files: Record<string, TextFileResponse> = {
  "a.md": noteFile("a.md", "alpha"),
  "b.md": noteFile("b.md", "beta"),
  "lib:pool/c.md": noteFile("lib:pool/c.md", "gamma"),
};

const applets: Record<string, FileResponse> = {
  "tools/hello.applet.html": {
    kind: "applet",
    path: "tools/hello.applet.html",
    revision: "rev-1",
    html: "<html><body>hi</body></html>",
  } as FileResponse,
};

// Fresh modules each time: the workspace is a module-level singleton, and
// the area and the session must bind to the same one.
// The divider's remembered share, as the settings service would hold it.
function splitSetting(initial?: number): Setting<number | undefined> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
    subscribe: () => () => {},
  };
}

async function setup(split = splitSetting(), dialog = {} as DialogService) {
  vi.resetModules();
  const workspace = await import("../../web/core/workspace.ts");
  const { createTabs } = await import("../../web/services/tabs.ts");
  const { createEditorArea } = await import("../../web/editorArea.ts");
  const { createDocuments } = await import("../../web/services/documents.ts");
  const { createEditorPanes } = await import("../../web/services/editorPanes.ts");
  const { createCommands } = await import("../../web/services/commands.ts");
  const { createMenus } = await import("../../web/services/menus.ts");
  const { createKeybindings } = await import("../../web/services/keybindings.ts");
  const { appletSourcePane, documentPane } = await import("../../web/view/panes/documentPane.ts");
  const { emptyPane } = await import("../../web/view/panes/emptyPane.ts");
  const { createPropertyEditor } = await import("../../web/view/propertyEditor.ts");
  const { createLinksList } = await import("../../web/view/linksList.ts");
  const { createAppIndicators } = await import("../../web/view/statusbar.ts");
  const { createFileNotices } = await import("../../web/services/fileNotices.ts");

  const queue = {
    schedule: vi.fn(),
    flush: vi.fn(async () => true),
    pendingContent: () => undefined,
    state: () => ({ failedPaths: [], conflictPaths: [] }),
    subscribe: () => () => {},
    noteRevision: vi.fn(),
    settledRevision: () => undefined,
    resolveConflict: vi.fn(),
    move: vi.fn(),
    pause: () => () => {},
    rebase: vi.fn(async () => {}),
    saveNow: vi.fn(async () => true),
    hasPending: () => false,
  } satisfies SaveQueue;
  const loadFile = vi.fn(async (path: string): Promise<FileResponse> => files[path] ?? applets[path]);
  const documents = createDocuments({ queue, fetchFile: loadFile });
  const contextMenu = { open: vi.fn(), close: vi.fn(), isOpen: () => false } as unknown as ContextMenu;
  const panes = createEditorPanes();
  const documentPaneDeps = {
    documents,
    saveQueue: queue,
    loadFile,
    formats: testFormats(),
    treeOrder: (paths: readonly string[]) => [...paths],
    describe: async () => undefined,
    openPath: vi.fn(),
    openBeside: vi.fn(),
    contextMenu,
    dialog,
    createPropertyEditor,
    tags: { known: () => [], read: async () => [] },
    createLinksList,
    revealProperties: vi.fn(),
    onSpaceChanged: vi.fn(),
    notify: vi.fn(),
    reportProblems: vi.fn(),
    runCommand: vi.fn(),
    shortcutFor: (_id: string): string | undefined => undefined,
  };
  panes.register(documentPane({ ...documentPaneDeps, layout: testLayout() }));
  panes.register(appletSourcePane({ ...documentPaneDeps, layout: testLayout() }));
  const commands = createCommands();
  const menus = createMenus(commands);
  panes.register(emptyPane({ menus, commands }));
  const root = document.createElement("div");
  const stripHost = document.createElement("div");
  document.body.replaceChildren(stripHost, root);

  const tabs = createTabs({
    documents,
    loadFile,
    loadLayout: async () => ({ groups: [], focusedGroup: 0, collapsedFolders: [], expandedFolders: [] }),
    saveGroups: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    mount: (group, tab, prefetched) => area.mount(group, tab, prefetched),
    renderStrip: (group) => area.renderStrip(group),
    revealInTree: () => true,
    notify: vi.fn(),
    openElsewhere: vi.fn(),
    scrollPartner: (group) => area.scrollPartner(group),
  });
  const inspector = { setPane: vi.fn(), show: vi.fn() };
  const indicators = createAppIndicators({ retrySaves: vi.fn(), reviewConflicts: vi.fn() });
  const notices = createFileNotices({ log: () => ({ reveal: () => true, kept: () => true }), showConsole: vi.fn() });
  const area = createEditorArea({
    root,
    stripHost,
    panes,
    formats: documentPaneDeps.formats,
    loadFile,
    commands,
    menus,
    keybindings: createKeybindings(commands),
    contextMenu,
    dialog: () => dialog,
    indicators,
    notices,
    inspector,
    tabs,
    split,
    showExtensions: { get: () => false },
  });
  const columns = () => [...root.querySelectorAll<HTMLElement>(".editor-group")];
  const strips = () => [...stripHost.querySelectorAll<HTMLElement>(".editor-group-tabs")];
  // Each column's status bar, and a part of it by its class's suffix.
  const bars = () => columns().map((column) => column.querySelector<HTMLElement>(".editor-statusbar"));
  const barPart = <E extends HTMLElement = HTMLElement>(column: number, part: string) =>
    columns()[column].querySelector<E>(`.editor-statusbar-${part}`);
  return {
    workspace,
    tabs,
    panes,
    area,
    root,
    stripHost,
    contextMenu,
    commands,
    menus,
    columns,
    strips,
    inspector,
    indicators,
    notices,
    bars,
    barPart,
  };
}

describe("editor area", () => {
  it("draws a proposal in whichever group shows its document, not only the focused one", async () => {
    const { tabs, area, columns } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");

    const shown = area.propose(
      { path: "a.md", before: files["a.md"].content, newContent: "# Title\n\nalpha two\n", revision: "r" },
      vi.fn(),
    );
    expect(shown).toBe(1);
    // Every editor view carries a bar; only the one drawing the proposal shows it.
    expect(columns()[0].querySelector(".edit-proposal-bar:not([hidden])")).not.toBeNull();
    expect(columns()[1].querySelector(".edit-proposal-bar:not([hidden])")).toBeNull();
    expect(area.propose({ path: "elsewhere.md", before: "", newContent: "x", revision: "r" }, vi.fn())).toBeUndefined();
  });

  it("takes the group showing a proposal out of reading view, and only that group", async () => {
    const { tabs, workspace, area, commands, columns } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    for (const group of workspace.groups()) {
      tabs.focusGroup(group.id);
      await commands.run("editor.toggleReadingView", { tab: workspace.activeTab(), pane: area.focusedPane() });
    }
    const pressed = () =>
      columns().map((column) => column.querySelector(".editor-toolbar-reading-toggle")?.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "true"]);

    area.propose(
      { path: "a.md", before: files["a.md"].content, newContent: "# Title\n\nalpha two\n", revision: "r" },
      vi.fn(),
    );

    expect(pressed()).toEqual(["false", "true"]);
    expect(columns()[0].querySelector(".edit-proposal-bar:not([hidden])")).not.toBeNull();
  });

  // Leaving it would turn the group's reading view off for the next file,
  // without showing the read-only one any differently.
  it("keeps a group in reading view for a proposal on a read-only tab", async () => {
    const { tabs, workspace, area, commands } = await setup();
    await tabs.openEntry("a.md");
    await commands.run("editor.toggleReadingView", { tab: workspace.activeTab(), pane: area.focusedPane() });
    await tabs.openEntry("lib:pool/c.md");

    area.propose(
      {
        path: "lib:pool/c.md",
        before: files["lib:pool/c.md"].content,
        newContent: "# Title\n\ngamma two\n",
        revision: "r",
      },
      vi.fn(),
    );
    await tabs.openEntry("b.md");

    expect(document.querySelector(".editor-toolbar-reading-toggle")?.getAttribute("aria-pressed")).toBe("true");
    expect(area.focusedDocumentPane()?.view.state.readOnly).toBe(true);
  });

  it("focuses the group a press lands in, and marks the other strip", async () => {
    const { tabs, workspace, columns, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    expect(strips().map((strip) => strip.classList.contains("unfocused"))).toEqual([true, false]);

    columns()[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(workspace.focusedGroup()).toBe(workspace.groups()[0]);
    expect(strips().map((strip) => strip.classList.contains("unfocused"))).toEqual([false, true]);
  });

  it("flashes the tab a run opens beside, and leaves the writer's strip focused", async () => {
    const { tabs, workspace, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openBeside("b.md", workspace.focusedGroup().id);

    const [left, right] = strips();
    expect(right.querySelector(".editor-tab.active")?.classList.contains("flash")).toBe(true);
    expect(left.querySelector(".editor-tab.flash")).toBeNull();
    expect(strips().map((strip) => strip.classList.contains("unfocused"))).toEqual([false, true]);
  });

  it("opens a pill's own menu, whose items act on that tab", async () => {
    const { tabs, workspace, area, contextMenu, commands, menus, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openNew("group-1");
    await tabs.openEntry("b.md");

    strips()[0]
      .querySelector(".editor-tab")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const target = { groupId: "group-1", index: 0 };
    expect(contextMenu.open).toHaveBeenCalledWith(expect.objectContaining({ menu: "editor.tab", arg: target }));

    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    expect(menus.resolve("editor.tab", context, target).map((item) => item.label)).toEqual([
      "Split",
      "Move to the side",
      "Close",
      "Close others",
    ]);
    await commands.run("tab.moveToOtherGroup", context, target);
    const [left, right] = workspace.groups();
    expect(left.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["b.md"]);
    expect(right.tabs.map((tab) => ("path" in tab ? tab.path : ""))).toEqual(["a.md"]);
  });

  // Copy path comes with the context menu itself, so it is installed here.
  // Clear shows only when the chip hands over what it clears, which a
  // locked Flow's chip doesn't.
  it("ends a node chip's menu with Copy path, then Clear where the chip clears", async () => {
    const { workspace, area, commands, menus, contextMenu } = await setup();
    const installed = installPathChipMenu({ commands, menus, menu: contextMenu });
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const labels = (arg: unknown) => menus.resolve(CHIP_MENU, context, arg).map((item) => item.label);
    expect(labels({ file: "a.md" }).at(-1)).toBe("Copy path");
    expect(labels({ folder: "notes" }).at(-1)).toBe("Copy path");
    const clear = vi.fn();
    expect(labels({ file: "a.md", clear }).slice(-2)).toEqual(["Copy path", "Clear"]);
    await commands.run(CLEAR_CHIP, context, { file: "a.md", clear });
    expect(clear).toHaveBeenCalledOnce();
    installed.dispose();
  });

  it("offers a tab's Rename as its tree row's, the name typed in a dialog", async () => {
    const prompt = vi.fn(async () => "c");
    const { tabs, workspace, area, commands, menus, strips } = await setup(splitSetting(), {
      prompt,
    } as unknown as DialogService);
    // The tree's Rename, as the Space view registers it: the name typed on the surface its target names.
    const named: string[] = [];
    commands.register({
      id: "tree.rename",
      label: "Rename…",
      when: (_, arg) => (arg as { node: unknown }).node !== null,
      run: (_, arg) => {
        const { node, naming } = arg as { node: { path: string }; naming: NamingSurface };
        naming.rename(node.path, (name) => named.push(name));
      },
    });
    await tabs.openEntry("a.md");
    await tabs.openNew("group-1");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };

    const items = menus.resolve("editor.tab", context, { groupId: "group-1", index: 0 });
    expect(items.map((item) => item.label)).toEqual(["Split", "Move to the side", "Rename…", "Close", "Close others"]);
    const newTab = menus.resolve("editor.tab", context, { groupId: "group-1", index: 1 });
    expect(newTab.map((item) => item.label)).not.toContain("Rename…");

    const rename = items[2];
    expect(rename.arg).toMatchObject({ node: { name: "a.md", path: "a.md", type: "file" } });
    // A right-click focuses the pill; the dialog would hand focus back to it.
    const pill = strips()[0].querySelector<HTMLElement>(".editor-tab");
    pill?.focus();
    expect(document.activeElement).toBe(pill);
    await commands.run("tree.rename", context, rename.arg);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: "Rename file", value: "a" }));
    expect(document.activeElement).not.toBe(pill);
    await vi.waitFor(() => expect(named).toEqual(["c.md"]));
  });

  it("offers New Note, Table, Flow and Class on an empty tab, made at the space's top, the name typed in a dialog", async () => {
    const prompt = vi.fn(async () => "Plans");
    const { tabs, root, commands } = await setup(splitSetting(), { prompt } as unknown as DialogService);
    // The tree's creates, as the Space view registers them: the name typed on the surface their target names.
    const made: unknown[] = [];
    for (const [id, label, kind] of [
      ["tree.newNote", "New Note", "note"],
      ["tree.newTable", "New Table", "table"],
      ["tree.newFlow", "New Flow", "flow"],
      ["tree.newClass", "New Class", "class"],
    ] as const) {
      commands.register({
        id,
        label,
        run: (_, arg) => {
          const { node, naming } = arg as { node: unknown; naming: NamingSurface };
          const pending = { parentPath: "", type: "file" as const, kind };
          naming.create(pending, (name) => made.push({ node, kind, name }));
        },
      });
    }
    await tabs.openNew("group-1");

    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".editor-empty-action")];
    expect(buttons.map((button) => button.textContent)).toEqual(["New Note", "New Table", "New Flow", "New Class"]);
    expect(buttons.map((button) => button.querySelector("[data-entry-icon]")?.getAttribute("data-entry-icon"))).toEqual(
      ["markdown", "table", "flow", "class"],
    );
    // A caret elsewhere, which a press on the button needn't take: the dialog would hand focus back to it.
    const caret = document.body.appendChild(document.createElement("textarea"));
    caret.focus();
    buttons[1].click();
    expect(document.activeElement).toBe(document.body);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New Table", icon: { glyph: "table" }, placeholder: "Table name" }),
    );
    await vi.waitFor(() => expect(made).toEqual([{ node: null, kind: "table", name: "Plans" }]));
  });

  it("offers a linked file Open and Open to the side, acting on the linked file", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const target = { file: "b.md" };
    expect(menus.resolve("editor.linkedFile", context, target).map((item) => item.label)).toEqual([
      "Open",
      "Open to the side",
      "Show in editor",
    ]);

    // Both commands start the open without awaiting it, as from the tree.
    await commands.run("editor.openToSide", context, target);
    await vi.waitFor(() => expect(workspace.groups().map((group) => paths(group.tabs))).toEqual([["a.md"], ["b.md"]]));

    tabs.focusGroup(workspace.groups()[0].id);
    await commands.run("editor.open", context, { file: "b.md" });
    await vi.waitFor(() => expect(paths(workspace.groups()[0].tabs)).toEqual(["b.md"]));
  });

  it("offers a preview's file Open, Open in new tab and Open to the side", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const target = { file: "b.md" };
    expect(menus.resolve(PREVIEW_OPEN_MENU, context, target).map((item) => item.label)).toEqual([
      "Open",
      "Open in new tab",
      "Open to the side",
    ]);

    await commands.run("editor.openInNewTab", context, target);
    await vi.waitFor(() => expect(paths(workspace.groups()[0].tabs)).toEqual(["a.md", "b.md"]));
  });

  // The Bookmarks view registers the bookmark commands; a stand-in here.
  it("offers a clip's or still's Open, Open in new tab and Open to the side, its Guides and Looks, then its Bookmark", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    commands.register({
      id: "bookmarks.add",
      label: "Bookmark",
      when: (_, arg) => typeof arg === "object" && arg !== null && "bookmark" in arg,
      run: vi.fn(),
    });
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const items = menus.resolve(MEDIA_MENU, context, { file: "b.mp4", bookmark: "b.mp4" });
    expect(items.map((item) => [item.label, item.group])).toEqual([
      ["Open", "open"],
      ["Open in new tab", "open"],
      ["Open to the side", "open"],
      ["Guides", "guides"],
      ["Looks", "guides"],
      ["Bookmark", "bookmark"],
    ]);
    // A vector image has no pixels to grade.
    const vector = menus.resolve(MEDIA_MENU, context, { file: "logo.svg", bookmark: "logo.svg" });
    expect(vector.map((item) => item.label)).toEqual([
      "Open",
      "Open in new tab",
      "Open to the side",
      "Guides",
      "Bookmark",
    ]);
    // Nor does a Flow's clip, which shows no look.
    const flowClip = menus.resolve(MEDIA_MENU, context, { file: "b.mp4", bookmark: "b.mp4", looks: false });
    expect(flowClip.map((item) => item.label)).toEqual([
      "Open",
      "Open in new tab",
      "Open to the side",
      "Guides",
      "Bookmark",
    ]);
  });

  // A group holds one tab per file, so Open and Open in new tab would stay put.
  it("leaves out Open and Open in new tab in the clip's or still's own tab", async () => {
    const { menus } = await setup();
    const resolved = (tab: Tab, file: string) =>
      menus.resolve(MEDIA_MENU, { tab, pane: undefined }, { file, bookmark: file }).map((item) => item.label);
    expect(resolved({ kind: "video", path: "b.mp4" }, "b.mp4")).toEqual(["Open to the side", "Guides", "Looks"]);
    expect(resolved({ kind: "image", path: "art/a.png" }, "art/a.png")).toEqual([
      "Open to the side",
      "Guides",
      "Looks",
    ]);
    // Another file's tab, or none, opens it as anywhere else.
    expect(resolved({ kind: "video", path: "a.mp4" }, "b.mp4").slice(0, 3)).toEqual([
      "Open",
      "Open in new tab",
      "Open to the side",
    ]);
    expect(resolved({ kind: "empty" }, "b.mp4").slice(0, 2)).toEqual(["Open", "Open in new tab"]);
  });

  it("offers a previewed page's Open, Open in new tab and Open to the side, then its Bookmark", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    commands.register({
      id: "bookmarks.add",
      label: "Bookmark",
      when: (_, arg) => typeof arg === "object" && arg !== null && "bookmark" in arg,
      run: vi.fn(),
    });
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const target = { file: "b.md", bookmark: "b.md" };
    expect(menus.resolve(PREVIEW_PAGE_MENU, context, target).map((item) => [item.label, item.group])).toEqual([
      ["Open", "open"],
      ["Open in new tab", "open"],
      ["Open to the side", "open"],
      ["Bookmark", "bookmark"],
    ]);

    await commands.run("editor.openInNewTab", context, target);
    await vi.waitFor(() => expect(paths(workspace.groups()[0].tabs)).toEqual(["a.md", "b.md"]));
  });

  it("offers a graph node's Open, Open in new tab and Open to the side, a folder's as a gallery", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    const { galleryPane } = await import("../../web/view/panes/galleryPane.ts");
    const { GRAPH_NODE_MENU, graphNodeTarget } = await import("../../web/graph/graphView.ts");
    galleryPane({
      commands,
      menus,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      tabs: () => tabs,
      dialog: vi.fn(),
      formats: testFormats(),
    });
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const items = (id: string) => menus.resolve(GRAPH_NODE_MENU, context, graphNodeTarget(id));
    const opens = ["Open", "Open in new tab", "Open to the side"];

    expect(items("b.md").map((item) => item.label)).toEqual(opens);
    expect(items("b.md").map((item) => item.command)).toEqual([
      "editor.open",
      "editor.openInNewTab",
      "editor.openToSide",
    ]);
    expect(items("notes/").map((item) => item.label)).toEqual(opens);
    expect(items("notes/").map((item) => item.arg)).toEqual(Array(3).fill({ folder: "notes" }));
    expect(items("notes/").map((item) => item.command)).toEqual([
      "gallery.openFolder",
      "gallery.openFolderInNewTab",
      "gallery.openFolderToSide",
    ]);
  });

  it("offers a linked Applet Edit on the side, and only an Applet, opening its code in the other group", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const applet = { file: "tools/hello.applet.html" };
    expect(menus.resolve("editor.linkedFile", context, applet).map((item) => item.label)).toEqual([
      "Open",
      "Open to the side",
      "Edit on the side",
      "Show in editor",
    ]);
    // The toolbar's menu names no file: it takes the focused tab, while that runs an Applet.
    const toolbar = (tab: Tab) => menus.resolve("editor.toolbar", { tab, pane: undefined }).map((item) => item.label);
    expect(toolbar(context.tab)).not.toContain("Edit on the side");
    expect(toolbar({ kind: "applet", path: "tools/hello.applet.html" })).toContain("Edit on the side");

    await commands.run("editor.editToSide", context, applet);
    await vi.waitFor(() =>
      expect(workspace.groups().map((group) => group.tabs.map((tab) => tab.kind))).toEqual([
        ["document"],
        ["applet-source"],
      ]),
    );
  });

  it("reads a document it edits on the side, the keyboard staying in the editor", async () => {
    const { tabs, workspace, area, commands, menus, columns } = await setup();
    await tabs.openEntry("a.md");
    const context = () => ({ tab: workspace.activeTab(), pane: area.focusedPane() });
    const labels = (menu: string) => menus.resolve(menu, context()).map((item) => item.label);
    expect(labels("editor.toolbar")).toEqual(expect.arrayContaining(["Read on the side", "Split Editor"]));
    expect(labels("editor.toolbar")).not.toContain("Edit on the side");
    expect(labels(COMMAND_PALETTE)).toContain("Read on the side");

    await commands.run("editor.readToSide", context());

    expect(
      workspace.groups().map((group) => [group.tabs.map((tab) => tab.kind !== "empty" && tab.path), group.readingView]),
    ).toEqual([
      [["a.md"], false],
      [["a.md"], true],
    ]);
    expect(workspace.focusedGroup()).toBe(workspace.groups()[0]);
    expect(columns()[1].querySelector<HTMLElement>(".editor-reading")?.hidden).toBe(false);
  });

  it("edits a document it reads on the side, the keyboard going to the editor", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    const context = () => ({ tab: workspace.activeTab(), pane: area.focusedPane() });
    await commands.run("editor.toggleReadingView", context());
    const labels = (menu: string) => menus.resolve(menu, context()).map((item) => item.label);
    expect(labels("editor.toolbar")).toContain("Edit on the side");
    expect(labels("editor.toolbar")).not.toContain("Read on the side");
    expect(labels(COMMAND_PALETTE)).toContain("Edit on the side");
    expect(labels(COMMAND_PALETTE)).not.toContain("Applet: Edit on the side");

    await commands.run("editor.editToSide", context());

    expect(
      workspace.groups().map((group) => [group.tabs.map((tab) => tab.kind !== "empty" && tab.path), group.readingView]),
    ).toEqual([
      [["a.md"], true],
      [["a.md"], false],
    ]);
    expect(workspace.focusedGroup()).toBe(workspace.groups()[1]);
    expect(area.focusedDocumentPane()?.view.state.readOnly).toBe(false);
  });

  it("marks both tabs of a document edited on one side and read on the other, and lights one side from the other's mark", async () => {
    const { tabs, workspace, area, commands, strips, columns } = await setup();
    await tabs.openEntry("a.md");
    const context = () => ({ tab: workspace.activeTab(), pane: area.focusedPane() });
    const frames = async () => {
      for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const marks = () => strips().map((strip) => strip.querySelectorAll(".editor-tab.active > .editor-tab-sync").length);
    const lit = (side: number) => [
      strips()[side].querySelector(".editor-tab.active")?.classList.contains("sync-partner"),
      columns()[side].querySelector(".editor-pane-host")?.classList.contains("sync-partner"),
    ];

    await commands.run("editor.readToSide", context());
    await frames();
    expect(marks()).toEqual([1, 1]);

    const mark = strips()[0].querySelector(".editor-tab-sync");
    mark?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect([lit(0), lit(1)]).toEqual([
      [false, false],
      [true, true],
    ]);
    mark?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect(lit(1)).toEqual([false, false]);

    // Both sides editing: nothing scrolls as one.
    tabs.focusGroup(workspace.groups()[1].id);
    await commands.run("editor.toggleReadingView", context());
    await frames();
    expect(marks()).toEqual([0, 0]);
  });

  it("opens a note opened in place on either side of a pair on the other side too, each keeping its mode", async () => {
    const { tabs, workspace, area, commands, strips } = await setup();
    await tabs.openEntry("a.md");
    const context = () => ({ tab: workspace.activeTab(), pane: area.focusedPane() });
    const frames = async () => {
      for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const shown = () =>
      workspace.groups().map((group) => {
        const tab = workspace.activeTabOf(group);
        return [tab.kind === "empty" ? "empty" : tab.path, group.readingView];
      });
    await commands.run("editor.readToSide", context());
    await frames();

    // From the tree, on the editing side.
    await tabs.openEntry("b.md");
    expect(shown()).toEqual([
      ["b.md", false],
      ["b.md", true],
    ]);
    await frames();
    expect(strips().map((strip) => strip.querySelectorAll(".editor-tab.active > .editor-tab-sync").length)).toEqual([
      1, 1,
    ]);

    // A link followed on the reading side moves the editor too.
    tabs.focusGroup(workspace.groups()[1].id);
    await tabs.openSpacePath("a.md");
    expect(shown()).toEqual([
      ["a.md", false],
      ["a.md", true],
    ]);
    expect(workspace.focusedGroup()).toBe(workspace.groups()[1]);
  });

  it("offers neither way to the side for a read-only file, which is only ever read", async () => {
    const { tabs, workspace, area, menus } = await setup();
    await tabs.openEntry("lib:pool/c.md");
    const labels = menus
      .resolve("editor.toolbar", { tab: workspace.activeTab(), pane: area.focusedPane() })
      .map((item) => item.label);
    expect(labels).not.toContain("Read on the side");
    expect(labels).not.toContain("Edit on the side");
  });

  it("shows a Links row's file in the editor, leaving reading view for the text", async () => {
    const { tabs, workspace, area, commands } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const toggle = document.querySelector(".editor-toolbar-reading-toggle");
    await commands.run("editor.toggleReadingView", context);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    const reveal = vi.spyOn(area.focusedDocumentPane() as DocumentPane, "revealMention");
    await commands.run("editor.showInEditor", context, { file: "b.md" });
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(reveal).toHaveBeenCalledWith("b.md");
  });

  it("shows a note from Backlinks in the document's place, out of reading view, at its mention of the document", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const linking = { file: "b.md", target: "a.md" };
    expect(menus.resolve("editor.linkingNote", context, linking).map((item) => item.label)).toEqual([
      "Open",
      "Open to the side",
      "Show in editor",
    ]);
    const toggle = document.querySelector(".editor-toolbar-reading-toggle");
    await commands.run("editor.toggleReadingView", context);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    const reveal = vi.spyOn(area.focusedDocumentPane() as DocumentPane, "revealMention");
    await commands.run("editor.showLinkingMention", context, linking);
    expect(workspace.activeTab()).toMatchObject({ path: "b.md" });
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(reveal).toHaveBeenCalledWith("a.md");
  });

  it("offers a linked name in the text Show in links too, which opens the Links tab on the focused pane's row", async () => {
    const { tabs, workspace, area, commands, menus, inspector } = await setup();
    await tabs.openEntry("a.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    const target = { file: "b.md" };
    expect(menus.resolve("editor.linkedName", context, target).map((item) => item.label)).toEqual([
      "Open",
      "Open to the side",
      "Show in links",
    ]);

    const reveal = vi.spyOn(area.focusedDocumentPane() as DocumentPane, "revealLink");
    await commands.run("editor.showInLinks", context, target);
    expect(inspector.show).toHaveBeenCalledWith("links");
    expect(reveal).toHaveBeenCalledWith("b.md");
    expect(document.activeElement?.closest(".cm-editor")).not.toBeNull();
  });

  it("closes the focused group's active tab when Close comes with no pill, from a key or the palette", async () => {
    const { tabs, workspace, area, commands, menus } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openNew("group-1");
    await tabs.openEntry("b.md");
    const context = { tab: workspace.activeTab(), pane: area.focusedPane() };
    expect(menus.commandsIn("commandPalette", context)).toContainEqual({ command: "tab.close", label: "Close Tab" });
    expect(await commands.run("tab.close", context)).toBe(true);
    expect(paths(workspace.groups()[0].tabs)).toEqual(["a.md"]);
  });

  it("moves a tab carried onto the other strip there, its pill going with it", async () => {
    const { tabs, workspace, stripHost, strips } = await setup();
    const restore = layOutStrips(stripHost);
    try {
      await tabs.openEntry("a.md");
      await tabs.openToSide("b.md");
      const pill = strips()[0].querySelector(".editor-tab") as HTMLElement;

      // Past b.md's middle on the second strip: the tab lands after it.
      await carryTab(pill, 480);
      await vi.waitFor(() => expect(workspace.groups()).toHaveLength(1));
      expect(paths(workspace.groups()[0].tabs)).toEqual(["b.md", "a.md"]);
      expect(workspace.activeTab()).toMatchObject({ path: "a.md" });
      const pills = [...strips()[0].querySelectorAll(".editor-tab")];
      expect(pills[1]).toBe(pill);
      expect(pills.map((each) => each.classList.contains("active"))).toEqual([false, true]);
      expect(stripHost.querySelector(".editor-tab-gap, .leaving")).toBeNull();
      expect(stripHost.classList.contains("tab-dragging")).toBe(false);
    } finally {
      restore();
    }
  });

  it("carries a New tab onto the other strip as it does any tab", async () => {
    const { tabs, workspace, stripHost, strips } = await setup();
    const restore = layOutStrips(stripHost);
    try {
      await tabs.openEntry("a.md");
      await tabs.openToSide("b.md");
      await tabs.openNew("group-1");
      const pill = strips()[0].querySelectorAll(".editor-tab")[1];

      await carryTab(pill, 480);
      await vi.waitFor(() => expect(paths(workspace.groups()[1].tabs)).toEqual(["b.md", "empty"]));
      expect(paths(workspace.groups()[0].tabs)).toEqual(["a.md"]);
      expect(workspace.activeTab()).toMatchObject({ kind: "empty" });
      expect([...strips()[1].querySelectorAll(".editor-tab")][1]).toBe(pill);
    } finally {
      restore();
    }
  });

  // The press selects the carried tab, so the group shows it when it lands.
  it("reorders a tab carried along its own strip, which the press made the shown one", async () => {
    const { tabs, workspace, stripHost, strips } = await setup();
    const restore = layOutStrips(stripHost);
    try {
      await tabs.openEntry("a.md");
      await tabs.openNew("group-1");
      await tabs.openEntry("b.md");
      const pill = strips()[0].querySelector(".editor-tab") as HTMLElement;

      await carryTab(pill, 260);
      expect(paths(workspace.focusedGroup().tabs)).toEqual(["b.md", "a.md"]);
      expect(workspace.activeTab()).toMatchObject({ path: "a.md" });
      expect([...strips()[0].querySelectorAll(".editor-tab")][1]).toBe(pill);
    } finally {
      restore();
    }
  });

  // The press selects the tab, as a browser's does, before any drag.
  it("selects a tab on press", async () => {
    const { tabs, workspace, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openNew("group-1");
    await tabs.openEntry("b.md");
    const first = strips()[0].querySelector(".editor-tab") as HTMLElement;
    first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    await vi.waitFor(() => expect(workspace.activeTab()).toMatchObject({ path: "a.md" }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
  });

  // The pill under the pointer has to stay the same element through a focus
  // move, or the drag starting from it never begins.
  it("keeps a strip's pills when a press only moves focus", async () => {
    const { tabs, workspace, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    const pill = strips()[0].querySelector(".editor-tab");

    pill?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(workspace.focusedGroup()).toBe(workspace.groups()[0]);
    expect(strips()[0].querySelector(".editor-tab")).toBe(pill);
  });

  it("takes a closed group's column and strip away, and the divider with them", async () => {
    const { tabs, workspace, root, stripHost, columns, strips } = await setup();
    await tabs.openEntry("a.md");
    await tabs.split();
    expect(columns()).toHaveLength(2);
    expect(columns()[1].previousElementSibling?.classList.contains("editor-group-divider")).toBe(true);
    expect(strips()[1].previousElementSibling?.classList.contains("editor-group-header-divider")).toBe(true);

    await tabs.close(workspace.groups()[1].id, 0);
    expect(columns()).toHaveLength(1);
    expect(strips()).toHaveLength(1);
    expect(root.querySelector(".editor-group-divider")).toBeNull();
    expect(stripHost.querySelector(".editor-group-header-divider")).toBeNull();
  });

  it("splits the row by the remembered share", async () => {
    const { tabs, columns } = await setup(splitSetting(0.3));
    await tabs.openEntry("a.md");
    await tabs.split();

    expect(columns().map((column) => Number(column.style.flexGrow))).toEqual([0.3, 0.7]);
  });

  // On macOS the traffic lights and the sidebar toggle can take more of the
  // header than a collapsed sidebar leaves, so the tab area starts later.
  it("ends the first strip where its group ends, wherever the tab area starts", async () => {
    const { tabs, stripHost, columns, strips } = await setup();
    await tabs.openEntry("a.md");
    vi.spyOn(stripHost, "getBoundingClientRect").mockReturnValue(new DOMRect(132, 0, 900, 40));
    vi.spyOn(columns()[0], "getBoundingClientRect").mockReturnValue(new DOMRect(54, 40, 500, 600));
    await tabs.split();

    expect(strips()[0].style.flexBasis).toBe("422px");
  });

  it("remembers the divider as the left group's share when its drag ends", async () => {
    const split = splitSetting();
    const { tabs, root, stripHost, columns } = await setup(split);
    await tabs.openEntry("a.md");
    await tabs.split();
    // jsdom lays nothing out: the row the drag measures is given a width.
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));

    root.querySelector(".editor-group-divider")?.dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    expect(stripHost.querySelector(".editor-group-header-divider")?.classList.contains("dragging")).toBe(true);
    expect(split.get()).toBeUndefined();
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(split.get()).toBe(0.4);
    expect(Number(columns()[0].style.flexGrow)).toBe(0.4);
  });
  it("gives each group a status bar of its own, naming its own file and counting its own words and notices", async () => {
    const { tabs, notices, bars, barPart } = await setup();
    await tabs.openEntry("a.md");
    const count = barPart(0, "wordcount")?.textContent;
    expect(count).not.toBe("");
    await tabs.openToSide("b.md");

    expect(bars().map((bar) => bar?.hidden)).toEqual([false, false]);
    expect([barPart(0, "path")?.textContent, barPart(1, "path")?.textContent]).toEqual(["a.md", "b.md"]);
    expect(barPart(0, "wordcount")?.textContent).toBe(count);
    expect(barPart(1, "wordcount")?.textContent).not.toBe(count);

    notices.reportProblems("b.md", ["An unknown node type"]);
    expect([barPart(0, "problems")?.hidden, barPart(1, "problems")?.hidden]).toEqual([true, false]);
    notices.add("a.md", "publish", { level: "info", kind: "publish", label: "a.md", content: "Published", count: 1 });
    expect([barPart(0, "notices")?.hidden, barPart(1, "notices")?.hidden]).toEqual([false, true]);
  });

  it("hides only the bar of a group showing an empty tab, whichever group has focus", async () => {
    const { tabs, workspace, bars } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    await tabs.openNew(workspace.groups()[1].id);
    expect(bars().map((bar) => bar?.hidden)).toEqual([false, true]);

    tabs.focusGroup(workspace.groups()[0].id);
    expect(bars().map((bar) => bar?.hidden)).toEqual([false, true]);
  });

  it("goes back in the bar's own group, focusing it, while the other keeps its place", async () => {
    const { tabs, workspace, barPart } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openEntry("b.md");
    await tabs.openToSide("a.md");
    const back = barPart<HTMLButtonElement>(0, "back");
    expect([back?.disabled, barPart<HTMLButtonElement>(1, "back")?.disabled]).toEqual([false, true]);

    back?.click();
    await vi.waitFor(() => expect(paths(workspace.groups()[0].tabs)).toEqual(["a.md"]));
    expect(workspace.focusedGroup()).toBe(workspace.groups()[0]);
    expect(paths(workspace.groups()[1].tabs)).toEqual(["a.md"]);
  });

  it("keeps the save warning and model activity in the rightmost bar that shows", async () => {
    const { tabs, workspace, columns, indicators } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openToSide("b.md");
    const holder = () => columns().findIndex((column) => column.contains(indicators.save));
    expect(holder()).toBe(1);
    expect(columns()[1].contains(indicators.activity)).toBe(true);

    await tabs.openNew(workspace.groups()[1].id);
    expect(holder()).toBe(0);
    await tabs.switchTo(workspace.groups()[1].id, 0);
    expect(holder()).toBe(1);

    await tabs.close(workspace.groups()[1].id, 1);
    await tabs.close(workspace.groups()[1].id, 0);
    expect(columns()).toHaveLength(1);
    expect(holder()).toBe(0);
  });

  it("shows the bar holding the save warning while a save fails, even over an empty tab", async () => {
    const { tabs, indicators, bars } = await setup();
    await tabs.openEntry("a.md");
    await tabs.openNew("group-1");
    expect(bars()[0]?.hidden).toBe(true);

    indicators.renderSave({ failedPaths: ["a.md"], conflictPaths: [] });
    expect(bars()[0]?.hidden).toBe(false);
    indicators.renderSave({ failedPaths: [], conflictPaths: [] });
    expect(bars()[0]?.hidden).toBe(true);
  });

  it("unfolds only the kind of tab named, so turning off one page's markers leaves the other's folds", async () => {
    const { tabs, area, root } = await setup();
    await tabs.openAppletCode("tools/hello.applet.html");
    const content = root.querySelector<HTMLElement>(".editor-applet-source .cm-editor");
    if (!content) throw new Error("no Edit code view");
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error("no editor on the Edit code view");
    view.dispatch({ effects: foldEffect.of({ from: 6, to: 20 }) });

    area.unfoldAll("document");
    expect(foldedRanges(view.state).size).toBe(1);
    area.unfoldAll("applet-source");
    expect(foldedRanges(view.state).size).toBe(0);
  });

  // The tree lists a folder in its own order, so a sort picked here is the
  // gallery's to keep current: a save can move a note by its value, and a
  // folder by its index.md's.
  it("lists a gallery sorted here by a property again after a save in its folder", async () => {
    const { tabs, panes, area } = await setup();
    const refresh = vi.fn();
    let local: SortChoice | undefined = { by: "property", property: "date", order: "desc" };
    const gallery = {
      kind: "gallery" as const,
      element: document.createElement("div"),
      setInput: async () => undefined,
      clearInput: () => undefined,
      title: () => "shots",
      dispose: () => undefined,
      refresh,
      sortTarget: () => ({
        path: "shots",
        name: "shots",
        order: { default: NAME_ORDER, ...(local ? { local } : {}) },
        shown: () => [],
        keepsOrder: true,
      }),
    };
    panes.register({
      kind: "gallery",
      chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
      create: () => gallery,
    });
    await tabs.openFolder("shots");

    area.noteSaved("shots/take.md");
    area.noteSaved("shots/act/index.md");
    expect(refresh).toHaveBeenCalledTimes(2);
    area.noteSaved("elsewhere/take.md");
    area.noteSaved("shots/still.png");
    local = undefined;
    area.noteSaved("shots/take.md");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
