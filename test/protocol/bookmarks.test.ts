import { describe, expect, it } from "vitest";
import {
  bookmarkPath,
  bookmarkPaths,
  bookmarksAfterDelete,
  bookmarksAfterMove,
  sameBookmark,
  serializeBookmarksFile,
  withBookmarkChange,
} from "../../src/protocol/bookmarks.ts";

const file = (...paths: string[]) => ({ bookmarks: paths.map((path) => ({ path })) });

describe("a bookmark's path", () => {
  it("is the rooted path in its one spelling", () => {
    expect(bookmarkPath("notes/a.md")).toBe("notes/a.md");
    expect(bookmarkPath("space:notes/a.md")).toBe("notes/a.md");
    expect(bookmarkPath("notes/")).toBe("notes");
    expect(bookmarkPath("lib:refs/moodboard.png")).toBe("lib:refs/moodboard.png");
  });

  // A root is no entry to keep at hand, and nothing under a dot is ever
  // named by a path.
  it("names no root, nothing hidden and nothing unparseable", () => {
    for (const input of ["", "lib:refs", "space:", ".trash/a.md", "notes/.git", "../a.md", "/a.md", "foo:bar"]) {
      expect(bookmarkPath(input), input).toBeUndefined();
    }
  });

  it("compares as entry names do", () => {
    expect(sameBookmark("Notes/Café.md", "notes/café.md")).toBe(true);
    expect(sameBookmark("notes/a.md", "notes/b.md")).toBe(false);
  });
});

describe("reading the file", () => {
  it("lists each bookmark once, in file order, skipping entries with no path", () => {
    const parsed = {
      bookmarks: [{ path: "b.md" }, { title: "a group" }, { path: "a.md" }, { path: "B.md" }, { path: ".hidden" }, 7],
    };
    expect(bookmarkPaths(parsed)).toEqual(["b.md", "a.md"]);
  });

  it("reads nothing from a file without a list", () => {
    expect(bookmarkPaths(undefined)).toEqual([]);
    expect(bookmarkPaths({ bookmarks: "a.md" })).toEqual([]);
  });
});

describe("one change", () => {
  it("adds a bookmark last, once", () => {
    expect(withBookmarkChange(file("a.md"), { add: "b.md" })).toEqual(file("a.md", "b.md"));
    expect(withBookmarkChange(file("a.md"), { add: "A.md" })).toEqual(file("a.md"));
    expect(withBookmarkChange(undefined, { add: "a.md" })).toEqual(file("a.md"));
  });

  it("removes every entry naming the bookmark", () => {
    expect(withBookmarkChange(file("a.md", "b.md", "A.md"), { remove: "a.md" })).toEqual(file("b.md"));
  });

  it("moves a bookmark before another, or last", () => {
    expect(withBookmarkChange(file("a.md", "b.md", "c.md"), { move: "c.md", before: "a.md" })).toEqual(
      file("c.md", "a.md", "b.md"),
    );
    expect(withBookmarkChange(file("a.md", "b.md", "c.md"), { move: "a.md" })).toEqual(file("b.md", "c.md", "a.md"));
    expect(withBookmarkChange(file("a.md", "b.md"), { move: "a.md", before: "gone.md" })).toEqual(file("b.md", "a.md"));
    expect(withBookmarkChange(file("a.md", "b.md"), { move: "gone.md" })).toEqual(file("a.md", "b.md"));
  });

  // A writer keeps what it doesn't read, in the file and in each entry.
  it("keeps every other key and entry", () => {
    const before = {
      $comment: "mine",
      bookmarks: [{ path: "a.md", title: "Start here" }, { title: "a group", items: [] }, { path: "b.md" }],
    };
    expect(withBookmarkChange(before, { move: "a.md" })).toEqual({
      $comment: "mine",
      bookmarks: [{ title: "a group", items: [] }, { path: "b.md" }, { path: "a.md", title: "Start here" }],
    });
  });
});

describe("following the entries", () => {
  it("follows a move of the entry, or of a folder holding it", () => {
    const moved = bookmarksAfterMove(
      { bookmarks: [{ path: "notes/a.md", title: "A" }, { path: "notes" }, { path: "notes-2/b.md" }] },
      "notes",
      "archive/notes",
    );
    expect(moved).toEqual({
      bookmarks: [{ path: "archive/notes/a.md", title: "A" }, { path: "archive/notes" }, { path: "notes-2/b.md" }],
    });
    expect(bookmarksAfterMove(file("lib:refs/a.png"), "lib:refs/a.png", "lib:refs/b.png")).toEqual(
      file("lib:refs/b.png"),
    );
  });

  it("goes with an entry deleted, or a folder holding it", () => {
    expect(bookmarksAfterDelete(file("notes/a.md", "notes", "notes-2/b.md"), "notes")).toEqual(file("notes-2/b.md"));
  });

  it("says when nothing changed", () => {
    expect(bookmarksAfterMove(file("a.md"), "b.md", "c.md")).toBeUndefined();
    expect(bookmarksAfterDelete(file("a.md"), "b.md")).toBeUndefined();
  });
});

describe("writing the file", () => {
  it("writes one line per bookmark, keeping other keys", () => {
    expect(
      serializeBookmarksFile({ $comment: "mine", bookmarks: [{ path: "a.md" }, { path: "lib:refs/b.png" }] }),
    ).toBe(
      '{\n  "$comment": "mine",\n  "bookmarks": [\n    { "path": "a.md" },\n    { "path": "lib:refs/b.png" }\n  ]\n}\n',
    );
    expect(serializeBookmarksFile({ bookmarks: [] })).toBe('{\n  "bookmarks": []\n}\n');
  });
});
