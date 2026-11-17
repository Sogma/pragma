// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../../web/lib/emitter.ts";
import { createCommands } from "../../../../web/services/commands.ts";
import { createKeybindings } from "../../../../web/services/keybindings.ts";
import { createMenus } from "../../../../web/services/menus.ts";
import type { Setting } from "../../../../web/services/settings.ts";
import { createSidebarViews, type RailStatus, type SidebarView } from "../../../../web/services/sidebarViews.ts";
import {
  createSidebarShell,
  registerSidebarCommands,
  type SidebarShellElements,
} from "../../../../web/view/sidebar/shell.ts";

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

const noWidth = () => fakeSetting<number | undefined>(undefined);

afterEach(() => {
  document.documentElement.style.removeProperty("--sidebar-width");
  document.documentElement.style.removeProperty("--sidebar-min-width");
  vi.restoreAllMocks();
});

// jsdom lays nothing out: each rail child gets a 48px slot in DOM order.
function stubRailLayout(): void {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return Array.from(this.parentElement?.children ?? []).indexOf(this) * 48;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
}

function elements(): SidebarShellElements {
  const rail = document.createElement("nav");
  const railTail = document.createElement("button");
  railTail.id = "rail-settings";
  rail.append(railTail);
  const sidebar = document.createElement("div");
  const resizeHandle = document.createElement("div");
  const headerToggle = document.createElement("button");
  const headerSpacer = document.createElement("div");
  document.body.append(rail, sidebar, resizeHandle, headerToggle, headerSpacer);
  return { rail, railTail, sidebar, resizeHandle, headerToggle, headerSpacer };
}

function view(id: string, onShow?: () => void): SidebarView {
  const panel = document.createElement("section");
  panel.className = "sidebar-panel";
  return { id, label: id, icon: "<svg></svg>", panel, onShow };
}

function railIds(rail: HTMLElement): string[] {
  return Array.from(rail.children)
    .filter((el) => !el.classList.contains("rail-indicator"))
    .map((el) => (el as HTMLElement).dataset.view ?? el.id);
}

const railBar = (rail: HTMLElement) => rail.querySelector(".rail-indicator") as HTMLElement;

describe("createSidebarShell", () => {
  it("renders one rail button per registered view, in order, before the tail", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    sidebar.register(view("git"));

    createSidebarShell(els, sidebar, noWidth());

    expect(railIds(els.rail)).toEqual(["space", "git", "rail-settings"]);
    // An icon button's tooltip is its accessible name (lib/tooltip.ts).
    const space = els.rail.querySelector<HTMLButtonElement>('[data-view="space"]');
    expect(space?.classList.contains("icon-button")).toBe(true);
    expect(space?.getAttribute("aria-label")).toBe("space");
  });

  it("mounts every panel under the sidebar and shows only the active one", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    const space = view("space");
    const git = view("git");
    sidebar.register(space);
    sidebar.register(git);

    createSidebarShell(els, sidebar, noWidth());

    expect(space.panel.parentElement).toBe(els.sidebar);
    expect(git.panel.parentElement).toBe(els.sidebar);
    expect(space.panel.hidden).toBe(false);
    expect(git.panel.hidden).toBe(true);
    expect(els.rail.querySelector('[data-view="space"]')?.classList.contains("active")).toBe(true);
  });

  it("a rail click activates a view and fires its onShow; clicking the active view collapses", () => {
    const els = elements();
    const onShow = vi.fn();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    const space = view("space");
    const git = view("git", onShow);
    sidebar.register(space);
    sidebar.register(git);
    createSidebarShell(els, sidebar, noWidth());

    els.rail.querySelector<HTMLButtonElement>('[data-view="git"]')?.click();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(git.panel.hidden).toBe(false);
    expect(space.panel.hidden).toBe(true);
    expect(els.sidebar.hidden).toBe(false);

    els.rail.querySelector<HTMLButtonElement>('[data-view="git"]')?.click();
    expect(els.sidebar.hidden).toBe(true);
    expect(els.resizeHandle.hidden).toBe(true);
    expect(els.headerSpacer.classList.contains("collapsed")).toBe(true);
    expect(els.headerToggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("places one bar on the restored view without sliding, and slides it from the first switch on", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false), active: fakeSetting("git") });
    sidebar.register(view("space"));
    sidebar.register(view("git"));
    stubRailLayout();
    createSidebarShell(els, sidebar, noWidth());
    const bar = railBar(els.rail);

    expect(bar.hidden).toBe(false);
    expect(bar.dataset.view).toBe("git");
    expect(bar.style.transform).toBe("translateY(48px)");
    expect(bar.style.height).toBe("48px");

    els.headerToggle.click();
    els.headerToggle.click();
    expect(bar.classList.contains("animated")).toBe(false);

    els.rail.querySelector<HTMLButtonElement>('[data-view="space"]')?.click();
    expect(bar.dataset.view).toBe("space");
    expect(bar.style.transform).toBe("translateY(0px)");
    expect(bar.classList.contains("animated")).toBe(true);
  });

  it("hides the bar until a view registers, then places it without sliding", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    createSidebarShell(els, sidebar, noWidth());
    const bar = railBar(els.rail);
    expect(bar.hidden).toBe(true);

    sidebar.register(view("space"));

    expect(bar.hidden).toBe(false);
    expect(bar.dataset.view).toBe("space");
    expect(bar.classList.contains("animated")).toBe(false);
  });

  it("the header toggle flips collapsed without changing the active view", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(true) });
    sidebar.register(view("space"));
    sidebar.register(view("git"));
    createSidebarShell(els, sidebar, noWidth());
    expect(els.sidebar.hidden).toBe(true);

    els.headerToggle.click();

    expect(els.sidebar.hidden).toBe(false);
    expect(els.headerToggle.getAttribute("aria-pressed")).toBe("true");
    expect(sidebar.get().activeId).toBe("space");
  });

  it("restores the saved state in place, and slides from the first toggle on", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(true) });
    sidebar.register(view("space"));
    createSidebarShell(els, sidebar, noWidth());
    sidebar.register(view("git"));
    expect(els.sidebar.classList.contains("animated")).toBe(false);
    expect(els.headerSpacer.classList.contains("animated")).toBe(false);

    els.headerToggle.click();

    expect(els.sidebar.hidden).toBe(false);
    expect(els.sidebar.classList.contains("animated")).toBe(true);
    expect(els.headerSpacer.classList.contains("animated")).toBe(true);
  });

  it("a view registered after the shell exists gets a button in the right place", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    createSidebarShell(els, sidebar, noWidth());

    const late = view("late");
    sidebar.register(late);

    expect(railIds(els.rail)).toEqual(["space", "late", "rail-settings"]);
    expect(late.panel.parentElement).toBe(els.sidebar);
    expect(late.panel.hidden).toBe(true);
  });

  it("disposing the shell stops it reacting to clicks", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    sidebar.register(view("git"));
    const shell = createSidebarShell(els, sidebar, noWidth());

    shell.dispose();
    els.rail.querySelector<HTMLButtonElement>('[data-view="git"]')?.click();

    expect(sidebar.get().activeId).toBe("space");
  });

  it("draws a view's badge and detail on its rail button, and keeps them current", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    const status = new Emitter<RailStatus>({
      badge: { text: "3", tone: "count" },
      detail: "On main · 3 uncommitted changes",
    });
    sidebar.register({ ...view("source-control"), label: "Source Control", status });

    const store = createSidebarShell(els, sidebar, noWidth());
    const button = els.rail.querySelector<HTMLButtonElement>('[data-view="source-control"]') as HTMLButtonElement;
    const badge = () => button.querySelector<HTMLElement>(".rail-badge");

    expect(badge()?.textContent).toBe("3");
    expect(badge()?.getAttribute("aria-hidden")).toBe("true");
    expect(button.dataset.tooltip).toBe("Source Control\nOn main · 3 uncommitted changes");
    expect(button.getAttribute("aria-label")).toBe("Source Control: On main · 3 uncommitted changes");

    status.set({ badge: { text: "!", tone: "warning" }, detail: "Restricted mode" });
    expect(badge()?.textContent).toBe("!");
    expect(badge()?.classList.contains("warning")).toBe(true);

    status.set({});
    expect(badge()).toBeNull();
    expect(button.dataset.tooltip).toBe("Source Control");

    store.dispose();
    status.set({ badge: { text: "9", tone: "count" } });
    expect(badge()).toBeNull();
  });

  it("hands a right-click on a rail button to its view's menu, at the pointer, and leaves other views' alone", () => {
    const els = elements();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    const onContextMenu = vi.fn();
    sidebar.register({ ...view("space"), onContextMenu });
    sidebar.register(view("git"));
    createSidebarShell(els, sidebar, noWidth());
    const rightClick = (id: string) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
      els.rail.querySelector<HTMLButtonElement>(`[data-view="${id}"]`)?.dispatchEvent(event);
      return event;
    };

    expect(rightClick("space").defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledWith({ x: 12, y: 34 });
    expect(sidebar.get().activeId).toBe("space");

    expect(rightClick("git").defaultPrevented).toBe(false);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  describe("width", () => {
    const sidebarWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");

    it("leaves the stylesheet's default until a width has been saved", () => {
      createSidebarShell(elements(), createSidebarViews({ hidden: fakeSetting(false) }), noWidth());

      expect(sidebarWidth()).toBe("");
    });

    it("restores a saved width", () => {
      createSidebarShell(
        elements(),
        createSidebarViews({ hidden: fakeSetting(false) }),
        fakeSetting<number | undefined>(320),
      );

      expect(sidebarWidth()).toBe("320px");
    });

    it("caps a width saved in a wider window at what the window has", () => {
      createSidebarShell(
        elements(),
        createSidebarViews({ hidden: fakeSetting(false) }),
        fakeSetting<number | undefined>(window.innerWidth + 500),
      );

      expect(sidebarWidth()).toBe(`${window.innerWidth}px`);
    });

    it("saves the width once, when the drag ends", () => {
      const els = elements();
      const width = fakeSetting<number | undefined>(undefined);
      createSidebarShell(els, createSidebarViews({ hidden: fakeSetting(false) }), width);

      els.resizeHandle.dispatchEvent(new MouseEvent("mousedown"));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 340 }));
      expect(sidebarWidth()).toBe("340px");
      expect(width.get()).toBeUndefined();

      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(width.get()).toBe(340);
    });

    it("hides near the rail as its toggle does, saving no width, and reopens at the width it had", () => {
      document.documentElement.style.setProperty("--sidebar-min-width", "200px");
      const els = elements();
      const hidden = fakeSetting(false);
      const width = fakeSetting<number | undefined>(320);
      createSidebarShell(els, createSidebarViews({ hidden }), width);

      els.resizeHandle.dispatchEvent(new MouseEvent("mousedown"));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120 }));
      expect(sidebarWidth()).toBe("200px");
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 30 }));
      expect(els.sidebar.hidden).toBe(true);
      expect(els.sidebar.classList.contains("animated")).toBe(true);
      expect(hidden.get()).toBe(true);

      // Left alone while hidden: the slide-out may still be under way.
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(width.get()).toBe(320);
      expect(sidebarWidth()).toBe("200px");

      els.headerToggle.click();
      expect(els.sidebar.hidden).toBe(false);
      expect(sidebarWidth()).toBe("320px");
    });
  });
});

describe("registerSidebarCommands", () => {
  it("hides a showing sidebar and shows a hidden one, as the header toggle does", async () => {
    const hidden = fakeSetting(false);
    const sidebar = createSidebarViews({ hidden });
    const commands = createCommands();
    registerSidebarCommands(sidebar, {
      commands,
      keybindings: createKeybindings(commands),
      menus: createMenus(commands),
    });
    const context = { tab: { kind: "empty" as const }, pane: undefined };

    await commands.run("sidebar.toggle", context);
    expect(sidebar.get().hidden).toBe(true);
    expect(hidden.get()).toBe(true);
    await commands.run("sidebar.toggle", context);
    expect(sidebar.get().hidden).toBe(false);
  });
});
