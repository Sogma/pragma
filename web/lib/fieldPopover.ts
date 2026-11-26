// The Add column / Add field form: a name, a type, and — only for `select` —
// a comma-separated options list, with submit held disabled until the name is
// filled and a select type has at least one option. The disabled button is
// the only validity feedback, on purpose: no separate message.
//
// A `timestamp` also gets the choice of filling new rows with the time they
// are added, and a `score` its max and whether a value can be rejected.
//
// The opener owns everything around the form — appending it, placing it
// beside its anchor, dismissing it on an outside click, and turning the
// submitted values into its own record — so this module knows nothing about
// Tables or Classes.
import { isScoreMax, parseFieldValueType, SCORE_MAX, SCORE_MAX_LIMIT } from "../../src/protocol/types.ts";
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
  // `default` only for a `timestamp`; `max` and `reject` only for a `score`,
  // `max` left out at its default.
  onSubmit: (values: FieldPopoverValues) => void;
  onCancel: () => void;
}

export interface FieldPopoverValues {
  label: string;
  type: string;
  options?: string[];
  default?: "now";
  max?: number;
  reject?: true;
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

  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.min = "1";
  maxInput.max = String(SCORE_MAX_LIMIT);
  maxInput.step = "1";
  maxInput.value = String(SCORE_MAX);
  maxInput.className = "form-input popover-input";
  const maxField = document.createElement("label");
  maxField.className = "popover-number";
  maxField.hidden = true;
  maxField.append("Max", maxInput);
  const rejectInput = document.createElement("input");
  rejectInput.type = "checkbox";
  const rejectField = document.createElement("label");
  rejectField.className = "popover-checkbox";
  rejectField.hidden = true;
  rejectField.append(rejectInput, "Can be rejected");

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "action-button";
  submit.textContent = spec.title;

  // A `select` type with zero options is a dead-end empty dropdown, so
  // submitting is blocked until it has at least one.
  const syncValidity = (): void => {
    const hasOptions = typeSelect.value !== "select" || optionsInput.value.split(",").some((o) => o.trim());
    const hasMax = typeSelect.value !== "score" || isScoreMax(Number(maxInput.value));
    const name = labelInput.value.trim();
    submit.disabled = !name || !hasOptions || !hasMax || !(spec.acceptsName?.(name) ?? true);
  };
  labelInput.addEventListener("input", syncValidity);
  optionsInput.addEventListener("input", syncValidity);
  maxInput.addEventListener("input", syncValidity);
  typeSelect.addEventListener("change", () => {
    setFieldTypeIcon(typeIcon, parseFieldValueType(typeSelect.value));
    optionsField.hidden = typeSelect.value !== "select";
    nowField.hidden = typeSelect.value !== "timestamp";
    maxField.hidden = typeSelect.value !== "score";
    rejectField.hidden = typeSelect.value !== "score";
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
    const max = Number(maxInput.value);
    if (type === "score" && max !== SCORE_MAX) values.max = max;
    if (type === "score" && rejectInput.checked) values.reject = true;
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

  popover.append(labelInput, suggestions, typeField, optionsField, nowField, maxField, rejectField, submit);
  return { element: popover, focus: () => labelInput.focus() };
}
