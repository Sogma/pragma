// A registered space as a row: Manage Spaces' list and the desktop app's
// welcome window build theirs here, so the two can't drift apart on what a
// missing or an open space looks like.
import type { SpaceRef } from "../core/apiClient.ts";

export interface SpaceRowOptions {
  space: Pick<SpaceRef, "name" | "label" | "missing">;
  /** Under the name: the space's path, or the folder that holds it. */
  location: string;
  /** The space being served, marked and never opened again. */
  current: boolean;
  /** The row's ⋮, when it has actions. */
  menu?: HTMLButtonElement;
  open(): void;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

export function createSpaceRow({ space, location, current, menu, open }: SpaceRowOptions): HTMLElement {
  // A div, not a button: the row carries its own ⋮ trigger, and a button
  // inside a button is invalid markup. Activation is wired by hand below so
  // the keyboard still behaves like the listbox option this claims to be.
  const row = document.createElement("div");
  row.className = "list-item";
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(current));

  const text = span("list-item-text", "");
  text.append(
    span("list-item-title", space.label || space.name),
    span("caption list-item-subtitle", space.missing ? `${location} (folder not found)` : location),
  );
  row.append(text);
  if (menu) row.append(menu);

  // The open space and one whose folder is gone stay listed, so their ⋮
  // actions remain reachable: Locate is the only way back for a missing one.
  //
  // Deliberately not aria-disabled: that marks everything inside the row
  // disabled too, including the ⋮, which is exactly the control a missing
  // row exists to offer. `aria-selected` already says which space is open,
  // and a missing one says so in its subtitle.
  if (current) row.classList.add("active");
  if (space.missing) row.classList.add("is-missing");
  if (!current && !space.missing) {
    row.tabIndex = 0;
    row.addEventListener("click", () => open());
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }
  return row;
}
