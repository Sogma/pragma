// The card a cards view draws once its file arranges it (docs/protocol.md's
// Table small cards section): tiles on a grid four across. The parts rule
// still picks the picture, the title and the badge; the tiles only place and
// size them.

import type { SmallCardTile, TableColumn } from "../../src/protocol/types.ts";
import { TILE_MAX_ROWS, type TileSize } from "./tileGrid.ts";

export const SMALL_CARD_COLUMNS = 4;
// A picture's rows where its tile names none: about a 16:9 frame at a card's
// least width.
const PICTURE_ROWS = 5;

export type SmallCardPart = "picture" | "title" | "badge" | "line" | "heading";

/** The fields the parts rule picked, by key. */
export interface SmallCardParts {
  picture?: string;
  badge?: string;
  // A Table's title column; a Class row brings its own title.
  title?: string;
}

export function smallCardPart(tile: SmallCardTile, parts: SmallCardParts): SmallCardPart {
  if ("heading" in tile) return "heading";
  if ("title" in tile) return "title";
  if (tile.field === parts.picture) return "picture";
  if (tile.field === parts.badge) return "badge";
  return "line";
}

/** Where a tile starts: a line of the card the cards view composes. */
export function smallCardStart(tile: SmallCardTile, parts: SmallCardParts): TileSize {
  const part = smallCardPart(tile, parts);
  if (part === "picture") return { columns: SMALL_CARD_COLUMNS, rows: PICTURE_ROWS };
  if (part === "badge") return { columns: 1, rows: 1 };
  if (part === "title" && parts.badge) return { columns: SMALL_CARD_COLUMNS - 1, rows: 1 };
  return { columns: SMALL_CARD_COLUMNS, rows: 1 };
}

/** A tile's span: its own, else where it starts, within the grid. */
export function smallCardSpan(tile: SmallCardTile, parts: SmallCardParts): TileSize {
  if ("heading" in tile) return { columns: SMALL_CARD_COLUMNS, rows: 1 };
  const start = smallCardStart(tile, parts);
  return {
    columns: Math.min(tile.columns ?? start.columns, SMALL_CARD_COLUMNS),
    rows: Math.min(tile.rows ?? start.rows, TILE_MAX_ROWS),
  };
}

/** The card the cards view composes, as tiles: what a designer starts
 * arranging from, so its first arrangement looks as the card did. */
export function smallCardFromParts(
  parts: SmallCardParts,
  lines: readonly string[],
  ownTitle: boolean,
): SmallCardTile[] {
  return [
    ...(parts.picture ? [{ field: parts.picture }] : []),
    ...(ownTitle || parts.title ? [{ title: true as const }] : []),
    ...(parts.badge ? [{ field: parts.badge }] : []),
    ...lines.map((field) => ({ field })),
  ];
}

/** The tiles a card shows: its headings, its title, and those naming one of
 * `fields`, the fields a Class's view shows or a Table's columns. */
export function smallCardTiles(fields: readonly TableColumn[], card: readonly SmallCardTile[]): SmallCardTile[] {
  const ids = new Set(fields.map((field) => field.id));
  return card.filter((tile) => !("field" in tile) || ids.has(tile.field));
}

/** A tile resolved once for every row: its part, its span, its label and the
 * field it shows. A Class row's own title is no field. */
export interface ResolvedTile {
  part: SmallCardPart;
  size: TileSize;
  label?: string;
  field?: TableColumn;
}

/** The parts rule's picks for `fields`, a Table's columns or the fields a
 * Class's view shows; a Class row brings its own title, so it has none. */
export interface PickedParts {
  picture?: TableColumn;
  title?: TableColumn;
  badge?: TableColumn;
}

/** An arranged card's tiles for `fields`. A blank value keeps its tile, so
 * every row's card keeps one shape. */
export function resolveSmallCard(
  fields: readonly TableColumn[],
  card: readonly SmallCardTile[],
  picked: PickedParts,
): ResolvedTile[] {
  const parts = { picture: picked.picture?.id, title: picked.title?.id, badge: picked.badge?.id };
  return smallCardTiles(fields, card).flatMap((tile): ResolvedTile[] => {
    const shared = { part: smallCardPart(tile, parts), size: smallCardSpan(tile, parts) };
    if ("heading" in tile) return [{ ...shared, label: tile.heading }];
    if ("title" in tile) return [{ ...shared, field: picked.title }];
    const field = fields.find((each) => each.id === tile.field);
    return field ? [{ ...shared, label: field.label, field }] : [];
  });
}

/** One tile, its content built: a line's label beside its value, a heading's
 * text, or the picture, the title or the badge alone. */
export interface ArrangedTile {
  part: SmallCardPart;
  size: TileSize;
  label?: string;
  control?: HTMLElement;
}

/** One tile as a card shows it, on a cards view and in Layout's designer. */
export function createArrangedTile(tile: ArrangedTile): HTMLElement {
  const el = document.createElement("div");
  el.style.setProperty("--tile-columns", String(tile.size.columns));
  el.style.setProperty("--tile-rows", String(tile.size.rows));
  if (tile.part === "line") {
    el.className = "data-cards-tile data-cards-field";
    const label = document.createElement("span");
    label.className = "data-cards-field-label";
    label.textContent = tile.label ?? "";
    const control = document.createElement("div");
    control.className = "data-cards-field-control";
    if (tile.control) control.appendChild(tile.control);
    el.append(label, control);
  } else if (tile.part === "heading") {
    el.className = "data-cards-tile data-cards-heading";
    const text = document.createElement("span");
    text.className = "data-cards-heading-text";
    text.textContent = tile.label ?? "";
    el.append(text);
  } else {
    el.className = `data-cards-tile data-cards-${tile.part}`;
    if (tile.control) el.appendChild(tile.control);
  }
  el.classList.toggle("is-tall", tile.size.rows > 1);
  return el;
}

/** An arranged card. Its open and remove buttons sit on its corners, as a
 * composed card's do, whatever tiles reach them. */
export function createArrangedCard(
  tiles: readonly ArrangedTile[],
  open?: HTMLElement,
  remove?: HTMLElement,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "card data-cards-card data-cards-arranged form-input-row";
  if (open) card.appendChild(open);
  const grid = document.createElement("div");
  grid.className = "data-cards-grid";
  grid.append(...tiles.map(createArrangedTile));
  card.appendChild(grid);
  if (remove) card.appendChild(remove);
  return card;
}
