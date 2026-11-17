// docs/protocol.md's Libraries: the libraries a space declares, in
// `_libraries.json` at its root, each by the id its `lib:<id>/…` paths name
// and a label. A declaration names no folder: where a library sits is one
// host's state, so nothing that writes a space file can point a host at a
// folder. One reading of the file for the server's reader and its writer.
import { serializeEntryListFile } from "./entryListFile.ts";
import { isLibraryId } from "./rootedPath.ts";

export const LIBRARIES_FILENAME = "_libraries.json";

export interface LibraryDeclaration {
  id: string;
  label: string;
}

/** One library's change: declares it last, gives it a new label, or takes
 * it out. Declaring an id already declared changes nothing. */
export type LibraryChange = { add: LibraryDeclaration } | { relabel: string; label: string } | { remove: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const entriesOf = (file: unknown): unknown[] => (isRecord(file) && Array.isArray(file.libraries) ? file.libraries : []);

const idOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.id === "string" && isLibraryId(entry.id) ? entry.id : undefined;

/** Every library a parsed file declares, in file order, each id once. An
 * entry with no id a `lib:` path can name declares nothing, and stays in
 * the file; a label that is missing or blank reads as the id. */
export function libraryDeclarations(file: unknown): LibraryDeclaration[] {
  const declared: LibraryDeclaration[] = [];
  for (const entry of entriesOf(file)) {
    const id = idOf(entry);
    if (id === undefined || declared.some((held) => held.id === id)) continue;
    const label = isRecord(entry) && typeof entry.label === "string" ? entry.label.trim() : "";
    declared.push({ id, label: label || id });
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
    return withEntries(file, entries.some((entry) => idOf(entry) === id) ? [...entries] : [...entries, { id, label }]);
  }
  if ("remove" in change)
    return withEntries(
      file,
      entries.filter((entry) => idOf(entry) !== change.remove),
    );
  return withEntries(
    file,
    entries.map((entry) => (idOf(entry) === change.relabel ? { ...(entry as object), label: change.label } : entry)),
  );
}

/** `_libraries.json` as Pragma writes it: one line per library. */
export function serializeLibrariesFile(file: Record<string, unknown>): string {
  return serializeEntryListFile(file, "libraries");
}
