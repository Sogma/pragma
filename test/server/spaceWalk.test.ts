import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkSpace } from "../../src/server/spaceWalk.ts";
import { canLockFolders, lockedFolder } from "../support/lockedFolder.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pragma-space-walk-"));
  mkdirSync(path.join(root, "notes", "drafts"), { recursive: true });
  writeFileSync(path.join(root, "notes", "a.md"), "");
  writeFileSync(path.join(root, "notes", "drafts", "b.md"), "");
  writeFileSync(path.join(root, "top.fountain"), "");
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "config"), "");
  writeFileSync(path.join(root, ".hidden.md"), "");
  symlinkSync(path.join(root, "notes"), path.join(root, "linked"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("walkSpace", () => {
  it("lists every file and folder under a folder, relative with /, passing over dot entries and links", async () => {
    const { files, folders } = await walkSpace(root, "fail");
    expect(files.sort()).toEqual(["notes/a.md", "notes/drafts/b.md", "top.fountain"]);
    expect(folders.sort()).toEqual(["notes", "notes/drafts"]);
  });

  it.skipIf(!canLockFolders)("finds nothing in a folder it can't list, or fails, as asked", async () => {
    await lockedFolder(path.join(root, "notes", "drafts"), async () => {
      const { files, folders } = await walkSpace(root, "skip");
      expect(files.sort()).toEqual(["notes/a.md", "top.fountain"]);
      expect(folders.sort()).toEqual(["notes", "notes/drafts"]);
      await expect(walkSpace(root, "fail")).rejects.toThrow(/EACCES/);
    });
  });
});
