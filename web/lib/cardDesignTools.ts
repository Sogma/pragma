// A card designer's tools, the same on every card a person arranges: a
// heading, something off the card back on it, and the cell guides kept
// showing. The designer owns the card; the tools only ask it.

import type { ContextMenuService } from "../services/menus.ts";

export interface CardDesignToolsDeps {
  addHeading(): void;
  // What is off the card, in the file's order, each with how to add it.
  offCard(): readonly { label: string; add(): void }[];
  guides: { on(): boolean; set(on: boolean): void };
  contextMenu: Pick<ContextMenuService, "open" | "close" | "isOpen">;
}

/** A small action button for a designer's row of tools. */
export function designTool(label: string): HTMLButtonElement {
  return Object.assign(document.createElement("button"), {
    type: "button",
    className: "action-button",
    textContent: label,
  });
}

export function createCardDesignTools(deps: CardDesignToolsDeps): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "design-tools";
  const heading = designTool("+ Heading");
  heading.addEventListener("click", () => deps.addHeading());
  const field = designTool("+ Field");
  field.setAttribute("aria-haspopup", "true");
  field.addEventListener("click", () => {
    if (deps.contextMenu.isOpen(field)) {
      deps.contextMenu.close();
      return;
    }
    deps.contextMenu.open({
      anchor: field,
      ariaLabel: "Fields off the card",
      empty: "Every field is on the card",
      items: deps.offCard().map((each) => ({ label: each.label, run: each.add })),
    });
  });
  const guides = designTool("Grid");
  guides.setAttribute("aria-pressed", String(deps.guides.on()));
  guides.addEventListener("click", () => {
    const on = !deps.guides.on();
    deps.guides.set(on);
    guides.setAttribute("aria-pressed", String(on));
  });
  strip.append(heading, field, guides);
  return strip;
}
