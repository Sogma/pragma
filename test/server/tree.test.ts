import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpaceTreeNode } from "../../src/protocol/api.ts";
import { buildTree, listFolder, listRootPaths, scopesOnDisk } from "../../src/server/tree.ts";

let library: string;

beforeEach(() => {
  library = mkdtempSync(path.join(tmpdir(), "pragma-tree-"));
  mkdirSync(path.join(library, "shots/day1"), { recursive: true });
  writeFileSync(path.join(library, "shots/day1/a.png"), "");
  mkdirSync(path.join(library, "scripts"));
  writeFileSync(path.join(library, "scripts/notes.md"), "");
  mkdirSync(path.join(library, "empty"));
  writeFileSync(path.join(library, "top.md"), "");
});

afterEach(() => {
  rmSync(library, { recursive: true, force: true });
});

describe("buildTree — depth", () => {
  it("stops at the limit, leaving each folder there unlisted rather than empty", async () => {
    const tree = await buildTree(library, library, "library", { depth: 1 });
    expect(tree.map((node) => node.name)).toEqual(["empty", "scripts", "shots", "top.md"]);
    for (const node of tree.filter((entry) => entry.type === "directory")) {
      expect(node).not.toHaveProperty("children");
    }
  });

  it("walks everything without one, pruning a read-only library's empty folder", async () => {
    const tree = await buildTree(library, library, "library");
    expect(tree.map((node) => node.name)).toEqual(["scripts", "shots", "top.md"]);
    const shots = tree.find((node) => node.name === "shots");
    expect(shots?.children?.[0]?.children?.map((node) => node.path)).toEqual(["shots/day1/a.png"]);
  });
});

describe("buildTree — name order", () => {
  it("lists folders first, then names in natural order, ignoring case", async () => {
    for (const name of ["take 10.md", "take 2.md", "Take 3.md", "b.md"]) {
      writeFileSync(path.join(library, "scripts", name), "");
    }
    mkdirSync(path.join(library, "scripts", "z"));
    const scripts = (await buildTree(library, library)).find((node) => node.name === "scripts");
    expect(scripts?.children?.map((node) => node.name)).toEqual([
      "z",
      "b.md",
      "notes.md",
      "take 2.md",
      "Take 3.md",
      "take 10.md",
    ]);
  });
});

describe("buildTree — Pragma's own files", () => {
  function roles(nodes: SpaceTreeNode[]): Record<string, string> {
    return Object.fromEntries(
      nodes.flatMap((node) => [
        ...(node.pragmaFile ? [[node.path, node.pragmaFile]] : []),
        ...Object.entries(roles(node.children ?? [])),
      ]),
    );
  }

  it("marks each where Pragma reads it, and no other file", async () => {
    mkdirSync(path.join(library, "site"));
    for (const name of ["_tags.json", "_libraries.json", "_structure.json"]) {
      writeFileSync(path.join(library, name), "{}");
    }
    for (const name of ["_tags.json", "_queue.json", "_properties.json"]) {
      writeFileSync(path.join(library, "scripts", name), "{}");
    }
    for (const name of ["_site.json", "_queue.json"]) writeFileSync(path.join(library, "site", name), "{}");
    expect(roles(await buildTree(library, library, "space", { allFileTypes: true }))).toEqual({
      "_libraries.json": "libraries",
      "_structure.json": "order",
      "_tags.json": "tags",
      "scripts/_properties.json": "properties",
      "site/_queue.json": "queue",
      "site/_site.json": "site",
    });
  });

  it("takes the space's root, not the walk's, for where the root's own files sit", async () => {
    writeFileSync(path.join(library, "scripts", "_tags.json"), "{}");
    const scripts = await buildTree(path.join(library, "scripts"), library, "space", { allFileTypes: true });
    expect(roles(scripts)).toEqual({});
  });
});

describe("buildTree — scopes", () => {
  function flagged(nodes: SpaceTreeNode[]): string[] {
    return nodes.flatMap((node) => [...(node.opensScope ? [node.path] : []), ...flagged(node.children ?? [])]);
  }

  it("flags a space's AGENTS.md whose frontmatter holds a pragma key, the root's included, and nothing else", async () => {
    writeFileSync(path.join(library, "AGENTS.md"), "---\npragma:\n---\n# Space\n");
    writeFileSync(path.join(library, "scripts/AGENTS.md"), "---\npragma:\n  lookup: [world/]\n---\n");
    writeFileSync(path.join(library, "scripts/README.md"), "---\npragma:\n---\n");
    writeFileSync(path.join(library, "shots/AGENTS.md"), "# Stills\n");
    writeFileSync(path.join(library, "shots/README.md"), "---\ndescription: Stills\n---\n");
    expect(flagged(await buildTree(library, library, "space"))).toEqual(["scripts/AGENTS.md", "AGENTS.md"]);
  });

  it("flags none in a library", async () => {
    writeFileSync(path.join(library, "scripts/AGENTS.md"), "---\npragma:\n---\n");
    expect(flagged(await buildTree(library, library, "library"))).toEqual([]);
  });
});

describe("buildTree — world folders", () => {
  function worlds(nodes: SpaceTreeNode[]): string[] {
    return nodes.flatMap((node) => [...(node.world ? [node.path] : []), ...worlds(node.children ?? [])]);
  }

  it("marks the folder a scope's World setting names, whatever it is called", async () => {
    writeFileSync(path.join(library, "shots/AGENTS.md"), "---\npragma:\n  screenplay:\n    world: day1/\n---\n");
    mkdirSync(path.join(library, "scripts/world"));
    expect(worlds(await buildTree(library, library, "space"))).toEqual(["shots/day1"]);
  });

  it("marks nothing a setting names outside its scope, or in a library", async () => {
    writeFileSync(path.join(library, "shots/AGENTS.md"), "---\npragma:\n  screenplay:\n    world: ../scripts/\n---\n");
    expect(worlds(await buildTree(library, library, "space"))).toEqual([]);
    writeFileSync(path.join(library, "shots/AGENTS.md"), "---\npragma:\n  screenplay:\n    world: day1/\n---\n");
    expect(worlds(await buildTree(library, library, "library"))).toEqual([]);
  });
});

describe("buildTree — every file type", () => {
  beforeEach(() => {
    for (const name of ["budget.csv", "archive.ZIP", "_tags.json", "_Notes.JSON", ".hidden.txt", "README"]) {
      writeFileSync(path.join(library, "scripts", name), "");
    }
  });

  const scriptNames = async (listing: { allFileTypes?: boolean }): Promise<string[] | undefined> =>
    (await buildTree(library, library, "space", listing))
      .find((node) => node.name === "scripts")
      ?.children?.map((node) => node.name);

  it("lists only files Pragma opens unless asked for every type", async () => {
    expect(await scriptNames({})).toEqual(["notes.md"]);
  });

  it("lists every other file then, an underscore's included, but never a dotfile", async () => {
    expect(await scriptNames({ allFileTypes: true })).toEqual([
      "_Notes.JSON",
      "_tags.json",
      "archive.ZIP",
      "budget.csv",
      "notes.md",
      "README",
    ]);
  });

  it("lists the same in one folder's listing", async () => {
    const names = async (allFileTypes: boolean) =>
      (await listFolder(path.join(library, "scripts"), "space", { allFileTypes })).map((entry) => entry.name);
    expect(await names(false)).toEqual(["notes.md"]);
    expect(await names(true)).toEqual(["_Notes.JSON", "_tags.json", "archive.ZIP", "budget.csv", "notes.md", "README"]);
  });

  it("keeps a library to the kinds its panes render, whatever is asked", async () => {
    expect((await listFolder(path.join(library, "scripts"), "library", { allFileTypes: true })).length).toBe(1);
  });
});

describe("listRootPaths", () => {
  beforeEach(() => {
    writeFileSync(path.join(library, "scripts/budget.csv"), "");
    writeFileSync(path.join(library, "scripts/_tags.json"), "{}");
    mkdirSync(path.join(library, ".git"));
    writeFileSync(path.join(library, ".git/config"), "");
    writeFileSync(path.join(library, "scripts/agents.md"), "---\npragma:\n---\n");
    writeFileSync(path.join(library, "shots/README.md"), "---\ndescription: Stills\n---\n");
  });

  // What a written path is read against: every file, whatever the tree shows.
  it("lists every file and folder but dot-entries, whatever their kind", async () => {
    const { files, folders } = await listRootPaths(library, "space");
    expect(files).toEqual([
      "scripts/_tags.json",
      "scripts/agents.md",
      "scripts/budget.csv",
      "scripts/notes.md",
      "shots/README.md",
      "shots/day1/a.png",
      "top.md",
    ]);
    expect(folders).toEqual(["empty", "scripts", "shots", "shots/day1"]);
  });

  it("names a space's scopes by their AGENTS.md, in any case, and none in a library", async () => {
    expect((await listRootPaths(library, "space")).scopes).toEqual(["scripts"]);
    expect((await listRootPaths(library, "library")).scopes).toEqual([]);
  });

  it("carries each scope's settings where its pragma is a map, the space's own included", async () => {
    writeFileSync(path.join(library, "AGENTS.md"), "---\npragma:\n  screenplay:\n    world: shots/\n---\n");
    writeFileSync(path.join(library, "shots/AGENTS.md"), "---\npragma:\n  outline: { beats: 8 }\n---\n");
    const { scopes, settings } = await listRootPaths(library, "space");
    expect(scopes).toEqual(["scripts", "shots"]);
    expect(settings).toEqual({ "": { screenplay: { world: "shots/" } }, shots: { outline: { beats: 8 } } });
    expect((await listRootPaths(library, "library")).settings).toBeUndefined();
  });

  // A path the server writes asks only the folders above it, never the walk.
  it("answers the same, one folder at a time, from the disk", () => {
    const scopes = scopesOnDisk(library);
    expect(["scripts", "shots", "shots/day1", "empty", "missing"].filter((folder) => scopes.has(folder))).toEqual([
      "scripts",
    ]);
  });
});
