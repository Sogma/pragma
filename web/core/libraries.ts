// Each of the space's libraries' names and what this computer lets pragma do
// inside it, on the client's side of the wire. The server is the enforcement point;
// this only keeps the interface from offering an edit that would be refused,
// so an unknown library reads as read-only, never optimistically writable.
// Loaded once and lazily — its first users already await something.
import { isLibraryRoot, type PathRoot } from "../../src/protocol/rootedPath.ts";
import { fetchLibraries, type LibraryRow } from "./apiClient.ts";

const writable = new Set<string>();
let names = new Map<string, string>();
const renameListeners = new Set<() => void>();
let loading: Promise<void> | undefined;

/** Records what a fresh listing says. Called with every one the app fetches,
 * so changing a library's access or label takes effect without a reload. */
export function setLibraryPermissions(rows: readonly LibraryRow[]): void {
  writable.clear();
  for (const row of rows) if (row.access === "read-write") writable.add(row.id);
  const next = new Map(rows.map((row) => [row.id, row.label]));
  const renamed = next.size !== names.size || [...next].some(([id, name]) => names.get(id) !== name);
  names = next;
  if (renamed) for (const listener of renameListeners) listener();
}

/** Every library's id the space declares, once they have been read. */
export function libraryIds(): string[] {
  return [...names.keys()];
}

/** A library's display name, once its entry has been read. */
export function libraryName(id: string): string | undefined {
  return names.get(id);
}

/** Calls `listener` whenever a listing changes what a library is called, the
 * first read included, so whatever shows a name can draw it again. A listing
 * that changes no name calls nothing, so a re-list redraws nothing. */
export function onLibraryNames(listener: () => void): () => void {
  renameListeners.add(listener);
  return () => renameListeners.delete(listener);
}

/** Resolves once the libraries have been read at least once. The promise is
 * cached, not the request: a caller that awaits this on every tab open must
 * not spend a request on every tab open. A failure is not cached — nothing
 * is writable until a listing actually arrives, and the next caller retries
 * rather than inheriting one bad response forever. */
export function ensureLibraryPermissions(): Promise<void> {
  loading ??= fetchLibraries()
    .then((answer) => setLibraryPermissions(answer.libraries))
    .catch(() => {
      loading = undefined;
    });
  return loading;
}

/** Whether pragma may write into the root a path names: the space always, a
 * library once its entry says so and that entry has been read. */
export function isWritableRoot(root: PathRoot): boolean {
  return !isLibraryRoot(root) || writable.has(root.library);
}
