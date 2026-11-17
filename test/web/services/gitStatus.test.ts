import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module + fresh fetch mock per test — gitStatusStore is a
// module-level singleton (matching main.ts's own single shared instance),
// so each test needs its own isolated copy rather than sharing state
// through vitest's module cache across tests.
async function freshStore() {
  vi.resetModules();
  const mod = await import("../../../web/services/gitStatus.ts");
  return mod.gitStatusStore;
}

describe("gitStatusStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts in the loading phase", async () => {
    const store = await freshStore();
    expect(store.get()).toEqual({ phase: "loading" });
  });

  it("subscribe() fires immediately with the current state", async () => {
    const store = await freshStore();
    const seen: unknown[] = [];
    store.subscribe((state) => seen.push(state));
    expect(seen).toEqual([{ phase: "loading" }]);
  });

  it("refresh() transitions to ready on a successful fetch", async () => {
    const store = await freshStore();
    const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    await store.refresh();
    expect(store.get()).toEqual({ phase: "ready", status });
  });

  it("refresh() transitions to error on a failed fetch, keeping the last known status", async () => {
    const store = await freshStore();
    const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }));
    await store.refresh();

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await store.refresh();
    const state = store.get();
    expect(state.phase).toBe("error");
    expect(state.phase === "error" && state.last).toEqual(status);
  });

  it("coalesces concurrent refresh() calls into one in-flight request", async () => {
    const store = await freshStore();
    const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    const [a, b] = [store.refresh(), store.refresh()];
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("update() adopts a status obtained elsewhere without fetching", async () => {
    const store = await freshStore();
    const status = { isRepo: true as const, branch: "main", ahead: 1, behind: 2, files: [] };
    store.update(status);
    expect(store.get()).toEqual({ phase: "ready", status });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("noteLocalChange() recounts once writes settle, skipping the remote fetch", async () => {
    vi.useFakeTimers();
    try {
      const store = await freshStore();
      store.update({ isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] });
      const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [{ path: "a.md", statusCode: " M" }] };
      fetchMock.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));

      store.noteLocalChange();
      await vi.advanceTimersByTimeAsync(600);
      store.noteLocalChange();
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/git/status?fetch=0");
      expect(store.get()).toEqual({ phase: "ready", status });
    } finally {
      vi.useRealTimers();
    }
  });

  it("noteLocalChange() has nothing to recount while loading, outside a repo, or in restricted mode", async () => {
    vi.useFakeTimers();
    try {
      const store = await freshStore();
      store.noteLocalChange();
      store.update({ isRepo: false });
      store.noteLocalChange();
      store.update({ isRepo: true, restricted: true, trust: "declined" });
      store.noteLocalChange();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a full read answers for a local one, and runs after one already under way", async () => {
    vi.useFakeTimers();
    try {
      const store = await freshStore();
      store.update({ isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] });
      const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };
      let release: (response: Response) => void = () => undefined;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
      fetchMock.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));

      store.noteLocalChange();
      await vi.advanceTimersByTimeAsync(1000);
      const full = store.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release(new Response(JSON.stringify(status), { status: 200 }));
      await full;
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        expect.stringContaining("?fetch=0"),
        expect.not.stringContaining("fetch=0"),
      ]);

      // While a full read is in flight, a local one joins it.
      let releaseFull: (response: Response) => void = () => undefined;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseFull = resolve)));
      const again = store.refresh();
      store.noteLocalChange();
      await vi.advanceTimersByTimeAsync(1000);
      releaseFull(new Response(JSON.stringify(status), { status: 200 }));
      await again;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a read that lands after a git action handed in its own result", async () => {
    const store = await freshStore();
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    const read = store.refresh();
    const committed = { isRepo: true as const, branch: "main", ahead: 1, behind: 0, files: [] };
    store.update(committed);
    const stale = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [{ path: "a.md", statusCode: "M " }] };
    release(new Response(JSON.stringify(stale), { status: 200 }));
    await read;
    expect(store.get()).toEqual({ phase: "ready", status: committed });
  });

  it("notifies subscribers on every state change", async () => {
    const store = await freshStore();
    const seen: string[] = [];
    store.subscribe((state) => seen.push(state.phase));
    store.update({ isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] });
    store.update({ isRepo: false });
    expect(seen).toEqual(["loading", "ready", "ready"]);
  });

  it("refreshOnFocus() fetches at most once per interval, and never while a git action runs", async () => {
    const store = await freshStore();
    const status = { isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    // The clock, not timers: the store coalesces in-flight fetches, so the
    // first one has to settle before a later call can be expected to fetch.
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      store.refreshOnFocus(() => true);
      expect(fetchMock).not.toHaveBeenCalled();

      store.refreshOnFocus(() => false);
      store.refreshOnFocus(() => false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await store.refresh(); // joins the in-flight fetch; starts none

      now.mockReturnValue(100_000 + 14_999);
      store.refreshOnFocus(() => false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now.mockReturnValue(100_000 + 15_000);
      store.refreshOnFocus(() => false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
