// The settings only some field types have, as a Table column's menu and a
// Class field's menu offer them, so the two never word one differently. One
// entry per type, so a type added without its settings fails to compile;
// each pane says how a change is saved.
import type { FieldValueType, TableColumn } from "../../src/protocol/types.ts";
import type { MenuItem } from "./menus.ts";

export interface FieldSettingHooks {
  // Applies a change to the field as the file holds it, and saves it.
  change(edit: (field: TableColumn) => void): void;
  // The settings asked for in a dialog. A pane leaves out one it doesn't
  // offer, and the menu leaves out its item.
  options?(): void;
  mediaFolder(): void;
}

// A setting that is on or off, as a checked item.
function toggle(
  label: string,
  field: TableColumn,
  hooks: FieldSettingHooks,
  isOn: (field: TableColumn) => boolean,
  set: (field: TableColumn, on: boolean) => void,
): MenuItem {
  return { label, checked: () => isOn(field), run: () => hooks.change((target) => set(target, !isOn(target))) };
}

const none = (): MenuItem[] => [];

const SETTINGS: {
  readonly [Type in FieldValueType]: (field: TableColumn, hooks: FieldSettingHooks) => MenuItem[];
} = {
  checkbox: none,
  color: none,
  integer: none,
  media: (field, hooks) => [
    toggle(
      "Show name",
      field,
      hooks,
      (each) => each.showName === true,
      (each, on) => {
        if (on) each.showName = true;
        else delete each.showName;
      },
    ),
    { label: "Media folder…", run: () => hooks.mediaFolder() },
  ],
  path: none,
  select: (_field, hooks) => (hooks.options ? [{ label: "Options…", run: () => hooks.options?.() }] : []),
  text: none,
  timestamp: (field, hooks) => [
    toggle(
      "Fill new rows with the time added",
      field,
      hooks,
      (each) => each.default === "now",
      (each, on) => {
        if (on) each.default = "now";
        else delete each.default;
      },
    ),
  ],
};

/** The menu items for what only `field`'s type has. */
export function fieldSettingItems(field: TableColumn, hooks: FieldSettingHooks): MenuItem[] {
  return SETTINGS[field.type](field, hooks);
}
