// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

// A screenplay's editor in the Fountain grammar. `|` marks a caret, « and »
// a selection; `shown` marks the result the same way.
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

const action = (id: string) => [...actions.lines, ...actions.marks].find((each) => each.id === id);
const on = (editor: EditorView, id: string) => action(id)?.isOn?.(editor.state) ?? false;
const applies = (editor: EditorView, id: string) => action(id)?.applies?.(editor.state) ?? true;

describe("a screenplay's marks", () => {
  it("wraps the caret's word, keeping the caret's place in it, and takes the mark off again", () => {
    const editor = edit("He wa|its.");
    expect(run(editor, "bold")).toBe("He **wa|its**.");
    expect(on(editor, "bold")).toBe(true);
    expect(run(editor, "bold")).toBe("He wa|its.");
  });

  it("opens an empty pair where the caret is in no word", () => {
    expect(run(edit("He | waits."), "italic")).toBe("He *|* waits.");
  });

  it("wraps a selection on each line it touches", () => {
    expect(run(edit("«One\nTwo»"), "bold")).toBe("**«One**\n**Two»**");
  });

  it("makes bold italic of the other star mark, and leaves it italic when bold comes off", () => {
    const editor = edit("He **wa|its**.");
    expect(run(editor, "italic")).toBe("He ***wa|its***.");
    expect(run(editor, "bold")).toBe("He *wa|its*.");
  });

  it("bolds a whole italic run rather than a word inside it, which the editor couldn't draw", () => {
    expect(run(edit("*it was wa|iting*"), "bold")).toBe("***it was wa|iting***");
  });

  it("nests underline with bold, both drawn", () => {
    const editor = edit("He **wa|its**.");
    expect(run(editor, "underline")).toBe("He **_wa|its_**.");
    expect(on(editor, "underline")).toBe(true);
    expect(on(editor, "bold")).toBe(true);
  });

  it("clears every mark the selection touches, or the caret is in", () => {
    expect(run(edit("«He **roars**, _waits_.»"), "clearFormatting")).toBe("«He roars, waits.»");
    expect(run(edit("**_wa|its_**"), "clearFormatting")).toBe("wa|its");
  });

  it("keeps a line's forcing marks out of a mark, so the line stays its kind", () => {
    expect(run(edit("«.THE CELLAR»"), "bold")).toBe(".**«THE CELLAR»**");
    expect(run(edit("«> THE END <»"), "italic")).toBe("> *«THE END»* <");
    expect(run(edit("«@McCoy\nHello.»"), "underline")).toBe("@_«McCoy_\n_Hello.»_");
    expect(run(edit("|.THE CELLAR"), "bold")).toBe(".**|THE** CELLAR");
  });

  it("takes a mark off a line selected with its forcing mark", () => {
    const editor = edit("«.**THE CELLAR**»");
    expect(on(editor, "bold")).toBe(true);
    expect(run(editor, "bold")).toBe("«.THE CELLAR»");
  });
});

describe("a screenplay's comments", () => {
  it("opens one at a caret, wraps a selection, and takes the brackets off one", () => {
    expect(run(edit("Snow falls.|"), "comment")).toBe("Snow falls.[[|]]");
    expect(run(edit("«Snow falls.»"), "comment")).toBe("[[«Snow falls.»]]");
    const editor = edit("Snow [[col|der]] falls.");
    expect(on(editor, "comment")).toBe(true);
    expect(run(editor, "comment")).toBe("Snow col|der falls.");
  });

  it("wraps each run of lines between empty ones, as a comment never spans one", () => {
    expect(run(edit("«One\n\nTwo»"), "comment")).toBe("[[«One]]\n\n[[Two»]]");
  });

  it("takes the brackets off a comment over several lines", () => {
    expect(run(edit("Snow. [[ask\nher|]] Go."), "comment")).toBe("Snow. ask\nher| Go.");
  });

  it("keeps a line's forcing marks out of a comment, so the line stays its kind", () => {
    expect(run(edit("«> Smash cut.»"), "comment")).toBe("> [[«Smash cut.»]]");
    expect(run(edit("«> THE END <»"), "comment")).toBe("> [[«THE END»]] <");
    expect(run(edit("«!He waits.\nShe doesn't.»"), "comment")).toBe("![[«He waits.\nShe doesn't.»]]");
    expect(run(edit("|> Smash cut."), "comment")).toBe("> [[|]]Smash cut.");
  });

  it("takes the brackets off a comment with emphasis in it", () => {
    expect(run(edit("Snow. [[He *real|ly* waits]]"), "comment")).toBe("Snow. He *real|ly* waits");
  });

  it("leaves a link note alone, as no comment", () => {
    const editor = edit("INT. HOLD [[>sid_k3x|9m2q7v1pa]]");
    expect(on(editor, "comment")).toBe(false);
    expect(applies(editor, "comment")).toBe(false);
    expect(applyFormat(actions, "comment", editor)).toBe(false);
    expect(shown(editor)).toBe("INT. HOLD [[>sid_k3x|9m2q7v1pa]]");
  });

  it("takes the brackets off a line selected with its forcing mark", () => {
    const editor = edit("«> [[Smash cut.]]»");
    expect(on(editor, "comment")).toBe(true);
    expect(run(editor, "comment")).toBe("«> Smash cut.»");
  });

  it("keeps a backward selection's head at its start as a mark or a comment goes on and off", () => {
    for (const id of ["bold", "comment"]) {
      const editor = backward(edit("Snow «falls» hard."));
      run(editor, id);
      expect(headAtStart(editor)).toBe(true);
      expect(run(editor, id)).toBe("Snow «falls» hard.");
      expect(headAtStart(editor)).toBe(true);
    }
  });
});

describe("a screenplay's kinds of line", () => {
  it("adds the blank line a heading needs, and no mark where INT. or EXT. reads as one", () => {
    expect(run(edit("She runs outside.\next. yard| - night"), "sceneHeading")).toBe(
      "She runs outside.\n\next. yard| - night",
    );
  });

  it("forces a heading with a period where the text alone isn't one", () => {
    expect(run(edit("\nThe cellar| stairs\n"), "sceneHeading")).toBe("\n.The cellar| stairs\n");
  });

  it("writes a name in capitals over its dialogue, and opens a line for it where there's none", () => {
    expect(run(edit("\nMa|ra\nWho's there?"), "character")).toBe("\nMA|RA\nWho's there?");
    expect(run(edit("\nMa|ra\n"), "character")).toBe("\nMARA\n|\n");
  });

  it("wraps a line of a speech in parentheses, and offers it only inside one", () => {
    const editor = edit("\nMARA\nquie|tly\nHello?");
    expect(on(editor, "dialogue")).toBe(true);
    expect(run(editor, "parenthetical")).toBe("\nMARA\n(quie|tly)\nHello?");
    const outside = edit("\nSnow fa|lls.");
    expect(applies(outside, "parenthetical")).toBe(false);
    expect(applyFormat(actions, "parenthetical", outside)).toBe(false);
  });

  it("never turns a line into dialogue, which is where a line sits", () => {
    const editor = edit("\nMARA\nHel|lo?");
    expect(applies(editor, "dialogue")).toBe(false);
    expect(applyFormat(actions, "dialogue", editor)).toBe(false);
  });

  it("capitalises a transition ending in TO:, and forces any other", () => {
    // Below the action, as at the top a line ending in a colon is a title page's.
    expect(run(edit("Snow falls.\n\ncut to|:\n"), "transition")).toBe("Snow falls.\n\nCUT TO|:\n");
    expect(run(edit("\nSmash cut|.\n"), "transition")).toBe("\n> Smash cut|.\n");
  });

  it("centers a line and makes one a synopsis", () => {
    expect(run(edit("\nThe E|nd\n"), "centered")).toBe("\n> The E|nd <\n");
    expect(run(edit("\nMara finds| the door.\n"), "synopsis")).toBe("\n= Mara finds| the door.\n");
  });

  it("forces action on a line that would read as something else, and drops a mark it no longer needs", () => {
    expect(run(edit("\nINT. KITCHEN| - NIGHT\n"), "action")).toBe("\n!INT. KITCHEN| - NIGHT\n");
    expect(run(edit("\n.THE CELLAR| STAIRS\n"), "sceneHeading")).toBe("\nTHE CELLAR| STAIRS\n");
  });

  it("ends a speech with a blank line above a line turned into action", () => {
    expect(run(edit("\nMARA\nIt was wai|ting."), "action")).toBe("\nMARA\n\nIt was wai|ting.");
  });

  it("writes the forcing mark on an empty line, for what's typed next", () => {
    expect(run(edit("\n|\n"), "sceneHeading")).toBe("\n.|\n");
  });

  it("changes nothing in the boneyard, where no kind or mark is drawn", () => {
    const editor = edit("/* cut| this */");
    expect(applies(editor, "sceneHeading")).toBe(false);
    expect(applies(editor, "bold")).toBe(false);
    expect(applyFormat(actions, "sceneHeading", editor)).toBe(false);
  });
});
