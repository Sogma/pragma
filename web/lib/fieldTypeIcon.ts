import { FIELD_VALUE_TYPE_OPTIONS, type FieldValueType, fieldPortType } from "../../src/protocol/types.ts";

// A Table column's or Class field's type as an icon: its glyph by field type,
// its colour by the port type the field becomes in a Flow, so the two places
// a value appears agree (web/styles/value-types.css).
export function fieldTypeIcon(type: FieldValueType): HTMLElement {
  const icon = document.createElement("span");
  icon.setAttribute("role", "img");
  setFieldTypeIcon(icon, type);
  return icon;
}

export function setFieldTypeIcon(icon: HTMLElement, type: FieldValueType): void {
  const label = FIELD_VALUE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
  icon.className = `type-icon type-${fieldPortType(type)}`;
  icon.dataset.fieldType = type;
  icon.dataset.tooltip = label;
  icon.setAttribute("aria-label", label);
}
