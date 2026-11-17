// The window's own minimize, maximize and close. Electron draws them over the
// header's far end on Windows and Linux (electron/main.ts) and the header
// keeps their room; this tells Electron the colours and height to draw them
// in, again whenever the theme or the zoom changes. macOS keeps its traffic
// lights, and a browser tab has no window to control.
import type { PragmaElectronBridge } from "../core/apiClient.ts";
import { must } from "../lib/dom.ts";
import { pixelToken } from "../lib/panelResize.ts";
import type { Setting } from "../services/settings.ts";

type WindowBridge = Pick<PragmaElectronBridge, "platform" | "styleWindowControls">;

export function wireWindowControls(bridge: WindowBridge | undefined, zoom: Setting<number>): void {
  if (!bridge || bridge.platform === "darwin") return;
  const header = must<HTMLElement>("#app-header");
  const room = must<HTMLElement>("#header-window-controls");
  room.hidden = false;
  const report = () =>
    void bridge.styleWindowControls({
      background: getComputedStyle(header).backgroundColor,
      foreground: getComputedStyle(room).color,
      // In DIPs, as Electron sizes them, and short of the header's bottom
      // line, which they would otherwise cover.
      height: Math.floor((pixelToken("--header-height") - 1) * (zoom.get() / 100)),
    });
  zoom.subscribe(report);
  // Every colour token keys off it (theme.ts).
  new MutationObserver(report).observe(document.documentElement, { attributeFilter: ["data-theme"] });
}
