import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PutFileResponse, SaveConflictError } from "../../../web/core/apiClient.ts";
import { createSaveQueue, describeUnsaved, type SaveSource } from "../../../web/services/saveQueue.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(delayMs = 500) {
  let written = 0;
  const putFile = vi.fn(
    async (
      _path: string,
      _content: string,
      _baseRevision?: string,
      _source?: SaveSource,
    ): Promise<PutFileResponse> => ({
      revision: `rev-${++written}`,
    }),
  );
  const onSaved = vi.fn();
  const queue = createSaveQueue({ putFile, onSaved, delayMs });
  return { queue, putFile, onSaved };
}

describe("createSaveQueue", () => {
  it("writes after the delay, once, with the latest content for that path", async () => {
    const { queue, putFile, onSaved } = setup();
    queue.schedule("a.md", "one");
    queue.schedule("a.md", "two");
    expect(queue.hasPending("a.md")).toBe(true);

    await vi.advanceTimersByTimeAsync(499);
    expect(putFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(putFile).toHaveBeenCalledTimes(1);
    expect(putFile).toHaveBeenCalledWith("a.md", "two", undefined, undefined);
    expect(onSaved).toHaveBeenCalledWith("a.md", "two");
    expect(queue.hasPending()).toBe(false);
  });

  it("names what wrote a save, through the typing that joins it before it goes", async () => {
    const { queue, putFile } = setup();
    queue.schedule("a.md", "restored", undefined, { source: "restored" });
    queue.schedule("a.md", "restored, then typed");
    await vi.advanceTimersByTimeAsync(500);
    expect(putFile).toHaveBeenLastCalledWith("a.md", "restored, then typed", undefined, { source: "restored" });

    queue.schedule("a.md", "typed alone");
    await vi.advanceTimersByTimeAsync(500);
    expect(putFile).toHaveBeenLastCalledWith("a.md", "typed alone", "rev-1", undefined);
  });

  it("keeps separate timers per path — a second path never drops the first", async () => {
    const { queue, putFile } = setup();
    queue.schedule("a.md", "A");
    queue.schedule("b.md", "B");

    await vi.advanceTimersByTimeAsync(500);

    expect(putFile.mock.calls.map((call) => call[0])).toEqual(["a.md", "b.md"]);
  });

  it("flush() writes everything pending immediately and resolves once written", async () => {
    const { queue, putFile } = setup();
    queue.schedule("a.md", "A");
    queue.schedule("b.md", "B");

    await queue.flush();

    expect(putFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(putFile).toHaveBeenCalledTimes(2); // the timers were cancelled, nothing writes twice
  });

  it("flush(path) writes only that path", async () => {
    const { queue, putFile } = setup();
    queue.schedule("a.md", "A");
    queue.schedule("b.md", "B");

    await queue.flush("a.md");

    expect(putFile).toHaveBeenCalledTimes(1);
    expect(queue.hasPending("b.md")).toBe(true);
  });

  it("calls onWritten with the server's dates, and drops a superseded callback", async () => {
    const { queue, putFile } = setup();
    putFile.mockResolvedValueOnce({ revision: "rev-d", dates: { created: "2026-09-10", updated: "2026-09-11" } });
    const first = vi.fn();
    const second = vi.fn();
    queue.schedule("a.md", "one", first);
    queue.schedule("a.md", "two", second);

    await queue.flush();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ created: "2026-09-10", updated: "2026-09-11" });
  });

  // An edit landing while flush's own write is out must not stay queued:
  // flush would report the file unwritten, refusing the move, while the
  // status bar shows nothing failing.
  it("flush() writes again an edit that arrived while its write was out", async () => {
    let release: () => void = () => {};
    const putFile = vi.fn(
      (_path: string, content: string, _base?: string) =>
        new Promise<PutFileResponse>((resolve) => {
          release = () => resolve({ revision: `after-${content}` });
        }),
    );
    const queue = createSaveQueue({ putFile, delayMs: 10 });
    queue.schedule("a.md", "one");
    const flushed = queue.flush();
    await Promise.resolve();
    queue.schedule("a.md", "two");
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();

    expect(await flushed).toBe(true);
    expect(putFile).toHaveBeenLastCalledWith("a.md", "two", "after-one", undefined);
    expect(queue.hasPending()).toBe(false);
  });

  it("flush() also waits for a write the timer already started", async () => {
    let release: () => void = () => {};
    const putFile = vi.fn(
      () =>
        new Promise<PutFileResponse>((resolve) => {
          release = () => resolve({ revision: "rev-1" });
        }),
    );
    const queue = createSaveQueue({ putFile, delayMs: 10 });
    queue.schedule("a.md", "A");
    await vi.advanceTimersByTimeAsync(10);
    expect(putFile).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushing = queue.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(flushed).toBe(true);
  });
  // A failed write (a 401, a disk error) and a good 204 must not return the
  // same value, or the queue reports every failed write as saved and drops
  // the only copy of the content.
  describe("a write that fails", () => {
    it("does not report the path as saved", async () => {
      const { queue, putFile, onSaved } = setup();
      putFile.mockRejectedValueOnce(new Error("Unauthorized"));
      queue.schedule("a.md", "one");

      await queue.flush();

      expect(onSaved).not.toHaveBeenCalled();
      expect(queue.state().failedPaths).toEqual(["a.md"]);
      expect(queue.state().message).toBe("Unauthorized");
    });

    it("keeps the content and retries it, unchanged, on a backoff", async () => {
      const { queue, putFile, onSaved } = setup();
      putFile.mockRejectedValueOnce(new Error("Unauthorized"));
      queue.schedule("a.md", "one");
      await queue.flush();

      expect(queue.hasPending("a.md")).toBe(true);
      expect(queue.pendingContent("a.md")).toBe("one");

      await vi.advanceTimersByTimeAsync(1_000);

      expect(putFile).toHaveBeenNthCalledWith(2, "a.md", "one", undefined, undefined);
      expect(onSaved).toHaveBeenCalledWith("a.md", "one");
      expect(queue.state().failedPaths).toEqual([]);
      expect(queue.hasPending("a.md")).toBe(false);
    });

    it("lets a newer edit supersede the content being retried", async () => {
      const { queue, putFile } = setup();
      putFile.mockRejectedValueOnce(new Error("offline"));
      queue.schedule("a.md", "one");
      await queue.flush();

      queue.schedule("a.md", "two");
      await queue.flush();

      expect(putFile).toHaveBeenLastCalledWith("a.md", "two", undefined, undefined);
      expect(queue.hasPending()).toBe(false);
    });

    it("makes flush() resolve false, so a caller that needs the file on disk can stop", async () => {
      const { queue, putFile } = setup();
      putFile.mockRejectedValue(new Error("ENOSPC"));
      queue.schedule("a.md", "one");

      expect(await queue.flush()).toBe(false);

      putFile.mockResolvedValue({ revision: "rev-1" });
      expect(await queue.flush()).toBe(true);
    });

    it("never rejects out of flush(), so navigation keeps working while the server is down", async () => {
      const { queue, putFile } = setup();
      putFile.mockRejectedValue(new Error("network"));
      queue.schedule("a.md", "one");

      await expect(queue.flush()).resolves.toBe(false);
    });

    it("waits out the backoff rather than retrying on every keystroke", async () => {
      const { queue, putFile } = setup();
      putFile.mockRejectedValue(new Error("offline"));
      queue.schedule("a.md", "one");
      await queue.flush();
      expect(putFile).toHaveBeenCalledTimes(1);

      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(500); // the ordinary debounce would have fired here
      expect(putFile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500); // 1_000ms: the first backoff step
      expect(putFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("revisions", () => {
    it("names the noted revision as the base, then the one each write lands at", async () => {
      const { queue, putFile } = setup();
      queue.noteRevision("a.md", "rev-0");
      queue.schedule("a.md", "one");
      await vi.advanceTimersByTimeAsync(500);
      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(500);

      expect(putFile).toHaveBeenNthCalledWith(1, "a.md", "one", "rev-0", undefined);
      expect(putFile).toHaveBeenNthCalledWith(2, "a.md", "two", "rev-1", undefined);
    });

    it("answers the settled revision only while nothing is pending, in flight, held or paused", async () => {
      let release: () => void = () => {};
      const putFile = vi.fn(
        (_path: string, _content: string, _base?: string) =>
          new Promise<PutFileResponse>((resolve) => {
            release = () => resolve({ revision: "rev-1" });
          }),
      );
      const queue = createSaveQueue({ putFile, delayMs: 10 });
      queue.noteRevision("a.md", "rev-0");
      expect(queue.settledRevision("a.md")).toBe("rev-0");

      queue.schedule("a.md", "one");
      expect(queue.settledRevision("a.md")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10);
      expect(queue.settledRevision("a.md")).toBeUndefined(); // in flight
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.settledRevision("a.md")).toBe("rev-1");

      const resume = queue.pause("a.md");
      expect(queue.settledRevision("a.md")).toBeUndefined();
      resume();
      expect(queue.settledRevision("a.md")).toBe("rev-1");

      putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(10);
      expect(queue.state().conflictPaths).toEqual(["a.md"]);
      expect(queue.settledRevision("a.md")).toBeUndefined();
    });

    it("ignores a revision noted while a write is pending — that content predates it", async () => {
      const { queue, putFile } = setup();
      queue.noteRevision("a.md", "rev-0");
      queue.schedule("a.md", "one");
      queue.noteRevision("a.md", "rev-newer");
      await vi.advanceTimersByTimeAsync(500);

      expect(putFile).toHaveBeenCalledWith("a.md", "one", "rev-0", undefined);
    });

    it("sends one write per path at a time, so the second names the first's result", async () => {
      let release: () => void = () => {};
      const putFile = vi.fn(
        (_path: string, content: string, _base?: string) =>
          new Promise<PutFileResponse>((resolve) => {
            release = () => resolve({ revision: `after-${content}` });
          }),
      );
      const queue = createSaveQueue({ putFile, delayMs: 10 });
      queue.noteRevision("a.md", "rev-0");
      queue.schedule("a.md", "one");
      await vi.advanceTimersByTimeAsync(10);
      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(10);
      expect(putFile).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(putFile).toHaveBeenLastCalledWith("a.md", "two", "after-one", undefined);
    });

    it("re-keys revisions when a file moves", async () => {
      const { queue, putFile } = setup();
      queue.noteRevision("dir/a.md", "rev-0");
      queue.move("dir", "other");
      queue.schedule("other/a.md", "one");
      await vi.advanceTimersByTimeAsync(500);

      expect(putFile).toHaveBeenCalledWith("other/a.md", "one", "rev-0", undefined);
    });
  });

  describe("conflicts", () => {
    function conflicted() {
      const context = setup();
      context.putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
      context.queue.noteRevision("a.md", "rev-0");
      context.queue.schedule("a.md", "mine");
      return context;
    }

    it("holds a refused save instead of retrying or dropping it", async () => {
      const { queue, putFile, onSaved } = conflicted();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(putFile).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
      expect(queue.state()).toMatchObject({ conflictPaths: ["a.md"], failedPaths: [] });
      expect(queue.hasPending("a.md")).toBe(true);
      expect(queue.pendingContent("a.md")).toBe("mine");
      expect(await queue.flush()).toBe(false);
      expect(putFile).toHaveBeenCalledTimes(1);
    });

    it("keeps the newest edit while held, and writes nothing", async () => {
      const { queue, putFile } = conflicted();
      await vi.advanceTimersByTimeAsync(500);
      queue.schedule("a.md", "mine, edited");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(putFile).toHaveBeenCalledTimes(1);
      expect(queue.pendingContent("a.md")).toBe("mine, edited");
    });

    it("overwrite writes the held content with no base", async () => {
      const { queue, putFile } = conflicted();
      await vi.advanceTimersByTimeAsync(500);
      queue.resolveConflict("a.md", "overwrite");
      await vi.advanceTimersByTimeAsync(0);

      expect(putFile).toHaveBeenLastCalledWith("a.md", "mine", undefined, undefined);
      expect(queue.state().conflictPaths).toEqual([]);
      expect(queue.hasPending()).toBe(false);
    });

    it("discard drops the held content, and the next noted revision is the base", async () => {
      const { queue, putFile } = conflicted();
      await vi.advanceTimersByTimeAsync(500);
      queue.resolveConflict("a.md", "discard");
      expect(queue.hasPending()).toBe(false);

      queue.noteRevision("a.md", "rev-theirs");
      queue.schedule("a.md", "on top of theirs");
      await vi.advanceTimersByTimeAsync(500);
      expect(putFile).toHaveBeenLastCalledWith("a.md", "on top of theirs", "rev-theirs", undefined);
    });
  });

  describe("pausing a path", () => {
    it("keeps edits made while paused, and writes the latest on resume", async () => {
      const { queue, putFile } = setup();
      const resume = queue.pause("a.md");
      queue.schedule("a.md", "one");
      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(putFile).not.toHaveBeenCalled();

      resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(putFile).toHaveBeenCalledTimes(1);
      expect(putFile).toHaveBeenCalledWith("a.md", "two", undefined, undefined);
    });

    it("makes flush() report a paused path unwritten without writing it, and still writes the rest", async () => {
      const { queue, putFile } = setup();
      queue.pause("a.md");
      queue.schedule("a.md", "A");
      queue.schedule("b.md", "B");

      expect(await queue.flush()).toBe(false);
      expect(putFile).toHaveBeenCalledTimes(1);
      expect(putFile).toHaveBeenCalledWith("b.md", "B", undefined, undefined);
      expect(queue.pendingContent("a.md")).toBe("A");
    });

    it("stays paused until every pause is resumed", async () => {
      const { queue, putFile } = setup();
      const first = queue.pause("a.md");
      const second = queue.pause("a.md");
      queue.schedule("a.md", "A");
      first();
      first();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(putFile).not.toHaveBeenCalled();

      second();
      await vi.advanceTimersByTimeAsync(0);
      expect(putFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("rebase", () => {
    const stamp = (content: string) => `${content} +id`;

    it("names the new revision next, and patches content still queued", async () => {
      const { queue, putFile } = setup();
      queue.noteRevision("a.md", "rev-0");
      const resume = queue.pause("a.md");
      queue.schedule("a.md", "typed meanwhile");
      await queue.rebase("a.md", "rev-published", stamp);
      resume();
      await vi.advanceTimersByTimeAsync(0);

      expect(putFile).toHaveBeenCalledWith("a.md", "typed meanwhile +id", "rev-published", undefined);
    });

    it("sets the base for the next edit when nothing is queued", async () => {
      const { queue, putFile } = setup();
      queue.noteRevision("a.md", "rev-0");
      await queue.rebase("a.md", "rev-published", stamp);
      queue.schedule("a.md", "later");
      await vi.advanceTimersByTimeAsync(500);

      expect(putFile).toHaveBeenCalledWith("a.md", "later", "rev-published", undefined);
    });

    it("waits out a write in flight, so that write's result doesn't replace the new base", async () => {
      let release: () => void = () => {};
      const putFile = vi.fn(
        (_path: string, content: string, _base?: string) =>
          new Promise<PutFileResponse>((resolve) => {
            release = () => resolve({ revision: `after-${content}` });
          }),
      );
      const queue = createSaveQueue({ putFile, delayMs: 10 });
      queue.schedule("a.md", "one");
      await vi.advanceTimersByTimeAsync(10);

      const rebased = queue.rebase("a.md", "rev-published", stamp);
      release();
      await rebased;
      queue.schedule("a.md", "two");
      await vi.advanceTimersByTimeAsync(10);

      expect(putFile).toHaveBeenLastCalledWith("a.md", "two", "rev-published", undefined);
    });

    it("patches content held as a conflict, so keeping it keeps the server's change", async () => {
      const { queue, putFile } = setup();
      putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
      queue.schedule("a.md", "mine");
      await vi.advanceTimersByTimeAsync(500);
      await queue.rebase("a.md", "rev-published", stamp);

      expect(queue.pendingContent("a.md")).toBe("mine +id");
      expect(queue.state().conflictPaths).toEqual(["a.md"]);
    });
  });
});

describe("describeUnsaved", () => {
  it("sends the writer to the status bar for a held conflict, by path", () => {
    expect(describeUnsaved({ failedPaths: [], conflictPaths: ["blog/post.md"] }, "moving")).toBe(
      'blog/post.md has a save conflict. Resolve it from "Save conflict" in the status bar before moving.',
    );
  });

  it("names a failing file and why it failed", () => {
    expect(describeUnsaved({ failedPaths: ["a.md"], conflictPaths: [], message: "Network error." }, "syncing")).toBe(
      "a.md couldn't be saved (Network error). It's being retried; try syncing again once saved.",
    );
  });

  it("explains only the one file a single-path flush was for", () => {
    const state = { failedPaths: ["other.md"], conflictPaths: ["another.md"] };
    expect(describeUnsaved(state, "publishing", "blog/post.md")).toBe(
      "Some edits are still waiting to be saved. Try publishing again in a moment.",
    );
  });
});
