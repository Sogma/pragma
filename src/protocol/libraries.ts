// docs/protocol.md's Libraries: the libraries a space declares, in
// `_libraries.json` at its root, each by the id its `lib:<id>/…` paths name,
// a label and an optional description. A declaration names no folder: where
// a library sits is one host's state, so nothing that writes a space file can
// point a host at a folder. One reading for the server's reader and writer.
import { serializeEntryListFile } from "./entryListFile.ts";
import { isLibraryId } from "./rootedPath.ts";

export const LIBRARIES_FILENAME = "_libraries.json";

export interface LibraryDeclaration {
  id: string;
  label: string;
  description?: string;
}

/** One library's change: declares it last, gives it a new label or
 * description, or takes it out. Declaring an id already declared changes
 * nothing, and a blank description takes the key out of the entry. */
export type LibraryChange =
  | { add: LibraryDeclaration }
  | { relabel: string; label: string }
  | { describe: string; description: string }
  | { remove: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const entriesOf = (file: unknown): unknown[] => (isRecord(file) && Array.isArray(file.libraries) ? file.libraries : []);

const idOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.id === "string" && isLibraryId(entry.id) ? entry.id : undefined;

const textOf = (entry: unknown, key: string): string =>
  isRecord(entry) && typeof entry[key] === "string" ? entry[key].trim() : "";

/** Every library a parsed file declares, in file order, each id once. An
 * entry with no id a `lib:` path can name declares nothing, and stays in
 * the file; a label that is missing or blank reads as the id, and a blank
 * description as none. */
export function libraryDeclarations(file: unknown): LibraryDeclaration[] {
  const declared: LibraryDeclaration[] = [];
  for (const entry of entriesOf(file)) {
    const id = idOf(entry);
    if (id === undefined || declared.some((held) => held.id === id)) continue;
    const description = textOf(entry, "description");
    declared.push({ id, label: textOf(entry, "label") || id, ...(description ? { description } : {}) });
  }
  return declared;
}

// `file` holding `entries` in place of its own, every other key kept.
function withEntries(file: unknown, entries: unknown[]): Record<string, unknown> {
  return { ...(isRecord(file) ? file : {}), libraries: entries };
}

/** `file` with `change` applied. Every other key, in the file and in each
 * entry, is kept: a writer keeps what it doesn't read, as with `_tags.json`. */
export function withLibraryChange(file: unknown, change: LibraryChange): Record<string, unknown> {
  const entries = entriesOf(file);
  if ("add" in change) {
    const { id, label } = change.add;
    const description = change.add.description?.trim();
    const added = { id, label, ...(description ? { description } : {}) };
    return withEntries(file, entries.some((entry) => idOf(entry) === id) ? [...entries] : [...entries, added]);
  }
  if ("remove" in change)
    return withEntries(
      file,
      entries.filter((entry) => idOf(entry) !== change.remove),
    );
  if ("describe" in change) {
    const description = change.description.trim();
    return withEntries(
      file,
      entries.map((entry) => {
        if (idOf(entry) !== change.describe) return entry;
        if (description) return { ...(entry as object), description };
        const { description: _old, ...rest } = entry as Record<string, unknown>;
        return rest;
      }),
    );
  }
  return withEntries(
    file,
    entries.map((entry) => (idOf(entry) === change.relabel ? { ...(entry as object), label: change.label } : entry)),
  );
}

/** `_libraries.json` as Pragma writes it: one line per library. */
export function serializeLibrariesFile(file: Record<string, unknown>): string {
  return serializeEntryListFile(file, "libraries");
}
