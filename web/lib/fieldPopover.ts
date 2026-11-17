// The Add column / Add field form: a name, a type, and — only for `select` —
// a comma-separated options list, with submit held disabled until the name is
// filled and a select type has at least one option. The disabled button is
// the only validity feedback, on purpose: no separate message.
//
// A `timestamp` also gets the choice of filling new rows with the time they
// are added.
//
// The opener owns everything around the form — appending it, placing it
// beside its anchor, dismissing it on an outside click, and turning the
// submitted values into its own record — so this module knows nothing about
// Tables or Classes.
import { parseFieldValueType } from "../../src/protocol/types.ts";
import { fieldTypeIcon, setFieldTypeIcon } from "./fieldTypeIcon.ts";

export interface FieldPopoverSpec {
  // The popover's accessible name and the submit button's label.
  title: string;
  // The name field's placeholder and accessible name.
  nameLabel: string;
  typeLabel: string;
  types: ReadonlyArray<{ value: string; label: string }>;
  // Names offered as the name is typed, and whether a typed one may be
  // used; one that may not holds submit disabled, as an empty one does.
  suggestions?: readonly string[];
  acceptsName?: (name: string) => boolean;
  // `options` is present only for a `select` type, and then never empty;
  // `default` only for a `timestamp`.
  onSubmit: (values: FieldPopoverValues) => void;
  onCancel: () => void;
}

export interface FieldPopoverValues {
  label: string;
  type: string;
  options?: string[];
  default?: "now";
}

export interface FieldPopover {
  element: HTMLElement;
  focus(): void;
}

// A datalist is tied to its input by id, so each needs one of its own.
let datalistCount = 0;

export function createFieldPopover(spec: FieldPopoverSpec): FieldPopover {
  const popover = document.createElement("div");
  popover.className = "popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", spec.title);

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "form-input popover-input";
  labelInput.placeholder = spec.nameLabel;
  labelInput.setAttribute("aria-label", spec.nameLabel);
  const suggestions = document.createElement("datalist");
  if (spec.suggestions?.length) {
    suggestions.id = `field-popover-names-${++datalistCount}`;
    for (const name of spec.suggestions)
      suggestions.appendChild(Object.assign(document.createElement("option"), { value: name }));
    labelInput.setAttribute("list", suggestions.id);
  }

  const typeSelect = document.createElement("select");
  typeSelect.className = "form-input popover-input";
  typeSelect.setAttribute("aria-label", spec.typeLabel);
  for (const { value, label } of spec.types) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }
  const typeIcon = fieldTypeIcon(parseFieldValueType(typeSelect.value));
  const typeField = document.createElement("div");
  typeField.className = "popover-type-field";
  typeField.append(typeIcon, typeSelect);

  const optionsInput = document.createElement("input");
  optionsInput.type = "text";
  optionsInput.className = "form-input popover-input";
  optionsInput.placeholder = "Option 1, Option 2";
  optionsInput.setAttribute("aria-label", "Options, comma-separated");
  const optionsField = document.createElement("div");
  optionsField.className = "popover-field";
  optionsField.hidden = true;
  optionsField.append(optionsInput);

  // Ticked to start with: a column made a timestamp is most often a record
  // of when each row arrived.
  const nowInput = document.createElement("input");
  nowInput.type = "checkbox";
  nowInput.checked = true;
  const nowField = document.createElement("label");
  nowField.className = "popover-checkbox";
  nowField.hidden = true;
  nowField.append(nowInput, "Fill new rows with the time added");

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "action-button";
  submit.textContent = spec.title;

  // A `select` type with zero options is a dead-end empty dropdown, so
  // submitting is blocked until it has at least one.
  const syncValidity = (): void => {
    const hasOptions = typeSelect.value !== "select" || optionsInput.value.split(",").some((o) => o.trim());
    const name = labelInput.value.trim();
    submit.disabled = !name || !hasOptions || !(spec.acceptsName?.(name) ?? true);
  };
  labelInput.addEventListener("input", syncValidity);
  optionsInput.addEventListener("input", syncValidity);
  typeSelect.addEventListener("change", () => {
    setFieldTypeIcon(typeIcon, parseFieldValueType(typeSelect.value));
    optionsField.hidden = typeSelect.value !== "select";
    nowField.hidden = typeSelect.value !== "timestamp";
    syncValidity();
  });
  syncValidity();

  const commit = (): void => {
    if (submit.disabled) return;
    const type = typeSelect.value;
    const values: FieldPopoverValues = { label: labelInput.value.trim(), type };
    if (type === "select") {
      values.options = optionsInput.value
        .split(",")
        .map((option) => option.trim())
        .filter(Boolean);
    }
    if (type === "timestamp" && nowInput.checked) values.default = "now";
    spec.onSubmit(values);
  };
  submit.addEventListener("click", commit);
  labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      spec.onCancel();
    }
  });

  popover.append(labelInput, suggestions, typeField, optionsField, nowField, submit);
  return { element: popover, focus: () => labelInput.focus() };
}
