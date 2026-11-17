import { describe, expect, it } from "vitest";
import {
  illegalTagNameReason,
  isTagName,
  isTagOrNested,
  sameTag,
  serializeTagsFile,
  tagDefinition,
  tagDefinitions,
  tagNameOf,
  tagsOf,
  unmarkedTagName,
  withTagChange,
} from "../../src/protocol/tags.ts";

// docs/protocol.md's Tags: one name rule wherever a tag is written, so every
// tag a file holds is one a note could write as `#name`.
describe("a tag's name", () => {
  it("holds no whitespace and no punctuation but _ - and /, and isn't only digits", () => {
    for (const name of ["draft", "project/alpha", "to-do", "snake_case", "y2k", "2024a", "café", "日本語"]) {
      expect(isTagName(name), name).toBe(true);
    }
    for (const name of ["", "two words", "tab\there", "c++", "q&a", "a.b", "#draft", "2024", "a—b", "a⸺b"]) {
      expect(isTagName(name), name).toBe(false);
    }
  });

  it("is read from a value trimmed, with one leading # dropped", () => {
    expect(tagNameOf(" #Draft ")).toBe("Draft");
    expect(tagNameOf("draft")).toBe("draft");
    expect(tagNameOf("##draft")).toBeUndefined();
    expect(tagNameOf("#")).toBeUndefined();
    expect(tagNameOf("two words")).toBeUndefined();
    expect(unmarkedTagName(" #two words ")).toBe("two words");
  });

  it("says why a typed value names no tag", () => {
    expect(illegalTagNameReason("#draft")).toBeNull();
    expect(illegalTagNameReason(" ")).toBe("A tag needs a name");
    expect(illegalTagNameReason("#")).toBe("A tag needs a name");
    expect(illegalTagNameReason("2024")).toBe("A tag can't be only digits");
    expect(illegalTagNameReason("two words")).toBe("A tag can't contain spaces, or punctuation other than _ - and /");
  });
});

// docs/protocol.md's Tags → Declared tags: what one entry of `_tags.json`
// says, as the Tags section, the suggestions and the pills all read it.
describe("tagDefinitions", () => {
  it("reads name and color, trimmed, and nothing from a key it doesn't know", () => {
    expect(
      tagDefinitions({
        tags: [{ name: " lyrics ", color: "#dfab01", toolkit: "/tools/lyrics.flow.html" }, { name: "draft" }],
      }),
    ).toEqual([
      { name: "lyrics", color: "#dfab01" },
      { name: "draft", color: "" },
    ]);
  });

  it("skips an entry with no name, and keeps file order", () => {
    const names = tagDefinitions({
      tags: [{ name: "zeta" }, { name: "  ", color: "#ffffff" }, { color: "#000000" }, "alpha", { name: "alpha" }],
    }).map((tag) => tag.name);
    expect(names).toEqual(["zeta", "alpha"]);
  });

  it("reads a value of the wrong type as none", () => {
    expect(tagDefinitions({ tags: [{ name: "x", color: 3 }] })).toEqual([{ name: "x", color: "" }]);
  });

  it("reads a name as any tag value is: its # dropped, and one naming no tag declares nothing", () => {
    expect(
      tagDefinitions({ tags: [{ name: "#draft" }, { name: "two words", color: "#000000" }, { name: "2024" }] }),
    ).toEqual([{ name: "draft", color: "" }]);
  });

  it("declares nothing for a missing file or one with no list", () => {
    expect(tagDefinitions(undefined)).toEqual([]);
    expect(tagDefinitions({})).toEqual([]);
    expect(tagDefinitions({ tags: "lyrics" })).toEqual([]);
  });
});

describe("withTagChange", () => {
  const file = {
    $comment: "kept",
    tags: [
      { name: "lyrics", color: "#dfab01", toolkit: "/tools/lyrics.flow.html", note: "kept too" },
      { name: "draft" },
      { name: "lyrics", color: "#000000" },
    ],
  };

  it("declares a tag as a new last entry", () => {
    expect(withTagChange(undefined, { name: "art" })).toEqual({ tags: [{ name: "art" }] });
    expect((withTagChange(file, { name: "art", color: "#e03e3e" }).tags as unknown[]).at(-1)).toEqual({
      name: "art",
      color: "#e03e3e",
    });
  });

  it("changes the first entry naming the tag, keeping every key it doesn't touch", () => {
    const next = withTagChange(file, { name: "lyrics", color: "#e03e3e" });
    expect(next).toEqual({
      $comment: "kept",
      tags: [
        { name: "lyrics", color: "#e03e3e", toolkit: "/tools/lyrics.flow.html", note: "kept too" },
        { name: "draft" },
        { name: "lyrics", color: "#000000" },
      ],
    });
    // The file it was given is left as it was.
    expect(file.tags[0].color).toBe("#dfab01");
  });

  it("takes the color off the entry when it's set to nothing", () => {
    const next = withTagChange(file, { name: "lyrics", color: "" });
    expect((next.tags as unknown[])[0]).toEqual({
      name: "lyrics",
      toolkit: "/tools/lyrics.flow.html",
      note: "kept too",
    });
  });

  it("removes only the first entry naming the tag, and nothing for a tag with none", () => {
    expect((withTagChange(file, { name: "lyrics", remove: true }).tags as unknown[]).length).toBe(2);
    expect(withTagChange(file, { name: "nope", remove: true })).toEqual(file);
  });

  it("declaring a tag already declared leaves its entry as it was", () => {
    expect(withTagChange(file, { name: "draft" })).toEqual(file);
  });

  it("names an entry's tag in any case", () => {
    expect(withTagChange(file, { name: "Draft" })).toEqual(file);
    expect((withTagChange(file, { name: "LYRICS", remove: true }).tags as unknown[]).length).toBe(2);
  });

  it("finds an entry by the tag its name declares, and keeps one declaring none", () => {
    const written = { tags: [{ name: "two words" }, { name: "#draft" }] };
    expect(withTagChange(written, { name: "draft", color: "#e03e3e" })).toEqual({
      tags: [{ name: "two words" }, { name: "#draft", color: "#e03e3e" }],
    });
    expect(withTagChange(written, { name: "Draft", remove: true })).toEqual({ tags: [{ name: "two words" }] });
  });
});

// docs/protocol.md's Tags: one tag, whatever case it is written in.
describe("comparing tags", () => {
  it("ignores case and Unicode form, as entry names do", () => {
    expect(sameTag("Draft", "draft")).toBe(true);
    expect(sameTag("caf\u00e9", "CAFE\u0301")).toBe(true);
    expect(sameTag("draft", "drafts")).toBe(false);
  });

  it("finds a tag nested under another, but not one that only starts like it", () => {
    expect(isTagOrNested("Project/Alpha", "project")).toBe(true);
    expect(isTagOrNested("project", "project")).toBe(true);
    expect(isTagOrNested("projects", "project")).toBe(false);
    expect(isTagOrNested("project", "project/alpha")).toBe(false);
  });

  it("finds a tag's entry in any case, the first of two", () => {
    const tags = tagDefinitions({
      tags: [
        { name: "Draft", color: "#e03e3e" },
        { name: "draft", color: "#000000" },
      ],
    });
    expect(tagDefinition(tags, "DRAFT")?.color).toBe("#e03e3e");
    expect(tagDefinition(tags, "art")).toBeUndefined();
  });

  it("reads a tags property as the tags its text items name, or a lone value's", () => {
    expect(tagsOf(["a", " b ", "", 3, null, { c: 1 }, "#c", "two words", "2024", "##d"])).toEqual(["a", "b", "c"]);
    expect(tagsOf("poetry")).toEqual(["poetry"]);
    expect(tagsOf("#poetry")).toEqual(["poetry"]);
    expect(tagsOf("two words")).toEqual([]);
    expect(tagsOf(undefined)).toEqual([]);
  });
});

describe("serializeTagsFile", () => {
  it("writes one line per tag, and any other key as JSON", () => {
    expect(
      serializeTagsFile({
        tags: [{ name: "lyrics", color: "#dfab01", toolkit: "/tools/lyrics.flow.html" }, { name: 'say "hi"' }],
        extra: { nested: [1, 2] },
      }),
    ).toBe(
      [
        "{",
        '  "tags": [',
        '    { "name": "lyrics", "color": "#dfab01", "toolkit": "/tools/lyrics.flow.html" },',
        '    { "name": "say \\"hi\\"" }',
        "  ],",
        '  "extra": {',
        '    "nested": [',
        "      1,",
        "      2",
        "    ]",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("writes what reads back as the same file", () => {
    const file = { tags: [{ name: "a", color: "#000000", extra: { deep: ["x"] } }, "stray"], other: null };
    expect(JSON.parse(serializeTagsFile(file))).toEqual(file);
    expect(serializeTagsFile({ tags: [] })).toBe('{\n  "tags": []\n}\n');
  });
});
