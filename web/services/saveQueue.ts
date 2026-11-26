// Debounced writes, one timer per path, latest wins. Every autosave schedules
// here, so one flush writes everything pending and a document switch never
// drops a waiting edit.
//
// The queue is the only record of an edit until its write lands, so a failed
// write goes back into `pending` and is retried, never dropped while its
// long-gone caller thinks it saved.
//
// Every write names the revision its content was composed from, so a save on
// a since-replaced copy is refused and held — never retried or dropped —
// until the writer picks a side.
import {
  type PutFileRequestBody,
  type PutFileResponse,
  SaveConflictError,
  type SavedDocumentDates,
} from "../core/apiClient.ts";
import { Emitter } from "../lib/emitter.ts";

/** What wrote a save's content when it wasn't the writer's typing. */
export type SaveSource = Required<Pick<PutFileRequestBody, "source">> & Pick<PutFileRequestBody, "flow">;

export interface SaveQueueDeps {
  putFile: (path: string, content: string, baseRevision?: string, source?: SaveSource) => Promise<PutFileResponse>;
  // After every *successful* write, whatever the caller — the git dirty
  // hint, a console line, the tree's order. A failed write must not reach
  // this.
  onSaved?: (path: string, content: string) => void;
  delayMs?: number;
}

export interface SaveQueueState {
  // Paths whose last write attempt failed and that are still being retried.
  failedPaths: string[];
  // Paths whose save was refused as stale, held until the writer picks a side.
  conflictPaths: string[];
  // The most recent failure's message, for the indicator's tooltip.
  message?: string;
}

export interface SaveQueue {
  // `onWritten` runs once this exact content has been written (with the
  // dates the server added, if any). It is dropped, not called, if a newer
  // schedule for the same path supersedes this one first. `source` says what
  // wrote the content when it wasn't the writer's typing.
  schedule(
    path: string,
    content: string,
    onWritten?: (dates: SavedDocumentDates | undefined) => void,
    source?: SaveSource,
  ): void;
  // The revision of the file a working copy was just built from — the base
  // its next save names. Ignored while `path` has a write pending, in
  // flight, or held as a conflict: that content was composed from the older
  // base, and adopting a newer one would let it overwrite unrefused. A path
  // with no revision noted writes unconditionally.
  noteRevision(path: string, revision: string): void;
  // The revision noted for `path` while nothing for it is pending, in
  // flight, held or paused: what disk should still hold if nothing else
  // wrote it. Undefined while the writer has something on its way.
  settledRevision(path: string): string | undefined;
  // Settles a held conflict: "overwrite" writes the held content over
  // whatever is on disk now; "discard" drops it, and the caller re-reads
  // the file.
  resolveConflict(path: string, resolution: "overwrite" | "discard"): void;
  // A space rename or move: revisions at or under `from` follow the file.
  // Only called after a flush, so nothing is pending under the old path.
  move(from: string, to: string): void;
  // Stops writing `path` until the returned function is called; edits
  // scheduled meanwhile wait, and are written on resume. For a caller whose
  // own request is about to rewrite the file on the server (a publish), so
  // no save of it can land between the server's read and its write.
  pause(path: string): () => void;
  // A write this client asked the server for (a publish's write-back)
  // changed `path` on disk: `revision` is its base from now on, and `patch`
  // makes the same change to any content still queued or held for it, so
  // writing that content later keeps the server's change. Waits out a write
  // already in flight first, since its result would otherwise overtake this.
  rebase(path: string, revision: string, patch: (content: string) => string): Promise<void>;
  // Writes every pending save now (or just `path`'s), and waits for any
  // write already in flight. Resolves false if anything is still unwritten
  // afterwards — a failed write being retried, a held conflict, a paused
  // path — none of it lost, but a caller about to act on the file on disk (a
  // git action) must not treat that as saved.
  //
  // Never rejects: navigation steps (switching tabs, opening a file) call it
  // and have to keep working while the server is unreachable.
  flush(path?: string): Promise<boolean>;
  // Schedules `content` and writes it at once: flush(path) for one edit.
  saveNow(path: string, content: string): Promise<boolean>;
  hasPending(path?: string): boolean;
  // The content queued or held for `path` but not yet on disk, if any. A
  // reader of the file has to prefer this over what the server returns, or
  // it will build on a copy this queue is about to overwrite.
  pendingContent(path: string): string | undefined;
  state(): SaveQueueState;
  subscribe(listener: (state: SaveQueueState) => void): () => void;
}

interface Held {
  content: string;
  onWritten?: (dates: SavedDocumentDates | undefined) => void;
}

interface Pending extends Held {
  timer: ReturnType<typeof setTimeout>;
  source?: SaveSource;
}

// Retry backoff, capped. There is no "give up" step: the content exists
// nowhere else, so the only two ends are a write that lands or a user who
// closes the window (which the unload guard warns about first). The cap
// keeps a long outage — a laptop asleep, a server restarting — down to one
// quiet attempt every 30s rather than a spin.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function retryDelayFor(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  const delay = deps.delayMs ?? 500;
  const pending = new Map<string, Pending>();
  const conflicts = new Map<string, Held>();
  const revisions = new Map<string, string>();
  const inFlight = new Set<Promise<void>>();
  // One write per path at a time. A second write for the same path sent
  // while the first is still out would name the base the first is about to
  // replace, and be refused as a conflict with the writer's own save.
  const writing = new Map<string, Promise<void>>();
  // Consecutive failures per path, reset by a write that lands. Kept
  // separate from `pending` so it survives the entry being replaced by a
  // newer edit: a server that is down stays down, and typing at it must not
  // reset the backoff to the debounce interval and hammer it.
  const failures = new Map<string, number>();
  // Paths not to write until resumed, counted: two publishes of one file
  // can overlap, and the first to finish must not resume the other's.
  const paused = new Map<string, number>();
  const emitter = new Emitter<SaveQueueState>({ failedPaths: [], conflictPaths: [] });
  let lastMessage: string | undefined;

  function publish(): void {
    const failedPaths = [...failures.keys()];
    emitter.set({
      failedPaths,
      conflictPaths: [...conflicts.keys()],
      message: failedPaths.length ? lastMessage : undefined,
    });
  }

  function hold(path: string, entry: Held): void {
    conflicts.set(path, { content: entry.content, onWritten: entry.onWritten });
    failures.delete(path);
    publish();
  }

  function write(path: string): Promise<void> {
    const current = writing.get(path);
    if (current) return current.then(() => write(path));
    if (paused.has(path)) return Promise.resolve();
    const entry = pending.get(path);
    if (!entry) return Promise.resolve();
    pending.delete(path);
    clearTimeout(entry.timer);
    const job = deps
      .putFile(path, entry.content, revisions.get(path), entry.source)
      .then(({ revision, dates }) => {
        revisions.set(path, revision);
        if (failures.delete(path)) publish();
        deps.onSaved?.(path, entry.content);
        entry.onWritten?.(dates);
      })
      .catch((error: unknown) => {
        if (error instanceof SaveConflictError) {
          // A newer edit queued meanwhile was composed from the same stale
          // base, so it is what gets held — the latest content, as ever.
          const newer = pending.get(path);
          if (newer) {
            clearTimeout(newer.timer);
            pending.delete(path);
          }
          hold(path, newer ?? entry);
          return;
        }
        const attempts = (failures.get(path) ?? 0) + 1;
        lastMessage = error instanceof Error ? error.message : "Save failed.";
        failures.set(path, attempts);
        // Put the content back so it is retried — unless a newer schedule
        // landed while this write was in flight, in which case that content
        // supersedes this one and already carries its own timer. Dropping
        // it then is latest-wins, not loss.
        if (!pending.has(path)) {
          pending.set(path, {
            content: entry.content,
            onWritten: entry.onWritten,
            timer: setTimeout(() => void write(path), retryDelayFor(attempts - 1)),
          });
        }
        publish();
      })
      .finally(() => {
        inFlight.delete(job);
        writing.delete(path);
      });
    inFlight.add(job);
    writing.set(path, job);
    return job;
  }

  const queue: SaveQueue = {
    schedule(path, content, onWritten, source) {
      // A held conflict stays held: the writer keeps working and the newest
      // content is what their eventual choice applies to.
      if (conflicts.has(path)) {
        conflicts.set(path, { content, onWritten });
        return;
      }
      const existing = pending.get(path);
      if (existing) clearTimeout(existing.timer);
      // While a path is failing, a fresh edit waits out the backoff rather
      // than retrying on the debounce interval — the write is failing for a
      // reason that typing doesn't fix.
      const attempts = failures.get(path);
      const wait = attempts === undefined ? delay : retryDelayFor(attempts - 1);
      const timer = setTimeout(() => void write(path), wait);
      // A restore or a copilot edit keeps its label through the typing that
      // joins it in one save: the version that save replaces is from before it.
      pending.set(path, { content, timer, onWritten, source: source ?? existing?.source });
    },
    noteRevision(path, revision) {
      if (pending.has(path) || writing.has(path) || conflicts.has(path)) return;
      revisions.set(path, revision);
    },
    settledRevision(path) {
      if (pending.has(path) || writing.has(path) || conflicts.has(path) || paused.has(path)) return undefined;
      return revisions.get(path);
    },
    resolveConflict(path, resolution) {
      const held = conflicts.get(path);
      if (!held) return;
      conflicts.delete(path);
      if (resolution === "overwrite") {
        // No base: this write is the writer choosing to replace whatever is
        // there. The revision it lands at is the base from then on.
        revisions.delete(path);
        pending.set(path, { ...held, timer: setTimeout(() => void write(path), 0) });
      }
      publish();
    },
    move(from, to) {
      for (const [path, revision] of [...revisions]) {
        if (path !== from && !path.startsWith(`${from}/`)) continue;
        revisions.delete(path);
        revisions.set(to + path.slice(from.length), revision);
      }
    },
    pause(path) {
      paused.set(path, (paused.get(path) ?? 0) + 1);
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        const count = (paused.get(path) ?? 1) - 1;
        if (count > 0) {
          paused.set(path, count);
          return;
        }
        paused.delete(path);
        // Its timer may have fired into the pause and done nothing.
        const entry = pending.get(path);
        if (entry) {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => void write(path), 0);
        }
      };
    },
    async rebase(path, revision, patch) {
      // A loop, not one await: a write chained behind the one in flight
      // starts as soon as it settles, and its result would replace the
      // revision set here.
      while (writing.has(path)) await writing.get(path);
      const entry = pending.get(path) ?? conflicts.get(path);
      if (entry) entry.content = patch(entry.content);
      revisions.set(path, revision);
    },
    async flush(path) {
      // A failing path is attempted too: its cause may be gone (a session
      // re-established), and the caller needs the file on disk now.
      //
      // The loop picks up anything queued meanwhile. A failed write is
      // attempted only once, so the loop terminates; a landed one is written
      // again if an edit arrived meanwhile, so nothing is left unwritten
      // without a failure to show.
      //
      // A held conflict is never written here — only the writer settles it —
      // and a paused path waits for resume.
      const attempted = new Set<string>();
      for (;;) {
        const paths = (path === undefined ? [...pending.keys()] : pending.has(path) ? [path] : []).filter(
          (candidate) => !paused.has(candidate) && !(attempted.has(candidate) && failures.has(candidate)),
        );
        for (const candidate of paths) attempted.add(candidate);
        // write() resolves either way (it catches), so this never rejects.
        const jobs = [...paths.map(write), ...inFlight];
        if (jobs.length === 0) break;
        await Promise.all(jobs);
      }
      return path === undefined
        ? pending.size === 0 && conflicts.size === 0
        : !pending.has(path) && !conflicts.has(path);
    },
    saveNow(path, content) {
      queue.schedule(path, content);
      return queue.flush(path);
    },
    hasPending: (path) =>
      path === undefined ? pending.size > 0 || conflicts.size > 0 : pending.has(path) || conflicts.has(path),
    pendingContent: (path) => pending.get(path)?.content ?? conflicts.get(path)?.content,
    state: () => emitter.get(),
    subscribe: (listener) => emitter.subscribe(listener),
  };
  return queue;
}

// Why a flush left something unwritten, for a caller that refused to go on
// because of it — `before` is what it refused, as in "before moving". Names
// the files, so the writer can find them in the status bar. With `path`,
// only that file's flush is being explained.
export function describeUnsaved(state: SaveQueueState, before: string, path?: string): string {
  const matching = (paths: string[]) => (path === undefined ? paths : paths.filter((each) => each === path));
  const conflicts = matching(state.conflictPaths);
  if (conflicts.length > 0) {
    return conflicts.length === 1
      ? `${conflicts[0]} has a save conflict. Resolve it from "Save conflict" in the status bar before ${before}.`
      : `${conflicts.join(", ")} have save conflicts. Resolve them from the status bar before ${before}.`;
  }
  const failed = matching(state.failedPaths);
  if (failed.length > 0) {
    const reason = state.message ? ` (${state.message.replace(/\.$/, "")})` : "";
    const retried = failed.length === 1 ? "It's being retried; try" : "They're being retried; try";
    return `${failed.join(", ")} couldn't be saved${reason}. ${retried} ${before} again once saved.`;
  }
  return `Some edits are still waiting to be saved. Try ${before} again in a moment.`;
}

// The last line of defence for work the queue is still holding. A write that
// failed, or is held as a conflict, has content that exists nowhere but this
// tab, so closing the window drops it for good; a debounced one that hasn't
// fired yet is in the same position. Browsers show their own generic wording
// here, and the desktop shell turns it into a real dialog (electron/main.ts).
export function guardUnload(queue: SaveQueue, target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("beforeunload", (event) => {
    if (!queue.hasPending()) return;
    void queue.flush(); // best-effort, in case the writer decides to stay
    event.preventDefault();
    event.returnValue = "";
  });
}
