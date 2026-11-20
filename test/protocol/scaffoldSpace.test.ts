import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldSpace } from "../../src/protocol/scaffoldSpace.ts";

const TEMPLATE = fileURLToPath(new URL("../../templates/space", import.meta.url));
let target: string;

beforeEach(async () => {
  target = await mkdtemp(path.join(tmpdir(), "pragma-scaffold-"));
});

afterEach(async () => {
  await rm(target, { recursive: true, force: true });
});

describe("scaffoldSpace", () => {
  it("copies the template space's worked examples", async () => {
    await scaffoldSpace(target);

    expect((await readdir(target)).sort()).toEqual([
      "AGENTS.md",
      "README.md",
      "_presets.json",
      "_tags.json",
      "presets",
      "projects",
    ]);
    expect((await readdir(path.join(target, "presets/templates"))).sort()).toEqual([
      "Daily Note.md",
      "Project",
      "README.md",
    ]);
    expect((await readdir(path.join(target, "projects/getting-started"))).sort()).toEqual([
      "AGENTS.md",
      "README.md",
      "rewrite-selection.flow.html",
      "rewrite.class.html",
      "sample-scene.md",
      "story-dials.applet.html",
      "story-expander.flow.html",
      "writing-prompts.table.html",
    ]);
    expect((await readdir(path.join(target, "projects"))).sort()).toEqual(["getting-started", "translation"]);
    expect((await readdir(path.join(target, "projects/translation"))).sort()).toEqual([
      "AGENTS.md",
      "README.md",
      "_structure.json",
      "brochure.md",
      "jobs.class.html",
      "queries.table.html",
      "style-guide.md",
      "tools",
    ]);
    expect((await readdir(path.join(target, "projects/translation/tools"))).sort()).toEqual([
      "review.flow.html",
      "translate.flow.html",
    ]);
  });

  it("leaves the worked examples out, and what pointed at them, when asked", async () => {
    await scaffoldSpace(target, { examples: false });

    expect((await readdir(target)).sort()).toEqual([
      "AGENTS.md",
      "README.md",
      "_presets.json",
      "_tags.json",
      "presets",
      "projects",
    ]);
    expect(await readdir(path.join(target, "projects"))).toEqual([]);
    expect((await readdir(path.join(target, "presets/templates"))).sort()).toEqual([
      "Daily Note.md",
      "Project",
      "README.md",
    ]);
    expect(await readFile(path.join(target, "_tags.json"), "utf8")).toBe('{\n  "tags": []\n}\n');
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toBe(
      await readFile(path.join(TEMPLATE, "AGENTS.md"), "utf8"),
    );

    // Every link the README keeps lands on something the space has.
    const readme = await readFile(path.join(target, "README.md"), "utf8");
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(([, href]) => href);
    for (const href of links) expect(existsSync(path.join(target, decodeURI(href))), href).toBe(true);
    expect(readme).not.toContain("projects/getting-started");
    expect(readme).toContain("## Where to go from here");
    expect(readme.endsWith("\n")).toBe(true);
  });

  it("copies the README word for word when the examples come along", async () => {
    await scaffoldSpace(target);

    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe(
      await readFile(path.join(TEMPLATE, "README.md"), "utf8"),
    );
    expect(await readFile(path.join(target, "_tags.json"), "utf8")).toBe(
      await readFile(path.join(TEMPLATE, "_tags.json"), "utf8"),
    );
  });

  it("refuses a directory that already holds a README", async () => {
    await writeFile(path.join(target, "README.md"), "mine\n");

    await expect(scaffoldSpace(target)).rejects.toThrow("already exists");
  });

  it("refuses one whose README is spelled in another case", async () => {
    await writeFile(path.join(target, "readme.md"), "mine\n");

    await expect(scaffoldSpace(target)).rejects.toThrow("readme.md already exists");
  });
});
