import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNearestReadme, readSpaceRulesFile } from "../../src/server/spaceFiles.ts";

const PRIVATE = "---\nvisibility: private\n---\n";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-rules-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the space's operating-rules file", () => {
  it("reads AGENTS.md, the name a space is scaffolded with", async () => {
    writeFileSync(path.join(dir, "AGENTS.md"), "neutral rules");

    expect(await readSpaceRulesFile(dir)).toEqual({ name: "AGENTS.md", content: "neutral rules" });
  });

  it("still reads CLAUDE.md, so a space written before the rename keeps its rules", async () => {
    // The whole point of the fallback: a rename that only looked for the new
    // name would leave every existing space silently unruled — no error, just
    // a copilot quietly ignoring the space's conventions.
    writeFileSync(path.join(dir, "CLAUDE.md"), "legacy rules");

    expect(await readSpaceRulesFile(dir)).toEqual({ name: "CLAUDE.md", content: "legacy rules" });
  });

  it("prefers AGENTS.md when a space carries both", async () => {
    writeFileSync(path.join(dir, "AGENTS.md"), "neutral rules");
    writeFileSync(path.join(dir, "CLAUDE.md"), "legacy rules");

    // One file wins rather than both being concatenated: a space mid-rename
    // would otherwise feed the copilot two copies of overlapping rules.
    expect(await readSpaceRulesFile(dir)).toEqual({ name: "AGENTS.md", content: "neutral rules" });
  });

  it("is silently absent when the space has neither", async () => {
    expect(await readSpaceRulesFile(dir)).toBeNull();
  });

  it("reads a rules file whatever its case, and names it as spelled", async () => {
    writeFileSync(path.join(dir, "agents.md"), "lowercase rules");

    expect(await readSpaceRulesFile(dir)).toEqual({ name: "agents.md", content: "lowercase rules" });
  });

  it("withholds a private AGENTS.md rather than reading CLAUDE.md in its place", async () => {
    writeFileSync(path.join(dir, "AGENTS.md"), `${PRIVATE}secret rules`);
    writeFileSync(path.join(dir, "CLAUDE.md"), "legacy rules");

    expect(await readSpaceRulesFile(dir)).toBeNull();
  });
});

describe("the nearest project README", () => {
  it("is the closest README.md above the open file, never the space root's own", async () => {
    mkdirSync(path.join(dir, "project", "scenes"), { recursive: true });
    writeFileSync(path.join(dir, "README.md"), "the space");
    writeFileSync(path.join(dir, "project", "README.md"), "the project");

    expect(await findNearestReadme(dir, path.join(dir, "project", "scenes"))).toEqual({
      path: "project/README.md",
      content: "the project",
    });
  });

  it("ends the walk at a private README and hands the model none of it", async () => {
    mkdirSync(path.join(dir, "series", "episode"), { recursive: true });
    writeFileSync(path.join(dir, "series", "README.md"), "the series");
    writeFileSync(path.join(dir, "series", "episode", "README.md"), `${PRIVATE}the episode`);

    expect(await findNearestReadme(dir, path.join(dir, "series", "episode"))).toBeNull();
  });

  it("finds a README in any case, as a scope does", async () => {
    mkdirSync(path.join(dir, "project"), { recursive: true });
    writeFileSync(path.join(dir, "project", "readme.md"), "the project");

    expect(await findNearestReadme(dir, path.join(dir, "project"))).toEqual({
      path: "project/readme.md",
      content: "the project",
    });
  });

  // Found in any case, a README is a Markdown document whatever its
  // extension's case, so `visibility: private` keeps it from the model.
  it("withholds a private README.MD as it does a README.md", async () => {
    mkdirSync(path.join(dir, "project"), { recursive: true });
    writeFileSync(path.join(dir, "project", "README.MD"), `${PRIVATE}the project`);

    expect(await findNearestReadme(dir, path.join(dir, "project"))).toBeNull();
  });
});
