import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APICallError, RetryError } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EffortLevel } from "../../src/protocol/api.ts";
import { type ContextLook, LOOK_REACH, lookFurther, refusesTools } from "../../src/server/contextLook.ts";
import { CONTEXT_FILE_LIMIT, placeContext, readContext } from "../../src/server/pathContext.ts";

import { listRootPaths } from "../../src/server/tree.ts";

// Conformance tests for docs/protocol.md's Context of a path, past its
// starting files: what the model's tools let it see, in the scope's folder
// only and never a private file, and what the trace tells the person.

const WORLD_SCOPE = "---\npragma:\n  screenplay:\n    world: world/\n---\n\n";
const TENT = "projects/story/screenplay/02 Tent.fountain";
const PRIVATE = "---\nvisibility: private\n---\n\n";

let space: string;
let clock: number;

function write(relative: string, content: string): void {
  const file = path.join(space, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const { rounds: LOOK_ROUNDS, total: LOOK_LIMIT, timeMs: LOOK_TIME_MS } = LOOK_REACH.medium;

// The trace's messages at one level, as their sentences.
const said = (look: ContextLook, level: "info" | "warn") =>
  look.trace.messages.filter((message) => message.level === level).map((message) => message.text);

async function lookFrom(relative: string, effort?: EffortLevel): Promise<ContextLook> {
  const listing = await listRootPaths(space, "space");
  const place = placeContext(listing, relative);
  if (!place) throw new Error(`nothing at ${relative}`);
  const { files } = await readContext(space, listing, place);
  return await lookFurther(
    space,
    listing,
    place,
    files.map((file) => file.path),
    { effort, now: () => clock },
  );
}

async function call(look: ContextLook, name: string, input: object): Promise<string> {
  const execute = look.tools.set[name].execute;
  if (!execute) throw new Error(`${name} runs nothing`);
  return String(await execute(input, { toolCallId: "t", messages: [], context: {} } as never));
}

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-look-"));
  clock = 0;
  write("AGENTS.md", "# Space rules\n");
  write("top.md", "# Top\n\nLina at the top.\n");
  write("other/notes.md", "Lina outside the scope.\n");
  write("projects/story/AGENTS.md", `${WORLD_SCOPE}# story\n`);
  write("projects/story/README.md", "# Story\n");
  write("projects/story/world/Lina.md", "# Lina\n\nCopper hair.\n");
  write("projects/story/world/Rory.md", `${PRIVATE}# Rory\n\nLina's brother.\n`);
  write(
    "projects/story/notes/arc.md",
    "---\ndescription: Where Lina ends up\n---\n\nLina goes home. [Lina](../world/Lina.md)\n",
  );
  write("projects/story/notes/secret.md", `${PRIVATE}Lina's secret. [Lina](../world/Lina.md)\n`);
  write("projects/story/screenplay/01 Opening.fountain", "LINA\nHome is south.\n");
  write(TENT, "LINA\nWhere?\n");
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe("listing the scope", () => {
  it("lists its files with their descriptions, never a private file or one outside it", async () => {
    const listed = (await call(await lookFrom(TENT), "list_space_files", {})).split("\n");
    expect(listed).toContain("/projects/story/notes/arc.md: Where Lina ends up");
    expect(listed).toContain("/projects/story/screenplay/01 Opening.fountain");
    expect(listed.indexOf("/projects/story/screenplay/01 Opening.fountain")).toBeLessThan(
      listed.indexOf("/projects/story/screenplay/02 Tent.fountain"),
    );
    expect(listed.join("\n")).not.toMatch(/Rory|secret|other|top\.md/);
  });

  it("lists one folder of it, and no folder outside it", async () => {
    const look = await lookFrom(TENT);
    expect((await call(look, "list_space_files", { folder: "/projects/story/screenplay/" })).split("\n")).toEqual([
      "/projects/story/screenplay/01 Opening.fountain",
      "/projects/story/screenplay/02 Tent.fountain",
    ]);
    expect(await call(look, "list_space_files", { folder: "/other" })).toBe(
      "There's no folder at /other in /projects/story/.",
    );
  });
});

describe("searching the scope", () => {
  it("finds lines in its files only, never a private file's or the connected file's, and records the search", async () => {
    const look = await lookFrom(TENT);
    const found = await call(look, "search_space_files", { query: "lina" });
    expect(found).toContain("/projects/story/notes/arc.md:5: Lina goes home.");
    expect(found).toContain("/projects/story/screenplay/01 Opening.fountain:1: LINA");
    expect(found).not.toMatch(/secret|Rory|other|top\.md|02 Tent/);
    expect(look.trace.searches).toEqual(["lina"]);
  });

  it("says when nothing matches", async () => {
    expect(await call(await lookFrom(TENT), "search_space_files", { query: "zeppelin" })).toBe(
      'Nothing in /projects/story/ matches "zeppelin".',
    );
  });
});

describe("reading a file", () => {
  it("reads a file in the scope once, by any spelling of its path, and the trace names it", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: "projects/story/screenplay/01 opening.fountain" })).toBe(
      "LINA\nHome is south.\n",
    );
    expect(await call(look, "read_space_file", { path: "/projects/story/screenplay/01 Opening.fountain" })).toBe(
      "You've read that file already.",
    );
    expect(look.trace.files).toEqual(["/projects/story/screenplay/01 Opening.fountain"]);
    expect(look.found()).toEqual([
      { path: "/projects/story/screenplay/01 Opening.fountain", content: "LINA\nHome is south.\n" },
    ]);
  });

  it("reads a path written from the scope's folder, as a model often writes it", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: "notes/arc.md" })).toContain("Lina goes home.");
    expect(look.trace.files).toEqual(["/projects/story/notes/arc.md"]);
  });

  it("answers a starting file and the connected file without reading them again", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: "/projects/story/world/Lina.md" })).toBe(
      "That file came with the instruction.",
    );
    expect(await call(look, "read_space_file", { path: `/${TENT}` })).toMatch(/the file the context is for/);
    expect(look.trace.files).toEqual([]);
  });

  it("finds no file outside the scope or private, as for a missing one, and tells the person which", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: "/other/notes.md" })).toBe(
      "There's no file at /other/notes.md in /projects/story/.",
    );
    expect(await call(look, "read_space_file", { path: "/projects/story/notes/secret.md" })).toBe(
      "There's no file at /projects/story/notes/secret.md in /projects/story/.",
    );
    expect(await call(look, "read_space_file", { path: "/projects/story/gone.md" })).toBe(
      "There's no file at /projects/story/gone.md in /projects/story/.",
    );
    expect(said(look, "warn")).toEqual([
      "Left out /other/notes.md: it's outside /projects/story/.",
      "Left out /projects/story/notes/secret.md: it's private.",
    ]);
  });

  it("cuts a file over its share and says so", async () => {
    write("projects/story/notes/long.md", "x".repeat(CONTEXT_FILE_LIMIT + 500));
    const look = await lookFrom(TENT);
    const read = await call(look, "read_space_file", { path: "/projects/story/notes/long.md" });
    expect(read.startsWith("x".repeat(CONTEXT_FILE_LIMIT))).toBe(true);
    expect(read).toMatch(/\(Cut to its first 8,000 characters\.\)$/);
    expect(look.found()[0].content).toBe("x".repeat(CONTEXT_FILE_LIMIT));
    expect(said(look, "info")).toEqual(["Cut /projects/story/notes/long.md to its first 8,000 characters."]);
  });

  it("leaves out what no longer fits, and ends the looking", async () => {
    const count = LOOK_LIMIT / CONTEXT_FILE_LIMIT + 1;
    for (let index = 0; index < count; index++)
      write(`projects/story/notes/n${index}.md`, "y".repeat(CONTEXT_FILE_LIMIT));
    const look = await lookFrom(TENT);
    for (let index = 0; index < count - 1; index++) {
      expect(await call(look, "read_space_file", { path: `/projects/story/notes/n${index}.md` })).toHaveLength(
        CONTEXT_FILE_LIMIT,
      );
    }
    expect(look.tools.mustStop(1)).toBe(false);
    const last = `/projects/story/notes/n${count - 1}.md`;
    expect(await call(look, "read_space_file", { path: last })).toBe("The context is full.");
    expect(said(look, "warn")).toEqual([`Left out ${last}: the context is full.`]);
    expect(look.tools.mustStop(2)).toBe(true);
    expect(look.found()).toHaveLength(count - 1);
  });
});

describe("reading a long note by its sections", () => {
  const LOOK = "projects/story/notes/look.md";
  const long = (letter: string) => letter.repeat(4500);
  beforeEach(() => {
    write(
      LOOK,
      `# Look\n\n## Lighting\n${long("l")}\n\n### Night\nBlue night.\n\n## Color\n${long("c")}\n\n` +
        "## Camera Language\nLocked off.\n\n## Lighting\nAgain.\n",
    );
  });

  it("gives a long note's headings with their sizes instead of its opening, and gathers nothing", async () => {
    const look = await lookFrom(TENT);
    const outline = (await call(look, "read_space_file", { path: `/${LOOK}` })).split("\n");
    expect(outline[0]).toMatch(
      /^\/projects\/story\/notes\/look\.md is 9,\d{3} characters\. Read the sections you need by heading:$/,
    );
    expect(outline.slice(1)).toEqual([
      "## Lighting (4,535)",
      "### Night (21)",
      "## Color (4,509)",
      "## Camera Language (30)",
      '## Lighting (18, read as "lighting-1")',
    ]);
    expect(look.found()).toEqual([]);
    expect(look.trace.files).toEqual([]);
  });

  it("reads a section by its heading, gathering it under that heading for the answer", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: `/${LOOK}`, section: "camera language" })).toBe(
      "## Camera Language\nLocked off.",
    );
    expect(look.found()).toEqual([
      { path: `/${LOOK}`, section: "Camera Language", content: "## Camera Language\nLocked off." },
    ]);
    expect(look.trace.files).toEqual([`/${LOOK} › Camera Language`]);
  });

  it("reads a repeated heading by its number, and answers a part already read as read", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: `/${LOOK}`, section: "lighting-1" })).toBe(
      "## Lighting\nAgain.",
    );
    expect(await call(look, "read_space_file", { path: `/${LOOK}`, section: "Lighting" })).toMatch(
      /^## Lighting\nl{4500}/,
    );
    expect(await call(look, "read_space_file", { path: `/${LOOK}`, section: "Night" })).toBe(
      "You've read that section already.",
    );
  });

  it("names the headings a note has when asked for one it lacks, and reads no sections of a file without any", async () => {
    const look = await lookFrom(TENT);
    const missing = await call(look, "read_space_file", { path: `/${LOOK}`, section: "Sound" });
    expect(missing).toMatch(/^\/projects\/story\/notes\/look\.md has no section "Sound"\. /);
    expect(missing).toContain("## Camera Language (30)");
    expect(
      await call(look, "read_space_file", { path: "/projects/story/screenplay/01 Opening.fountain", section: "x" }),
    ).toBe("/projects/story/screenplay/01 Opening.fountain has no headings to read it by. Read it whole.");
  });

  it("reads by section a file that came with the instruction, which a plain read still answers as given", async () => {
    write("projects/story/README.md", "# Story\n\n## Logline\nShe goes south.\n\n## Tone\nCold.\n");
    const look = await lookFrom(TENT);
    expect(await call(look, "read_space_file", { path: "/projects/story/README.md" })).toBe(
      "That file came with the instruction.",
    );
    expect(await call(look, "read_space_file", { path: "/projects/story/README.md", section: "Tone" })).toBe(
      "## Tone\nCold.",
    );
  });

  it("gives an oversized section's own headings rather than cutting it", async () => {
    write(
      LOOK,
      `## Lighting\n### Day\n${long("d")}\n### Night\n${long("n")}\n### Dusk\n${long("k")}\n## Color\nWarm.\n`,
    );
    const look = await lookFrom(TENT);
    const outline = (await call(look, "read_space_file", { path: `/${LOOK}`, section: "Lighting" })).split("\n");
    expect(outline[0]).toMatch(/^Lighting in \/projects\/story\/notes\/look\.md is 13,\d{3} characters\./);
    expect(outline.slice(1).map((line) => line.replace(/ \(.*\)$/, ""))).toEqual(["### Day", "### Night", "### Dusk"]);
  });
});

describe("following links", () => {
  it("names what a note links to and what links to it, private notes left out", async () => {
    const look = await lookFrom(TENT);
    expect(await call(look, "list_space_file_links", { path: "/projects/story/world/Lina.md" })).toBe(
      "Linked from:\n/projects/story/notes/arc.md",
    );
    expect(await call(look, "list_space_file_links", { path: "/projects/story/notes/arc.md" })).toBe(
      "Links to:\n/projects/story/world/Lina.md",
    );
  });

  it("names the world files a screenplay names", async () => {
    expect(
      await call(await lookFrom(TENT), "list_space_file_links", {
        path: "/projects/story/screenplay/01 Opening.fountain",
      }),
    ).toBe("Links to:\n/projects/story/world/Lina.md");
  });
});

describe("when the looking ends", () => {
  it("lets it look until its rounds run out, then says it stopped", async () => {
    const look = await lookFrom(TENT);
    expect(look.tools.mustStop(1)).toBe(false);
    expect(look.tools.mustStop(LOOK_ROUNDS - 1)).toBe(false);
    expect(look.tools.mustStop(LOOK_ROUNDS)).toBe(true);
    expect(said(look, "warn")).toEqual([`Stopped looking after ${LOOK_ROUNDS} rounds of searching and reading.`]);
  });

  it("stops it looking once its time is up", async () => {
    const look = await lookFrom(TENT);
    clock = LOOK_TIME_MS + 1;
    expect(look.tools.mustStop(1)).toBe(true);
    expect(said(look, "warn")).toEqual(["Stopped looking after 60 seconds."]);
  });

  // A model asked to try harder looks further, and one asked for little
  // stops sooner; its own default reaches as medium does.
  it("reaches as far as the effort the generation runs at", async () => {
    const near = await lookFrom(TENT, "low");
    expect(near.tools.mustStop(LOOK_REACH.low.rounds - 1)).toBe(false);
    expect(near.tools.mustStop(LOOK_REACH.low.rounds)).toBe(true);

    const far = await lookFrom(TENT, "xhigh");
    expect(far.tools.mustStop(LOOK_ROUNDS)).toBe(false);
    clock = LOOK_TIME_MS + 1;
    expect(far.tools.mustStop(1)).toBe(false);
    clock = LOOK_REACH.xhigh.timeMs + 1;
    expect(far.tools.mustStop(1)).toBe(true);
    expect(said(far, "warn")).toEqual(["Stopped looking after 180 seconds."]);
  });

  it("holds more of what it reads at a higher effort", async () => {
    const count = LOOK_LIMIT / CONTEXT_FILE_LIMIT + 1;
    for (let index = 0; index < count; index++) {
      write(`projects/story/notes/n${index}.md`, "y".repeat(CONTEXT_FILE_LIMIT));
    }
    const look = await lookFrom(TENT, "high");
    for (let index = 0; index < count; index++) {
      expect(await call(look, "read_space_file", { path: `/projects/story/notes/n${index}.md` })).toHaveLength(
        CONTEXT_FILE_LIMIT,
      );
    }
    expect(said(look, "warn")).toEqual([]);
  });

  it("tells it where it may look, and starts it with the scope's files, never a private one", async () => {
    const look = await lookFrom(TENT);
    expect(look.tools.guidance).toContain("look further in /projects/story/");
    expect(look.tools.guidance).toContain("The files in /projects/story/:\n");
    expect(look.tools.guidance).toContain("\n/projects/story/screenplay/01 Opening.fountain\n");
    expect(look.tools.guidance).not.toMatch(/secret|Rory|other|top\.md/);
    expect(Object.keys(look.tools.set)).toEqual([
      "list_space_files",
      "search_space_files",
      "read_space_file",
      "list_space_file_links",
      "ready",
    ]);
    expect(look.tools.set.ready.execute).toBeUndefined();
  });
});

describe("a model that takes no tools", () => {
  const refusal = (statusCode: number, message: string, responseBody?: string) =>
    new APICallError({ message, url: "http://localhost/v1/chat", requestBodyValues: {}, statusCode, responseBody });

  it("is told apart by what its server answers, a retry's wrapping included", () => {
    expect(refusesTools(refusal(400, "registry.ollama.ai/library/gemma3 does not support tools"))).toBe(true);
    expect(refusesTools(refusal(400, "Bad Request", '{"error":"tools param requires --jinja flag"}'))).toBe(true);
    const retried = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [refusal(500, "tools param requires --jinja flag")],
    });
    expect(refusesTools(retried)).toBe(true);
  });

  it("is not every failure", () => {
    expect(refusesTools(refusal(401, "Invalid key for tools"))).toBe(false);
    expect(refusesTools(refusal(429, "Too many requests"))).toBe(false);
    expect(refusesTools(refusal(400, "Context length exceeded"))).toBe(false);
    expect(refusesTools(new Error("does not support tools"))).toBe(false);
  });
});
