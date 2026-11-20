// @vitest-environment jsdom
import {
  autocompletion,
  CompletionContext,
  type CompletionResult,
  completionStatus,
  currentCompletions,
} from "@codemirror/autocomplete";
import { defaultKeymap, history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fountain, lineOpened } from "../../../../web/formats/screenplay/language.ts";
import { cueNameSource } from "../../../../web/formats/screenplay/typing.ts";
import { applyFormat, type FormatActions, type FormatContext } from "../../../../web/services/formats.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { testFormats } from "../../support/formats.ts";

polyfillRangeRects();

const format = testFormats().get("screenplay");
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
// CodeMirror's own keys and suggester below the format's. `|` marks the
// caret; `marked` reads the result back the same way.
function edit(text: string): EditorView {
  const caret = text.indexOf("|");
  const doc = text.replace("|", "");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [
      history(),
      format.extensions(context),
      format.formatting?.(context) ?? [],
      keymap.of(defaultKeymap),
      autocompletion(),
    ],
  });
  ensureSyntaxTree(state, doc.length);
  const editor = new EditorView({ state, parent: document.body });
  Object.defineProperty(editor, "hasFocus", { get: () => true });
  view = editor;
  return editor;
}

function marked(editor: EditorView): string {
  const text = editor.state.doc.toString();
  const { head } = editor.state.selection.main;
  return `${text.slice(0, head)}|${text.slice(head)}`;
}

// Whether the editor took the key, as the browser's own default is left
// alone when it didn't.
function press(editor: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  ensureSyntaxTree(editor.state, editor.state.doc.length);
  return runScopeHandlers(
    editor,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    "editor",
  );
}

// Typed as the browser types it: through the editor's input handlers first.
function type(editor: EditorView, text: string): void {
  for (const char of text) {
    ensureSyntaxTree(editor.state, editor.state.doc.length);
    const { from, to } = editor.state.selection.main;
    const insert = () => editor.state.update({ ...editor.state.replaceSelection(char), userEvent: "input.type" });
    if (editor.state.facet(EditorView.inputHandler).some((handler) => handler(editor, from, to, char, insert)))
      continue;
    editor.dispatch(insert());
  }
}

// Each line's element as the editor draws it, "" for a line drawn as none.
function drawn(editor: EditorView): string[] {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map(
    (line) => [...line.classList].find((name) => name.startsWith("cm-fountain-"))?.slice(12) ?? "",
  );
}

describe("Return in a screenplay", () => {
  it("leaves a blank line after action, a scene heading and a transition, for the next element", () => {
    for (const line of ["The door opens.", "INT. HOUSE - DAY", "CUT TO:"]) {
      const editor = edit(`Snow.\n\n${line}|`);
      expect(press(editor, "Enter")).toBe(true);
      expect(marked(editor)).toBe(`Snow.\n\n${line}\n\n|`);
    }
  });

  it("goes from a cue straight to its dialogue line, drawn as dialogue under a cue drawn as one", () => {
    const editor = edit("Snow.\n\nBOB|");
    press(editor, "Enter");
    expect(marked(editor)).toBe("Snow.\n\nBOB\n|");
    expect(drawn(editor)).toEqual(["action", "", "character", "dialogue"]);
    type(editor, "Hi.");
    expect(drawn(editor)).toEqual(["action", "", "character", "dialogue"]);
  });

  it("ends a speech with a blank line, and keeps a line inside one in it", () => {
    const ending = edit("BOB\nHi.|");
    press(ending, "Enter");
    expect(marked(ending)).toBe("BOB\nHi.\n\n|");

    const inside = edit("BOB\nHi.|\n(beat)\nBye.");
    press(inside, "Enter");
    expect(marked(inside)).toBe("BOB\nHi.\n|\n(beat)\nBye.");
    type(inside, "So.");
    expect(drawn(inside)).toEqual(["character", "dialogue", "dialogue", "parenthetical", "dialogue"]);
  });

  it("steps past a parenthetical's closing bracket to the dialogue line", () => {
    const editor = edit("BOB\n(quietly|)");
    press(editor, "Enter");
    expect(marked(editor)).toBe("BOB\n(quietly)\n|");
    expect(drawn(editor)).toEqual(["character", "parenthetical", "dialogue"]);
  });

  it("ends a line after the marks closing it, never splitting them off", () => {
    const dual = edit("BRICK| ^");
    press(dual, "Enter");
    expect(marked(dual)).toBe("BRICK ^\n|");

    const centered = edit("> THE END| <");
    press(centered, "Enter");
    expect(marked(centered)).toBe("> THE END <\n\n|");

    const emphasis = edit("He *waits|*");
    press(emphasis, "Enter");
    expect(marked(emphasis)).toBe("He *waits*\n\n|");
  });

  it("ends a scene heading before its number, drawn in the margins, never splitting the number off", () => {
    const heading = edit("Snow.\n\nEXT. RUNWAY - DAY| #110A#");
    press(heading, "Enter");
    expect(marked(heading)).toBe("Snow.\n\nEXT. RUNWAY - DAY #110A#\n\n|");

    const action = edit("Snow falls.| #4#");
    press(action, "Enter");
    expect(marked(action)).toBe("Snow falls.\n|#4#");
  });

  it("keeps a song's next lyric under the last", () => {
    const editor = edit("~Willy Wonka!|");
    press(editor, "Enter");
    expect(marked(editor)).toBe("~Willy Wonka!\n|");
  });

  it("leaves a caret inside the text, an empty line, the title page and a note to CodeMirror's own line break", () => {
    const cases: [string, string][] = [
      ["The door| opens.", "The door\n|opens."],
      ["Snow.\n|", "Snow.\n\n|"],
      ["Title: Big Fish|", "Title: Big Fish\n|"],
      ["He waits. [[ask Ann|]]", "He waits. [[ask Ann\n|]]"],
    ];
    for (const [before, after] of cases) {
      const editor = edit(before);
      press(editor, "Enter");
      expect(marked(editor)).toBe(after);
    }
  });

  it("goes past an empty dialogue line with a second press, leaving the name as action", () => {
    const editor = edit("Snow.\n\nBANG|");
    press(editor, "Enter");
    press(editor, "Enter");
    expect(marked(editor)).toBe("Snow.\n\nBANG\n\n|");
    expect(drawn(editor)).toEqual(["action", "", "action", "", ""]);
  });

  it("draws each line by its text again once the caret leaves", () => {
    const editor = edit("Snow.\n\nBOB|");
    press(editor, "Enter");
    editor.dispatch({ selection: EditorSelection.cursor(0) });
    expect(drawn(editor)).toEqual(["action", "", "action", ""]);
  });
});

describe("Shift+Return in a screenplay", () => {
  it("breaks a line inside a speech, the new line dialogue's", () => {
    const editor = edit("BOB\nHi.|");
    expect(press(editor, "Enter", { shiftKey: true })).toBe(true);
    expect(marked(editor)).toBe("BOB\nHi.\n|");
    expect(drawn(editor)).toEqual(["character", "dialogue", "dialogue"]);
  });

  it("is CodeMirror's own line break anywhere else", () => {
    const editor = edit("The door opens.|");
    press(editor, "Enter", { shiftKey: true });
    expect(marked(editor)).toBe("The door opens.\n|");
  });
});

describe("Tab in a screenplay", () => {
  it("starts a cue on an empty line, drawn as one, and takes what's typed in capitals", () => {
    const editor = edit("Snow.\n\n|");
    expect(press(editor, "Tab")).toBe(true);
    expect(drawn(editor)).toEqual(["action", "", "character"]);
    type(editor, "bob");
    expect(marked(editor)).toBe("Snow.\n\nBOB|");
    expect(drawn(editor)).toEqual(["action", "", "character"]);
    press(editor, "Enter");
    expect(marked(editor)).toBe("Snow.\n\nBOB\n|");
    expect(drawn(editor)).toEqual(["action", "", "character", "dialogue"]);
  });

  it("puts the empty line a cue needs above it", () => {
    const editor = edit("BOB\nHi.\n|");
    press(editor, "Tab");
    expect(marked(editor)).toBe("BOB\nHi.\n\n|");
    expect(drawn(editor)).toEqual(["character", "dialogue", "", "character"]);
  });

  it("keeps the case of a cue forced with `@`", () => {
    const editor = edit("Snow.\n\n|");
    press(editor, "Tab");
    type(editor, "@McClane");
    expect(marked(editor)).toBe("Snow.\n\n@McClane|");
  });

  it("makes a name typed on a line of its own the cue, and goes to its dialogue line", () => {
    const editor = edit("Snow.\n\nbob|");
    expect(press(editor, "Tab")).toBe(true);
    expect(marked(editor)).toBe("Snow.\n\nBOB\n|");
    expect(drawn(editor)).toEqual(["action", "", "character", "dialogue"]);
  });

  it("leaves the key alone inside a speech, a paragraph or a line's text", () => {
    for (const text of ["BOB\nHi.|", "The door opens.\nIt creaks.|", "bo|b"]) {
      const editor = edit(text);
      expect(press(editor, "Tab")).toBe(false);
      expect(marked(editor)).toBe(text);
    }
  });

  it("offers the script's names, and takes the one picked", async () => {
    const editor = edit("ANN\nHi.\n\nBOB\nHey.\n\n|");
    press(editor, "Tab");
    await vi.waitFor(() => expect(completionStatus(editor.state)).toBe("active"));
    expect(currentCompletions(editor.state).map((option) => option.label)).toEqual(["ANN", "BOB"]);
    // CodeMirror takes no pick in the list's first 75ms; Tab is still the page's.
    expect(press(editor, "Tab")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    press(editor, "Tab");
    expect(marked(editor)).toBe("ANN\nHi.\n\nBOB\nHey.\n\nANN|");
  });
});

describe("the Format column's Character", () => {
  it("opens the dialogue line under a name the way Return does", () => {
    const editor = edit("Snow.\n\nbob|");
    expect(applyFormat(format.actions as FormatActions, "character", editor)).toBe(true);
    expect(marked(editor)).toBe("Snow.\n\nBOB\n|");
    expect(drawn(editor)).toEqual(["action", "", "character", "dialogue"]);
  });
});

// The names offered at `|`, on a line opened for a cue unless `typed`.
function offered(text: string, opened = true): CompletionResult | null {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(pos), extensions: fountain() });
  const at = state.doc.lineAt(pos).from;
  if (opened) state = state.update({ effects: lineOpened.of({ at, kind: "character" }) }).state;
  ensureSyntaxTree(state, doc.length);
  return cueNameSource(new CompletionContext(state, pos, false)) as CompletionResult | null;
}

const labels = (result: CompletionResult | null) => result?.options.map((option) => option.label);

describe("the names a cue is offered", () => {
  it("puts the speaker before last first, then the last, the rest latest first, then those further down", () => {
    const script = "ANN\nHi.\n\nCARL\nYo.\n\nBOB\nHey.\n\nCARL\nSo.\n\n|\n\nDAVE\nLater.";
    expect(labels(offered(script))).toEqual(["BOB", "CARL", "ANN", "DAVE"]);
  });

  it("narrows to names starting with what's typed in capitals, and closes on one typed whole", () => {
    const script = "BOB\nHi.\n\nBOBBY\nHey.\n\n";
    expect(labels(offered(`${script}BO|`, false))).toEqual(["BOB", "BOBBY"]);
    expect(offered(`${script}BOB|`, false)).toBeNull();
    expect(labels(offered(`${script}BOBB|`, false))).toEqual(["BOBBY"]);
  });

  it("offers nothing for lower case where no cue was opened, or under another line", () => {
    expect(offered("BOB\nHi.\n\nbo|", false)).toBeNull();
    expect(offered("BOB\nHi.\nBO|", false)).toBeNull();
  });

  it("reads a name without its extension, its `^` or its `@`, and writes a forced one back with its `@`", () => {
    const result = offered("BOB (V.O.)\nHi.\n\n@McCLANE\nYippee.\n\nBRICK ^\nYo.\n\n|");
    expect(labels(result)).toEqual(["McCLANE", "BRICK", "BOB"]);
    expect(result?.options[0].apply).toBe("@McCLANE");
  });

  it("leaves out a cue with nothing under it, which is action", () => {
    expect(labels(offered("BANG\n\nANN\nHi.\n\n|"))).toEqual(["ANN"]);
  });
});
