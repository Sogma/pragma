import { describe, expect, it } from "vitest";
import {
  formatPresetFolder,
  isPresetPath,
  presetAddRefusal,
  presetFolderAt,
  presetFolderOf,
  presetFolders,
  presetsAfterDelete,
  presetsAfterMove,
  readLuts,
  serializePresetsFile,
  withPresetChange,
} from "../../src/protocol/presets.ts";

describe("a listed folder", () => {
  it("is a space folder from the root or a library's, a trailing / either way", () => {
    expect(presetFolderOf("presets/luts/")).toEqual({ root: "space", path: "presets/luts" });
    expect(presetFolderOf("presets/luts")).toEqual({ root: "space", path: "presets/luts" });
    expect(presetFolderOf("/presets/luts/")).toEqual({ root: "space", path: "presets/luts" });
    expect(presetFolderOf("space:presets/")).toEqual({ root: "space", path: "presets" });
    expect(presetFolderOf("lib:film/")).toEqual({ root: { library: "film" }, path: "" });
    expect(presetFolderOf("lib:film/Print/")).toEqual({ root: { library: "film" }, path: "Print" });
  });

  // The whole space would leave every file out of its own content, and no
  // path names an entry under a dot.
  it("is never the space itself, a hidden entry or an unparseable path", () => {
    for (const written of [
      "",
      "/",
      "space:",
      ".trash/",
      "presets/.git/",
      "../luts/",
      "a//b/",
      "foo:bar/",
      "lib:Bad/",
    ]) {
      expect(presetFolderOf(written), written).toBeUndefined();
    }
  });

  it("is written with the / that marks a folder", () => {
    expect(formatPresetFolder({ root: "space", path: "presets/luts" })).toBe("presets/luts/");
    expect(formatPresetFolder({ root: { library: "film" }, path: "" })).toBe("lib:film/");
    expect(formatPresetFolder({ root: { library: "film" }, path: "Print" })).toBe("lib:film/Print/");
  });
});

describe("reading the file", () => {
  it("lists each kind's folders in file order, skipping entries naming none", () => {
    const parsed = { luts: ["lib:film/", 7, ".hidden/", "presets/luts/"], templates: ["presets/templates/"] };
    expect(presetFolders(parsed).map(({ kind, written }) => `${kind} ${written}`)).toEqual([
      "templates presets/templates/",
      "luts lib:film/",
      "luts presets/luts/",
    ]);
  });

  // Listed twice, or inside a folder the kind already lists, a folder's
  // files would show twice.
  it("counts a folder inside another of its kind once, as that one's", () => {
    const parsed = { luts: ["presets/luts/Kodak/", "presets/luts/", "Presets/LUTs/"] };
    expect(presetFolders(parsed).map(({ written }) => written)).toEqual(["presets/luts/"]);
  });

  it("reads nothing from a file without lists", () => {
    expect(presetFolders(undefined)).toEqual([]);
    expect(presetFolders({ luts: "presets/" })).toEqual([]);
  });
});

describe("what a listed folder holds", () => {
  const folders = presetFolders({ templates: ["presets/templates/"], luts: ["lib:film/", "Looks/"] });

  it("is the folder and everything under it, names compared as entry names are", () => {
    expect(isPresetPath(folders, "presets/templates/Daily Note.md")).toBe(true);
    expect(isPresetPath(folders, "Presets/Templates")).toBe(true);
    expect(isPresetPath(folders, "looks/warm.cube")).toBe(true);
    expect(isPresetPath(folders, "lib:film/Print/2383.cube")).toBe(true);
    expect(isPresetPath(folders, "presets/templatesx/a.md")).toBe(false);
    expect(isPresetPath(folders, "notes/a.md")).toBe(false);
    expect(isPresetPath(folders, "lib:other/a.cube")).toBe(false);
  });

  it("answers the kind a folder is listed for", () => {
    expect(presetFolderAt(folders, "looks/a.cube", "luts")?.written).toBe("Looks/");
    expect(presetFolderAt(folders, "looks/a.cube", "templates")).toBeUndefined();
  });
});

describe("listing a folder", () => {
  const folders = presetFolders({ templates: ["presets/templates/"], luts: ["presets/luts/"] });

  it("is refused inside a folder its kind lists, or across another kind's", () => {
    expect(presetAddRefusal(folders, "luts", { root: "space", path: "presets/luts/Kodak" })).toBe(
      "presets/luts/ already lists these LUTs",
    );
    expect(presetAddRefusal(folders, "luts", { root: "space", path: "presets/templates/x" })).toBe(
      "presets/templates/ is already listed for templates",
    );
    expect(presetAddRefusal(folders, "templates", { root: "space", path: "presets" })).toBe(
      "presets/luts/ is already listed for LUTs",
    );
    expect(presetAddRefusal(folders, "luts", { root: { library: "film" }, path: "" })).toBeUndefined();
  });

  it("puts it last for its kind, once, keeping every other key", () => {
    const file = { luts: ["presets/luts/"], note: "kept" };
    expect(withPresetChange(file, { add: "luts", folder: "lib:film/" })).toEqual({
      luts: ["presets/luts/", "lib:film/"],
      note: "kept",
    });
    expect(withPresetChange(file, { add: "luts", folder: "Presets/LUTs" })).toEqual(file);
    expect(withPresetChange(undefined, { add: "templates", folder: "presets/templates" })).toEqual({
      templates: ["presets/templates/"],
    });
  });

  it("drops the kind's folders it now holds", () => {
    const file = { luts: ["presets/luts/Kodak/", "lib:film/", "presets/luts/Fuji/"] };
    expect(withPresetChange(file, { add: "luts", folder: "presets/luts/" })).toEqual({
      luts: ["lib:film/", "presets/luts/"],
    });
  });

  it("takes out every entry naming it", () => {
    const file = { luts: ["presets/luts/", "lib:film/", "Presets/LUTs"] };
    expect(withPresetChange(file, { remove: "luts", folder: "presets/luts/" })).toEqual({ luts: ["lib:film/"] });
  });
});

describe("a listed folder that moves", () => {
  const file = { templates: ["presets/templates/"], luts: ["presets/luts/", "lib:film/Print/"] };

  it("is followed, on itself or a folder holding it", () => {
    expect(presetsAfterMove(file, "presets", "kit/presets")).toEqual({
      templates: ["kit/presets/templates/"],
      luts: ["kit/presets/luts/", "lib:film/Print/"],
    });
    expect(presetsAfterMove(file, "lib:film/Print", "lib:film/Prints")).toEqual({
      ...file,
      luts: ["presets/luts/", "lib:film/Prints/"],
    });
  });

  it("changes nothing when no listed folder moved", () => {
    expect(presetsAfterMove(file, "notes", "archive/notes")).toBeUndefined();
    expect(presetsAfterMove(file, "presets/luts/warm.cube", "warm.cube")).toBeUndefined();
  });

  it("goes when deleted, or when a folder holding it is", () => {
    expect(presetsAfterDelete(file, "presets")).toEqual({ templates: [], luts: ["lib:film/Print/"] });
    expect(presetsAfterDelete(file, "notes")).toBeUndefined();
  });
});

describe("a LUTs folder's listing", () => {
  it("holds its LUTs, and each folder holding any as a group", () => {
    const listing = [
      {
        name: "Kodak",
        path: "luts/Kodak",
        type: "directory" as const,
        children: [
          { name: "2383.cube", path: "luts/Kodak/2383.cube", type: "file" as const },
          { name: "notes.md", path: "luts/Kodak/notes.md", type: "file" as const },
        ],
      },
      { name: "empty", path: "luts/empty", type: "directory" as const, children: [] },
      { name: "README.md", path: "luts/README.md", type: "file" as const },
      { name: "warm.CUBE", path: "luts/warm.CUBE", type: "file" as const },
    ];
    expect(readLuts(listing)).toEqual([
      {
        kind: "group",
        name: "Kodak",
        path: "luts/Kodak",
        entries: [{ kind: "lut", name: "2383.cube", path: "luts/Kodak/2383.cube" }],
      },
      { kind: "lut", name: "warm.CUBE", path: "luts/warm.CUBE" },
    ]);
  });
});

describe("the file as Pragma writes it", () => {
  it("puts each listed folder on a line of its own", () => {
    expect(serializePresetsFile({ templates: ["presets/templates/"], luts: ["presets/luts/", "lib:film/"] })).toBe(
      `{
  "templates": [
    "presets/templates/"
  ],
  "luts": [
    "presets/luts/",
    "lib:film/"
  ]
}
`,
    );
  });
});
