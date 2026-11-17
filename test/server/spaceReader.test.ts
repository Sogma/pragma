import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpaceReader, type SpaceReaderOptions } from "../../src/server/spaceReader.ts";

// The reads every model surface shares, as the copilot and the agent API take
// them: no read limit, paths relative to the space. A generation's look, with
// its budget, is tested in contextLook.test.ts.

const PRIVATE = "---\nvisibility: private\n---\n\n";

let space: string;
let outside: string;

function write(relative: string, content: string): void {
  const file = path.join(space, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function reader(options: Partial<SpaceReaderOptions> = {}) {
  return createSpaceReader({
    spaceRoot: space,
    scope: "",
    where: "the space",
    limits: { answer: 20_000, matches: 50, line: 200 },
    ...options,
  });
}

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-reader-"));
  outside = mkdtempSync(path.join(tmpdir(), "pragma-reader-outside-"));
  write("cast/README.md", "---\ndescription: Who is who\n---\n\n# Cast\n");
  write("cast/lina.md", "---\ndescription: The lead\n---\n\n# Lina\n\nCopper hair. [Rory](rory.md)\n");
  write("cast/rory.md", "# Rory\n\nLina's brother.\n");
  write("cast/secret.md", `${PRIVATE}Lina's secret.\n`);
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("a read with no limit", () => {
  const look = `# Look\n\n## Lighting\n\n${"Warm light. ".repeat(3000)}\n\n## Camera\n\nWide lenses.\n`;

  it("hands over a long note whole, since a whole new text may be proposed from it", async () => {
    write("look.md", look);
    expect(await reader().read("look.md")).toBe(look);
  });

  it("reads one section of a note by its heading, and names the headings when none matches", async () => {
    write("look.md", look);
    const files = reader();
    expect(await files.read("look.md", "camera")).toBe("## Camera\n\nWide lenses.");
    const missing = await files.read("look.md", "Sound");
    expect(missing).toMatch(/^look\.md has no section "Sound"\. look\.md is 36,\d{3} characters\./);
    expect(missing).toContain("## Lighting (36,");
    expect(missing).toContain("## Camera (23)");
  });
});

describe("a list", () => {
  it("shows each folder ahead of what it holds, with the link to name it by and its description", async () => {
    const linkTo = (spacePath: string, folder: boolean) => `[[${spacePath}${folder ? "/" : ""}]]`;
    const listed = await reader({ folders: true, descriptions: true, linkTo }).list();
    expect(listed.split("\n")).toEqual([
      "cast/ (link [[cast/]]): Who is who",
      "cast/lina.md (link [[cast/lina.md]]): The lead",
      "cast/README.md (link [[cast/README.md]]): Who is who",
      "cast/rory.md (link [[cast/rory.md]])",
    ]);
  });

  it("stops where an answer's limit falls, saying how to see the rest", async () => {
    const listed = await reader({ limits: { answer: 20, matches: 50 } }).list();
    expect(listed).toBe("cast/lina.md\n(The list stops here. List one of its folders to see the rest.)");
  });
});

it("holds each matching line to its limit", async () => {
  write("long.md", `${"word ".repeat(100)}needle ${"word ".repeat(100)}\n`);
  const found = await reader().search("needle");
  expect(found).toMatch(/^long\.md:1: word word .{180,}…$/);
  expect(found.length).toBeLessThan(220);
});

describe("what a read admits", () => {
  it("reads only what the tree lists where only the listed are read", async () => {
    write("_tags.json", '{"tags": {}}\n');
    expect(await reader({ listedOnly: true }).read("_tags.json")).toBe("There's no file at _tags.json in the space.");
    expect(await reader().read("_tags.json")).toBe('{"tags": {}}\n');
  });

  it("answers a private file as a missing one, and tells whoever started the reads", async () => {
    const files = reader();
    expect(await files.read("cast/secret.md")).toBe("There's no file at cast/secret.md in the space.");
    expect(files.trace.messages).toEqual([{ level: "warn", text: "Left out cast/secret.md: it's private." }]);
  });

  it("follows no link out of the space, lists no hidden folder and climbs out of nothing", async () => {
    writeFileSync(path.join(outside, "secret.md"), "outside words\n");
    symlinkSync(outside, path.join(space, "outdir"));
    symlinkSync(path.join(outside, "secret.md"), path.join(space, "out.md"));
    write(".git/config", "url = https://plum-token@example.com\n");
    const files = reader();
    for (const written of ["outdir/secret.md", "out.md", ".git/config", "../secret.md"]) {
      expect(await files.read(written)).toBe(`There's no file at ${written} in the space.`);
    }
    expect(await files.list("outdir")).toBe("There's no folder at outdir in the space.");
    expect(await files.list(".git")).toBe("There's no folder at .git in the space.");
  });

  it("matches a path written another way: from the root, or in other letter case", async () => {
    const files = reader();
    expect(await files.read("/cast/rory.md")).toBe("# Rory\n\nLina's brother.\n");
    expect(await files.read("./cast/../cast/RORY.md")).toBe("# Rory\n\nLina's brother.\n");
  });
});

it("names a file's links, each with the link to name it by, and none it may not show", async () => {
  write("cast/notes.md", "[Lina](lina.md) and [the secret](secret.md)\n");
  const linkTo = (spacePath: string) => `[[${spacePath}]]`;
  expect(await reader({ linkTo }).links("cast/notes.md")).toBe("Links to:\ncast/lina.md (link [[cast/lina.md]])");
});
