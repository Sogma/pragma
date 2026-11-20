// @vitest-environment jsdom
import { defaultKeymap, history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { openSearchPanel, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formattingChanged } from "../../../../web/formats/markdown/formatting.ts";
import { applyFormat, type FormatActions, type FormatContext } from "../../../../web/services/formats.ts";
import { hideFormatSyntax } from "../../../../web/services/settings.ts";
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
  hideFormatSyntax.set(true);
});

// A note's editor as the pane builds it, focused, with CodeMirror's own keys
// below the format's. `|` marks the caret, « and » a selection; `marked`
// reads the result back the same way.
function edit(text: string, extensions: Extension = []): EditorView {
  const caret = text.indexOf("|");
  const from = caret >= 0 ? caret : text.indexOf("«");
  const to = caret >= 0 ? caret : text.indexOf("»") - 1;
  const doc = text.replace(/[|«»]/g, "");
  const formatting = format.formatting?.(context);
  if (!formatting) throw new Error("the Markdown format has no formatting");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [history(), format.extensions(context), formatting, keymap.of(defaultKeymap), extensions],
  });
  ensureSyntaxTree(state, doc.length);
  const editor = new EditorView({ state, parent: document.body });
  Object.defineProperty(editor, "hasFocus", { get: () => true });
  editor.dispatch({ effects: formattingChanged.of(null) });
  view = editor;
  return editor;
}

function marked(editor: EditorView): string {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  const text = editor.state.doc.toString();
  const { from, to } = editor.state.selection.main;
  if (from === to) return `${text.slice(0, from)}|${text.slice(from)}`;
  return `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`;
}

// What each line shows, hidden syntax left out.
function shown(editor: EditorView): string[] {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "");
}

function press(editor: EditorView, key: string, init: KeyboardEventInit = {}): void {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  runScopeHandlers(editor, event, "editor");
}

function type(editor: EditorView, text: string): void {
  for (const char of text) {
    ensureSyntaxTree(editor.state, editor.state.doc.length);
    editor.dispatch({ ...editor.state.replaceSelection(char), userEvent: "input.type" });
  }
}

function click(editor: EditorView, pos: number): string {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  editor.dispatch({ selection: EditorSelection.cursor(pos), userEvent: "select.pointer" });
  return marked(editor);
}

describe("what the switch hides", () => {
  it("keeps a run's marks hidden at the caret, and a link's syntax showing there", () => {
    expect(shown(edit("a **b|** [c](d)"))).toEqual(["a b c"]);
    expect(shown(edit("a **b** [c|](d)"))).toEqual(["a b [c](d)"]);
  });

  it("keeps a heading's marks, a bullet and a task's box drawn at the caret", () => {
    expect(shown(edit("## Title|"))).toEqual(["Title"]);
    const task = edit("- [ ] to|do");
    expect(task.contentDOM.querySelector("input.cm-md-task")).not.toBeNull();
    expect(task.contentDOM.querySelector(".cm-md-bullet")).not.toBeNull();
  });

  it("shows a code fence only while the caret is on its line", () => {
    expect(shown(edit("```js\nco|de\n```"))).toEqual(["", "code", ""]);
    expect(shown(edit("``|`js\ncode\n```"))).toEqual(["```js", "code", ""]);
  });
});

describe("where the caret sits", () => {
  it("goes before a run's hidden marks, taking the formatting of the character before", () => {
    const editor = edit("|a **bold** c");
    expect(click(editor, 4)).toBe("a |**bold** c");
    expect(click(editor, 10)).toBe("a **bold|** c");
    expect(click(editor, 3)).toBe("a |**bold** c");
  });

  it("goes after a line's markers and opening marks, to the start of its text", () => {
    expect(click(edit("|x"), 0)).toBe("|x");
    const editor = edit("- [ ] **task**\n# Head\n\\*star|");
    expect(click(editor, 0)).toBe("- [ ] **|task**\n# Head\n\\*star");
    expect(click(editor, 15)).toBe("- [ ] **task**\n# |Head\n\\*star");
    expect(click(editor, 22)).toBe("- [ ] **task**\n# Head\n|\\*star");
    expect(click(editor, 23)).toBe("- [ ] **task**\n# Head\n|\\*star");
  });

  it("goes where it is put among syntax a find match shows", () => {
    const editor = edit("|a **b** c", search());
    editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "**b" })) });
    openSearchPanel(editor);
    expect(shown(editor)).toEqual(["a **b** c"]);
    expect(click(editor, 3)).toBe("a *|*b** c");
  });
});

describe("arrow keys", () => {
  it("move one visible character a press, past hidden marks", () => {
    const editor = edit("|a **bold** c");
    const right: string[] = [];
    for (let step = 0; step < 9; step++) {
      press(editor, "ArrowRight");
      right.push(marked(editor));
    }
    expect(right).toEqual([
      "a| **bold** c",
      "a |**bold** c",
      "a **b|old** c",
      "a **bo|ld** c",
      "a **bol|d** c",
      "a **bold|** c",
      "a **bold** |c",
      "a **bold** c|",
      "a **bold** c|",
    ]);
    const left: string[] = [];
    for (let step = 0; step < 8; step++) {
      press(editor, "ArrowLeft");
      left.push(marked(editor));
    }
    expect(left).toEqual([...right.slice(0, 7).reverse(), "|a **bold** c"]);
  });

  it("cross a line's markers with its line break", () => {
    const editor = edit("one|\n- two");
    press(editor, "ArrowRight");
    expect(marked(editor)).toBe("one\n- |two");
    press(editor, "ArrowLeft");
    expect(marked(editor)).toBe("one|\n- two");
  });

  it("move a word at a time as over the text the note shows", () => {
    const editor = edit("|a **bold** c");
    const stops: string[] = [];
    for (let step = 0; step < 3; step++) {
      press(editor, "ArrowRight", { ctrlKey: true });
      stops.push(marked(editor));
    }
    expect(stops).toEqual(["a| **bold** c", "a **bold|** c", "a **bold** c|"]);
    press(editor, "ArrowLeft", { ctrlKey: true });
    press(editor, "ArrowLeft", { ctrlKey: true });
    expect(marked(editor)).toBe("a |**bold** c");
  });

  it("extend a selection over the visible text", () => {
    const editor = edit("a |**bold** c");
    for (let step = 0; step < 4; step++) press(editor, "ArrowRight", { shiftKey: true });
    expect(marked(editor)).toBe("a «**bold»** c");
  });
});

describe("deleting", () => {
  it("takes the visible character beside the caret, never a hidden mark", () => {
    const editor = edit("a **bold|** c");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("a **bol|** c");
    press(editor, "Delete");
    expect(marked(editor)).toBe("a **bol|**c");
    const before = edit("a |**bold** c");
    press(before, "Backspace");
    expect(marked(before)).toBe("a|**bold** c");
  });

  it("takes a run's marks with its last character", () => {
    const editor = edit("a **b|** c");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("a | c");
  });

  it("takes an escaped character with its backslash", () => {
    const editor = edit("a \\*|b");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("a |b");
  });

  it("turns a heading or a task into plain text at the start of its text", () => {
    const heading = edit("## |Title");
    press(heading, "Backspace");
    expect(marked(heading)).toBe("|Title");
    const task = edit("- [ ] |todo");
    press(task, "Backspace");
    expect(marked(task)).toBe("|todo");
  });

  it("keeps a run's marks paired when a selection takes half of it", () => {
    const editor = edit("a **bo«ld** c»");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("a **bo|**");
  });

  it("makes two runs of a kind one when the line break between them goes", () => {
    const editor = edit("**bo**\n**|ld**");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("**bo|ld**");
  });

  it("pulls the next line's text up without its markers", () => {
    const editor = edit("one|\n- two");
    press(editor, "Delete");
    expect(marked(editor)).toBe("one|two");
  });
});

describe("typing", () => {
  it("keeps a blank typed at a run's end outside its marks until more text follows", () => {
    const editor = edit("**bold|**");
    type(editor, " ");
    expect(marked(editor)).toBe("**bold** |");
    type(editor, "t");
    expect(marked(editor)).toBe("**bold t|**");
    type(editor, " ");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("**bold t|**");
    type(editor, "x");
    expect(marked(editor)).toBe("**bold tx|**");
  });

  it("ends a superscript at a blank, which it cannot hold", () => {
    const editor = edit("x^ab|^");
    type(editor, " c");
    expect(marked(editor)).toBe("x^ab^ c|");
  });

  it("closes and reopens a run a line break splits, and steps out of one at its edge", () => {
    const middle = edit("- **bo|ld**");
    press(middle, "Enter");
    expect(marked(middle)).toBe("- **bo**\n- **|ld**");
    const end = edit("- **bold|**");
    press(end, "Enter");
    expect(marked(end)).toBe("- **bold**\n- |");
  });

  it("undoes a rule's fix with the typing that caused it", () => {
    const editor = edit("**bold|**");
    type(editor, " ");
    undo(editor);
    expect(marked(editor)).toBe("**bold|**");
  });
});

describe("Mod+B at a bare caret", () => {
  it("steps out of a run at its end for what is typed next", () => {
    const editor = edit("**bold|**");
    applyFormat(actions, "bold", editor);
    expect(marked(editor)).toBe("**bold**|");
    type(editor, " plain");
    expect(marked(editor)).toBe("**bold** plain|");
  });

  it("steps into a run from just before it", () => {
    const editor = edit("a |**bold**");
    applyFormat(actions, "bold", editor);
    type(editor, "x");
    expect(marked(editor)).toBe("a **x|bold**");
  });

  it("takes a run off with the caret inside it, between its words, as without the switch", () => {
    const editor = edit("**big |deal**");
    applyFormat(actions, "bold", editor);
    expect(marked(editor)).toBe("big |deal");
  });

  it("opens a run for what is typed next outside any word, and closes it again", () => {
    const editor = edit("a |");
    applyFormat(actions, "bold", editor);
    expect(marked(editor)).toBe("a |");
    expect(actions.marks.find((action) => action.id === "bold")?.isOn?.(editor.state)).toBe(true);
    type(editor, "big deal");
    expect(marked(editor)).toBe("a **big deal|**");
    const cancelled = edit("a |");
    applyFormat(actions, "bold", cancelled);
    applyFormat(actions, "bold", cancelled);
    type(cancelled, "x");
    expect(marked(cancelled)).toBe("a x|");
  });
});

describe("copying", () => {
  it("gives a run the selection cuts into the marks it lacks", () => {
    const editor = edit("a **bo«ld** c»");
    const filters = editor.state.facet(EditorView.clipboardOutputFilter);
    const text = editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to);
    expect(filters.reduce((out, filter) => filter(out, editor.state), text)).toBe("**ld** c");
  });
});

describe("with the switch off", () => {
  it("leaves the caret, the keys and typing as they were", () => {
    hideFormatSyntax.set(false);
    const editor = edit("a |**bold** c");
    expect(shown(editor)).toEqual(["a **bold** c"]);
    press(editor, "ArrowRight");
    expect(marked(editor)).toBe("a *|*bold** c");
    expect(click(editor, 4)).toBe("a **|bold** c");
  });
});
