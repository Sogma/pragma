// Finding a file by its name, the way World names and Quick Open look one
// up: its basename with the extension stripped, folded as entry names are.
// A link never does this; a wikilink is a path, so a file of the same name
// elsewhere can't change what it opens.
import { entryNameKey } from "./entryName.ts";
import { hasKnownKind, isLutFile } from "./types.ts";
import { wikilinkStem } from "./wikilink.ts";

/** Every file in one root, keyed the two ways a name is looked up. Both are
 * a lookup rather than a scan, so a screenplay resolving every capitalised
 * run on each redraw costs the same in a root of ten files or ten thousand. */
export interface NameIndex {
  /** Folded full path → the path as written. */
  byPath: ReadonlyMap<string, string>;
  /** Folded stem → every path carrying it, in listing order. Two entries
   * means neither. A file of no kind, or a LUT, is left out, so listing one
   * never makes a name ambiguous. */
  byStem: ReadonlyMap<string, readonly string[]>;
}

/** Builds the index for `paths`, every file in the one root searched,
 * relative to it. Earlier entries win a collision under folding. */
export function createNameIndex(paths: readonly string[]): NameIndex {
  const byPath = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  for (const filePath of paths) {
    const folded = entryNameKey(filePath);
    if (!byPath.has(folded)) byPath.set(folded, filePath);
    if (!hasKnownKind(filePath) || isLutFile(filePath)) continue;
    const stem = entryNameKey(wikilinkStem(filePath));
    const sharing = byStem.get(stem);
    if (sharing) sharing.push(filePath);
    else byStem.set(stem, [filePath]);
  }
  return { byPath, byStem };
}

/** The one file whose stem is `name`, or undefined for none or several. */
export function uniqueStem(index: NameIndex, name: string): string | undefined {
  const sharing = index.byStem.get(entryNameKey(name));
  return sharing?.length === 1 ? sharing[0] : undefined;
}

/** The file a typed name picks: the one at that path from the root, `.md`
 * optional, else the one file whose stem it is. */
export function matchName(index: NameIndex, name: string): string | undefined {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed) return undefined;
  const folded = entryNameKey(trimmed);
  return index.byPath.get(folded) ?? index.byPath.get(`${folded}.md`) ?? uniqueStem(index, wikilinkStem(trimmed));
}

/** The project a document in `docDir` belongs to: the folder of the nearest
 * `README.md`, its name in any case, at or above it, stopping before the
 * root — docs/protocol.md's Project context. Undefined outside any project. */
export function projectFolder(index: NameIndex, docDir: string): string | undefined {
  const segments = docDir === "" ? [] : docDir.split("/");
  for (let depth = segments.length; depth >= 1; depth--) {
    const folder = segments.slice(0, depth).join("/");
    if (index.byPath.has(entryNameKey(`${folder}/README.md`))) return folder;
  }
  return undefined;
}
