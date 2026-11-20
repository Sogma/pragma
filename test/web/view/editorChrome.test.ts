// @vitest-environment jsdom
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { LibraryRow, Tab } from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import type { FlowView } from "../../../web/flow/xyflowAdapter.ts";
import { createCommands } from "../../../web/services/commands.ts";
import type { DialogService, PromptOptions } from "../../../web/services/dialog.ts";
import { createEditorPanes, type EditorPane } from "../../../web/services/editorPanes.ts";
import type { FormatActions } from "../../../web/services/formats.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { COMMAND_PALETTE, createMenus, type MenuItem } from "../../../web/services/menus.ts";
import type { ContextMenu } from "../../../web/view/contextMenu.ts";
import { createEditorChrome, registerEditorChromeCommands } from "../../../web/view/editorChrome.ts";
import type { EditorTitleBar } from "../../../web/view/editorTitleBar.ts";
import type { DocumentPane } from "../../../web/view/panes/documentPane.ts";
import { memorySetting } from "../support/editorLayout.ts";
import { testFormats } from "../support/formats.ts";

// A pane that only keeps the two things the chrome reads back: whether it
// is designing, and a layout to offer.
function fakePane() {
  const pane = {
    kind: "table" as const,
    element: document.createElement("div"),
    designing: false,
    setInput: async () => undefined,
    clearInput: () => undefined,
    title: (): string | undefined => "Takes",
    titleHost: () => document.createElement("div"),
    refresh: vi.fn(),
    design: {
      isActive: () => pane.designing,
      toggle: () => {
        pane.designing = !pane.designing;
      },
    },
    layout: { current: () => "list", set: () => undefined, available: () => [{ id: "list", label: "List" }] },
    dispose: () => undefined,
  };
  return pane satisfies EditorPane;
}

const library = (id: string, access: LibraryRow["access"]): LibraryRow => ({
  id,
  label: id,
  path: `/${id}`,
  access,
  missing: false,
});

beforeEach(() => {
  setLibraryPermissions([]);
});

function setup(
  tab: Tab,
  reading = false,
  documentPane?: DocumentPane,
  dialog: Partial<DialogService> = {},
  flowView?: FlowView,
) {
  const commands = createCommands();
  const menus = createMenus(commands);
  const panes = createEditorPanes();
  const pane = fakePane();
  // On a note the focused pane is the document pane, whose find the chrome
  // reads through the pane contract.
  if (documentPane?.findable) {
    const findable = () => documentPane.findable();
    const openFind = (replace: boolean) => (documentPane as Partial<DocumentPane>).openFind?.(replace);
    Object.assign(pane, { findable, openFind });
  }
  const create = () => pane;
  let readingView = reading;
  let sourceMode = false;
  const formatColumn = memorySetting(false);
  const takeBack = vi.fn();
  const announce = vi.fn(() => takeBack);
  const titleBar = { show: vi.fn(), hide: vi.fn() } satisfies EditorTitleBar;
  panes.register({
    kind: "table",
    chrome: { toolbar: true, readingView: true, statusbar: true, actions: ["data-design"] },
    create,
  });
  panes.register({
    kind: "document",
    chrome: { toolbar: true, readingView: true, statusbar: true, actions: ["add-property"] },
    create,
  });
  panes.register({
    kind: "flow",
    chrome: { toolbar: true, readingView: false, statusbar: true, actions: ["flow-run"] },
    create,
  });
  const chrome = createEditorChrome({
    panes,
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false, dispose: vi.fn() } as unknown as ContextMenu,
    titleBar,
    activeTab: () => tab,
    activePane: () => pane,
    activeFlowView: () => undefined,
    readingView: () => readingView,
    setReadingView: (on) => {
      readingView = on;
    },
    sourceMode: () => sourceMode,
    setSourceMode: (on) => {
      sourceMode = on;
    },
    showRuns: vi.fn(),
    announce,
  });
  const keybindings = createKeybindings(commands);
  registerEditorChromeCommands({
    commands,
    keybindings,
    menus,
    panes,
    dialog: () => dialog as DialogService,
    focused: () => chrome,
    activeFlowView: () => flowView,
    activeDocumentPane: () => documentPane,
    openAppletCode: vi.fn(async () => undefined),
    runApplet: vi.fn(async () => undefined),
    formats: testFormats(),
    formatColumn,
  });
  chrome.activate(tab);
  const readingToggle = chrome.toolbar.querySelector<HTMLButtonElement>(".editor-toolbar-reading-toggle");
  if (!readingToggle) throw new Error("the toolbar has no reading toggle");
  const context = () => ({ tab, pane });
  const toolbar = () => menus.resolve("editor.toolbar", context());
  const item = (label: string) => toolbar().find((entry) => entry.label === label);
  const pick = (label: string) => item(label)?.run?.(context(), undefined);
  const palette = () => menus.resolve(COMMAND_PALETTE, context()).map((entry) => entry.label);
  return {
    chrome,
    pane,
    readingToggle,
    toolbar,
    item,
    pick,
    palette,
    commands,
    keybindings,
    context,
    formatColumn,
    announce,
    takeBack,
    titleBar,
  };
}

const table: Tab = { kind: "table", path: "takes.table.html" };
const note: Tab = { kind: "document", path: "note.md", documentType: "note" };
const flow: Tab = { kind: "flow", path: "a.flow.html" };

describe("editorChrome modes", () => {
  it("a table's menu offers Design as a checkbox beside Layout, unchecked to start", () => {
    const { toolbar, readingToggle } = setup(table);
    expect(toolbar().map((entry) => [entry.label, entry.checked, entry.disabled])).toEqual([
      ["Design", false, false],
      ["Layout", undefined, undefined],
    ]);
    expect(readingToggle.hidden).toBe(false);
  });

  // Reading view and Design always exclude each other, and the pane is
  // refreshed once the pair is settled.
  it("picking Design leaves reading view, unchecking it returns to Edit, and Layout hides while designing", () => {
    const { chrome, pane, readingToggle, toolbar, item, pick } = setup(table);
    readingToggle.click();
    pick("Design");
    expect(pane.designing).toBe(true);
    expect(chrome.isReadingView()).toBe(false);
    expect(readingToggle.getAttribute("aria-pressed")).toBe("false");
    expect(toolbar().map((entry) => [entry.label, entry.checked])).toEqual([["Design", true]]);
    expect(pane.refresh).toHaveBeenCalled();

    pick("Design");
    expect(chrome.currentMode()).toBe("edit");
    expect(pane.designing).toBe(false);
    expect(item("Design")?.checked).toBe(false);
    expect(item("Layout")).toBeDefined();
  });

  it("the toolbar button walks Read and Edit, and leaving Design by it drops Design", () => {
    const { chrome, pane, readingToggle, pick } = setup(table);
    pick("Design");
    readingToggle.click();
    expect(chrome.isReadingView()).toBe(true);
    expect(pane.designing).toBe(false);
    readingToggle.click();
    expect(chrome.isReadingView()).toBe(false);
    expect(pane.designing).toBe(false);
  });

  it("draws the toggle pressed for a group already in reading view", () => {
    const { chrome, readingToggle } = setup(note, true);
    expect(chrome.isReadingView()).toBe(true);
    expect(readingToggle.getAttribute("aria-pressed")).toBe("true");
    expect(readingToggle.getAttribute("aria-label")).toBe("Switch to editing");
  });

  // The menu never repeats a toolbar control, and Read and Edit are the
  // toggle's.
  it("offers Design only where the pane declares it, and Read and Edit nowhere", () => {
    for (const tab of [table, note, flow]) {
      const labels = setup(tab)
        .toolbar()
        .map((entry) => entry.label);
      expect(labels).not.toContain("Read");
      expect(labels).not.toContain("Edit");
      expect(labels.includes("Design")).toBe(tab === table);
    }
  });

  // Shown disabled rather than hidden, so the menu says why the shape is
  // fixed; the palette lists only commands that run, so it drops Design.
  it("a read-only library tab is pinned to reading view, with Design shown disabled", () => {
    const tab: Tab = { kind: "table", path: "lib:pool/pool.table.html" };
    setLibraryPermissions([library("pool", "read-only")]);
    const readOnly = setup(tab);
    expect(readOnly.chrome.isReadingView()).toBe(true);
    expect(readOnly.readingToggle.hidden).toBe(true);
    expect(readOnly.item("Design")).toMatchObject({ checked: false, disabled: true });
    expect(readOnly.palette()).not.toContain("Toggle design mode");

    setLibraryPermissions([library("pool", "read-write")]);
    const writable = setup(tab);
    expect(writable.item("Design")).toMatchObject({ checked: false, disabled: false });
    expect(writable.palette()).toContain("Toggle design mode");
  });
});

// A title of the document's own is the field's text; with none, the field is
// empty and the filename shows as its placeholder, grey.
describe("editorChrome title bar", () => {
  it("shows the pane's title, else the filename as the placeholder", () => {
    const { chrome, pane, titleBar } = setup(table);
    chrome.refreshTitle();
    expect(titleBar.show).toHaveBeenLastCalledWith({ text: "Takes", placeholder: "takes" }, expect.any(HTMLElement));

    pane.title = () => undefined;
    chrome.refreshTitle();
    expect(titleBar.show).toHaveBeenLastCalledWith({ text: "", placeholder: "takes" }, expect.any(HTMLElement));
  });
});

describe("editorChrome Title", () => {
  function askTitle(name: string | undefined) {
    const prompt = vi.fn(async (_options: PromptOptions) => null);
    const flowView = { getFileName: () => name, setDisplayName: vi.fn(async (_name: string) => true) };
    const shown = setup(flow, false, undefined, { prompt }, flowView as unknown as FlowView);
    void shown.commands.get("flow.rename")?.run(shown.context(), undefined);
    const options = prompt.mock.calls[0]?.[0];
    if (!options) throw new Error("Title… asked nothing");
    return { ...shown, options, flowView };
  }

  it("asks under the Flow's icon, empty with the filename as placeholder while the Flow has no title", () => {
    expect(askTitle(undefined).options).toMatchObject({
      title: "Title",
      value: "",
      placeholder: "a",
      icon: { glyph: "flow" },
    });
  });

  it("starts from the Flow's own title", () => {
    expect(askTitle("Story Expander").options).toMatchObject({ value: "Story Expander", placeholder: "a" });
  });

  it("saves an emptied title as none, and redraws the title bar", async () => {
    const { options, flowView, titleBar } = askTitle("Story Expander");
    expect(options.validate).toBeUndefined();
    titleBar.show.mockClear();
    await options.submit?.("  ");
    expect(flowView.setDisplayName).toHaveBeenCalledWith("");
    expect(titleBar.show).toHaveBeenCalledTimes(1);
  });

  it("saves nothing when the title is left as it was", async () => {
    const { options, flowView } = askTitle(undefined);
    await options.submit?.("");
    expect(flowView.setDisplayName).not.toHaveBeenCalled();
  });
});

describe("editorChrome Source mode", () => {
  function notePane(hasSourceMode: boolean) {
    return {
      findable: () => "replace",
      hasSourceMode: () => hasSourceMode,
      formatActions: () => undefined,
      formatApplies: () => false,
      formatMenu: () => [],
    } as unknown as DocumentPane;
  }

  // Where Design sits on a Table, and like it a checkbox; the pane is
  // refreshed once the group's mode is set.
  it("offers Source mode first in a note's menu, checked while the group is in it", () => {
    const { chrome, pane, toolbar, item, commands, context } = setup(note, false, notePane(true));
    expect(toolbar()[0]).toMatchObject({ label: "Source mode", command: "editor.toggleSourceMode", checked: false });

    void commands.run("editor.toggleSourceMode", context());
    expect(chrome.isSourceMode()).toBe(true);
    expect(item("Source mode")?.checked).toBe(true);
    expect(pane.refresh).toHaveBeenCalled();

    void commands.run("editor.toggleSourceMode", context());
    expect(chrome.isSourceMode()).toBe(false);
  });

  it("leaves reading view as it is, in either direction", () => {
    const { chrome, readingToggle, commands, context } = setup(note, false, notePane(true));
    void commands.run("editor.toggleSourceMode", context());
    readingToggle.click();
    expect(chrome.isReadingView()).toBe(true);
    readingToggle.click();
    expect(chrome.isSourceMode()).toBe(true);
  });

  it("offers it nowhere the pane has none, and names it for the palette where it has", () => {
    expect(setup(note, false, notePane(false)).item("Source mode")).toBeUndefined();
    expect(setup(table).item("Source mode")).toBeUndefined();
    expect(setup(note, false, notePane(false)).palette()).not.toContain("Toggle Source mode");
    expect(setup(note, false, notePane(true)).palette()).toContain("Toggle Source mode");
  });
});

describe("editorChrome toolbar row", () => {
  it("mounts a pane's aside left of the toolbar's box and its overlay under it, and takes both down with the pane", () => {
    const { chrome } = setup(note);
    const aside = document.createElement("div");
    const below = document.createElement("div");
    chrome.mountPane({ ...fakePane(), toolbarAside: aside, toolbarBelow: below });

    const [slot, end] = chrome.toolbar.children;
    const [box, underSlot] = end.children;
    expect(slot.firstElementChild).toBe(aside);
    expect(box.classList.contains("floating-toolbar")).toBe(true);
    expect(underSlot.firstElementChild).toBe(below);

    chrome.mountPane(undefined);
    expect(slot.childElementCount).toBe(0);
    expect(underSlot.childElementCount).toBe(0);
  });

  it("hides only the box for a pane with no toolbar, so an aside can still show", () => {
    const { chrome } = setup({ kind: "empty" });
    expect(chrome.toolbar.hidden).toBe(false);
    expect(chrome.toolbar.querySelector<HTMLElement>(".editor-toolbar-box")?.hidden).toBe(true);
  });
});

describe("editorChrome find", () => {
  function findPane(findable: "find" | "replace" | undefined) {
    return {
      findable: () => findable,
      hasSourceMode: () => false,
      formatActions: () => undefined,
      formatApplies: () => false,
      formatMenu: () => [],
      openFind: vi.fn(),
    } as unknown as DocumentPane & { openFind: Mock };
  }

  it("lists Find… and Replace… in a group of their own, after the pane's own actions", () => {
    const { chrome, toolbar } = setup(note, false, findPane("replace"));
    chrome.setAddPropertyAvailable(true);
    expect(toolbar().map((entry) => [entry.label, entry.group])).toEqual([
      ["Layout", undefined],
      ["Add property…", undefined],
      ["Find…", "find"],
      ["Replace…", "find"],
    ]);
  });

  it("opens the card from each, with Replace showing from Replace…", () => {
    const documentPane = findPane("replace");
    const { commands, context } = setup(note, false, documentPane);
    void commands.run("document.find", context());
    void commands.run("document.replace", context());
    expect(documentPane.openFind.mock.calls).toEqual([[false], [true]]);
  });

  it("offers Find… alone over locked text, and neither where the card can't show", () => {
    const labels = (findable: "find" | "replace" | undefined) =>
      setup(note, false, findPane(findable))
        .toolbar()
        .map((entry) => entry.label);
    expect(labels("find")).toEqual(["Layout", "Find…"]);
    expect(labels(undefined)).toEqual(["Layout"]);
  });

  it("names them for the command palette, where no toolbar says which document", () => {
    const { palette } = setup(note, false, findPane("replace"));
    expect(palette()).toEqual(expect.arrayContaining(["Find in document…", "Replace in document…"]));
  });

  it("offers Find… on any pane that can search what it shows, a Table's among them", () => {
    const { pane, toolbar } = setup(table);
    expect(toolbar().map((entry) => entry.label)).not.toContain("Find…");

    Object.assign(pane, { findable: () => "find" });
    expect(toolbar().map((entry) => [entry.label, entry.group])).toEqual([
      ["Design", undefined],
      ["Layout", undefined],
      ["Find…", "find"],
    ]);
  });

  it("opens it on Ctrl+F where the pane can search, leaving the key to the browser elsewhere", () => {
    const ctrlF = () => new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    const searchable = setup(table);
    const openFind = vi.fn();
    Object.assign(searchable.pane, { findable: () => "find", openFind });
    expect(searchable.keybindings.resolve(ctrlF(), searchable.context())?.command).toBe("document.find");
    void searchable.commands.run("document.find", searchable.context());
    expect(openFind).toHaveBeenCalledWith(false);

    const other = setup(table);
    expect(other.keybindings.resolve(ctrlF(), other.context())).toBeUndefined();
  });
});

describe("editorChrome Format", () => {
  const text = { id: "text", label: "Text", glyph: "pilcrow", group: "text", run: vi.fn() };
  const bold = { id: "bold", label: "Bold", glyph: "bold", group: "marks", key: "Mod+B", run: vi.fn() };
  const offered: FormatActions = { plain: text, lines: [text], marks: [bold], tools: [bold] };
  function formatPane(actions: FormatActions | undefined, applies = (_id: string) => true, menu: MenuItem[] = []) {
    return {
      findable: () => "replace",
      hasSourceMode: () => true,
      formatActions: () => actions,
      formatApplies: (id: string) =>
        actions !== undefined && [...actions.lines, ...actions.marks].some((each) => each.id === id) && applies(id),
      formatMenu: () => menu,
      applyFormat: vi.fn(),
    } as unknown as DocumentPane & { applyFormat: Mock };
  }

  it("lists the format's own rows right after Format…, before the pane's", () => {
    const zoom = { label: "Zoom", submenu: [{ label: "100%", run: vi.fn() }] };
    const { toolbar } = setup(note, false, formatPane(offered, undefined, [zoom]));
    expect(toolbar().map((entry) => entry.label)).toEqual([
      "Source mode",
      "Format…",
      "Zoom",
      "Layout",
      "Find…",
      "Replace…",
    ]);
  });

  it("offers Format right after Source mode, checked while the setting is on, and flips the setting", () => {
    const { toolbar, item, commands, context, formatColumn } = setup(note, false, formatPane(offered));
    expect(
      toolbar()
        .map((entry) => entry.label)
        .slice(0, 2),
    ).toEqual(["Source mode", "Format…"]);
    expect(item("Format…")?.checked).toBe(false);

    void commands.run("editor.toggleFormat", context());
    expect(formatColumn.get()).toBe(true);
    expect(item("Format…")?.checked).toBe(true);
  });

  it("offers it nowhere a note's editor can't change", () => {
    expect(setup(note, false, formatPane(undefined)).item("Format…")).toBeUndefined();
    expect(setup(table).item("Format…")).toBeUndefined();
  });

  it("makes each format's actions commands, named for the palette, run on the focused note", () => {
    const documentPane = formatPane(offered);
    const { commands, context, palette } = setup(note, false, documentPane);
    expect(palette()).toEqual(expect.arrayContaining(["Toggle Format", "Format: Bold"]));
    void commands.run("format.bold", context());
    expect(documentPane.applyFormat).toHaveBeenCalledWith("bold");
    // The Markdown format's Heading 2, which this note's actions don't offer.
    expect(palette()).not.toContain("Format: Heading 2");
    expect(commands.isEnabled("format.heading2", context())).toBe(false);
  });

  it("leaves out of the palette an action the format offers that can't run where the selection is", () => {
    const italic = { id: "italic", label: "Italic", glyph: "italic", group: "marks", run: vi.fn() };
    const actions = { plain: text, lines: [text], marks: [bold, italic], tools: [bold, italic] };
    const documentPane = formatPane(actions, (id) => id !== "italic");
    const { commands, context, palette } = setup(note, false, documentPane);
    expect(palette()).toContain("Format: Bold");
    expect(palette()).not.toContain("Format: Italic");
    expect(commands.isEnabled("format.italic", context())).toBe(false);
  });
});

describe("editorChrome run count", () => {
  it("counts the runs going beside Run, reveals them, and hides with Run in App Mode", () => {
    const panes = createEditorPanes();
    panes.register({
      kind: "flow",
      chrome: { toolbar: true, readingView: false, statusbar: true, actions: ["flow-run"] },
      create: () => fakePane(),
    });
    let appMode = false;
    const showRuns = vi.fn();
    const chrome = createEditorChrome({
      panes,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false, dispose: vi.fn() } as unknown as ContextMenu,
      titleBar: { show: vi.fn(), hide: vi.fn() } as unknown as EditorTitleBar,
      activeTab: () => flow,
      activePane: () => undefined,
      activeFlowView: () => ({ isAppModeActive: () => appMode, run: vi.fn() }) as unknown as FlowView,
      readingView: () => false,
      setReadingView: vi.fn(),
      sourceMode: () => false,
      setSourceMode: vi.fn(),
      showRuns,
      announce: vi.fn(),
    });
    chrome.activate(flow);
    chrome.refreshFlowRun();
    const count = chrome.toolbar.querySelector(".flow-run-count") as HTMLButtonElement;
    expect(count.previousElementSibling?.classList.contains("flow-run-button")).toBe(true);
    expect(count.hidden).toBe(true);

    chrome.setFlowRuns(3);
    expect([count.hidden, count.textContent]).toEqual([false, "3 running"]);
    count.click();
    expect(showRuns).toHaveBeenCalledTimes(1);

    appMode = true;
    chrome.refreshFlowRun();
    expect(count.hidden).toBe(true);
  });
});

// One row for every kind that keeps a view, its words the chrome's and its
// hover text the pane's.
describe("editorChrome default view", () => {
  const ROW = "Set as default view";

  function withDefaultView(tab: Tab) {
    const shown = setup(tab);
    const view = { differs: true, set: vi.fn(async () => true) };
    Object.assign(shown.pane, {
      defaultView: { tooltip: "Saves this view into it.", differs: () => view.differs, set: view.set },
    });
    return { ...shown, view };
  }

  it("offers the row only while the pane's view differs, with the pane's hover text", () => {
    const { item, pick, view } = withDefaultView(flow);
    expect(item(ROW)).toMatchObject({ tooltip: "Saves this view into it." });
    pick(ROW);
    expect(view.set).toHaveBeenCalledTimes(1);

    view.differs = false;
    expect(item(ROW)).toBeUndefined();
  });

  it("says in the group's status bar that the view was saved, only once it was", async () => {
    const { pick, view, announce } = withDefaultView(flow);
    pick(ROW);
    await view.set.mock.results[0]?.value;
    expect(announce).toHaveBeenCalledWith("Saved as default view for everyone");

    view.set.mockResolvedValueOnce(false);
    pick(ROW);
    await view.set.mock.results[1]?.value;
    expect(announce).toHaveBeenCalledTimes(1);
  });

  // A pan or a zoom that leaves the default in place, such as a click,
  // keeps it; the first that moves off it takes it back, once.
  it("takes the line back once the view shown is no longer the default", async () => {
    const { chrome, pick, view, takeBack } = withDefaultView(flow);
    pick(ROW);
    await view.set.mock.results[0]?.value;
    view.differs = false;
    chrome.viewChanged();
    expect(takeBack).not.toHaveBeenCalled();

    view.differs = true;
    chrome.viewChanged();
    chrome.viewChanged();
    expect(takeBack).toHaveBeenCalledTimes(1);
  });

  it("offers it on no read-only tab, and on no pane that keeps no view", () => {
    setLibraryPermissions([library("pool", "read-only")]);
    expect(withDefaultView({ kind: "flow", path: "lib:pool/a.flow.html" }).item(ROW)).toBeUndefined();
    expect(setup(flow).item(ROW)).toBeUndefined();
  });
});
