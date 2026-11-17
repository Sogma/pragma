// Moving or renaming one space entry, and everything that has to follow it.
// The server half rewrites the references that named the entry (src/server/
// spaceReferences.ts), so this is no longer a rename plus a tree refresh: a
// buffer has to be flushed before the rewrite runs and re-read after it, or
// the two halves overwrite each other.
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import { type MoveEntryResponse, postMoveEntry } from "../core/apiClient.ts";
import type { DocumentsService } from "./documents.ts";
import type { ModelConsole } from "./modelConsole.ts";
import { describeUnsaved, type SaveQueueState } from "./saveQueue.ts";
import type { Tabs } from "./tabs.ts";

export interface EntryMoveDeps {
  documents: Pick<DocumentsService, "move" | "reloadPaths">;
  /** Writes anything still queued. Resolves to the queue's state when
   * something is still unwritten, which is the one condition this refuses
   * to move under, and undefined when everything reached disk. */
  flushPendingSave(): Promise<SaveQueueState | undefined>;
  /** The open document's path, and what to do when the move renamed it —
   * the title and status bar follow it, so the caller owns that. */
  activePath(): string | undefined;
  onActivePathMoved(path: string): void;
  tabs: Pick<Tabs, "repath" | "followMove">;
  refreshTree(): Promise<unknown>;
  notify(message: string): void;
  modelConsole: Pick<ModelConsole, "logEntry">;
}

/** Whether `path` is the moved entry or something that was inside it. */
function movedWith(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

/** The same relative position under the entry's new path. */
function repath(path: string, from: string, to: string): string {
  return to + path.slice(from.length);
}

export interface EntryMove {
  from: string;
  to: string;
}

/** Moves the entry at `from` to `to`, then settles everything the move
 * displaced: open tabs and models re-keyed, rewritten documents re-read and
 * recorded, the tree refreshed, each pane on a moved tab re-read if it keeps
 * its own copy, and anything the rewrite could not repair reported.
 *
 * Resolves to the server's response, or undefined when the move did not
 * happen — the caller has already been told why through `notify`. */
export async function moveSpaceEntry(
  from: string,
  to: string,
  deps: EntryMoveDeps,
): Promise<MoveEntryResponse | undefined> {
  const [moved] = await moveSpaceEntries([{ from, to }], deps);
  return moved;
}

/** Moves each entry as a lone move would, as one action: one flush before,
 * one tree refresh after, and one notification naming every entry that
 * stayed where it was. Resolves to each move's response, in order, undefined
 * for one that did not happen. */
export async function moveSpaceEntries(
  moves: readonly EntryMove[],
  deps: EntryMoveDeps,
): Promise<(MoveEntryResponse | undefined)[]> {
  const results: (MoveEntryResponse | undefined)[] = moves.map(() => undefined);
  if (moves.every(({ from, to }) => from === to)) return results;

  // Before the move, not after: the server rewrites other documents as part
  // of it, and an edit still sitting in a buffer would be saved over that
  // rewrite a moment later. Same order, and the same reason, as a git action's
  // flush (services/gitActions.ts).
  const unsaved = await deps.flushPendingSave();
  if (unsaved) {
    deps.notify(describeUnsaved(unsaved, "moving"));
    return results;
  }

  const stayed: { from: string; message: string }[] = [];
  const warnings: string[] = [];
  const followed: string[] = [];
  for (const [index, { from, to }] of moves.entries()) {
    if (from === to) continue;
    let moved: MoveEntryResponse;
    try {
      moved = await postMoveEntry(from, to);
    } catch (error) {
      stayed.push({ from, message: error instanceof Error ? error.message : "Failed to move." });
      continue;
    }
    results[index] = moved;

    const active = deps.activePath();
    if (active !== undefined && movedWith(active, from)) {
      deps.onActivePathMoved(repath(active, from, moved.path));
    }

    if (deps.tabs.repath(from, moved.path)) followed.push(moved.path);
    deps.documents.move(from, moved.path);

    // After the re-keying above, so these post-move paths name models that are
    // actually open. Re-reading is safe because the flush left nothing unsaved;
    // a path that has no model open is skipped, and one that can't be re-read
    // was just written by the rewrite, so it isn't a case worth unwinding for.
    if (moved.rewritten?.length) {
      await deps.documents.reloadPaths(moved.rewritten);

      // The move's own outcome is on screen, but the rewrite's isn't: documents
      // the user never opened were edited on disk and turn up later as changes
      // they didn't type, so the Console lists their paths, the form the
      // question takes in Source Control.
      //
      // Warnings stay a notification, below: the Console is off by default, and
      // a collision needs an answer.
      const count = moved.rewritten.length;
      deps.modelConsole.logEntry(
        "info",
        "MOVE",
        `Moved ${from} → ${moved.path} and updated ${count} document${count === 1 ? "" : "s"}`,
        moved.rewritten.join("\n"),
      );
    }
    if (moved.warnings?.length) warnings.push(...moved.warnings);
  }

  if (results.some((moved) => moved !== undefined)) {
    await deps.refreshTree();
    // After the refresh, so a gallery on a renamed folder finds its folders in
    // the tree, for their icons.
    for (const path of followed) await deps.tabs.followMove(path);
  }
  // A lone move's refusal is the server's own message; several moves name
  // each entry that stayed beside its reason.
  const notes: string[] = [];
  if (moves.length === 1 && stayed.length === 1) notes.push(stayed[0].message);
  else if (stayed.length > 0) {
    const lines = stayed.map(({ from, message }) => `${basenameOf(from)}: ${message}`);
    notes.push(`Couldn't move everything.\n\n${lines.join("\n")}`);
  }
  notes.push(...warnings);
  if (notes.length > 0) deps.notify(notes.join("\n\n"));
  return results;
}
