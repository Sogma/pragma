import type { Stats } from "node:fs";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, globalLayoutPath, loadGlobalConfig } from "../../src/config/loadConfig.ts";
import type { SortChoice } from "../../src/protocol/folderSort.ts";
import type { LocalSort } from "../../src/protocol/localSort.ts";
import type { TableLayout } from "../../src/protocol/types.ts";
import { orderEntries } from "../../src/server/folderOrder.ts";
import {
  readFlowAppModes,
  readLocalSorts,
  readTableLayouts,
  updateLocalSorts,
  writeFolderState,
} from "../../src/server/layout.ts";
import {
  duplicatedLocalSorts,
  folderSortState,
  forgottenByPath,
  forgottenLocalSorts,
  movedByPath,
  movedLocalSorts,
  saveFlowAppMode,
  saveFolderLayout,
  saveLocalSort,
  saveTableLayout,
} from "../../src/server/localSorts.ts";
import { buildTree, type FolderListingEntry } from "../../src/server/tree.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

const names = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name);

function entry(
  name: string,
  type: "file" | "directory",
  facts: { created?: number; modified?: number; size?: number } = {},
): FolderListingEntry {
  const stats = { birthtimeMs: facts.created ?? 0, mtimeMs: facts.modified ?? 0, size: facts.size ?? 0 } as Stats;
  return { name, type, stats };
}

// The listing's own stats, as the gallery's route hands them.
const orderListing = async (listing: FolderListingEntry[], sort: SortChoice, arrangement: string[] = []) =>
  names(await orderEntries("", listing, sort, arrangement, async (listed) => listed.stats));

describe("ordering a listing", () => {
  // In name order, as a listing comes: folders first.
  const listing = [
    entry("archive", "directory", { created: 5, modified: 50 }),
    entry("drafts", "directory", { created: 1, modified: 90 }),
    entry("a.png", "file", { created: 3, modified: 30, size: 900 }),
    entry("b.png", "file", { created: 2, modified: 70, size: 10 }),
    entry("c.png", "file", { created: 4, modified: 70, size: 10 }),
  ];

  it("keeps folders first by name, date and size, in either direction, ties by name", async () => {
    expect(await orderListing(listing, { by: "name", order: "desc" })).toEqual([
      "drafts",
      "archive",
      "c.png",
      "b.png",
      "a.png",
    ]);
    expect(await orderListing(listing, { by: "modified", order: "desc" })).toEqual([
      "drafts",
      "archive",
      "b.png",
      "c.png",
      "a.png",
    ]);
    expect(await orderListing(listing, { by: "created", order: "asc" })).toEqual([
      "drafts",
      "archive",
      "b.png",
      "a.png",
      "c.png",
    ]);
    expect(await orderListing(listing, { by: "size", order: "desc" })).toEqual([
      "archive",
      "drafts",
      "a.png",
      "b.png",
      "c.png",
    ]);
  });

  it("reads a file with no birth time as made at its last change", async () => {
    const unborn = [entry("old.png", "file", { modified: 1 }), entry("new.png", "file", { modified: 9 })];
    expect(await orderListing(unborn, { by: "created", order: "desc" })).toEqual(["new.png", "old.png"]);
  });

  it("mixes folders with documents in an arrangement, the unlisted after in name order", async () => {
    expect(await orderListing(listing, { by: "manual" }, ["c.png", "drafts", "gone.png", "a.png"])).toEqual([
      "c.png",
      "drafts",
      "a.png",
      "archive",
      "b.png",
    ]);
  });
});

describe("a folder's sort on this install", () => {
  let root: string;
  let scenes: string;

  beforeEach(() => {
    isolateConfig();
    root = tempSpace("pragma-sorts-");
    scenes = path.join(root, "scenes");
    mkdirSync(path.join(scenes, "extras"), { recursive: true });
    writeFileSync(path.join(scenes, "take 10.md"), "---\ndate: 2026-01-03\n---\n");
    writeFileSync(path.join(scenes, "take 2.md"), "---\ndate: 2026-01-01\ndescription: The second take\n---\n");
    writeFileSync(path.join(scenes, "take 3.md"), "---\ndate: 2026-01-02\n---\n");
  });

  const save = (change: { sort?: LocalSort["sort"]; arrangement?: string[] | null }, key = "scenes") =>
    saveLocalSort(root, key, path.join(root, key), "space", change);
  const state = async () => folderSortState(scenes, "space", (await readLocalSorts(root)).scenes);

  it("lists by name in natural order, folders first, when the folder keeps no order", async () => {
    const { shown, fallback, local } = await state();
    expect(names(shown)).toEqual(["extras", "take 2.md", "take 3.md", "take 10.md"]);
    expect(fallback).toEqual({ by: "name", order: "asc" });
    expect(local).toBeUndefined();
  });

  it("reads the folder's own manual and property orders as sorts", async () => {
    writeFileSync(path.join(scenes, "_structure.json"), JSON.stringify({ order: [{ name: "take 3.md" }] }));
    expect((await state()).fallback).toEqual({ by: "manual" });
    expect(names((await state()).shown)[0]).toBe("take 3.md");
    const byDate = { by: "property", property: "date", order: "desc" };
    writeFileSync(path.join(scenes, "_properties.json"), JSON.stringify({ sort: byDate }));
    expect((await state()).fallback).toEqual(byDate);
    expect(names((await state()).shown)).toEqual(["take 10.md", "take 3.md", "take 2.md", "extras"]);
  });

  // A rule, never the order it shows: the manifest stays for Manual order.
  it("orders the tree by a folder's own date or size rule, keeping its manifest", async () => {
    writeFileSync(path.join(scenes, "_structure.json"), JSON.stringify({ order: [{ name: "take 3.md" }] }));
    for (const [name, day] of [
      ["take 2.md", 3],
      ["take 3.md", 1],
      ["take 10.md", 2],
    ] as const) {
      utimesSync(path.join(scenes, name), new Date(Date.UTC(2026, 0, day)), new Date(Date.UTC(2026, 0, day)));
    }
    writeFileSync(path.join(scenes, "_properties.json"), JSON.stringify({ sort: { by: "modified", order: "desc" } }));
    const folder = (await buildTree(root, root)).find((node) => node.name === "scenes");
    expect(folder?.sort).toEqual({ by: "modified", order: "desc" });
    expect(folder?.sortable).toBe(false);
    expect(names(folder?.children ?? [])).toEqual(["extras", "take 2.md", "take 10.md", "take 3.md"]);
    expect((await state()).manifest).toEqual(["take 3.md"]);

    writeFileSync(path.join(scenes, "take 3.md"), "---\ndate: 2026-01-02\n---\nThe longest of the three takes.\n");
    writeFileSync(path.join(scenes, "_properties.json"), JSON.stringify({ sort: { by: "size", order: "desc" } }));
    expect(names((await state()).shown)).toEqual(["extras", "take 3.md", "take 2.md", "take 10.md"]);
  });

  it("keeps a sort only while it shows the folder another way", async () => {
    await save({ sort: { by: "name", order: "asc" } });
    expect(await readLocalSorts(root)).toEqual({});
    await save({ sort: { by: "name", order: "desc" } });
    expect(await readLocalSorts(root)).toEqual({ scenes: { sort: { by: "name", order: "desc" } } });
    expect(names((await state()).shown)).toEqual(["extras", "take 10.md", "take 3.md", "take 2.md"]);
    expect((await state()).local).toEqual({ by: "name", order: "desc" });
    await save({ sort: undefined });
    expect(await readLocalSorts(root)).toEqual({});
  });

  it("starts Manual order from the order on screen, or the folder's kept manifest", async () => {
    await save({ sort: { by: "property", property: "date", order: "desc" } });
    await save({ sort: { by: "manual" } });
    expect((await readLocalSorts(root)).scenes).toEqual({
      sort: { by: "manual" },
      arrangement: ["take 10.md", "take 3.md", "take 2.md", "extras"],
    });

    await save({ sort: undefined, arrangement: null });
    writeFileSync(path.join(scenes, "_structure.json"), JSON.stringify({ order: [{ name: "take 3.md" }] }));
    writeFileSync(path.join(scenes, "_properties.json"), JSON.stringify({ sort: { by: "name", order: "asc" } }));
    await save({ sort: { by: "manual" } });
    expect((await readLocalSorts(root)).scenes?.arrangement).toEqual([
      "take 3.md",
      "extras",
      "take 2.md",
      "take 10.md",
    ]);
  });

  it("drops an arrangement that matches the folder's own manual order", async () => {
    writeFileSync(path.join(scenes, "_structure.json"), JSON.stringify({ order: [{ name: "take 3.md" }] }));
    await save({ sort: { by: "manual" } });
    expect(await readLocalSorts(root)).toEqual({});
    await save({ sort: { by: "manual" }, arrangement: ["take 2.md", "take 3.md"] });
    expect((await state()).local).toEqual({ by: "manual" });
    await save({ sort: { by: "manual" }, arrangement: ["take 3.md", "extras", "take 2.md", "take 10.md"] });
    expect(await readLocalSorts(root)).toEqual({});
  });

  it("brings back a dragged arrangement when Manual order is picked again", async () => {
    const arrangement = ["take 3.md", "take 2.md", "extras", "take 10.md"];
    await save({ sort: { by: "manual" }, arrangement });
    await save({ sort: { by: "name", order: "asc" } });
    expect((await readLocalSorts(root)).scenes).toEqual({ arrangement });
    await save({ sort: { by: "manual" } });
    expect(names((await state()).shown)).toEqual(arrangement);
  });

  it("keeps a folder's cards beside its sort, and nothing for tiles", async () => {
    await saveFolderLayout(root, "scenes", "cards");
    expect((await readLocalSorts(root)).scenes).toEqual({ layout: "cards" });
    await save({ sort: { by: "name", order: "desc" } });
    expect((await readLocalSorts(root)).scenes).toEqual({ sort: { by: "name", order: "desc" }, layout: "cards" });
    await save({ sort: { by: "name", order: "asc" } });
    expect((await readLocalSorts(root)).scenes).toEqual({ layout: "cards" });
    await saveFolderLayout(root, "scenes", "tiles");
    expect(await readLocalSorts(root)).toEqual({});
  });

  it("names a folder's place in a library by its rooted path", async () => {
    await saveLocalSort(root, "lib:footage", scenes, "library", { sort: { by: "size", order: "desc" } });
    expect(await readLocalSorts(root)).toEqual({ "lib:footage": { sort: { by: "size", order: "desc" } } });
    // A library keeps no order, so Name is its own and a manual sort differs.
    expect((await folderSortState(scenes, "library", { sort: { by: "manual" } })).local).toEqual({ by: "manual" });
  });

  it("keeps the rest of the layout, and drops an entry that doesn't parse", async () => {
    await writeFolderState(root, { collapsedFolders: ["scenes"] });
    await updateLocalSorts(root, () => ({ scenes: { sort: { by: "size", order: "asc" } } }));
    const id = findSpaceId(loadGlobalConfig(), root) ?? "";
    const file = JSON.parse(readFileSync(globalLayoutPath(id), "utf8"));
    expect(file.collapsedFolders).toEqual(["scenes"]);
    file.localSorts.broken = { sort: { by: "colour" } };
    writeFileSync(globalLayoutPath(id), JSON.stringify(file));
    expect(await readLocalSorts(root)).toEqual({ scenes: { sort: { by: "size", order: "asc" } } });
  });

  it("keeps a Table's layout beside the folders' sorts, and nothing for its file's own", async () => {
    await saveFolderLayout(root, "scenes", "cards");
    await saveTableLayout(root, "scenes/shots.table.html", "cards", "list");
    await saveTableLayout(root, "board.table.html", "list", "cards");
    expect(await readTableLayouts(root)).toEqual({ "scenes/shots.table.html": "cards", "board.table.html": "list" });
    expect(await readLocalSorts(root)).toEqual({ scenes: { layout: "cards" } });

    await saveTableLayout(root, "scenes/shots.table.html", "list", "list");
    await saveTableLayout(root, "board.table.html", "cards", "cards");
    expect(await readTableLayouts(root)).toEqual({});

    const id = findSpaceId(loadGlobalConfig(), root) ?? "";
    const file = JSON.parse(readFileSync(globalLayoutPath(id), "utf8"));
    file.tableLayouts = { "a.table.html": "tiles", "b.table.html": "cards" };
    writeFileSync(globalLayoutPath(id), JSON.stringify(file));
    expect(await readTableLayouts(root)).toEqual({ "b.table.html": "cards" });
  });

  it("keeps whether a Flow shows App mode, and nothing for its file's own", async () => {
    await saveFlowAppMode(root, "flows/brief.flow.html", true, false);
    await saveFlowAppMode(root, "form.flow.html", false, true);
    expect(await readFlowAppModes(root)).toEqual({ "flows/brief.flow.html": true, "form.flow.html": false });

    await saveFlowAppMode(root, "flows/brief.flow.html", false, false);
    await saveFlowAppMode(root, "form.flow.html", true, true);
    expect(await readFlowAppModes(root)).toEqual({});

    const id = findSpaceId(loadGlobalConfig(), root) ?? "";
    const file = JSON.parse(readFileSync(globalLayoutPath(id), "utf8"));
    file.flowAppModes = { "a.flow.html": "yes", "b.flow.html": true };
    writeFileSync(globalLayoutPath(id), JSON.stringify(file));
    expect(await readFlowAppModes(root)).toEqual({ "b.flow.html": true });
  });
});

describe("a folder's sort follows its entries", () => {
  const sorts: Record<string, LocalSort> = {
    scenes: { sort: { by: "manual" }, arrangement: ["b.md", "act 1", "a.md"] },
    "scenes/act 1": { sort: { by: "name", order: "desc" } },
    "scenes/act 1/beats": { sort: { by: "size", order: "desc" } },
    "lib:footage/day 1": { arrangement: ["x.png", "y.png"] },
  };

  it("moves with a renamed folder and the folders under it, keeping its place", async () => {
    expect(movedLocalSorts(sorts, "scenes/act 1", "scenes/act one")).toEqual({
      scenes: { sort: { by: "manual" }, arrangement: ["b.md", "act one", "a.md"] },
      "scenes/act one": { sort: { by: "name", order: "desc" } },
      "scenes/act one/beats": { sort: { by: "size", order: "desc" } },
      "lib:footage/day 1": { arrangement: ["x.png", "y.png"] },
    });
  });

  it("leaves its old folder's arrangement when moved out of it", async () => {
    expect(movedLocalSorts(sorts, "lib:footage/day 1/x.png", "lib:footage/x.png")?.["lib:footage/day 1"]).toEqual({
      arrangement: ["y.png"],
    });
    expect(movedLocalSorts(sorts, "notes/a.md", "notes/b.md")).toBeUndefined();
  });

  it("goes with a deleted folder, and leaves its folder's arrangement", async () => {
    expect(forgottenLocalSorts(sorts, "scenes/act 1")).toEqual({
      scenes: { sort: { by: "manual" }, arrangement: ["b.md", "a.md"] },
      "lib:footage/day 1": { arrangement: ["x.png", "y.png"] },
    });
    expect(forgottenLocalSorts(sorts, "elsewhere")).toBeUndefined();
  });

  it("puts a duplicate right after its original", async () => {
    expect(duplicatedLocalSorts(sorts, "scenes/b.md", "b 2.md")?.scenes?.arrangement).toEqual([
      "b.md",
      "b 2.md",
      "act 1",
      "a.md",
    ]);
    expect(duplicatedLocalSorts(sorts, "scenes/new.md", "new 2.md")).toBeUndefined();
  });
});

describe("a Table's layout follows its file", () => {
  const layouts: Record<string, TableLayout> = {
    "shots/day 1.table.html": "cards",
    "shots/act 1/beats.table.html": "list",
    "lib:footage/takes.table.html": "cards",
  };

  it("moves with a renamed Table, and with the folder it is in", async () => {
    expect(movedByPath(layouts, "shots/day 1.table.html", "shots/day one.table.html")).toEqual({
      "shots/day one.table.html": "cards",
      "shots/act 1/beats.table.html": "list",
      "lib:footage/takes.table.html": "cards",
    });
    expect(movedByPath(layouts, "shots", "scenes")).toEqual({
      "scenes/day 1.table.html": "cards",
      "scenes/act 1/beats.table.html": "list",
      "lib:footage/takes.table.html": "cards",
    });
    // A folder named like the Table's start is not the Table's folder.
    expect(movedByPath(layouts, "shots/day 1", "shots/day 2")).toBeUndefined();
  });

  it("goes with a deleted Table, and with the folder it is in", async () => {
    expect(forgottenByPath(layouts, "lib:footage/takes.table.html")).toEqual({
      "shots/day 1.table.html": "cards",
      "shots/act 1/beats.table.html": "list",
    });
    expect(forgottenByPath(layouts, "shots")).toEqual({ "lib:footage/takes.table.html": "cards" });
    expect(forgottenByPath(layouts, "elsewhere")).toBeUndefined();
  });
});
