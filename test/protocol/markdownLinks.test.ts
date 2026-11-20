import { describe, expect, it } from "vitest";
import {
  applyReferenceEdits,
  findMarkdownReferences,
  isPathDestination,
  noteLinks,
} from "../../src/protocol/markdownLinks.ts";

// What a rewrite is allowed to touch. The cases that matter most here are
// the negative ones: a reference the parser does *not* report is a reference
// a move will not corrupt.
function targets(text: string): string[] {
  return findMarkdownReferences(text).map((reference) => `${reference.kind}:${reference.raw}`);
}

describe("finding references", () => {
  it("finds a link, an image, and both wikilink forms", () => {
    expect(targets("[a](./x.md) ![i](p.png) [[w]] [[t|shown]]")).toEqual([
      "url:./x.md",
      "url:p.png",
      "wikilink:w",
      "wikilink:t",
    ]);
  });

  it("reports only the wikilink's target half, so the display text survives", () => {
    const [reference] = findMarkdownReferences("see [[notes/plan|The plan]] here");
    expect("see [[notes/plan|The plan]] here".slice(reference.from, reference.to)).toBe("notes/plan");
  });

  it("finds a reference definition's destination", () => {
    expect(targets('[d][r]\n\n[r]: ./ref.md "T"\n')).toEqual(["url:./ref.md"]);
  });

  it("reports the span inside an angle-bracketed destination", () => {
    expect(targets("[c](<./sp ace.md>)")).toEqual(["url:./sp ace.md"]);
  });

  it("excludes a link's title from the destination", () => {
    expect(targets('[a](./x.md "Title")')).toEqual(["url:./x.md"]);
  });

  // The whole reason this goes through a parser: a regex scan would rewrite
  // documentation *about* links, silently editing a code sample.
  it("ignores anything inside a fenced block or inline code", () => {
    expect(targets("```\n[[a]] [b](./c.md)\n```\n\nand `[[d]]` and `[e](./f.md)`\n")).toEqual([]);
  });

  it("ignores anything inside math, inline or a block", () => {
    expect(targets("$[[0,1]]$ and [[real]]\n\n$$\n[a](b.md)\n$$\n")).toEqual(["wikilink:real"]);
  });

  it("ignores an escaped bracket", () => {
    expect(targets("\\[\\[not a link\\]\\]")).toEqual([]);
  });

  it("does not mistake a reference link for a wikilink", () => {
    expect(targets("[text][ref]")).toEqual([]);
  });

  // Frontmatter is data, not prose. A Markdown parser handed it reads a YAML
  // flow sequence as a wikilink, which would let a move edit a document's
  // tags — and the reading view never treats it as body either.
  it("ignores frontmatter, whose YAML can look like a link", () => {
    const doc = "---\ntags: [[a, b]]\ncover: ./art/c.png\n---\n\nBody [[plan]]\n";
    expect(targets(doc)).toEqual(["wikilink:plan"]);
  });

  // The block is split, never parsed: a document whose YAML is broken still
  // has a readable body, and a rewrite must not fail over a block it never
  // reads.
  it("still finds the body's references when the frontmatter is malformed YAML", () => {
    const doc = "---\ncover: [x](./art/c.png)\n---\n\nBody [[plan]]\n";
    expect(() => targets(doc)).not.toThrow();
    expect(targets(doc)).toEqual(["wikilink:plan"]);
  });

  it("reports offsets against the whole document, frontmatter included", () => {
    const doc = "---\ntitle: T\n---\n\nBody [[plan]]\n";
    const [reference] = findMarkdownReferences(doc);
    expect(doc.slice(reference.from, reference.to)).toBe("plan");
  });
});

describe("applying edits", () => {
  it("rewrites several spans in one pass without shifting the later ones", () => {
    const text = "[a](./x.md) and [[w]] and [b](./y.md)";
    const edits = [
      { from: 4, to: 10, replacement: "../moved/x.md" },
      { from: 18, to: 19, replacement: "renamed" },
      { from: 30, to: 36, replacement: "../moved/y.md" },
    ];
    expect(applyReferenceEdits(text, edits)).toBe("[a](../moved/x.md) and [[renamed]] and [b](../moved/y.md)");
  });

  it("leaves text with no edits exactly as it was", () => {
    expect(applyReferenceEdits("unchanged", [])).toBe("unchanged");
  });
});

// Publishing rewrites an image's destination to an uploaded URL and must
// leave every other reference exactly as the author wrote it.
describe("telling an image apart from a link", () => {
  function images(text: string): string[] {
    return findMarkdownReferences(text)
      .filter((reference) => reference.isImage)
      .map((reference) => reference.raw);
  }

  it("marks an image and not a link or a reference definition", () => {
    expect(images("[a](./x.md) ![i](p.png)\n\n[r]: ./ref.png\n")).toEqual(["p.png"]);
  });

  it("marks the inner image but not the link wrapping it", () => {
    expect(images("[![thumb](small.png)](big.png)")).toEqual(["small.png"]);
  });

  it("marks an angle-bracketed image destination", () => {
    expect(images("![i](<my file.png>)")).toEqual(["my file.png"]);
  });

  it("never marks a wikilink, which has no embed form", () => {
    expect(images("[[cover.png]] [[a|b]]")).toEqual([]);
  });
});

describe("what a note links to", () => {
  const links = (text: string) => noteLinks(text).map((link) => `${link.form}:${link.raw}`);

  it("keeps wikilinks and Markdown links to paths, in source order, with where each sits", () => {
    expect(links("[[plan]] [a](./a.md) [l](lib:refs/b.md) [s](space:c.md)\n\n[r]: ./ref.md\n")).toEqual([
      "wikilink:plan",
      "markdown:./a.md",
      "markdown:lib:refs/b.md",
      "markdown:space:c.md",
      "markdown:./ref.md",
    ]);
    expect(noteLinks("See [[plan|the plan]].")).toEqual([{ form: "wikilink", raw: "plan", from: 6, to: 10 }]);
  });

  it("leaves out an embed, a web link, mailto: and a bare anchor", () => {
    expect(links("![i](p.png) [w](https://x.com/a.md) [m](mailto:a@b.c) [h](#top) [p](//x.com/a)")).toEqual([]);
  });

  it("keeps the link around a thumbnail but not the thumbnail", () => {
    expect(links("[![thumb](small.png)](big.md)")).toEqual(["markdown:big.md"]);
  });

  it("reads a destination as a path by the same rule", () => {
    for (const path of ["./a.md", "../b c.png", "lib:refs/b.md", "space:c.md", " notes/d.md "]) {
      expect(isPathDestination(path), path).toBe(true);
    }
    for (const other of ["https://x.com/a.md", "mailto:a@b.c", "#top", "//x.com/a", "ftp://x.com/a"]) {
      expect(isPathDestination(other), other).toBe(false);
    }
  });
});
