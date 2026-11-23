import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextMessage } from "../../src/protocol/types.ts";
import { CONTEXT_FILE_LIMIT, placeContext, readContext } from "../../src/server/pathContext.ts";
import { listRootPaths } from "../../src/server/tree.ts";
import { tempDir } from "../support/isolation.ts";

// Conformance tests for docs/protocol.md's Context of a path, against a space
// on disk: what goes, in which order, and what is left out or cut.

const SCOPE = '---\npragma: ""\n---\n\n';
const WORLD_SCOPE = "---\npragma:\n  screenplay:\n    world: world/\n---\n\n";
const SCENE = "projects/forbidden/story/screenplay/Sequence 1/130 Awakening.fountain";

let space: string;

function write(relative: string, content: string): void {
  const file = path.join(space, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// The messages at one level, as their sentences.
const said = (messages: readonly ContextMessage[], level: ContextMessage["level"]) =>
  messages.filter((message) => message.level === level).map((message) => message.text);

async function contextOf(relative: string) {
  const listing = await listRootPaths(space, "space");
  const place = placeContext(listing, relative);
  if (!place) throw new Error(`nothing at ${relative}`);
  const read = await readContext(space, listing, place);
  return {
    scope: place.scope,
    files: read.files.map((file) => file.path),
    notes: said(read.messages, "info"),
    warnings: said(read.messages, "warn"),
    read,
  };
}

beforeEach(() => {
  space = tempDir("pragma-context-");
  write("AGENTS.md", "# Space rules\n");
  write("top.md", "# Top\n");
  write("projects/forbidden/AGENTS.md", `${SCOPE}# forbidden\n`);
  write("projects/forbidden/loglines.md", "# Loglines\n");
  write("projects/forbidden/story/AGENTS.md", `${WORLD_SCOPE}# story\n`);
  write("projects/forbidden/story/README.md", "# Story\n\nAn agent goes south.\n");
  write("projects/forbidden/story/world/characters/Lina.md", "# Lina\n\nCopper hair.\n");
  write("projects/forbidden/story/world/characters/Lina.png", "not really a picture");
  write("projects/forbidden/story/world/characters/Rory.md", "---\nvisibility: private\n---\n\n# Rory\n");
  write("projects/forbidden/story/world/locations/C-17 - Cargo Hold.md", "# Cargo hold\n");
  write(SCENE, "INT. C-17 - CARGO HOLD - NIGHT\n\nLina walks. RORY waits.\n\nLINA\nWhere?\n");
});

describe("the context of a screenplay", () => {
  it("sends its scope's AGENTS.md, its README, then the world files it names, by first mention", async () => {
    const { scope, files, notes, warnings } = await contextOf(SCENE);
    expect(scope).toBe("projects/forbidden/story");
    expect(files).toEqual([
      "/projects/forbidden/story/AGENTS.md",
      "/projects/forbidden/story/README.md",
      "/projects/forbidden/story/world/locations/C-17 - Cargo Hold.md",
      "/projects/forbidden/story/world/characters/Lina.md",
    ]);
    expect(warnings).toEqual(["Left out /projects/forbidden/story/world/characters/Rory.md: it's private."]);
    expect(notes).toEqual([]);
  });

  it("sends each file as it is on disk", async () => {
    const { read } = await contextOf(SCENE);
    expect(read.files[3]).toEqual({
      path: "/projects/forbidden/story/world/characters/Lina.md",
      content: "# Lina\n\nCopper hair.\n",
    });
  });

  it("takes its world from an enclosing scope that sets one", async () => {
    write("projects/forbidden/AGENTS.md", "---\npragma:\n  screenplay:\n    world: story/world/\n---\n\n# forbidden\n");
    write("projects/forbidden/story/AGENTS.md", `${SCOPE}# story\n`);
    const { files } = await contextOf(SCENE);
    expect(files).toContain("/projects/forbidden/story/world/characters/Lina.md");
  });

  it("names no world files where no scope sets a World, whatever a folder is called", async () => {
    write("projects/forbidden/story/AGENTS.md", `${SCOPE}# story\n`);
    const { files } = await contextOf(SCENE);
    expect(files).toEqual(["/projects/forbidden/story/AGENTS.md", "/projects/forbidden/story/README.md"]);
  });
});

describe("the context of a note", () => {
  it("sends the notes its links reach inside the scope, and says which it left outside", async () => {
    write(
      "projects/forbidden/story/notes/plan.md",
      "[Lina](../world/characters/Lina.md), [loglines](../../loglines.md), [[missing]] and [her picture](../world/characters/Lina.png)\n",
    );
    const { files, warnings } = await contextOf("projects/forbidden/story/notes/plan.md");
    expect(files).toEqual([
      "/projects/forbidden/story/AGENTS.md",
      "/projects/forbidden/story/README.md",
      "/projects/forbidden/story/world/characters/Lina.md",
    ]);
    expect(warnings).toEqual(["Left out /projects/forbidden/loglines.md: it's outside /projects/forbidden/story/."]);
  });

  it("sends nothing a private note names, since what it names tells what it holds", async () => {
    write("projects/forbidden/story/secret.md", "---\nvisibility: private\n---\n\n[Lina](world/characters/Lina.md)\n");
    const { files, warnings } = await contextOf("projects/forbidden/story/secret.md");
    expect(files).toEqual(["/projects/forbidden/story/AGENTS.md", "/projects/forbidden/story/README.md"]);
    expect(warnings).toEqual(["Left out what /projects/forbidden/story/secret.md names: it's private."]);
  });

  it("never sends the path's own file", async () => {
    const { files } = await contextOf("projects/forbidden/story/README.md");
    expect(files).toEqual(["/projects/forbidden/story/AGENTS.md"]);
  });
});

describe("the context of a folder, and of the space's own scope", () => {
  it("starts a folder's README walk at the folder itself", async () => {
    write("projects/forbidden/story/world/README.md", "# World\n");
    const { files } = await contextOf("projects/forbidden/story/world");
    expect(files).toEqual(["/projects/forbidden/story/AGENTS.md", "/projects/forbidden/story/world/README.md"]);
  });

  it("sends the space's AGENTS.md for a path in no inner scope, and no root README", async () => {
    write("README.md", "# The space\n");
    const { scope, files } = await contextOf("top.md");
    expect(scope).toBe("");
    expect(files).toEqual(["/AGENTS.md"]);
  });

  it("finds nothing at a path that names nothing", async () => {
    expect(placeContext(await listRootPaths(space, "space"), "projects/nowhere.md")).toBeUndefined();
  });
});

describe("the size of a context", () => {
  it("cuts a file over its share and says so", async () => {
    write("projects/forbidden/story/README.md", "x".repeat(CONTEXT_FILE_LIMIT + 500));
    const { read, notes, warnings } = await contextOf(SCENE);
    expect(read.files[1].content).toBe(`${"x".repeat(CONTEXT_FILE_LIMIT)}\n\n(Cut to its first 8,000 characters.)`);
    expect(notes).toContain("Cut /projects/forbidden/story/README.md to its first 8,000 characters.");
    expect(warnings).not.toContainEqual(expect.stringContaining("README.md"));
  });

  // One list, so whoever reads it sees what happened in the order it did.
  it("says what it cut and what it left out in the order it met them", async () => {
    write("projects/forbidden/story/README.md", "x".repeat(CONTEXT_FILE_LIMIT + 500));
    const { read } = await contextOf(SCENE);
    expect(read.messages).toEqual([
      { level: "info", text: "Cut /projects/forbidden/story/README.md to its first 8,000 characters." },
      { level: "warn", text: "Left out /projects/forbidden/story/world/characters/Rory.md: it's private." },
    ]);
  });

  // A model that may look further reads those sections by name.
  it("ends a note it cuts with the heading the cut falls in and the headings past it", async () => {
    const section = (title: string) => `## ${title}\n\n${"y".repeat(3000)}\n\n`;
    write(
      "projects/forbidden/story/README.md",
      `# Story\n\n${section("Aesthetic")}${section("Lighting")}${section("Camera Language")}## Constraints\n\nNo night.\n`,
    );
    const { read } = await contextOf(SCENE);
    expect(
      read.files[1].content.endsWith(
        "\n\n(Cut to its first 8,000 characters, in ## Camera Language. It goes on with ## Constraints.)",
      ),
    ).toBe(true);
  });

  it("leaves out what no longer fits once the whole is full", async () => {
    const names = ["Ana", "Ben", "Cal", "Dee", "Eve"];
    for (const name of names) write(`projects/forbidden/story/world/characters/${name}.md`, "y".repeat(8000));
    write(SCENE, `${names.map((name) => name.toUpperCase()).join(" waits. ")} waits.\n`);
    const { files, warnings } = await contextOf(SCENE);
    expect(files.map((file) => path.basename(file))).toEqual(["AGENTS.md", "README.md", "Ana.md", "Ben.md", "Cal.md"]);
    expect(warnings).toEqual([
      "Left out /projects/forbidden/story/world/characters/Dee.md: the context is full.",
      "Left out /projects/forbidden/story/world/characters/Eve.md: the context is full.",
    ]);
  });
});
