// The theme control: the Settings picker, the stored preference, and the
// `data-theme` attribute every token block in web/styles/tokens.css keys off. One
// place, because the three have to move together — a preference written
// without the attribute applied leaves the UI showing the old theme until
// reload, and an attribute applied without the write loses it on reload.
//
// The attribute holds only the resolved "light" or "dark", never "system", so
// nothing that reads it needs to know about the OS: under "system" it is
// resolved again whenever the OS switches.
//
// The desktop window's own UI is handed the pick itself, "system" included,
// which keeps its prefers-color-scheme the OS's for System Default.
import type { PragmaElectronBridge } from "../core/apiClient.ts";
import { type PickerChoice, wireChoicePicker } from "../lib/picker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import * as settings from "../services/settings.ts";

const THEMES: PickerChoice[] = [
  { value: "system", label: "System Default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Applies the stored theme immediately and keeps the picker, the stored
 * value and the document attribute in step from then on. */
export function wireThemeControl(
  button: HTMLButtonElement,
  theme: settings.Setting<settings.Theme>,
  contextMenu: ContextMenuService,
  bridge?: Pick<PragmaElectronBridge, "setNativeTheme">,
): void {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const picker = wireChoicePicker(button, THEMES, {
    role: "Color scheme",
    contextMenu,
    align: "end",
    pick: (value) => theme.set(settings.parseTheme(value)),
  });

  function apply(): void {
    const pick = theme.get();
    const dark = pick === "dark" || (pick === "system" && systemDark.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    picker.show(pick);
    void bridge?.setNativeTheme(pick);
  }

  theme.subscribe(apply);
  systemDark.addEventListener("change", apply);
}
