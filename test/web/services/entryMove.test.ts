// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type EntryMoveDeps, moveSpaceEntries, moveSpaceEntry } from "../../../web/services/entryMove.ts";

function deps(overrides: Partial<EntryMoveDeps> = {}): EntryMoveDeps {
  return {
    documents: { move: vi.fn(), reloadPaths: vi.fn(async () => []) },
    flushPendingSave: vi.fn(async () => undefined),
    activePath: () => undefined,
    onActivePathMoved: vi.fn(),
    tabs: { repath: vi.fn(() => false), followMove: vi.fn(async () => {}) },
    refreshTree: vi.fn(async () => {}),
    notify: vi.fn(),
    modelConsole: { logEntry: vi.fn() },
    ...overrides,
  };
}

describe("moveSpaceEntry", () => {
  // Any file's unsaved edit blocks a move, not just the moved one's, so the
  // refusal has to say which file — the one moved is usually not it.
  it("refuses while another file holds a save conflict, and names that file", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const moveDeps = deps({
      flushPendingSave: vi.fn(async () => ({ failedPaths: [], conflictPaths: ["blog/post.md"] })),
    });

    expect(await moveSpaceEntry("logo.svg", "logo-light.svg", moveDeps)).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(moveDeps.notify).toHaveBeenCalledWith(
      'blog/post.md has a save conflict. Resolve it from "Save conflict" in the status bar before moving.',
    );
    fetchSpy.mockRestore();
  });

  it("re-points the tabs to where the server put the entry, and re-reads panes after the tree refresh", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ path: "flows-2", rewritten: [], warnings: [] }));
    const order: string[] = [];
    const moveDeps = deps({
      refreshTree: vi.fn(async () => void order.push("refresh")),
      tabs: {
        repath: vi.fn(() => {
          order.push("repath");
          return true;
        }),
        followMove: vi.fn(async () => void order.push("follow")),
      },
    });

    await moveSpaceEntry("flows", "flows-2", moveDeps);
    expect(moveDeps.tabs.repath).toHaveBeenCalledWith("flows", "flows-2");
    expect(moveDeps.tabs.followMove).toHaveBeenCalledWith("flows-2");
    expect(order).toEqual(["repath", "refresh", "follow"]);
    fetchSpy.mockRestore();
  });

  it("re-reads no pane when no open tab moved", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ path: "b.flow.html", rewritten: [], warnings: [] }));
    const moveDeps = deps();

    await moveSpaceEntry("other.flow.html", "b.flow.html", moveDeps);
    expect(moveDeps.tabs.followMove).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("moveSpaceEntries", () => {
  // The server refuses a taken name with its own words, as it does a lone move.
  function serverMoving(refused: string[]) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { from, to } = JSON.parse(String(init?.body)) as { from: string; to: string };
      if (refused.includes(from)) return new Response("Already exists", { status: 409 });
      return Response.json({ path: to, rewritten: [], warnings: [] });
    });
  }

  it("moves each entry, saves and refreshes once, and names every entry that stayed in one message", async () => {
    const fetchSpy = serverMoving(["notes/b.md"]);
    const moveDeps = deps();

    const results = await moveSpaceEntries(
      [
        { from: "notes/a.md", to: "archive/a.md" },
        { from: "notes/b.md", to: "archive/b.md" },
        { from: "notes/c.md", to: "archive/c.md" },
      ],
      moveDeps,
    );
    expect(results.map((moved) => moved?.path)).toEqual(["archive/a.md", undefined, "archive/c.md"]);
    expect(moveDeps.flushPendingSave).toHaveBeenCalledTimes(1);
    expect(moveDeps.refreshTree).toHaveBeenCalledTimes(1);
    expect(moveDeps.notify).toHaveBeenCalledTimes(1);
    expect(moveDeps.notify).toHaveBeenCalledWith("Couldn't move everything.\n\nb.md: Already exists");
    fetchSpy.mockRestore();
  });

  it("gives a lone move's refusal in the server's own words", async () => {
    const fetchSpy = serverMoving(["notes/b.md"]);
    const moveDeps = deps();

    expect(await moveSpaceEntry("notes/b.md", "archive/b.md", moveDeps)).toBeUndefined();
    expect(moveDeps.notify).toHaveBeenCalledWith("Already exists");
    expect(moveDeps.refreshTree).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("follows every moved tab after the one refresh", async () => {
    const fetchSpy = serverMoving([]);
    const order: string[] = [];
    const moveDeps = deps({
      refreshTree: vi.fn(async () => void order.push("refresh")),
      tabs: { repath: vi.fn(() => true), followMove: vi.fn(async (path: string) => void order.push(path)) },
    });

    await moveSpaceEntries(
      [
        { from: "a.md", to: "archive/a.md" },
        { from: "b.md", to: "archive/b.md" },
      ],
      moveDeps,
    );
    expect(order).toEqual(["refresh", "archive/a.md", "archive/b.md"]);
    fetchSpy.mockRestore();
  });

  it("asks nothing of the server, nor saves, when nothing moves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const moveDeps = deps();

    expect(await moveSpaceEntries([], moveDeps)).toEqual([]);
    expect(moveDeps.flushPendingSave).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
