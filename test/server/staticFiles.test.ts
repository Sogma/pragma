import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStaticFile } from "../../src/server/staticFiles.ts";

let root: string;
let outside: string;

beforeEach(() => {
  outside = mkdtempSync(path.join(tmpdir(), "pragma-static-"));
  root = path.join(outside, "web");
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<p>editor</p>");
  writeFileSync(path.join(root, "welcome.html"), "<p>welcome</p>");
  writeFileSync(path.join(root, "assets", "welcome.js"), "start();");
  writeFileSync(path.join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

// The editor's server and the desktop app's first-run window both serve the
// build through this, so neither may reach a file outside it.
describe("readStaticFile", () => {
  it("serves an exact file with its media type, and index.html for the root", async () => {
    expect(await readStaticFile(root, "/assets/welcome.js")).toEqual({
      content: Buffer.from("start();"),
      type: "text/javascript; charset=utf-8",
    });
    expect((await readStaticFile(root, "/"))?.content.toString()).toBe("<p>editor</p>");
    expect((await readStaticFile(root, "/welcome.html"))?.type).toBe("text/html; charset=utf-8");
  });

  it("finds nothing for a missing file, a path out of the build or a malformed one", async () => {
    expect(await readStaticFile(root, "/missing.js")).toBeUndefined();
    expect(await readStaticFile(root, "/../secret.txt")).toBeUndefined();
    expect(await readStaticFile(root, "/%2E%2E/secret.txt")).toBeUndefined();
    expect(await readStaticFile(root, "/%E0%A4%A")).toBeUndefined();
  });
});
