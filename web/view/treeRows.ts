// The active tab's row highlight, shared by every tree in the sidebar. A
// tree asks it whether a row it is drawing is the active one; moving the
// highlight re-marks the rows already drawn.
//
// One document can have a row in more than one panel at once (the main tree
// and a site's accordion), so nothing here assumes a single match.

import { dirnameOf } from "../../src/protocol/rootedPath.ts";
export interface ActiveRowMarker {
  /** Points the highlight at a path, or nowhere, and re-marks every row drawn. */
  set(rootedPath: string | undefined): void;
  /** Whether a row drawn for `rootedPath` carries the highlight. */
  has(rootedPath: string): boolean;
  /** Whether the highlighted row sits directly in the folder at `rootedPath`,
   * whose indent guide is drawn darker. */
  holds(rootedPath: string): boolean;
  /** Calls `listener` each time the highlight moves to another path; the
   * returned function stops it. */
  subscribe(listener: (rootedPath: string | undefined) => void): () => void;
}

/** The tree's highlighted row, following the active tab. Keyed by rooted
 * path (src/protocol/rootedPath.ts), not a captured element: a file can have
 * rows in two panels, and a library row and a space row of the same relative
 * name differ.
 *
 * `root` is the whole sidebar, not one tree's container — a lookup scoped to
 * the main tree finds a hidden copy, or nothing, when the file was opened
 * from a site accordion or a library. */
export function createActiveRowMarker(root: ParentNode): ActiveRowMarker {
  let activePath: string | undefined;
  let activeFolder: string | undefined;
  const listeners = new Set<(rootedPath: string | undefined) => void>();

  function remark(): void {
    for (const marked of root.querySelectorAll<HTMLElement>(".node-label.active, .tree-guides > .active")) {
      marked.classList.remove("active");
    }
    if (activePath === undefined || activeFolder === undefined) return;
    for (const label of root.querySelectorAll<HTMLElement>(`.node-label[data-path="${CSS.escape(activePath)}"]`)) {
      label.classList.add("active");
    }
    for (const line of root.querySelectorAll<HTMLElement>(
      `.tree-guides > [data-folder="${CSS.escape(activeFolder)}"]`,
    )) {
      line.classList.add("active");
    }
  }

  return {
    set(rootedPath) {
      const moved = rootedPath !== activePath;
      activePath = rootedPath;
      activeFolder = rootedPath === undefined ? undefined : dirnameOf(rootedPath);
      remark();
      if (moved) for (const listener of [...listeners]) listener(rootedPath);
    },
    has: (rootedPath) => rootedPath === activePath,
    holds: (rootedPath) => rootedPath === activeFolder,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
