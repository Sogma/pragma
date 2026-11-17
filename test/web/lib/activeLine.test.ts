// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { activeLineHighlight } from "../../../web/lib/activeLine.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

describe("activeLineHighlight", () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  function mount(selection: EditorSelection): EditorView {
    const extensions = [EditorState.allowMultipleSelections.of(true), activeLineHighlight];
    const state = EditorState.create({ doc: "first\nsecond\nthird", selection, extensions });
    view = new EditorView({ state, parent: document.body });
    return view;
  }

  const marked = (editor: EditorView) =>
    [...editor.contentDOM.querySelectorAll(".cm-activeLine")].map((line) => line.textContent);

  it("marks the cursor's line", () => {
    expect(marked(mount(EditorSelection.single(8)))).toEqual(["second"]);
  });

  it("marks nothing while text is selected", () => {
    expect(marked(mount(EditorSelection.single(6, 9)))).toEqual([]);
  });

  it("marks the line again once the selection collapses", () => {
    const editor = mount(EditorSelection.single(6, 9));
    editor.dispatch({ selection: { anchor: 15 } });
    expect(marked(editor)).toEqual(["third"]);
  });

  it("follows the cursor's line through an edit above it", () => {
    const editor = mount(EditorSelection.single(8));
    editor.dispatch({ changes: { from: 0, insert: "zero\n" } });
    expect(marked(editor)).toEqual(["second"]);
  });

  it("marks each cursor's line once", () => {
    const cursors = [EditorSelection.cursor(0), EditorSelection.cursor(3), EditorSelection.cursor(14)];
    expect(marked(mount(EditorSelection.create(cursors)))).toEqual(["first", "third"]);
  });

  it("marks no line while any one range has text selected", () => {
    const ranges = [EditorSelection.cursor(0), EditorSelection.range(13, 16)];
    expect(marked(mount(EditorSelection.create(ranges)))).toEqual([]);
  });
});
