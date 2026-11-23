import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, globalLayoutPath, loadGlobalConfig } from "../../src/config/loadConfig.ts";
import { readFolderState, readLayoutGroups, writeFolderState, writeLayoutGroups } from "../../src/server/layout.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { isolateConfig, tempDir, tempSpace } from "../support/isolation.ts";

// Layouts live in the install-global config directory, so each test gets a
// throwaway one rather than the developer's own.
beforeEach(() => {
  isolateConfig();
});

const unregisteredSpace = () => tempDir("pragma-layout-test-");

const space = () => tempSpace("pragma-layout-test-");

function layoutFile(root: string): string {
  const id = findSpaceId(loadGlobalConfig(), root);
  if (id === undefined) throw new Error(`${root} is not registered`);
  return globalLayoutPath(id);
}

const readme = { tabs: [{ kind: "document" as const, path: "README.md" }], activeTabIndex: 0 };

describe("folder state", () => {
  it("folds every folder below the top level of a space whose folds were never saved", async () => {
    const root = space();
    await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
    await mkdir(path.join(root, "d"));
    await mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await writeFile(path.join(root, "a", "note.md"), "# Note\n");
    expect(await readFolderState(root)).toEqual({ collapsedFolders: ["a/b", "a/b/c"], expandedFolders: [] });
  });

  // A scaffolded space carries no layout, so its first open shows the
  // projects folder open and each project in it folded.
  it("opens the template space with only its top-level folders open", async () => {
    const template = fileURLToPath(new URL("../../templates/space", import.meta.url));
    const { collapsedFolders } = await readFolderState(template);
    expect(collapsedFolders).toContain("projects/getting-started");
    expect(collapsedFolders.filter((folder) => !folder.includes("/"))).toEqual([]);
  });

  it("keeps a saved list over the first open's, an empty one included", async () => {
    const root = space();
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFolderState(root, { collapsedFolders: [] });
    expect(await readFolderState(root)).toEqual({ collapsedFolders: [], expandedFolders: [] });
  });

  it("reads a malformed list as never saved", async () => {
    const root = space();
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    const file = layoutFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ collapsedFolders: "x", expandedFolders: { x: true } }));
    expect(await readFolderState(root)).toEqual({ collapsedFolders: ["a/b"], expandedFolders: [] });
  });

  it("writes one list without dropping the other", async () => {
    const root = space();
    await writeFolderState(root, { collapsedFolders: ["a"], expandedFolders: ["lib:footage/stills"] });
    await writeFolderState(root, { collapsedFolders: ["b"] });
    expect(await readFolderState(root)).toEqual({ collapsedFolders: ["b"], expandedFolders: ["lib:footage/stills"] });
  });

  it("keeps the groups across a folder write, and the folder lists across a groups write", async () => {
    const root = space();
    const one = { tabs: [{ kind: "document" as const, path: "note.md" }], activeTabIndex: 0 };
    await writeLayoutGroups(root, { groups: [one], focusedGroup: 0 });
    await writeFolderState(root, { collapsedFolders: ["a"], expandedFolders: ["lib:footage/stills"] });
    const two = { tabs: [{ kind: "image" as const, path: "a.png" }, { kind: "empty" as const }], activeTabIndex: 1 };
    await writeLayoutGroups(root, { groups: [one, two], focusedGroup: 1 });
    expect(await readLayoutGroups(root)).toEqual({ groups: [one, two], focusedGroup: 1 });
    expect(await readFolderState(root)).toEqual({ collapsedFolders: ["a"], expandedFolders: ["lib:footage/stills"] });
  });
});

describe("groups", () => {
  // A scaffolded space carries no layout, so its first open lands on its
  // README through this rule rather than through a shipped file.
  it("opens the template space on its README", async () => {
    const template = fileURLToPath(new URL("../../templates/space", import.meta.url));
    expect(await readLayoutGroups(template)).toEqual({ groups: [readme], focusedGroup: 0 });
  });

  it("opens a space whose groups were never saved on its README, even with folder lists saved", async () => {
    const root = space();
    await writeFile(path.join(root, "README.md"), "# Mine\n");
    expect(await readLayoutGroups(root)).toEqual({ groups: [readme], focusedGroup: 0 });

    await writeFolderState(root, { collapsedFolders: ["a"] });
    expect(await readLayoutGroups(root)).toEqual({ groups: [readme], focusedGroup: 0 });
  });

  it("reads no groups from a space with no README and no saved groups", async () => {
    expect(await readLayoutGroups(space())).toEqual({ groups: [], focusedGroup: 0 });
  });

  it("keeps groups saved with every tab closed empty, README or not", async () => {
    const root = space();
    await writeFile(path.join(root, "README.md"), "# Mine\n");
    await writeLayoutGroups(root, { groups: [], focusedGroup: 0 });
    expect(await readLayoutGroups(root)).toEqual({ groups: [], focusedGroup: 0 });
  });

  // A file in a shape no reader knows restores nothing, and the next write
  // leaves only the fields that are read.
  it("reads a file without groups as nothing to restore, and drops keys no reader knows", async () => {
    const root = space();
    const file = layoutFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ collapsedFolders: ["a"], tabs: [{ kind: "empty" }], activeTabIndex: 0 }));
    expect(await readLayoutGroups(root)).toEqual({ groups: [], focusedGroup: 0 });

    await writeFolderState(root, { collapsedFolders: ["b"] });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ collapsedFolders: ["b"] });
  });
});

describe("where the layout lives", () => {
  it("writes beside config.json under the space's id, and nothing into the space", async () => {
    const root = space();
    await writeLayoutGroups(root, { groups: [readme], focusedGroup: 0 });
    await writeFolderState(root, { collapsedFolders: ["a"] });

    expect(await readdir(root)).toEqual([]);
    expect(JSON.parse(await readFile(layoutFile(root), "utf8"))).toEqual({
      groups: [readme],
      focusedGroup: 0,
      collapsedFolders: ["a"],
    });
  });

  // Losing a layout costs only the open tabs, so an unreadable one is none
  // rather than the hard stop an unreadable config.json is.
  it("reads an unparseable layout as none, and the next write replaces it", async () => {
    const root = space();
    const file = layoutFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");

    expect(await readFolderState(root)).toEqual({ collapsedFolders: [], expandedFolders: [] });
    await writeFolderState(root, { collapsedFolders: ["a"] });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ collapsedFolders: ["a"] });
  });

  it("reads an unregistered space as having no layout, and refuses to save one", async () => {
    const root = unregisteredSpace();
    expect(await readFolderState(root)).toEqual({ collapsedFolders: [], expandedFolders: [] });
    await expect(writeFolderState(root, { collapsedFolders: ["a"] })).rejects.toThrow("not a registered space");
  });
});

describe("the layout route", () => {
  async function post(root: string, groups: unknown[]): Promise<number> {
    const routes = spaceRoutes(createServedSpace(root), { ownMachine: true });
    const response = await routes().request("/api/space/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groups, focusedGroup: 0 }),
    });
    return response.status;
  }

  it("answers a space whose folds were never saved with the folders below its top level folded", async () => {
    const root = space();
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    const response = await spaceRoutes(createServedSpace(root), { ownMachine: true })().request("/api/space/layout");
    expect((await response.json()).collapsedFolders).toEqual(["a/b"]);
  });

  it("keeps each group's reading view and Source mode, and refuses either as anything but a boolean", async () => {
    const root = space();
    const group = { ...readme, readingView: false, sourceMode: true };
    expect(await post(root, [group])).toBe(204);
    expect(await readLayoutGroups(root)).toEqual({ groups: [group], focusedGroup: 0 });

    expect(await post(root, [{ ...readme, sourceMode: "yes" }])).toBe(400);
    expect(await post(root, [{ ...readme, readingView: 1 }])).toBe(400);
    expect(await readLayoutGroups(root)).toEqual({ groups: [group], focusedGroup: 0 });
  });

  it("keeps a document tab's place, and refuses one that isn't a line and a caret", async () => {
    const root = space();
    const tab = { kind: "document", path: "README.md", place: { line: 12.5, caret: { line: 14, column: 3 } } };
    const placed = { tabs: [tab], activeTabIndex: 0 };
    expect(await post(root, [placed])).toBe(204);
    expect(await readLayoutGroups(root)).toEqual({ groups: [placed], focusedGroup: 0 });

    for (const place of [
      { line: "12" },
      { line: -1 },
      { line: 3, caret: { line: 0, column: 0 } },
      { line: 3, caret: 7 },
    ]) {
      expect(await post(root, [{ tabs: [{ ...tab, place }], activeTabIndex: 0 }])).toBe(400);
    }
    expect(await readLayoutGroups(root)).toEqual({ groups: [placed], focusedGroup: 0 });
  });

  it("keeps a LUT's tab", async () => {
    const root = space();
    const group = { tabs: [{ kind: "lut", path: "looks/print.cube" }], activeTabIndex: 0 };
    expect(await post(root, [group])).toBe(204);
    expect(await readLayoutGroups(root)).toEqual({ groups: [group], focusedGroup: 0 });
  });

  it("keeps a Flow tab's view, and refuses one that isn't an offset and a zoom", async () => {
    const root = space();
    const tab = { kind: "flow", path: "a.flow.html", viewport: { x: -120, y: 40.5, zoom: 0.75 } };
    const viewed = { tabs: [tab], activeTabIndex: 0 };
    expect(await post(root, [viewed])).toBe(204);
    expect(await readLayoutGroups(root)).toEqual({ groups: [viewed], focusedGroup: 0 });

    for (const viewport of [
      { x: "0", y: 0, zoom: 1 },
      { x: 0, y: 0 },
      { x: 0, y: 0, zoom: 0 },
      { x: 0, y: null, zoom: 1 },
      7,
    ]) {
      expect(await post(root, [{ tabs: [{ ...tab, viewport }], activeTabIndex: 0 }])).toBe(400);
    }
    expect(await readLayoutGroups(root)).toEqual({ groups: [viewed], focusedGroup: 0 });
  });
});
