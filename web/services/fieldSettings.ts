// The settings only some field types have, as a Table column's menu and a
// Class field's menu offer them, so the two never word one differently. One
// entry per type, so a type added without its settings fails to compile;
// each pane says how a change is saved.
import {
  type FieldValueType,
  isScoreMax,
  SCORE_MAX,
  SCORE_MAX_LIMIT,
  scoreMax,
  type TableColumn,
} from "../../src/protocol/types.ts";
import type { DialogService } from "./dialog.ts";
import type { MenuItem } from "./menus.ts";

export interface FieldSettingHooks {
  // Applies a change to the field as the file holds it, and saves it.
  change(edit: (field: TableColumn) => void): void;
  dialog: DialogService;
  // The settings a pane asks for in a dialog of its own. A pane leaves out
  // one it doesn't offer, and the menu leaves out its item.
  options?(): void;
  mediaFolder(): void;
}

// A max of 5 is left out of the file, as other defaults are.
function askScoreMax(field: TableColumn, hooks: FieldSettingHooks): void {
  void hooks.dialog
    .prompt({
      title: `${field.label} max`,
      message: `How many marks, from 1 to ${SCORE_MAX_LIMIT}. Values stay as written, and one above the max shows as text.`,
      label: "Max",
      value: String(scoreMax(field)),
      submitLabel: "Save",
      validate: (value) =>
        isScoreMax(Number(value.trim())) ? undefined : `Enter a whole number from 1 to ${SCORE_MAX_LIMIT}.`,
    })
    .then((value) => {
      if (value === null) return;
      const max = Number(value.trim());
      hooks.change((target) => {
        if (max === SCORE_MAX) delete target.max;
        else target.max = max;
      });
    });
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
  score: (field, hooks) => [
    { label: "Max…", run: () => askScoreMax(field, hooks) },
    toggle(
      "Can be rejected",
      field,
      hooks,
      (each) => each.reject === true,
      (each, on) => {
        if (on) each.reject = true;
        else delete each.reject;
      },
    ),
  ],
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
