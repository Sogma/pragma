// A screenplay's own preferences, the font it is set in and its page zoom,
// and its page under Settings → Editor → Formats. The font lands on each
// screenplay editor as `data-screenplay-font`, which fountain.css beside this
// file keys the font and the line height off, together; an installed font's
// name rides with it as `--screenplay-font-family`.
//
// The zoom lands as `--screenplay-zoom`, which fountain.css sizes the page by.
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { fileTypeLabel } from "../../core/paths.ts";
import {
  createInstalledFonts,
  cssFamily,
  type FontChoice,
  fontSettingRow,
  type InstalledFonts,
} from "../../lib/fontPicker.ts";
import { zoomSettingRow } from "../../lib/zoomPicker.ts";
import type { FormatSettings } from "../../services/formats.ts";
import type { ContextMenuService } from "../../services/menus.ts";
import { createSetting, createZoomSetting, type Setting, type ZoomSetting } from "../../services/settings.ts";

// One of the built-in fonts' values, or an installed font's family name.
export type ScreenplayFont = string;
export const DEFAULT_SCREENPLAY_FONT: ScreenplayFont = "courier-prime";

const BUILT_IN: FontChoice[] = [
  {
    value: DEFAULT_SCREENPLAY_FONT,
    label: "Courier Prime",
    font: '"Courier Prime", var(--font-monospace)',
    monospaced: true,
  },
  {
    value: "courier-prime-sans",
    label: "Courier Prime Sans",
    font: '"Courier Prime Sans", var(--font-monospace)',
    monospaced: true,
  },
  { value: "system", label: "System monospace", font: "var(--font-monospace)", monospaced: true, standIn: true },
];

export function parseScreenplayFont(stored: string | null): ScreenplayFont {
  return stored?.trim() ? stored : DEFAULT_SCREENPLAY_FONT;
}

export const screenplayFont = createSetting("pragma:screenplay-font", parseScreenplayFont);

// One zoom for every screenplay, as a percentage of the printed page's size.
// Its own steps, 10 apart up to 150%, not the window zoom's: a larger page
// outgrows the editor of a 1600px window with both side panels open, and its
// lines rewrap.
export const SCREENPLAY_ZOOM_LEVELS: readonly number[] = [80, 90, 100, 110, 120, 130, 140, 150];
export const screenplayZoom = createZoomSetting("pragma:screenplay-zoom", SCREENPLAY_ZOOM_LEVELS);

/** Keeps every open screenplay editor wearing the font picked. */
export function screenplayFontAttribute(font: Setting<ScreenplayFont>): Extension {
  return ViewPlugin.define((view) => {
    const unsubscribe = font.subscribe((value) => {
      const builtIn = BUILT_IN.some((choice) => choice.value === value);
      view.dom.dataset.screenplayFont = builtIn ? value : "named";
      if (builtIn) view.dom.style.removeProperty("--screenplay-font-family");
      else view.dom.style.setProperty("--screenplay-font-family", cssFamily(value));
    });
    return {
      destroy() {
        unsubscribe();
        delete view.dom.dataset.screenplayFont;
        view.dom.style.removeProperty("--screenplay-font-family");
      },
    };
  });
}

/** Keeps every open screenplay editor at the page zoom picked. CodeMirror
 * doesn't notice its text changing size, so a change asks it to measure
 * again: lines it drew before would keep their old heights, and a click
 * would land lines away. */
export function screenplayZoomProperty(zoom: Setting<number>): Extension {
  return ViewPlugin.define((view) => {
    let applied = false;
    const unsubscribe = zoom.subscribe((percent) => {
      view.dom.style.setProperty("--screenplay-zoom", String(percent / 100));
      if (applied) view.requestMeasure();
      applied = true;
    });
    return {
      destroy() {
        unsubscribe();
        view.dom.style.removeProperty("--screenplay-zoom");
      },
    };
  });
}

export function screenplaySettings(
  font: Setting<ScreenplayFont>,
  zoom: ZoomSetting,
  contextMenu: ContextMenuService,
  fonts: InstalledFonts = createInstalledFonts(),
): FormatSettings {
  return {
    label: fileTypeLabel("fountain") ?? "",
    detail: "Fountain files (.fountain)",
    page() {
      const row = fontSettingRow({
        setting: font,
        defaultValue: DEFAULT_SCREENPLAY_FONT,
        builtIn: BUILT_IN,
        monospace: true,
        fonts,
        contextMenu,
        resetLabel: "Reset screenplay font to default",
      });
      const card = document.createElement("div");
      card.className = "settings-card";
      card.append(
        row,
        zoomSettingRow({
          title: "Page zoom",
          description: "Size of every screenplay's page, 12pt at 100%.",
          setting: zoom,
          contextMenu,
        }),
      );
      const group = document.createElement("div");
      group.className = "settings-group";
      group.append(card);
      return group;
    },
  };
}
