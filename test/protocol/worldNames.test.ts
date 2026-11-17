import { describe, expect, it } from "vitest";
import { settledToken } from "../../src/protocol/fountainElements.ts";
import {
  createWorldIndex,
  findWorldNames,
  resolveWorldName,
  type WorldNameLine,
  worldFilesNamed,
  worldFolder,
} from "../../src/protocol/worldNames.ts";

// Conformance tests for docs/protocol.md's World names: which names in a
// screenplay line link, and to which file.
const SPACE = [
  "projects/forbidden/README.md",
  "projects/forbidden/screenplay/Sequence 1/110 Prologue.fountain",
  "projects/forbidden/world/characters/Lina.md",
  "projects/forbidden/world/characters/The Thing.md",
  "projects/forbidden/world/locations/Vostok Station.md",
  "projects/forbidden/world/locations/Vostok Station - Radio Room.md",
  "projects/forbidden/world/locations/Lina's Apartment.md",
  "projects/forbidden/world/props/Box.table.html",
  "projects/forbidden/world/props/3D Map.md",
  "projects/other/README.md",
  "projects/other/world/Twin.md",
  "projects/other/world/sub/Twin.md",
  "notes/Lina.md",
];
const SCRIPT = "projects/forbidden/screenplay/Sequence 1/110 Prologue.fountain";

// Each scope's settings, by its folder: forbidden names its world.
const SETTINGS: Record<string, unknown> = { "projects/forbidden": { screenplay: { world: "world/" } } };
const blocksOf =
  (settings: Record<string, unknown>) =>
  (folder: string): unknown =>
    settings[folder];

function resolverFor(docPath: string): (name: string) => string | undefined {
  const folder = worldFolder(blocksOf(SETTINGS), docPath);
  if (folder === undefined) throw new Error(`${docPath} has no world`);
  const world = createWorldIndex(SPACE, folder);
  return (name) => resolveWorldName(world, name);
}

// Each linked name as `text → file name`, in line order.
function linked(text: string, line: WorldNameLine, docPath = SCRIPT): string[] {
  return findWorldNames(text, line, resolverFor(docPath)).map(
    (name) => `${text.slice(name.from, name.to)} → ${name.path.slice(name.path.lastIndexOf("/") + 1)}`,
  );
}

describe("a screenplay's world", () => {
  it("is the folder its scope's World setting names, read from the scope's folder", () => {
    expect(worldFolder(blocksOf(SETTINGS), SCRIPT)).toBe("projects/forbidden/world");
  });

  it("reads a setting written from the root as the same folder", () => {
    const settings = { "projects/forbidden": { screenplay: { world: "/projects/forbidden/world/" } } };
    expect(worldFolder(blocksOf(settings), SCRIPT)).toBe("projects/forbidden/world");
  });

  it("takes an enclosing scope's setting when its own scope gives none", () => {
    const settings = { ...SETTINGS, "projects/forbidden/screenplay": {} };
    expect(worldFolder(blocksOf(settings), SCRIPT)).toBe("projects/forbidden/world");
  });

  it("takes the nearest scope's setting over an outer one's", () => {
    const settings = { ...SETTINGS, "projects/forbidden/screenplay": { screenplay: { world: "cast/" } } };
    expect(worldFolder(blocksOf(settings), SCRIPT)).toBe("projects/forbidden/screenplay/cast");
  });

  it("names nothing outside the scope that sets it", () => {
    const settings = { "projects/forbidden": { screenplay: { world: "../other/world/" } } };
    expect(worldFolder(blocksOf(settings), SCRIPT)).toBeUndefined();
  });

  it("is absent where no scope gives a World setting, whatever folders are named world", () => {
    expect(worldFolder(blocksOf(SETTINGS), "projects/other/pilot.fountain")).toBeUndefined();
    expect(worldFolder(blocksOf(SETTINGS), "loose.fountain")).toBeUndefined();
  });

  it("holds only files under that folder, so a same-named note elsewhere never links", () => {
    const world = createWorldIndex(SPACE, "projects/forbidden/world");
    expect(resolveWorldName(world, "LINA")).toBe("projects/forbidden/world/characters/Lina.md");
  });

  it("matches the folder whatever its case", () => {
    const world = createWorldIndex(SPACE, "projects/forbidden/World");
    expect(resolveWorldName(world, "lina")).toBe("projects/forbidden/world/characters/Lina.md");
  });

  it("strips a compound extension from a file's name", () => {
    expect(resolveWorldName(createWorldIndex(SPACE, "projects/forbidden/world"), "BOX")).toBe(
      "projects/forbidden/world/props/Box.table.html",
    );
  });

  it("leaves a name two files share unlinked", () => {
    expect(resolveWorldName(createWorldIndex(SPACE, "projects/other/world"), "TWIN")).toBeUndefined();
  });

  it("leaves out media, so a picture beside its note never shares the note's name", () => {
    const world = createWorldIndex(
      [...SPACE, "projects/forbidden/world/characters/Lina.JPG", "projects/forbidden/world/props/Stone.mp4"],
      "projects/forbidden/world",
    );
    expect(resolveWorldName(world, "LINA")).toBe("projects/forbidden/world/characters/Lina.md");
    expect(resolveWorldName(world, "STONE")).toBeUndefined();
  });
});

describe("names in a character cue", () => {
  it("links the whole cue", () => {
    expect(linked("LINA", "character")).toEqual(["LINA → Lina.md"]);
    expect(linked("THE THING", "character")).toEqual(["THE THING → The Thing.md"]);
  });

  it("leaves out an extension, a forced cue's `@` and a dual cue's `^`", () => {
    expect(linked("LINA (V.O.)", "character")).toEqual(["LINA → Lina.md"]);
    expect(linked("LINA (V.O.) (CONT'D) ^", "character")).toEqual(["LINA → Lina.md"]);
    expect(linked("@Lina", "character")).toEqual(["Lina → Lina.md"]);
  });

  it("never links part of a cue", () => {
    expect(linked("YOUNG LINA", "character")).toEqual([]);
  });
});

describe("names in a scene heading", () => {
  it("links the location, between the prefix and the time of day", () => {
    expect(linked("EXT. VOSTOK STATION - NIGHT", "scene-heading")).toEqual(["VOSTOK STATION → Vostok Station.md"]);
    expect(linked("INT./EXT. VOSTOK STATION - DAY", "scene-heading")).toEqual(["VOSTOK STATION → Vostok Station.md"]);
    expect(linked("I/E VOSTOK STATION", "scene-heading")).toEqual(["VOSTOK STATION → Vostok Station.md"]);
  });

  it("reads a forced heading and stops before a scene number", () => {
    expect(linked(".Vostok Station #12#", "scene-heading")).toEqual(["Vostok Station → Vostok Station.md"]);
    expect(linked("INT. VOSTOK STATION - RADIO ROOM #110A.#", "scene-heading")).toEqual([
      "VOSTOK STATION - RADIO ROOM → Vostok Station - Radio Room.md",
    ]);
  });

  it("falls back to the longest part of the location that resolves", () => {
    expect(linked("INT. VOSTOK STATION RADIO ROOM - NIGHT", "scene-heading")).toEqual([
      "VOSTOK STATION → Vostok Station.md",
    ]);
  });

  it("prefers a possessive location to the name inside it", () => {
    expect(linked("INT. LINA'S APARTMENT - DAY", "scene-heading")).toEqual(["LINA'S APARTMENT → Lina's Apartment.md"]);
    expect(linked("INT. LINA'S CAR - DAY", "scene-heading")).toEqual(["LINA → Lina.md"]);
  });

  it("never reads the time of day", () => {
    expect(linked("INT. CRATER - LINA", "scene-heading")).toEqual([]);
  });

  it("links a room to the file named for it and its master location", () => {
    expect(linked("INT. VOSTOK STATION - RADIO ROOM - NIGHT", "scene-heading")).toEqual([
      "VOSTOK STATION - RADIO ROOM → Vostok Station - Radio Room.md",
    ]);
    expect(linked("INT. VOSTOK STATION - RADIO ROOM #4#", "scene-heading")).toEqual([
      "VOSTOK STATION - RADIO ROOM → Vostok Station - Radio Room.md",
    ]);
  });

  it("links the master location when the room has no file", () => {
    expect(linked("INT. VOSTOK STATION - KITCHEN - DAY", "scene-heading")).toEqual([
      "VOSTOK STATION → Vostok Station.md",
    ]);
  });

  it("never links a later part on its own", () => {
    expect(linked("INT. CRATER - VOSTOK STATION - DAY", "scene-heading")).toEqual([]);
    expect(linked("INT. RADIO ROOM - DAY", "scene-heading")).toEqual([]);
  });

  it("leaves a note out of the location, at its end or after a scene number", () => {
    expect(linked("INT. VOSTOK STATION - RADIO ROOM [[>sid_k3x9m2q7v1pa]]", "scene-heading")).toEqual([
      "VOSTOK STATION - RADIO ROOM → Vostok Station - Radio Room.md",
    ]);
    expect(linked("INT. VOSTOK STATION - RADIO ROOM #4# [[Recheck]]", "scene-heading")).toEqual([
      "VOSTOK STATION - RADIO ROOM → Vostok Station - Radio Room.md",
    ]);
  });
});

describe("names in an action line", () => {
  it("links a capitalised name inside a sentence", () => {
    expect(linked("The glow catches her face: LINA, mid 30s, ice-cold.", "action")).toEqual(["LINA → Lina.md"]);
  });

  it("links the longest capitalised run first", () => {
    expect(linked("Out of the dark, THE THING EMERGES.", "action")).toEqual(["THE THING → The Thing.md"]);
    expect(linked("LINA SCREAMS.", "action")).toEqual(["LINA → Lina.md"]);
  });

  it("links several names in one line", () => {
    expect(linked("LINA opens the BOX at VOSTOK STATION.", "action")).toEqual([
      "LINA → Lina.md",
      "BOX → Box.table.html",
      "VOSTOK STATION → Vostok Station.md",
    ]);
  });

  it("links a name before its possessive", () => {
    expect(linked("LINA's hand shakes.", "action")).toEqual(["LINA → Lina.md"]);
    expect(linked("LINA’S hand shakes.", "action")).toEqual(["LINA → Lina.md"]);
  });

  it("links a name written in mixed case, at the start of a sentence or inside one", () => {
    expect(linked("Lina turns away.", "action")).toEqual(["Lina → Lina.md"]);
    expect(linked("Lina's hand shakes.", "action")).toEqual(["Lina → Lina.md"]);
    expect(linked("Out of the dark, The Thing emerges.", "action")).toEqual(["The Thing → The Thing.md"]);
  });

  it("skips a capitalised word before a name that doesn't join it", () => {
    expect(linked("Then Lina walks in.", "action")).toEqual(["Lina → Lina.md"]);
    expect(linked("FBI Lina waits.", "action")).toEqual(["Lina → Lina.md"]);
  });

  it("ignores a name in lowercase, and never joins a lowercase word to a run", () => {
    expect(linked("lina turns away.", "action")).toEqual([]);
    expect(linked("The thing is, she's late.", "action")).toEqual([]);
  });

  it("reads a word by its first letter, not its first character", () => {
    expect(linked("She unfolds the 3D MAP, mid 30s.", "action")).toEqual(["3D MAP → 3D Map.md"]);
  });

  it("does not join words across punctuation", () => {
    expect(linked("THE. THING", "action")).toEqual([]);
  });

  it("reads nothing inside a note", () => {
    expect(linked("She waits. [[LINA should hesitate]]", "action")).toEqual([]);
    expect(linked("THE [[x]] THING", "action")).toEqual([]);
  });
});

describe("every world file a screenplay names", () => {
  // Each file's name, in the order the screenplay first names it.
  const named = (source: string) =>
    worldFilesNamed(source, resolverFor(SCRIPT)).map((file) => file.slice(file.lastIndexOf("/") + 1));

  it("reads cues, headings and action, each file once, by first mention", () => {
    const source = [
      "INT. VOSTOK STATION - RADIO ROOM - NIGHT",
      "",
      "LINA",
      "Where is it?",
      "",
      "THE THING emerges. Lina screams.",
    ].join("\n");
    expect(named(source)).toEqual(["Vostok Station - Radio Room.md", "Lina.md", "The Thing.md"]);
  });

  it("reads no title page, boneyard or note", () => {
    const source = [
      "Title: LINA",
      "Author: Someone",
      "",
      "/* LINA, cut",
      "THE THING */",
      "",
      "INT. LINA'S APARTMENT - DAY",
      "",
      "A light [[THE THING]] flickers.",
    ].join("\n");
    expect(named(source)).toEqual(["Lina's Apartment.md"]);
  });

  it("reads a cue with nothing under it as action, whose runs link apart", () => {
    expect(named("LINA AND THE THING\nStay back.")).toEqual([]);
    expect(named("LINA AND THE THING\n\nShe waits.")).toEqual(["Lina.md", "The Thing.md"]);
    expect(named("LINA AND THE THING")).toEqual(["Lina.md", "The Thing.md"]);
  });

  it("gives a line inside a note over several lines the kind of the line it opened on", () => {
    const source = ["INT. VOSTOK STATION - NIGHT [[the radio", "hums]] THE THING arrives."].join("\n");
    expect(named(source)).toEqual(["Vostok Station.md"]);
  });

  it("reads a source whose lines end in CRLF", () => {
    expect(named("LINA\r\nWhere?\r\n")).toEqual(["Lina.md"]);
  });
});

describe("a cue, once the line below it is known", () => {
  it("stands over a line of speech, and is action over an empty line or the end", () => {
    expect(settledToken("fountain-character", "Where?")).toBe("fountain-character");
    expect(settledToken("fountain-character-dual", "Here.")).toBe("fountain-character-dual");
    expect(settledToken("fountain-character", "")).toBe("fountain-action");
    expect(settledToken("fountain-character", undefined)).toBe("fountain-action");
    expect(settledToken("fountain-scene-heading", undefined)).toBe("fountain-scene-heading");
  });
});
