import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookmarksAfterMove } from "../../src/protocol/bookmarks.ts";
import {
  BookmarksFileError,
  changeSpaceBookmark,
  keepSpaceBookmarks,
  readSpaceBookmarks,
} from "../../src/server/spaceBookmarks.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";

let space: string;
let configDir: string;
let library: string;

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-bookmarks-space-"));
  library = mkdtempSync(path.join(tmpdir(), "pragma-bookmarks-library-"));
  // A library's folder sits in the config, so each test has its own.
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-bookmarks-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  giveSpaceLibraries(configDir, space, [{ id: "refs", label: "Refs", path: library, access: "read-only" }]);
  mkdirSync(path.join(space, "notes"));
  writeFileSync(path.join(space, "notes", "a.md"), "# A\n");
  writeFileSync(path.join(library, "moodboard.png"), "");
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  for (const dir of [space, library, configDir]) rmSync(dir, { recursive: true, force: true });
});

const bookmarksFile = () => path.join(space, ".pragma", "bookmarks.json");
const hold = (value: unknown) => {
  mkdirSync(path.join(space, ".pragma"), { recursive: true });
  writeFileSync(bookmarksFile(), typeof value === "string" ? value : JSON.stringify(value));
};

describe("the space's bookmarks", () => {
  it("holds none without a file", () => {
    expect(readSpaceBookmarks(space)).toEqual({ bookmarks: [] });
  });

  it("says what each bookmark names on disk, a missing one with no type", () => {
    hold({
      bookmarks: [{ path: "notes/a.md" }, { path: "notes" }, { path: "lib:refs/moodboard.png" }, { path: "gone.md" }],
    });
    expect(readSpaceBookmarks(space).bookmarks).toEqual([
      { path: "notes/a.md", type: "file" },
      { path: "notes", type: "directory" },
      { path: "lib:refs/moodboard.png", type: "file" },
      { path: "gone.md" },
    ]);
  });

  it("names nothing through a library this install doesn't have", () => {
    hold({ bookmarks: [{ path: "lib:elsewhere/a.png" }] });
    expect(readSpaceBookmarks(space).bookmarks).toEqual([{ path: "lib:elsewhere/a.png" }]);
  });

  it("names nothing through a link", () => {
    symlinkSync(path.join(space, "notes"), path.join(space, "linked"));
    hold({ bookmarks: [{ path: "linked/a.md" }] });
    expect(readSpaceBookmarks(space).bookmarks).toEqual([{ path: "linked/a.md" }]);
  });

  it("adds a bookmark into .pragma/, one line each", async () => {
    expect(await changeSpaceBookmark(space, { add: "notes/a.md" })).toEqual({
      bookmarks: [{ path: "notes/a.md", type: "file" }],
    });
    await changeSpaceBookmark(space, { add: "notes" });
    expect(readFileSync(bookmarksFile(), "utf8")).toBe(
      '{\n  "bookmarks": [\n    { "path": "notes/a.md" },\n    { "path": "notes" }\n  ]\n}\n',
    );
  });

  it("adds only an entry that exists", async () => {
    await expect(changeSpaceBookmark(space, { add: "gone.md" })).rejects.toThrow("Not found: gone.md");
    expect(existsSync(path.join(space, ".pragma"))).toBe(false);
  });

  it("leaves no file, and no folder, once the last bookmark goes", async () => {
    await changeSpaceBookmark(space, { add: "notes/a.md" });
    expect(await changeSpaceBookmark(space, { remove: "notes/a.md" })).toEqual({ bookmarks: [] });
    expect(existsSync(path.join(space, ".pragma"))).toBe(false);
  });

  it("keeps a folder that holds something else", async () => {
    await changeSpaceBookmark(space, { add: "notes/a.md" });
    writeFileSync(path.join(space, ".pragma", "other.json"), "{}");
    await changeSpaceBookmark(space, { remove: "notes/a.md" });
    expect(existsSync(bookmarksFile())).toBe(false);
    expect(existsSync(path.join(space, ".pragma", "other.json"))).toBe(true);
  });

  // A hand edit gone wrong survives until someone fixes it.
  it("reports a file that doesn't read, and never writes over it", async () => {
    hold('{ "bookmarks": [ { "path": "notes/a.md" }, ] }');
    const read = readSpaceBookmarks(space);
    expect(read.bookmarks).toEqual([]);
    expect(read.problem).toMatch(/^\.pragma\/bookmarks\.json doesn't parse: /);
    await expect(changeSpaceBookmark(space, { add: "notes/a.md" })).rejects.toBeInstanceOf(BookmarksFileError);
    await keepSpaceBookmarks(space, (file) => bookmarksAfterMove(file, "notes", "archive"));
    expect(readFileSync(bookmarksFile(), "utf8")).toBe('{ "bookmarks": [ { "path": "notes/a.md" }, ] }');
  });

  it("reports a file holding no list", () => {
    hold({ bookmarks: "notes/a.md" });
    expect(readSpaceBookmarks(space)).toEqual({
      bookmarks: [],
      problem: ".pragma/bookmarks.json holds no list of bookmarks",
    });
  });

  it("refuses to write through a linked folder", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "pragma-bookmarks-elsewhere-"));
    try {
      symlinkSync(elsewhere, path.join(space, ".pragma"));
      await expect(changeSpaceBookmark(space, { add: "notes/a.md" })).rejects.toThrow("symbolic link");
      expect(existsSync(path.join(elsewhere, "bookmarks.json"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("keeps a bookmark on its entry, and writes nothing when none follows", async () => {
    await changeSpaceBookmark(space, { add: "notes/a.md" });
    await keepSpaceBookmarks(space, (file) => bookmarksAfterMove(file, "notes", "archive/notes"));
    expect(JSON.parse(readFileSync(bookmarksFile(), "utf8"))).toEqual({ bookmarks: [{ path: "archive/notes/a.md" }] });
    rmSync(path.join(space, ".pragma"), { recursive: true });
    await keepSpaceBookmarks(space, (file) => bookmarksAfterMove(file, "notes", "elsewhere"));
    expect(existsSync(path.join(space, ".pragma"))).toBe(false);
  });
});
