// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { applyBrightSelection, selectedTextMark } from "../../../web/lib/selection.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

// A format's mark over "code", as inline code's is.
const codeSpan = EditorView.decorations.of(Decoration.set(Decoration.mark({ class: "code" }).range(6, 10)));

describe("selectedTextMark", () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  function mount(selection: EditorSelection): EditorView {
    const extensions = [EditorState.allowMultipleSelections.of(true), codeSpan, selectedTextMark];
    const state = EditorState.create({ doc: "plain code text\nsecond", selection, extensions });
    view = new EditorView({ state, parent: document.body });
    return view;
  }

  const marked = (editor: EditorView) =>
    [...editor.contentDOM.querySelectorAll(".cm-selected-text")].map((span) => span.textContent);

  it("marks the selected text while the editor has no focus", () => {
    const editor = mount(EditorSelection.single(0, 5));
    expect(editor.hasFocus).toBe(false);
    expect(marked(editor)).toEqual(["plain"]);
  });

  it("marks nothing for a cursor", () => {
    expect(marked(mount(EditorSelection.single(3)))).toEqual([]);
  });

  it("marks each selected range, line by line", () => {
    const ranges = [EditorSelection.range(0, 5), EditorSelection.cursor(7), EditorSelection.range(11, 19)];
    expect(marked(mount(EditorSelection.create(ranges)))).toEqual(["plain", "text", "sec"]);
  });

  it("follows the selection", () => {
    const editor = mount(EditorSelection.single(0, 5));
    editor.dispatch({ selection: { anchor: 16, head: 22 } });
    expect(marked(editor)).toEqual(["second"]);
    editor.dispatch({ selection: { anchor: 16 } });
    expect(marked(editor)).toEqual([]);
  });

  it("sits inside a format's mark without splitting it", () => {
    const editor = mount(EditorSelection.single(3, 8));
    const code = [...editor.contentDOM.querySelectorAll(".code")];
    expect(code.map((span) => span.textContent)).toEqual(["code"]);
    expect(marked(editor)).toEqual(["in ", "co"]);
    expect(code[0].querySelector(".cm-selected-text")?.textContent).toBe("co");
  });
});

describe("applyBrightSelection", () => {
  afterEach(() => document.documentElement.classList.remove("bright-selection"));

  it("marks the root while it is on", () => {
    applyBrightSelection(true);
    expect(document.documentElement.classList.contains("bright-selection")).toBe(true);
    applyBrightSelection(false);
    expect(document.documentElement.classList.contains("bright-selection")).toBe(false);
  });
});
