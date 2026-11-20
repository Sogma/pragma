// @vitest-environment jsdom
import { defaultKeymap, history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFormat, type FormatActions, type FormatContext } from "../../../../web/services/formats.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

const format = testFormats().get("screenplay");
const actions = format.actions as FormatActions;
const context: FormatContext = {
  path: () => "scene.fountain",
  openPath: vi.fn(),
  searchTag: vi.fn(),
};

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

// A screenplay's editor as the pane builds it, formatted and focused, with
// CodeMirror's own keys below the format's. `|` marks the caret; `marked`
// reads the result back the same way.
function edit(text: string): EditorView {
  const caret = text.indexOf("|");
  const doc = text.replace("|", "");
  const formatting = format.formatting?.(context);
  if (!formatting) throw new Error("the screenplay format has no formatting");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [history(), format.extensions(context), formatting, keymap.of(defaultKeymap)],
  });
  ensureSyntaxTree(state, doc.length);
  const editor = new EditorView({ state, parent: document.body });
  Object.defineProperty(editor, "hasFocus", { get: () => true });
  editor.dispatch({ selection: EditorSelection.cursor(caret) });
  view = editor;
  return editor;
}

function marked(editor: EditorView): string {
  const text = editor.state.doc.toString();
  const { head } = editor.state.selection.main;
  return `${text.slice(0, head)}|${text.slice(head)}`;
}

// What each line shows, hidden syntax left out.
function shown(editor: EditorView): string[] {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "");
}

function press(editor: EditorView, key: string, init: KeyboardEventInit = {}): void {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  runScopeHandlers(editor, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }), "editor");
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

describe("a screenplay with Hide format syntax on", () => {
  it("keeps emphasis, forcing marks, a comment's brackets and a synopsis's `=` hidden at the caret", () => {
    expect(shown(edit("He says **hel|lo** now."))).toEqual(["He says hello now."]);
    expect(shown(edit(".the cel|lar"))).toEqual(["the cellar"]);
    expect(shown(edit("= A sce|ne"))).toEqual(["A scene"]);
    expect(shown(edit("A plan [[no|te]] here."))).toEqual(["A plan note here."]);
  });

  it("still shows a link note as written where the caret touches it", () => {
    expect(shown(edit("See [[>world/Li|na]] now."))).toEqual(["See [[>world/Lina]] now."]);
  });

  it("puts the caret after a line's forcing mark, and before a dual cue's `^`", () => {
    const heading = edit("|.the cellar");
    expect(marked(heading)).toBe(".|the cellar");
    const dual = edit("STEEL\nHi.\n\nBRICK ^\nHello.|");
    expect(click(dual, 18)).toBe("STEEL\nHi.\n\nBRICK| ^\nHello.");
  });

  it("moves over hidden marks a visible character at a time", () => {
    const editor = edit("He **sa|id** it.");
    press(editor, "ArrowRight");
    expect(marked(editor)).toBe("He **sai|d** it.");
    press(editor, "ArrowRight");
    expect(marked(editor)).toBe("He **said|** it.");
    press(editor, "ArrowRight");
    expect(marked(editor)).toBe("He **said** |it.");
  });

  it("takes a forcing mark or a synopsis's `=` with Backspace at the start of the text", () => {
    const heading = edit(".|the cellar");
    press(heading, "Backspace");
    expect(marked(heading)).toBe("|the cellar");
    const synopsis = edit("= |A scene");
    press(synopsis, "Backspace");
    expect(marked(synopsis)).toBe("|A scene");
  });

  it("takes a comment's brackets with its last character", () => {
    const editor = edit("A plan [[n|]] here.");
    press(editor, "Backspace");
    expect(marked(editor)).toBe("A plan | here.");
  });

  it("keeps a blank typed at a run's end inside it, as Fountain reads one there", () => {
    const editor = edit("**bold|**");
    type(editor, " x");
    expect(marked(editor)).toBe("**bold x|**");
  });

  it("closes and reopens emphasis a line break splits, which Fountain never carries over", () => {
    const editor = edit("He **sa|id** it.");
    press(editor, "Enter");
    expect(marked(editor)).toBe("He **sa**\n**|id** it.");
  });

  it("steps out of bold with Mod+B at its end, and opens a comment for what is typed next", () => {
    const bold = edit("**bold|**");
    applyFormat(actions, "bold", bold);
    type(bold, " plain");
    expect(marked(bold)).toBe("**bold** plain|");
    const comment = edit("A plan |");
    applyFormat(actions, "comment", comment);
    expect(actions.marks.find((action) => action.id === "comment")?.isOn?.(comment.state)).toBe(true);
    type(comment, "note");
    expect(marked(comment)).toBe("A plan [[note|]]");
  });
});
