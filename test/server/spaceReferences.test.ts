import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClassFile } from "../../src/protocol/classFile.ts";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import { parseFrontmatter } from "../../src/protocol/frontmatter.ts";
import { parseTableFile } from "../../src/protocol/tableFile.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import { emptyClass } from "../../src/protocol/types.ts";
import { rewriteMovedReferences } from "../../src/server/spaceReferences.ts";
import { tempDir } from "../support/isolation.ts";

// The move → rewrite path end to end, over a real directory: a file or
// folder is renamed on disk exactly as the route does it, and then the paths
// that named it are expected to still name it, written as a new one would be.
async function space(files: Record<string, string>): Promise<string> {
  const root = tempDir("pragma-refs-test-");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function move(root: string, from: string, to: string) {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await rename(path.join(root, from), path.join(root, to));
  return rewriteMovedReferences(root, from, to);
}

function read(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

const SCOPE = "---\npragma:\n---\n";

describe("paths to a moved file", () => {
  it("retargets a wikilink, keeping a `.md` the author wrote", async () => {
    const root = await space({
      "index.md": "See [[notes/plan]] and [[notes/plan.md]].",
      "notes/plan.md": "# Plan",
    });

    const result = await move(root, "notes/plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe("See [[archive/plan]] and [[archive/plan.md]].");
    expect(result.rewritten).toEqual(["index.md"]);
  });

  it("finds a link past a byte order mark, and writes the document back without one", async () => {
    const root = await space({
      "index.md": "\uFEFF[plan]: notes/plan.md\n\nSee [[notes/plan]].",
      "notes/plan.md": "# Plan",
    });

    await move(root, "notes/plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe("[plan]: archive/plan.md\n\nSee [[archive/plan]].");
  });

  it("finds a wikilink whatever case it spells the path in", async () => {
    const root = await space({ "index.md": "See [[Notes/PLAN]].", "notes/plan.md": "# Plan" });

    await move(root, "notes/plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe("See [[archive/plan]].");
  });

  it("renames a wikilink whose file was renamed", async () => {
    const root = await space({ "notes/index.md": "See [[plan]].", "notes/plan.md": "# Plan" });

    await move(root, "notes/plan.md", "notes/roadmap.md");

    expect(await read(root, "notes/index.md")).toBe("See [[roadmap]].");
  });

  it("keeps the display half of a piped wikilink", async () => {
    const root = await space({ "notes/index.md": "See [[plan|the plan]].", "notes/plan.md": "# Plan" });

    await move(root, "notes/plan.md", "notes/roadmap.md");

    expect(await read(root, "notes/index.md")).toBe("See [[roadmap|the plan]].");
  });

  // A wikilink is a path: one that only named its file by name names
  // nothing, so a move has nothing of it to keep, and no collision to report.
  it("leaves a wikilink that names nothing as it was, and warns of nothing", async () => {
    const root = await space({ "index.md": "See [[plan]].", "notes/plan.md": "# Plan", "archive/draft.md": "" });

    const result = await move(root, "notes/plan.md", "notes/draft.md");

    expect(await read(root, "index.md")).toBe("See [[plan]].");
    expect(result).toEqual({ rewritten: [], warnings: [] });
  });

  it("retargets relative links and images", async () => {
    const root = await space({
      "guide/index.md": "[plan](./plan.md) and ![shot](../art/shot.png)",
      "guide/plan.md": "# Plan",
      "art/shot.png": "",
    });

    await move(root, "guide/plan.md", "archive/plan.md");

    expect(await read(root, "guide/index.md")).toBe("[plan](../archive/plan.md) and ![shot](../art/shot.png)");
  });

  it("retargets a percent-encoded destination a substring replace would miss", async () => {
    const root = await space({ "index.md": "[x](./my%20plan.md)", "my plan.md": "# Plan" });

    await move(root, "my plan.md", "archive/my plan.md");

    expect(await read(root, "index.md")).toBe("[x](archive/my%20plan.md)");
  });

  // Written fresh from its place: the two share the space's scope.
  it("rewrites a path from the root by the writing rule", async () => {
    const root = await space({ "guide/index.md": "[x](/notes/plan.md)", "notes/plan.md": "# Plan" });

    await move(root, "notes/plan.md", "archive/plan.md");

    expect(await read(root, "guide/index.md")).toBe("[x](../archive/plan.md)");
  });

  it("preserves a fragment on a retargeted link", async () => {
    const root = await space({ "index.md": "[x](./plan.md#goals)", "plan.md": "# Plan" });

    await move(root, "plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe("[x](archive/plan.md#goals)");
  });

  it("never touches an external URL or a same-document anchor", async () => {
    const source = "[a](https://example.com/plan.md) [b](mailto:x@y.z) [c](#plan)";
    const root = await space({ "index.md": source, "plan.md": "# Plan" });

    const result = await move(root, "plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe(source);
    expect(result.rewritten).toEqual([]);
  });

  // A regex over the raw text would edit the sample; the parser never
  // reports a reference inside code at all.
  it("never rewrites a reference inside a code fence or inline code", async () => {
    const source = "```\n[[plan]] [x](./plan.md)\n```\n\nand `[[plan]]` too.\n";
    const root = await space({ "index.md": source, "plan.md": "# Plan" });

    const result = await move(root, "plan.md", "archive/plan.md");

    expect(await read(root, "index.md")).toBe(source);
    expect(result.rewritten).toEqual([]);
  });

  it("leaves a link whose target only shares a path prefix with the moved one", async () => {
    const root = await space({
      "index.md": "[a](./projects/ab.md) [b](./projects/a.md)",
      "projects/ab.md": "",
      "projects/a.md": "",
    });

    await move(root, "projects/a.md", "moved/a.md");

    expect(await read(root, "index.md")).toBe("[a](./projects/ab.md) [b](moved/a.md)");
  });
});

describe("paths a moved document writes", () => {
  it("rebases a relative link when the document itself moves", async () => {
    const root = await space({
      "guide/index.md": "[plan](./plan.md)",
      "guide/plan.md": "# Plan",
    });

    await move(root, "guide/index.md", "index.md");

    expect(await read(root, "index.md")).toBe("[plan](guide/plan.md)");
  });

  it("leaves a library embed alone when the document moves", async () => {
    const root = await space({ "guide/index.md": "![hero](lib:footage/stills/hero.png)" });

    await move(root, "guide/index.md", "index.md");

    expect(await read(root, "index.md")).toBe("![hero](lib:footage/stills/hero.png)");
  });

  it("leaves a link alone when document and target move together", async () => {
    const root = await space({
      "guide/index.md": "[plan](./plan.md)",
      "guide/plan.md": "# Plan",
    });

    const result = await move(root, "guide", "archive/guide");

    expect(await read(root, "archive/guide/index.md")).toBe("[plan](./plan.md)");
    expect(result.rewritten).toEqual([]);
  });

  it("rebases a moved document's link to a target that stayed put", async () => {
    const root = await space({
      "guide/index.md": "[art](../art/shot.png)",
      "art/shot.png": "",
    });

    await move(root, "guide", "a/b/guide");

    expect(await read(root, "a/b/guide/index.md")).toBe("[art](../../../art/shot.png)");
  });
});

describe("moving a folder", () => {
  it("retargets paths to every file inside it, in both directions", async () => {
    const root = await space({
      "index.md": "[one](./notes/one.md) and [[notes/two]]",
      "notes/one.md": "[two](./two.md) and [up](../index.md)",
      "notes/two.md": "# Two",
    });

    const result = await move(root, "notes", "archive/notes");

    expect(await read(root, "index.md")).toBe("[one](archive/notes/one.md) and [[archive/notes/two]]");
    expect(await read(root, "archive/notes/one.md")).toBe("[two](./two.md) and [up](../../index.md)");
    expect(result.rewritten.sort()).toEqual(["archive/notes/one.md", "index.md"]);
  });

  it("retargets a link to the folder itself", async () => {
    const root = await space({ "index.md": "[[notes/]] and [n](notes/) and [m](notes)", "notes/two.md": "" });

    await move(root, "notes", "archive/notes");

    expect(await read(root, "index.md")).toBe("[[archive/notes/]] and [n](archive/notes/) and [m](archive/notes/)");
  });
});

describe("paths and scopes", () => {
  // The point of writing a scope's own paths relative: the scope moves as a
  // unit and none of them need touching.
  it("rewrites none of a scope's own paths when its folder moves", async () => {
    const root = await space({
      "projects/a/AGENTS.md": `${SCOPE}See [[scenes/one]].`,
      "projects/a/scenes/one.md": "Bob is [[../cast/bob|Bob]].",
      "projects/a/cast/bob.md": "# Bob",
    });

    const result = await move(root, "projects/a", "archive/a");

    expect(await read(root, "archive/a/AGENTS.md")).toBe(`${SCOPE}See [[scenes/one]].`);
    expect(await read(root, "archive/a/scenes/one.md")).toBe("Bob is [[../cast/bob|Bob]].");
    expect(result.rewritten).toEqual([]);
  });

  it("rebases a relative link when its document moves within the scope", async () => {
    const root = await space({
      "projects/a/AGENTS.md": SCOPE,
      "projects/a/scenes/one.md": "[[../cast/bob]]",
      "projects/a/cast/bob.md": "# Bob",
    });

    await move(root, "projects/a/scenes/one.md", "projects/a/one.md");

    expect(await read(root, "projects/a/one.md")).toBe("[[cast/bob]]");
  });

  // Written fresh from its new place, a link back into the old scope is one
  // that crosses a scope's edge: a path from the root.
  it("writes a link from the root once its document leaves the scope", async () => {
    const root = await space({
      "projects/a/AGENTS.md": SCOPE,
      "projects/a/one.md": "[[cast/bob]]",
      "projects/a/cast/bob.md": "# Bob",
      "projects/b/AGENTS.md": SCOPE,
    });

    await move(root, "projects/a/one.md", "projects/b/one.md");

    expect(await read(root, "projects/b/one.md")).toBe("[[/projects/a/cast/bob]]");
  });

  it("retargets a relative link whose target moved within the scope", async () => {
    const root = await space({
      "projects/a/AGENTS.md": SCOPE,
      "projects/a/one.md": "[[cast/bob.md|Bob]]",
      "projects/a/cast/bob.md": "# Bob",
    });

    await move(root, "projects/a/cast/bob.md", "projects/a/people/bob.md");

    expect(await read(root, "projects/a/one.md")).toBe("[[people/bob.md|Bob]]");
  });

  it("writes a path from the root relative once its target moves into the document's scope", async () => {
    const root = await space({
      "projects/a/AGENTS.md": SCOPE,
      "projects/a/one.md": "[[/projects/b/bob]]",
      "projects/b/bob.md": "# Bob",
    });

    await move(root, "projects/b/bob.md", "projects/a/bob.md");

    expect(await read(root, "projects/a/one.md")).toBe("[[bob]]");
  });

  // A path into a nested scope crosses its edge, so it is written from the
  // root, and moving the outer scope breaks it: the move rewrites it.
  it("rewrites a path into a nested scope when the outer one moves", async () => {
    const root = await space({
      "projects/sogma/AGENTS.md": `${SCOPE}[[/projects/sogma/pragma/x]]`,
      "projects/sogma/pragma/AGENTS.md": SCOPE,
      "projects/sogma/pragma/x.md": "",
    });

    await move(root, "projects/sogma", "archive/sogma");

    expect(await read(root, "archive/sogma/AGENTS.md")).toBe(`${SCOPE}[[/archive/sogma/pragma/x]]`);
  });
});

describe("paths other documents hold", () => {
  it("retargets a Table's media values and its drop folder", async () => {
    const table = serializeTableFile({
      version: "1.0",
      columns: [{ id: "image", type: "media", label: "Image", mediaFolder: "../renders/" }],
      rows: [{ values: { image: "../renders/a.png" } }, { values: { image: "" } }],
    });
    const root = await space({ "shots/log.table.html": table, "renders/a.png": "" });

    const result = await move(root, "renders", "art/renders");

    const file = parseTableFile(await read(root, "shots/log.table.html"));
    expect(file?.rows.map((row) => row.values.image)).toEqual(["../art/renders/a.png", ""]);
    expect(file?.columns[0].mediaFolder).toBe("../art/renders/");
    expect(result.rewritten).toEqual(["shots/log.table.html"]);
  });

  it("retargets the Flows a Table links", async () => {
    const table = serializeTableFile({
      version: "1.0",
      columns: [{ id: "title", type: "text", label: "Title" }],
      rows: [],
      links: ["../tools/clips.flow.html"],
    });
    const root = await space({ "shots/log.table.html": table, "tools/clips.flow.html": "" });

    const result = await move(root, "tools/clips.flow.html", "flows/clips.flow.html");

    expect(parseTableFile(await read(root, "shots/log.table.html"))?.links).toEqual(["../flows/clips.flow.html"]);
    expect(result.rewritten).toEqual(["shots/log.table.html"]);
  });

  it("retargets a Table's path values, a folder's keeping its slash", async () => {
    const table = serializeTableFile({
      version: "1.0",
      columns: [
        { id: "ref", type: "path", label: "Ref" },
        { id: "note", type: "text", label: "Note" },
      ],
      rows: [{ values: { ref: "../refs/a.md", note: "../refs/a.md" } }, { values: { ref: "../refs/", note: "" } }],
    });
    const root = await space({ "shots/log.table.html": table, "refs/a.md": "" });

    await move(root, "refs", "archive/refs");

    const file = parseTableFile(await read(root, "shots/log.table.html"));
    expect(file?.rows.map((row) => [row.values.ref, row.values.note])).toEqual([
      ["../archive/refs/a.md", "../refs/a.md"],
      ["../archive/refs/", ""],
    ]);
  });

  // A Folder value is written from the Class's scope, so it follows the
  // folder it names through a move, and the Class through one into another
  // scope. A pattern names no one folder and stays as written.
  it("retargets the folders a Class's Folder rules name", async () => {
    const folder = (test: string, ...values: string[]) => ({ property: "file.folder", test, values });
    const classFile = serializeClassFile({
      ...emptyClass(),
      filter: [folder("is", "projects/notes", "projects"), folder("is", "*/lyrics")],
      views: [{ name: "Notes", layout: "list", filter: [folder("within", "projects/notes")] }],
    });
    const root = await space({
      "projects/c.class.html": classFile,
      "projects/notes/a.md": "",
      "music/AGENTS.md": "---\npragma:\n---\n",
    });
    const rules = async (at: string) => {
      const parsed = parseClassFile(await read(root, at));
      return [...(parsed?.filter ?? []), ...(parsed?.views[0].filter ?? [])].map((rule) => rule.values);
    };

    await move(root, "projects/notes", "projects/archive/notes");
    expect(await rules("projects/c.class.html")).toEqual([
      ["projects/archive/notes", "projects"],
      ["*/lyrics"],
      ["projects/archive/notes"],
    ]);

    await move(root, "projects/c.class.html", "music/c.class.html");
    expect(await rules("music/c.class.html")).toEqual([
      ["/projects/archive/notes", "/projects"],
      ["*/lyrics"],
      ["/projects/archive/notes"],
    ]);
  });

  it("leaves a Class's own scope as . when the scope moves with it", async () => {
    const classFile = serializeClassFile({
      ...emptyClass(),
      filter: [{ property: "file.folder", test: "within", values: ["."] }],
    });
    const root = await space({ "music/AGENTS.md": "---\npragma:\n---\n", "music/c.class.html": classFile });

    await move(root, "music", "archive/music");

    expect(parseClassFile(await read(root, "archive/music/c.class.html"))?.filter[0].values).toEqual(["."]);
  });

  // It names whichever folder the Class is in, so no move rewrites it, and a
  // folder given that name is written behind `./` to stay a folder.
  it("leaves this.file.folder as written, and escapes a folder of that name", async () => {
    const classFile = serializeClassFile({
      ...emptyClass(),
      filter: [{ property: "file.folder", test: "is", values: ["this.file.folder", "old"] }],
    });
    const root = await space({ "projects/c.class.html": classFile, "old/a.md": "" });
    const values = async (at: string) => parseClassFile(await read(root, at))?.filter[0].values;

    await move(root, "projects", "work/projects");
    expect(await values("work/projects/c.class.html")).toEqual(["this.file.folder", "old"]);

    await move(root, "old", "this.file.folder");
    expect(await values("work/projects/c.class.html")).toEqual(["this.file.folder", "./this.file.folder"]);
  });

  it("retargets a file a Class links, and its links when the Class moves", async () => {
    const classFile = serializeClassFile({ ...emptyClass(), links: ["../tools/polish.flow.html"] });
    const root = await space({ "projects/c.class.html": classFile, "tools/polish.flow.html": "<html></html>" });
    const links = async (at: string) => parseClassFile(await read(root, at))?.links;

    await move(root, "tools/polish.flow.html", "kits/polish.flow.html");
    expect(await links("projects/c.class.html")).toEqual(["../kits/polish.flow.html"]);

    await move(root, "projects/c.class.html", "projects/songs/c.class.html");
    expect(await links("projects/songs/c.class.html")).toEqual(["../../kits/polish.flow.html"]);
  });

  // docs/protocol.md's Tags: a declared tag holds no path, so a key naming
  // one stays as written.
  it("leaves _tags.json as written", async () => {
    const tags = `{\n  "tags": [\n    { "name": "rewrite", "toolkit": "tools/rewrite.flow.html" },\n    { "name": "plain" }\n  ]\n}\n`;
    const root = await space({ "_tags.json": tags, "tools/rewrite.flow.html": "<html></html>" });

    await move(root, "tools/rewrite.flow.html", "kits/rewrite.flow.html");

    expect(await read(root, "_tags.json")).toBe(tags);
  });

  // A key no setting declares is someone else's, kept as written.
  it("retargets the folders an AGENTS.md's settings name, and only those", async () => {
    const agents = "---\npragma:\n  screenplay:\n    world: world/\n  lookup: [world/]\n---\n# Film\n";
    const root = await space({
      "projects/film/AGENTS.md": agents,
      "projects/film/world/lina.md": "",
    });

    await move(root, "projects/film/world", "projects/film/lore");

    const { data } = parseFrontmatter(await read(root, "projects/film/AGENTS.md"));
    expect(data.pragma).toEqual({ screenplay: { world: "lore/" }, lookup: ["world/"] });
  });

  // Grants are pinned to a Flow's code, and a rewrite no one made there would
  // leave them behind.
  it("leaves a Flow's paths as written", async () => {
    const flow =
      '<html><body><script type="application/json" data-role="graph">{"nodes":[{"id":"n","type":"loadNote","config":{"notePath":"notes/a.md"}}],"edges":[]}</script></body></html>';
    const root = await space({ "tools/read.flow.html": flow, "tools/notes/a.md": "" });

    const result = await move(root, "tools/notes/a.md", "tools/notes/b.md");

    expect(await read(root, "tools/read.flow.html")).toBe(flow);
    expect(result.rewritten).toEqual([]);
  });
});

describe("one bad document", () => {
  // One unparseable file must not abort the whole pass and leave every other
  // document silently un-rewritten.
  it("does not stop the rest of the space being rewritten", async () => {
    const root = await space({
      "broken.md": "---\ncover: [x](./nope.md)\n---\n\nSee [[plan]].",
      "fine.md": "See [[plan]].",
      "plan.md": "# Plan",
    });

    const result = await move(root, "plan.md", "archive/roadmap.md");

    expect(await read(root, "fine.md")).toBe("See [[archive/roadmap]].");
    expect(result.rewritten).toContain("fine.md");
  });
});

describe("documents that hold no references", () => {
  // Fountain spells its Notes `[[...]]` too (web/formats/screenplay/language.ts's
  // INLINE_PATTERNS), so a screenplay's "[[cut this?]]" is prose. Widening
  // the scan past Markdown would start editing scripts.
  it("never touches a .fountain file, whose [[...]] is a Note and not a link", async () => {
    const source = "INT. ROOM - DAY\n\nShe turns. [[writing-prompts]] He leaves.\n";
    const root = await space({ "scene.fountain": source, "writing-prompts.md": "# Prompts" });

    const result = await move(root, "writing-prompts.md", "archive/writing-prompts.md");

    expect(await read(root, "scene.fountain")).toBe(source);
    expect(result.rewritten).toEqual([]);
  });
});
