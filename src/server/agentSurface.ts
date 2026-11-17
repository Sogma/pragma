// What an external caller can see of a space, in one place.
//
// Both encodings of the agent API — the MCP tools and the REST endpoints —
// resolve through here rather than each applying the rule themselves:
// **the surface is bounded by what the tree shows, not by what the
// filesystem allows**, and what it will not list it will not read. Two
// implementations would drift apart, and the drift would be a disclosure.

import { lstat } from "node:fs/promises";
import path from "node:path";
import { isHiddenPath } from "../protocol/relativeReference.ts";
import { aliasedOnWindows, hiddenBelow, pathOnDisk } from "./entryOnDisk.ts";
import { readSpaceFile, resolveWithinSpace } from "./spaceFiles.ts";
import { createSpaceReader, type SpaceReader } from "./spaceReader.ts";
import { buildTree, filterPrivateNodes, isPrivateFile, isSpaceListedFile, spaceListing } from "./tree.ts";

/** Every document a caller may name, space-relative.
 *
 * The tree walk already skips dot-prefixed entries, so `.trash/`, `.git/`
 * and other apps' folders never appear; documents marked `visibility: private` are then
 * dropped by the same filter the copilot's own listing uses. */
export async function visiblePaths(spaceRoot: string): Promise<string[]> {
  const tree = await filterPrivateNodes(spaceRoot, await buildTree(spaceRoot, spaceRoot, "space", spaceListing()));
  const paths: string[] = [];
  const walk = (nodes: Awaited<ReturnType<typeof buildTree>>): void => {
    for (const node of nodes) {
      if (node.type === "directory") walk(node.children ?? []);
      else paths.push(node.path);
    }
  };
  walk(tree);
  return paths;
}

/** Whether `relativePath` is a document this surface admits to having.
 *
 * The listing's rule, asked of one path rather than by walking the space: a
 * kind the tree lists, under no dotted folder, through no link, not private.
 * Containment alone would happily resolve `.git/config` or anything in
 * `.trash/`, leaving them unlistable but readable; agentSurface.test.ts holds
 * this to the listing. */
export async function isVisible(spaceRoot: string, relativePath: string): Promise<boolean> {
  const filePath = inSpace(spaceRoot, relativePath);
  if (filePath === undefined) return false;
  const onDisk = pathOnDisk(filePath);
  if (!isSpaceListedFile(path.basename(onDisk), spaceListing())) return false;
  const entry = await lstat(filePath).catch(() => undefined);
  return entry?.isFile() === true && !(await isPrivateFile(onDisk));
}

/** Whether `relativePath` is a folder this surface admits to having. */
export async function isVisibleFolder(spaceRoot: string, relativePath: string): Promise<boolean> {
  const folderPath = inSpace(spaceRoot, relativePath);
  return folderPath !== undefined && (await lstat(folderPath).catch(() => undefined))?.isDirectory() === true;
}

// The absolute path of a space path written as the listing writes it, under
// no dotted folder, by the disk's names as well as by its spelling, and
// through no link; undefined for any other.
function inSpace(spaceRoot: string, relativePath: string): string | undefined {
  if (aliasedOnWindows(relativePath)) return undefined;
  let absolute: string;
  try {
    absolute = resolveWithinSpace(spaceRoot, relativePath);
  } catch {
    return undefined;
  }
  const written = path.relative(spaceRoot, absolute).split(path.sep).join("/");
  if (written !== relativePath || isHiddenPath(written) || hiddenBelow(spaceRoot, absolute)) return undefined;
  return absolute;
}

/** One document's text, or undefined when the surface does not admit to it.
 *
 * Undefined rather than a distinct "forbidden" — a caller must not be able to
 * tell a private document from a missing one, or the refusal itself confirms
 * what the document is. The shared space reader is the required doorway beyond
 * that: it refuses a private document's contents and a raster image's bytes. */
export async function readVisibleFile(spaceRoot: string, relativePath: string): Promise<string | undefined> {
  if (!(await isVisible(spaceRoot, relativePath))) return undefined;
  return readSpaceFile(spaceRoot, relativePath);
}

/** The model-facing reads both encodings offer: what the listing holds,
 * whole, by paths relative to the space. */
export function agentReader(spaceRoot: string): SpaceReader {
  return createSpaceReader({ spaceRoot, scope: "", where: "the space", limits: { matches: 50 }, listedOnly: true });
}
