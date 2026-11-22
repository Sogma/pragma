// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { noteLinks } from "../../src/protocol/markdownLinks.ts";
import { splitTitleHeading } from "../../src/protocol/markdownTitle.ts";
import { splitWikilinkLabel } from "../../src/protocol/wikilink.ts";
import { wikilinkLabel } from "../../src/protocol/wikilinkSyntax.ts";
import { renderMarkdown } from "../../web/markdownRender.ts";
import type { FormatContext } from "../../web/services/formats.ts";
import { testFormats } from "./support/formats.ts";

const note = testFormats().get("note");
const context: FormatContext = { path: () => "note.md", openPath: vi.fn(), searchTag: vi.fn() };

function inTheEditor(text: string): string[] {
  const state = EditorState.create({ doc: text, extensions: note.extensions(context) });
  const targets: string[] = [];
  ensureSyntaxTree(state, text.length)?.iterate({
    enter: (node) => {
      if (node.name === "Wikilink") targets.push(splitWikilinkLabel(wikilinkLabel(node, text)).target);
    },
  });
  return targets;
}

function onThePage(text: string): string[] {
  const targets: string[] = [];
  const wikilink = (target: string) => {
    targets.push(target);
    return undefined;
  };
  renderMarkdown(text, { image: () => undefined, link: () => undefined, wikilink });
  return targets;
}

const inBacklinks = (text: string) =>
  noteLinks(text)
    .filter((link) => link.form === "wikilink")
    .map((link) => link.raw.trim());

// Every reader takes the same text for a wikilink, or the page would show a
// link that backlinks never list, or list one the page never shows.
describe("what every reader takes for a wikilink", () => {
  it.each([
    ["See [[a]] and [[b|B]]", ["a", "b"]],
    ["| x | y |\n| - | - |\n| [[a|b]] | c |", []],
    ["| x |\n| - |\n| [[a]] |", ["a"]],
    ["[[www.example.com]] and [[https://example.com]]", ["www.example.com", "https://example.com"]],
    ["[[a|https://x.com]]", ["a"]],
    ["[[ ]] and [[]] and [[|b]]", []],
    ["`[[a]]` and $[[0,1]]$", []],
  ])("in %j", (text, targets) => {
    const read = { editor: inTheEditor(text), page: onThePage(text), backlinks: inBacklinks(text) };
    expect(read).toEqual({ editor: targets, page: targets, backlinks: targets });
  });

  it("titles a note by a wikilink's display text, an address in brackets included", () => {
    expect(splitTitleHeading("# See [[www.example.com]]").title).toBe("See www.example.com");
  });
});
