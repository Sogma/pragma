import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isVisible, visiblePaths } from "../../src/server/agentSurface.ts";

// What the agent API will read has to be exactly what it lists: a file the
// per-path check admits but the listing hides would be a disclosure, and one
// it refuses but the listing shows would be a document no caller can open.

let space: string;
let outside: string;

function write(relative: string, content = "text\n"): void {
  const file = path.join(space, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Every file on disk under `dir`, links included but never followed.
function onDisk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? onDisk(path.join(dir, entry.name), relative) : [relative];
  });
}

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-surface-"));
  outside = mkdtempSync(path.join(tmpdir(), "pragma-surface-outside-"));
  write("a.md", "# A\n");
  write("notes/b.md");
  write("notes/deep/c.fountain", "INT. HOUSE - DAY\n");
  write("notes/.hidden.md");
  write("img.png");
  write("paper.pdf", "%PDF-1.4\n");
  write("_tags.json", "{}\n");
  write("script.py");
  write(".trash/old.md");
  write(".git/config");
  write("secret.md", "---\nvisibility: private\n---\n\nsecret\n");
  write("broken.md", "---\ntitle: Chapter 1: The Start\n---\n\nbroken\n");
  write(
    "cast.table.html",
    '<html data-format="table"><body><dl data-role="metadata"><dt>visibility</dt><dd>private</dd></dl></body></html>',
  );
  writeFileSync(path.join(outside, "x.md"), "outside\n");
  symlinkSync(path.join(space, "a.md"), path.join(space, "alias.md"));
  symlinkSync(outside, path.join(space, "outdir"));
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

it("admits by path exactly the files the listing holds", async () => {
  const candidates = [...onDisk(space), "outdir/x.md", "./a.md", "notes//b.md", "../a.md"];
  const admitted: string[] = [];
  for (const candidate of candidates) if (await isVisible(space, candidate)) admitted.push(candidate);
  expect(admitted.sort()).toEqual((await visiblePaths(space)).sort());
  expect(admitted.sort()).toEqual(["a.md", "img.png", "notes/b.md", "notes/deep/c.fountain", "paper.pdf"]);
});
