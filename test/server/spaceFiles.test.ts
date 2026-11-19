import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSpaceFile } from "../../src/server/spaceFiles.ts";

let space: string;

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-space-files-"));
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe("readSpaceFile", () => {
  it("never reads a LUT as text, whatever the case of its extension", async () => {
    writeFileSync(path.join(space, "Print.CUBE"), "LUT_3D_SIZE 2\n");
    await expect(readSpaceFile(space, "Print.CUBE")).rejects.toThrow(
      "This is a LUT file. Its contents can't be read as text.",
    );
  });
});
