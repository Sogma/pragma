// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, HighlightStyle, highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags as highlightTags } from "@lezer/highlight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TagDefinition } from "../../../../src/protocol/tags.ts";
import { editProposal, proposeEdit } from "../../../../web/editProposal.ts";
import { formattingChanged, wikilinkShown } from "../../../../web/formats/markdown/formatting.ts";
import type { LinkLead } from "../../../../web/markdownRender.ts";
import type { FormatContext } from "../../../../web/services/formats.ts";
import { hideFormatSyntax } from "../../../../web/services/settings.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

// The syntax the selection shows, with Hide format syntax off; its rules
// with the switch on are hiddenSyntax.test.ts's.
let view: EditorView | undefined;
beforeEach(() => hideFormatSyntax.set(false));
afterEach(() => {
  view?.destroy();
  view = undefined;
  hideFormatSyntax.set(true);
});

interface Options {
  // Where the selection is; the end of the text when absent.
  cursor?: number | EditorSelection;
  focused?: boolean;
  extensions?: Extension;
  // The space's declared tags.
  tags?: TagDefinition[];
  linkHint?: (lead: LinkLead, text: string) => string | undefined;
}

// A note's editor as the pane builds it: the format's language and its
// formatting, with history and several selection ranges, a wikilink
// resolving unless it names "missing".
function edit(
  doc: string,
  { cursor = doc.length, focused = false, extensions = [], tags = [], linkHint }: Options = {},
) {
  const format = testFormats({
    resolveWikilinkTarget: (target) => (target === "missing" ? undefined : `notes/${target}.md`),
    linkHint,
    tags: { known: tags },
  }).get("note");
  const context: FormatContext = {
    path: () => "notes/a.md",
    showLinkMenu: vi.fn(),
    openPath: vi.fn(),
    searchTag: vi.fn(),
  };
  const formatting = format.formatting?.(context);
  if (!formatting) throw new Error("the Markdown format has no formatting");
  const state = EditorState.create({
    doc,
    selection: typeof cursor === "number" ? EditorSelection.cursor(cursor) : cursor,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      history(),
      format.extensions(context),
      formatting,
      extensions,
    ],
  });
  ensureSyntaxTree(state, doc.length);
  const editor = new EditorView({ state, parent: document.body });
  view = editor;
  // jsdom never gives the editor focus.
  if (focused) Object.defineProperty(editor, "hasFocus", { get: () => true });
  editor.dispatch({ effects: formattingChanged.of(null) });
  return { view: editor, context };
}

// What each line reads, hidden syntax left out.
function shown(editor: EditorView): string[] {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "");
}

function line(editor: EditorView, index: number): HTMLElement {
  const element = editor.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[index];
  if (!element) throw new Error(`no line ${index}`);
  return element;
}

describe("the syntax a note's editor hides", () => {
  it("hides what reading view hides, away from the selection", () => {
    const { view } = edit("# Title\n\nSome **bold**, *em*, ~~gone~~, ^up^, ==lit==, `code` and \\* star.\n");
    expect(shown(view)).toEqual(["Title", "", "Some bold, em, gone, up, lit, code and * star.", ""]);
    expect(line(view, 0).classList).toContain("cm-md-h1");
    expect(view.contentDOM.querySelector(".cm-md-strong")?.textContent).toBe("bold");
    expect(view.contentDOM.querySelector(".cm-md-highlight")?.textContent).toBe("lit");
    expect(view.contentDOM.querySelector(".cm-md-code")?.textContent).toBe("code");
  });

  it("shows a run's syntax, faint, once the selection touches it, its edges included", () => {
    expect(shown(edit("a **b** c", { cursor: 1, focused: true }).view)).toEqual(["a b c"]);
    for (const cursor of [2, 4, 7]) {
      const { view } = edit("a **b** c", { cursor, focused: true });
      expect(shown(view)).toEqual(["a **b** c"]);
      expect([...view.contentDOM.querySelectorAll(".cm-shown-syntax")].map((mark) => mark.textContent)).toEqual([
        "**",
        "**",
      ]);
    }
  });

  it("counts every selection range, and none while the editor has no focus", () => {
    const doc = "**a** and *b*";
    const both = EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(12)]);
    expect(shown(edit(doc, { cursor: both, focused: true }).view)).toEqual(["**a** and *b*"]);
    expect(shown(edit(doc, { cursor: both }).view)).toEqual(["a and b"]);
  });

  it("shows a heading's marks while the selection is on its line, closing ones too", () => {
    const doc = "## Head ##\n\ntext";
    expect(shown(edit(doc, { focused: true }).view)).toEqual(["Head", "", "text"]);
    expect(shown(edit(doc, { cursor: 6, focused: true }).view)).toEqual(["## Head ##", "", "text"]);
  });

  it("sizes an underlined heading's text, its underline left as written", () => {
    const { view } = edit("Title\n===\n\ntext");
    expect(shown(view)).toEqual(["Title", "===", "", "text"]);
    expect(line(view, 0).classList).toContain("cm-md-h1");
    expect(line(view, 1).classList).not.toContain("cm-md-heading");
  });

  // Reading view leaves half a heading's size under it, whether the text
  // follows it directly or after a blank line.
  it("leaves reading view's gap under a heading: below its line, or as the height of a blank line under it", () => {
    const { view } = edit("## Close\ntext\n\n### Spaced\n\ntext\n\nSetext\n===\ntext", { extensions: lineNumbers() });
    const classes = (index: number) => [...line(view, index).classList].filter((name) => name.startsWith("cm-md-gap"));
    expect(classes(0)).toEqual(["cm-md-gap-below", "cm-md-gap-h2"]);
    expect(classes(3)).toEqual([]);
    expect(classes(4)).toEqual(["cm-md-gap-line", "cm-md-gap-h3"]);
    expect(classes(8)).toEqual(["cm-md-gap-below", "cm-md-gap-h1"]);
    expect(classes(2)).toEqual([]);
    // The short blank line's number has no room to show.
    const cells = [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter(
      (cell) => cell.style.visibility !== "hidden",
    );
    expect(cells.map((cell) => cell.classList.contains("cm-md-gap-line"))).toEqual(
      ["## Close", "text", "", "### Spaced", "", "text", "", "Setext", "===", "text"].map((_, index) => index === 4),
    );
  });

  it("keeps a code block's fence lines as its top and bottom, their text hidden until the selection is in it", () => {
    const doc = "```js\nlet a = **1**;\n```\n\nafter";
    const { view } = edit(doc, { focused: true });
    expect(shown(view)).toEqual(["", "let a = **1**;", "", "", "after"]);
    expect(line(view, 0).classList).toContain("cm-md-codeblock-start");
    expect(line(view, 1).classList).toContain("cm-md-codeblock");
    expect(line(view, 2).classList).toContain("cm-md-codeblock-end");
    expect(shown(edit(doc, { cursor: 8, focused: true }).view)).toEqual([
      "```js",
      "let a = **1**;",
      "```",
      "",
      "after",
    ]);
  });

  it("draws a comment's text muted between its ends, which show faint wherever the selection is", () => {
    const doc = "Text <!-- note --> more\n\n<!--\nblock\n-->\n\n<!-- a --> <b>past</b>";
    const { view } = edit(doc, { cursor: 0, focused: true });
    expect(shown(view)).toEqual(doc.split("\n"));
    const texts = (selector: string) => [...view.contentDOM.querySelectorAll(selector)].map((mark) => mark.textContent);
    expect(texts(".cm-md-comment")).toEqual([" note ", "block", " a "]);
    expect(texts(".cm-shown-syntax")).toEqual(["<!--", "-->", "<!--", "-->", "<!--", "-->"]);
  });

  it("leaves images, tables, HTML and reference definitions as written", () => {
    const doc = "![a *b*](p.png)\n\n| a | *b* |\n| - | - |\n\n<b>*x*</b>\n\n[r]: https://x.com";
    expect(shown(edit(doc).view)).toEqual(doc.split("\n").map((text) => (text === "<b>*x*</b>" ? "<b>x</b>" : text)));
  });
});

describe("what a note's editor draws over its text", () => {
  it("keeps a bullet's character, drawn by how deep its list nests, and an ordered item's number as written", () => {
    const { view } = edit("- one\n  * two\n    + three\n      - four\n\n1. five\n   - six");
    expect(shown(view)).toEqual(["- one", "  * two", "    + three", "      - four", "", "1. five", "   - six"]);
    expect(
      [...view.contentDOM.querySelectorAll(".cm-md-bullet")].map((mark) => [mark.textContent, mark.className]),
    ).toEqual([
      ["-", "cm-md-bullet"],
      ["*", "cm-md-bullet cm-md-bullet-circle"],
      ["+", "cm-md-bullet cm-md-bullet-square"],
      ["-", "cm-md-bullet cm-md-bullet-square"],
      ["-", "cm-md-bullet cm-md-bullet-circle"],
    ]);
  });

  it("puts a quote's lines behind a bar, the first `>` kept see-through and a nested one shown", () => {
    const { view } = edit("> one\n> > two\n\nplain");
    expect(shown(view)).toEqual(["> one", "> > two", "", "plain"]);
    expect(line(view, 0).classList).toContain("cm-md-quote");
    expect(line(view, 3).classList).not.toContain("cm-md-quote");
    expect(view.contentDOM.querySelectorAll(".cm-md-quote-mark")).toHaveLength(2);
    expect(line(view, 1).querySelector(".cm-shown-syntax")?.textContent).toBe(">");
    // Each wraps at its own text, past every `>` before it.
    expect(line(view, 0).getAttribute("style")).toMatch(/text-indent/);
    expect(line(view, 1).getAttribute("style")).not.toBe(line(view, 0).getAttribute("style"));
  });

  it("draws a rule as a line until the selection is on it", () => {
    const doc = "a\n\n---\n\nb";
    expect(line(edit(doc).view, 2).classList).toContain("cm-md-hr");
    expect(line(edit(doc, { cursor: 4, focused: true }).view, 2).classList).not.toContain("cm-md-hr");
  });

  it("hangs a list item's wrapped rows at its text", () => {
    const { view } = edit("- a long item\n  - [ ] a task\nplain");
    expect(line(view, 0).getAttribute("style")).toMatch(/text-indent: calc\(-1 \* var\(--md-hang-\d+/);
    expect(line(view, 1).getAttribute("style")).toMatch(/text-indent/);
    expect(line(view, 2).getAttribute("style")).toBeNull();
  });

  it("classes a heading's gutter cells, so its line number sits on its baseline", () => {
    const { view } = edit("# One\n\ntext\n\n### Three", { extensions: lineNumbers() });
    // The first cell is the hidden spacer that sizes the column.
    const cells = [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter(
      (cell) => cell.style.visibility !== "hidden",
    );
    expect(cells.map((cell) => cell.classList.contains("cm-md-heading"))).toEqual([true, false, false, false, true]);
    expect(cells[4].classList).toContain("cm-md-h3");
  });
});

describe("links in a note's editor", () => {
  it("shows a link as its text and a wikilink as reading view shows it", () => {
    const doc = "[site](https://a.com) [note](b.md) [[f/n.md]] [[x|shown]] [[missing]] <https://c.com> [ref][r]";
    const { view } = edit(doc);
    expect(shown(view)).toEqual(["site note n shown missing https://c.com ref"]);
    const links = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-link")];
    expect(links.map((link) => [link.textContent, link.dataset.spacePath])).toEqual([
      ["note", "notes/b.md"],
      ["n", "notes/f/n.md.md"],
      ["shown", "notes/x.md"],
    ]);
    expect(view.contentDOM.querySelector(".cm-md-unresolved")?.textContent).toBe("missing");
    expect(view.contentDOM.querySelector(".cm-md-plain")?.textContent).toBe("ref");
  });

  it("underlines what reading view links, and nothing it leaves as text", () => {
    const doc =
      "[site](https://a.com) [mail](mailto:a@b.com) [note](b.md) [[x]] [[missing]] <https://c.com> www.d.com e@f.com [g](#h)";
    const underlined = [...edit(doc).view.contentDOM.querySelectorAll(".cm-md-anchor")].map((mark) => mark.textContent);
    expect(underlined).toEqual(["site", "mail", "note", "x", "https://c.com", "www.d.com"]);
  });

  it("underlines a link inside the span that colors it, the link a click opens left whole", () => {
    const linkColor = HighlightStyle.define([{ tag: [highlightTags.link, highlightTags.url], color: "blue" }]);
    const { view } = edit("[site](https://a.com) [the **keeper**](b.md) [[x]] www.d.com end", {
      extensions: syntaxHighlighting(linkColor),
    });
    const colored = `[class~="${highlightingFor(view.state, [highlightTags.link])}"]`;
    const underlines = [...view.contentDOM.querySelectorAll(".cm-md-anchor")];
    expect(underlines.map((mark) => mark.textContent)).toEqual(["site", "the ", "keeper", "x", "www.d.com"]);
    for (const mark of underlines) expect(mark.closest(colored)).not.toBeNull();
    const links = [...view.contentDOM.querySelectorAll(".cm-md-link")].map((link) => link.textContent);
    expect(links).toEqual(["the keeper", "x"]);
  });

  it("gives a link its hint over the whole of its text, by where it leads, as reading view does", () => {
    const linkHint = (lead: LinkLead, text: string) =>
      `${"url" in lead ? lead.url : `${lead.form} ${lead.written} ${lead.path ?? "none"}`} / ${text}`;
    const doc =
      "[site](https://a.com) [the **clip**](c.mp4) [[plan]] [[missing]] [top](#top) <https://c.com> www.d.com";
    const hinted = [
      ...edit(doc, { linkHint, cursor: 0 }).view.contentDOM.querySelectorAll<HTMLElement>("[data-tooltip]"),
    ];
    expect(hinted.map((mark) => [mark.textContent, mark.dataset.tooltip])).toEqual([
      ["site", "https://a.com / site"],
      ["the clip", "markdown c.mp4 notes/c.mp4 / the **clip**"],
      ["plan", "wikilink plan notes/plan.md / plan"],
      ["missing", "wikilink missing none / missing"],
      ["top", "markdown #top none / top"],
    ]);
    expect(edit(doc).view.contentDOM.querySelector("[data-tooltip]")).toBeNull();
  });

  // Between the two events the press puts the cursor where it landed, as the
  // editor's own mousedown does in a browser; jsdom can't lay out text for it.
  function click(editor: EditorView, target: Element): void {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
    editor.dispatch({ selection: EditorSelection.cursor(editor.posAtDOM(target) + 1) });
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, detail: 1 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  }

  it("opens a wikilink's file on a click, leaving the cursor where it was", () => {
    const { view, context } = edit("see [[plan]] now", { cursor: 0 });
    const link = view.contentDOM.querySelector(".cm-md-link") as HTMLElement;
    click(view, link);
    expect(context.openPath).toHaveBeenCalledWith("notes/plan.md", link);
    expect(view.state.selection.main.head).toBe(0);
  });

  it("edits a link the cursor touches instead, and never opens an unresolved one", () => {
    const touching = edit("see [[plan]] now", { cursor: 12, focused: true });
    click(touching.view, touching.view.contentDOM.querySelector(".cm-md-link") as HTMLElement);
    expect(touching.context.openPath).not.toHaveBeenCalled();

    const missing = edit("see [[missing]] now", { cursor: 0 });
    click(missing.view, missing.view.contentDOM.querySelector(".cm-md-unresolved") as HTMLElement);
    expect(missing.context.openPath).not.toHaveBeenCalled();
  });

  it("draws a tag as written in its pill, filled with its declared color in any case", () => {
    const tags = [{ name: "draft", color: "#E03E3E" }];
    const { view } = edit("A #Draft, a #night and `#code`.\n\n| #cell |\n| - |\n", { tags });
    const pills = [...view.contentDOM.querySelectorAll<HTMLElement>(".inline-tag")];
    expect(pills.map((pill) => [pill.textContent, pill.dataset.mdTag])).toEqual([
      ["#Draft", "Draft"],
      ["#night", "night"],
    ]);
    expect(pills[0].classList).toContain("has-tag-color");
    expect(pills[0].style.background).toBe("rgb(224, 62, 62)");
    expect(pills[1].getAttribute("style")).toBeNull();
  });

  it("opens Search for a tag on a click, and edits one the cursor touches instead", () => {
    const { view, context } = edit("see #plan now", { cursor: 0 });
    click(view, view.contentDOM.querySelector(".inline-tag") as HTMLElement);
    expect(context.searchTag).toHaveBeenCalledWith("plan");
    expect(view.state.selection.main.head).toBe(0);

    const touching = edit("see #plan now", { cursor: 9, focused: true });
    click(touching.view, touching.view.contentDOM.querySelector(".inline-tag") as HTMLElement);
    expect(touching.context.searchTag).not.toHaveBeenCalled();
  });
});

describe("a task's checkbox", () => {
  it("stands for its brackets, checked as they say, until the selection touches them", () => {
    const doc = "- [ ] open\n- [x] done";
    const boxes = [...edit(doc).view.contentDOM.querySelectorAll<HTMLInputElement>("input.cm-md-task")];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    expect(shown(edit(doc, { cursor: 4, focused: true }).view)[0]).toBe("- [ ] open");
  });

  it("writes the one character between its brackets, an edit undo reverts", () => {
    const { view } = edit("- [ ] open\n- [X] done");
    const box = (index: number) => view.contentDOM.querySelectorAll<HTMLInputElement>("input.cm-md-task")[index];
    box(0).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("- [x] open\n- [X] done");
    box(1).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("- [x] open\n- [ ] done");
    undo(view);
    undo(view);
    expect(view.state.doc.toString()).toBe("- [ ] open\n- [X] done");
  });
});

describe("syntax shown for something other than the selection", () => {
  it("shows the syntax inside find's matches while its card is open", () => {
    const { view } = edit("a **b** c\n\n# d", { extensions: search() });
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "**b" })) });
    openSearchPanel(view);
    expect(shown(view)).toEqual(["a **b** c", "", "d"]);
  });

  it("shows a pending proposal's changes as written", () => {
    const { view } = edit("a **b** c and *d*", { extensions: editProposal({ barHost: document.body }) });
    proposeEdit(view, { base: "a **b** c and *d*", hunks: [{ from: 2, to: 7, insert: "b" }] });
    expect(shown(view)[0]).toContain("a **b**");
    expect(shown(view)[0]).not.toContain("*d*");
  });
});

describe("wikilinkShown", () => {
  it.each([
    ["note", "note"],
    ["f/n.md", "n"],
    ["m/md.md", "md"],
    ["f/n.md|shown", "shown"],
    ["note| ", "note"],
    ["a/b/", "b"],
    ["/abs/path.md", "/abs/path.md"],
    [" spaced ", "spaced"],
  ])("finds what %j shows", (raw, text) => {
    const span = wikilinkShown(raw);
    expect(span && raw.slice(span.from, span.to)).toBe(text);
  });

  it("takes a relative target's name from its last segment, not an earlier match", () => {
    expect(wikilinkShown("m/md.md")).toEqual({ from: 2, to: 4 });
  });
});
