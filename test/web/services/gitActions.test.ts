import { describe, expect, it, vi } from "vitest";
import type { GitActionResponse, GitStatus } from "../../../web/core/apiClient.ts";
import { createGitActions, type GitActionsDeps } from "../../../web/services/gitActions.ts";
import type { SaveQueueState } from "../../../web/services/saveQueue.ts";

const CLEAN: GitStatus = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };

function setup(overrides: Partial<GitActionsDeps> = {}) {
  let busy = false;
  const deps = {
    flushPendingSave: vi.fn(async (): Promise<SaveQueueState | undefined> => undefined),
    setBusy: vi.fn((next: boolean) => {
      busy = next;
    }),
    isBusy: () => busy,
    reloadPaths: vi.fn(async (_paths: readonly string[]) => [] as string[]),
    dropTabsForGonePaths: vi.fn(),
    refreshTree: vi.fn(async () => {}),
    onStatus: vi.fn(),
    onError: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
  return { actions: createGitActions(deps), deps };
}

describe("createGitActions", () => {
  it("writes pending saves to disk before touching the working tree", async () => {
    const order: string[] = [];
    const { actions, deps } = setup({
      flushPendingSave: vi.fn(async () => {
        order.push("flush");
        return undefined;
      }),
    });

    await actions.run(async () => {
      order.push("git");
      return { status: CLEAN };
    }, "Sync failed.");

    expect(order).toEqual(["flush", "git"]);
    expect(deps.onStatus).toHaveBeenCalledWith(CLEAN);
  });

  // The whole point of flush() reporting failure: committing a tree that is
  // missing the writer's latest edits records a stale copy, and pulling over
  // it overwrites work that only exists in the save queue.
  it("refuses to run at all when something is still unwritten, naming the file", async () => {
    const action = vi.fn(async () => ({ status: CLEAN }) satisfies GitActionResponse);
    const { actions, deps } = setup({
      flushPendingSave: vi.fn(async () => ({ failedPaths: [], conflictPaths: ["notes/a.md"] })),
    });

    await actions.run(action, "Sync failed.");

    expect(action).not.toHaveBeenCalled();
    expect(deps.setBusy).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("notes/a.md has a save conflict"));
  });

  // The reversion this whole change exists to stop: a pull rewrites a file
  // an editor has open, and without a reload the next keystroke saves the
  // stale buffer straight back over it.
  it("re-reads exactly the paths the action changed, and nothing else", async () => {
    const { actions, deps } = setup();

    await actions.run(async () => ({ status: CLEAN, changedPaths: ["notes/a.md"], deletedPaths: [] }), "Pull failed.");

    expect(deps.reloadPaths).toHaveBeenCalledWith(["notes/a.md"]);
    expect(deps.refreshTree).toHaveBeenCalled();
  });

  it("skips the reload entirely for an action that rewrote nothing", async () => {
    const { actions, deps } = setup();

    await actions.run(async () => ({ status: CLEAN }), "Push failed.");

    expect(deps.reloadPaths).not.toHaveBeenCalled();
    expect(deps.refreshTree).not.toHaveBeenCalled();
  });

  it("closes tabs on files the pull deleted, and on ones that no longer read back", async () => {
    const { actions, deps } = setup({ reloadPaths: vi.fn(async () => ["notes/broken.md"]) });

    await actions.run(
      async () => ({ status: CLEAN, changedPaths: ["notes/broken.md"], deletedPaths: ["notes/gone.md"] }),
      "Sync failed.",
    );

    expect(deps.dropTabsForGonePaths).toHaveBeenCalledWith(["notes/gone.md", "notes/broken.md"]);
  });

  it("locks the workspace for the duration and always unlocks, failure included", async () => {
    const { actions, deps } = setup();

    await actions.run(async () => {
      throw new Error("could not connect to remote");
    }, "Sync failed.");

    expect(deps.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(deps.setBusy).toHaveBeenNthCalledWith(2, false);
    expect(deps.onError).toHaveBeenCalledWith("could not connect to remote");
    expect(deps.onStatus).not.toHaveBeenCalled();
  });

  it("ignores a second action while one is already running", async () => {
    const { actions, deps } = setup();
    const action = vi.fn(async () => ({ status: CLEAN }) satisfies GitActionResponse);

    const first = actions.run(async () => {
      await actions.run(action, "Pull failed.");
      return { status: CLEAN };
    }, "Sync failed.");
    await first;

    expect(action).not.toHaveBeenCalled();
    expect(deps.flushPendingSave).toHaveBeenCalledTimes(1);
  });
});
