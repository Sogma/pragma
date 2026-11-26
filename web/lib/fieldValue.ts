// A Table or Class cell's value by its field's type: the editor that hands
// each edit back as text, and the value as content for the modes that lock
// values, text that wraps rather than a disabled control clipped at its own
// width. One entry per type, so a type added without its controls fails to
// compile.
import type { FieldDefinition, FieldValueType, TableColumn } from "../../src/protocol/types.ts";
import { normalizeHexColor } from "../../src/protocol/types.ts";
import { createColorChip, paintColorChip } from "./colorChip.ts";
import { createTimestampField, timestampLabel } from "./timestampField.ts";

/** The cell controls that live above `lib/`, which a pane hands in: a
 * media value's slot, a path value's, and the color picker's popover. */
export interface CellControls {
  media: (column: TableColumn, value: string, readOnly: boolean, onChange: (value: string) => void) => HTMLElement;
  path: (value: string, readOnly: boolean, onChange: (value: string) => void) => HTMLElement;
  pickColor: (anchor: HTMLElement, value: string, onPick: (hex: string) => void) => void;
}

export interface CellOptions {
  // When typed text is handed back: as each key lands, or once the field is
  // left, for a pane whose every hand-back is a write to another file.
  commit?: "input" | "change";
  // A select shows the value it holds as it is — blank for none, one not
  // among its options marked as such — rather than its first option, for a
  // pane that must not show a value the file doesn't hold.
  asHeld?: boolean;
  // Text wraps over several lines, as a tall tile of a row's card has room
  // for.
  multiline?: boolean;
}

interface CellContext {
  onChange: (value: string) => void;
  readOnly: boolean;
  controls: CellControls;
  options: CellOptions;
}

interface FieldControl {
  // Fills the locked value's element. A blank value shows none, so a locked
  // grid never invents a default: a select's first option is Edit's to fill
  // in.
  show(el: HTMLElement, field: FieldDefinition, value: string): void;
  cell(column: TableColumn, value: string, context: CellContext): HTMLElement;
}

function showText(el: HTMLElement, _field: FieldDefinition, value: string): void {
  el.textContent = value.trim();
}

// Its editor while values can be entered, its value as content otherwise.
function lockable(edit: FieldControl["cell"]): FieldControl["cell"] {
  return (column, value, context) =>
    context.readOnly ? createFieldValue(column, value) : edit(column, value, context);
}

function textInput(type: "text" | "number", value: string, context: CellContext): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  if (type === "number") input.step = "1";
  input.className = "form-input form-input-quiet data-table-cell-text";
  input.value = value;
  input.addEventListener(context.options.commit ?? "input", () => context.onChange(input.value));
  return input;
}

const FIELD_CONTROLS: { readonly [Type in FieldValueType]: FieldControl } = {
  checkbox: {
    show(el, _field, value) {
      const checked = value === "true";
      const mark = document.createElement("span");
      mark.className = "data-table-value-check";
      mark.hidden = !checked;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", checked ? "Checked" : "Not checked");
      el.appendChild(mark);
    },
    cell: lockable((_column, value, { onChange }) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "data-table-cell-checkbox";
      input.checked = value === "true";
      input.addEventListener("change", () => onChange(input.checked ? "true" : "false"));
      return input;
    }),
  },
  color: {
    show(el, field, value) {
      const hex = normalizeHexColor(value);
      if (hex) el.appendChild(createColorChip(hex));
      else showText(el, field, value);
    },
    // An unrecognized value shows as "None" but is kept until a color is
    // picked: the format's lenient-preserve rule.
    cell: lockable((_column, value, { onChange, controls }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "form-input form-input-quiet data-table-cell-color";
      let current = value;
      const chip = createColorChip(current);
      button.append(chip);
      button.addEventListener("click", () => {
        controls.pickColor(button, current, (hex) => {
          current = hex;
          paintColorChip(chip, hex);
          onChange(hex);
        });
      });
      return button;
    }),
  },
  integer: {
    show: showText,
    cell: lockable((_column, value, context) => textInput("number", value, context)),
  },
  // A media or path value is always its slot, which takes the lock itself.
  media: {
    show: showText,
    cell: (column, value, { onChange, readOnly, controls }) => controls.media(column, value, readOnly, onChange),
  },
  path: {
    show: showText,
    cell: (_column, value, { onChange, readOnly, controls }) => controls.path(value, readOnly, onChange),
  },
  select: {
    show: showText,
    cell: lockable((column, value, { onChange, options }) => {
      const select = document.createElement("select");
      select.className = "form-input form-input-quiet data-table-cell-select";
      const listed = column.options ?? [];
      if (options.asHeld && !listed.includes(value)) {
        const held = document.createElement("option");
        held.value = value;
        held.textContent = value ? `${value} · not an option` : "";
        select.appendChild(held);
      }
      for (const option of listed) {
        const optionEl = document.createElement("option");
        optionEl.value = option;
        optionEl.textContent = option;
        select.appendChild(optionEl);
      }
      select.value = value;
      select.addEventListener("change", () => onChange(select.value));
      return select;
    }),
  },
  text: {
    show: showText,
    cell: lockable((_column, value, context) => {
      if (!context.options.multiline) return textInput("text", value, context);
      const area = document.createElement("textarea");
      area.className = "form-input form-input-quiet data-table-cell-text";
      area.value = value;
      area.addEventListener(context.options.commit ?? "input", () => context.onChange(area.value));
      return area;
    }),
  },
  timestamp: {
    show(el, _field, value) {
      const label = timestampLabel(value);
      el.textContent = label.text;
      el.dataset.tooltip = label.title;
    },
    cell: lockable((_column, value, { onChange }) => createTimestampField({ value, onChange })),
  },
};

/** A value as content, for the modes that lock values. Media is the
 * caller's: its read-only field is already a display. */
export function createFieldValue(field: FieldDefinition, value: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "data-table-value";
  FIELD_CONTROLS[field.type].show(el, field, value);
  return el;
}

/** One cell, by its column's type: its editor, or the value as content
 * wherever values are locked. A media or path cell is always its slot,
 * which takes the lock itself. */
export function createCell(
  column: TableColumn,
  value: string,
  onChange: (value: string) => void,
  readOnly: boolean,
  controls: CellControls,
  options: CellOptions = {},
): HTMLElement {
  return FIELD_CONTROLS[column.type].cell(column, value, { onChange, readOnly, controls, options });
}
