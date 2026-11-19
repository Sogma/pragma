// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { LibraryRow, Tab } from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import { createEditorPanes, type EditorPane, type PaneTabKind } from "../../../web/services/editorPanes.ts";
import { createEditorGroupView } from "../../../web/view/editorGroup.ts";
import { fakePaneGroup } from "../support/paneGroup.ts";

// A pane whose input load can be held open, to exercise the stale-open guard.
function fakePane(kind: PaneTabKind) {
  const element = document.createElement("div");
  element.className = `pane-${kind}`;
  const rendered: string[] = [];
  // One pending resolver per in-flight input load, released oldest first.
  const pending: (() => void)[] = [];
  const pane: EditorPane & { rendered: string[]; release(): void } = {
    kind,
    element,
    rendered,
    release: () => pending.shift()?.(),
    setInput: vi.fn(async (tab, ctx) => {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      if (!ctx.isCurrent()) return;
      rendered.push("path" in tab ? tab.path : "");
    }),
    clearInput: vi.fn(),
    title: () => undefined,
    titleHost: () => element,
    dispose: vi.fn(),
  };
  return pane;
}

function setup() {
  const panes = createEditorPanes();
  const created: Record<string, ReturnType<typeof fakePane>[]> = { table: [], flow: [] };
  for (const kind of ["table", "flow"] as const) {
    panes.register({
      kind,
      chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
      create: () => {
        const pane = fakePane(kind);
        created[kind].push(pane);
        return pane;
      },
    });
  }
  const stripHost = document.createElement("div");
  const host = document.createElement("div");
  host.hidden = true;
  document.body.append(stripHost, host);
  const tabs = {
    onSwitch: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onMenu: vi.fn(),
  };
  const onPaneMounted = vi.fn();
  const onScrollMarkHover = vi.fn();
  const group = createEditorGroupView({
    stripHost,
    host,
    panes,
    tabs,
    onPaneMounted,
    onScrollMarkHover,
    paneGroup: fakePaneGroup(),
  });
  return { panes, stripHost, host, group, created, tabs, onPaneMounted, onScrollMarkHover };
}

function keyOn(pill: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  pill.dispatchEvent(event);
  return event;
}

const tableTab: Tab = { kind: "table", path: "a.table.html" };
const flowTab: Tab = { kind: "flow", path: "b.flow.html" };

describe("createEditorGroupView", () => {
  it("handles exactly the registered kinds", () => {
    const { group } = setup();
    expect(group.handles("table")).toBe(true);
    expect(group.handles("document")).toBe(false);
  });

  // What follows the pane outside the host (its Info-tab section) hears of
  // a change of pane, not of every open: two tabs of one kind share a pane.
  it("reports each change of mounted pane, and the unmount", async () => {
    const { group, created, onPaneMounted } = setup();
    const first = group.open(tableTab);
    created.table[0].release();
    await first;
    const second = group.open({ kind: "table", path: "c.table.html" });
    created.table[0].release();
    await second;
    expect(onPaneMounted.mock.calls).toEqual([[created.table[0]]]);

    const third = group.open(flowTab);
    created.flow[0].release();
    await third;
    group.close();
    expect(onPaneMounted.mock.calls).toEqual([[created.table[0]], [created.flow[0]], [undefined]]);
  });

  it("creates a pane on first open, mounts it, and hands it the tab", async () => {
    const { group, host, created } = setup();
    const opening = group.open(tableTab);
    const [pane] = created.table;

    expect(host.hidden).toBe(false);
    expect(pane.element.parentElement).toBe(host);
    pane.release();
    await opening;

    expect(pane.rendered).toEqual(["a.table.html"]);
    expect(group.activePane()).toBe(pane);
  });

  it("reuses the same pane instance for a second tab of the same kind", async () => {
    const { group, created } = setup();
    let opening = group.open(tableTab);
    created.table[0].release();
    await opening;
    opening = group.open({ kind: "table", path: "c.table.html" });
    created.table[0].release();
    await opening;

    expect(created.table).toHaveLength(1);
    expect(created.table[0].rendered).toEqual(["a.table.html", "c.table.html"]);
  });

  it("switching kinds clears and unmounts the previous pane", async () => {
    const { group, host, created } = setup();
    let opening = group.open(tableTab);
    created.table[0].release();
    await opening;

    opening = group.open(flowTab);
    created.flow[0].release();
    await opening;

    expect(created.table[0].clearInput).toHaveBeenCalledTimes(1);
    expect(created.table[0].element.parentElement).toBeNull();
    expect(created.flow[0].element.parentElement).toBe(host);
    expect(group.activePane()).toBe(created.flow[0]);
  });

  it("a load that finishes after a newer open renders nothing", async () => {
    const { group, created } = setup();
    const first = group.open(tableTab);
    const second = group.open({ kind: "table", path: "c.table.html" });
    const [pane] = created.table;

    pane.release(); // the first load finishes, but the group has moved on
    await first;
    pane.release();
    await second;

    expect(pane.rendered).toEqual(["c.table.html"]);
  });

  it("close() clears, unmounts, hides the host, and invalidates an in-flight open", async () => {
    const { group, host, created } = setup();
    const opening = group.open(tableTab);
    const [pane] = created.table;

    group.close();
    pane.release();
    await opening;

    expect(pane.clearInput).toHaveBeenCalled();
    expect(pane.element.parentElement).toBeNull();
    expect(host.hidden).toBe(true);
    expect(pane.rendered).toEqual([]);
    expect(group.activePane()).toBeUndefined();
  });

  it("open() throws for a kind nobody registered", async () => {
    const { group } = setup();
    await expect(group.open({ kind: "empty" })).rejects.toThrow(/no editor pane registered/);
  });

  it("dispose() disposes every pane the group created", async () => {
    const { group, created } = setup();
    let opening = group.open(tableTab);
    created.table[0].release();
    await opening;
    opening = group.open(flowTab);
    created.flow[0].release();
    await opening;

    group.dispose();

    expect(created.table[0].dispose).toHaveBeenCalled();
    expect(created.flow[0].dispose).toHaveBeenCalled();
  });

  it("renders its tab strip into the strip host, with the new-tab button as a permanent last child", () => {
    const { stripHost, group, tabs } = setup();
    const strip = stripHost.firstElementChild as HTMLElement;
    expect(strip.classList.contains("editor-group-tabs")).toBe(true);

    group.renderTabs([{ kind: "table", path: "a/b.table.html" }, { kind: "empty" }], 1);

    const children = Array.from(strip.children).map((el) => el.className);
    expect(children).toEqual(["editor-tab", "editor-tab active", "icon-button editor-group-new-tab"]);
    const labels = Array.from(strip.querySelectorAll(".editor-tab-label")).map((el) => el.textContent);
    expect(labels).toEqual(["b", "New tab"]);
    const [table, blank] = strip.querySelectorAll<HTMLElement>(".editor-tab");
    expect([table.dataset.spacePath, blank.dataset.tooltip]).toEqual(["a/b.table.html", "New tab"]);

    strip.querySelector<HTMLButtonElement>(".editor-group-new-tab")?.click();
    expect(tabs.onNew).toHaveBeenCalledTimes(1);
  });

  // A tab not shown whose file a page draws names it for its preview
  // (tabPreview.ts), which shows the path in place of the tooltip.
  it("names a tab's file for its preview while the tab isn't shown, and gives every other a tooltip", () => {
    const { stripHost, group } = setup();
    const kept = { id: "v1", time: Date.UTC(2026, 10, 2, 9, 30), source: "edit" } as const;
    const tabs: Tab[] = [
      { kind: "document", path: "notes/a.md", documentType: "note" },
      { kind: "document", path: "story/act.fountain", documentType: "screenplay" },
      { kind: "table", path: "b.table.html" },
      { kind: "flow", path: "c.flow.html" },
      { kind: "version", path: "notes/a.md", version: kept },
      { kind: "document", path: "notes/plain.txt", documentType: "note" },
    ];
    const drawn = () =>
      [...stripHost.querySelectorAll<HTMLElement>(".editor-tab")].map(
        (pill) => pill.dataset.spacePath ?? `tooltip: ${pill.dataset.tooltip}`,
      );

    group.renderTabs(tabs, 0);
    expect(drawn()).toEqual([
      "tooltip: notes/a.md",
      "story/act.fountain",
      "b.table.html",
      "tooltip: c.flow.html",
      expect.stringMatching(/^tooltip: notes\/a\.md, kept /),
      "tooltip: notes/plain.txt",
    ]);

    group.renderTabs(tabs, 2);
    expect(drawn().slice(0, 3)).toEqual(["notes/a.md", "story/act.fountain", "tooltip: b.table.html"]);
  });

  it("hands a right-click on a pill to the tab's own menu, in place of the browser's", () => {
    const { stripHost, group, tabs } = setup();
    group.renderTabs([tableTab, flowTab], 0);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 12 });
    stripHost.querySelectorAll(".editor-tab")[1].dispatchEvent(event);
    expect(tabs.onMenu).toHaveBeenCalledWith(1, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("is a tablist whose active pill is its one tab stop, each pill naming the pane it shows", () => {
    const { stripHost, host, group } = setup();
    host.id = "editor-pane-group-1";
    group.renderTabs([tableTab, flowTab], 1);
    const strip = stripHost.firstElementChild as HTMLElement;
    expect(strip.getAttribute("role")).toBe("tablist");
    const pills = [...strip.querySelectorAll<HTMLButtonElement>(".editor-tab")];
    expect(pills.map((pill) => pill.getAttribute("role"))).toEqual(["tab", "tab"]);
    expect(pills.map((pill) => pill.tabIndex)).toEqual([-1, 0]);
    expect(pills.map((pill) => pill.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(pills.map((pill) => pill.getAttribute("aria-controls"))).toEqual([
      "editor-pane-group-1",
      "editor-pane-group-1",
    ]);
    expect(pills.map((pill) => pill.querySelector<HTMLElement>(".editor-tab-close")?.tabIndex)).toEqual([-1, -1]);

    group.renderTabs([tableTab, flowTab], 0);
    expect(pills.map((pill) => pill.tabIndex)).toEqual([0, -1]);
  });

  it("selects along the row with the arrow keys, Home and End, and closes with Delete", () => {
    const { stripHost, group, tabs } = setup();
    group.renderTabs([tableTab, flowTab, { kind: "table", path: "c.table.html" }], 0);
    const pills = [...stripHost.querySelectorAll<HTMLButtonElement>(".editor-tab")];

    expect(keyOn(pills[0], "ArrowRight").defaultPrevented).toBe(true);
    expect(tabs.onSwitch).toHaveBeenLastCalledWith(1);
    expect(document.activeElement).toBe(pills[1]);
    keyOn(pills[0], "ArrowLeft");
    expect(tabs.onSwitch).toHaveBeenLastCalledWith(2);
    keyOn(pills[2], "ArrowRight");
    expect(tabs.onSwitch).toHaveBeenLastCalledWith(0);
    keyOn(pills[1], "End");
    expect(tabs.onSwitch).toHaveBeenLastCalledWith(2);
    keyOn(pills[1], "Home");
    expect(tabs.onSwitch).toHaveBeenLastCalledWith(0);
    expect(document.activeElement).toBe(pills[0]);

    keyOn(pills[1], "Delete");
    expect(tabs.onClose).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(pills[2]);
    expect(keyOn(pills[1], "a").defaultPrevented).toBe(false);
    expect(tabs.onSwitch).toHaveBeenCalledTimes(5);
  });

  it("tells a drag which pills it shows, and settles the strip for it", () => {
    const { stripHost, group } = setup();
    const blank: Tab = { kind: "empty" };
    group.renderTabs([tableTab, flowTab, blank], 0);
    const strip = stripHost.firstElementChild as HTMLElement;
    const pills = laidOut(stripHost) as HTMLButtonElement[];
    expect(group.pills()).toEqual(pills);
    expect(group.indexOf(pills[2])).toBe(2);
    expect(group.showing([tableTab, flowTab, blank])).toBe(true);
    expect(group.showing([flowTab, tableTab, blank])).toBe(false);
    expect(group.showing([tableTab, flowTab, { kind: "empty" }])).toBe(false);

    // A pill carried out of the strip is not among the strip's pills.
    document.body.append(pills[1]);
    expect(group.pills()).toEqual([pills[0], pills[2]]);
    pills[0].after(pills[1]);

    // A width hold is let go before the drag measures the strip.
    pills[1].querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    group.renderTabs([tableTab, blank], 0);
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("120px");
    group.settle();
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("");
  });

  it("places a pill a drag carried out by its gap, and leaves it alone once the gap has closed", () => {
    const { stripHost, group } = setup();
    const third: Tab = { kind: "table", path: "c.table.html" };
    group.renderTabs([tableTab, flowTab, third], 0);
    const strip = stripHost.firstElementChild as HTMLElement;
    const [first, carried, last] = strip.querySelectorAll<HTMLElement>(".editor-tab");
    const layer = document.createElement("div");
    document.body.append(layer);
    const gap = document.createElement("div");
    gap.className = "editor-tab-gap";
    carried.before(gap);
    layer.append(carried);

    // The pressed tab becomes the active one while it is carried.
    group.renderTabs([tableTab, flowTab, third], 1);
    expect(carried.parentElement).toBe(layer);
    expect(carried.classList.contains("active")).toBe(true);
    expect([...strip.children].slice(0, 3)).toEqual([first, gap, last]);

    gap.remove();
    group.renderTabs([tableTab, flowTab, third], 1);
    expect(carried.parentElement).toBe(layer);
    expect([...strip.children].slice(0, 2)).toEqual([first, last]);
  });

  it("hands a pill over to the other view, which keeps it rather than drawing a new one", () => {
    const left = setup();
    const right = setup();
    right.host.id = "editor-pane-group-2";
    const third: Tab = { kind: "table", path: "c.table.html" };
    left.group.renderTabs([tableTab, flowTab], 0);
    right.group.renderTabs([third], 0);
    const rightStrip = right.stripHost.firstElementChild as HTMLElement;
    const stayed = rightStrip.querySelector(".editor-tab") as HTMLButtonElement;

    const { tab, pill } = left.group.detach(1);
    expect(tab).toBe(flowTab);
    rightStrip.prepend(pill);
    right.group.attach(tab, pill, 0);
    expect(pill.classList.contains("active")).toBe(true);
    expect(pill.getAttribute("aria-controls")).toBe("editor-pane-group-2");
    expect(stayed.classList.contains("active")).toBe(false);

    // The model catches up: neither strip redraws the pill, and nothing rises.
    left.group.renderTabs([tableTab], 0);
    right.group.renderTabs([flowTab, third], 0);
    expect(left.stripHost.querySelectorAll(".editor-tab")).toHaveLength(1);
    expect([...rightStrip.querySelectorAll(".editor-tab")]).toEqual([pill, stayed]);
    expect(rightStrip.querySelector(".leaving, .rising")).toBeNull();

    // Its clicks reach the view it is in now.
    pill.click();
    expect(right.tabs.onSwitch).toHaveBeenCalledWith(0);
    expect(left.tabs.onSwitch).not.toHaveBeenCalled();
    pill.querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    expect(right.tabs.onClose).toHaveBeenCalledWith(0);
  });

  // A root has no name in its path: the space's is empty, a library's is
  // only its scheme and id, which stands in until the library's name is read.
  it("labels a folder whole, and a gallery of a root by the root", () => {
    const { stripHost, group } = setup();
    const tabs: Tab[] = [
      { kind: "gallery", path: "" },
      { kind: "gallery", path: "lib:footage" },
      { kind: "gallery", path: "lib:footage/day 1" },
      { kind: "gallery", path: "acts/v1.2" },
    ];
    const labels = () => Array.from(stripHost.querySelectorAll(".editor-tab-label")).map((el) => el.textContent);
    group.renderTabs(tabs, 0);
    expect(labels()).toEqual(["Space", "footage", "day 1", "v1.2"]);
    setLibraryPermissions([{ id: "footage", label: "Footage" } as LibraryRow]);
    group.renderTabs(tabs, 0);
    expect(labels()).toEqual(["Space", "Footage", "day 1", "v1.2"]);
  });

  it("gives a pill its file's tree glyph, and none to a plain file or a folder view", () => {
    const { stripHost, group } = setup();
    group.renderTabs(
      [
        { kind: "flow", path: "a.flow.html" },
        { kind: "document", path: "draft.fountain", documentType: "screenplay" },
        { kind: "applet-source", path: "tool.applet.html" },
        { kind: "document", path: "notes.md", documentType: "note" },
        { kind: "document", path: "todo.txt", documentType: "note" },
        { kind: "gallery", path: "scenes" },
        { kind: "empty" },
      ],
      0,
    );
    const pills = [...stripHost.querySelectorAll<HTMLElement>(".editor-tab")];
    expect(pills.map((pill) => pill.querySelector<HTMLElement>(".editor-tab-icon")?.dataset.entryIcon)).toEqual([
      "flow",
      "fountain",
      "applet",
      "markdown",
      undefined,
      undefined,
      undefined,
    ]);
    expect(pills.map((pill) => pill.querySelector(".editor-tab-icon") !== null)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(pills[0].firstElementChild?.className).toBe("editor-tab-icon");
  });

  it("a pill click switches; its close button closes without switching; a closed tab's pill goes", () => {
    const { stripHost: root, group, tabs } = setup();
    group.renderTabs([tableTab, flowTab], 0);
    const pills = root.querySelectorAll<HTMLButtonElement>(".editor-tab");

    pills[1].click();
    expect(tabs.onSwitch).toHaveBeenCalledWith(1);

    pills[0].querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    expect(tabs.onClose).toHaveBeenCalledWith(0);
    expect(tabs.onSwitch).toHaveBeenCalledTimes(1);

    group.renderTabs([flowTab], 0);
    expect(root.querySelectorAll(".editor-tab")).toHaveLength(1);
    expect(root.querySelector(".editor-tab")?.classList.contains("active")).toBe(true);
  });

  it("keeps a tab's pill across renders, and hands it to a tab that takes its place", () => {
    const { stripHost: root, group } = setup();
    const third: Tab = { kind: "table", path: "c.table.html" };
    group.renderTabs([tableTab, flowTab], 0);
    const [first, second] = root.querySelectorAll<HTMLElement>(".editor-tab");

    group.renderTabs([tableTab, flowTab, third], 2);
    const pills = root.querySelectorAll<HTMLElement>(".editor-tab");
    expect(pills).toHaveLength(3);
    expect(pills[0]).toBe(first);
    expect(pills[1]).toBe(second);

    // A file opened in the current tab replaces its Tab, in the same pill.
    group.renderTabs([tableTab, { kind: "flow", path: "d.flow.html" }, third], 1);
    expect(root.querySelectorAll(".editor-tab")[1]).toBe(second);
    expect(second.querySelector(".editor-tab-label")?.textContent).toBe("d");
    expect(second.dataset.tooltip).toBe("d.flow.html");
  });

  it("moves no kept pill when a tab between them closes or arrives", () => {
    const { stripHost: root, group } = setup();
    const third: Tab = { kind: "table", path: "c.table.html" };
    group.renderTabs([tableTab, flowTab, third], 2);
    const strip = root.firstElementChild as HTMLElement;
    const [first, second, last] = strip.querySelectorAll<HTMLElement>(".editor-tab");
    const moved: Node[] = [];
    new MutationObserver((records) => {
      for (const record of records) moved.push(...record.removedNodes);
    }).observe(strip, { childList: true });

    group.renderTabs([tableTab, third], 1);
    group.renderTabs([tableTab, { kind: "flow", path: "d.flow.html" }, third], 1);
    return Promise.resolve().then(() => {
      expect(moved).toEqual([second]);
      expect(strip.querySelectorAll(".editor-tab")[0]).toBe(first);
      expect(strip.querySelectorAll(".editor-tab")[2]).toBe(last);
    });
  });

  it("reports a pill's place as it stands when the pill is pressed", () => {
    const { stripHost: root, group, tabs } = setup();
    group.renderTabs([tableTab, flowTab], 0);
    const pill = root.querySelectorAll<HTMLButtonElement>(".editor-tab")[1];

    group.renderTabs([{ kind: "table", path: "c.table.html" }, tableTab, flowTab], 1);
    pill.click();
    expect(tabs.onSwitch).toHaveBeenCalledWith(2);
    pill.querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    expect(tabs.onClose).toHaveBeenCalledWith(2);
  });

  // jsdom lays nothing out, so each pill is handed the width it holds.
  function laidOut(root: HTMLElement): HTMLElement[] {
    const pills = [...root.querySelectorAll<HTMLElement>(".editor-tab")];
    for (const pill of pills) pill.getBoundingClientRect = () => ({ left: 0, width: 120 }) as DOMRect;
    return pills;
  }

  it("holds the pills' width after a press on a × until the pointer leaves the strip", () => {
    const { stripHost: root, group } = setup();
    const third: Tab = { kind: "table", path: "c.table.html" };
    group.renderTabs([tableTab, flowTab, third], 0);
    const strip = root.firstElementChild as HTMLElement;
    const pills = laidOut(root);

    pills[1].querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    group.renderTabs([tableTab, third], 0);
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("120px");

    strip.dispatchEvent(new Event("pointerleave"));
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("");
  });

  it("holds nothing for a close from anywhere but a ×, or for the last pill's", () => {
    const { stripHost: root, group } = setup();
    const third: Tab = { kind: "table", path: "c.table.html" };
    group.renderTabs([tableTab, flowTab, third], 0);
    const strip = root.firstElementChild as HTMLElement;
    let pills = laidOut(root);

    // A close from the keyboard or a menu.
    group.renderTabs([tableTab, third], 0);
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("");

    // The last pill's ×: the others may widen, as nothing sits after it.
    pills = laidOut(root);
    pills[1].querySelector<HTMLButtonElement>(".editor-tab-close")?.click();
    group.renderTabs([tableTab], 0);
    expect(strip.style.getPropertyValue("--tab-cap")).toBe("");
  });

  it("raises the active pill only when a tab already in the strip becomes the active one", () => {
    const { stripHost: root, group } = setup();
    const rising = () =>
      [...root.querySelectorAll(".editor-tab")].flatMap((pill, index) =>
        pill.classList.contains("rising") ? [index] : [],
      );
    const opened: Tab = { kind: "table", path: "c.table.html" };

    group.renderTabs([tableTab, flowTab], 0);
    expect(rising()).toEqual([]);

    group.renderTabs([tableTab, flowTab], 1);
    expect(rising()).toEqual([1]);

    // Redrawn for some other change, the same tab still active.
    group.renderTabs([tableTab, flowTab], 1);
    expect(rising()).toEqual([]);

    // A file opened in the current tab replaces its Tab.
    group.renderTabs([tableTab, opened], 1);
    expect(rising()).toEqual([]);

    // The active tab dragged to the front.
    group.renderTabs([opened, tableTab], 0);
    expect(rising()).toEqual([]);

    // The active tab closed, its neighbour taking over.
    group.renderTabs([tableTab], 0);
    expect(rising()).toEqual([0]);
  });

  it("marks the active pill as scrolling with the other side, before its ×, until another tab is the active one", () => {
    const { stripHost: root, group } = setup();
    const marked = () =>
      [...root.querySelectorAll(".editor-tab")].flatMap((pill, index) =>
        pill.querySelector(":scope > .editor-tab-sync") ? [index] : [],
      );
    group.renderTabs([tableTab, flowTab], 1);
    expect(marked()).toEqual([]);

    group.setScrollSynced(true);
    expect(marked()).toEqual([1]);
    const pill = root.querySelectorAll(".editor-tab")[1];
    const mark = pill.querySelector<HTMLElement>(".editor-tab-sync");
    expect(mark?.nextElementSibling?.classList.contains("editor-tab-close")).toBe(true);
    expect(mark?.dataset.tooltip).toBe("Scrolls with the other side");

    // Redrawn for some other change, or told again, it keeps the mark it has.
    group.renderTabs([tableTab, flowTab], 1);
    group.setScrollSynced(true);
    expect(pill.querySelector(".editor-tab-sync")).toBe(mark);

    // Another tab made the active one takes the mark away at once, before
    // the sync says the pair has ended.
    group.renderTabs([tableTab, flowTab], 0);
    expect(marked()).toEqual([]);
    group.setScrollSynced(false);
    group.renderTabs([tableTab, flowTab], 1);
    expect(marked()).toEqual([]);
  });

  it("lights the marked pill and its pane while told, and says when the pointer is on the mark", () => {
    const { stripHost: root, host, group, onScrollMarkHover } = setup();
    group.renderTabs([tableTab, flowTab], 0);
    group.setScrollSynced(true);
    const pill = root.querySelector<HTMLElement>(".editor-tab.active");
    const mark = pill?.querySelector(".editor-tab-sync");
    const lit = () => [pill?.classList.contains("sync-partner"), host.classList.contains("sync-partner")];

    group.lightScrollPartner(true);
    expect(lit()).toEqual([true, true]);
    group.lightScrollPartner(false);
    expect(lit()).toEqual([false, false]);

    mark?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(onScrollMarkHover).toHaveBeenLastCalledWith(true);
    mark?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect(onScrollMarkHover).toHaveBeenLastCalledWith(false);

    // A pair that ends under the pointer takes the light and the hover with it.
    mark?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    group.lightScrollPartner(true);
    group.setScrollSynced(false);
    expect(pill?.querySelector(".editor-tab-sync")).toBeNull();
    expect(lit()).toEqual([false, false]);
    expect(onScrollMarkHover).toHaveBeenLastCalledWith(false);
  });

  // A second editor group must stay possible (docs/architecture.md's Workspace and UI ownership
  // section): two groups, side by side, each with its own pane instance for
  // its own kind. No UI opens a second group, so this is the only thing that
  // notices if one stops working.
  it("two groups side by side hold independent pane instances", async () => {
    const panes = createEditorPanes();
    const created: ReturnType<typeof fakePane>[] = [];
    for (const kind of ["table", "flow"] as const) {
      panes.register({
        kind,
        chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
        create: () => {
          const pane = fakePane(kind);
          created.push(pane);
          return pane;
        },
      });
    }
    const left = document.createElement("div");
    const right = document.createElement("div");
    document.body.append(left, right);
    const tabs = {
      onSwitch: vi.fn(),
      onClose: vi.fn(),
      onNew: vi.fn(),
      onMenu: vi.fn(),
    };
    const strips = document.createElement("div");
    document.body.append(strips);
    const leftGroup = createEditorGroupView({ stripHost: strips, host: left, panes, tabs, paneGroup: fakePaneGroup() });
    const rightGroup = createEditorGroupView({
      stripHost: strips,
      host: right,
      panes,
      tabs,
      paneGroup: fakePaneGroup(),
    });

    const openLeft = leftGroup.open(tableTab);
    const openRight = rightGroup.open(flowTab);
    for (const pane of created) pane.release();
    await Promise.all([openLeft, openRight]);

    expect(created).toHaveLength(2);
    expect(left.querySelector(".pane-table")).not.toBeNull();
    expect(right.querySelector(".pane-flow")).not.toBeNull();
    expect(leftGroup.activePane()).not.toBe(rightGroup.activePane());
    expect(strips.querySelectorAll(".editor-group-tabs")).toHaveLength(2);
  });
});
