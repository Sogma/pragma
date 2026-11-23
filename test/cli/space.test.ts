import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/index.ts";
import { findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

let root: string;
let printed: string[];
let errors: string[];

// One command line, as typed after `pragma`, against this test's own config
// directory. A refusal shows as process.exitCode, reset after each test so it
// can't fail the run.
async function pragma(...args: string[]): Promise<void> {
  await createProgram()
    .exitOverride()
    .parseAsync(["node", "pragma", ...args]);
}

async function folder(name: string): Promise<string> {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  return target;
}

beforeEach(() => {
  root = tempDir("pragma-cli-");
  isolateConfig(path.join(root, "config"));
  printed = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    printed.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("pragma init", () => {
  it("makes a space and adds it to your spaces without opening it", async () => {
    const target = path.join(root, "notes");

    await pragma("init", target);

    const config = loadGlobalConfig();
    expect(findSpaceId(config, target)).toMatch(/^spc_[0-9a-f]{8}$/);
    expect(config.spacePath).toBeUndefined();
    expect(await readdir(target)).toContain("README.md");
    expect(printed).toEqual([`Created ${target} and added it to your spaces.`]);
  });

  it("adds nothing when it makes nothing", async () => {
    const target = await folder("notes");
    await writeFile(path.join(target, "README.md"), "# Notes\n");

    await pragma("init", target);

    expect(process.exitCode).toBe(1);
    expect(loadGlobalConfig().spaces).toBeUndefined();
  });
});

describe("pragma space add", () => {
  it("adds a folder as it is, and only once", async () => {
    const target = await folder("notes");
    await writeFile(path.join(target, "idea.md"), "An idea\n");

    await pragma("space", "add", target);
    await pragma("space", "add", target);

    const id = findSpaceId(loadGlobalConfig(), target);
    expect(Object.keys(loadGlobalConfig().spaces ?? {})).toEqual([id]);
    expect(await readdir(target)).toEqual(["idea.md"]);
    expect(printed).toEqual([
      `Added ${target} to your spaces, as ${id}.`,
      `${target} is already in your spaces, as ${id}.`,
    ]);
  });

  it("refuses a path that isn't a folder", async () => {
    const file = path.join(root, "idea.md");
    await writeFile(file, "An idea\n");

    await pragma("space", "add", file);

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([`${file} is not a directory.`]);
    expect(loadGlobalConfig().spaces).toBeUndefined();
  });
});

describe("pragma space locate", () => {
  it("points a space at its new folder, keeping its id and trust", async () => {
    const moved = await folder("moved");
    saveGlobalConfig({ spacePath: "/gone/notes", spaces: { main: { path: "/gone/notes", trusted: true } } });

    await pragma("space", "locate", "main", moved);

    const config = loadGlobalConfig();
    expect(config.spaces).toEqual({ main: { path: moved, trusted: true } });
    expect(config.spacePath).toBe(moved);
    expect(printed[0]).toBe(`main now points to ${moved}, keeping its approvals and API tokens.`);
  });

  it("refuses an unknown id, and a folder another space has", async () => {
    const notes = await folder("notes");
    const before = { spaces: { main: { path: "/gone/main" }, notes: { path: notes } } };
    saveGlobalConfig(before);

    await pragma("space", "locate", "nope", notes);
    await pragma("space", "locate", "main", notes);

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([
      'No space has the id "nope". Run pragma space list to see them.',
      "That folder is already registered as another space.",
    ]);
    expect(loadGlobalConfig()).toEqual(before);
  });
});

describe("pragma space list", () => {
  it("lists each space's id, name and folder, by name, and flags a missing folder", async () => {
    const notes = await folder("notes");
    saveGlobalConfig({
      spaces: { spc_0000aaaa: { path: notes }, main: { path: "/gone/screenplays", label: "Screenplays" } },
    });

    await pragma("space", "list");

    expect(printed).toEqual([
      `ID${" ".repeat(12)}NAME${" ".repeat(9)}FOLDER`,
      `spc_0000aaaa  notes${" ".repeat(8)}${notes}`,
      `main${" ".repeat(10)}Screenplays  /gone/screenplays  (folder not found)`,
    ]);
  });

  it("says how to add one when there are none", async () => {
    await pragma("space", "list");

    expect(printed).toEqual([
      "No spaces yet. Make one with pragma init <folder>, or add one with pragma space add <folder>.",
    ]);
  });
});
