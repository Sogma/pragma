import { describe, expect, it } from "vitest";
import {
  composeFrontmatter,
  documentBody,
  editFrontmatter,
  editFrontmatterYaml,
  frontmatterDescription,
  isPrivateDocument,
  parseFrontmatter,
  readFrontmatter,
  sameFrontmatter,
  sameKeyOrder,
  splitFrontmatter,
} from "../../src/protocol/frontmatter.ts";

// Every server-side write-back (a save's dates, a publish's `id`) edits the
// block it reads, so any drift here compounds once per write.
describe("frontmatter round trip", () => {
  it("leaves a document as it is when its block already holds the values", () => {
    const content = "---\nid: doc_1\n---\n\n\n\n# Post\n";
    expect(editFrontmatter(content, { id: "doc_1" })).toBe(content);
  });

  it("keeps the blank lines after an edited block, however often it is edited", () => {
    expect(editFrontmatter("---\nid: doc_1\n---\n\n\n\n# Post\n", { id: "doc_2" })).toBe(
      "---\nid: doc_2\n---\n\n\n\n# Post\n",
    );
    expect(editFrontmatter("---\nid: doc_1\n---\n# Post\n", { id: "doc_2" })).toBe("---\nid: doc_2\n---\n# Post\n");
    let content = "---\nid: doc_1\n---\n\n# Post\n";
    for (const id of ["doc_2", "doc_3", "doc_4"]) content = editFrontmatter(content, { id });
    expect(content).toBe("---\nid: doc_4\n---\n\n# Post\n");
  });

  it("writes a block into a document with none, one blank line below it, and drops one with no keys left", () => {
    expect(editFrontmatter("# Post\n", { id: "doc_1" })).toBe("---\nid: doc_1\n---\n\n# Post\n");
    expect(editFrontmatter("---\nid: doc_1\n---\n\n# Post\n", {})).toBe("# Post\n");
  });

  it("leaves a byte order mark out of a document it writes", () => {
    expect(editFrontmatter("\uFEFF---\nid: doc_1\n---\n# Post\n", { id: "doc_2" })).toBe(
      "---\nid: doc_2\n---\n# Post\n",
    );
    expect(editFrontmatter("\uFEFF# Post\n", { id: "doc_1" })).toBe("---\nid: doc_1\n---\n\n# Post\n");
    expect(editFrontmatter("\uFEFF---\nid: doc_1\n---\n\n# Post\n", {})).toBe("# Post\n");
  });

  it("gives back the body it was given", () => {
    expect(parseFrontmatter(composeFrontmatter("id: doc_1", "# Post\n")).body).toBe("# Post\n");
  });

  it("drops the gap of a CRLF document too", () => {
    expect(parseFrontmatter("---\r\nid: doc_1\r\n---\r\n\r\n# Post\r\n").body).toBe("# Post\r\n");
  });
});

describe("splitFrontmatter", () => {
  it("returns a body that is still a suffix of the content, and the blank lines above it", () => {
    const content = "---\nid: doc_1\n---\n\n\n# Post\n";
    const split = splitFrontmatter(content);
    expect(split?.body).toBe("# Post\n");
    expect(split?.gap).toBe("\n\n");
    expect(content.endsWith(split?.body ?? "")).toBe(true);
  });

  it("trims a CRLF block's edge line breaks whole", () => {
    expect(splitFrontmatter("---\r\na: 1\r\nb: 2\r\n---\r\n\r\nText")?.yaml).toBe("a: 1\r\nb: 2");
  });

  it("opens a block only on a first line that is exactly `---`", () => {
    for (const content of [
      "\n---\na: 1\n---\n",
      " ---\na: 1\n---\n",
      "--- \na: 1\n---\n",
      "----\na: 1\n---\n",
      "---a: 1\n---\n",
      "Text\n---\na: 1\n---\n",
    ]) {
      expect(splitFrontmatter(content)).toBeUndefined();
    }
  });

  it("closes a block on the next line that is exactly `---`", () => {
    expect(splitFrontmatter("---\na: 1\n----\n--- \n---x\nb: 2\n---\nText")?.yaml).toBe("a: 1\n----\n--- \n---x\nb: 2");
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({ yaml: "a: 1", gap: "", body: "" });
    expect(splitFrontmatter("---\n---\nText")).toEqual({ yaml: "", gap: "", body: "Text" });
    expect(splitFrontmatter("---\na: 1\n---- \nText")).toBeUndefined();
  });

  it("looks past a byte order mark", () => {
    expect(splitFrontmatter("\uFEFF---\na: 1\n---\n\nText")).toEqual({ yaml: "a: 1", gap: "\n", body: "Text" });
    expect(splitFrontmatter("\uFEFF\uFEFF---\na: 1\n---\n")).toBeUndefined();
  });
});

describe("documentBody", () => {
  it("is the text below the block, or the whole document, never its byte order mark", () => {
    expect(documentBody("\uFEFF---\na: 1\n---\n\nText")).toBe("Text");
    expect(documentBody("\uFEFFText")).toBe("Text");
    expect(documentBody("\n---\na: 1\n---\nText")).toBe("\n---\na: 1\n---\nText");
  });
});

describe("editFrontmatterYaml", () => {
  const block = [
    "# shot metadata",
    "status: draft   # wip",
    "tags: [shot, night]",
    'color: "#ff0000"',
    "notes: >",
    "  long folded",
    "  text",
    "last: 1",
  ].join("\n");
  const held = () => parseFrontmatter(`---\n${block}\n---\n`).data;

  it("rewrites a changed value where it stands, keeping its comment and every other line", () => {
    expect(editFrontmatterYaml(block, { ...held(), status: "approved" })).toBe(block.replace("draft", "approved"));
  });

  it("rewrites a value that changes shape over its own lines only", () => {
    expect(editFrontmatterYaml(block, { ...held(), tags: ["shot", "day"] })).toBe(
      block.replace("tags: [shot, night]", "tags:\n  - shot\n  - day"),
    );
    expect(editFrontmatterYaml(block, { ...held(), notes: "short" })).toBe(
      block.replace(">\n  long folded\n  text", "short"),
    );
  });

  it("removes a key's own lines, and the break before the block's last one", () => {
    const { tags: _tags, ...withoutTags } = held();
    expect(editFrontmatterYaml(block, withoutTags)).toBe(block.replace("tags: [shot, night]\n", ""));
    const { last: _last, ...withoutLast } = held();
    expect(editFrontmatterYaml(block, withoutLast)).toBe(block.replace("\nlast: 1", ""));
  });

  // A publish appends `id` and `pushed`, so taking both out cuts the last two.
  it("leaves no blank line where the pairs ending the block were cut", () => {
    const { notes: _notes, last: _last, ...withoutTheLastTwo } = held();
    expect(editFrontmatterYaml(block, withoutTheLastTwo)).toBe(block.replace(/\nnotes: >[\s\S]*$/, ""));
    expect(editFrontmatterYaml("a: 1\nb: 2\nc: 3\nd: 4", { a: 1 })).toBe("a: 1");
    expect(editFrontmatterYaml("a: 1\nb: [x]\nc: 3", { a: 1, b: ["x", "y"] })).toBe("a: 1\nb:\n  - x\n  - y");
  });

  it("appends a new key after the last pair, ahead of a closing comment or blank line", () => {
    expect(editFrontmatterYaml(block, { ...held(), frame: "frames/a.png" })).toBe(`${block}\nframe: frames/a.png`);
    expect(editFrontmatterYaml("a: 1\n# end", { a: 1, b: 2 })).toBe("a: 1\nb: 2\n# end");
    expect(editFrontmatterYaml("a: 1\n", { a: 1, b: 2 })).toBe("a: 1\nb: 2\n");
  });

  it("renames a key in place when only its name changed", () => {
    const renamed = Object.fromEntries(
      Object.entries(held()).map(([key, value]) => [key === "color" ? "colour" : key, value]),
    );
    expect(editFrontmatterYaml(block, renamed)).toBe(block.replace("color:", "colour:"));
  });

  it("fills a key written with no value", () => {
    expect(editFrontmatterYaml("draft:\nnext: 2", { draft: "done", next: 2 })).toBe("draft: done\nnext: 2");
  });

  it("writes a block for none, and drops one with no keys left", () => {
    expect(editFrontmatterYaml(undefined, { a: 1 })).toBe("a: 1");
    expect(editFrontmatterYaml("a: 1", {})).toBeUndefined();
    expect(editFrontmatterYaml(undefined, {})).toBeUndefined();
  });

  it("keeps a block holding only comments, and adds to it", () => {
    expect(editFrontmatterYaml("# a note", {})).toBe("# a note");
    expect(editFrontmatterYaml("# a note", { a: 1 })).toBe("# a note\na: 1");
  });

  it("writes the block afresh where a splice would mean something else", () => {
    // `b` aliases `a`, so `a` rewritten in place would take `b` with it.
    expect(editFrontmatterYaml("a: &x 1\nb: *x", { a: 2, b: 1 })).toBe("a: 2\nb: 1");
    expect(editFrontmatterYaml("{a: 1, b: 2}", { a: 1, b: 3 })).toBe("a: 1\nb: 3");
  });

  it("refuses a block that doesn't parse", () => {
    expect(() => editFrontmatterYaml("a: [1, 2", { a: 1 })).toThrow();
  });
});

describe("editFrontmatterYaml moving keys", () => {
  const data = (yaml: string) => parseFrontmatter(`---\n${yaml}\n---\n`).data;
  const inOrder = (yaml: string, keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, data(yaml)[key]] as const));

  it("moves a key with the comment right above it, keeping every line as written", () => {
    const yaml = "status: draft   # wip\n# the night shoot\ntags: [shot, night]\nlast: 1";
    expect(editFrontmatterYaml(yaml, inOrder(yaml, ["tags", "status", "last"]))).toBe(
      "# the night shoot\ntags: [shot, night]\nstatus: draft   # wip\nlast: 1",
    );
  });

  it("moves a block value whole", () => {
    const yaml = 'status: draft\ntags: [shot, night]\ncolor: "#ff0000"\nnotes: >\n  long folded\n  text\nlast: 1';
    expect(editFrontmatterYaml(yaml, inOrder(yaml, ["status", "notes", "tags", "color", "last"]))).toBe(
      'status: draft\nnotes: >\n  long folded\n  text\ntags: [shot, night]\ncolor: "#ff0000"\nlast: 1',
    );
  });

  it("keeps the block's last line with or without its break", () => {
    expect(editFrontmatterYaml("a: 1\nb: 2", { b: 2, a: 1 })).toBe("b: 2\na: 1");
    expect(editFrontmatterYaml("a: 1\nb: 2\n", { b: 2, a: 1 })).toBe("b: 2\na: 1\n");
    expect(editFrontmatterYaml("a: 1\r\nb: 2", { b: 2, a: 1 })).toBe("b: 2\r\na: 1");
  });

  it("leaves a comment set apart at the top, and one closing the block, where they are", () => {
    expect(editFrontmatterYaml("# about\n\na: 1\nb: 2", { b: 2, a: 1 })).toBe("# about\n\nb: 2\na: 1");
    expect(editFrontmatterYaml("a: 1\nb: 2\n# end", { b: 2, a: 1 })).toBe("b: 2\na: 1\n# end");
  });

  it("puts a key added in the same edit where it was placed", () => {
    expect(editFrontmatterYaml("a: 1\n# about b\nb: 2", { c: 3, a: 1, b: 2 })).toBe("c: 3\na: 1\n# about b\nb: 2");
  });

  // An object lists an array-index key first wherever the file wrote it, so
  // the order it hands back says nothing about where that key goes.
  it("never moves a key that reads as an array index, and moves the rest around it", () => {
    const yaml = "title: x\n2024: y\nauthor: z";
    expect(editFrontmatterYaml(yaml, data(yaml))).toBe(yaml);
    expect(editFrontmatterYaml(yaml, { ...data(yaml), author: "w" })).toBe("title: x\n2024: y\nauthor: w");
    expect(editFrontmatterYaml(yaml, inOrder(yaml, ["2024", "author", "title"]))).toBe("author: z\n2024: y\ntitle: x");
  });

  it("rewrites a document whose keys only moved", () => {
    expect(editFrontmatter("---\na: 1\nb: 2\n---\n\n# Post\n", { b: 2, a: 1 })).toBe(
      "---\nb: 2\na: 1\n---\n\n# Post\n",
    );
  });
});

describe("sameKeyOrder", () => {
  it("compares the order of the keys both hold, an array-index key and an undefined value left out", () => {
    expect(sameKeyOrder({ a: 1, b: 2 }, { a: 3, b: 4 })).toBe(true);
    expect(sameKeyOrder({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(sameKeyOrder({ 7: 1, a: 1 }, { a: 1, 7: 1 })).toBe(true);
    expect(sameKeyOrder({ a: 1, gone: undefined, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });
});

describe("readFrontmatter", () => {
  it("reads a block that doesn't parse as no properties, naming the file's line and the parser's reason", () => {
    expect(readFrontmatter("---\nstatus: draft\ntitle: Chapter 1: The Start\n---\n\n# Chapter 1\n")).toEqual({
      data: {},
      body: "# Chapter 1\n",
      error: "line 3: Nested mappings are not allowed in compact mappings",
    });
    expect(readFrontmatter("---\ntags: a\ntags: b\n---\nText").error).toBe("line 3: Map keys must be unique");
  });

  it("reads a block that parses, and a document with none, with no error", () => {
    expect(readFrontmatter("---\nstatus: draft\n---\n\nText")).toEqual({ data: { status: "draft" }, body: "Text" });
    expect(readFrontmatter("Text")).toEqual({ data: {}, body: "Text" });
  });
});

describe("isPrivateDocument", () => {
  it("keeps a document marked private, and one whose block doesn't parse, since nothing shows it isn't", () => {
    expect(isPrivateDocument("---\nvisibility: private\n---\nText")).toBe(true);
    expect(isPrivateDocument("---\nvisibility: private\ntags: a\ntags: b\n---\nText")).toBe(true);
    expect(isPrivateDocument("---\ntitle: Chapter 1: The Start\n---\nText")).toBe(true);
    expect(isPrivateDocument("---\nvisibility: public\n---\nText")).toBe(false);
    expect(isPrivateDocument("Text")).toBe(false);
  });

  it("keeps a private document private behind a byte order mark", () => {
    expect(isPrivateDocument("\uFEFF---\nvisibility: private\n---\nText")).toBe(true);
  });
});

describe("sameFrontmatter", () => {
  it("compares maps in any key order, and reads a key set to undefined as absent", () => {
    expect(sameFrontmatter({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameFrontmatter({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameFrontmatter({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameFrontmatter({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe("frontmatterDescription", () => {
  it("reads a non-empty string, trimmed", () => {
    expect(frontmatterDescription({ description: "  The investigator. " })).toBe("The investigator.");
  });

  it("reads nothing from a blank, missing or non-string value", () => {
    expect(frontmatterDescription({ description: "  " })).toBeUndefined();
    expect(frontmatterDescription({})).toBeUndefined();
    expect(frontmatterDescription({ description: ["a", "b"] })).toBeUndefined();
  });
});
