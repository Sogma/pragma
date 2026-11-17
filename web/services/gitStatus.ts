import { fetchGitStatus, type GitStatus } from "../core/apiClient.ts";
import { Emitter } from "../lib/emitter.ts";

// Every consumer (the rail badge, the Source Control panel, the git action
// handlers) reads one shared fetch: a `git status` shell-out is too costly
// to duplicate, and separate copies could disagree on screen. A caller
// already holding a fresh GitStatus (after a sync/commit/pull/push) feeds it
// back in.
//
// No polling. A full read, which fetches the remote first, runs on startup,
// on opening the panel, and (throttled) on window focus. A write in the
// space is recounted by a read that skips the fetch, once writes settle.
export type GitStatusState =
  | { phase: "loading" }
  | { phase: "ready"; status: GitStatus }
  | { phase: "error"; message: string; last?: GitStatus };

function lastKnown(state: GitStatusState): GitStatus | undefined {
  if (state.phase === "ready") return state.status;
  if (state.phase === "error") return state.last;
  return undefined;
}

// Rapid window switching must not spawn a fetch storm: one focus-driven
// fetch per interval, however many focus and visibility events arrive.
const FOCUS_REFRESH_INTERVAL_MS = 15_000;
// A burst of saves, or a move that rewrites several files, is one recount.
const LOCAL_SETTLE_MS = 1000;

function createGitStatusStore() {
  const emitter = new Emitter<GitStatusState>({ phase: "loading" });
  // One read at a time, chained rather than overlapped: a local read landing
  // after a full one would bring back ahead/behind from refs the fetch has
  // since moved.
  let inFlight: { done: Promise<void>; fetch: boolean } | undefined;
  // Bumped when a git action hands in its own result, so a read that started
  // before it can't land over it with the tree as it was mid-action.
  let epoch = 0;
  let lastFocusRefresh = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;

  /** A full read answers for a local one too; a local read never stands in
   * for a full one. */
  function read(fetch: boolean): Promise<void> {
    if (inFlight && (inFlight.fetch || !fetch)) return inFlight.done;
    const run = async () => {
      const started = epoch;
      try {
        const status = await fetchGitStatus({ fetch });
        if (started === epoch) emitter.set({ phase: "ready", status });
      } catch (error: unknown) {
        if (started !== epoch) return;
        emitter.set({
          phase: "error",
          message: error instanceof Error ? error.message : "Failed to load git status.",
          last: lastKnown(emitter.get()),
        });
      } finally {
        if (inFlight === current) inFlight = undefined;
      }
    };
    const current = { fetch, done: inFlight ? inFlight.done.then(run) : run() };
    inFlight = current;
    return current.done;
  }

  return {
    /** Latest known state — starts as `{ phase: "loading" }`. */
    get: (): GitStatusState => emitter.get(),
    /** Subscribe to state changes; fires immediately with the current state. Returns an unsubscribe fn. */
    subscribe: (listener: (state: GitStatusState) => void): (() => void) => emitter.subscribe(listener),
    /** A full read, the remote fetched first. Concurrent callers share it. */
    refresh: (): Promise<void> => read(true),
    /** The focus-regain refetch — a commit or pull may have happened in a
     * terminal meanwhile. Throttled, and skipped while a git action runs:
     * its own result already feeds the store, so a refetch would only race
     * it. Whether one is running is the caller's to say. */
    refreshOnFocus(isBusy: () => boolean): void {
      if (isBusy()) return;
      if (Date.now() - lastFocusRefresh < FOCUS_REFRESH_INTERVAL_MS) return;
      lastFocusRefresh = Date.now();
      void read(true);
    },
    /** Adopt a GitStatus obtained elsewhere (a git action's response) — no refetch. */
    update(status: GitStatus): void {
      epoch++;
      emitter.set({ phase: "ready", status });
    },
    /** A write landed in the space: recount once writes settle, without the
     * remote. Outside a trusted repository there is nothing to count, and a
     * first read still loading sees the write anyway. */
    noteLocalChange(): void {
      const status = lastKnown(emitter.get());
      if (!status?.isRepo || status.restricted) return;
      clearTimeout(settle);
      settle = setTimeout(() => void read(false), LOCAL_SETTLE_MS);
    },
  };
}

export const gitStatusStore = createGitStatusStore();
