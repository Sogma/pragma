// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorFlash, flash, flashRange, unflash } from "../../../web/lib/flash.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("flash", () => {
  it("marks an element until its hold and fade are over", () => {
    const row = document.createElement("div");
    flash(row);
    expect(row.classList.contains("flash")).toBe(true);
    vi.advanceTimersByTime(1199);
    expect(row.classList.contains("flash")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(row.classList.contains("flash")).toBe(false);
  });

  it("comes off at once when taken back, and a later flash runs its whole time", () => {
    const row = document.createElement("div");
    flash(row);
    vi.advanceTimersByTime(600);
    unflash(row);
    expect(row.classList.contains("flash")).toBe(false);

    flash(row);
    vi.advanceTimersByTime(1199);
    expect(row.classList.contains("flash")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(row.classList.contains("flash")).toBe(false);
  });

  it("starts over when flashed again before it ends", () => {
    const row = document.createElement("div");
    flash(row);
    vi.advanceTimersByTime(800);
    flash(row);
    vi.advanceTimersByTime(800);
    expect(row.classList.contains("flash")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(row.classList.contains("flash")).toBe(false);
  });
});

describe("editorFlash", () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  function mount(doc: string): EditorView {
    view = new EditorView({ state: EditorState.create({ doc, extensions: [editorFlash] }), parent: document.body });
    return view;
  }

  const flashed = (editor: EditorView) => [...editor.contentDOM.querySelectorAll(".flash")];

  it("marks the range's text, then takes the mark off", () => {
    const editor = mount("one two three");
    editor.dispatch({ effects: flashRange(4, 7) });
    expect(flashed(editor).map((mark) => mark.textContent)).toEqual(["two"]);
    vi.advanceTimersByTime(1200);
    expect(flashed(editor)).toEqual([]);
  });

  it("marks the line when the range is empty", () => {
    const editor = mount("first\nsecond\nthird");
    editor.dispatch({ effects: flashRange(8, 8) });
    const [line] = flashed(editor);
    expect(line.classList.contains("cm-line")).toBe(true);
    expect(line.textContent).toBe("second");
  });

  it("keeps the mark on its text through an edit before it", () => {
    const editor = mount("one two three");
    editor.dispatch({ effects: flashRange(4, 7) });
    editor.dispatch({ changes: { from: 0, insert: "zero " } });
    expect(flashed(editor).map((mark) => mark.textContent)).toEqual(["two"]);
  });

  // A tab's editor state is cached and restored; a mark kept in it would
  // flash again when the tab came back.
  it("leaves nothing in the state for a restored tab to show again", () => {
    const editor = mount("one two three");
    editor.dispatch({ effects: flashRange(4, 7) });
    const cached = editor.state;
    editor.setState(EditorState.create({ doc: "other" }));
    editor.setState(cached);
    expect(flashed(editor)).toEqual([]);
  });
});
