// What happens after the save queue holds a save as a conflict: the file
// changed since the copy being saved was read, so the writer picks which
// version to keep. Nothing is merged or decided for them — a line-wise merge
// of a serialized table or flow no longer parses, and a guess loses work.
//
// Each conflict is asked about once; closing the dialog leaves the save held
// (the status bar and unload guard still see it) until it is reviewed again.
import { basenameOf, dirnameOf } from "../../src/protocol/rootedPath.ts";
import { splitDocumentName } from "../../src/protocol/types.ts";
import { ApiError } from "../core/apiClient.ts";
import type { DialogService } from "./dialog.ts";
import type { SaveQueue } from "./saveQueue.ts";

export interface SaveConflictsDeps {
  queue: Pick<SaveQueue, "subscribe" | "state" | "pendingContent" | "resolveConflict">;
  dialog: Pick<DialogService, "pick">;
  // Creates a new file, refusing (409) a name that is already taken.
  createFile: (parentPath: string, name: string, content: string) => Promise<unknown>;
  // Re-reads the file into whatever shows it.
  reloadPath: (path: string) => Promise<void>;
  onCopySaved: () => void;
  notify: (message: string) => void;
}

export interface SaveConflicts {
  // Asks about every conflict still held.
  review(): void;
}

// `notes (conflicted copy 2026-09-24 1432).md`, the shape file-sync tools
// settled on. The compound extension stays whole, so a table's copy is still
// a `.table.html`.
function copyName(path: string, attempt: number, now: Date): string {
  const { stem, extension } = splitDocumentName(basenameOf(path));
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stem} (conflicted copy ${stamp}${attempt > 1 ? ` ${attempt}` : ""})${extension}`;
}

export function createSaveConflicts(deps: SaveConflictsDeps): SaveConflicts {
  // Paths waiting for, or showing, a dialog. One dialog at a time: a flush
  // can turn up several conflicts at once.
  const queued = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let known = new Set<string>();

  async function saveCopy(path: string, content: string): Promise<void> {
    const now = new Date();
    for (let attempt = 1; ; attempt++) {
      try {
        await deps.createFile(dirnameOf(path), copyName(path, attempt, now), content);
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409) || attempt >= 20) throw error;
      }
    }
  }

  async function ask(path: string): Promise<void> {
    if (!deps.queue.state().conflictPaths.includes(path)) return;
    const choice = await deps.dialog.pick({
      title: "This file changed while you were editing it",
      message: `Something else saved ${basenameOf(path)} after you opened it: another tab or device, an applet, or another program. Your latest edits haven't been saved over it.`,
      options: [
        {
          id: "copy",
          label: "Keep both",
          description: "Save your version as a copy next to it, then show the file as it is now.",
        },
        { id: "discard", label: "Use the file as it is now", description: "Throw away your unsaved edits." },
        { id: "overwrite", label: "Keep your version", description: "Replace the file with your version." },
      ],
    });
    if (choice === null) return;
    if (choice === "overwrite") {
      deps.queue.resolveConflict(path, "overwrite");
      return;
    }
    if (choice === "copy") {
      const content = deps.queue.pendingContent(path);
      if (content === undefined) return;
      try {
        await saveCopy(path, content);
      } catch (error) {
        deps.notify(`Couldn't save your copy: ${error instanceof Error ? error.message : error}`);
        return;
      }
      deps.onCopySaved();
    }
    deps.queue.resolveConflict(path, "discard");
    try {
      await deps.reloadPath(path);
    } catch {
      deps.notify(`${basenameOf(path)} couldn't be read again. It may have been moved or deleted.`);
    }
  }

  function enqueue(paths: readonly string[]): void {
    for (const path of paths) {
      if (queued.has(path)) continue;
      queued.add(path);
      // A throw here would stop every dialog after it, so one is swallowed.
      chain = chain.then(() => ask(path).finally(() => queued.delete(path))).catch(() => {});
    }
  }

  deps.queue.subscribe(({ conflictPaths }) => {
    enqueue(conflictPaths.filter((path) => !known.has(path)));
    known = new Set(conflictPaths);
  });

  return { review: () => enqueue(deps.queue.state().conflictPaths) };
}
