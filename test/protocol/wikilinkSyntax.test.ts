import { GFM, parser, Table } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { wikilinkSyntax } from "../../src/protocol/wikilinkSyntax.ts";

const wikilinkParser = parser.configure(wikilinkSyntax);

// Every Wikilink and Link node's source text, in document order.
function links(text: string, using = wikilinkParser): string[] {
  const found: string[] = [];
  using.parse(text).iterate({
    enter: (node) => {
      if (node.name === "Wikilink" || node.name === "Link")
        found.push(`${node.name}:${text.slice(node.from, node.to)}`);
    },
  });
  return found;
}

const wikilinks = (text: string, using = wikilinkParser) =>
  links(text, using).filter((link) => link.startsWith("Wikilink:"));

// Conformance tests for docs/protocol.md's Links section: what a wikilink is,
// read the same by every reader that parses with this syntax.
describe("wikilink syntax", () => {
  it("claims both brackets of each form, with its marks at either end", () => {
    expect(links("see [[a]] and [[b/c|C]] here")).toEqual(["Wikilink:[[a]]", "Wikilink:[[b/c|C]]"]);
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

  it("holds no bracket, and may run across a line break", () => {
    expect(wikilinks("[[a]")).toEqual([]);
    expect(wikilinks("[[a]b]]")).toEqual([]);
    expect(wikilinks("[[[a]]]")).toEqual(["Wikilink:[[a]]"]);
    expect(wikilinks("[[a]]]")).toEqual(["Wikilink:[[a]]"]);
    expect(wikilinks("x [[a\nb]] y")).toEqual(["Wikilink:[[a\nb]]"]);
  });

  // A link names a target: an empty one would name the document's own folder.
  it("takes nothing that names no target for a wikilink", () => {
    expect(wikilinks("[[]] [[ ]] [[|shown]]")).toEqual([]);
    expect(wikilinks("[[ a ]]")).toEqual(["Wikilink:[[ a ]]"]);
  });

  // Its brackets say it is a path, as docs/protocol.md has it, whatever an
  // address-reading grammar would make of the text inside.
  it("reads an address in brackets as a wikilink, never a web link in brackets", () => {
    const gfm = parser.configure([GFM, wikilinkSyntax]);
    expect(wikilinks("[[www.example.com]] [[a|https://x.com]]", gfm)).toEqual([
      "Wikilink:[[www.example.com]]",
      "Wikilink:[[a|https://x.com]]",
    ]);
  });

  // A table splits its cells at each pipe first, as the page does.
  it("finds no piped wikilink across a table's cells", () => {
    const tables = parser.configure([Table, wikilinkSyntax]);
    expect(wikilinks("| x | y |\n| - | - |\n| [[a|b]] | c |", tables)).toEqual([]);
    expect(wikilinks("| x |\n| - |\n| [[a]] |", tables)).toEqual(["Wikilink:[[a]]"]);
  });
});
