import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyClass } from "../../src/protocol/classFile.ts";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import {
  createDocumentIndex,
  documentIndex,
  type IndexRoot,
  installDocumentIndex,
} from "../../src/server/documentIndex.ts";
import { tempDir } from "../support/isolation.ts";

const folder = () => tempDir("pragma-document-index-");

async function write(root: string, relative: string, content: string): Promise<string> {
  const absolute = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

const note = (content: string) => write(folder(), "note.md", content);

const spaceAt = (dir: string): IndexRoot => ({ dir, root: "space" });

// Runs before anything else here asks the process's index a question.
describe("the process's index", () => {
  it("is the host's own when installed before anything asks, and refuses a later one", () => {
    const own = createDocumentIndex();
    installDocumentIndex(own);
    expect(documentIndex()).toBe(own);
    expect(documentIndex()).toBe(own);
    expect(() => installDocumentIndex(createDocumentIndex())).toThrow();
  });
});

// The head is read a chunk at a time, and must find the block a whole-file
// read finds.
describe("frontmatter", () => {
  it("reads a block past a byte order mark, and none below a first line that isn't `---`", async () => {
    const index = createDocumentIndex();
    expect(index.frontmatter(await note("﻿---\nstatus: done\n---\n\nText"))).toEqual({ status: "done" });
    expect(index.frontmatter(await note("\n---\nstatus: done\n---\n"))).toEqual({});
  });

  it("reads on when a chunk ends inside a longer line that starts `---`", async () => {
    // The first 4096 bytes end on the `---` of `---x: 1`.
    const head = `---\nnotes: ${"x".repeat(4081)}\n`;
    expect(Buffer.byteLength(`${head}---`)).toBe(4096);
    const data = createDocumentIndex().frontmatter(await note(`${head}---x: 1\nstatus: done\n---\n\nText`));
    expect(data).toMatchObject({ "---x": 1, status: "done" });
  });

  it("reads a block that closes many chunks in, and none from a large file whose block never closes", async () => {
    const index = createDocumentIndex();
    const long = await note(`---\nnotes: ${"x".repeat(50_000)}\nstatus: done\n---\n\n# Title\n`);
    expect(index.noteHead(long)).toEqual({ data: { notes: "x".repeat(50_000), status: "done" }, title: "Title" });
    // About 8 MB, which takes seconds when the head is decoded whole again per 4 KB chunk.
    const unclosed = await note(`---\n${"status: open\n".repeat(650_000)}`);
    const started = performance.now();
    expect(index.frontmatter(unclosed)).toEqual({});
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("says why a block doesn't parse", async () => {
    const head = createDocumentIndex().noteHead(await note("---\nstatus: [open\n---\n\n# Title\n"));
    expect(head.data).toEqual({});
    expect(head.title).toBe("Title");
    expect(head.error).toEqual(expect.any(String));
  });
});

describe("one file's entry", () => {
  it("is trusted while the file is unchanged, and read again whole once it changes", async () => {
    const index = createDocumentIndex();
    const file = await note("---\nstatus: draft\n---\n\n# First\n\nOpening.\n");
    const describe = vi.fn((text: string) => text.split("\n").at(-2));
    expect(index.noteHead(file)).toEqual({ data: { status: "draft" }, title: "First" });
    expect(index.description(file, describe)).toBe("Opening.");
    expect(index.description(file, describe)).toBe("Opening.");
    expect(describe).toHaveBeenCalledTimes(1);

    await writeFile(file, "---\nstatus: done\n---\n\n# Second title\n\nAnother opening.\n");
    expect(index.noteHead(file)).toEqual({ data: { status: "done" }, title: "Second title" });
    expect(index.description(file, describe)).toBe("Another opening.");
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it("reads a title and an opening past comments longer than the head it reads", async () => {
    const index = createDocumentIndex();
    const file = await note(`<!--\n${"license line\n".repeat(1000)}-->\n\n# Title\n\nOpening.\n`);
    expect(index.noteHead(file).title).toBe("Title");
    expect(index.noteExcerpt(file, 1000)).toBe("Opening.");
  });

  it("reads a note's opening, and reads it again once the note changes", async () => {
    const index = createDocumentIndex();
    const file = await note("# Title\n\nFirst draft.\n");
    expect(index.noteExcerpt(file, 1000)).toBe("First draft.");
    await writeFile(file, "# Title\n\nThe second draft.\n");
    expect(index.noteExcerpt(file, 1000)).toBe("The second draft.");
  });

  it("is never made for a link or a missing file", async () => {
    const index = createDocumentIndex();
    const root = folder();
    const target = await write(root, "target.md", "---\nstatus: done\n---\n\n# Target\n");
    const link = path.join(root, "link.md");
    await symlink(target, link);
    expect(index.frontmatter(link)).toEqual({});
    expect(index.noteHead(link)).toEqual({ data: {}, title: undefined });
    expect(index.noteExcerpt(path.join(root, "missing.md"), 1000)).toBeUndefined();
    expect(index.size).toBe(0);
  });
});

describe("a root's check", () => {
  it("drops the entry of a file that changed, forgets one that went, and leaves other roots alone", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const library = folder();
    const changed = await write(space, "changed.md", "---\nstatus: draft\n---\n");
    const gone = await write(space, "gone.md", "---\nstatus: draft\n---\n");
    const kept = await write(space, "deep/kept.md", "---\nstatus: draft\n---\n");
    const elsewhere = await write(library, "elsewhere.md", "---\nstatus: draft\n---\n");
    for (const file of [changed, gone, kept, elsewhere]) index.frontmatter(file);
    expect(index.size).toBe(4);

    await writeFile(changed, "---\nstatus: done, and longer\n---\n");
    await unlink(gone);
    await index.check(spaceAt(space));
    expect(index.size).toBe(3);
    expect(index.frontmatter(changed)).toEqual({ status: "done, and longer" });
    expect(index.size).toBe(3);
  });

  it("forgets an entry inside a dot folder or behind a link, which no path names", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const hidden = await write(space, ".trash/old.md", "---\nstatus: draft\n---\n");
    await symlink(path.join(space, ".trash"), path.join(space, "linked"));
    index.frontmatter(hidden);
    index.frontmatter(path.join(space, "linked", "old.md"));
    expect(index.size).toBe(2);
    await index.check(spaceAt(space));
    expect(index.size).toBe(0);
  });

  it("is shared by a question asked while it runs, and runs anew after", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "note.md", "# Note\n");
    const first = index.check(spaceAt(space));
    expect(index.check(spaceAt(space))).toBe(first);
    await first;
    expect(index.check(spaceAt(space))).not.toBe(first);
  });
});

describe("backlinks", () => {
  const linking = (answer: { path: string }[]) => answer.map((backlink) => backlink.path);

  it("lists each note whose own text links to a note, with the line and place of each mention", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    await write(space, "a.md", "# A\n\nSee [[plan]] and [[Plan]].\n");
    await write(space, "x/b.md", "[the plan](../plan.md)\r\n");
    expect(await index.backlinks("plan.md", [spaceAt(space)])).toEqual([
      {
        path: "a.md",
        mentions: [
          { line: 3, text: "See [[plan]] and [[Plan]].", at: 6, length: 4 },
          { line: 3, text: "See [[plan]] and [[Plan]].", at: 19, length: 4 },
        ],
      },
      { path: "x/b.md", mentions: [{ line: 1, text: "[the plan](../plan.md)", at: 11, length: 10 }] },
    ]);
  });

  it("counts no embed, web link, folder link, or link in code or frontmatter", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    await write(space, "embed.md", "![](plan.md)\n");
    await write(space, "web.md", "[plan](https://example.com/plan.md) and [mail](mailto:plan.md)\n");
    await write(space, "folder.md", "[[plan/]]\n");
    await write(space, "code.md", "`[[plan]]`\n\n```\n[[plan]]\n```\n");
    await write(space, "front.md", "---\nsee: [[plan]]\n---\n\nBody.\n");
    expect(await index.backlinks("plan.md", [spaceAt(space)])).toEqual([]);
  });

  it("reads a link as a path from the note's own folder, or from the root, as the resolver does", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "notes/plan.md", "# Plan\n");
    await write(space, "notes/sibling.md", "[[plan]]\n");
    await write(space, "other/far.md", "[[plan]] names other/plan, and [[/notes/plan]] names the note\n");
    await write(space, "other/encoded.md", "[it](../notes/plan.md) and [spaced](my%20note.md)\n");
    await write(space, "other/my note.md", "# Spaced\n");
    expect(linking(await index.backlinks("notes/plan.md", [spaceAt(space)]))).toEqual([
      "notes/sibling.md",
      "other/encoded.md",
      "other/far.md",
    ]);
    const far = (await index.backlinks("notes/plan.md", [spaceAt(space)])).find((b) => b.path === "other/far.md");
    expect(far?.mentions.map((mention) => mention.at)).toEqual([33]);
    expect(linking(await index.backlinks("other/my note.md", [spaceAt(space)]))).toEqual(["other/encoded.md"]);
  });

  it("counts a wikilink that leaves off `.md` only while it names that one file", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    await write(space, "a.md", "[[plan]] and [[plan.md]]\n");
    expect(await index.backlinks("plan.md", [spaceAt(space)])).toEqual([
      {
        path: "a.md",
        mentions: [
          { line: 1, text: "[[plan]] and [[plan.md]]", at: 2, length: 4 },
          { line: 1, text: "[[plan]] and [[plan.md]]", at: 15, length: 7 },
        ],
      },
    ]);
    // A file named `plan` beside it makes `[[plan]]` name neither.
    await write(space, "plan", "no kind");
    const [only] = await index.backlinks("plan.md", [spaceAt(space)]);
    expect(only.mentions.map((mention) => mention.at)).toEqual([15]);
  });

  it("leaves out a note's links to itself, and a preset's links to a note outside the presets", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const isPreset = (path: string) => path.startsWith("presets/");
    await write(space, "plan.md", "# Plan\n\nSee [[plan]].\n");
    await write(space, "presets/brief.md", "[[/plan]] and [[outline]]\n");
    await write(space, "presets/outline.md", "# Outline\n");
    expect(await index.backlinks("plan.md", [spaceAt(space)], isPreset)).toEqual([]);
    expect(linking(await index.backlinks("presets/outline.md", [spaceAt(space)], isPreset))).toEqual([
      "presets/brief.md",
    ]);
  });

  it("reads a library note's from its library and from the space", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const library = folder();
    await write(library, "refs/plan.md", "# Plan\n");
    await write(library, "inside.md", "[[refs/plan]]\n");
    await write(space, "outside.md", "[[lib:refs-lib/refs/plan]] and [this](lib:refs-lib/refs/plan.md)\n");
    await write(space, "refs/plan.md", "# Not the library's\n");
    const roots = [{ dir: library, root: { library: "refs-lib" } }, spaceAt(space)];
    expect(linking(await index.backlinks("lib:refs-lib/refs/plan.md", roots))).toEqual([
      "lib:refs-lib/inside.md",
      "outside.md",
    ]);
    expect(await index.backlinks("refs/plan.md", [spaceAt(space)])).toEqual([]);
  });

  it("follows edits, new notes and deletions between two questions", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    const a = await write(space, "a.md", "[[plan]]\n");
    const b = await write(space, "b.md", "[[plan]]\n");
    expect(linking(await index.backlinks("plan.md", [spaceAt(space)]))).toEqual(["a.md", "b.md"]);

    await writeFile(a, "No link any more.\n");
    await unlink(b);
    await write(space, "c.md", "Now [[plan]].\n");
    expect(linking(await index.backlinks("plan.md", [spaceAt(space)]))).toEqual(["c.md"]);
    expect(await index.backlinks("gone.md", [spaceAt(space)])).toEqual([]);
  });

  it("keeps a note filed when a question about that one file read it again in between", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    const a = await write(space, "a.md", "[[plan]]\n");
    expect(linking(await index.backlinks("plan.md", [spaceAt(space)]))).toEqual(["a.md"]);
    await writeFile(a, "---\nstatus: done\n---\n\nStill [[plan]].\n");
    expect(index.frontmatter(a)).toEqual({ status: "done" });
    expect(linking(await index.backlinks("plan.md", [spaceAt(space)]))).toEqual(["a.md"]);
  });
});

describe("classes", () => {
  const classFile = (name: string, links: string[] = []) => serializeClassFile({ ...emptyClass(), name, links });
  const names = (classes: { definition: { name?: string } }[]) =>
    classes.map(({ definition }) => definition.name ?? "").sort();

  it("lists each Class under a root with its definition, but one that doesn't read as one or no path names", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "shots.class.html", classFile("Shots", ["refs/guide.md"]));
    await write(space, "deep/cast.class.html", classFile("Cast"));
    await write(space, "broken.class.html", "<table>not a Class</table>");
    await write(space, ".hidden/secret.class.html", classFile("Secret"));
    const listed = await index.classes(spaceAt(space));
    expect(listed.map(({ path }) => path).sort()).toEqual(["deep/cast.class.html", "shots.class.html"]);
    expect(listed.find(({ path }) => path === "shots.class.html")?.definition.links).toEqual(["refs/guide.md"]);
  });

  it("reads a Class again once it changes, and sees one added or gone at the next question", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const shots = await write(space, "shots.class.html", classFile("Shots"));
    expect(names(await index.classes(spaceAt(space)))).toEqual(["Shots"]);
    await writeFile(shots, classFile("Shot list"));
    await write(space, "cast.class.html", classFile("Cast"));
    expect(names(await index.classes(spaceAt(space)))).toEqual(["Cast", "Shot list"]);
    await unlink(shots);
    expect(names(await index.classes(spaceAt(space)))).toEqual(["Cast"]);
  });
});

describe("tags", () => {
  const byPath = (documents: { path: string; tags: unknown[] }[]) =>
    Object.fromEntries(documents.map(({ path, tags }) => [path, tags]));

  it("lists a note's frontmatter tags and those written in its text, where each sits, and a Table's metadata tags", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "a.md", "---\ntags: [Draft, night]\n---\n\nSee #rain and\n  `#code` #Draft\n");
    await write(space, "b.md", "---\ntags: poetry\n---\nNo inline tags.\n");
    await write(space, "c.md", "Nothing here.\n");
    await write(
      space,
      "shots.table.html",
      '<table><caption><dl data-role="metadata"><dt>tags</dt><dd>reel</dd></dl></caption></table>\n',
    );
    await write(space, "notes.txt", "#plain text\n");
    expect(byPath(await index.tagged(spaceAt(space)))).toEqual({
      "a.md": [
        { name: "Draft" },
        { name: "night" },
        { name: "rain", line: 5, text: "See #rain and", at: 4 },
        { name: "Draft", line: 6, text: "  `#code` #Draft", at: 10 },
      ],
      "b.md": [{ name: "poetry" }],
      "shots.table.html": [{ name: "reel" }],
    });
  });

  it("sees a tag added, edited or gone at the next question", async () => {
    const index = createDocumentIndex();
    const space = folder();
    const a = await write(space, "a.md", "#one\n");
    expect(byPath(await index.tagged(spaceAt(space)))["a.md"]).toEqual([{ name: "one", line: 1, text: "#one", at: 0 }]);
    await writeFile(a, "---\ntags: [two]\n---\n#three\n");
    await write(space, "b.md", "#four\n");
    const tagged = byPath(await index.tagged(spaceAt(space)));
    expect(tagged["a.md"]).toEqual([{ name: "two" }, { name: "three", line: 4, text: "#three", at: 0 }]);
    expect(tagged["b.md"]).toEqual([{ name: "four", line: 1, text: "#four", at: 0 }]);
    await writeFile(a, "No tags.\n");
    expect(Object.keys(byPath(await index.tagged(spaceAt(space))))).toEqual(["b.md"]);
  });

  it("answers one note's tags written in its text, and keeps its links for the next check", async () => {
    const index = createDocumentIndex();
    const space = folder();
    await write(space, "plan.md", "# Plan\n");
    const a = await write(space, "a.md", "#todo [[plan]] #Later\n");
    expect(index.inlineTags(a)).toEqual(["todo", "Later"]);
    expect((await index.backlinks("plan.md", [spaceAt(space)])).map((link) => link.path)).toEqual(["a.md"]);
  });
});
