import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { moveFromTrash, readSpaceFile } from "../../src/server/spaceFiles.ts";
import { tempDir } from "../support/isolation.ts";
import { canLockFolders, lockedFolder } from "../support/lockedFolder.ts";

let space: string;

beforeEach(() => {
  space = tempDir("pragma-space-files-");
});

describe("readSpaceFile", () => {
  it("never reads a LUT as text, whatever the case of its extension", async () => {
    writeFileSync(path.join(space, "Print.CUBE"), "LUT_3D_SIZE 2\n");
    await expect(readSpaceFile(space, "Print.CUBE")).rejects.toThrow(
      "This is a LUT file. Its contents can't be read as text.",
    );
  });
});

describe("moveFromTrash", () => {
  // Every note is listed before any loses its publish state, so a folder it
  // can't read stops the restore with every note as it was.
  it.skipIf(!canLockFolders)("refuses a folder it can't read in full, before touching a note", async () => {
    const published = "---\nid: doc-1\npushed: 2026-10-01T09:00:00.000Z\n---\nBody\n";
    const site = path.join(space, ".trash", "site");
    mkdirSync(path.join(site, "locked"), { recursive: true });
    writeFileSync(path.join(site, "page.md"), published);
    await lockedFolder(path.join(site, "locked"), async () => {
      await expect(moveFromTrash(space, "site", space)).rejects.toThrow(/EACCES/);
    });
    expect(readFileSync(path.join(site, "page.md"), "utf8")).toBe(published);
  });
});
