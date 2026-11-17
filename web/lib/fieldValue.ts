// A Table or Class cell's value as content, for the modes that lock
// values: text that wraps rather than a disabled control clipped at its own
// width. Media is the caller's: its read-only field is already a display.
// A blank value draws nothing, so a locked grid never invents a default —
// a select's first option is Edit's to fill in.
import { type FieldValueType, normalizeHexColor } from "../../src/protocol/types.ts";
import { createColorChip } from "./colorChip.ts";
import { timestampLabel } from "./timestampField.ts";

export function createFieldValue(type: FieldValueType, value: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "data-table-value";

  if (type === "checkbox") {
    const checked = value === "true";
    const mark = document.createElement("span");
    mark.className = "data-table-value-check";
    mark.hidden = !checked;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", checked ? "Checked" : "Not checked");
    el.appendChild(mark);
    return el;
  }

  if (type === "color") {
    const hex = normalizeHexColor(value);
    if (hex) {
      el.appendChild(createColorChip(hex));
      return el;
    }
  }

  if (type === "timestamp") {
    const label = timestampLabel(value);
    el.textContent = label.text;
    el.dataset.tooltip = label.title;
    return el;
  }

  el.textContent = value.trim();
  return el;
}
