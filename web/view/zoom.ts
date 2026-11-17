// The desktop window's zoom: the Settings → Appearance picker, the stored
// percentage, and the commands that step it. Desktop only: a browser tab
// zooms itself on the same keys, and binding them here would take that away.
import type { PragmaElectronBridge } from "../core/apiClient.ts";
import { must } from "../lib/dom.ts";
import { zoomSettingRow } from "../lib/zoomPicker.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";
import { COMMAND_PALETTE, type ContextMenuService, type MenuRegistry } from "../services/menus.ts";
import { ZOOM_LEVELS, type ZoomSetting } from "../services/settings.ts";

export interface ZoomDeps {
  zoom: ZoomSetting;
  bridge: Pick<PragmaElectronBridge, "setZoomFactor"> | undefined;
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
  menus: MenuRegistry;
  contextMenu: ContextMenuService;
}

/** The level `by` steps away from `percent`, held at either end of the list. */
export function stepZoom(percent: number, by: number): number {
  const index = ZOOM_LEVELS.indexOf(percent);
  const from = index === -1 ? ZOOM_LEVELS.indexOf(100) : index;
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, from + by))] ?? 100;
}

export function wireZoom(deps: ZoomDeps): void {
  const { zoom, bridge } = deps;
  if (!bridge) return;
  must<HTMLElement>("#setting-zoom-row").replaceWith(
    zoomSettingRow({
      title: "Zoom",
      description: "Size of everything in the window.",
      setting: zoom,
      contextMenu: deps.contextMenu,
    }),
  );
  zoom.subscribe((percent) => bridge.setZoomFactor(percent / 100));

  deps.commands.register({ id: "window.zoomIn", label: "Zoom In", run: () => zoom.set(stepZoom(zoom.get(), 1)) });
  deps.commands.register({ id: "window.zoomOut", label: "Zoom Out", run: () => zoom.set(stepZoom(zoom.get(), -1)) });
  deps.commands.register({ id: "window.zoomReset", label: "Reset Zoom", run: () => zoom.set(100) });
  // + is Shift+= on a US keyboard, but its own key on many layouts and on
  // the keypad, so Zoom In answers to all three.
  for (const key of ["Mod+=", "Mod+Shift+Plus", "Mod+Plus"])
    deps.keybindings.register({ key, command: "window.zoomIn" });
  deps.keybindings.register({ key: "Mod+-", command: "window.zoomOut" });
  deps.keybindings.register({ key: "Mod+0", command: "window.zoomReset" });
  deps.menus.register(COMMAND_PALETTE, [
    { command: "window.zoomIn" },
    { command: "window.zoomOut" },
    { command: "window.zoomReset" },
  ]);
}
