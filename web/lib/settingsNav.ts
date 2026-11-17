// A Settings dialog's category list, the `.settings-nav` pragma's Settings
// and a site's both have: a click, Enter or Space shows an item's category,
// and ↑/↓ move focus through the items, stopping at either end.
import { cursorRing } from "./cursorRing.ts";

export interface SettingsNav {
  /** Marks `category`'s item as the one showing. */
  select(category: string): void;
  /** `category`'s item, where a dialog opening on it puts focus. */
  item(category: string): HTMLButtonElement | undefined;
}

/** Wires the `.settings-nav-item` buttons in `nav`, each naming its category
 * in `data-settings-category`. */
export function settingsNav(nav: HTMLElement, show: (category: string) => void): SettingsNav {
  const items = Array.from(nav.querySelectorAll<HTMLButtonElement>(".settings-nav-item"));
  const ring = cursorRing(nav, items);
  const categoryOf = (item: HTMLElement): string => item.dataset.settingsCategory ?? "";
  for (const item of items) {
    // Showing a category hides the ring, as Enter opening a file does in the
    // tree: the item's fill marks it then.
    item.addEventListener("click", () => {
      ring.hide();
      show(categoryOf(item));
    });
  }
  // A modified arrow is left to the app's shortcuts.
  nav.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = items.indexOf(event.target as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    ring.show();
    items[at + step]?.focus();
  });
  return {
    select(category) {
      for (const item of items) item.classList.toggle("active", categoryOf(item) === category);
    },
    item: (category) => items.find((item) => categoryOf(item) === category),
  };
}
