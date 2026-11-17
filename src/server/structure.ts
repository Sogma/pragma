// The manual order: `_structure.json` beside a sortable directory's entries
// (docs/protocol.md's Folder order) — read, applied to a listing, and
// rewritten as entries are renamed, removed, duplicated, or reordered.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STRUCTURE_FILENAME } from "../protocol/pragmaFiles.ts";
import { namedEntryPath, refuseLink } from "./rootedFiles.ts";

// An entry is an object naming one child rather than the bare name, so a
// file whose entries carry more keys still reads. Those keys are
// dropped on its next write.
interface SpaceStructureFile {
  order: Array<{ name: string }>;
}

interface OrderableNode {
  name: string;
}

/** The child names `<dir>/_structure.json` orders, if present. Malformed or
 * missing files fall back to `null` rather than throwing, so a directory
 * without (or with a broken) one just keeps alphabetical order. */

export function readStructure(dir: string): string[] | null {
  const structurePath = namedEntryPath(dir, STRUCTURE_FILENAME);
  if (!existsSync(structurePath)) return null;

  try {
    refuseLink(dir, structurePath);
    const parsed = JSON.parse(readFileSync(structurePath, "utf8")) as { order?: unknown };
    if (!Array.isArray(parsed.order)) return null;
    return parsed.order.flatMap((entry: unknown) => {
      const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
      return typeof name === "string" ? [name] : [];
    });
  } catch {
    return null;
  }
}

/** Reorders `nodes` (already alphabetically sorted by the caller) to follow
 * `order`. Names with no matching node are skipped, so a stale
 * entry can't invent a file that isn't on disk.
 *
 * Nodes present on disk but missing from the order (new/untracked scenes)
 * are appended afterward in their existing alphabetical order, so nothing
 * silently disappears from the tree while the order is out of date. */

export function applyStructure<T extends OrderableNode>(nodes: T[], order: string[]): T[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  for (const name of order) {
    const node = byName.get(name);
    if (node && !seen.has(name)) {
      ordered.push(node);
      seen.add(name);
    }
  }

  for (const node of nodes) {
    if (!seen.has(node.name)) ordered.push(node);
  }

  return ordered;
}

/** Writes `<dir>/_structure.json` so it orders `entryNames` (a full set of
 * that directory's current child basenames, files and directories alike)
 * exactly as given, refusing a link where it goes: the reader takes one as
 * absent, so a write through it would land wherever it points.
 *
 * Creates the file on first use: a directory that's never been
 * reordered has no file, and stays alphabetical. */

export function writeStructure(dir: string, entryNames: string[]): void {
  const structurePath = namedEntryPath(dir, STRUCTURE_FILENAME);
  refuseLink(dir, structurePath);
  const file: SpaceStructureFile = { order: entryNames.map((name) => ({ name })) };
  writeFileSync(structurePath, `${JSON.stringify(file, null, 2)}\n`);
}

/** Keeps `<dir>/_structure.json` in sync with a same-directory rename,
 * keeping the entry's position, since a rename changes its name out from
 * under the order tracking it by that name. No-op if the directory isn't
 * sortable, or the order has no entry for `oldName`. */

export function renameStructureEntry(dir: string, oldName: string, newName: string): void {
  const order = readStructure(dir);
  if (!order?.includes(oldName)) return;
  writeStructure(
    dir,
    order.map((name) => (name === oldName ? newName : name)),
  );
}

/** Keeps `<dir>/_structure.json` in sync with a deletion or a move out of
 * the directory, dropping the entry. Left behind, it would be cruft the tree
 * ordering silently skips, until a file of the same name took its place. No-op
 * if the directory isn't sortable, or the order has no entry for `name`. */

export function removeStructureEntry(dir: string, name: string): void {
  const order = readStructure(dir);
  if (!order?.includes(name)) return;
  writeStructure(
    dir,
    order.filter((entry) => entry !== name),
  );
}

/** Keeps `<dir>/_structure.json` in sync with a duplicate: the copy is placed
 * directly after the original. Without this the copy lands at the end of a
 * long binder, far from the entry it was made from. No-op if the directory
 * isn't sortable or the original has no entry.
 *
 * A stale entry already under the copy's name is dropped, or it would claim
 * the copy's position first. */

export function duplicateStructureEntry(dir: string, name: string, copyName: string): void {
  const order = readStructure(dir)?.filter((entry) => entry !== copyName);
  const index = order?.indexOf(name) ?? -1;
  if (!order || index === -1) return;
  writeStructure(dir, [...order.slice(0, index + 1), copyName, ...order.slice(index + 1)]);
}
