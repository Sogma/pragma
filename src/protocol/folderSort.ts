// A folder's order (docs/protocol.md, Folder order): the `sort` key of its
// `_properties.json`, else its `_structure.json`, else its names. A host
// shows a folder by the same choices, so one shape serves the rule a folder
// keeps, the sort one install shows it in, and the wire between them.

export type SortOrder = "asc" | "desc";

/** One way to list a folder. Any but manual can be a folder's `sort`;
 * manual is its `_structure.json`, followed while it has none. */
export type SortChoice =
  | { by: "manual" }
  | { by: "name" | "created" | "modified" | "size"; order: SortOrder }
  | { by: "property"; property: string; order: SortOrder };

export type SortKind = SortChoice["by"];

/** What a folder lists in when it keeps no order of its own. */
export const NAME_ORDER: SortChoice = { by: "name", order: "asc" };

/** A comparable frontmatter value: numbers and dates compare as numbers,
 * everything else as text. */
export type SortValue = number | string;

/** Any sort, manual included. An `order` other than "desc" is ascending; a
 * value no form matches is none. */
export function parseSortChoice(value: unknown): SortChoice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { by, order: raw, property } = value as Record<string, unknown>;
  const order: SortOrder = raw === "desc" ? "desc" : "asc";
  if (by === "manual") return { by };
  if (by === "name" || by === "created" || by === "modified" || by === "size") return { by, order };
  if (by === "property" && typeof property === "string" && property.trim()) {
    return { by, property: property.trim(), order };
  }
  return undefined;
}

/** A folder's own `sort`. Manual is never one, so a `sort` naming it is
 * ignored as if absent, as any other unknown value is. */
export function parseFolderSort(value: unknown): Exclude<SortChoice, { by: "manual" }> | undefined {
  const choice = parseSortChoice(value);
  return choice?.by === "manual" ? undefined : choice;
}

/** Whether two sorts read a folder the same way. Two manual orders are the
 * same choice; whether they arrange it alike is the listing's to say. */
export function sameSortChoice(a: SortChoice, b: SortChoice): boolean {
  if (a.by === "manual" || b.by === "manual") return a.by === b.by;
  if (a.by !== b.by || a.order !== b.order) return false;
  return a.by !== "property" || (b.by === "property" && a.property === b.property);
}

// A date, optionally with a time and zone. A bare year or a free-form date
// ("March 3") stays text: Date.parse accepts those too, but inconsistently
// across engines, and the order would differ between hosts.
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?)?$/;

function parseIsoDate(text: string): number | undefined {
  const match = ISO_DATE.exec(text);
  if (!match) return undefined;
  const [, date, time, zone] = match;
  // A time with no zone is read as UTC, not the host's local time, so every
  // host orders it the same way.
  const parsed = Date.parse(time ? `${date}T${time}${zone ?? "Z"}` : date);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Undefined means the entry has no usable value and sorts after every entry
 * that does: absent, empty, a list, or a map. */
export function toSortValue(raw: unknown): SortValue | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.getTime();
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  return parseIsoDate(text) ?? text;
}

const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Name order: folders first, then names in natural order ("take 2" before
 * "take 10"), ignoring case. Names equal but for case still order one way,
 * so a listing never takes the filesystem's order. */
export function compareEntryNames(
  a: { name: string; type: "file" | "directory" },
  b: { name: string; type: "file" | "directory" },
): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return NATURAL.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Numbers before text; text in natural order ("post 2" before "post 10"),
 * ignoring case. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Orders `nodes` (already in name order) by `sortValueOf`, descending when the
 * rule says so. Entries without a value keep their name order, after the
 * rest, in either direction; ties fall back to name order too. */
export function orderByProperty<T>(
  nodes: T[],
  sort: { order: SortOrder },
  sortValueOf: (node: T) => SortValue | undefined,
): T[] {
  const valued: { node: T; value: SortValue; index: number }[] = [];
  const unvalued: T[] = [];
  nodes.forEach((node, index) => {
    const value = sortValueOf(node);
    if (value === undefined) unvalued.push(node);
    else valued.push({ node, value, index });
  });
  const direction = sort.order === "desc" ? -1 : 1;
  valued.sort((a, b) => direction * compareSortValues(a.value, b.value) || a.index - b.index);
  return [...valued.map((entry) => entry.node), ...unvalued];
}
