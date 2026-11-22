// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFormat, type FormatActions, type FormatContext } from "../../../../web/services/formats.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

const format = testFormats().get("note");
const actions = format.actions as FormatActions;
const context: FormatContext = {
  path: () => "notes/a.md",
  openPath: vi.fn(),
  searchTag: vi.fn(),
};

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

// A note's editor in the Markdown format's grammar. `|` marks a caret, «
// and » a selection; `shown` marks the result the same way.
function edit(marked: string): EditorView {
  const caret = marked.indexOf("|");
  const from = caret >= 0 ? caret : marked.indexOf("«");
  const to = caret >= 0 ? caret : marked.indexOf("»") - 1;
  const doc = marked.replace(/[|«»]/g, "");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [EditorState.allowMultipleSelections.of(true), format.extensions(context)],
  });
  ensureSyntaxTree(state, doc.length);
  view = new EditorView({ state, parent: document.body });
  return view;
}

function shown(editor: EditorView): string {
  const text = editor.state.doc.toString();
  const { from, to } = editor.state.selection.main;
  if (from === to) return `${text.slice(0, from)}|${text.slice(from)}`;
  return `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`;
}

function run(editor: EditorView, id: string): string {
  expect(applyFormat(actions, id, editor)).toBe(true);
  return shown(editor);
}

// A selection made with Shift+Left, its head at its start.
function backward(editor: EditorView): EditorView {
  const { from, to } = editor.state.selection.main;
  editor.dispatch({ selection: EditorSelection.single(to, from) });
  return editor;
}

const headAtStart = (editor: EditorView) => editor.state.selection.main.head === editor.state.selection.main.from;

function on(editor: EditorView, id: string): boolean {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  const action = [...actions.lines, ...actions.marks].find((each) => each.id === id);
  return action?.isOn?.(editor.state) ?? false;
}

describe("Markdown format actions: marks", () => {
  it("bolds the word a caret is in, the caret keeping its place, and takes it off again", () => {
    const editor = edit("one tw|o three");
    expect(run(editor, "bold")).toBe("one **tw|o** three");
    expect(on(editor, "bold")).toBe(true);
    expect(on(editor, "italic")).toBe(false);
    expect(run(editor, "bold")).toBe("one tw|o three");
  });

  it("keeps a caret at a word's end inside the new mark", () => {
    expect(run(edit("one two| three"), "italic")).toBe("one *two|* three");
  });

  it("puts a caret in no word between new delimiters, to type into", () => {
    expect(run(edit("one |"), "bold")).toBe("one **|**");
  });

  it("wraps a selection line by line, trimmed of its spaces and kept off each line's markers", () => {
    expect(run(edit("- «one\n- two »"), "bold")).toBe("- **«one**\n- **two»** ");
  });

  it("writes each mark's own delimiter", () => {
    expect(run(edit("«word»"), "italic")).toBe("*«word»*");
    expect(run(edit("«word»"), "code")).toBe("`«word»`");
    expect(run(edit("«word»"), "strikethrough")).toBe("~~«word»~~");
    expect(run(edit("«word»"), "highlight")).toBe("==«word»==");
    expect(run(edit("«word»"), "superscript")).toBe("^«word»^");
    expect(run(edit("«word»"), "subscript")).toBe("~«word»~");
  });

  it("counts a caret just past a closing delimiter as out of the mark", () => {
    expect(on(edit("**bold**| next"), "bold")).toBe(false);
    expect(on(edit("**bo|ld** next"), "bold")).toBe(true);
  });

  it("highlights the word a caret is in and takes the highlight off again", () => {
    const editor = edit("one tw|o three");
    expect(run(editor, "highlight")).toBe("one ==tw|o== three");
    expect(on(editor, "highlight")).toBe(true);
    expect(run(editor, "highlight")).toBe("one tw|o three");
  });

  it("clears both delimiters of every mark the selection touches, and the marks a caret is in", () => {
    expect(run(edit("«a **b** and *c*»"), "clearFormatting")).toBe("«a b and c»");
    expect(run(edit("**bo«ld** te»xt"), "clearFormatting")).toBe("bo«ld te»xt");
    expect(run(edit("***bo|ld*** plain"), "clearFormatting")).toBe("bo|ld plain");
    expect(run(edit("«a ==b== c»"), "clearFormatting")).toBe("«a b c»");
  });

  it("keeps a backward selection's head at its start as a mark or a comment goes on and off", () => {
    for (const id of ["bold", "htmlComment"]) {
      const editor = backward(edit("Snow «falls» hard."));
      run(editor, id);
      expect(headAtStart(editor)).toBe(true);
      expect(run(editor, id)).toBe("Snow «falls» hard.");
      expect(headAtStart(editor)).toBe(true);
    }
  });
});

describe("Markdown format actions: links", () => {
  it("writes a link around the selection, the caret where the address goes", () => {
    expect(run(edit("see «the docs»"), "link")).toBe("see [the docs](|)");
  });

  it("writes one around an address, the caret where its text goes", () => {
    expect(run(edit("«https://example.com»"), "link")).toBe("[|](https://example.com)");
  });

  it("writes an empty one at a caret", () => {
    expect(run(edit("a |"), "link")).toBe("a [|]()");
  });

  it("takes a link off its text", () => {
    const editor = edit("see [the do|cs](https://example.com) now");
    expect(on(editor, "link")).toBe(true);
    expect(run(editor, "link")).toBe("see the do|cs now");
  });
});

describe("Markdown format actions: comments", () => {
  it("comments out the line a caret is on, the caret keeping its place, and takes the comment off again", () => {
    const editor = edit("- one tw|o");
    expect(on(editor, "htmlComment")).toBe(false);
    expect(run(editor, "htmlComment")).toBe("<!-- - one tw|o -->");
    expect(on(editor, "htmlComment")).toBe(true);
    expect(run(editor, "htmlComment")).toBe("- one tw|o");
    expect(run(edit("text|"), "htmlComment")).toBe("<!-- text| -->");
  });

  it("wraps a selection on one line as it is, and the lines of one over several whole", () => {
    expect(run(edit("one « two » three"), "htmlComment")).toBe("one  <!-- «two» -->  three");
    expect(run(edit("- o«ne\n\n- tw»o\n"), "htmlComment")).toBe("<!-- «- one\n\n- two» -->\n");
  });

  it("opens an empty comment on a blank line, the caret inside", () => {
    expect(run(edit("a\n|\nb"), "htmlComment")).toBe("a\n<!-- | -->\nb");
  });

  it("takes off every comment the text it would go around holds, never writing one inside another", () => {
    expect(run(edit("keep <!-- old --> te|xt"), "htmlComment")).toBe("keep old te|xt");
    expect(run(edit("«<!-- a --> b <!--c-->»"), "htmlComment")).toBe("«a b c»");
  });

  it("takes a comment over several lines off with the lines its ends stand alone on", () => {
    expect(run(edit("<!--\nbl|ock\n\nmore\n-->\n\nafter"), "htmlComment")).toBe("bl|ock\n\nmore\n\nafter");
    expect(run(edit("<!-- one\ntw|o -->"), "htmlComment")).toBe("one\ntw|o");
    expect(run(edit("<!--\n|\n-->"), "htmlComment")).toBe("|");
  });
});

describe("Markdown format actions: lines", () => {
  it("turns a line into a heading and, run again, back into text", () => {
    const editor = edit("Ti|tle");
    expect(run(editor, "heading2")).toBe("## Ti|tle");
    expect(on(editor, "heading2")).toBe(true);
    expect(run(editor, "heading2")).toBe("Ti|tle");
  });

  it("replaces another kind's markers, leaving the caret in the text", () => {
    expect(run(edit("- it|em"), "heading1")).toBe("# it|em");
    expect(run(edit("|todo"), "taskList")).toBe("- [ ] |todo");
  });

  it("numbers the lines it turns into a numbered list, leaving blank lines blank", () => {
    expect(run(edit("«a\n\nb\nc»"), "numberedList")).toBe("1. «a\n\n2. b\n3. c»");
  });

  it("keeps a list item's nesting, and takes it off for any other kind", () => {
    expect(run(edit("  1. ne|sted"), "bulletList")).toBe("  - ne|sted");
    expect(run(edit("  - ne|sted"), "quote")).toBe("> ne|sted");
  });

  it("toggles a quote back into text", () => {
    const editor = edit("> quo|ted");
    expect(on(editor, "quote")).toBe(true);
    expect(run(editor, "quote")).toBe("quo|ted");
  });

  it("fences lines into a code block and takes the fences off again", () => {
    const editor = edit("«let a\nlet b»");
    expect(run(editor, "codeBlock")).toBe("```\n«let a\nlet b»\n```");
    expect(on(editor, "codeBlock")).toBe(true);
    expect(run(editor, "codeBlock")).toBe("«let a\nlet b»");
  });

  it("turns a code block's lines into another kind, its fences gone and its text kept", () => {
    expect(run(edit("```js\n«a\nb»\n```"), "heading1")).toBe("# «a\n# b»");
  });

  it("names the text a line is with the first kind, as the picker shows it", () => {
    expect(on(edit("plain |line"), "text")).toBe(true);
    expect(on(edit("## head|ing"), "text")).toBe(false);
  });
});
