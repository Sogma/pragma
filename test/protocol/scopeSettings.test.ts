import { describe, expect, it } from "vitest";
import {
  settingFolder,
  settingSource,
  settingValue,
  startingSettings,
  WORLD_SETTING,
  writeSetting,
} from "../../src/protocol/scopeSettings.ts";

// Conformance tests for docs/protocol.md's Scopes: the settings a scope's
// `pragma` value holds, a document kind's under its kind's name.
describe("a scope's settings", () => {
  it("reads a kind's setting under the kind's name, and nothing from a bare pragma", () => {
    expect(settingValue({ screenplay: { world: "world/" } }, WORLD_SETTING)).toBe("world/");
    expect(settingValue("", WORLD_SETTING)).toBeUndefined();
    expect(settingValue({ world: "world/" }, WORLD_SETTING)).toBeUndefined();
  });

  it("sets a setting, making the maps it needs out of a bare pragma", () => {
    const frontmatter: Record<string, unknown> = { pragma: "", tags: ["film"] };
    writeSetting(frontmatter, WORLD_SETTING, "world/");
    expect(frontmatter).toEqual({ pragma: { screenplay: { world: "world/" } }, tags: ["film"] });
  });

  it("keeps the keys it doesn't know, a kind's and core's alike", () => {
    const frontmatter: Record<string, unknown> = { pragma: { outline: { beats: 8 }, screenplay: { wrold: "notes/" } } };
    writeSetting(frontmatter, WORLD_SETTING, "world/");
    expect(frontmatter.pragma).toEqual({ outline: { beats: 8 }, screenplay: { wrold: "notes/", world: "world/" } });
  });

  it("clears a setting and every map it leaves empty, but never the pragma that opens the scope", () => {
    const frontmatter: Record<string, unknown> = { pragma: { screenplay: { world: "world/" } } };
    writeSetting(frontmatter, WORLD_SETTING, undefined);
    expect(frontmatter).toEqual({ pragma: "" });
  });

  it("leaves a bare pragma bare when there is nothing to clear", () => {
    const frontmatter: Record<string, unknown> = { pragma: null };
    writeSetting(frontmatter, WORLD_SETTING, undefined);
    expect(frontmatter).toEqual({ pragma: null });
  });

  it("never changes the map it was handed, only the frontmatter's key", () => {
    const block = { screenplay: { world: "world/" } };
    writeSetting({ pragma: block }, WORLD_SETTING, "cast/");
    expect(block).toEqual({ screenplay: { world: "world/" } });
  });
});

describe("where a setting comes from", () => {
  const blocks: Record<string, unknown> = {
    "": { screenplay: { world: "shared/" } },
    film: { screenplay: { world: "world/" } },
    "film/story": "",
  };
  const blockOf = (folder: string) => blocks[folder];

  it("is the nearest scope that gives it a value, an inner one before an outer one", () => {
    expect(settingSource(blockOf, "film/story/scenes", WORLD_SETTING)).toEqual({ scope: "film", value: "world/" });
  });

  it("reaches the space's own scope last", () => {
    expect(settingSource(blockOf, "notes", WORLD_SETTING)).toEqual({ scope: "", value: "shared/" });
  });
});

describe("the folder a setting names", () => {
  it("is read from its scope's folder, or from the root", () => {
    expect(settingFolder("film", "story/world/")).toBe("film/story/world");
    expect(settingFolder("film", "/film/story/world/")).toBe("film/story/world");
  });

  it("may be the scope's own folder", () => {
    expect(settingFolder("film", "./")).toBe("film");
  });

  it("is nothing outside the scope, in a library, or past the root", () => {
    expect(settingFolder("film", "../notes/")).toBeUndefined();
    expect(settingFolder("film", "/notes/")).toBeUndefined();
    expect(settingFolder("film", "lib:footage/world/")).toBeUndefined();
    expect(settingFolder("film", "../../../x/")).toBeUndefined();
  });

  it("is anywhere in the space for the space's own scope", () => {
    expect(settingFolder("", "notes/world/")).toBe("notes/world");
  });
});

describe("a scope turned on", () => {
  it("takes each start folder its own folder holds, and nothing it lacks", () => {
    expect(startingSettings("film", (path) => path === "film/world")).toEqual([
      { setting: WORLD_SETTING, folder: "film/world" },
    ]);
    expect(startingSettings("notes", () => false)).toEqual([]);
  });
});
