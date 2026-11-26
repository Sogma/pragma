// The Layout popover a Table or a Class shows in its header in Design mode:
// a switch for how the rows are drawn, and under Cards the card each row
// shows, arranged on a grid four tiles across (docs/protocol.md's Table small
// cards section). The pane owns the file and its rows; the panel draws them,
// and hands each new layout and arrangement back for the pane to save.

import { type SmallCardTile, TABLE_LAYOUTS, type TableColumn, type TableLayout } from "../src/protocol/types.ts";
import { createCardDesignTools, designTool } from "./lib/cardDesignTools.ts";
import { startLabelRename } from "./lib/dataGrid.ts";
import {
  createArrangedTile,
  type PickedParts,
  type ResolvedTile,
  resolveSmallCard,
  SMALL_CARD_COLUMNS,
  smallCardFromParts,
} from "./lib/smallCard.ts";
import { createTileGrid, FULL_ROW, type TileGrid, type TileSize } from "./lib/tileGrid.ts";
import type { ContextMenuService } from "./services/menus.ts";

export interface LayoutPanelDeps {
  /** How the rows are drawn now, and a switch to another layout. */
  layout(): TableLayout;
  setLayout(layout: TableLayout): void;
  /** The fields a tile can name: every one of the file's, since the card is
   * one per file, whichever view it is designed from. */
  fields(): readonly TableColumn[];
  /** The parts rule's picks among them. */
  parts(): PickedParts;
  /** A Class row brings its own title. */
  ownTitle: boolean;
  /** The card as the file arranges it; absent until it is arranged. */
  card(): readonly SmallCardTile[] | undefined;
  /** The card arranged anew, for the pane to save. */
  arrange(tiles: SmallCardTile[]): void;
  /** The rows the card can show, by index, as the pane shows them. */
  count(): number;
  title(index: number): string;
  /** A tile's content for the row at `index`, locked: its picture, its title
   * or a field's value, the pane's own control. */
  content(tile: ResolvedTile, index: number): HTMLElement | undefined;
  contextMenu: Pick<ContextMenuService, "open" | "close" | "isOpen">;
}

export interface LayoutPanel {
  readonly element: HTMLElement;
  /** Draws again from the pane: its layout, fields, card and rows. */
  refresh(): void;
  dispose(): void;
}

// A press anywhere on a tile moves it, since its value is only shown; the
// tile's x is its own.
const HANDLES = { move: ".small-card-tile", not: "button, input", keys: ".data-cards-tile" };

export function createLayoutPanel(deps: LayoutPanelDeps): LayoutPanel {
  const element = document.createElement("div");
  element.className = "popover layout-panel";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "Layout");
  let grid: TileGrid | undefined;
  // The tiles shown, by element, in the order arranged.
  let placed = new Map<HTMLElement, SmallCardTile>();
  let row = 0;
  let guidesOn = false;

  function picked(): PickedParts {
    return deps.parts();
  }

  // The file's card, or until it is arranged the card the cards view
  // composes, so the first arrangement starts from what the rows show.
  function startingTiles(): SmallCardTile[] {
    const card = deps.card();
    if (card) return [...card];
    const { picture, title, badge } = picked();
    const lines = deps.fields().filter((field) => field !== picture && field !== title && field !== badge);
    return smallCardFromParts(
      { picture: picture?.id, title: title?.id, badge: badge?.id },
      lines.map((field) => field.id),
      deps.ownTitle,
    );
  }

  function resolved(tile: SmallCardTile): ResolvedTile | undefined {
    return resolveSmallCard(deps.fields(), [tile], picked())[0];
  }

  function sizeOf(tile: SmallCardTile): TileSize {
    if ("heading" in tile) return { columns: FULL_ROW, rows: 1 };
    return resolved(tile)?.size ?? { columns: SMALL_CARD_COLUMNS, rows: 1 };
  }

  function face(tile: SmallCardTile): HTMLElement {
    const shown = resolved(tile);
    const content = shown && !("heading" in tile) ? deps.content(shown, row) : undefined;
    return createArrangedTile(shown ? { ...shown, control: content } : { part: "line", size: sizeOf(tile) });
  }

  function tileElement(tile: SmallCardTile): HTMLElement {
    const element = document.createElement("div");
    element.className = "small-card-tile";
    element.classList.toggle("is-heading", "heading" in tile);
    element.append(face(tile));
    return element;
  }

  function arranged(): SmallCardTile[] {
    return grid ? grid.tiles().flatMap((each) => placed.get(each) ?? []) : [];
  }

  // Designing writes the whole arrangement each time, as a move does.
  function save(): void {
    deps.arrange(arranged());
  }

  function addTile(tile: SmallCardTile): HTMLElement | undefined {
    if (!grid) return undefined;
    const added = tileElement(tile);
    placed.set(added, tile);
    grid.add(added, sizeOf(tile));
    save();
    return added;
  }

  // Off the card only: the field stays in the file.
  function removeTile(tile: HTMLElement): void {
    grid?.remove(tile);
    placed.delete(tile);
    save();
  }

  // A Table's title column is the card's title, never a line of it.
  function offCard(): { label: string; add(): void }[] {
    const on = arranged();
    const { title } = picked();
    const titled = on.some((tile) => "title" in tile);
    const used = new Set(on.flatMap((tile) => ("field" in tile ? [tile.field] : [])));
    return [
      ...(!titled && (deps.ownTitle || title) ? [{ label: "Title", add: () => void addTile({ title: true }) }] : []),
      ...deps
        .fields()
        .filter((field) => field !== title && !used.has(field.id))
        .map((field) => ({ label: field.label, add: () => void addTile({ field: field.id }) })),
    ];
  }

  function renameHeading(tile: HTMLElement): void {
    const text = tile.querySelector<HTMLElement>(".data-cards-heading-text");
    if (!text) return;
    startLabelRename(text, (next) => {
      placed.set(tile, { heading: next });
      save();
    });
  }

  function layoutSwitch(): HTMLElement {
    const choices = document.createElement("div");
    choices.className = "design-tools";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Layout");
    for (const { id, label } of TABLE_LAYOUTS) {
      const choice = designTool(label);
      choice.setAttribute("aria-pressed", String(deps.layout() === id));
      choice.addEventListener("click", () => {
        if (deps.layout() === id) return;
        deps.setLayout(id);
        render();
      });
      choices.append(choice);
    }
    return choices;
  }

  function stepper(): HTMLElement {
    const step = document.createElement("div");
    step.className = "layout-panel-step";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "icon-button";
    back.setAttribute("aria-label", "Previous row");
    back.disabled = row === 0;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "icon-button layout-panel-next";
    next.setAttribute("aria-label", "Next row");
    next.disabled = row >= deps.count() - 1;
    const name = document.createElement("span");
    name.className = "layout-panel-step-name";
    name.textContent = deps.title(row);
    back.addEventListener("click", () => showRow(row - 1));
    next.addEventListener("click", () => showRow(row + 1));
    step.append(back, name, next);
    return step;
  }

  function showRow(index: number): void {
    row = Math.max(0, Math.min(index, deps.count() - 1));
    render();
  }

  function render(): void {
    grid?.dispose();
    grid = undefined;
    placed = new Map();
    element.replaceChildren(layoutSwitch());
    if (deps.layout() !== "cards") return;
    row = Math.max(0, Math.min(row, deps.count() - 1));
    const rule = document.createElement("hr");
    rule.className = "layout-panel-rule";
    grid = createTileGrid({
      prefix: "small-card",
      handles: HANDLES,
      columns: SMALL_CARD_COLUMNS,
      removal: { label: "Remove from card", onRemove: removeTile },
      onMove(tile, target, zone) {
        target.parentElement?.insertBefore(tile, zone === "before" ? target : target.nextSibling);
        save();
      },
      onResize(tile, size) {
        const was = placed.get(tile);
        if (!was || "heading" in was) return;
        const resized: SmallCardTile = { ...was, columns: size.columns, rows: size.rows };
        placed.set(tile, resized);
        tile.firstElementChild?.replaceWith(face(resized));
        save();
      },
    });
    for (const tile of startingTiles()) {
      if (!("heading" in tile) && !resolved(tile)) continue;
      const shown = tileElement(tile);
      placed.set(shown, tile);
      grid.add(shown, sizeOf(tile));
    }
    grid.setGuides(guidesOn);
    // A heading renames from a double-click or Enter.
    grid.el.addEventListener("dblclick", (event) => {
      const tile =
        event.target instanceof Element ? event.target.closest<HTMLElement>(".small-card-tile.is-heading") : null;
      if (tile) renameHeading(tile);
    });
    grid.el.addEventListener("keydown", (event) => {
      const tile =
        event.target instanceof Element ? event.target.closest<HTMLElement>(".small-card-tile.is-heading") : null;
      if (event.key !== "Enter" || !tile || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      renameHeading(tile);
    });
    const card = document.createElement("div");
    card.className = "layout-panel-card";
    card.append(grid.el);
    const tools = createCardDesignTools({
      addHeading() {
        const added = addTile({ heading: "Heading" });
        if (added) renameHeading(added);
      },
      offCard,
      guides: {
        on: () => guidesOn,
        set(on) {
          guidesOn = on;
          grid?.setGuides(on);
        },
      },
      contextMenu: deps.contextMenu,
    });
    element.append(rule, tools, card);
    if (deps.count() > 0) element.append(stepper());
    grid.layout();
  }

  render();
  return {
    element,
    refresh: render,
    dispose() {
      grid?.dispose();
      grid = undefined;
    },
  };
}
