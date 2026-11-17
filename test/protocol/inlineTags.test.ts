import { describe, expect, it } from "vitest";
import { tagsInProse } from "../../src/protocol/inlineTags.ts";
import { noteLinksAndTags } from "../../src/protocol/markdownLinks.ts";

// docs/protocol.md's Tags: the rule a note's `#tags` are read by, as the
// index, reading view and the editor all read them.
const tags = (text: string) => noteLinksAndTags(text).tags.map((tag) => tag.name);

describe("a tag written in a note", () => {
  it("is `#` and a name, at the start of a line or after whitespace", () => {
    expect(tags("#draft and #Next\tthen #x")).toEqual(["draft", "Next", "x"]);
    expect(tags("one\n#two")).toEqual(["two"]);
  });

  it("is not a `#` after anything else, a `#` alone, or a heading", () => {
    expect(tags("C# issue#4 a#b (#c) *#d* ## # Title #")).toEqual([]);
    expect(tags("# Heading #tag\n## Second")).toEqual(["tag"]);
  });

  it("is not written inside math", () => {
    expect(tags("$x #a$ #b\n\n$$\n#c\n$$\n")).toEqual(["b"]);
  });

  it("is not only the digits 0–9", () => {
    expect(tags("#1 #2024 #2024-10 #1a #a1 #١٢")).toEqual(["2024-10", "1a", "a1", "١٢"]);
  });

  it("ends at whitespace or punctuation, which `_`, `-` and `/` aren't", () => {
    expect(tags("#a. #b, #c! #d? #e: #f; #g) #h' #i\" #j]")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
    ]);
    expect(tags("#snake_case #kebab-case #project/alpha #trailing/ #/lead")).toEqual([
      "snake_case",
      "kebab-case",
      "project/alpha",
      "trailing/",
      "/lead",
    ]);
  });

  it("holds letters of any script, their marks and emoji, and ends at Unicode's punctuation blocks", () => {
    expect(tags("#café #日本語 #🎉party #a…b #c—d #e⸺g")).toEqual(["café", "日本語", "🎉party", "a", "c", "e"]);
  });

  it("is never in code, a link, a wikilink, a URL or HTML", () => {
    const text = [
      "`#code` [a #b](x.md) [#c](https://e.com) [[#d]] [[e #f]] ![#g](i.png)",
      "<https://e.com/#h> <span title='#i'> #j</span> <!-- #k -->",
      "```",
      "#fenced",
      "```",
      "",
      "    #indented",
      "",
      "#kept",
    ].join("\n");
    expect(tags(text)).toEqual(["j", "kept"]);
  });

  it("is never in frontmatter, and sits at its offset in the whole file", () => {
    const text = "---\ntags: [a]\n# a comment\n---\nSee #one\n";
    const [tag] = noteLinksAndTags(text).tags;
    expect(noteLinksAndTags(text).tags).toHaveLength(1);
    expect(text.slice(tag.from, tag.to)).toBe("#one");
  });

  it("reads a run of prose by the character ahead of it", () => {
    expect(tagsInProse("#a #b", 10, " ").map((tag) => [tag.name, tag.from, tag.to])).toEqual([
      ["a", 10, 12],
      ["b", 13, 15],
    ]);
    expect(tagsInProse("#a #b", 10, "x").map((tag) => tag.name)).toEqual(["b"]);
    expect(tagsInProse("#a", 0, "").map((tag) => tag.name)).toEqual(["a"]);
  });
});

describe("a note's links and tags", () => {
  it("come from one reading, as the links alone read", () => {
    const text = "See [[plan]] #todo and [x](notes/x.md).";
    const read = noteLinksAndTags(text);
    expect(read.links.map((link) => link.raw)).toEqual(["plan", "notes/x.md"]);
    expect(read.tags.map((tag) => tag.name)).toEqual(["todo"]);
  });
});
