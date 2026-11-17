// What a root holds, for reading a written path against: every file and
// folder, shown in the tree or not. One rule matches a path to an entry, its
// names folding as entry names compare, whoever holds the entries: a listing
// the browser keeps, or a disk the server reads.
import { entryNameKey, isHiddenName } from "./entryName.ts";
import { type PathForm, readWrittenPath } from "./relativeReference.ts";
import { basenameOf, dirnameOf, formatRootedPath, type PathRoot } from "./rootedPath.ts";

/** One root's entries, each path relative to it, `/`-separated. */
export interface RootListing {
  files: readonly string[];
  folders: readonly string[];
}

export type EntryType = "file" | "directory";

export interface FoundEntry {
  path: string;
  type: EntryType;
}

/** An entry a folder holds, by its name as spelled. */
export interface NamedEntry {
  name: string;
  type: EntryType;
}

/** The entries in the folder `dir`, spelled as it is ("" for the root), whose
 * names fold to `key`. */
export type FolderNames = (dir: string, key: string) => readonly NamedEntry[];

/** Every entry `path` could name below its root, narrowed by `want`: each
 * segment matched as entry names compare, never a dot-entry. The root itself
 * is "", always a folder. One is the entry the path names; two name nothing,
 * since another tool can make `Plan.md` beside `plan.md` and a guess would
 * open one of them by chance. */
export function matchEntries(path: string, want: EntryType | "any", names: FolderNames): FoundEntry[] {
  if (path === "") return want === "file" ? [] : [{ path: "", type: "directory" }];
  const segments = path.split("/");
  const found: FoundEntry[] = [];
  const walk = (dir: string, at: number): void => {
    for (const entry of names(dir, entryNameKey(segments[at]))) {
      if (isHiddenName(entry.name)) continue;
      const entryPath = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (at < segments.length - 1) {
        if (entry.type === "directory") walk(entryPath, at + 1);
      } else if (want === "any" || entry.type === want) {
        found.push({ path: entryPath, type: entry.type });
      }
    }
  };
  walk("", 0);
  return found;
}

function only(found: readonly FoundEntry[]): FoundEntry | undefined {
  return found.length === 1 ? found[0] : undefined;
}

/** A listing, held by folder and folded name for the matching above. */
export interface PathIndex {
  names: FolderNames;
}

export function createPathIndex(listing: RootListing): PathIndex {
  const byFolder = new Map<string, Map<string, NamedEntry[]>>();
  const add = (path: string, type: EntryType) => {
    const dir = dirnameOf(path);
    const name = basenameOf(path);
    const folder = byFolder.get(dir) ?? new Map<string, NamedEntry[]>();
    byFolder.set(dir, folder);
    const key = entryNameKey(name);
    folder.set(key, [...(folder.get(key) ?? []), { name, type }]);
  };
  for (const file of listing.files) add(file, "file");
  for (const folder of listing.folders) add(folder, "directory");
  return { names: (dir, key) => byFolder.get(dir)?.get(key) ?? [] };
}

/** The one entry at `path` in this root, narrowed by `want`, or undefined
 * when none or two match. */
export function findEntry(index: PathIndex, path: string, want: EntryType | "any"): FoundEntry | undefined {
  return only(matchEntries(path, want, index.names));
}

// A wikilink may leave off `.md`, so `[[plan]]` is `plan.md`, or a file of
// no kind named `plan`; both there name neither. Without its `/` it is never
// a folder, or creating `plan.md` beside `plan/` would retarget the link.
function findWikilinkFile(index: PathIndex, path: string): FoundEntry | undefined {
  const withMd = entryNameKey(path).endsWith(".md") ? [] : matchEntries(`${path}.md`, "file", index.names);
  return only([...matchEntries(path, "file", index.names), ...withMd]);
}

/** The entry a path written in a document names (docs/protocol.md, Links),
 * as a rooted path, or undefined when it names nothing. `indexOf` gives each
 * root's index, undefined for one not loaded: an unloaded library names
 * nothing rather than a guess. */
export function resolveWrittenPath(
  docDir: string,
  written: string,
  form: PathForm,
  indexOf: (root: PathRoot) => PathIndex | undefined,
): FoundEntry | undefined {
  const read = readWrittenPath(docDir, written, form);
  if (!read) return undefined;
  const index = indexOf(read.target.root);
  if (!index) return undefined;
  const found =
    form === "wikilink" && !read.folder
      ? findWikilinkFile(index, read.target.path)
      : findEntry(index, read.target.path, read.folder ? "directory" : "any");
  return found && { path: formatRootedPath({ root: read.target.root, path: found.path }), type: found.type };
}
