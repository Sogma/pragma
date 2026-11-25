// Source mode's own preferences and its page under Settings → Editor → Formats:
// how an applet's source is laid out, apart from a note's, and the font it is
// set in. Code runs the pane's width with its line numbers, folding markers
// and indentation guides showing until they are turned off here. The font
// lands on :root as --font-code, which editor.css sets the source's text in.
import {
  createInstalledFonts,
  cssFamily,
  type FontChoice,
  fontSettingRow,
  type InstalledFonts,
} from "../../lib/fontPicker.ts";
import { toggleSettingRow } from "../../lib/toggleRow.ts";
import type { FormatSettings } from "../../services/formats.ts";
import type { ContextMenuService } from "../../services/menus.ts";
import { createBooleanSetting, createSetting, type EditorLayout, type Setting } from "../../services/settings.ts";

export const codeLayout: EditorLayout = {
  readableLineLength: createBooleanSetting("pragma:code-readable-line-length", (stored) => stored === "true"),
  lineNumbers: createBooleanSetting("pragma:code-line-numbers", (stored) => stored !== "false"),
  foldMarkers: createBooleanSetting("pragma:code-fold-markers", (stored) => stored !== "false"),
  indentGuides: createBooleanSetting("pragma:code-indent-guides", (stored) => stored !== "false"),
};

// A built-in font's value, or an installed font's family name.
const DEFAULT_CODE_FONT = "monospace";

const BUILT_IN: FontChoice[] = [
  { value: DEFAULT_CODE_FONT, label: "System monospace", font: "var(--font-monospace)", monospaced: true },
];

export const codeFont = createSetting("pragma:code-font", (stored) => (stored?.trim() ? stored : DEFAULT_CODE_FONT));

/** Keeps --font-code on :root on the font picked. An installed font falls
 * back to the system's code font for a letter it lacks. */
export function wireCodeFont(font: Setting<string> = codeFont): void {
  font.subscribe((value) => {
    const family =
      BUILT_IN.find((choice) => choice.value === value)?.font ?? `${cssFamily(value)}, var(--font-monospace)`;
    document.documentElement.style.setProperty("--font-code", family);
  });
}

export interface CodeSettingsDeps {
  layout?: EditorLayout;
  font?: Setting<string>;
  contextMenu: ContextMenuService;
  fonts?: InstalledFonts;
  // Folding markers turned off: the only way back into a folded block went
  // with them, so every open Source mode tab is unfolded.
  onFoldMarkersHidden: () => void;
}

/** Keeps the code font on :root, and returns Source mode's page for the
 * Formats list. */
export function wireCodeSettings(deps: CodeSettingsDeps): { id: string; settings: FormatSettings } {
  wireCodeFont(deps.font);
  return { id: "code", settings: codeSettings(deps) };
}

export function codeSettings(deps: CodeSettingsDeps): FormatSettings {
  const { layout = codeLayout, font = codeFont, fonts = createInstalledFonts() } = deps;
  return {
    label: "Code",
    detail: "An applet in Source mode",
    page() {
      const card = document.createElement("div");
      card.className = "settings-card";
      card.append(
        toggleSettingRow({
          title: "Readable line length",
          description: "Limit code to a comfortable width.",
          setting: layout.readableLineLength,
        }),
        toggleSettingRow({
          title: "Line numbers",
          description: "Show line numbers in the gutter.",
          setting: layout.lineNumbers,
        }),
        toggleSettingRow({
          title: "Folding markers",
          description: "Show gutter icons for expanding and collapsing code blocks.",
          setting: layout.foldMarkers,
          onChange: (show) => {
            if (!show) deps.onFoldMarkersHidden();
          },
        }),
        ...(layout.indentGuides
          ? [
              toggleSettingRow({
                title: "Indentation guides",
                description: "Show a line at each level of indentation.",
                setting: layout.indentGuides,
              }),
            ]
          : []),
        fontSettingRow({
          setting: font,
          defaultValue: DEFAULT_CODE_FONT,
          builtIn: BUILT_IN,
          monospace: true,
          fonts,
          contextMenu: deps.contextMenu,
          resetLabel: "Reset code font to default",
        }),
      );
      const group = document.createElement("div");
      group.className = "settings-group";
      group.append(card);
      return group;
    },
  };
}
