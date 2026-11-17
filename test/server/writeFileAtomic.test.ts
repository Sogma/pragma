import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/server/spaceFiles.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes a new file and replaces an existing one", async () => {
    const target = path.join(dir, "note.md");

    await writeFileAtomic(target, "first");
    expect(readFileSync(target, "utf8")).toBe("first");

    await writeFileAtomic(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  it("leaves no temp file behind", async () => {
    await writeFileAtomic(path.join(dir, "note.md"), "content");

    expect(readdirSync(dir)).toEqual(["note.md"]);
  });

  // The failure this exists for: a plain writeFile truncates first, so a
  // write that dies partway leaves the old content destroyed and the new
  // content nowhere. Here the original has to survive untouched.
  it("keeps the previous contents when the write fails", async () => {
    const target = path.join(dir, "note.md");
    writeFileSync(target, "the good copy");

    // A directory in the temp file's place makes the write fail the same way
    // a full disk would, without needing one.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "");

    await expect(writeFileAtomic(path.join(blocked, "note.md"), "new")).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("the good copy");
  });
});
