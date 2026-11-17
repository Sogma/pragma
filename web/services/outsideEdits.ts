// Takes changes made outside this window into the files open in it: an
// agent's edit, a pull run elsewhere, another device. Every file an open tab
// holds a copy of is asked about with the trees (spaceChanges.ts); one whose
// revision moved while nothing of the writer's was on its way to disk is read
// again in place, and one gone from disk empties its tabs.
//
// A copy with an edit on its way is left alone: that edit's save names the
// older revision, so it is refused and the writer picks a side
// (saveConflicts.ts).
import type { SaveQueue } from "./saveQueue.ts";
import { type FileFollower, spaceChanges } from "./spaceChanges.ts";
import type { Tabs } from "./tabs.ts";

export interface OutsideEditsDeps {
  queue: Pick<SaveQueue, "settledRevision">;
  tabs: Pick<Tabs, "openCopies" | "reloadPath" | "dropGone">;
}

export function createOutsideEdits(deps: OutsideEditsDeps): FileFollower {
  // Each path asked about, with the revision its copy was settled at as the
  // ask went out. A save of the writer's that lands during the ask moves it
  // on, and the answer then says nothing about the copy they hold now.
  let asked = new Map<string, string>();
  const reloading = new Set<string>();

  return {
    paths() {
      asked = new Map();
      for (const path of deps.tabs.openCopies()) {
        const revision = deps.queue.settledRevision(path);
        if (revision !== undefined) asked.set(path, revision);
      }
      return [...asked.keys()];
    },
    onRevisions(revisions) {
      const gone: string[] = [];
      for (const [path, revision] of revisions) {
        const known = asked.get(path);
        if (known === undefined || revision === known || deps.queue.settledRevision(path) !== known) continue;
        if (revision === null) gone.push(path);
        else if (!reloading.has(path)) {
          reloading.add(path);
          // A failed read is the next ask's to retry: the revision still differs.
          void deps.tabs
            .reloadPath(path)
            .catch(() => {})
            .finally(() => reloading.delete(path));
        }
      }
      if (gone.length > 0) deps.tabs.dropGone(gone);
    },
  };
}

/** Follows every open copy's file for as long as the window lives. */
export function followOutsideEdits(deps: OutsideEditsDeps): () => void {
  return spaceChanges.followFiles(createOutsideEdits(deps));
}
