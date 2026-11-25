import { nodeLabel } from "../../src/protocol/flowInputs.ts";
import {
  FLOW_NODE_REGISTRY,
  type FlowNodeConfigField,
  type FlowNodeInputWidget,
  intValue,
  stepInt,
} from "../../src/protocol/flowNodes.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { wireChoicePicker } from "../lib/picker.ts";
import type { ContextMenuService } from "../services/menus.ts";

// Shared plumbing for the canvas and App mode: the select-bearing controls,
// a select widget's picker, and the card's color. The plumbing behind every
// select-bearing control (a picker's dropdown, toggleText's affix picker):
// one `.nodrag` <select> with its change listener wired once.

// Applies (or clears) a node's color. The card carries it as --node-color
// plus .tinted, from which nodes.css draws the top edge and tints the body.
export function applyNodeColor(cardEl: HTMLElement, color: string | undefined): void {
  if (color) cardEl.style.setProperty("--node-color", color);
  else cardEl.style.removeProperty("--node-color");
  cardEl.classList.toggle("tinted", Boolean(color));
}

export function createSelectControl(
  currentValue: string,
  options: { value: string; label: string }[],
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "form-input nodrag";
  appendSelectOptions(select, options);
  select.value = currentValue;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function appendSelectOptions(select: HTMLSelectElement, options: { value: string; label: string }[]): void {
  for (const option of options) {
    const optionEl = document.createElement("option");
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    select.appendChild(optionEl);
  }
}

// A picker's dropdown over a live list: a folder's children, a table's rows.
// A stored pick the list no longer has stays selected as "<label> (missing)",
// never swapped for another option, which a run would then read without
// anyone having picked it. Only an empty store takes the first option,
// returned for the caller to save.
export function fillPickSelect(
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
  stored: string,
  storedLabel: string,
): string | undefined {
  const present = options.some((option) => option.value === stored);
  if (stored && !present) {
    const missing = new Option(`${storedLabel} (missing)`, stored);
    missing.disabled = true;
    select.add(missing);
  }
  appendSelectOptions(select, options);
  if (stored || present || options.length === 0) {
    select.value = stored;
    return undefined;
  }
  select.value = options[0].value;
  return options[0].value;
}

// A pin's name is snake_case, as a wire names it; a form and a control's
// accessible name are for the Flow's users, so they read it as words.
export function formLabel(label: string): string {
  return label.replaceAll("_", " ");
}

// Why a run left a node out, as its card says: the disabled node feeding it.
export function skippedText(graph: FlowGraph, disabledId: string): string {
  const disabled = graph.nodes.find((node) => node.id === disabledId);
  return `Skipped: ${disabled ? nodeLabel(disabled) : disabledId} is disabled`;
}

// Regenerate's tooltip on the card and in App mode: the input it moves on,
// for a type that finds its results by its inputs, or a held result's own.
export function regenerateHint(type: string): string {
  return `A new ${FLOW_NODE_REGISTRY[type]?.regenerate?.key ?? "result"}, run on this node's last inputs`;
}

// A select widget's or select field's control: the app's picker over its
// options. A stored value its options lack, from a hand edit or another
// editor, is kept and shown as it is, never swapped for an option: a run
// reads it, so the swap would change what runs unpicked.
//
// A widget's blank is an option of its own, "Default". A field's blank is
// its first option, as its node reads it. `detail` names a muted reason
// beside an option in the menu.
export function createSelectPicker(
  contextMenu: ContextMenuService,
  select: FlowNodeInputWidget | FlowNodeConfigField,
  stored: string,
  onPick: (value: string) => void,
  detail?: (value: string) => string | undefined,
): HTMLButtonElement {
  const options = select.options ?? [];
  const widget = "portId" in select;
  const shown = widget || stored ? stored : (options[0] ?? "");
  const values = options.includes(shown) ? options : [...options, shown];
  const button = document.createElement("button");
  button.className = "form-input flow-picker";
  const choices = values.map((value) => ({ value, label: value || "Default", detail: detail?.(value) }));
  const role = widget ? formLabel(select.portId) : select.label;
  wireChoicePicker(button, choices, { role, contextMenu, pick: onPick }).show(shown);
  return button;
}

/** A whole number written as text, as its field keeps it once a person is
 * done typing: digits past the largest a run reads are held to it, and a
 * box left blank or holding only "-" is 0. */
function wholeNumberText(typed: string): string {
  return /^-?\d+$/.test(typed) ? String(stepInt(Number(typed), 0)) : "0";
}

export interface IntStepper {
  el: HTMLElement;
  // Shows the field's value again, after something other than the box set it.
  show(): void;
}

/** An integer field's control: the number between arrows that step it by
 * one, as ↑ and ↓ do. Typing keeps digits and a leading minus; leaving the
 * box writes what it holds as a whole number. A stored value that isn't
 * one is shown as it is, and a step goes on from 0. */
export function createIntStepper(
  field: FlowNodeConfigField,
  stored: () => string,
  onChange: (value: string) => void,
): IntStepper {
  const el = document.createElement("div");
  el.className = "flow-int-stepper nodrag";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.className = "form-input";
  input.maxLength = String(Number.MIN_SAFE_INTEGER).length;
  input.setAttribute("role", "spinbutton");
  input.setAttribute("aria-label", field.label);

  function describe(text: string): void {
    const value = intValue(text);
    if (value === undefined) input.removeAttribute("aria-valuenow");
    else input.setAttribute("aria-valuenow", String(value));
  }

  function show(text: string): void {
    input.value = text || "0";
    describe(text);
  }

  function save(text: string): void {
    show(text);
    if (text !== stored()) onChange(text);
  }

  function step(by: number): void {
    save(String(stepInt(Number(wholeNumberText(input.value)), by)));
  }

  // Off the tab order, as a number box's own arrows are: ↑ and ↓ step it.
  function stepButton(by: number, label: string, part: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.className = `icon-button flow-int-stepper-step ${part}`;
    button.setAttribute("aria-label", label);
    const icon = document.createElement("span");
    icon.className = "flow-int-stepper-icon";
    button.appendChild(icon);
    button.addEventListener("click", () => step(by));
    return button;
  }

  // Saved as typed, a lone "-" too, so a run never reads a value the box no
  // longer shows; leaving the box makes it a whole number.
  input.addEventListener("input", () => {
    const typed = input.value;
    const kept = (typed.startsWith("-") ? "-" : "") + typed.replace(/\D/g, "");
    if (kept !== typed) {
      const caret = Math.max(0, (input.selectionStart ?? kept.length) - (typed.length - kept.length));
      input.value = kept;
      input.setSelectionRange(caret, caret);
    }
    describe(kept);
    if (kept !== stored()) onChange(kept);
  });
  input.addEventListener("change", () => save(wholeNumberText(input.value)));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    step(event.key === "ArrowUp" ? 1 : -1);
  });

  show(stored());
  el.append(
    stepButton(-1, "Subtract 1", "flow-int-stepper-less"),
    input,
    stepButton(1, "Add 1", "flow-int-stepper-more"),
  );
  return { el, show: () => show(stored()) };
}
