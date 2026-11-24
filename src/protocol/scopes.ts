// A `pragma` key in a folder's AGENTS.md opens a scope over that folder's
// tree, the folder itself included. Every rule about scopes is a function
// here: a host hands one the folders its scopes open over, and never
// restates it.
import { entryNameKey } from "./entryName.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
  type RootedPath,
  sameRoot,
} from "./rootedPath.ts";

/** Whether the document at `path` opens a scope: an `AGENTS.md`, its name in
 * any case, whose frontmatter holds a `pragma` key. The key's presence is
 * what counts, so a bare `pragma:` opens one with no directives.
 * `frontmatter` is read only for an AGENTS.md, since the key means nothing
 * in any other document. */
export function opensScope(path: string, frontmatter: () => Record<string, unknown>): boolean {
  return isAgentsFile(path) && Object.hasOwn(frontmatter(), "pragma");
}

/** Whether `path` names a folder's AGENTS.md, its name in any case. */
export function isAgentsFile(path: string): boolean {
  return entryNameKey(basenameOf(path)) === "agents.md";
}

/** Whether `path` names a folder's README, its name in any case. */
export function isReadme(path: string): boolean {
  return entryNameKey(basenameOf(path)) === "readme.md";
}

/** Which folders open a scope in one root, asked one folder at a time: a
 * listing's set answers, or a host that reads that folder's AGENTS.md. */
export interface ScopeFolders {
  has(folder: string): boolean;
}

/** The scope the entry at `path` sits in, given the folders scopes open over
 * in its root: the deepest one at or above it, a scope's own folder being in
 * it, and "" for the root's own scope when none is. */
export function scopeOf(scopes: ScopeFolders, path: string): string {
  for (let current = path; current !== ""; current = dirnameOf(current)) {
    if (scopes.has(current)) return current;
  }
  return "";
}

/** The scope the entry at the rooted path `rooted` sits in, as that scope's
 * folder's rooted path: in the space, the deepest one at or above it, "" for
 * the space's own; anywhere in a library, the library's top, a library being
 * one scope. `scopes` are the folders scopes open over in the space. */
export function rootedScopeOf(scopes: ScopeFolders, rooted: string): string {
  const { root, path } = parseRootedPath(rooted);
  return formatRootedPath({ root, path: isLibraryRoot(root) ? "" : scopeOf(scopes, path) });
}

/** Whether two entries sit in one scope, so a path between them is written
 * relative: the same root, and always within a library, a library being one
 * scope. `scopes` are the folders scopes open over in the space. */
export function sameScope(scopes: ScopeFolders, a: RootedPath, b: RootedPath): boolean {
  if (!sameRoot(a.root, b.root)) return false;
  return isLibraryRoot(a.root) || scopeOf(scopes, a.path) === scopeOf(scopes, b.path);
}
