// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import type { Setting } from "../../../web/services/settings.ts";
import { wireWindowControls } from "../../../web/view/windowControls.ts";

function bridge(platform: string) {
  return { platform, styleWindowControls: vi.fn(async () => {}) };
}

function zoomSetting(percent: number): Setting<number> {
  const stored = new Emitter<number>(percent);
  return {
    get: () => stored.get(),
    set: (value) => stored.set(value),
    subscribe: (listener) => stored.subscribe(listener),
  };
}

const room = () => document.querySelector<HTMLElement>("#header-window-controls") as HTMLElement;

beforeEach(() => {
  document.documentElement.style.setProperty("--header-height", "40px");
  document.body.innerHTML = `<header id="app-header" style="background-color: rgb(246, 246, 246)">
    <div id="header-window-controls" style="color: rgb(136, 136, 136)" hidden></div>
  </header>`;
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("the window's own controls", () => {
  it("are given the header's colours and its height in DIPs, short of its bottom line", () => {
    const desktop = bridge("win32");
    wireWindowControls(desktop, zoomSetting(150));

    expect(room().hidden).toBe(false);
    expect(desktop.styleWindowControls).toHaveBeenLastCalledWith({
      background: "rgb(246, 246, 246)",
      foreground: "rgb(136, 136, 136)",
      height: 58,
    });
  });

  it("follow the zoom and the theme as they change", async () => {
    const desktop = bridge("linux");
    const zoom = zoomSetting(100);
    wireWindowControls(desktop, zoom);
    zoom.set(200);
    expect(desktop.styleWindowControls).toHaveBeenLastCalledWith(expect.objectContaining({ height: 78 }));

    room().style.color = "rgb(134, 134, 134)";
    document.documentElement.setAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(desktop.styleWindowControls).toHaveBeenLastCalledWith(
      expect.objectContaining({ foreground: "rgb(134, 134, 134)", height: 78 }),
    );
  });

  it("are left alone in a browser, and on macOS, which keeps its traffic lights", () => {
    wireWindowControls(undefined, zoomSetting(100));
    const mac = bridge("darwin");
    wireWindowControls(mac, zoomSetting(100));

    expect(room().hidden).toBe(true);
    expect(mac.styleWindowControls).not.toHaveBeenCalled();
  });
});
