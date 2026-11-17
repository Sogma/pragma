// A Class's rows, read from its notes' own frontmatter and text: the host's
// half of the rules src/protocol/class.ts states.
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SpaceTreeNode } from "../protocol/api.ts";
import {
  type ClassPlace,
  type ClassRow,
  classFolders,
  compareRowNames,
  folderInScope,
  isRowEntry,
  matchesRules,
  type ReadFolder,
  readsFolder,
  rowKindOf,
} from "../protocol/class.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { isNamed } from "../protocol/entryName.ts";
import { fountainTitlePage } from "../protocol/fountainLines.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import { basenameOf, dirnameOf, formatRootedPath, isLibraryRoot, parseRootedPath } from "../protocol/rootedPath.ts";
import { scopeOf } from "../protocol/scopes.ts";
import { isTemplatePath } from "../protocol/templates.ts";
import { type ClassFile, formatTimestamp, splitDocumentName } from "../protocol/types.ts";
import { documentIndex } from "./documentIndex.ts";
import { formatWithinRoot, isSpaceTarget, namedEntryPath, resolveHeldPath, resolveRootedPath } from "./rootedFiles.ts";
import { buildTree, scopesOnDisk, spaceListing } from "./tree.ts";

function isFile(absolutePath: string): boolean {
  return lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** The scope `folder` sits in, as a rooted folder: the deepest one at or
 * above it in the space, the space's own at the top, and a library's root,
 * a library being one scope. */
export function scopeFolderOf(spaceRoot: string, folder: string): string {
  const { root, path } = parseRootedPath(folder);
  return formatRootedPath({ root, path: isLibraryRoot(root) ? "" : scopeOf(scopesOnDisk(spaceRoot), path) });
}

function classPlaceOf(spaceRoot: string, classPath: string): ClassPlace {
  const folder = dirnameOf(classPath);
  return { scope: scopeFolderOf(spaceRoot, folder), folder };
}

/** The notes `classPath` holds: the rows of the folders its Folder rule
 * names, else of its whole root, kept by its filter. A Class file that
 * can't be read gives none at all. */
export async function classRows(spaceRoot: string, classPath: string): Promise<ClassRow[]> {
  const resolved = resolveRootedPath(spaceRoot, classPath, "read");
  const file = parseClassFile(await readFile(resolved.filePath, "utf8"));
  if (!file) return [];
  const place = classPlaceOf(spaceRoot, formatRootedPath(resolved.rooted));
  const rows = await folderRows(spaceRoot, classFolders(place, file.filter), place.scope);
  return rows.filter((row) => matchesRules(row, file.filter, place));
}

/** The rows `folders` hold: each one's, by the tree's visibility and in the
 * folder's own order, as the tree shows it, so a row dragged here or in the
 * tree lands in place in both. A folder with its subfolders gives them
 * depth-first, as the tree lists them. Each row's folder is written from
 * `scope`, the Class's scope's folder.
 *
 * Rows from several folders are in name order instead, since no one folder's
 * order covers them, and a file reached twice is one row. A folder this host
 * can't read gives none. */
export async function folderRows(
  spaceRoot: string,
  folders: readonly ReadFolder[],
  scope: string,
): Promise<ClassRow[]> {
  const rows = new Map<string, ClassRow>();
  for (const { folder, subfolders } of folders) {
    let nodes: SpaceTreeNode[];
    let target: ReturnType<typeof resolveHeldPath>;
    try {
      target = resolveHeldPath(spaceRoot, folder, "read");
      const treeRoot = isSpaceTarget(target) ? "space" : "library";
      const listing = treeRoot === "space" ? spaceListing() : {};
      const depth = subfolders ? Number.POSITIVE_INFINITY : 1;
      nodes = await buildTree(target.filePath, target.rootDir, treeRoot, { depth, ...listing });
    } catch {
      continue;
    }
    // A Class lists the space's templates only from among them.
    collect(target, target.filePath, nodes, rows, { skipsTemplates: !isTemplatePath(folder), scope });
  }
  const listed = [...rows.values()];
  return folders.length > 1 ? listed.sort(compareRowNames) : listed;
}

/** The row `doc`, a document in the space, makes in the Class `file` at
 * `classPath`, or undefined when the Class doesn't hold it: as the Class's
 * rows list it, without reading any other. */
export function classRowOf(
  spaceRoot: string,
  classPath: string,
  file: ClassFile,
  doc: { path: string; filePath: string },
): ClassRow | undefined {
  // A folder's row is its `index.md`, listed by the folder holding it.
  const indexed = isNamed(basenameOf(doc.path), "index.md");
  const entry = indexed ? dirnameOf(doc.path) : doc.path;
  const node = { name: basenameOf(entry), type: indexed ? ("directory" as const) : ("file" as const) };
  if (entry === "" || isHiddenPath(entry) || !isRowEntry(node.name, node.type, indexed)) return undefined;
  const folder = dirnameOf(entry);
  const place = classPlaceOf(spaceRoot, classPath);
  const reached = classFolders(place, file.filter).some(
    (read) => readsFolder(read, folder) && (isTemplatePath(read.folder) || !isTemplatePath(entry)),
  );
  if (!reached) return undefined;
  const row = readRow(doc.filePath, doc.path, node, folderInScope(place.scope, folder));
  return matchesRules(row, file.filter, place) ? row : undefined;
}

// A folder's row comes before the rows below it. A walk that stopped at the
// read folder's own level lists its folders without children, so only a
// read with its subfolders descends. A folder's row sits in the folder
// holding it.
function collect(
  target: ReturnType<typeof resolveRootedPath>,
  dir: string,
  nodes: readonly SpaceTreeNode[],
  rows: Map<string, ClassRow>,
  walk: { skipsTemplates: boolean; scope: string },
): void {
  const folder = folderInScope(walk.scope, formatWithinRoot(target, dir));
  for (const node of nodes) {
    const absolute = path.join(dir, node.name);
    if (walk.skipsTemplates && isTemplatePath(formatWithinRoot(target, absolute))) continue;
    const file = node.type === "directory" ? namedEntryPath(absolute, "index.md") : absolute;
    const rowPath = formatWithinRoot(target, file);
    if (!rows.has(rowPath) && isRowEntry(node.name, node.type, node.type === "directory" && isFile(file))) {
      rows.set(rowPath, readRow(file, rowPath, node, folder));
    }
    if (node.children) collect(target, absolute, node.children, rows, walk);
  }
}

// A row's title and values, as its kind keeps them, beside the file's own
// facts. A folder's row is its `index.md`, a note named for the folder.
function readRow(file: string, rowPath: string, node: Pick<SpaceTreeNode, "name" | "type">, folder: string): ClassRow {
  const kind = node.type === "directory" ? "note" : (rowKindOf(node.name) ?? "note");
  const stem = node.type === "directory" ? node.name : splitDocumentName(node.name).stem;
  const stats = lstatSync(file);
  const facts = {
    path: rowPath,
    name: node.name,
    kind,
    size: stats.size,
    modified: formatTimestamp(stats.mtime),
    folder,
  };
  if (kind === "note") {
    const { data, title, error } = documentIndex().noteHead(file);
    const inlineTags = documentIndex().inlineTags(file);
    return {
      ...facts,
      title: title ?? stem,
      properties: data,
      ...(error ? { error } : {}),
      ...(inlineTags.length > 0 ? { inlineTags } : {}),
    };
  }
  if (kind === "screenplay") {
    // Keys in lower case, as a field reads them in any case; the first of a
    // key named twice.
    const properties: Record<string, unknown> = {};
    for (const { key, value } of fountainTitlePage(readFileSync(file, "utf8"))) {
      properties[key.toLowerCase()] ??= value;
    }
    const title = typeof properties.title === "string" && properties.title ? properties.title : stem;
    return { ...facts, title, properties };
  }
  return { ...facts, title: stem, properties: {} };
}
