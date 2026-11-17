import { parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { wikilinkPattern } from "../../src/protocol/wikilink.ts";
import { wikilinkSyntax } from "../../web/wikilinkSyntax.ts";

const wikilinkParser = parser.configure(wikilinkSyntax);

// Every Wikilink and Link node's source text, in document order.
function links(text: string): string[] {
  const found: string[] = [];
  wikilinkParser.parse(text).iterate({
    enter: (node) => {
      if (node.name === "Wikilink" || node.name === "Link")
        found.push(`${node.name}:${text.slice(node.from, node.to)}`);
    },
  });
  return found;
}

describe("wikilink syntax", () => {
  it("claims both brackets of each form, with its marks at either end", () => {
    expect(links("see [[a]] and [[t|shown]]")).toEqual(["Wikilink:[[a]]", "Wikilink:[[t|shown]]"]);
    const marks: string[] = [];
    wikilinkParser.parse("[[a]]").iterate({
      enter: (node) => {
        if (node.name === "WikilinkMark") marks.push("[[a]]".slice(node.from, node.to));
      },
    });
    expect(marks).toEqual(["[[", "]]"]);
  });

  it("leaves ordinary links to the Link parser", () => {
    expect(links("[a](./x.md) [ref]")).toEqual(["Link:[a](./x.md)", "Link:[ref]"]);
  });

  it("ignores a wikilink inside inline code", () => {
    expect(links("`[[a]]`")).toEqual([]);
  });

  // The editor must mark exactly what the reading view links, or a link
  // would look live in one and inert in the other.
  it.each(["[[]]", "[[a]", "[[a]b]]", "[[[a]]]", "[[a]]]", "x [[a\nb]] y"])(
    "matches what wikilinkPattern matches in %j",
    (text) => {
      const expected = [...text.matchAll(wikilinkPattern())].map((match) => `Wikilink:${match[0]}`);
      expect(links(text).filter((link) => link.startsWith("Wikilink:"))).toEqual(expected);
    },
  );
});
