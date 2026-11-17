import { describe, expect, it, vi } from "vitest";
import type { Setting } from "../../../web/services/settings.ts";
import { createSidebarViews, type SidebarView } from "../../../web/services/sidebarViews.ts";

function fakeSetting(initial: boolean): Setting<boolean> & { writes: boolean[] } {
  let value = initial;
  const writes: boolean[] = [];
  return {
    writes,
    get: () => value,
    set(next) {
      value = next;
      writes.push(next);
    },
    subscribe: () => () => {},
  };
}

// The service never touches the DOM, so a bare object stands in for the
// panel element it carries opaquely.
function view(id: string, onShow?: () => void): SidebarView {
  return { id, label: id, icon: "<svg></svg>", panel: {} as HTMLElement, onShow };
}

describe("createSidebarViews", () => {
  it("makes the first registered view active and keeps registration order", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    sidebar.register(view("git"));

    expect(sidebar.get().activeId).toBe("space");
    expect(sidebar.get().views.map((v) => v.id)).toEqual(["space", "git"]);
  });

  it("rejects a duplicate id", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));

    expect(() => sidebar.register(view("space"))).toThrow(/already registered/);
  });

  it("activate() shows the view, un-collapses the sidebar, and fires onShow every time", () => {
    const onShow = vi.fn();
    const sidebar = createSidebarViews({ hidden: fakeSetting(true) });
    sidebar.register(view("space"));
    sidebar.register(view("git", onShow));

    sidebar.activate("git");
    sidebar.activate("git");

    expect(sidebar.get()).toMatchObject({ activeId: "git", hidden: false });
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it("toggle() collapses the active, visible view and activates any other", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    sidebar.register(view("git"));

    sidebar.toggle("space");
    expect(sidebar.get()).toMatchObject({ activeId: "space", hidden: true });

    sidebar.toggle("space");
    expect(sidebar.get()).toMatchObject({ activeId: "space", hidden: false });

    sidebar.toggle("git");
    expect(sidebar.get()).toMatchObject({ activeId: "git", hidden: false });
  });

  it("persists hidden through the setting only when it changes", () => {
    const hidden = fakeSetting(false);
    const sidebar = createSidebarViews({ hidden });
    sidebar.register(view("space"));

    sidebar.setHidden(true);
    sidebar.setHidden(true);
    sidebar.activate("space");

    expect(hidden.writes).toEqual([true, false]);
  });

  it("starts collapsed when the setting says so", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(true) });
    expect(sidebar.get().hidden).toBe(true);
  });

  it("notifies subscribers immediately and on every change", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    const seen: Array<string | undefined> = [];
    sidebar.subscribe((state) => seen.push(state.activeId));

    sidebar.register(view("space"));
    sidebar.register(view("git"));
    sidebar.activate("git");

    expect(seen).toEqual([undefined, "space", "space", "git"]);
  });

  it("disposing a registration removes it and falls back to the first remaining view", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false) });
    sidebar.register(view("space"));
    const git = sidebar.register(view("git"));
    sidebar.activate("git");

    git.dispose();

    expect(sidebar.get().views.map((v) => v.id)).toEqual(["space"]);
    expect(sidebar.get().activeId).toBe("space");
    expect(() => sidebar.activate("git")).toThrow(/no sidebar view/);
  });
});

// Where the sidebar was left comes back on the next load — but only through
// a real activation, never through registration, and only shown once the
// bootstrap says the panels may draw.
describe("remembering the active view", () => {
  function memory(initial: string) {
    let value = initial;
    return {
      get: () => value,
      set: (next: string) => {
        value = next;
      },
      subscribe: () => () => undefined,
      log: () => value,
    };
  }

  it("makes the remembered view the initial one when it registers, without showing it", () => {
    const active = memory("git");
    const sidebar = createSidebarViews({ hidden: fakeSetting(false), active });
    const onShow = vi.fn();
    sidebar.register(view("space"));
    expect(sidebar.get().activeId).toBe("space");
    sidebar.register(view("git", onShow));
    expect(sidebar.get().activeId).toBe("git");
    expect(onShow).not.toHaveBeenCalled();
    // Registration wrote nothing: the memory still says what it said.
    expect(active.log()).toBe("git");
  });

  it("restore() shows whatever is active, once", () => {
    const onShow = vi.fn();
    const sidebar = createSidebarViews({ hidden: fakeSetting(false), active: memory("git") });
    sidebar.register(view("space"));
    sidebar.register(view("git", onShow));
    sidebar.restore();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first view when the remembered one never registers", () => {
    const sidebar = createSidebarViews({ hidden: fakeSetting(false), active: memory("retired") });
    sidebar.register(view("space"));
    sidebar.register(view("git"));
    expect(sidebar.get().activeId).toBe("space");
    expect(() => sidebar.restore()).not.toThrow();
  });

  it("remembers an activation, and not a collapse", () => {
    const active = memory("");
    const sidebar = createSidebarViews({ hidden: fakeSetting(false), active });
    sidebar.register(view("space"));
    sidebar.register(view("git"));
    sidebar.activate("git");
    expect(active.log()).toBe("git");
    sidebar.toggle("git"); // collapses the sidebar; the view stays the one to come back to
    expect(active.log()).toBe("git");
  });
});
