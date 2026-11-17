// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import type { Setting, Theme } from "../../../web/services/settings.ts";
import { wireThemeControl } from "../../../web/view/theme.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

function setup(pick: Theme, systemDark: boolean, bridge?: { setNativeTheme: (theme: Theme) => Promise<void> }) {
  const listeners: (() => void)[] = [];
  const query = {
    matches: systemDark,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
  };
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  const switchSystem = (dark: boolean) => {
    query.matches = dark;
    for (const listener of listeners) listener();
  };

  const button = document.createElement("button");
  const stored = new Emitter<Theme>(pick);
  const theme: Setting<Theme> = {
    get: () => stored.get(),
    set: (value) => stored.set(value),
    subscribe: (listener) => stored.subscribe(listener),
  };
  const contextMenu = fakeContextMenu();
  wireThemeControl(button, theme, contextMenu, bridge);
  const shown = () => document.documentElement.getAttribute("data-theme");
  // What the picker names, and the row its menu checks.
  const named = () => button.querySelector(".picker-choice.current")?.textContent;
  const choose = (label: string) => {
    button.click();
    contextMenu.pick(label);
  };
  return { button, theme, matchMedia, switchSystem, shown, named, choose, contextMenu };
}

describe("wireThemeControl", () => {
  it("resolves System Default to the OS's mode and follows the OS as it switches", () => {
    const { button, matchMedia, switchSystem, shown, named } = setup("system", true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(named()).toBe("System Default");
    expect(button.getAttribute("aria-label")).toBe("Color scheme: System Default");
    expect(shown()).toBe("dark");
    switchSystem(false);
    expect(shown()).toBe("light");
    switchSystem(true);
    expect(shown()).toBe("dark");
  });

  it.each(["light", "dark"] as const)("keeps a picked %s whatever the OS does", (pick) => {
    const { named, switchSystem, shown } = setup(pick, pick === "light");
    expect(named()).toBe(pick === "light" ? "Light" : "Dark");
    expect(shown()).toBe(pick);
    switchSystem(pick !== "light");
    expect(shown()).toBe(pick);
  });

  it("offers the three schemes in its menu, the stored one checked", () => {
    const { button, contextMenu } = setup("light", true);
    button.click();
    expect(contextMenu.labels()).toEqual(["System Default", "Light", "Dark"]);
    const context = { tab: { kind: "empty" as const }, pane: undefined };
    expect(contextMenu.rows().map((row) => row.checked?.(context, undefined))).toEqual([false, true, false]);
    expect(contextMenu.opened[0]).toMatchObject({ anchor: button, ariaLabel: "Color scheme", picker: true });
  });

  it("stores and applies a pick from the menu", () => {
    const { theme, shown, named, choose } = setup("light", true);
    choose("System Default");
    expect(theme.get()).toBe("system");
    expect(shown()).toBe("dark");
    expect(named()).toBe("System Default");
    choose("Light");
    expect(theme.get()).toBe("light");
    expect(shown()).toBe("light");
  });

  // The pick itself, so under System Default the desktop window's
  // prefers-color-scheme keeps following the OS.
  it("hands the desktop window the pick, not the scheme it resolves to", () => {
    const bridge = { setNativeTheme: vi.fn(async (_theme: Theme) => {}) };
    const { choose } = setup("system", true, bridge);
    expect(bridge.setNativeTheme).toHaveBeenLastCalledWith("system");
    choose("Light");
    expect(bridge.setNativeTheme).toHaveBeenLastCalledWith("light");
  });

  it("shows a change made outside the picker", () => {
    const { named, theme, shown } = setup("system", false);
    theme.set("dark");
    expect(named()).toBe("Dark");
    expect(shown()).toBe("dark");
  });
});
