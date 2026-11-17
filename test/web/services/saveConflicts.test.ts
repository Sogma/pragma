import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type PutFileResponse, SaveConflictError } from "../../../web/core/apiClient.ts";
import { createSaveConflicts } from "../../../web/services/saveConflicts.ts";
import { createSaveQueue } from "../../../web/services/saveQueue.ts";

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 8, 24, 14, 32) }));
afterEach(() => vi.useRealTimers());

async function setup(choice: string | null) {
  const putFile = vi.fn(async (): Promise<PutFileResponse> => ({ revision: "rev-new" }));
  putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
  const queue = createSaveQueue({ putFile, delayMs: 10 });
  const pick = vi.fn(async () => choice);
  const createFile = vi.fn(async () => undefined);
  const reloadPath = vi.fn(async () => {});
  const onCopySaved = vi.fn();
  const notify = vi.fn();
  const conflicts = createSaveConflicts({ queue, dialog: { pick }, createFile, reloadPath, onCopySaved, notify });

  queue.noteRevision("notes/song.table.html", "rev-0");
  queue.schedule("notes/song.table.html", "mine");
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(0);
  return { queue, putFile, pick, createFile, reloadPath, onCopySaved, notify, conflicts };
}

describe("createSaveConflicts", () => {
  it("asks once when a conflict appears", async () => {
    const { pick } = await setup(null);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("keeps the save held when the dialog is closed, and asks again on review", async () => {
    const { queue, pick, conflicts } = await setup(null);
    expect(queue.state().conflictPaths).toEqual(["notes/song.table.html"]);

    conflicts.review();
    await vi.advanceTimersByTimeAsync(0);
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("keep both saves a conflicted copy beside the file, still of the same kind, then reloads", async () => {
    const { queue, createFile, reloadPath, onCopySaved } = await setup("copy");

    expect(createFile).toHaveBeenCalledWith("notes", "song (conflicted copy 2026-09-24 1432).table.html", "mine");
    expect(onCopySaved).toHaveBeenCalled();
    expect(queue.hasPending()).toBe(false);
    expect(reloadPath).toHaveBeenCalledWith("notes/song.table.html");
  });

  it("steps around a copy name that is already taken", async () => {
    const putFile = vi.fn(async (): Promise<PutFileResponse> => ({ revision: "r" }));
    putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
    const queue = createSaveQueue({ putFile, delayMs: 10 });
    const createFile = vi.fn(async () => undefined);
    createFile.mockRejectedValueOnce(new ApiError("Already exists", 409));
    createSaveConflicts({
      queue,
      dialog: { pick: async () => "copy" },
      createFile,
      reloadPath: async () => {},
      onCopySaved: () => {},
      notify: () => {},
    });
    queue.schedule("a.md", "mine");
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);

    expect(createFile).toHaveBeenLastCalledWith("", "a (conflicted copy 2026-09-24 1432 2).md", "mine");
  });

  it("keeps the save held if the copy can't be written", async () => {
    const { queue, createFile, notify, reloadPath } = await setup(null);
    createFile.mockRejectedValue(new Error("disk full"));
    const conflicts = createSaveConflicts({
      queue,
      dialog: { pick: async () => "copy" },
      createFile,
      reloadPath,
      onCopySaved: () => {},
      notify,
    });
    conflicts.review();
    await vi.advanceTimersByTimeAsync(0);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(queue.hasPending("notes/song.table.html")).toBe(true);
    expect(reloadPath).not.toHaveBeenCalled();
  });

  it("use the file as it is now drops the edits and reloads", async () => {
    const { queue, reloadPath, putFile } = await setup("discard");
    expect(queue.hasPending()).toBe(false);
    expect(reloadPath).toHaveBeenCalledWith("notes/song.table.html");
    expect(putFile).toHaveBeenCalledTimes(1);
  });

  it("keep your version writes it with no base", async () => {
    const { queue, putFile, reloadPath } = await setup("overwrite");
    await vi.advanceTimersByTimeAsync(1);
    expect(putFile).toHaveBeenLastCalledWith("notes/song.table.html", "mine", undefined, undefined);
    expect(queue.hasPending()).toBe(false);
    expect(reloadPath).not.toHaveBeenCalled();
  });
});
