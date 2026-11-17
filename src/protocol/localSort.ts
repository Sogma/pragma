// How one install shows a folder: its Sort by and its layout, kept with the
// space's layout and never in the space (docs/architecture.md's Moves and
// references). What a folder keeps for every reader is its own order
// (docs/protocol.md).
import { parseSortChoice, type SortChoice } from "./folderSort.ts";

/** How a gallery draws a folder's entries: tiles, or cards that carry each
 * entry's description. */
export type FolderLayout = "tiles" | "cards";

/** A folder's sort on this install. `sort` is absent while the folder shows
 * its own order; `arrangement` is the last one dragged here, entry names in
 * order, which Manual order brings back. `layout` is absent while the folder
 * shows tiles. */
export interface LocalSort {
  sort?: SortChoice;
  arrangement?: string[];
  layout?: "cards";
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Undefined for a value that keeps nothing. */
export function parseLocalSort(value: unknown): LocalSort | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sort = parseSortChoice(raw.sort);
  const arrangement = isStringList(raw.arrangement) ? raw.arrangement : undefined;
  const cards = raw.layout === "cards";
  if (!sort && !arrangement && !cards) return undefined;
  return { ...(sort ? { sort } : {}), ...(arrangement ? { arrangement } : {}), ...(cards ? { layout: "cards" } : {}) };
}
