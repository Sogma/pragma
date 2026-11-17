// The space's bookmarks, in `.pragma/bookmarks.json`: the entries a person
// keeps at hand, carried with the space. Pragma's own state rather than a
// format another host reads, so it sits under a dot, where no path, listing
// or link reaches it. One reading of the file for the server's reader, its
// writer and the move that keeps a bookmark on its entry.

import { serializeEntryListFile } from "./entryListFile.ts";
import { entryNameKey } from "./entryName.ts";
import { isHiddenPath } from "./relativeReference.ts";
import { formatRootedPath, parseRootedPath } from "./rootedPath.ts";

export const BOOKMARKS_FOLDER = ".pragma";
export const BOOKMARKS_FILENAME = "bookmarks.json";

/** One bookmark's change: adds it last, takes it out, or moves it to just
 * before `before`, or last without one. */
export type BookmarkChange = { add: string } | { remove: string } | { move: string; before?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `input` as a bookmark holds it, the rooted path in its one spelling, or
 * undefined for anything a bookmark can't name: no path, a root itself, or
 * an entry under a dot. */
export function bookmarkPath(input: string): string | undefined {
  try {
    const rooted = parseRootedPath(input);
    return rooted.path === "" || isHiddenPath(rooted.path) ? undefined : formatRootedPath(rooted);
  } catch {
    return undefined;
  }
}

/** Whether two bookmarks name one entry, compared as entry names are. */
export function sameBookmark(a: string, b: string): boolean {
  return entryNameKey(a) === entryNameKey(b);
}

const pathOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.path === "string" ? bookmarkPath(entry.path) : undefined;

const entriesOf = (file: unknown): unknown[] => (isRecord(file) && Array.isArray(file.bookmarks) ? file.bookmarks : []);

/** Every bookmark a parsed file holds, in file order, each once. An entry
 * with no path a bookmark can name is no bookmark, and stays in the file. */
export function bookmarkPaths(file: unknown): string[] {
  const paths: string[] = [];
  for (const entry of entriesOf(file)) {
    const path = pathOf(entry);
    if (path !== undefined && !paths.some((held) => sameBookmark(held, path))) paths.push(path);
  }
  return paths;
}

// `file` holding `entries` in place of its own, every other key kept.
function withEntries(file: unknown, entries: unknown[]): Record<string, unknown> {
  return { ...(isRecord(file) ? file : {}), bookmarks: entries };
}

/** `file` with `change` applied. Every other key, in the file and in each
 * entry, is kept: a writer keeps what it doesn't read, as with `_tags.json`. */
export function withBookmarkChange(file: unknown, change: BookmarkChange): Record<string, unknown> {
  const entries = entriesOf(file);
  const names = (entry: unknown, path: string) => {
    const held = pathOf(entry);
    return held !== undefined && sameBookmark(held, path);
  };
  if ("add" in change) {
    return entries.some((entry) => names(entry, change.add))
      ? withEntries(file, [...entries])
      : withEntries(file, [...entries, { path: change.add }]);
  }
  if ("remove" in change)
    return withEntries(
      file,
      entries.filter((entry) => !names(entry, change.remove)),
    );

  const moved = entries.find((entry) => names(entry, change.move));
  if (moved === undefined || (change.before !== undefined && sameBookmark(change.before, change.move))) {
    return withEntries(file, [...entries]);
  }
  const rest = entries.filter((entry) => !names(entry, change.move));
  const before = change.before;
  const at = before === undefined ? -1 : rest.findIndex((entry) => names(entry, before));
  rest.splice(at === -1 ? rest.length : at, 0, moved);
  return withEntries(file, rest);
}

const isAtOrUnder = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);

/** After `from` moved to `to`: each bookmark on it or inside it follows, its
 * entry's other keys kept. Undefined when none did. */
export function bookmarksAfterMove(file: unknown, from: string, to: string): Record<string, unknown> | undefined {
  let changed = false;
  const entries = entriesOf(file).map((entry) => {
    const path = pathOf(entry);
    if (path === undefined || !isAtOrUnder(path, from)) return entry;
    changed = true;
    return { ...(entry as Record<string, unknown>), path: to + path.slice(from.length) };
  });
  return changed ? withEntries(file, entries) : undefined;
}

/** After `removed` was deleted: each bookmark on it or inside it goes.
 * Undefined when none did. */
export function bookmarksAfterDelete(file: unknown, removed: string): Record<string, unknown> | undefined {
  const entries = entriesOf(file);
  const kept = entries.filter((entry) => {
    const path = pathOf(entry);
    return path === undefined || !isAtOrUnder(path, removed);
  });
  return kept.length === entries.length ? undefined : withEntries(file, kept);
}

/** The file as Pragma writes it: one line per bookmark, so adding, moving or
 * removing one is a one-line diff. Any other key keeps its value. */
export function serializeBookmarksFile(file: Record<string, unknown>): string {
  return serializeEntryListFile(file, "bookmarks");
}
