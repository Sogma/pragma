// A row's full card over its pane (docs/protocol.md's Table row cards
// section): the pane's overlay showing one row whole, its fields as tiles on
// the tile grid. The pane hands over its rows and each field's live control,
// so editing and saving stay the pane's; the card draws, steps and closes,
// and hands a new arrangement back for the pane to save.

import { cardTiles } from "../src/protocol/card.ts";
import type { CardTile, FieldValueType, TableColumn } from "../src/protocol/types.ts";
import { OPEN_IN_NEW_TAB } from "./core/paths.ts";
import { createCardDesignTools } from "./lib/cardDesignTools.ts";
import { type RowMenu, startLabelRename } from "./lib/dataGrid.ts";
import { fieldTypeIcon } from "./lib/fieldTypeIcon.ts";
import { type MoreOptionsButton, moreOptionsButton } from "./lib/moreOptionsButton.ts";
import { createPaneOverlay, swallowRest } from "./lib/paneOverlay.ts";
import { createTileGrid, FULL_ROW, type TileGrid, type TileSize } from "./lib/tileGrid.ts";
import type { ContextMenuService } from "./services/menus.ts";

/** The menu of the ⋮ along a card's foot, its argument naming the row's file
 * where the row is one. The card's backdrop covers the pane's own ⋮, so
 * what a card needs from that menu is registered here too. */
export const ROW_CARD_MENU = "rowCard.more";

export interface RowCardDeps {
  /** The pane's box, which the card lies over. */
  host: HTMLElement;
  /** The rows the arrows step through, in the order the pane shows them. */
  count(): number;
  /** The fields a tile can name, and the card the file arranges, if any. */
  fields(): readonly TableColumn[];
  card(): readonly CardTile[] | undefined;
  /** A field's control for the row at `index`: the pane's own, so an edit
   * saves as one in the grid does. */
  cell(field: TableColumn, index: number, options: { multiline: boolean }): HTMLElement;
  /** The row's name, heading its card. */
  title(index: number): string;
  /** What the rows belong to, for the facts along the card's foot. */
  source(): string;
  /** A row that is a file: its path, which the card opens in a new tab. */
  pathOf?(index: number): string | undefined;
  openBeside?(path: string): void;
  /** Whether the card may be arranged now: in Design mode alone, and never
   * in a file that can't be saved. */
  arrangeable(): boolean;
  /** The card arranged anew, for the pane to save. */
  arrange(tiles: CardTile[]): void;
  /** The card closed on the row at `index`, for the pane to show again. */
  closed(index: number): void;
  /** What the ⋮ offers for the row at `index` after the card's own items,
   * as the row's right-click does. */
  menuOf?(index: number): RowMenu;
  contextMenu: Pick<ContextMenuService, "open" | "close" | "isOpen">;
}

export interface RowCard {
  open(index: number): void;
  isOpen(): boolean;
  /** The index of the row shown, or undefined while closed. */
  shown(): number | undefined;
  /** The pane's rows changed order, and the shown row is at `index` now;
   * its controls stay as they are. */
  moved(index: number): void;
  /** Closes the card, and hands its row back to the pane unless told not
   * to, as when the pane is about to show something else. */
  close(refocus?: boolean): void;
  /** Draws the shown row again from the pane's rows, which were read again
   * or changed lock; closes the card if the row is gone. */
  refresh(): void;
  dispose(): void;
}

// A field's tile before anyone sizes it, by what it shows.
const DEFAULT_SIZES: Record<FieldValueType, TileSize> = {
  media: { columns: 3, rows: 3 },
  text: { columns: 3, rows: 1 },
  path: { columns: 3, rows: 1 },
  select: { columns: 2, rows: 1 },
  score: { columns: 2, rows: 1 },
  timestamp: { columns: 2, rows: 1 },
  integer: { columns: 1, rows: 1 },
  checkbox: { columns: 1, rows: 1 },
  color: { columns: 1, rows: 1 },
};

// A tile moves by its label, a heading by itself; a field never starts a
// move, so typing and picking in a tile stay what they were.
const HANDLES = {
  move: ".row-card-label, .row-card-heading",
  not: "input, textarea, select, button",
  keys: ".row-card-label, .row-card-heading",
};

const FIELDS = "input, select, textarea, button, [contenteditable='true']";

// The quiet look is the grid's, where the cell's own border draws the box;
// on a card each field stands alone, so it keeps its own.
function unquiet(control: HTMLElement): HTMLElement {
  for (const each of [control, ...control.querySelectorAll<HTMLElement>(".form-input-quiet")]) {
    each.classList.remove("form-input-quiet");
  }
  return control;
}

export function createRowCard(deps: RowCardDeps): RowCard {
  let grid: TileGrid | undefined;
  let more: MoreOptionsButton | undefined;
  // The tiles shown, by element, in the order arranged.
  let placed = new Map<HTMLElement, CardTile>();
  let last: number | undefined;
  // Design mode's Grid: the cell guides kept showing, from row to row.
  let guidesOn = false;

  const overlay = createPaneOverlay({
    host: deps.host,
    stem: "row-card",
    count: () => deps.count(),
    showable: (index) => index >= 0 && index < deps.count(),
    render,
    release() {
      grid?.dispose();
      grid = undefined;
      more?.dispose();
      more = undefined;
      placed = new Map();
    },
    shown(index) {
      last = index;
      deps.host.focus({ preventScroll: true });
    },
    refocus() {
      if (last !== undefined) deps.closed(last);
    },
  });
  // Beneath anything else the pane lays over itself, such as a picture's
  // preview opened from a field on the card.
  deps.host.prepend(overlay.element);

  function sizeOf(tile: CardTile): TileSize {
    if ("heading" in tile) return { columns: FULL_ROW, rows: 1 };
    const field = deps.fields().find((each) => each.id === tile.field);
    const fallback = DEFAULT_SIZES[field?.type ?? "text"];
    return { columns: tile.columns ?? fallback.columns, rows: tile.rows ?? fallback.rows };
  }

  function tileElement(tile: CardTile, index: number): HTMLElement {
    if ("heading" in tile) {
      const heading = document.createElement("div");
      heading.className = "row-card-heading";
      const text = document.createElement("span");
      text.className = "row-card-heading-text";
      text.textContent = tile.heading;
      heading.append(text);
      return heading;
    }
    const field = deps.fields().find((each) => each.id === tile.field);
    const element = document.createElement("div");
    element.className = "row-card-tile";
    if (!field) return element;
    const label = document.createElement("div");
    label.className = "row-card-label";
    const name = document.createElement("span");
    name.textContent = field.label;
    label.append(fieldTypeIcon(field.type), name);
    const value = document.createElement("div");
    value.className = "row-card-value";
    value.dataset.type = field.type;
    value.append(unquiet(deps.cell(field, index, { multiline: sizeOf(tile).rows > 1 })));
    element.append(label, value);
    return element;
  }

  function factsText(index: number): string {
    return `Row ${index + 1} of ${deps.count()} · ${deps.source()}`;
  }

  function arranged(): CardTile[] {
    return grid ? grid.tiles().flatMap((element) => placed.get(element) ?? []) : [];
  }

  // Designing writes the whole arrangement each time, as a move does.
  function addTile(tile: CardTile): HTMLElement | undefined {
    if (!grid) return undefined;
    const element = tileElement(tile, overlay.shownIndex() ?? last ?? 0);
    placed.set(element, tile);
    grid.add(element, sizeOf(tile));
    deps.arrange(arranged());
    element.scrollIntoView?.({ block: "nearest" });
    return element;
  }

  // Off the card only: the field stays in the Table or Class.
  function removeTile(element: HTMLElement): void {
    grid?.remove(element);
    placed.delete(element);
    deps.arrange(arranged());
  }

  function fieldsOffCard(): TableColumn[] {
    const on = new Set(arranged().flatMap((tile) => ("field" in tile ? [tile.field] : [])));
    return deps.fields().filter((field) => !on.has(field.id));
  }

  // Focus comes back to the heading once its box closes by key, so the
  // card's keys and the heading's own still work.
  function renameHeading(heading: HTMLElement): void {
    const text = heading.querySelector<HTMLElement>(":scope > .row-card-heading-text");
    if (!text || !deps.arrangeable()) return;
    startLabelRename(text, (next) => {
      placed.set(heading, { heading: next });
      deps.arrange(arranged());
    });
    heading.querySelector("input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        queueMicrotask(() => heading.isConnected && heading.focus({ preventScroll: true }));
      }
    });
  }

  // Design mode's tools, under the card's title.
  function designStrip(): HTMLElement {
    const strip = createCardDesignTools({
      addHeading() {
        const added = addTile({ heading: "Heading" });
        if (added) renameHeading(added);
      },
      offCard: () =>
        fieldsOffCard().map((each) => ({ label: each.label, add: () => void addTile({ field: each.id }) })),
      guides: {
        on: () => guidesOn,
        set(on) {
          guidesOn = on;
          grid?.setGuides(on);
        },
      },
      contextMenu: deps.contextMenu,
    });
    strip.classList.add("row-card-design");
    return strip;
  }

  function render(index: number): HTMLElement {
    const page = document.createElement("div");
    page.className = "row-card-page";
    page.classList.toggle("is-arrangeable", deps.arrangeable());

    const head = document.createElement("div");
    head.className = "row-card-head";
    const title = document.createElement("div");
    title.className = "row-card-title";
    title.textContent = deps.title(index);
    head.append(title);
    const path = deps.pathOf?.(index);
    const { openBeside } = deps;
    if (path && openBeside) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "icon-button row-card-open";
      open.setAttribute("aria-label", OPEN_IN_NEW_TAB);
      open.addEventListener("click", () => openBeside(path));
      head.append(open);
    }

    const tiles = cardTiles(deps.fields(), deps.card());
    const arrangeable = deps.arrangeable();
    grid = createTileGrid({
      prefix: "row-card",
      handles: HANDLES,
      arrangeable,
      removal: arrangeable ? { label: "Remove from card", onRemove: removeTile } : undefined,
      onMove(element, target, zone) {
        target.parentElement?.insertBefore(element, zone === "before" ? target : target.nextSibling);
        deps.arrange(arranged());
      },
      onResize(element, size) {
        const tile = placed.get(element);
        if (!tile || "heading" in tile) return;
        const resized: CardTile = { field: tile.field, columns: size.columns, rows: size.rows };
        placed.set(element, resized);
        // A field that gains or loses lines takes the control for it, for
        // the row shown now: the rows may have moved since it was drawn.
        if (sizeOf(tile).rows > 1 !== size.rows > 1) {
          const field = deps.fields().find((each) => each.id === tile.field);
          const value = element.querySelector<HTMLElement>(":scope > .row-card-value");
          const row = overlay.shownIndex() ?? index;
          if (field && value) value.replaceChildren(unquiet(deps.cell(field, row, { multiline: size.rows > 1 })));
        }
        deps.arrange(arranged());
      },
    });
    for (const tile of tiles) {
      const element = tileElement(tile, index);
      placed.set(element, tile);
      grid.add(element, sizeOf(tile));
    }
    grid.setGuides(arrangeable && guidesOn);
    // A heading renames from a double-click or Enter, in Design mode alone.
    grid.el.addEventListener("dblclick", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const heading = target?.closest<HTMLElement>(".row-card-heading");
      if (heading && !target?.closest("input, button")) renameHeading(heading);
    });
    grid.el.addEventListener("keydown", (event) => {
      const target = event.target;
      if (event.key !== "Enter" || !(target instanceof HTMLElement) || !target.matches(".row-card-heading")) return;
      event.preventDefault();
      renameHeading(target);
    });

    const facts = document.createElement("div");
    facts.className = "row-card-facts";
    const place = document.createElement("span");
    place.className = "row-card-facts-text";
    place.textContent = factsText(index);
    more = moreOptionsButton("row-card-more", (anchor) => {
      if (deps.contextMenu.isOpen(anchor)) {
        deps.contextMenu.close();
        return;
      }
      // The row shown now: a sort may have moved it since it was drawn.
      const row = deps.menuOf?.(overlay.shownIndex() ?? index);
      deps.contextMenu.open({
        menu: ROW_CARD_MENU,
        arg: row?.arg,
        itemsAfter: row?.items,
        anchor,
        align: "end",
        ariaLabel: "More options",
      });
    });
    facts.append(place, more.element);

    if (arrangeable) page.append(head, designStrip(), grid.el, facts);
    else page.append(head, grid.el, facts);
    if (tiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "row-card-empty";
      empty.textContent = arrangeable
        ? "Nothing on this card yet."
        : "Nothing on this card. Add fields in Design mode.";
      grid.el.after(empty);
    }
    return page;
  }

  // A click on the backdrop closes the card; the rest of its click run
  // presses nothing it uncovers.
  overlay.element.addEventListener("click", (event) => {
    if (event.target !== overlay.element || event.detail > 1) return;
    overlay.close();
    swallowRest();
  });

  // The pane's keys while the card shows, but never a field's: the arrows
  // step through the rows (Up and Down too, as rows run down a list), Page
  // Up and Down scroll the card, and Space closes it. Escape closes it
  // through the pane, as any overlay of it.
  const onKey = (event: KeyboardEvent) => {
    if (overlay.shownIndex() === undefined || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest(FIELDS)) return;
    const page = overlay.stage.querySelector<HTMLElement>(".row-card-page");
    const line = 40;
    const screen = Math.max(line, (page?.clientHeight ?? 0) - line);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") overlay.step(-1);
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") overlay.step(1);
    else if (event.key === " ") overlay.close();
    else if (event.key === "PageDown" && page) page.scrollTop += screen;
    else if (event.key === "PageUp" && page) page.scrollTop -= screen;
    else return;
    event.preventDefault();
  };
  deps.host.addEventListener("keydown", onKey);

  return {
    open: (index) => overlay.show(index),
    isOpen: () => overlay.shownIndex() !== undefined,
    shown: () => overlay.shownIndex(),
    moved(index) {
      overlay.moved(index);
      last = index;
      const place = overlay.stage.querySelector(".row-card-facts-text");
      if (place) place.textContent = factsText(index);
    },
    close: (refocus = true) => overlay.close(refocus),
    // A control is bound to the row it was drawn for and the lock it was
    // drawn under. A read replaces the rows and reading view changes the
    // lock, so a control left standing would edit a row no save writes, or
    // edit what is locked.
    refresh() {
      const index = overlay.shownIndex();
      if (index === undefined) return;
      if (index < deps.count()) overlay.show(index);
      else overlay.close(false);
    },
    dispose() {
      deps.host.removeEventListener("keydown", onKey);
      overlay.dispose();
    },
  };
}
