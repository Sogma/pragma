// The bracket every git action runs inside, since a git action rewrites the
// working tree the editor holds buffers over. Before, pending saves must
// reach disk, or Sync's commit leaves the edit out.
//
// After, whatever changed on disk is read back into the open panes and the
// tree. Without that, pulling an edit to an open note and typing once
// reverts it locally, and the next Sync pushes the reversion under the
// writer's name.
import type { GitActionResponse, GitStatus } from "../core/apiClient.ts";
import { describeUnsaved, type SaveQueueState } from "./saveQueue.ts";

export interface GitActionsDeps {
  // Resolves to the queue's state when something is still unwritten, and
  // undefined when everything reached disk — see saveQueue.flush.
  flushPendingSave: () => Promise<SaveQueueState | undefined>;
  // Locks the workspace (and disables the git controls) for the duration.
  setBusy: (busy: boolean) => void;
  isBusy: () => boolean;
  // Re-reads these paths into any open model; resolves to the ones that
  // couldn't be read back, which the caller treats as gone.
  reloadPaths: (paths: readonly string[]) => Promise<string[]>;
  // Files that no longer exist can't stay open on a tab.
  dropTabsForGonePaths: (paths: readonly string[]) => void;
  refreshTree: () => Promise<void>;
  onStatus: (status: GitStatus) => void;
  // Shown in the panel's message row; cleared at the start of every action.
  onError: (message: string) => void;
  clearError: () => void;
}

export interface GitActions {
  run(action: () => Promise<GitActionResponse>, failureMessage: string): Promise<void>;
}

export function createGitActions(deps: GitActionsDeps): GitActions {
  // Only the paths the action actually touched (pull and sync report them;
  // commit and push rewrite nothing), so an open file the pull left alone
  // keeps its undo history, selection and scroll instead of being rebuilt.
  async function applyWorkingTreeChanges(result: GitActionResponse): Promise<void> {
    const changed = result.changedPaths ?? [];
    const deleted = result.deletedPaths ?? [];
    if (changed.length === 0 && deleted.length === 0) return;

    const unreadable = await deps.reloadPaths(changed);
    deps.dropTabsForGonePaths([...deleted, ...unreadable]);
    await deps.refreshTree();
  }

  return {
    async run(action, failureMessage) {
      if (deps.isBusy()) return;
      deps.clearError();

      const unsaved = await deps.flushPendingSave();
      if (unsaved) {
        // Nothing here is safe on a tree that doesn't have the writer's
        // latest edits in it: a commit would record a stale copy, and a pull
        // would overwrite work that is still only in the queue.
        deps.onError(describeUnsaved(unsaved, "syncing"));
        return;
      }

      deps.setBusy(true);
      try {
        const result = await action();
        deps.onStatus(result.status);
        await applyWorkingTreeChanges(result);
      } catch (error: unknown) {
        deps.onError(error instanceof Error ? error.message : failureMessage);
      } finally {
        deps.setBusy(false);
      }
    },
  };
}
