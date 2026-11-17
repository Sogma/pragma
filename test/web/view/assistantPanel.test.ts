// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfoResponse, Tab } from "../../../web/core/apiClient.ts";
import { createCommands } from "../../../web/services/commands.ts";
import type { EditorPane } from "../../../web/services/editorPanes.ts";
import {
  createInspectorTabs,
  type InspectorTab,
  type InspectorTabsService,
} from "../../../web/services/inspectorTabs.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import type { Setting } from "../../../web/services/settings.ts";
import { createInspector, wireAssistantPanel } from "../../../web/view/assistantPanel.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFileInfo: vi.fn(async () => ({ kind: "file", size: 2048, modified: "2026-09-28T10:00:00.000Z" })),
}));

function fakeSetting<T>(initial: T): Setting<T> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
    subscribe: () => () => {},
  };
}

function registries() {
  const commands = createCommands();
  return { commands, keybindings: createKeybindings(commands), menus: createMenus(commands) };
}

// The column as web/index.html has it, trimmed to what the module reads.
beforeEach(() => {
  document.body.innerHTML = `
    <div id="header-assistant">
      <div id="inspector-tabs">
        <button id="inspector-tab-tools"></button>
        <button id="inspector-tab-links"></button>
        <button id="inspector-tab-properties"></button>
        <button id="inspector-tab-info"></button>
      </div>
      <button id="header-assistant-toggle"></button>
    </div>
    <main id="editor"></main>
    <div id="assistant-resize-handle"></div>
    <aside id="assistant">
      <section id="assistant-inspector">
        <div id="inspector-info"><div id="inspector-pane-slot"></div></div>
        <div id="inspector-links" hidden><div id="inspector-links-slot"></div></div>
        <div id="inspector-properties" hidden><div id="inspector-properties-slot"></div></div>
        <div id="inspector-tools" hidden><div id="context-panel" hidden></div><div id="button-list"></div><div id="inspector-tools-slot"></div></div>
      </section>
      <div id="assistant-split-handle"></div>
      <section id="assistant-chat"></section>
    </aside>`;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function facts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of el("#inspector-info").querySelectorAll(".meta-row")) {
    out[row.querySelector(".meta-key")?.textContent ?? ""] = row.querySelector(".meta-value")?.textContent ?? "";
  }
  return out;
}

function setup(
  info: (path: string) => Promise<FileInfoResponse> = async (path) => ({
    kind: "file",
    name: path.slice(path.lastIndexOf("/") + 1),
    size: 2048,
    modified: "2026-09-28T10:00:00.000Z",
    systemFolder: `/home/me/space/${path.slice(0, path.lastIndexOf("/"))}`,
  }),
  sha256: (path: string) => Promise<string> = async () => DIGEST,
  contributed: InspectorTabsService = createInspectorTabs(),
  remembered = "",
) {
  const fileInfo = vi.fn(info);
  const fileSha256 = vi.fn(sha256);
  const view = fakeSetting(remembered);
  const collapsed = fakeSetting(false);
  const showAssistant = vi.fn();
  const height = fakeSetting<number | undefined>(undefined);
  const inspector = createInspector({ fileInfo, fileSha256, view, collapsed, height, showAssistant, contributed });
  return { inspector, fileInfo, fileSha256, view, collapsed, showAssistant };
}

describe("the inspector's Info tab", () => {
  it("lists the facts every file has, filled from the file-info and hash routes", async () => {
    const { inspector, fileInfo, fileSha256 } = setup();
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });

    expect(Object.keys(facts())).toEqual(["Name", "Path", "Size", "Modified", "SHA-256"]);
    expect(Object.values(facts())).toEqual(["…", "…", "…", "…", "…"]);
    expect(document.querySelector("#inspector-info .inspector-section-title")).toBeNull();
    await settle();
    expect(fileInfo).toHaveBeenCalledWith("notes/song.md");
    expect(fileSha256).toHaveBeenCalledWith("notes/song.md");
    expect(facts().Name).toBe("song.md");
    expect(facts().Path).toBe("/home/me/space/notes");
    expect(facts().Size).toBe("2.0 KB");
    expect(facts().Modified).not.toBe("…");
    expect(facts()["SHA-256"]).toBe(DIGEST);
    expect(el(".inspector-empty").hidden).toBe(true);
  });

  // A folder's byte count is its directory entry's, not its contents', and
  // it has no bytes of its own to hash.
  it("leaves the size and hash off a folder", () => {
    const { inspector, fileSha256 } = setup();
    inspector.setTab({ kind: "gallery", path: "novel/part-one" });
    expect(Object.keys(facts())).toEqual(["Name", "Path", "Modified"]);
    expect(fileSha256).not.toHaveBeenCalled();
  });

  // Each piece is an inline-block, so a wrapped path breaks between folders
  // and never at a hyphen inside a name; together they copy as the path.
  it("shows the folder on disk as the system spells it, a piece per folder", async () => {
    const { inspector } = setup(async () => ({
      kind: "file",
      name: "song.md",
      size: 1,
      modified: "2026-09-28T10:00:00.000Z",
      systemFolder: "C:\\Users\\me\\my-space",
    }));
    inspector.setTab({ kind: "document", path: "song.md", documentType: "note" });
    await settle();
    const value = el(".meta-path");
    expect([...value.children].map((piece) => piece.textContent)).toEqual(["C:\\", "Users\\", "me\\", "my-space"]);
    expect(value.textContent).toBe("C:\\Users\\me\\my-space");
  });

  it("leaves the path off when the engine names no place on disk", async () => {
    const { inspector } = setup(async () => ({
      kind: "file",
      name: "song.md",
      size: 1,
      modified: "2026-09-28T10:00:00.000Z",
    }));
    inspector.setTab({ kind: "document", path: "song.md", documentType: "note" });
    await settle();
    expect(facts()).toMatchObject({ Name: "song.md" });
    expect(Object.keys(facts())).toEqual(["Name", "Size", "Modified", "SHA-256"]);
  });

  it("says so when no file is open", () => {
    const { inspector, fileInfo, fileSha256 } = setup();
    inspector.setTab({ kind: "empty" });
    expect(el(".inspector-empty").hidden).toBe(false);
    expect(facts()).toEqual({});
    expect(fileInfo).not.toHaveBeenCalled();
    expect(fileSha256).not.toHaveBeenCalled();
  });

  // A large take takes seconds to hash; Size and Modified must not wait on it.
  it("fills the stat without waiting on the hash", async () => {
    let finishHash: (digest: string) => void = () => {};
    const { inspector } = setup(undefined, () => new Promise((resolve) => (finishHash = resolve)));
    inspector.setTab({ kind: "video", path: "takes/long.mp4" });
    await settle();
    expect(facts().Size).toBe("2.0 KB");
    expect(facts()["SHA-256"]).toBe("…");
    finishHash(DIGEST);
    await settle();
    expect(facts()["SHA-256"]).toBe(DIGEST);
  });

  // One line with an ellipsis, like a tree name; the full digest is a
  // tooltip only while it is actually cut off (test/web/lib/tooltip.test.ts).
  it("offers the whole digest as a tooltip while it is cut off", async () => {
    const { inspector } = setup();
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    await settle();
    const value = el(".meta-code");
    expect(value.textContent).toBe(DIGEST);
    expect(value.dataset.tooltipOverflow).toBe("");
  });

  it("shows a failed hash as Unknown like any other lookup", async () => {
    const { inspector } = setup(undefined, async () => Promise.reject(new Error("x")));
    inspector.setTab({ kind: "image", path: "art/cover.png" });
    await settle();
    expect(facts()["SHA-256"]).toBe("Unknown");
  });

  it("drops a lookup that finishes after the tab moved on, and shows a failed one as Unknown", async () => {
    let finishFirst: (info: FileInfoResponse) => void = () => {};
    let finishFirstHash: (digest: string) => void = () => {};
    const { inspector } = setup(
      async (path) => {
        if (path === "a.md") return new Promise((resolve) => (finishFirst = resolve));
        throw new Error("gone");
      },
      async (path) => {
        if (path === "a.md") return new Promise((resolve) => (finishFirstHash = resolve));
        throw new Error("gone");
      },
    );
    inspector.setTab({ kind: "document", path: "a.md", documentType: "note" });
    inspector.setTab({ kind: "document", path: "b.md", documentType: "note" });
    await settle();
    finishFirst({ kind: "file", name: "a.md", size: 1, modified: "2026-01-01T00:00:00.000Z" });
    finishFirstHash(DIGEST);
    await settle();
    expect(Object.values(facts())).toEqual(["Unknown", "Unknown", "Unknown", "Unknown", "Unknown"]);
  });

  it("re-reads the facts after a write to the file showing, and only that file", async () => {
    const { inspector, fileInfo, fileSha256 } = setup();
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    await settle();
    fileInfo.mockClear();
    fileSha256.mockClear();

    inspector.refreshFacts("notes/other.md");
    expect(fileInfo).not.toHaveBeenCalled();
    expect(fileSha256).not.toHaveBeenCalled();
    inspector.refreshFacts("notes/song.md");
    expect(fileInfo).toHaveBeenCalledWith("notes/song.md");
    expect(fileSha256).toHaveBeenCalledWith("notes/song.md");
  });

  it("mounts the pane's links in the Links tab, and says why there are none otherwise", () => {
    const { inspector } = setup();
    const empty = () => el("#inspector-links > .inspector-empty");
    expect(empty().textContent).toBe("No file open.");

    inspector.setTab({ kind: "table", path: "cast.table.html" } as Tab);
    inspector.setPane({} as EditorPane);
    expect(empty().hidden).toBe(false);
    expect(empty().textContent).toBe("Links are listed for notes and screenplays.");

    const list: HTMLElement = document.createElement("div");
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    inspector.setPane({ links: list } as EditorPane);
    expect(el("#inspector-links-slot").firstElementChild).toBe(list);
    expect(empty().hidden).toBe(true);
  });

  // Whether the line shows is the stylesheet's call, once the pane's own
  // element shows; only its wording and the mount are the module's.
  it("mounts the pane's properties in the Properties tab, and words its line for the file", () => {
    const { inspector } = setup();
    const line = () => el("#inspector-properties > .inspector-empty");
    expect(line().textContent).toBe("No file open.");

    inspector.setTab({ kind: "table", path: "cast.table.html" } as Tab);
    inspector.setPane({} as EditorPane);
    expect(line().textContent).toBe("Properties are kept for notes, Tables, Flows and Classes.");
    expect(el("#inspector-properties-slot").childElementCount).toBe(0);

    const section = document.createElement("section");
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    inspector.setPane({ properties: section } as EditorPane);
    expect(el("#inspector-properties-slot").firstElementChild).toBe(section);

    inspector.setPane({} as EditorPane);
    expect(el("#inspector-properties-slot").childElementCount).toBe(0);
  });

  it("mounts the pane's own section, and clears it for a pane with none", () => {
    const { inspector } = setup();
    const section = document.createElement("section");
    inspector.setPane({ inspector: section } as EditorPane);
    expect(el("#inspector-pane-slot").firstElementChild).toBe(section);
    inspector.setPane({} as EditorPane);
    expect(el("#inspector-pane-slot").childElementCount).toBe(0);
  });
});

describe("the inspector's tabs", () => {
  it("switches views, and folds on a second click of the selected one", () => {
    const { view, collapsed } = setup();
    const info = el("#inspector-tab-info");
    const tools = el("#inspector-tab-tools");
    expect(info.getAttribute("aria-selected")).toBe("true");
    expect(el("#inspector-info").hidden).toBe(false);

    tools.click();
    expect(el("#inspector-tools").hidden).toBe(false);
    expect(el("#inspector-info").hidden).toBe(true);
    expect(view.get()).toBe("tools");

    tools.click();
    expect(collapsed.get()).toBe(true);
    expect(el("#assistant-inspector").classList.contains("collapsed")).toBe(true);
    expect(el("#inspector-tools").hidden).toBe(true);
    expect(el("#assistant-split-handle").hidden).toBe(true);
    expect(tools.getAttribute("aria-selected")).toBe("false");

    info.click();
    expect(collapsed.get()).toBe(false);
    expect(el("#inspector-info").hidden).toBe(false);
    expect(el("#assistant-split-handle").hidden).toBe(false);
  });

  it("places the bar on the remembered tab without sliding, and slides it from the first pick on", () => {
    createInspector({
      fileInfo: vi.fn(),
      fileSha256: vi.fn(),
      view: fakeSetting("links"),
      collapsed: fakeSetting(false),
      height: fakeSetting<number | undefined>(undefined),
      showAssistant: vi.fn(),
      contributed: createInspectorTabs(),
    });
    const bar = el("#inspector-tabs > .rail-indicator");
    expect(bar.hidden).toBe(false);
    expect(bar.style.transform).toBe("translateX(100%)");
    expect(bar.classList.contains("animated")).toBe(false);

    el("#inspector-tab-info").click();
    expect(bar.style.transform).toBe("translateX(300%)");
    expect(bar.classList.contains("animated")).toBe(true);
  });

  it("hides the bar while folded, and shows it on the tab that unfolds", () => {
    setup();
    const bar = el("#inspector-tabs > .rail-indicator");
    el("#inspector-tab-info").click();
    expect(bar.hidden).toBe(true);

    el("#inspector-tab-tools").click();
    expect(bar.hidden).toBe(false);
    expect(bar.style.transform).toBe("translateX(0%)");
  });

  // The class the tab's pill gets, so the bar wears its stripe's colour.
  it("marks the bar while the focused tab's file lives in a library", () => {
    const { inspector } = setup();
    const bar = el("#inspector-tabs > .rail-indicator");
    expect(bar.classList.contains("foreign-root")).toBe(false);

    inspector.setTab({ kind: "document", path: "lib:refs/song.md", documentType: "note" });
    expect(bar.classList.contains("foreign-root")).toBe(true);

    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    expect(bar.classList.contains("foreign-root")).toBe(false);

    inspector.setTab({ kind: "gallery", path: "lib:footage" });
    expect(bar.classList.contains("foreign-root")).toBe(true);

    inspector.setTab({ kind: "empty" });
    expect(bar.classList.contains("foreign-root")).toBe(false);
  });

  it("opens on the remembered Properties view", () => {
    createInspector({
      fileInfo: vi.fn(),
      fileSha256: vi.fn(),
      view: fakeSetting("properties"),
      collapsed: fakeSetting(false),
      height: fakeSetting<number | undefined>(undefined),
      showAssistant: vi.fn(),
      contributed: createInspectorTabs(),
    });
    expect(el("#inspector-properties").hidden).toBe(false);
    expect(el("#inspector-tab-properties").getAttribute("aria-selected")).toBe("true");
    expect(el("#inspector-info").hidden).toBe(true);
  });

  it("opens on the remembered Links view", () => {
    createInspector({
      fileInfo: vi.fn(),
      fileSha256: vi.fn(),
      view: fakeSetting("links"),
      collapsed: fakeSetting(false),
      height: fakeSetting<number | undefined>(undefined),
      showAssistant: vi.fn(),
      contributed: createInspectorTabs(),
    });
    expect(el("#inspector-links").hidden).toBe(false);
    expect(el("#inspector-info").hidden).toBe(true);
  });

  it("opens on the remembered view and fold", () => {
    createInspector({
      fileInfo: vi.fn(),
      fileSha256: vi.fn(),
      view: fakeSetting("tools"),
      collapsed: fakeSetting(true),
      height: fakeSetting<number | undefined>(undefined),
      showAssistant: vi.fn(),
      contributed: createInspectorTabs(),
    });
    expect(el("#assistant-inspector").classList.contains("collapsed")).toBe(true);
    expect(el("#inspector-tools").hidden).toBe(true);
    el("#inspector-tab-tools").click();
    expect(el("#inspector-tools").hidden).toBe(false);
  });

  it("a reveal unfolds onto the asked-for view and shows the whole column", () => {
    const hidden = fakeSetting(true);
    const inspector = wireAssistantPanel(
      {
        assistantHidden: hidden,
        assistantWidth: fakeSetting<number | undefined>(undefined),
        inspectorView: fakeSetting("info"),
        inspectorCollapsed: fakeSetting(true),
        inspectorHeight: fakeSetting<number | undefined>(undefined),
      },
      registries(),
    );
    expect(el("#assistant").hidden).toBe(true);
    expect(el("#header-assistant").classList.contains("collapsed")).toBe(true);

    inspector.show("tools");

    expect(el("#assistant").hidden).toBe(false);
    expect(el("#header-assistant").classList.contains("collapsed")).toBe(false);
    expect(hidden.get()).toBe(false);
    expect(el("#inspector-tools").hidden).toBe(false);
    expect(el("#assistant-inspector").classList.contains("collapsed")).toBe(false);
  });
});

describe("the inspector's empty tabs", () => {
  const dimmed = () =>
    ["tools", "links", "properties", "info"].filter((view) => el(`#inspector-tab-${view}`).classList.contains("empty"));

  it("dims every tab with no file open, and only the empty ones with one", () => {
    const { inspector } = setup();
    expect(dimmed()).toEqual(["tools", "links", "properties", "info"]);

    el("#button-list").toggleAttribute("data-empty", true);
    inspector.setTab({ kind: "table", path: "cast.table.html" } as Tab);
    inspector.setPane({} as EditorPane);
    expect(dimmed()).toEqual(["tools", "links", "properties"]);
  });

  // A mutation observer reports the change, after the current task.
  it("follows the parts as they fill and empty", async () => {
    const { inspector } = setup();
    const links: HTMLElement = document.createElement("div");
    links.toggleAttribute("data-empty", true);
    const properties: HTMLElement = document.createElement("section");
    properties.hidden = true;
    el("#button-list").toggleAttribute("data-empty", true);
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    inspector.setPane({ links, properties } as EditorPane);
    expect(dimmed()).toEqual(["tools", "links", "properties"]);

    el("#context-panel").hidden = false;
    links.toggleAttribute("data-empty", false);
    properties.hidden = false;
    await settle();
    expect(dimmed()).toEqual([]);

    properties.toggleAttribute("data-empty", true);
    await settle();
    expect(dimmed()).toEqual(["properties"]);
  });

  it("lights Tools for the pane's jobs, mounted in the tab's slot", async () => {
    const { inspector } = setup();
    const tools: HTMLElement = document.createElement("div");
    tools.toggleAttribute("data-empty", true);
    el("#button-list").toggleAttribute("data-empty", true);
    inspector.setTab({ kind: "flow", path: "kite.flow.html" } as Tab);
    inspector.setPane({ tools } as EditorPane);
    expect(el("#inspector-tools-slot").firstElementChild).toBe(tools);
    expect(dimmed()).toContain("tools");

    tools.toggleAttribute("data-empty", false);
    await settle();
    expect(dimmed()).not.toContain("tools");

    inspector.setPane({} as EditorPane);
    expect(el("#inspector-tools-slot").childElementCount).toBe(0);
    expect(dimmed()).toContain("tools");
  });

  it("counts the runs the pane's jobs say are going on the Tools tab, in its name too", async () => {
    const { inspector } = setup();
    const tools: HTMLElement = document.createElement("div");
    const tab = el("#inspector-tab-tools");
    const badge = () => tab.querySelector(".rail-badge");
    inspector.setTab({ kind: "flow", path: "kite.flow.html" } as Tab);
    inspector.setPane({ tools } as EditorPane);
    expect(badge()).toBeNull();

    tools.setAttribute("data-running", "3");
    await settle();
    expect([badge()?.textContent, badge()?.getAttribute("aria-hidden")]).toEqual(["3", "true"]);
    expect(tab.getAttribute("aria-label")).toBe("Tools: 3 running");
    expect(tab.dataset.tooltip).toBe("Tools\n3 running");

    // A note's toolkit runs count with them.
    el("#button-list").setAttribute("data-running", "2");
    await settle();
    expect(badge()?.textContent).toBe("5");

    inspector.setPane({} as EditorPane);
    expect(badge()?.textContent).toBe("2");
    el("#button-list").removeAttribute("data-running");
    await settle();
    expect(badge()).toBeNull();
    expect(tab.getAttribute("aria-label")).toBe("Tools");
  });

  it("stops following a pane once another is mounted", async () => {
    const { inspector } = setup();
    const links: HTMLElement = document.createElement("div");
    inspector.setTab({ kind: "document", path: "notes/song.md", documentType: "note" });
    inspector.setPane({ links } as EditorPane);
    expect(dimmed()).not.toContain("links");

    inspector.setPane({} as EditorPane);
    links.toggleAttribute("data-empty", true);
    links.toggleAttribute("data-empty", false);
    await settle();
    expect(dimmed()).toContain("links");
  });
});

describe("the assistant's slide", () => {
  const animated = (selector: string) => el(selector).classList.contains("animated");

  it("restores the saved state in place, and slides from the first toggle on", () => {
    wireAssistantPanel(
      {
        assistantHidden: fakeSetting(true),
        assistantWidth: fakeSetting<number | undefined>(undefined),
        inspectorView: fakeSetting("info"),
        inspectorCollapsed: fakeSetting(false),
        inspectorHeight: fakeSetting<number | undefined>(undefined),
      },
      registries(),
    );
    expect(el("#assistant").hidden).toBe(true);
    expect(animated("#assistant")).toBe(false);
    expect(animated("#header-assistant")).toBe(false);

    el("#header-assistant-toggle").click();

    expect(el("#assistant").hidden).toBe(false);
    expect(animated("#assistant")).toBe(true);
    expect(animated("#header-assistant")).toBe(true);
  });
});

describe("Toggle Assistant", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function wire() {
    const hidden = fakeSetting(false);
    const deps = registries();
    wireAssistantPanel(
      {
        assistantHidden: hidden,
        assistantWidth: fakeSetting<number | undefined>(undefined),
        inspectorView: fakeSetting("info"),
        inspectorCollapsed: fakeSetting(false),
        inspectorHeight: fakeSetting<number | undefined>(undefined),
      },
      deps,
    );
    return { hidden, ...deps };
  }

  it("hides a showing column and shows a hidden one, as the header toggle does", async () => {
    const { hidden, commands } = wire();
    const context = { tab: { kind: "empty" as const }, pane: undefined };

    await commands.run("assistant.toggle", context);
    expect(el("#assistant").hidden).toBe(true);
    expect(el("#header-assistant-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(hidden.get()).toBe(true);
    await commands.run("assistant.toggle", context);
    expect(el("#assistant").hidden).toBe(false);
    expect(hidden.get()).toBe(false);
  });

  it("takes ⌥⌘B on a Mac, and no key elsewhere", () => {
    expect(wire().keybindings.defaultChordsFor("assistant.toggle")).toEqual([]);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(wire().keybindings.defaultChordsFor("assistant.toggle")).toEqual(["Alt+Meta+B"]);
  });
});

describe("the assistant's sizes", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--assistant-width");
  });

  const assistantWidth = () => document.documentElement.style.getPropertyValue("--assistant-width");
  const inspectorHeight = () => el("#assistant-inspector").style.getPropertyValue("--inspector-height");

  function wire(width: number | undefined, height: number | undefined) {
    const sizes = { width: fakeSetting(width), inspectorHeight: fakeSetting(height) };
    wireAssistantPanel(
      {
        assistantHidden: fakeSetting(false),
        assistantWidth: sizes.width,
        inspectorView: fakeSetting("info"),
        inspectorCollapsed: fakeSetting(false),
        inspectorHeight: sizes.inspectorHeight,
      },
      registries(),
    );
    return sizes;
  }

  function drag(handle: string, to: Partial<MouseEventInit>) {
    el(handle).dispatchEvent(new MouseEvent("mousedown"));
    document.dispatchEvent(new MouseEvent("mousemove", to));
  }

  it("leaves the stylesheet's defaults until a size has been saved", () => {
    wire(undefined, undefined);

    expect(assistantWidth()).toBe("");
    expect(inspectorHeight()).toBe("");
  });

  it("restores the saved width and split", () => {
    wire(360, 220);

    expect(assistantWidth()).toBe("360px");
    expect(inspectorHeight()).toBe("220px");
  });

  it("gives way to the editor when the width was saved in a wider window", () => {
    vi.spyOn(el("#editor"), "getBoundingClientRect").mockReturnValue(new DOMRect(300, 0, 0, 0));

    wire(window.innerWidth, undefined);

    expect(assistantWidth()).toBe(`${window.innerWidth - 300}px`);
  });

  // jsdom lays nothing out: the header region is given the width its tabs,
  // toggle and window controls take on Electron for Windows.
  const headerNeeds = (width: number) =>
    vi.spyOn(el("#header-assistant"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 40));

  it("is never narrower than its header region needs", () => {
    headerNeeds(305);
    document.documentElement.style.setProperty("--assistant-width", "300px");

    wire(undefined, undefined);
    expect(assistantWidth()).toBe("305px");

    drag("#assistant-resize-handle", { clientX: window.innerWidth - 250 });
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(assistantWidth()).toBe("305px");
  });

  it("raises a width saved below what the header region needs", () => {
    headerNeeds(305);

    wire(250, undefined);

    expect(assistantWidth()).toBe("305px");
  });

  it("saves the width when its drag ends", () => {
    const { width } = wire(undefined, undefined);

    drag("#assistant-resize-handle", { clientX: window.innerWidth - 410 });
    expect(assistantWidth()).toBe("410px");
    expect(width.get()).toBeUndefined();

    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(width.get()).toBe(410);
  });

  it("hides near the window's edge as its toggle does, saving no width, and reopens at the width it had", () => {
    headerNeeds(240);
    const { width } = wire(360, undefined);

    drag("#assistant-resize-handle", { clientX: window.innerWidth - 100 });
    expect(assistantWidth()).toBe("240px");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: window.innerWidth - 30 }));
    expect(el("#assistant").hidden).toBe(true);
    expect(el("#header-assistant-toggle").getAttribute("aria-pressed")).toBe("false");

    // Left alone while hidden: the slide-out may still be under way.
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(width.get()).toBe(360);
    expect(assistantWidth()).toBe("240px");

    el("#header-assistant-toggle").click();
    expect(el("#assistant").hidden).toBe(false);
    expect(assistantWidth()).toBe("360px");
  });

  it("saves the split when its drag ends", () => {
    const { inspectorHeight: height } = wire(undefined, undefined);
    // The drag caps the inspector at the column's height, which jsdom has none of.
    vi.spyOn(el("#assistant"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 800));

    drag("#assistant-split-handle", { clientY: 180 });
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(inspectorHeight()).toBe("180px");
    expect(height.get()).toBe(180);
  });
});

describe("a contributed inspector tab", () => {
  function contributedTab(id = "graph") {
    return {
      id,
      label: "Graph",
      icon: "<svg></svg>",
      panel: document.createElement("div"),
      setTab: vi.fn(),
      onShow: vi.fn(),
      onHide: vi.fn(),
    } satisfies InspectorTab;
  }

  it("draws before Info, and its panel shows only while it is picked", () => {
    const contributed = createInspectorTabs();
    const tab = contributedTab();
    contributed.register(tab);
    setup(undefined, undefined, contributed);
    const ids = [...el("#inspector-tabs").querySelectorAll("button")].map((button) => button.id);
    expect(ids.slice(-2)).toEqual(["inspector-tab-graph", "inspector-tab-info"]);
    expect(el("#inspector-tab-graph").getAttribute("aria-label")).toBe("Graph");
    expect(tab.panel.hidden).toBe(true);

    el("#inspector-tab-graph").click();
    expect(tab.panel.hidden).toBe(false);
    expect(tab.onShow).toHaveBeenCalledTimes(1);
    expect(el("#inspector-tabs > .rail-indicator").style.transform).toBe("translateX(300%)");

    el("#inspector-tab-info").click();
    expect(tab.panel.hidden).toBe(true);
    expect(tab.onHide).toHaveBeenCalledTimes(1);
  });

  it("hears every change of the focused tab, shown or not", () => {
    const contributed = createInspectorTabs();
    const tab = contributedTab();
    contributed.register(tab);
    const { inspector } = setup(undefined, undefined, contributed);
    const focused: Tab = { kind: "document", path: "notes/song.md", documentType: "note" };
    inspector.setTab(focused);
    expect(tab.setTab).toHaveBeenCalledWith(focused);
  });

  // main.ts registers a module's tab wherever its bootstrap gets to it.
  it("takes back the selection it was left with when it registers late", () => {
    const contributed = createInspectorTabs();
    setup(undefined, undefined, contributed, "graph");
    expect(el("#inspector-info").hidden).toBe(false);

    const tab = contributedTab();
    contributed.register(tab);
    expect(tab.panel.hidden).toBe(false);
    expect(tab.onShow).toHaveBeenCalledTimes(1);
    expect(el("#inspector-info").hidden).toBe(true);
  });

  it("leaves the strip when its registration is disposed, handing the selection to Info", () => {
    const contributed = createInspectorTabs();
    const tab = contributedTab();
    const registration = contributed.register(tab);
    setup(undefined, undefined, contributed);
    el("#inspector-tab-graph").click();

    registration.dispose();
    expect(document.querySelector("#inspector-tab-graph")).toBeNull();
    expect(tab.panel.isConnected).toBe(false);
    expect(el("#inspector-info").hidden).toBe(false);
  });

  it("refuses a second tab under an id already registered", () => {
    const contributed = createInspectorTabs();
    contributed.register(contributedTab());
    expect(() => contributed.register(contributedTab())).toThrow(/already registered/);
  });
});
