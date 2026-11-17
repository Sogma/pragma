// Settings' fonts for the whole app: Appearance → Interface font, on :root
// as --font-interface, and Editor → Font, for notes, as --font-text. A note's
// surfaces read only --font-text, so a note keeps its font whatever the
// interface's is; Tables and Classes take the interface's, and
// an Applet's source the Code page's.
import { must } from "../lib/dom.ts";
import {
  createInstalledFonts,
  type FontChoice,
  type FontSetting,
  fontSettingRow,
  type InstalledFonts,
  installedFamily,
} from "../lib/fontPicker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import {
  DEFAULT_EDITOR_FONT,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_INTERFACE_FONT,
  type Setting,
} from "../services/settings.ts";

// The system's own fonts, which every browser draws, including one that
// can't list the installed fonts.
const SYSTEM_FONTS: FontChoice[] = [
  { value: "sans-serif", label: "System sans-serif", font: "var(--font-system)", monospaced: false },
  { value: "serif", label: "System serif", font: "var(--font-serif)", monospaced: false, standIn: true },
  { value: "monospace", label: "System monospace", font: "var(--font-monospace)", monospaced: true, standIn: true },
];

// Segoe UI by name is the default's own face, re-split to centre its capitals
// beside icons (fonts.css): as installed, its text sits a pixel low.
const SEGOE_UI = '"Segoe UI Centred", "Segoe UI", var(--font-system)';

function fontFamily(value: string): string {
  return SYSTEM_FONTS.find((choice) => choice.value === value)?.font ?? installedFamily(value);
}

export interface FontsDeps {
  interfaceFont: Setting<string>;
  editorFont: Setting<string>;
  contextMenu: ContextMenuService;
  fonts?: InstalledFonts;
}

/** Puts the Interface font and Font rows in their Settings slots, and keeps
 * each one's property on :root on its pick. */
export function wireFonts(deps: FontsDeps): void {
  const { interfaceFont, editorFont, contextMenu } = deps;
  const fonts = deps.fonts ?? createInstalledFonts();
  const root = document.documentElement.style;
  // Resolved as index.html's first-paint script resolves it before this
  // module loads, so the window never paints in one font and then another;
  // a test holds the two alike.
  interfaceFont.subscribe((value) => {
    if (value === DEFAULT_INTERFACE_FONT) root.removeProperty("--font-interface");
    else root.setProperty("--font-interface", value.toLowerCase() === "segoe ui" ? SEGOE_UI : fontFamily(value));
  });
  editorFont.subscribe((value) => root.setProperty("--font-text", fontFamily(value)));

  const row = (options: Pick<FontSetting, "title" | "setting" | "defaultValue" | "description" | "resetLabel">) =>
    fontSettingRow({ ...options, builtIn: SYSTEM_FONTS, monospace: false, fonts, contextMenu });
  must<HTMLElement>("#setting-interface-font").replaceWith(
    row({
      title: "Interface font",
      setting: interfaceFont,
      defaultValue: DEFAULT_INTERFACE_FONT,
      description: "Font for menus and panels.",
      resetLabel: "Reset interface font to default",
    }),
  );
  must<HTMLElement>("#setting-editor-font").replaceWith(
    row({
      setting: editorFont,
      defaultValue: DEFAULT_EDITOR_FONT,
      description: "Font for notes.",
      resetLabel: "Reset font to default",
    }),
  );
}

/** The Editor's Font size slider, on :root as --editor-font-size. */
export function wireEditorFontSize(fontSize: Setting<number>): void {
  const slider = must<HTMLInputElement>("#setting-editor-font-size");
  const value = must<HTMLSpanElement>("#setting-editor-font-size-value");
  const reset = must<HTMLButtonElement>("#setting-editor-font-size-reset");
  fontSize.subscribe((size) => {
    document.documentElement.style.setProperty("--editor-font-size", `${size}px`);
    slider.value = String(size);
    value.textContent = `${size}px`;
    // Hidden, not removed, as the Font row's is: the row keeps its height.
    reset.style.visibility = size === DEFAULT_EDITOR_FONT_SIZE ? "hidden" : "";
  });
  slider.addEventListener("input", () => fontSize.set(Number(slider.value)));
  reset.addEventListener("click", () => fontSize.set(DEFAULT_EDITOR_FONT_SIZE));
}
