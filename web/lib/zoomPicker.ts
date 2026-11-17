// A zoom picked from its setting's steps, wherever one is: the window's and a
// screenplay's page zoom, each as a Settings row, and a screenplay's and a
// PDF's as the ⋮ menu's Zoom, its name and its steps alike everywhere.
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import type { ZoomSetting } from "../services/settings.ts";
import { wireChoicePicker } from "./picker.ts";

function zoomLabel(percent: number): string {
  return `${percent}%`;
}

export interface ZoomRow {
  title: string;
  description: string;
  setting: ZoomSetting;
  contextMenu: ContextMenuService;
}

/** A Settings row: its name and what it does, and a picker for `setting`. */
export function zoomSettingRow(options: ZoomRow): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "field-row-title";
  title.textContent = options.title;
  const description = document.createElement("div");
  description.className = "field-row-description";
  description.textContent = options.description;
  const text = document.createElement("div");
  text.className = "field-row-text";
  text.append(title, description);
  const button = document.createElement("button");
  button.className = "form-input settings-select";
  const choices = options.setting.levels.map((percent) => ({ value: String(percent), label: zoomLabel(percent) }));
  const picker = wireChoicePicker(button, choices, {
    role: options.title,
    contextMenu: options.contextMenu,
    align: "end",
    pick: (value) => options.setting.set(Number(value)),
  });
  options.setting.subscribe((percent) => picker.show(String(percent)));
  const row = document.createElement("div");
  row.className = "field-row";
  row.append(text, button);
  return row;
}

/** The ⋮ menu's Zoom, wherever a format or a pane offers one: `rows` are its
 * steps, after any rows of the surface's own, built per open where they
 * depend on the pane. */
export function zoomMenu(rows: NonNullable<MenuItem["submenu"]>): MenuItem {
  return { label: "Zoom", submenu: rows };
}

/** The steps as a menu's rows, the one `setting` holds checked. */
export function zoomMenuItems(setting: Pick<ZoomSetting, "levels" | "get" | "set">): MenuItem[] {
  return setting.levels.map((percent) => ({
    label: zoomLabel(percent),
    checked: () => setting.get() === percent,
    run: () => setting.set(percent),
  }));
}
