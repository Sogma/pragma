// Turning a rooted path (src/protocol/rootedPath.ts) into a real file on
// disk, and refusing the ones that aren't allowed. The one write doorway
// (docs/architecture.md's Document writes and reference integrity): a write refuses
// here rather than at whichever surface asked, so a UI affordance that
// forgets to hide an action still can't perform it.
import { type Dirent, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { entryNameKey, illegalEntryNameReason } from "../protocol/entryName.ts";
import { type FolderNames, matchEntries } from "../protocol/pathIndex.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
  type RootedPath,
} from "../protocol/rootedPath.ts";
import { hiddenBelow, linkBelow, namedEntryPath } from "./entryOnDisk.ts";
import { readLibraries } from "./libraries.ts";
import { recordWrite } from "./writtenPaths.ts";

/** The error a read of something that isn't there raises, for a path that
 * names nothing a caller may see, so it reads exactly as a missing file. */
export function absent(filePath: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
    code: "ENOENT",
    syscall: "open",
    path: filePath,
  });
}

export { linkBelow, namedEntryPath };

/** A refusal with the status it should become. Same shape and reasoning as
 * sandbox.ts's SandboxRequestError: the layer that knows *why* access was
 * refused is the layer that knows which status says so, and a route that
 * flattens every failure to 500 can't tell a caller whether to fix the path,
 * the library, or the request. */
export class PathAccessError extends Error {
  readonly status: 400 | 403 | 404;

  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "PathAccessError";
    this.status = status;
  }
}

/** Whether a `path.relative` result points outside the root it was measured
 * from. The exact `..` prefix matters: a bare `startsWith("..")` also rejects
 * a legitimate entry named `..drafts` sitting at the root.
 *
 * Callers that break or report instead of throwing use this directly; the
 * rest go through the throwing resolver below. Both compare strings only —
 * the link check below is what looks at the disk. */
export function escapesRoot(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** The containment check, in one place: the space, static-file and library
 * resolvers all delegate here, because a separate copy is where an escape
 * bug eventually lands. The root itself resolves fine — callers pass "." to
 * mean it. */
export function resolveWithinRoot(rootDir: string, relativePath: string, escapeMessage: string): string {
  const resolved = path.resolve(rootDir, relativePath);
  if (escapesRoot(path.relative(rootDir, resolved))) throw new Error(escapeMessage);
  return resolved;
}

// What a folder on disk holds under one folded name, for the protocol's one
// rule matching a path to an entry (pathIndex.ts).
function namesOnDisk(rootDir: string): FolderNames {
  return (dir, key) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(rootDir, ...dir.split("/")), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entryNameKey(entry.name) === key)
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
  };
}

/** A writer's form of the check above, and a lenient reader's inside its
 * own try: a link refused here reads as absent there. */
export function refuseLink(dir: string, absolutePath: string): void {
  const link = linkBelow(dir, absolutePath);
  if (link !== undefined) {
    throw new PathAccessError(403, `"${link}" is a symbolic link, and Pragma follows none inside a space or library`);
  }
}

/** The folder `name` makes directly inside `parentDir`, or why it makes none.
 * The name is one entry under the entry-name rule, whoever chose it: a person
 * naming a space, or a service handing back a site's slug, where `a/../../x`
 * would otherwise climb out of the space. */
export function newFolderIn(parentDir: string, name: string): { folder: string } | { refused: string } {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    return { refused: "A name can't be empty or contain a slash" };
  }
  const illegal = illegalEntryNameReason(trimmed);
  if (illegal) return { refused: illegal };

  const folder = path.resolve(parentDir, trimmed);
  // An empty `relative` is `parentDir` itself, which every other root check
  // accepts and this one must not: it would write over the folder holding it.
  const relative = path.relative(parentDir, folder);
  if (!relative || escapesRoot(relative)) return { refused: "A name has to make a folder inside its parent" };
  return { folder };
}

/** The folder a new space named `name` makes in `parentDir`, or why it makes
 * none: the entry-name rule above, and a name already there in any case,
 * whether a folder or a file. A new space never moves into a folder that
 * exists, so the template can't land among someone's own files. */
export function newSpaceFolderIn(parentDir: string, name: string): { folder: string } | { refused: string } {
  const placed = newFolderIn(parentDir, name);
  if ("refused" in placed) return placed;
  const existing = namedEntryPath(parentDir, path.basename(placed.folder));
  if (!existsSync(existing)) return placed;

  const taken = `“${path.basename(existing)}” in ${path.basename(parentDir) || parentDir}`;
  return statSync(existing).isDirectory()
    ? { refused: `There’s already a folder named ${taken}. Choose another name, or open it with Open folder as space.` }
    : { refused: `There’s already a file named ${taken}. Choose another name.` };
}

/** The containment check for a root that holds content, the space or a
 * library: it also refuses a path through a link. The static root resolves
 * without it — it is the app's own build output, not anything a space put
 * there. */
export function resolveContentPath(rootDir: string, relativePath: string, escapeMessage: string): string {
  const resolved = resolveWithinRoot(rootDir, relativePath, escapeMessage);
  refuseLink(rootDir, resolved);
  return resolved;
}

/** Read is every surface that displays a file; write is every surface that
 * changes one, deletes it, or creates something inside it. */
export type Access = "read" | "write";

export interface ResolvedRootedPath {
  /** Absolute, guaranteed inside its root. */
  filePath: string;
  rooted: RootedPath;
  /** The root's own directory — the space, or the library's registered
   * folder. What a caller measures a path against and writes beside: a
   * library's trash belongs in that library, not in the space of whichever
   * window happened to delete the file. */
  rootDir: string;
}

/** Whether the space's own machinery applies to a resolved path.
 *
 * The distinction is docs/architecture.md's Document writes and reference integrity
 * section: *"you may not write here"* is permission and flips, while *"this
 * root is not a space"* never does.
 *
 * Binder order, folder sorts, site manifests, published copies and link
 * rewriting are all the second kind — a writable library gets create,
 * rename and delete, and still never gets a `_structure.json`. */
export function isSpaceTarget(resolved: ResolvedRootedPath): boolean {
  return !isLibraryRoot(resolved.rooted.root);
}

/** An absolute path back out in the spelling the caller used: bare for the
 * space, `lib:<id>/…` for a library. A response naming a path has to be
 * valid input to the next request, and the bare form would name a different
 * file — or no file — once the root stops being the space. */
export function formatWithinRoot(resolved: ResolvedRootedPath, absolutePath: string): string {
  return formatRootedPath({
    root: resolved.rooted.root,
    path: path.relative(resolved.rootDir, absolutePath).split(path.sep).join("/"),
  });
}

// How a path's spelling meets the disk: a host's own path, from the tree
// or a route, as spelled; a path a document holds, as its links read one.
type Spelling = "as-spelled" | "held";

/** The entry `relativePath` names below `rootDir`, by the protocol's rule for
 * a path a document holds: whatever case it spells it in, and refused when
 * two names differ only by case. A write the path names no entry for lands
 * in the folder its parent names, under its own name. */
function heldEntry(rootDir: string, input: string, relativePath: string, access: Access): string | undefined {
  const names = namesOnDisk(rootDir);
  const ambiguous = () =>
    new PathAccessError(404, `"${input}" names two entries whose names differ only in case, so it names neither`);
  const found = matchEntries(relativePath, "any", names);
  if (found.length > 1) throw ambiguous();
  if (found.length === 1) return path.join(rootDir, ...found[0].path.split("/"));
  if (access === "read") return undefined;
  const parent = matchEntries(dirnameOf(relativePath), "directory", names);
  if (parent.length > 1) throw ambiguous();
  return parent.length === 1 ? path.join(rootDir, ...parent[0].path.split("/"), basenameOf(relativePath)) : undefined;
}

// A host's own path is read as spelled. One that misses finds its entry as a
// written path would, so a stale case still opens; a write never folds, or
// renaming `a.md` to `A.md` would land on itself.
function spelledEntry(rootDir: string, relativePath: string, resolved: string, access: Access): string {
  if (access === "write" || lstatSync(resolved, { throwIfNoEntry: false })) return resolved;
  const found = matchEntries(relativePath, "any", namesOnDisk(rootDir));
  return found.length === 1 ? path.join(rootDir, ...found[0].path.split("/")) : resolved;
}

function resolveIn(spaceRoot: string, input: string, access: Access, spelling: Spelling): ResolvedRootedPath {
  let rooted: RootedPath;
  try {
    rooted = parseRootedPath(input);
  } catch (error) {
    throw new PathAccessError(400, error instanceof Error ? error.message : "Unreadable path");
  }

  const resolve = (rootDir: string, escapeMessage: string): ResolvedRootedPath => {
    const resolved = resolveWithinRoot(rootDir, rooted.path, escapeMessage);
    const filePath =
      spelling === "held"
        ? (heldEntry(rootDir, input, rooted.path, access) ?? resolved)
        : spelledEntry(rootDir, rooted.path, resolved, access);
    refuseLink(rootDir, filePath);
    // No path names a hidden entry (docs/protocol.md): a read finds nothing,
    // as every surface shows it, and a write is refused. A dot is where either
    // does the most harm: a root's `.git` with a remote's credentials, another
    // app's settings, a `.trash` of the only copies. Judged on the disk's name.
    if (hiddenBelow(rootDir, filePath)) {
      if (access === "read") throw absent(filePath);
      throw new PathAccessError(403, `Hidden entries can't be written to: "${input}"`);
    }
    const found: RootedPath =
      filePath === resolved
        ? rooted
        : { root: rooted.root, path: path.relative(rootDir, filePath).split(path.sep).join("/") };
    if (access === "write") recordWrite(formatRootedPath(found), filePath);
    return { filePath, rooted: found, rootDir };
  };

  if (!isLibraryRoot(rooted.root)) return resolve(spaceRoot, "Path escapes the space");

  const id = rooted.root.library;
  const library = readLibraries(spaceRoot).find((entry) => entry.id === id);
  if (!library) throw new PathAccessError(404, `No library "${id}" is located in this space`);

  if (access === "write" && library.access !== "read-write") {
    throw new PathAccessError(403, `The library "${library.label}" is read-only`);
  }

  return resolve(library.path, "Path escapes the library");
}

/** Resolves a path string against whichever root it names, for the access it
 * is being resolved for, as spelled: a host's own path, from the tree or a
 * route.
 *
 * Deny by default is the rule: a root has to say `read-write` to be written
 * to, so an unknown, malformed or absent permission refuses rather than
 * defaults. The space itself carries no permission: it is always writable. */
export function resolveRootedPath(spaceRoot: string, input: string, access: Access): ResolvedRootedPath {
  return resolveIn(spaceRoot, input, access, "as-spelled");
}

/** The same, for a path a document holds, read as protocol.md's Links reads
 * one: whatever case it spells it in, two entries differing only by case
 * naming neither. A Flow's reads and writes, an Applet's imports, a
 * Class's sources and a published document's files resolve here. */
export function resolveHeldPath(spaceRoot: string, input: string, access: Access): ResolvedRootedPath {
  return resolveIn(spaceRoot, input, access, "held");
}
