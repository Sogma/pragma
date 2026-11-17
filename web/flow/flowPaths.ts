// The paths a Flow's nodes store, as the canvas reads and writes them: read
// from the Flow's folder as a run reads them, and an entry dropped on a node
// written from there by the one writing rule every document follows.
import { resolveDeclaredPath } from "../../src/protocol/relativeReference.ts";
import {
  dirnameOf,
  formatDeclaredPath,
  formatRootedPath,
  isLibraryRoot,
  type RootedPath,
} from "../../src/protocol/rootedPath.ts";
import { writePathFrom } from "../core/spaceTree.ts";

/** How the Flow at `flowPath` stores an entry dropped on one of its nodes, as
 * any document writes a path to it. A Flow in a library can't name outside
 * it, so such a drop keeps the entry's address, which a run refuses by name. */
export function flowStoredPath(flowPath: string, target: RootedPath, folder = false): string {
  return writePathFrom(dirnameOf(flowPath), target, { folder }) ?? formatDeclaredPath(target);
}

/** What a folder node of the Flow at `flowPath` stores for its pick `child`,
 * a tree path: `stored` when that names it already, so opening a Flow never
 * re-spells a pick, else the child as a drop of it is written. */
export function flowPickPath(flowPath: string, child: string, stored: string): string {
  if (stored && flowTreePath(flowPath, stored) === child) return stored;
  return flowStoredPath(flowPath, { root: "space", path: child });
}

/** A path the Flow at `flowPath` stores, as the space tree spells it: read
 * from the Flow's folder, with no `space:`. What a folder is looked up by,
 * and what a drop target's chip shows. A library path keeps its `lib:`; one
 * that names nothing shows as stored. */
export function flowTreePath(flowPath: string, stored: string): string {
  try {
    const rooted = resolveDeclaredPath(dirnameOf(flowPath), stored);
    return isLibraryRoot(rooted.root) ? formatRootedPath(rooted) : rooted.path;
  } catch {
    return stored;
  }
}
