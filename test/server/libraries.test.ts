import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LibraryLocation, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { isAccess, libraryRows, mintLibraryId, readLibraries } from "../../src/server/libraries.ts";
import {
  addOfferedLibrary,
  addSpaceLibrary,
  describeSpaceLibrary,
  libraryOffers,
  locateSpaceLibrary,
  moveLibrariesOntoSpaces,
  relabelSpaceLibrary,
  removeSpaceLibrary,
  setSpaceLibraryAccess,
} from "../../src/server/spaceLibraries.ts";

let configDir: string;
let space: string;
let footage: string;
let stills: string;
const made: string[] = [];

const folder = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const declare = (root: string, file: unknown) =>
  writeFileSync(path.join(root, "_libraries.json"), typeof file === "string" ? file : JSON.stringify(file));
const declared = (root: string) => readFileSync(path.join(root, "_libraries.json"), "utf8");

function register(root: string, libraries?: Record<string, LibraryLocation>): string {
  const config = loadGlobalConfig();
  const id = `spc_${Object.keys(config.spaces ?? {}).length}`;
  saveGlobalConfig({ ...config, spaces: { ...config.spaces, [id]: { path: root, ...(libraries && { libraries }) } } });
  return id;
}

const locations = (spaceId: string) => loadGlobalConfig().spaces?.[spaceId]?.libraries;

beforeEach(() => {
  configDir = folder("pragma-libraries-config-");
  process.env.PRAGMA_CONFIG_DIR = configDir;
  space = folder("pragma-libraries-space-");
  footage = folder("pragma-libraries-footage-");
  stills = folder("pragma-libraries-stills-");
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a space's libraries", () => {
  it("lists every library the space declares, each found where this host located it", () => {
    declare(space, { libraries: [{ id: "footage", label: "Footage" }, { id: "stills" }] });
    register(space, { footage: { path: footage, access: "read-write" } });
    expect(libraryRows(space)).toEqual({
      libraries: [
        { id: "footage", label: "Footage", path: footage, access: "read-write", missing: false },
        // Declared on another machine: listed with no path, and nothing writes there.
        { id: "stills", label: "stills", access: "read-only", missing: true },
      ],
    });
    expect(readLibraries(space)).toEqual([{ id: "footage", label: "Footage", path: footage, access: "read-write" }]);
  });

  it("reports a located folder that isn't there right now, keeping its path", () => {
    const gone = path.join(tmpdir(), "pragma-libraries-not-there");
    declare(space, { libraries: [{ id: "gone", label: "Gone" }] });
    register(space, { gone: { path: gone, access: "read-only" } });
    expect(libraryRows(space).libraries).toEqual([
      { id: "gone", label: "Gone", path: gone, access: "read-only", missing: true },
    ]);
  });

  // The space decides which libraries it has: a folder this host keeps for an
  // id the space no longer declares names nothing, and neither does a
  // declaration in a space the registry doesn't hold.
  it("resolves only a library the space declares and this host located", () => {
    declare(space, { libraries: [{ id: "footage", label: "Footage" }] });
    register(space, { stills: { path: stills, access: "read-only" } });
    expect(readLibraries(space)).toEqual([]);

    const unregistered = folder("pragma-libraries-unregistered-");
    declare(unregistered, { libraries: [{ id: "footage", label: "Footage" }] });
    expect(readLibraries(unregistered)).toEqual([]);
    expect(libraryRows(unregistered).libraries.map((row) => row.missing)).toEqual([true]);
  });

  it("says why a file that exists declares nothing, rather than reading it as none", () => {
    register(space);
    declare(space, "{ nope");
    expect(libraryRows(space)).toMatchObject({ libraries: [], problem: expect.stringMatching(/doesn't parse/) });
    declare(space, { libraries: { footage: {} } });
    expect(libraryRows(space)).toEqual({ libraries: [], problem: "_libraries.json holds no list of libraries" });
  });

  it("finds the file under any spelling of its name, as every file Pragma names itself", () => {
    writeFileSync(path.join(space, "_Libraries.JSON"), JSON.stringify({ libraries: [{ id: "footage" }] }));
    register(space, { footage: { path: footage, access: "read-only" } });
    expect(readLibraries(space).map((library) => library.id)).toEqual(["footage"]);
  });
});

describe("adding and locating a library", () => {
  it("declares a picked folder under an id minted from its name, located there read-only", async () => {
    const spaceId = register(space);
    const library = await addSpaceLibrary(space, footage);
    expect(library).toEqual({
      id: mintLibraryId(path.basename(footage), []),
      label: path.basename(footage),
      path: footage,
      access: "read-only",
    });
    expect(JSON.parse(declared(space))).toEqual({ libraries: [{ id: library.id, label: library.label }] });
    expect(locations(spaceId)).toEqual({ [library.id]: { path: footage, access: "read-only" } });
  });

  it("refuses a folder already one of the space's libraries, but not one another space has", async () => {
    register(space);
    await addSpaceLibrary(space, footage);
    await expect(addSpaceLibrary(space, footage)).rejects.toThrow(/already one of this space's libraries/);

    const other = folder("pragma-libraries-other-");
    register(other);
    expect((await addSpaceLibrary(other, footage)).path).toBe(footage);
  });

  it("refuses a folder for a space the registry doesn't hold, and writes nothing", async () => {
    await expect(addSpaceLibrary(space, footage)).rejects.toThrow(/not a registered space/);
    expect(existsSync(path.join(space, "_libraries.json"))).toBe(false);
  });

  // Locate is how a space opened on a new machine finds its libraries, and
  // how one whose folder moved gets it back: the id every `lib:` path was
  // written against stays, and so does the access a person chose.
  it("points a declared library at a picked folder, keeping its id and access", () => {
    declare(space, {
      libraries: [
        { id: "footage", label: "Footage" },
        { id: "stills", label: "Stills" },
      ],
    });
    const spaceId = register(space, { footage: { path: path.join(tmpdir(), "moved-away"), access: "read-write" } });
    locateSpaceLibrary(space, "footage", footage);
    locateSpaceLibrary(space, "stills", stills);
    expect(locations(spaceId)).toEqual({
      footage: { path: footage, access: "read-write" },
      stills: { path: stills, access: "read-only" },
    });
    expect(() => locateSpaceLibrary(space, "stills", footage)).toThrow(/already another of this space's libraries/);
    expect(() => locateSpaceLibrary(space, "nope", stills)).toThrow(/Not one of this space's libraries/);
  });
});

// What Add library offers besides a picker: a folder this host located for
// another space, named back by that space's id and the library's.
describe("offering other spaces' libraries", () => {
  it("offers each folder other spaces located once, that this space hasn't got, by label", () => {
    const first = folder("pragma-libraries-first-");
    declare(first, {
      libraries: [
        { id: "stills", label: "Stills" },
        { id: "reels", label: "Reels" },
      ],
    });
    const firstId = register(first, {
      stills: { path: stills, access: "read-write" },
      reels: { path: footage, access: "read-only" },
    });
    const second = folder("pragma-libraries-second-");
    declare(second, {
      libraries: [
        { id: "again", label: "Again" },
        { id: "art", label: "art" },
      ],
    });
    const art = folder("pragma-libraries-art-");
    const secondId = register(second, {
      again: { path: stills, access: "read-only" },
      art: { path: art, access: "read-only" },
    });
    declare(space, { libraries: [{ id: "mine", label: "Mine" }] });
    register(space, { mine: { path: footage, access: "read-only" } });

    expect(libraryOffers(space)).toEqual([
      { space: secondId, id: "art", label: "art", path: art },
      { space: firstId, id: "stills", label: "Stills", path: stills },
    ]);
  });

  it("leaves out a folder that isn't there, a location no space declares, and a space whose folder is gone", () => {
    const other = folder("pragma-libraries-other-");
    declare(other, { libraries: [{ id: "gone", label: "Gone" }] });
    register(other, {
      gone: { path: path.join(tmpdir(), "pragma-libraries-not-there"), access: "read-only" },
      stale: { path: stills, access: "read-only" },
    });
    register(path.join(tmpdir(), "pragma-libraries-no-space"), { reels: { path: footage, access: "read-only" } });
    register(space);
    expect(libraryOffers(space)).toEqual([]);
  });

  it("adds an offered library read-only, keeping its label and, where it is free here, its id", async () => {
    const other = folder("pragma-libraries-other-");
    declare(other, {
      libraries: [
        { id: "stills", label: "Stills" },
        { id: "reels", label: "Reels" },
      ],
    });
    const otherId = register(other, {
      stills: { path: stills, access: "read-write" },
      reels: { path: footage, access: "read-write" },
    });
    declare(space, { libraries: [{ id: "reels", label: "Mine" }] });
    const spaceId = register(space);

    expect(await addOfferedLibrary(space, { space: otherId, id: "stills" })).toEqual({
      id: "stills",
      label: "Stills",
      path: stills,
      access: "read-only",
    });
    // Taken here by another library, so the folder's own name gives the id.
    const reels = await addOfferedLibrary(space, { space: otherId, id: "reels" });
    expect(reels).toMatchObject({ id: mintLibraryId(path.basename(footage), []), label: "Reels", access: "read-only" });
    expect(locations(spaceId)).toEqual({
      stills: { path: stills, access: "read-only" },
      [reels.id]: { path: footage, access: "read-only" },
    });
  });

  it("carries a library's description into the offer and into the space that adds it", async () => {
    const other = folder("pragma-libraries-other-");
    declare(other, { libraries: [{ id: "stills", label: "Stills", description: "Frames from the shoot" }] });
    const otherId = register(other, { stills: { path: stills, access: "read-only" } });
    register(space);

    expect(libraryOffers(space)).toEqual([
      { space: otherId, id: "stills", label: "Stills", description: "Frames from the shoot", path: stills },
    ]);
    expect(await addOfferedLibrary(space, { space: otherId, id: "stills" })).toEqual({
      id: "stills",
      label: "Stills",
      description: "Frames from the shoot",
      path: stills,
      access: "read-only",
    });
    expect(JSON.parse(declared(space))).toEqual({
      libraries: [{ id: "stills", label: "Stills", description: "Frames from the shoot" }],
    });
  });

  it("refuses an offer that isn't one, rather than taking a folder from the request", async () => {
    const other = folder("pragma-libraries-other-");
    declare(other, { libraries: [{ id: "stills", label: "Stills" }] });
    const otherId = register(other, { stills: { path: stills, access: "read-only" } });
    register(space);
    for (const from of [{ space: otherId, id: "nope" }, { space: "spc_nope", id: "stills" }, { path: stills }, {}]) {
      await expect(addOfferedLibrary(space, from)).rejects.toThrow(/No other space on this computer has that library/);
    }
    expect(existsSync(path.join(space, "_libraries.json"))).toBe(false);
  });
});

describe("changing a library", () => {
  beforeEach(() => {
    declare(space, {
      libraries: [
        { id: "footage", label: "Footage" },
        { id: "stills", label: "Stills" },
      ],
    });
  });

  it("sets a located library's access from the closed set, and nothing else", () => {
    const spaceId = register(space, { footage: { path: footage, access: "read-only" } });
    setSpaceLibraryAccess(space, "footage", "read-write");
    expect(locations(spaceId)?.footage).toEqual({ path: footage, access: "read-write" });
    // The doorway denies anything but the literal `read-write`, so a value
    // outside the set would act as read-only while the config held it.
    for (const value of ["rw", "READ-WRITE", "", undefined, 1]) {
      expect(() => setSpaceLibraryAccess(space, "footage", value)).toThrow(/Not a library access/);
    }
    expect(() => setSpaceLibraryAccess(space, "stills", "read-write")).toThrow(/Locate this library/);
    expect(() => setSpaceLibraryAccess(space, "nope", "read-write")).toThrow(/Not one of this space's libraries/);
  });

  it("relabels in the space's file, a blank label going back to the folder's name or the id", async () => {
    register(space, { footage: { path: footage, access: "read-only" } });
    await relabelSpaceLibrary(space, "footage", "  Archive  ");
    expect(libraryRows(space).libraries.map((row) => row.label)).toEqual(["Archive", "Stills"]);
    await relabelSpaceLibrary(space, "footage", " ");
    await relabelSpaceLibrary(space, "stills", "");
    expect(libraryRows(space).libraries.map((row) => row.label)).toEqual([path.basename(footage), "stills"]);
    await expect(relabelSpaceLibrary(space, "footage", 1)).rejects.toThrow(/must be text/);
  });

  // The 80-character limit is the panel's, for typing and its tooltip: the
  // file keeps a longer one whole.
  it("describes in the space's file, located here or not, a blank description taking it away", async () => {
    register(space, { footage: { path: footage, access: "read-only" } });
    await describeSpaceLibrary(space, "footage", "  Reels from the shoot  ");
    const long = "x".repeat(200);
    await describeSpaceLibrary(space, "stills", long);
    expect(libraryRows(space).libraries.map((row) => row.description)).toEqual(["Reels from the shoot", long]);
    expect(readLibraries(space).map((entry) => entry.description)).toEqual(["Reels from the shoot"]);

    await describeSpaceLibrary(space, "footage", " ");
    expect(JSON.parse(declared(space))).toEqual({
      libraries: [
        { id: "footage", label: "Footage" },
        { id: "stills", label: "Stills", description: long },
      ],
    });
    await expect(describeSpaceLibrary(space, "footage", 1)).rejects.toThrow(/must be text/);
    await expect(describeSpaceLibrary(space, "nope", "x")).rejects.toThrow(/Not one of this space's libraries/);
  });

  it("removes a library from the space and this host, leaving its folder alone", async () => {
    const spaceId = register(space, { footage: { path: footage, access: "read-only" } });
    await removeSpaceLibrary(space, "footage");
    expect(JSON.parse(declared(space))).toEqual({ libraries: [{ id: "stills", label: "Stills" }] });
    expect(locations(spaceId)).toBeUndefined();
    expect(existsSync(footage)).toBe(true);

    // A file left declaring nothing, and holding nothing else, goes.
    await removeSpaceLibrary(space, "stills");
    expect(existsSync(path.join(space, "_libraries.json"))).toBe(false);
    await expect(removeSpaceLibrary(space, "stills")).rejects.toThrow(/Not one of this space's libraries/);
  });

  it("keeps what the file holds that it doesn't read, one library to a line", async () => {
    declare(space, {
      note: "kept",
      libraries: [{ id: "footage", label: "Footage", color: "#fff" }, { id: "Not An Id" }, { id: "stills" }],
    });
    register(space);
    await relabelSpaceLibrary(space, "footage", "Reels");
    expect(declared(space)).toBe(
      [
        "{",
        '  "note": "kept",',
        '  "libraries": [',
        '    { "id": "footage", "label": "Reels", "color": "#fff" },',
        '    { "id": "Not An Id" },',
        '    { "id": "stills" }',
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("never writes over a file that doesn't read", async () => {
    register(space, { footage: { path: footage, access: "read-only" } });
    declare(space, "{ nope");
    await expect(relabelSpaceLibrary(space, "footage", "Reels")).rejects.toThrow(/Fix the file/);
    await expect(removeSpaceLibrary(space, "footage")).rejects.toThrow(/Fix the file/);
    expect(declared(space)).toBe("{ nope");
  });
});

describe("mintLibraryId", () => {
  it("slugifies the folder's name and steps past the ids the space declares", () => {
    expect(mintLibraryId("B-Roll 2024", [])).toBe("b-roll-2024");
    expect(mintLibraryId("Forbidden", ["forbidden"])).toBe("forbidden-2");
    expect(mintLibraryId("forbidden", ["forbidden", "forbidden-2"])).toBe("forbidden-3");
    expect(mintLibraryId("!!!", [])).toBe("library");
  });
});

describe("isAccess", () => {
  it("accepts exactly the two spellings the doorway reads", () => {
    expect(isAccess("read-only")).toBe(true);
    expect(isAccess("read-write")).toBe(true);
    expect(isAccess("read_write")).toBe(false);
    expect(isAccess(undefined)).toBe(false);
  });
});

describe("moving an install-wide list onto the spaces", () => {
  const list = () => [
    { id: "footage", label: "Footage", path: footage, access: "read-write" as const },
    { id: "stills", label: "Stills", path: stills, access: "read-only" as const },
  ];

  it("gives each space the libraries its files name, keeping ids, labels and folders", async () => {
    mkdirSync(path.join(space, "notes"));
    writeFileSync(path.join(space, "notes", "a.md"), "![](lib:footage/reel.mp4)\n");
    const other = folder("pragma-libraries-other-");
    mkdirSync(path.join(other, ".pragma"));
    writeFileSync(
      path.join(other, ".pragma", "bookmarks.json"),
      JSON.stringify({ bookmarks: [{ path: "lib:stills/a/" }] }),
    );
    const spaceId = register(space);
    const otherId = register(other);
    const empty = register(folder("pragma-libraries-empty-"));
    saveGlobalConfig({ ...loadGlobalConfig(), libraries: list() });

    await moveLibrariesOntoSpaces();

    expect(libraryRows(space).libraries.map((row) => [row.id, row.label, row.path, row.access])).toEqual([
      ["footage", "Footage", footage, "read-write"],
    ]);
    expect(libraryRows(other).libraries.map((row) => [row.id, row.path])).toEqual([["stills", stills]]);
    expect(locations(spaceId)).toEqual({ footage: { path: footage, access: "read-write" } });
    expect(locations(otherId)).toEqual({ stills: { path: stills, access: "read-only" } });
    expect(locations(empty)).toBeUndefined();
    expect(loadGlobalConfig().libraries).toBeUndefined();
  });

  it("gives a library no space names to the space opened last, and keeps what a space already has", async () => {
    const first = register(space);
    const recent = folder("pragma-libraries-recent-");
    const elsewhere = folder("pragma-libraries-elsewhere-");
    declare(recent, { libraries: [{ id: "stills", label: "My stills" }] });
    const recentId = register(recent, { stills: { path: elsewhere, access: "read-only" } });
    saveGlobalConfig({ ...loadGlobalConfig(), recentSpaceIds: [recentId, first], libraries: list() });

    await moveLibrariesOntoSpaces();

    expect(libraryRows(recent).libraries.map((row) => [row.id, row.label, row.path])).toEqual([
      ["stills", "My stills", elsewhere],
      ["footage", "Footage", footage],
    ]);
    expect(existsSync(path.join(space, "_libraries.json"))).toBe(false);
  });

  it("keeps the list when a space can't take its libraries, for the next start to finish", async () => {
    writeFileSync(path.join(space, "a.md"), "![](lib:footage/reel.mp4)\n");
    declare(space, "{ nope");
    register(space);
    saveGlobalConfig({ ...loadGlobalConfig(), libraries: list() });

    await expect(moveLibrariesOntoSpaces()).rejects.toThrow(/keeps its libraries list/);
    expect(loadGlobalConfig().libraries).toHaveLength(2);
    expect(declared(space)).toBe("{ nope");

    declare(space, { libraries: [] });
    await moveLibrariesOntoSpaces();
    expect(readLibraries(space).map((library) => library.id)).toEqual(["footage", "stills"]);
    expect(loadGlobalConfig().libraries).toBeUndefined();
  });

  it("does nothing on a config with no such list", async () => {
    register(space);
    const before = readFileSync(path.join(configDir, "config.json"), "utf8");
    await moveLibrariesOntoSpaces();
    expect(readFileSync(path.join(configDir, "config.json"), "utf8")).toBe(before);
  });
});
