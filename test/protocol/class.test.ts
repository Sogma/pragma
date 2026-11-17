import { describe, expect, it } from "vitest";
import {
  CLASS_FIELD_TYPE_OPTIONS,
  type ClassRow,
  canBeFieldKey,
  cellValue,
  classFolders,
  classLinkUse,
  classViews,
  fieldAsRead,
  folderInScope,
  folderNamed,
  folderRule,
  folderValueOf,
  frontmatterValue,
  groupRows,
  holdsTags,
  isRowEntry,
  isThisFolder,
  matchesRules,
  newNoteProperties,
  noteFolderOf,
  readsFolder,
  rowKindOf,
  rowValue,
  suggestedFields,
  viewFields,
  viewRows,
} from "../../src/protocol/class.ts";
import type { ClassView, TableColumn } from "../../src/protocol/types.ts";

// A Class's place, its own folder its scope's unless named.
const placed = (scope: string, folder = scope) => ({ scope, folder });

const row = (name: string, properties: Record<string, unknown>, kind: ClassRow["kind"] = "note"): ClassRow => ({
  path: `shots/${name}`,
  name,
  title: name.replace(/\.md$/, ""),
  kind,
  size: 0,
  modified: "2026-10-12T09:30:00Z",
  folder: ".",
  properties,
});

describe("classLinkUse", () => {
  it("gives a Flow's buttons, starts New note from a Markdown template, and lists anything else", () => {
    expect(classLinkUse("tools/lyrics.flow.html")).toBe("toolkit");
    expect(classLinkUse("_templates/song.md")).toBe("template");
    expect(classLinkUse("_templates/Screenplay.fountain")).toBe("reference");
    expect(classLinkUse("songs/voice.md")).toBe("reference");
    expect(classLinkUse("lib:refs/_templates/song.md")).toBe("reference");
  });
});

describe("readsFolder", () => {
  it("reads a source's own folder, and those below only with its subfolders, names in any case", () => {
    expect(readsFolder({ folder: "songs", subfolders: false }, "songs")).toBe(true);
    expect(readsFolder({ folder: "songs", subfolders: false }, "songs/chico")).toBe(false);
    expect(readsFolder({ folder: "songs", subfolders: true }, "Songs/chico/lyrics")).toBe(true);
    expect(readsFolder({ folder: "songs", subfolders: true }, "songbook")).toBe(false);
    expect(readsFolder({ folder: "", subfolders: true }, "anything/below")).toBe(true);
    expect(readsFolder({ folder: "", subfolders: true }, "lib:refs/notes")).toBe(false);
  });
});

describe("classFolders", () => {
  const folders = (test: string, ...values: string[]) => [{ property: "file.folder", test, values }];

  it("reads the whole root when the filter names no folder", () => {
    expect(classFolders(placed("p"), [])).toEqual([{ folder: "", subfolders: true }]);
    expect(classFolders(placed("lib:refs"), [{ property: "status", test: "is", values: ["draft"] }])).toEqual([
      { folder: "lib:refs", subfolders: true },
    ]);
  });

  it("reads each folder the first Folder rule names from the scope, once each", () => {
    const named = classFolders(placed("p/x"), folders("is", ".", "shots/", "/archive", "./shots"));
    expect(named.map((each) => each.folder)).toEqual(["p/x", "p/x/shots", "archive"]);
    expect(classFolders(placed("p/x"), [...folders("is", "shots"), ...folders("within", "world")])).toEqual([
      { folder: "p/x/shots", subfolders: false },
    ]);
  });

  it("reads below a folder for within, and below a pattern's fixed part", () => {
    expect(classFolders(placed("p"), folders("within", "songs"))).toEqual([{ folder: "p/songs", subfolders: true }]);
    expect(classFolders(placed("p"), folders("is", "songs/*/lyrics"))).toEqual([
      { folder: "p/songs", subfolders: true },
    ]);
    expect(classFolders(placed(""), folders("is", "*/lyrics"))).toEqual([{ folder: "", subfolders: true }]);
  });

  it("reads the root however its value is spelled", () => {
    for (const root of ["/", "//", "/."]) expect(classFolders(placed("p/x"), folders("is", root))[0].folder).toBe("");
  });

  it("reads the Class's own folder for this.file.folder, wherever its scope is", () => {
    const at = placed("p", "p/x/shots");
    expect(classFolders(at, folders("is", "this.file.folder"))).toEqual([{ folder: "p/x/shots", subfolders: false }]);
    expect(classFolders(at, folders("within", " this.file.folder "))).toEqual([
      { folder: "p/x/shots", subfolders: true },
    ]);
    expect(classFolders(at, folders("is", "this.file.folder", "x/shots"))).toHaveLength(1);
    expect(classFolders(placed("lib:refs", "lib:refs/b"), folders("is", "this.file.folder"))[0].folder).toBe(
      "lib:refs/b",
    );
  });

  it("reads a folder named this.file.folder behind ./", () => {
    expect(classFolders(placed("p", "p/x"), folders("is", "./this.file.folder"))[0].folder).toBe("p/this.file.folder");
  });
});

describe("this.file.folder", () => {
  it("is that value alone, spaces aside", () => {
    expect(isThisFolder(" this.file.folder ")).toBe(true);
    expect(isThisFolder("This.File.Folder")).toBe(false);
    expect(isThisFolder("./this.file.folder")).toBe(false);
    expect(isThisFolder("this.file.folder/notes")).toBe(false);
  });

  it("is never written for a folder of that name", () => {
    expect(folderValueOf("p", "p/this.file.folder")).toBe("./this.file.folder");
    expect(folderValueOf("p", "p/x")).toBe("x");
    expect(folderValueOf("p", "p")).toBe(".");
    expect(folderValueOf("p", "q/this.file.folder")).toBe("/q/this.file.folder");
  });
});

describe("a Class's Folder rule", () => {
  it("is the first rule of its filter that is or is within folders", () => {
    const filter = [
      { property: "file.folder", test: "contains", values: ["lyrics"] },
      { property: "file.folder", test: "within", values: ["songs"] },
      { property: "file.folder", test: "is", values: ["demos"] },
    ];
    expect(folderRule(filter)).toBe(filter[1]);
    expect(folderRule([{ property: "tags", test: "is", values: ["x"] }])).toBeUndefined();
  });

  it("names a folder from the scope, and from the root with a leading /", () => {
    expect(folderNamed("music", ".")).toEqual({ folder: "music", pattern: false });
    expect(folderNamed("music", "album-1/lyrics/")).toEqual({ folder: "music/album-1/lyrics", pattern: false });
    expect(folderNamed("music", "/notes")).toEqual({ folder: "notes", pattern: false });
    expect(folderNamed("lib:footage", "b")).toEqual({ folder: "lib:footage/b", pattern: false });
    expect(folderNamed("music", "*/lyrics")).toEqual({ folder: "music", pattern: true });
  });

  // A new note lands where the Class reads, never below it.
  it("puts a new note in the first folder it names, else the Class's own folder", () => {
    const rule = (test: string, ...values: string[]) => [{ property: "file.folder", test, values }];
    const at = placed("p", "p/x");
    expect(noteFolderOf(at, rule("within", "x/shots", "x"))).toBe("p/x/shots");
    expect(noteFolderOf(at, rule("is", "*/lyrics"))).toBe("p");
    expect(noteFolderOf(at, rule("is", "this.file.folder", "/archive"))).toBe("p/x");
    expect(noteFolderOf(at, [])).toBe("p/x");
  });
});

describe("viewFields", () => {
  const fields: TableColumn[] = [
    { id: "scene", type: "integer", label: "Scene" },
    { id: "status", type: "select", label: "Status", options: ["draft"] },
    { id: "frame", type: "media", label: "Frame" },
  ];

  it("shows every field, in the Class's order, for a view that lists none", () => {
    expect(viewFields(fields, {}).map((field) => field.id)).toEqual(["scene", "status", "frame"]);
  });

  it("shows a view's own list in its order, once each, skipping a key no field has", () => {
    expect(viewFields(fields, { fields: ["frame", "gone", "scene", "frame"] }).map((field) => field.id)).toEqual([
      "frame",
      "scene",
    ]);
    expect(viewFields(fields, { fields: [] })).toEqual([]);
  });
});

describe("isRowEntry", () => {
  it("takes notes and folders holding an index.md, never the folder's own index.md or README.md", () => {
    expect(isRowEntry("shot-1.md", "file", false)).toBe(true);
    expect(isRowEntry("scene-1", "directory", true)).toBe(true);
    expect(isRowEntry("frames", "directory", false)).toBe(false);
    expect(isRowEntry("index.md", "file", false)).toBe(false);
    expect(isRowEntry("README.md", "file", false)).toBe(false);
  });

  it("takes screenplays and media, and never a Table, Flow, Applet or Class", () => {
    expect(["draft.fountain", "cover.png", "take.mp4", "board.pdf"].map(rowKindOf)).toEqual([
      "screenplay",
      "image",
      "video",
      "pdf",
    ]);
    for (const name of ["cast.table.html", "polish.flow.html", "dials.applet.html", "shots.class.html", "a.txt"]) {
      expect(isRowEntry(name, "file", false)).toBe(false);
    }
  });

  it("reads each of those names in any case", () => {
    expect(isRowEntry("Shot-2.MD", "file", false)).toBe(true);
    expect(isRowEntry("Index.md", "file", false)).toBe(false);
    expect(isRowEntry("readme.md", "file", false)).toBe(false);
  });
});

describe("matchesRules", () => {
  it("has: one of the values in a list, or as a lone value", () => {
    const rule = [{ property: "tags", test: "has", values: ["shot", "still"] }];
    expect(matchesRules(row("a.md", { tags: ["night", "shot"] }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { tags: "still" }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { tags: ["night"] }), rule)).toBe(false);
    expect(matchesRules(row("a.md", {}), rule)).toBe(false);
  });

  it("has and is on tags: a tag in any case, and has counts the tags a note writes in its text", () => {
    const has = [{ property: "tags", test: "has", values: ["Shot"] }];
    expect(matchesRules(row("a.md", { tags: ["shot"] }), has)).toBe(true);
    expect(matchesRules({ ...row("a.md", {}), inlineTags: ["SHOT"] }, has)).toBe(true);
    expect(matchesRules({ ...row("a.md", { tags: ["night"] }), inlineTags: ["still"] }, has)).toBe(false);
    const is = [{ property: "tags", test: "is", values: ["Shot"] }];
    expect(matchesRules(row("a.md", { tags: "shot" }), is)).toBe(true);
    expect(matchesRules({ ...row("a.md", {}), inlineTags: ["shot"] }, is)).toBe(false);
    // Any other property matches as spelled.
    expect(matchesRules(row("a.md", { genre: ["shot"] }), [{ property: "genre", test: "has", values: ["Shot"] }])).toBe(
      false,
    );
  });

  it("has on tags: a tag nested under one of the values, as Search finds it", () => {
    const has = [{ property: "tags", test: "has", values: ["project"] }];
    expect(matchesRules(row("a.md", { tags: ["Project/Alpha"] }), has)).toBe(true);
    expect(matchesRules({ ...row("a.md", {}), inlineTags: ["project/beta"] }, has)).toBe(true);
    expect(matchesRules(row("a.md", { tags: ["projects"] }), has)).toBe(false);
    const nested = [{ property: "tags", test: "has", values: ["project/alpha"] }];
    expect(matchesRules(row("a.md", { tags: ["project"] }), nested)).toBe(false);
    const all = [{ property: "file.tags", test: "has", values: ["project"] }];
    expect(matchesRules({ ...row("a.md", {}), inlineTags: ["project/alpha"] }, all)).toBe(true);
  });

  it("tags: a test reads the tags a value names, a # dropped and a value naming none left out", () => {
    const has = [{ property: "tags", test: "has", values: ["#draft"] }];
    expect(matchesRules(row("a.md", { tags: ["#Draft"] }), has)).toBe(true);
    expect(matchesRules(row("a.md", { tags: ["draft"] }), has)).toBe(true);
    const spaced = [{ property: "tags", test: "has", values: ["two words"] }];
    expect(matchesRules(row("a.md", { tags: ["two words"] }), spaced)).toBe(false);
    const contains = [{ property: "tags", test: "contains", values: ["word"] }];
    expect(matchesRules(row("a.md", { tags: ["two words"] }), contains)).toBe(false);
    expect(matchesRules(row("a.md", { tags: ["wordplay"] }), contains)).toBe(true);
    const empty = [{ property: "tags", test: "empty", values: [] }];
    expect(matchesRules(row("a.md", { tags: ["two words", 2024] }), empty)).toBe(true);
    expect(matchesRules(row("a.md", { tags: ["two words", "draft"] }), empty)).toBe(false);
  });

  it("is: a lone value that is one of the values, compared as text", () => {
    const rule = [{ property: "status", test: "is", values: ["approved", "3"] }];
    expect(matchesRules(row("a.md", { status: "approved" }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { status: 3 }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { status: ["approved"] }), rule)).toBe(false);
    expect(matchesRules(row("a.md", { status: "draft" }), rule)).toBe(false);
  });

  it("empty and not-empty: absent, blank and an empty list are empty", () => {
    const empty = [{ property: "frame", test: "empty", values: [] }];
    for (const value of [undefined, null, "  ", []])
      expect(matchesRules(row("a.md", { frame: value }), empty)).toBe(true);
    expect(matchesRules(row("a.md", { frame: "a.png" }), empty)).toBe(false);
    expect(matchesRules(row("a.md", { frame: false }), empty)).toBe(false);
    expect(matchesRules(row("a.md", { frame: "a.png" }), [{ property: "frame", test: "not-empty", values: [] }])).toBe(
      true,
    );
  });

  it("passes a test it doesn't know, and needs every rule", () => {
    expect(matchesRules(row("a.md", {}), [{ property: "a", test: "near", values: ["x"] }])).toBe(true);
    const rules = [
      { property: "status", test: "is", values: ["approved"] },
      { property: "frame", test: "empty", values: [] },
    ];
    expect(matchesRules(row("a.md", { status: "approved" }), rules)).toBe(true);
    expect(matchesRules(row("a.md", { status: "approved", frame: "a.png" }), rules)).toBe(false);
  });
});

describe("viewRows", () => {
  const rows = [
    row("c.md", { scene: 2, status: "approved" }),
    row("a.md", { scene: 10, status: "draft" }),
    row("b.md", { status: "approved" }),
  ];

  it("keeps the order given with no sort, narrowed by the view's filter", () => {
    const view: ClassView = {
      name: "",
      layout: "list",
      filter: [{ property: "status", test: "is", values: ["approved"] }],
    };
    expect(viewRows(rows, view).map((each) => each.name)).toEqual(["c.md", "b.md"]);
  });

  it("sorts by a property as folder order does: values first, then none, in name order", () => {
    const view: ClassView = { name: "", layout: "list", filter: [], sort: { property: "scene", order: "desc" } };
    expect(viewRows(rows, view).map((each) => each.name)).toEqual(["a.md", "c.md", "b.md"]);
  });
});

describe("groupRows", () => {
  const status: TableColumn = { id: "status", type: "select", label: "Status", options: ["draft", "approved", "shot"] };

  it("groups a select's values in option order, then other values, then the rows with none", () => {
    const rows = [
      row("a.md", { status: "approved" }),
      row("b.md", {}),
      row("c.md", { status: "wip" }),
      row("d.md", { status: "draft" }),
      row("e.md", { status: "approved" }),
    ];
    expect(
      groupRows(rows, "status", status).map((group) => [group.value, group.rows.map((each) => each.name)]),
    ).toEqual([
      ["draft", ["d.md"]],
      ["approved", ["a.md", "e.md"]],
      ["wip", ["c.md"]],
      ["", ["b.md"]],
    ]);
  });
});

describe("classViews", () => {
  it("shows every row as a list when the Class names no view", () => {
    expect(classViews({ views: [] })).toEqual([{ name: "", layout: "list", filter: [] }]);
  });
});

describe("cellValue", () => {
  const field = (type: TableColumn["type"], options?: string[]): TableColumn => ({
    id: "x",
    type,
    label: "X",
    options,
  });

  it("reads a value of the field's type as fitting", () => {
    expect(cellValue(field("checkbox"), true)).toEqual({ text: "true", fits: true });
    expect(cellValue(field("integer"), 5)).toEqual({ text: "5", fits: true });
    expect(cellValue(field("select", ["draft"]), "draft")).toEqual({ text: "draft", fits: true });
    expect(cellValue(field("color"), "#ff0000")).toEqual({ text: "#ff0000", fits: true });
    expect(cellValue(field("timestamp"), "2026-10-07T12:32:05Z")).toEqual({ text: "2026-10-07T12:32:05Z", fits: true });
    expect(cellValue(field("text"), undefined)).toEqual({ text: "", fits: true });
    expect(cellValue(field("path"), "../refs/")).toEqual({ text: "../refs/", fits: true });
  });

  // A move rewrites no note's frontmatter, so a path kept there would break.
  it("offers every field type but path", () => {
    expect(CLASS_FIELD_TYPE_OPTIONS.map((option) => option.value)).not.toContain("path");
    expect(CLASS_FIELD_TYPE_OPTIONS.map((option) => option.value)).toContain("media");
  });

  it("reads one that doesn't fit as the text it is, and a list as its items", () => {
    expect(cellValue(field("checkbox"), "yes")).toEqual({ text: "yes", fits: false });
    expect(cellValue(field("select", ["draft"]), "wip")).toEqual({ text: "wip", fits: false });
    expect(cellValue(field("integer"), 2.5)).toEqual({ text: "2.5", fits: false });
    expect(cellValue(field("text"), ["a", "b"])).toEqual({ text: "a, b", fits: false, items: ["a", "b"] });
    expect(cellValue(field("text"), { a: 1 })).toEqual({ text: '{"a":1}', fits: false });
  });
});

describe("frontmatterValue", () => {
  const field = (type: TableColumn["type"]): TableColumn => ({ id: "x", type, label: "X" });

  it("stores each type as natural YAML, and blank text as no key", () => {
    expect(frontmatterValue(field("checkbox"), "true")).toBe(true);
    expect(frontmatterValue(field("checkbox"), "false")).toBe(false);
    expect(frontmatterValue(field("integer"), " 12 ")).toBe(12);
    expect(frontmatterValue(field("integer"), "1.5")).toBe("1.5");
    expect(frontmatterValue(field("color"), "#ABC")).toBe("#aabbcc");
    expect(frontmatterValue(field("timestamp"), "2026-10-12T10:00:00Z")).toBe("2026-10-12T10:00:00Z");
    expect(frontmatterValue(field("text"), " A prompt ")).toBe("A prompt");
    expect(frontmatterValue(field("select"), "")).toBeUndefined();
    expect(frontmatterValue(field("media"), "  ")).toBeUndefined();
  });
});

describe("newNoteProperties", () => {
  const fields: TableColumn[] = [
    { id: "status", type: "select", label: "Status", options: ["draft", "approved"] },
    { id: "scene", type: "integer", label: "Scene" },
    { id: "added", type: "timestamp", label: "Added", default: "now" },
    { id: "prompt", type: "text", label: "Prompt" },
  ];
  const now = new Date("2026-10-12T10:00:00Z");

  it("keeps what a template's frontmatter holds, but for what keeps the note in view", () => {
    const held = { status: "approved", scene: 4, tags: ["night"], mood: "calm" };
    const view = { filter: [{ property: "tags", test: "has", values: ["shot"] }], groupBy: "status" };
    expect(newNoteProperties({ fields, filter: [] }, view, "draft", now, held)).toEqual({
      status: "draft",
      scene: 4,
      added: "2026-10-12T10:00:00Z",
      tags: ["night", "shot"],
      mood: "calm",
    });
  });

  it("starts from each field's starting value, leaving the blank ones out", () => {
    expect(newNoteProperties({ fields, filter: [] }, { filter: [] }, undefined, now)).toEqual({
      status: "draft",
      added: "2026-10-12T10:00:00Z",
    });
  });

  it("takes what keeps it in view: a has rule's value, an is rule's only one, typed by its field", () => {
    const file = { fields, filter: [{ property: "tags", test: "has", values: ["shot", "still"] }] };
    const view = {
      filter: [
        { property: "scene", test: "is", values: ["3"] },
        { property: "status", test: "is", values: ["draft", "approved"] },
        { property: "frame", test: "empty", values: [] },
      ],
    };
    expect(newNoteProperties(file, view, undefined, now)).toEqual({
      status: "draft",
      scene: 3,
      added: "2026-10-12T10:00:00Z",
      tags: ["shot"],
    });
  });

  it("takes the group it was added under, and none for the group with none", () => {
    const view = { filter: [], groupBy: "status" };
    expect(newNoteProperties({ fields, filter: [] }, view, "approved", now).status).toBe("approved");
    expect(newNoteProperties({ fields, filter: [] }, view, "", now)).not.toHaveProperty("status");
  });
});

describe("suggestedFields", () => {
  it("takes every key the notes use, the most used first, each typed by all its values", () => {
    const rows = [
      row("a.md", { status: "draft", take: 2, done: true, shot: "2026-10-12T09:30:00Z", tags: ["night"] }),
      row("b.md", { status: "wip", take: 3, done: false, shot: "2026-10-13 18:05+02:00" }),
      row("c.md", { status: "draft", lens: "35mm", day: "2026-10-12", take: 1 }),
    ];
    expect(suggestedFields(rows)).toEqual([
      { id: "status", type: "text", label: "Status" },
      { id: "take", type: "integer", label: "Take" },
      { id: "done", type: "checkbox", label: "Done" },
      { id: "shot", type: "timestamp", label: "Shot" },
      { id: "day", type: "text", label: "Day" },
      { id: "lens", type: "text", label: "Lens" },
      { id: "tags", type: "text", label: "Tags" },
    ]);
  });

  it("makes a mix of kinds text, and passes over blanks in deciding", () => {
    const rows = [row("a.md", { take: 2, fps: 24 }), row("b.md", { take: "two", fps: null }), row("c.md", { fps: "" })];
    expect(suggestedFields(rows)).toEqual([
      { id: "fps", type: "integer", label: "Fps" },
      { id: "take", type: "text", label: "Take" },
    ]);
  });

  it("reads a note's frontmatter, and no screenplay's title page", () => {
    const rows = [
      row("look.md", { status: "approved", take: 3 }),
      row("draft.fountain", { title: "Brick", "draft date": "1/1/26" }, "screenplay"),
      row("frame.png", {}, "image"),
    ];
    expect(suggestedFields(rows).map((field) => [field.id, field.type])).toEqual([
      ["status", "text"],
      ["take", "integer"],
    ]);
  });

  it("leaves out a key no field can take", () => {
    const rows = [row("a.md", { "lens, mm": 35, "file.ext": "md", status: "draft" })];
    expect(suggestedFields(rows).map((field) => field.id)).toEqual(["status"]);
    expect(canBeFieldKey("status")).toBe(true);
    expect(canBeFieldKey("")).toBe(false);
  });
});

describe("a row's own facts", () => {
  it("reads a file field from the file, whatever its values say", () => {
    const note = { ...row("Wide.md", { "file.size": 3, kind: "mine" }), size: 120 };
    expect(rowValue(note, "file.name")).toBe("Wide");
    expect(rowValue(note, "file.size")).toBe(120);
    expect(rowValue(note, "file.modified")).toBe("2026-10-12T09:30:00Z");
    expect(rowValue(note, "file.other")).toBeUndefined();
    expect(rowValue(note, "kind")).toBe("mine");
    expect(rowValue(row("draft.fountain", {}, "screenplay"), "file.name")).toBe("draft");
    // A folder's row is its index.md, named for the folder.
    expect(rowValue({ ...row("scene-1", {}), path: "shots/scene-1/index.md" }, "file.name")).toBe("scene-1");
  });

  it("reads an extension in lower case, a folder row's from its index.md", () => {
    expect(rowValue(row("Wide.md", { "file.ext": "png" }), "file.ext")).toBe("md");
    expect(rowValue(row("Draft.FOUNTAIN", {}, "screenplay"), "file.ext")).toBe("fountain");
    expect(rowValue(row("take.v2.mov", {}, "video"), "file.ext")).toBe("mov");
    expect(rowValue({ ...row("scene-1", {}), path: "shots/scene-1/index.md" }, "file.ext")).toBe("md");
  });

  it("filters by extension in any case, its dot written or not", () => {
    const draft = row("Draft.FOUNTAIN", {}, "screenplay");
    for (const value of ["fountain", ".fountain", "Fountain", ".FOUNTAIN"]) {
      expect(matchesRules(draft, [{ property: "file.ext", test: "is", values: [value] }])).toBe(true);
    }
    expect(matchesRules(draft, [{ property: "file.ext", test: "has", values: ["md", "fountain"] }])).toBe(true);
    expect(matchesRules(row("a.md", {}), [{ property: "file.ext", test: "is", values: ["fountain"] }])).toBe(false);
  });

  it("reads a screenplay's title page keys in any case", () => {
    const draft = row("draft.fountain", { "draft date": "1/1/26", title: "Brick" }, "screenplay");
    expect(rowValue(draft, "Draft date")).toBe("1/1/26");
    expect(matchesRules(draft, [{ property: "Title", test: "is", values: ["Brick"] }])).toBe(true);
  });

  it("types a file's fact as itself, keeping only the Class's label", () => {
    expect(fieldAsRead({ id: "file.size", type: "text", label: "Bytes" })).toEqual({
      id: "file.size",
      type: "integer",
      label: "Bytes",
    });
    const status: TableColumn = { id: "status", type: "text", label: "Status" };
    expect(fieldAsRead(status)).toBe(status);
  });

  it("groups by extension in natural order, and sorts by size", () => {
    const rows = [row("b.png", {}, "image"), row("a.md", {}), row("c.fountain", {}, "screenplay")];
    expect(groupRows(rows, "file.ext").map((group) => group.value)).toEqual(["fountain", "md", "png"]);
    const sized = rows.map((each, index) => ({ ...each, size: [30, 10, 20][index] }));
    const view: ClassView = { name: "", layout: "list", filter: [], sort: { property: "file.size", order: "asc" } };
    expect(viewRows(sized, view).map((each) => each.name)).toEqual(["a.md", "c.fountain", "b.png"]);
  });

  it("filters by contains: inside a value's text or a list's item, in any case", () => {
    const rule = [{ property: "logline", test: "contains", values: ["DOOR", "key"] }];
    expect(matchesRules(row("a.md", { logline: "A locked door" }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { logline: ["no", "Keys here"] }), rule)).toBe(true);
    expect(matchesRules(row("a.md", { logline: "A window" }), rule)).toBe(false);
  });

  it("gives a new note none of a file's own facts", () => {
    const fields: TableColumn[] = [{ id: "file.modified", type: "timestamp", label: "Modified", default: "now" }];
    const filter = [{ property: "file.ext", test: "is", values: ["md"] }];
    const view = { filter: [], groupBy: "file.ext" };
    expect(newNoteProperties({ fields, filter }, view, "png", new Date())).toEqual({});
  });
});

describe("a row's tags", () => {
  it("lists its frontmatter's tags, then its text's, each once in any case, as first spelled", () => {
    const note = { ...row("a.md", { tags: ["Night", "shot"] }), inlineTags: ["night", "rain"] };
    expect(rowValue(note, "file.tags")).toEqual(["Night", "shot", "rain"]);
    expect(rowValue(row("a.md", { tags: "still" }), "file.tags")).toEqual(["still"]);
    expect(rowValue(row("a.md", {}), "file.tags")).toEqual([]);
    // A screenplay with no `tags` on its title page, or a media file, has none.
    expect(rowValue(row("one.fountain", {}, "screenplay"), "file.tags")).toEqual([]);
    expect(rowValue(row("wide.png", {}, "image"), "file.tags")).toEqual([]);
  });

  it("filters by any of them, in any case, and is never a lone value", () => {
    const has = [{ property: "file.tags", test: "has", values: ["Screenplay"] }];
    expect(matchesRules(row("a.md", { tags: ["SCREENPLAY"] }), has)).toBe(true);
    expect(matchesRules({ ...row("a.md", {}), inlineTags: ["screenplay"] }, has)).toBe(true);
    expect(matchesRules(row("a.md", { tags: ["draft"] }), has)).toBe(false);
    expect(matchesRules(row("one.fountain", {}, "screenplay"), has)).toBe(false);
    expect(
      matchesRules(row("a.md", { tags: "screenplay" }), [
        { property: "file.tags", test: "is", values: ["screenplay"] },
      ]),
    ).toBe(false);
    expect(holdsTags("file.tags")).toBe(true);
    expect(holdsTags("tags")).toBe(true);
    expect(holdsTags("Tags")).toBe(false);
  });

  it("is a file's fact, typed as text and shown as its items", () => {
    expect(fieldAsRead({ id: "file.tags", type: "integer", label: "Carried" })).toEqual({
      id: "file.tags",
      type: "text",
      label: "Carried",
    });
    const field = fieldAsRead({ id: "file.tags", type: "text", label: "All tags" });
    expect(
      cellValue(field, rowValue({ ...row("a.md", { tags: ["a"] }), inlineTags: ["b"] }, "file.tags")).items,
    ).toEqual(["a", "b"]);
  });

  it("gives a new note the tag a has on it names, as one of its own", () => {
    const filter = [{ property: "file.tags", test: "has", values: ["rewrite"] }];
    expect(newNoteProperties({ fields: [], filter }, { filter: [] }, undefined, new Date())).toEqual({
      tags: ["rewrite"],
    });
    expect(
      newNoteProperties({ fields: [], filter }, { filter: [] }, undefined, new Date(), { tags: ["draft"] }),
    ).toEqual({ tags: ["draft", "rewrite"] });
    const empty = [{ property: "file.tags", test: "empty", values: [] }];
    expect(newNoteProperties({ fields: [], filter: empty }, { filter: [] }, undefined, new Date())).toEqual({});
  });

  it("gives a new note a has rule's tag by its name, and nothing it carries already", () => {
    const now = new Date();
    const marked = [{ property: "tags", test: "has", values: ["#rewrite"] }];
    expect(newNoteProperties({ fields: [], filter: marked }, { filter: [] }, undefined, now)).toEqual({
      tags: ["rewrite"],
    });
    const project = [{ property: "tags", test: "has", values: ["project"] }];
    expect(
      newNoteProperties({ fields: [], filter: project }, { filter: [] }, undefined, now, { tags: ["Project/Alpha"] }),
    ).toEqual({ tags: ["Project/Alpha"] });
    const spaced = [{ property: "tags", test: "has", values: ["two words"] }];
    expect(newNoteProperties({ fields: [], filter: spaced }, { filter: [] }, undefined, now)).toEqual({});
  });
});

describe("a row's folder", () => {
  it("writes a folder from the Class's scope: down from its folder, and from the root outside it", () => {
    expect(folderInScope("music", "music")).toBe(".");
    expect(folderInScope("music", "music/album-1/lyrics")).toBe("album-1/lyrics");
    expect(folderInScope("music", "notes/x")).toBe("/notes/x");
    expect(folderInScope("music", "musical/x")).toBe("/musical/x");
    expect(folderInScope("", "music/a")).toBe("music/a");
    expect(folderInScope("Music", "music/Lyrics")).toBe("Lyrics");
    expect(folderInScope("lib:footage", "lib:footage/b")).toBe("b");
  });

  it("filters Folder by a path where * stands for any one folder name, in any case", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const is = (pattern: string) => [{ property: "file.folder", test: "is", values: [pattern] }];
    expect(rowValue(at("album-1/lyrics"), "file.folder")).toBe("album-1/lyrics");
    expect(matchesRules(at("album-1/lyrics"), is("*/lyrics"))).toBe(true);
    expect(matchesRules(at("album-1/old/lyrics"), is("*/lyrics"))).toBe(false);
    expect(matchesRules(at("album-1/demos"), is("*/lyrics"))).toBe(false);
    expect(matchesRules(at("album-2/Lyrics"), is("*/lyrics/"))).toBe(true);
    expect(matchesRules(at("lyrics"), is("./lyrics"))).toBe(true);
    expect(matchesRules(at("."), is("."))).toBe(true);
    expect(matchesRules(at("lyrics"), is("*"))).toBe(true);
    expect(matchesRules(at("."), is("*"))).toBe(false);
    const loose = [{ property: "file.folder", test: "contains", values: ["LYRICS"] }];
    expect(matchesRules(at("lyrics-old"), loose)).toBe(true);
  });

  it("tells a folder outside the scope by its leading /", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const is = (pattern: string) => [{ property: "file.folder", test: "is", values: [pattern] }];
    expect(matchesRules(at("/notes/lyrics"), is("/*/lyrics"))).toBe(true);
    expect(matchesRules(at("/notes/lyrics"), is("*/lyrics"))).toBe(false);
    expect(matchesRules(at("notes/lyrics"), is("/notes/lyrics"))).toBe(false);
  });

  it("filters within a folder: that folder or any below it", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const within = (...values: string[]) => [{ property: "file.folder", test: "within", values }];
    expect(matchesRules(at("songs"), within("songs"))).toBe(true);
    expect(matchesRules(at("Songs/chico/lyrics"), within("songs"))).toBe(true);
    expect(matchesRules(at("songbook"), within("songs"))).toBe(false);
    expect(matchesRules(at("."), within("songs"))).toBe(false);
    expect(matchesRules(at("songs/a/lyrics/old"), within("*/*/lyrics"))).toBe(true);
    expect(matchesRules(at("anything"), within("."))).toBe(true);
    expect(matchesRules(at("/outside"), within("."))).toBe(false);
    expect(matchesRules(at("demos"), within("songs", "demos"))).toBe(true);
    // On any other key it narrows nothing, as a test a reader doesn't know.
    expect(matchesRules(at("."), [{ property: "status", test: "within", values: ["x"] }])).toBe(true);
  });

  // With the scope known, a value compares as the folder it names, whichever
  // way it is spelled, so an ancestor of the scope holds the scope's rows.
  it("compares a folder, not its spelling, once the scope is known", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const rule = (test: string, value: string) => [{ property: "file.folder", test, values: [value] }];
    const music = placed("music");
    expect(matchesRules(at("."), rule("is", "/music"), music)).toBe(true);
    expect(matchesRules(at("lyrics"), rule("within", "/"), music)).toBe(true);
    expect(matchesRules(at("album/lyrics"), rule("within", "/music"), music)).toBe(true);
    expect(matchesRules(at("/notes"), rule("within", "/music"), music)).toBe(false);
    expect(matchesRules(at("lyrics"), rule("is", "/music"), music)).toBe(false);
    expect(matchesRules(at("album-1/lyrics"), rule("is", "*/lyrics"), music)).toBe(true);
  });

  // The rows' folders are written from the scope, the Class's from wherever
  // it sits in it.
  it("filters to the Class's own folder for this.file.folder", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const rule = (test: string) => [{ property: "file.folder", test, values: ["this.file.folder"] }];
    const lyrics = placed("music", "music/album/lyrics");
    expect(matchesRules(at("album/lyrics"), rule("is"), lyrics)).toBe(true);
    expect(matchesRules(at("Album/Lyrics"), rule("is"), lyrics)).toBe(true);
    expect(matchesRules(at("album/lyrics/old"), rule("is"), lyrics)).toBe(false);
    expect(matchesRules(at("album/lyrics/old"), rule("within"), lyrics)).toBe(true);
    expect(matchesRules(at("album"), rule("within"), lyrics)).toBe(false);
    expect(matchesRules(at("."), rule("is"), placed("music"))).toBe(true);
    expect(viewRows([at("album/lyrics"), at(".")], { name: "", layout: "list", filter: rule("is") }, lyrics)).toEqual([
      at("album/lyrics"),
    ]);
  });

  it("finds no folder for this.file.folder with no Class to be in", () => {
    const at = (folder: string) => ({ ...row("a.md", {}), folder });
    const rule = [{ property: "file.folder", test: "is", values: ["this.file.folder"] }];
    expect(matchesRules(at("this.file.folder"), rule)).toBe(false);
    expect(matchesRules(at("."), rule)).toBe(false);
  });
});
