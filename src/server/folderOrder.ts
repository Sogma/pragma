// A folder's entries in a sort's order (src/protocol/folderSort.ts): the
// folder's own, wherever it is listed, and one install's, wherever it is
// listed for a person (localSorts.ts).
import type { Stats } from "node:fs";
import path from "node:path";
import {
  compareEntryNames,
  NAME_ORDER,
  orderByProperty,
  parseFolderSort,
  type SortChoice,
  type SortValue,
  toSortValue,
} from "../protocol/folderSort.ts";
import { isMarkdownFile } from "../protocol/types.ts";
import { documentIndex } from "./documentIndex.ts";
import { namedEntryPath } from "./rootedFiles.ts";
import { applyStructure, readStructure } from "./structure.ts";

type Listed = { name: string; type: "file" | "directory" };

/** `entry`'s value for `property`, read where a property order reads it: a
 * Markdown document's own frontmatter, a folder's `index.md`'s. Anything
 * else has none. */
function entrySortValue(dir: string, entry: Listed, property: string): SortValue | undefined {
  const source =
    entry.type === "directory"
      ? namedEntryPath(path.join(dir, entry.name), "index.md")
      : isMarkdownFile(entry.name)
        ? path.join(dir, entry.name)
        : undefined;
  return source === undefined ? undefined : toSortValue(documentIndex().frontmatter(source)[property]);
}

// A filesystem that keeps no birth time reports zero; the last change is
// the nearest it has. A folder has no size of its own, so folders order
// among themselves by name.
function factOf(by: "created" | "modified" | "size", entry: Listed, stats: Stats | undefined): number {
  if (!stats) return 0;
  if (by === "created") return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  if (by === "modified") return stats.mtimeMs;
  return entry.type === "file" ? stats.size : 0;
}

/** `entries`, in name order, as `sort` lists them; a manual one follows
 * `arrangement`. Folders lead every sort but a manual or a property one,
 * which mix them with the documents. Ties keep name order. A property sort
 * hands back each entry with its value, so a client can tell whether a save
 * moved a document. `statsOf` is asked only by a date or size sort. */
export async function orderEntries<T extends Listed>(
  dir: string,
  entries: T[],
  sort: SortChoice,
  arrangement: string[],
  statsOf: (entry: T) => Promise<Stats | undefined>,
): Promise<(T & { sortValue?: SortValue })[]> {
  if (sort.by === "manual") return applyStructure(entries, arrangement);
  if (sort.by === "property") {
    const valued = entries.map((entry): T & { sortValue?: SortValue } => {
      const value = entrySortValue(dir, entry, sort.property);
      return value === undefined ? entry : { ...entry, sortValue: value };
    });
    return orderByProperty(valued, sort, (entry) => entry.sortValue);
  }
  const sign = sort.order === "desc" ? -1 : 1;
  const by = sort.by;
  const facts =
    by === "name"
      ? undefined
      : new Map(
          await Promise.all(entries.map(async (entry) => [entry, factOf(by, entry, await statsOf(entry))] as const)),
        );
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    if (!facts) return sign * compareEntryNames(a, b);
    return sign * ((facts.get(a) ?? 0) - (facts.get(b) ?? 0)) || compareEntryNames(a, b);
  });
}

/** `entries`, in name order, in the order `dir` keeps for itself, with that
 * order as a sort and the folder's `_structure.json`, followed or kept. */
export async function orderByFolder<T extends Listed>(
  dir: string,
  entries: T[],
  properties: Record<string, unknown>,
  statsOf: (entry: T) => Promise<Stats | undefined>,
): Promise<{ ordered: (T & { sortValue?: SortValue })[]; rule: SortChoice; manifest: string[] | null }> {
  const manifest = readStructure(dir);
  const rule: SortChoice = parseFolderSort(properties.sort) ?? (manifest ? { by: "manual" } : NAME_ORDER);
  const named = rule.by === "name" && rule.order === "asc";
  const ordered = named ? entries : await orderEntries(dir, entries, rule, manifest ?? [], statsOf);
  return { ordered, rule, manifest };
}
