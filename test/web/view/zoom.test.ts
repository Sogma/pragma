// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { COMMAND_PALETTE, createMenus } from "../../../web/services/menus.ts";
import { ZOOM_LEVELS, type ZoomSetting } from "../../../web/services/settings.ts";
import { stepZoom, wireZoom } from "../../../web/view/zoom.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

function setup(options: { stored?: number; electron?: boolean } = {}) {
  const placeholder = document.createElement("div");
  placeholder.id = "setting-zoom-row";
  placeholder.hidden = true;
  document.body.replaceChildren(placeholder);

  const stored = new Emitter<number>(options.stored ?? 100);
  const zoom: ZoomSetting = {
    levels: ZOOM_LEVELS,
    get: () => stored.get(),
    set: (value) => stored.set(value),
    subscribe: (listener) => stored.subscribe(listener),
  };
  const setZoomFactor = vi.fn();
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const menus = createMenus(commands);
  const contextMenu = fakeContextMenu();
  wireZoom({
    zoom,
    bridge: options.electron === false ? undefined : { setZoomFactor },
    commands,
    keybindings,
    menus,
    contextMenu,
  });
  // In the desktop app the row takes the placeholder's place.
  const row = document.body.firstElementChild as HTMLElement;
  const button = row.querySelector("button") as HTMLButtonElement;
  const named = () => button.querySelector(".picker-choice.current")?.textContent;
  return { row, button, named, contextMenu, zoom, setZoomFactor, commands, keybindings, menus };
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ctrlKey: true, ...init });
}

describe("stepZoom", () => {
  it("moves one level along the list and holds at either end", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(110, -1)).toBe(100);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(80, -1)).toBe(80);
  });

  it("steps from 100 when the current level is off the list", () => {
    expect(stepZoom(133, 1)).toBe(110);
  });
});

describe("wireZoom", () => {
  it("in a browser tab leaves the row hidden and claims no keys", () => {
    const { row, commands, keybindings } = setup({ electron: false });
    expect(row.hidden).toBe(true);
    expect(commands.get("window.zoomIn")).toBeUndefined();
    expect(keybindings.resolve(press("="), context)).toBeUndefined();
  });

  it("shows the row and applies the stored level at startup", () => {
    const { row, button, named, contextMenu, setZoomFactor } = setup({ stored: 125 });
    expect(row.hidden).toBe(false);
    expect(row.querySelector(".field-row-title")?.textContent).toBe("Zoom");
    expect(row.querySelector(".field-row-description")?.textContent).toBe("Size of everything in the window.");
    button.click();
    expect(contextMenu.labels()).toEqual(["80%", "90%", "100%", "110%", "125%", "150%", "175%", "200%"]);
    expect(named()).toBe("125%");
    expect(button.getAttribute("aria-label")).toBe("Zoom: 125%");
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.25);
  });

  it("a pick in the menu zooms the window", () => {
    const { button, contextMenu, named, zoom, setZoomFactor } = setup();
    button.click();
    contextMenu.pick("150%");
    expect(zoom.get()).toBe(150);
    expect(named()).toBe("150%");
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.5);
  });

  it("the commands step the level and the picker follows", async () => {
    const { named, zoom, commands, setZoomFactor } = setup({ stored: 110 });
    await commands.run("window.zoomIn", context);
    expect(zoom.get()).toBe(125);
    expect(named()).toBe("125%");
    await commands.run("window.zoomOut", context);
    await commands.run("window.zoomOut", context);
    expect(zoom.get()).toBe(100);
    await commands.run("window.zoomIn", context);
    await commands.run("window.zoomReset", context);
    expect(zoom.get()).toBe(100);
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
  });

  it("Zoom In answers to =, Shift+= and the keypad's +", () => {
    const { keybindings } = setup();
    expect(keybindings.resolve(press("="), context)?.command).toBe("window.zoomIn");
    expect(keybindings.resolve(press("+", { shiftKey: true }), context)?.command).toBe("window.zoomIn");
    expect(keybindings.resolve(press("+"), context)?.command).toBe("window.zoomIn");
    expect(keybindings.resolve(press("-"), context)?.command).toBe("window.zoomOut");
    expect(keybindings.resolve(press("0"), context)?.command).toBe("window.zoomReset");
  });

  it("lists the three commands in the palette, so Settings → Shortcuts can rebind them", () => {
    const { menus } = setup();
    expect(menus.commandsIn(COMMAND_PALETTE, context)).toEqual([
      { command: "window.zoomIn", label: "Zoom In" },
      { command: "window.zoomOut", label: "Zoom Out" },
      { command: "window.zoomReset", label: "Reset Zoom" },
    ]);
  });
});
