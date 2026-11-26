import type { CardTile, SmallCardTile, TableColumn } from "./types.ts";

/** The tiles a row's card shows (docs/protocol.md's Table row cards section):
 * every field in order when the file arranges none, else the tiles it lists
 * that name one of its fields, with its headings. */
export function cardTiles(fields: readonly TableColumn[], card: readonly CardTile[] | undefined): CardTile[] {
  if (card === undefined) return fields.map((field) => ({ field: field.id }));
  const ids = new Set(fields.map((field) => field.id));
  return card.filter((tile) => "heading" in tile || ids.has(tile.field));
}

/** A field added to a file whose card is arranged joins the card at its end,
 * unless a tile already names it. A file with no card block keeps none, so
 * its card goes on showing every field. The same holds for the small card. */
export function cardWithField(card: readonly CardTile[] | undefined, field: string): CardTile[] | undefined;
export function cardWithField(card: readonly SmallCardTile[] | undefined, field: string): SmallCardTile[] | undefined;
export function cardWithField(card: readonly SmallCardTile[] | undefined, field: string): SmallCardTile[] | undefined {
  if (card === undefined) return undefined;
  return card.some((tile) => "field" in tile && tile.field === field) ? [...card] : [...card, { field }];
}

/** A field deleted from the file leaves its card too, so one added later
 * under the same key joins at the end rather than where the old one sat. */
export function cardWithoutField(card: readonly CardTile[] | undefined, field: string): CardTile[] | undefined;
export function cardWithoutField(
  card: readonly SmallCardTile[] | undefined,
  field: string,
): SmallCardTile[] | undefined;
export function cardWithoutField(
  card: readonly SmallCardTile[] | undefined,
  field: string,
): SmallCardTile[] | undefined {
  return card?.filter((tile) => !("field" in tile) || tile.field !== field);
}
