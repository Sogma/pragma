// A picker: a button naming the value picked, with a chevron, that opens a
// menu of the values under it, the one picked checked. Settings' dropdowns,
// the model pickers and the screenplay font are each one, drawn here so no
// two drift apart.
import type { ContextMenuService, MenuItem, MenuSlider } from "../services/menus.ts";
import { must } from "./dom.ts";

/** What a picker's menu holds, and what it says about itself. */
export interface PickerMenu {
  // The rows, or under a typed query the rows it matches.
  items(query: string): MenuItem[];
  // A search box atop the rows, with this placeholder: for a long list, or
  // one that takes a typed value.
  search?: string;
  ariaLabel: string;
  align?: "start" | "end";
  // Added to the menu, for a picker's own sizes and rows.
  className?: string;
  // What the menu says with no rows at all.
  empty?: string;
  // Pinned under the list.
  slider?: MenuSlider;
}

/** Opens `menu` under `button`, in place of any menu open, with `query`
 * already typed into its search box. */
export function openPickerMenu(
  contextMenu: ContextMenuService,
  button: HTMLElement,
  menu: PickerMenu,
  query = "",
): void {
  contextMenu.open({
    items: menu.items(""),
    search:
      menu.search === undefined ? undefined : { placeholder: menu.search, filter: (typed) => menu.items(typed), query },
    anchor: button,
    align: menu.align,
    ariaLabel: menu.ariaLabel,
    className: menu.className ? `picker-menu ${menu.className}` : "picker-menu",
    empty: menu.empty,
    slider: menu.slider,
    picker: true,
  });
}

/** Opens `menu` under `button`, or closes it when it is open there already. */
export function togglePickerMenu(contextMenu: ContextMenuService, button: HTMLElement, menu: PickerMenu): void {
  if (contextMenu.isOpen(button)) contextMenu.close();
  else openPickerMenu(contextMenu, button, menu);
}

function span(className: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  return element;
}

/** Gives `button` a picker's parts: the name and the chevron after it. */
function makePicker(button: HTMLButtonElement): void {
  button.type = "button";
  button.classList.add("picker");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  const chevron = span("picker-chevron");
  chevron.setAttribute("aria-hidden", "true");
  button.replaceChildren(span("picker-name"), chevron);
  // ↓ and ↑ open a closed picker's menu, on the value picked, as they open a
  // select's list. They open it through the button's own click, so a picker
  // opens one way whichever menu it shows.
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (button.getAttribute("aria-expanded") === "true") return;
    event.preventDefault();
    button.click();
  });
}

/** A picker button built in code, for a surface with no markup to find one in. */
export function createPickerButton(className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = className ? `picker ${className}` : "picker";
  makePicker(button);
  return button;
}

/** Writes `name` into a picker's name slot. */
export function setPickerName(button: HTMLElement, name: string): void {
  must<HTMLElement>(".picker-name", button).textContent = name;
}

/** A value a choice picker offers, and its name. */
export interface PickerChoice {
  value: string;
  label: string;
  // A muted hint after the label in the menu: why a choice won't do now.
  detail?: string;
}

export interface ChoicePicker {
  // The value named and checked; a pick changes it.
  readonly value: string;
  // Names `value` without running a pick: a change made elsewhere, or a
  // form being filled in.
  show(value: string): void;
}

export interface ChoicePickerOptions {
  // Its accessible name, ahead of the choice's: "Color scheme".
  role: string;
  contextMenu: ContextMenuService;
  // "end" for a picker at the end of its row, so the menu's right edge
  // meets the button's.
  align?: "start" | "end";
  // Runs on a pick, once the picker names it.
  pick(value: string): void;
}

/**
 * Makes `button` a picker over a fixed list. Every choice's name sits in one
 * cell, only the one picked shown, so the button is as wide as the longest
 * and a pick never resizes it, as a select's width works.
 */
export function wireChoicePicker(
  button: HTMLButtonElement,
  choices: PickerChoice[],
  options: ChoicePickerOptions,
): ChoicePicker {
  makePicker(button);
  const name = must<HTMLElement>(".picker-name", button);
  name.classList.add("picker-choices");
  const labels = choices.map((choice) => {
    const label = span("picker-choice");
    label.textContent = choice.label;
    return label;
  });
  name.replaceChildren(...labels);

  let value = "";
  const show = (next: string) => {
    value = next;
    const index = choices.findIndex((choice) => choice.value === next);
    for (const [at, label] of labels.entries()) label.classList.toggle("current", at === index);
    button.setAttribute("aria-label", `${options.role}: ${choices[index]?.label ?? next}`);
  };
  const items = () =>
    choices.map(
      (choice): MenuItem => ({
        label: choice.label,
        ...(choice.detail ? { detail: choice.detail } : {}),
        checked: () => choice.value === value,
        run: () => {
          show(choice.value);
          options.pick(choice.value);
        },
      }),
    );
  button.addEventListener("click", () => {
    togglePickerMenu(options.contextMenu, button, { items, ariaLabel: options.role, align: options.align });
  });
  show(choices[0]?.value ?? "");
  return {
    get value() {
      return value;
    },
    show,
  };
}
