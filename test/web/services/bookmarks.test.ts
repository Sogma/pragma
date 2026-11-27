import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceBookmarksResponse } from "../../../src/protocol/api.ts";
import type { Tab } from "../../../web/core/apiClient.ts";
import * as workspace from "../../../web/core/workspace.ts";
import { bookmarkTargetOf, createBookmarks } from "../../../web/services/bookmarks.ts";
import type { CommandContext } from "../../../web/services/commands.ts";

const answer = (...paths: string[]): SpaceBookmarksResponse => ({
  bookmarks: paths.map((path) => ({ path, type: "file" })),
});

// A promise the test settles when it chooses.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("the bookmark list", () => {
  it("holds each answer, a read's or a change's", async () => {
    const api = {
      fetch: vi.fn(async () => answer("a.md")),
      change: vi.fn(async () => answer("a.md", "b.md")),
    };
    const bookmarks = createBookmarks(api);
    const heard = vi.fn();
    bookmarks.subscribe(heard);
    expect(bookmarks.loaded()).toBe(false);
    await bookmarks.read();
    expect(bookmarks.loaded()).toBe(true);
    expect(bookmarks.list().map((bookmark) => bookmark.path)).toEqual(["a.md"]);
    expect(bookmarks.has("A.md")).toBe(true);
    await bookmarks.change({ add: "b.md" });
    expect(api.change).toHaveBeenCalledWith({ add: "b.md" });
    expect(bookmarks.has("b.md")).toBe(true);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("holds none after a read that fails, and says why", async () => {
    const bookmarks = createBookmarks({
      fetch: async () => {
        throw new Error("The server is down");
      },
      change: async () => answer(),
    });
    await bookmarks.read();
    expect(bookmarks.list()).toEqual([]);
    expect(bookmarks.problem()).toBe("The server is down");
  });

  it("passes on a change that fails", async () => {
    const bookmarks = createBookmarks({
      fetch: async () => answer(),
      change: async () => {
        throw new Error("Not found: gone.md");
      },
    });
    await expect(bookmarks.change({ add: "gone.md" })).rejects.toThrow("Not found: gone.md");
  });

  // A read answered after a change landed may hold the file from before it.
  it("drops a read that a change overtook", async () => {
    const slow = deferred<SpaceBookmarksResponse>();
    const bookmarks = createBookmarks({ fetch: () => slow.promise, change: async () => answer("a.md") });
    const reading = bookmarks.read();
    await bookmarks.change({ add: "a.md" });
    slow.resolve(answer());
    await reading;
    expect(bookmarks.has("a.md")).toBe(true);
  });
});

describe("what a menu's bookmark items act on", () => {
  const context = (tab: Tab): CommandContext => ({ tab, pane: undefined });
  const none = context({ kind: "empty" });

  afterEach(() => {
    workspace.focusedGroup().tabs = [{ kind: "empty" }];
  });

  it("is a tree row, the space's or a library's", () => {
    expect(bookmarkTargetOf({ node: { type: "file", path: "notes/a.md" } }, none)).toBe("notes/a.md");
    expect(
      bookmarkTargetOf({ root: { library: "refs" }, node: { type: "directory", path: "lib:refs/stills" } }, none),
    ).toBe("lib:refs/stills");
    expect(bookmarkTargetOf({ node: null }, none)).toBeUndefined();
  });

  it("is a Bookmarks row's own bookmark", () => {
    expect(bookmarkTargetOf({ bookmark: "notes", folder: "notes" }, none)).toBe("notes");
  });

  it("is the tab a tab's menu names, or the focused one for the palette", () => {
    const group = workspace.focusedGroup();
    group.tabs = [
      { kind: "gallery", path: "stills" },
      { kind: "find-context", path: "notes", result: { results: [] } as never },
    ];
    expect(bookmarkTargetOf({ groupId: group.id, index: 0 }, none)).toBe("stills");
    expect(bookmarkTargetOf({ groupId: group.id, index: 1 }, none)).toBeUndefined();
    expect(bookmarkTargetOf(undefined, context({ kind: "pdf", path: "lib:refs/brief.pdf" }))).toBe(
      "lib:refs/brief.pdf",
    );
    expect(bookmarkTargetOf(undefined, none)).toBeUndefined();
  });

  it("is nothing for an entry no bookmark can name", () => {
    expect(bookmarkTargetOf(undefined, context({ kind: "gallery", path: "" }))).toBeUndefined();
    expect(bookmarkTargetOf({ node: { type: "file", path: ".trash/a.md" } }, none)).toBeUndefined();
    expect(bookmarkTargetOf({ file: "notes/a.md" }, none)).toBeUndefined();
  });
});
