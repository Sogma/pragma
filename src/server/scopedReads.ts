// A model's reads of the space, bounded to one scope's folder, "" for the
// whole space. The tools every model surface shares (spaceReader.ts) read
// here, so the bound sits beside the privacy rule instead of in each tool.
//
// Outside the folder reads as missing, as a hidden file does, and a private
// file is never listed, found or read (docs/architecture.md, Privacy): a
// model learns nothing of either, not even that it exists.
import path from "node:path";
import type { SpaceTreeNode } from "../protocol/api.ts";
import { isWithin } from "../protocol/rootedPath.ts";
import { absent, readSpaceFile, resolveWithinSpace } from "./spaceFiles.ts";
import { buildTree, filterPrivateNodes, type SpaceSearchMatch, searchSpaceFiles, spaceListing } from "./tree.ts";

/** The scope's folder as the space tree shows it, private files left out. */
export async function scopeTree(spaceRoot: string, scope: string): Promise<SpaceTreeNode[]> {
  const dir = path.join(spaceRoot, ...scope.split("/"));
  return filterPrivateNodes(spaceRoot, await buildTree(dir, spaceRoot, "space", spaceListing()));
}

/** The agent search over the scope's text files. */
export function searchScope(spaceRoot: string, scope: string, query: string): Promise<SpaceSearchMatch[]> {
  return searchSpaceFiles(spaceRoot, query, scope);
}

/** A file's text by its space-relative path, through the space's privacy
 * doorway, while it sits in the scope's folder. */
export async function readInScope(spaceRoot: string, scope: string, relativePath: string): Promise<string> {
  const filePath = resolveWithinSpace(spaceRoot, relativePath);
  const inSpace = path.relative(spaceRoot, filePath).split(path.sep).join("/");
  if (!isWithin(scope, inSpace)) throw absent(filePath);
  return readSpaceFile(spaceRoot, inSpace);
}
