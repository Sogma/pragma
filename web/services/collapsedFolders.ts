// Which folders are folded — one store for every tree that draws them (the
// Space view, a site's accordion in Websites, a library), so a folder folded
// in one is folded in all. Persisted in the space's layout so the state
// survives a restart.
//
// A space folder starts open and a library folder starts collapsed: the space
// is a working tree, a library an archive drilled into. Each root records only
// its exceptions, so the root is read off every key, never assumed by the
// caller. A space never folded loads with the folders below its top level
// already in the list: the server answers with them (src/server/layout.ts).
import { isLibraryPath, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import type { fetchLayout, postSetFolderState } from "../core/apiClient.ts";

export interface CollapsedFoldersDeps {
  load: typeof fetchLayout;
  save: typeof postSetFolderState;
}

export interface CollapsedFolders {
  /** Whether the folder at this rooted path draws folded. */
  isCollapsed(dir: string): boolean;
  /** Folds or opens one folder, as a click on its row does, and persists. */
  setCollapsed(dir: string, collapsed: boolean): void;
  load(): Promise<void>;
  /** Expands `dir` so a row about to be drawn inside it is visible. A root
   * has no row to collapse, so "" and `lib:<id>` are no-ops. */
  expand(dir: string): void;
  /** Expands every ancestor of `path`, for a row reached by a link rather
   * than a click; true if any of them was folded. */
  reveal(path: string): boolean;
  /** Folds every folder in `dirs` with one save, as Collapse All does. */
  foldAll(dirs: Iterable<string>): void;
}

function isRoot(dir: string): boolean {
  try {
    return parseRootedPath(dir).path === "";
  } catch {
    return false;
  }
}

export function createCollapsedFolders(deps: CollapsedFoldersDeps): CollapsedFolders {
  const collapsed = new Set<string>(); // space folders folded shut
  const expanded = new Set<string>(); // library folders opened

  // Best-effort in both directions: a save failure must not interrupt the
  // click that caused it, and a failed load just starts every root at its
  // default.
  function persist(): void {
    void deps.save([...collapsed], [...expanded]).catch(() => undefined);
  }

  // Unpersisted, so reveal opens a whole chain with one save.
  function setFolded(dir: string, folded: boolean): void {
    if (isRoot(dir)) return;
    if (isLibraryPath(dir)) {
      if (folded) expanded.delete(dir);
      else expanded.add(dir);
    } else if (folded) collapsed.add(dir);
    else collapsed.delete(dir);
  }

  const isCollapsed = (dir: string) => (isLibraryPath(dir) ? !expanded.has(dir) : collapsed.has(dir));

  return {
    isCollapsed,
    setCollapsed(dir, folded) {
      setFolded(dir, folded);
      persist();
    },
    async load() {
      try {
        const { collapsedFolders, expandedFolders } = await deps.load();
        // A key in the other root's list means nothing there. Dropped here,
        // so the next save writes both lists back clean.
        for (const dir of collapsedFolders) if (!isLibraryPath(dir)) collapsed.add(dir);
        for (const dir of expandedFolders) if (isLibraryPath(dir)) expanded.add(dir);
      } catch {
        // see above
      }
    },
    expand(dir) {
      if (isRoot(dir)) return;
      setFolded(dir, false);
      persist();
    },
    // Saves only when it opened something: the tree reveals the open file on
    // every tab switch, and a switch inside open folders changes nothing.
    reveal(path) {
      let ancestor = "";
      let opened = false;
      for (const segment of path.split("/").slice(0, -1)) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        if (isRoot(ancestor) || !isCollapsed(ancestor)) continue;
        setFolded(ancestor, false);
        opened = true;
      }
      if (opened) persist();
      return opened;
    },
    foldAll(dirs) {
      for (const dir of dirs) setFolded(dir, true);
      persist();
    },
  };
}
