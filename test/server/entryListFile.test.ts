import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeEntryListFile } from "../../src/protocol/entryListFile.ts";
import { EntryListFileError, type EntryListFileKind, readEntryListFile } from "../../src/server/entryListFile.ts";
import { changeEntryListFile } from "../../src/server/spaceFiles.ts";

// One made-up kind stands for the tags, presets, libraries and bookmarks
// files, each of which reads and changes its file through these two.

const LISTS = ["things", "others"];
const things: EntryListFileKind = {
  name: "_things.json",
  at: (spaceRoot) => path.join(spaceRoot, "_things.json"),
  lists: LISTS,
  serialize: (file) => serializeEntryListFile(file, LISTS),
  noList: "_things.json holds no list of things",
  notList: (key) => `_things.json's "${key}" is no list`,
};
const heldThings: EntryListFileKind = {
  ...things,
  at: (spaceRoot) => path.join(spaceRoot, ".held", "_things.json"),
  folder: (spaceRoot) => path.join(spaceRoot, ".held"),
};

let space: string;
let outside: string;
const thingsFile = () => things.at(space);
const hold = (text: string) => writeFileSync(thingsFile(), text);

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-entry-list-"));
  outside = mkdtempSync(path.join(tmpdir(), "pragma-entry-list-outside-"));
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("a list file", () => {
  it("holds nothing when missing or a link, and says why when it exists but doesn't read", () => {
    expect(readEntryListFile(space, things)).toEqual({ file: undefined });
    hold("{ oops");
    expect(readEntryListFile(space, things).problem).toMatch(/^_things\.json doesn't parse: /);
    hold("[1]");
    expect(readEntryListFile(space, things).problem).toBe("_things.json holds no list of things");
    hold('{ "things": [], "others": {} }');
    expect(readEntryListFile(space, things).problem).toBe('_things.json\'s "others" is no list');
    hold('{ "things": ["a"], "kept": 1 }');
    expect(readEntryListFile(space, things)).toEqual({ file: { things: ["a"], kept: 1 } });

    rmSync(thingsFile());
    writeFileSync(path.join(outside, "elsewhere.json"), '{ "things": ["b"] }');
    symlinkSync(path.join(outside, "elsewhere.json"), thingsFile());
    expect(readEntryListFile(space, things)).toEqual({ file: undefined });
  });

  it("refuses to change a file that doesn't read, leaving it as written", async () => {
    hold("{ oops");
    const change = changeEntryListFile(space, things, () => ({ things: ["a"] }));
    await expect(change).rejects.toBeInstanceOf(EntryListFileError);
    await expect(change).rejects.toThrow(/^_things\.json doesn't parse: .*\. Fix the file, then try again\.$/);
    expect(readFileSync(thingsFile(), "utf8")).toBe("{ oops");
  });

  it("writes through no link", async () => {
    writeFileSync(path.join(outside, "elsewhere.json"), "{}");
    symlinkSync(path.join(outside, "elsewhere.json"), thingsFile());
    await expect(changeEntryListFile(space, things, () => ({ things: ["a"] }))).rejects.toMatchObject({ status: 403 });
    expect(readFileSync(path.join(outside, "elsewhere.json"), "utf8")).toBe("{}");
  });

  it("writes a change, keeps a file holding more than empty lists, and removes one holding only those", async () => {
    const onWrite = vi.fn();
    expect(await changeEntryListFile(space, things, () => ({ things: ["a"], kept: 1 }), onWrite)).toEqual({
      things: ["a"],
      kept: 1,
    });
    expect(readFileSync(thingsFile(), "utf8")).toBe(serializeEntryListFile({ things: ["a"], kept: 1 }, LISTS));
    // No change writes nothing, and answers with the file as it stands.
    expect(await changeEntryListFile(space, things, () => undefined, onWrite)).toEqual({ things: ["a"], kept: 1 });
    expect(onWrite).toHaveBeenCalledTimes(1);

    await changeEntryListFile(space, things, () => ({ things: [], kept: 1 }));
    expect(existsSync(thingsFile())).toBe(true);
    await changeEntryListFile(space, things, () => ({ things: [], others: [] }));
    expect(existsSync(thingsFile())).toBe(false);
  });

  it("makes a folder of its own for the file, and removes it with the file once nothing else is in it", async () => {
    await changeEntryListFile(space, heldThings, () => ({ things: ["a"] }));
    expect(existsSync(heldThings.at(space))).toBe(true);
    await changeEntryListFile(space, heldThings, () => ({ things: [] }));
    expect(existsSync(path.join(space, ".held"))).toBe(false);

    await changeEntryListFile(space, heldThings, () => ({ things: ["a"] }));
    mkdirSync(path.join(space, ".held", "other"));
    await changeEntryListFile(space, heldThings, () => ({ things: [] }));
    expect([existsSync(heldThings.at(space)), existsSync(path.join(space, ".held"))]).toEqual([false, true]);
  });
});
