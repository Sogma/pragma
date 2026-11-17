// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormatContext } from "../../../../web/services/formats.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

// A note's editor checking its spelling, unformatted as Source mode shows it:
// the format's language and its skips.
function edit(doc: string): EditorView {
  const format = testFormats().get("note");
  const context: FormatContext = {
    path: () => "notes/a.md",
    showLinkMenu: vi.fn(),
    openPath: vi.fn(),
    searchTag: vi.fn(),
  };
  const state = EditorState.create({
    doc,
    extensions: [
      format.extensions(context),
      format.spellcheckSkips ?? [],
      EditorView.contentAttributes.of({ spellcheck: "true" }),
    ],
  });
  ensureSyntaxTree(state, doc.length);
  view = new EditorView({ state, parent: document.body });
  return view;
}

// Whether the spellchecker reads the text holding `text`: the nearest element
// that says, a skipped run's mark or else the editor itself.
function checks(editor: EditorView, text: string): boolean {
  const walker = document.createTreeWalker(editor.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) {
      return node.parentElement?.closest("[spellcheck]")?.getAttribute("spellcheck") === "true";
    }
  }
  throw new Error(`no text holds "${text}"`);
}

describe("Markdown's spellcheck skips", () => {
  it("skips code, addresses, wikilinks, HTML and tags, and checks the prose around them", () => {
    const editor = edit(
      [
        "Run `npm test` at https://example.com, or <b>loudly</b>.",
        "See [[other note]] about #todo.",
        "",
        "```",
        "const total = 1;",
        "```",
        "",
      ].join("\n"),
    );
    for (const skipped of ["npm test", "https://example.com", "<b>", "</b>", "other note", "#todo", "const total"]) {
      expect(checks(editor, skipped), skipped).toBe(false);
    }
    for (const prose of ["Run", "loudly", "See", "about"]) expect(checks(editor, prose), prose).toBe(true);
  });

  // A label is prose a reader sees, unlike the address beside it.
  it("checks a link's and an image's label, skipping only the address", () => {
    const editor = edit("Read [the guide](https://example.org/guide) and ![a sketch](sketch.png).\n");
    expect(checks(editor, "the guide")).toBe(true);
    expect(checks(editor, "a sketch")).toBe(true);
    expect(checks(editor, "https://example.org/guide")).toBe(false);
    expect(checks(editor, "sketch.png")).toBe(false);
  });

  it("skips math, inline or a block", () => {
    const editor = edit("Where $\\alpha + beta$ holds:\n\n$$\n\\mathrm{erf}(x)\n$$\n");
    expect(checks(editor, "\\alpha + beta")).toBe(false);
    expect(checks(editor, "\\mathrm{erf}(x)")).toBe(false);
    expect(checks(editor, "Where")).toBe(true);
    expect(checks(editor, "holds:")).toBe(true);
  });

  it("skips what an edit makes code", () => {
    const editor = edit("plain words\n");
    editor.dispatch({ changes: { from: 0, insert: "`snippet` " } });
    ensureSyntaxTree(editor.state, editor.state.doc.length);
    expect(checks(editor, "snippet")).toBe(false);
    expect(checks(editor, "plain words")).toBe(true);
  });
});
