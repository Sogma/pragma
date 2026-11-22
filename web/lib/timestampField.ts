// A timestamp cell, shared so a Table's and a Class's can't drift: the instant
// as its viewer's local date and time, on a button that opens a picker, and
// stored as the canonical UTC form. Text, not the browser's own date control,
// because that control won't narrow to a card. A value that isn't a
// timestamp shows as the text it is and stays on disk until a time is picked.
import { formatTimestamp, parseTimestamp } from "../../src/protocol/types.ts";
import { dateTimeLabel } from "./dateText.ts";
import { positionPopover } from "./flyout.ts";

export interface TimestampFieldSpec {
  value: string;
  onChange: (value: string) => void;
}

// A `datetime-local` control takes and gives wall time with no zone, which
// the browser reads back as local time.
function localInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// What a value reads as, edited or not: the instant in local time, or the
// text it is with a title saying why. Blank reads as "".
export function timestampLabel(value: string): { text: string; title: string } {
  const instant = parseTimestamp(value);
  if (instant) return { text: dateTimeLabel(instant), title: "" };
  const text = value.trim();
  return { text, title: text ? "Not a time Pragma can read, kept as written" : "" };
}

export function createTimestampField(spec: TimestampFieldSpec): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "form-input form-input-quiet data-table-cell-timestamp";
  let value = spec.value;
  const sync = (): void => {
    const label = timestampLabel(value);
    button.textContent = label.text || "None";
    button.classList.toggle("is-empty", !label.text);
    button.dataset.tooltip = label.title;
  };
  sync();
  button.addEventListener("click", () =>
    openTimestampPicker(button, value, (next) => {
      value = next;
      sync();
      spec.onChange(next);
    }),
  );
  return button;
}

// Only ever one open at a time, as with the color and date pickers.
let teardown: (() => void) | null = null;

export function closeTimestampPicker(): void {
  teardown?.();
}

// The browser's date-and-time control, with Now and Clear. A change applies
// at once and leaves the picker open, since a date and its time are set one
// part after the other; Now and Clear apply and close.
function openTimestampPicker(anchor: HTMLElement, value: string, onPick: (value: string) => void): void {
  closeTimestampPicker();

  const popover = document.createElement("div");
  popover.className = "popover timestamp-picker";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Choose a time");

  const input = document.createElement("input");
  input.type = "datetime-local";
  input.step = "1";
  input.className = "form-input popover-input";
  const instant = parseTimestamp(value);
  if (instant) input.value = localInputValue(instant);
  // `change`, not `input`: the control reports "" while a part is half
  // typed, which would blank the stored value mid-edit.
  input.addEventListener("change", () => {
    const picked = new Date(input.value);
    if (input.value && !Number.isNaN(picked.getTime())) onPick(formatTimestamp(picked));
  });

  const action = (label: string, next: () => string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button";
    button.textContent = label;
    button.addEventListener("click", () => {
      onPick(next());
      closeTimestampPicker();
    });
    return button;
  };
  const actions = document.createElement("div");
  actions.className = "timestamp-picker-actions";
  actions.append(
    action("Now", () => formatTimestamp(new Date())),
    action("Clear", () => ""),
  );

  popover.append(input, actions);
  popover.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeTimestampPicker();
  });
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  input.focus();

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (!popover.contains(target) && !anchor.contains(target)) closeTimestampPicker();
  };
  const onResize = (): void => closeTimestampPicker();
  // Deferred so the same click that opened the picker doesn't close it.
  const armPointer = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
  window.addEventListener("resize", onResize);

  teardown = () => {
    window.clearTimeout(armPointer);
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", onResize);
    const restore = popover.contains(document.activeElement);
    popover.remove();
    if (restore) anchor.focus();
    teardown = null;
  };
}
