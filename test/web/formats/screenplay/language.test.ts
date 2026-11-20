// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fountain,
  fountainFormatting,
  numberRoomMeasured,
  screenplayWorldLinks,
} from "../../../../web/formats/screenplay/language.ts";
import { hideFormatSyntax } from "../../../../web/services/settings.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";

polyfillRangeRects();

// The syntax the selection shows, with Hide format syntax off; its rules
// with the switch on are hiddenSyntax.test.ts's.
beforeEach(() => hideFormatSyntax.set(false));
afterEach(() => hideFormatSyntax.set(true));

// The whole-document count behind Links, over the same syntax tree the
// editor draws from.
const WORLD: Record<string, string> = { lina: "world/Lina.md", "the thing": "world/The Thing.md" };
const resolve = (name: string) => WORLD[name.toLowerCase()];

function linksIn(doc: string) {
  return screenplayWorldLinks(EditorState.create({ doc, extensions: fountain() }), resolve);
}

// Where `name` sits in `doc`, after the first `after`.
function at(doc: string, after: string, name: string) {
  const from = doc.indexOf(name, doc.indexOf(after) + after.length);
  return { from, to: from + name.length };
}

describe("screenplayWorldLinks", () => {
  it("counts every mention and where it is, in order of first mention", () => {
    const doc = "INT. LAB - NIGHT\n\nTHE THING waits. LINA enters.\n\nLINA\nIs it awake?\n\nLINA (V.O.)\nIt is.\n";
    expect(linksIn(doc)).toEqual([
      { path: "world/The Thing.md", count: 1, mentions: [at(doc, "", "THE THING")] },
      {
        path: "world/Lina.md",
        count: 3,
        mentions: [at(doc, "waits. ", "LINA"), at(doc, "enters.", "LINA"), at(doc, "awake?", "LINA")],
      },
    ]);
  });

  it("reads a cue with nothing under it as action, and never reads dialogue", () => {
    const doc = "LINA\n\nTHE THING\nLINA and THE THING, said aloud.\n";
    expect(linksIn(doc)).toEqual([
      { path: "world/Lina.md", count: 1, mentions: [at(doc, "", "LINA")] },
      { path: "world/The Thing.md", count: 1, mentions: [at(doc, "", "THE THING")] },
    ]);
  });

  it("reads past the first screen of a long script", () => {
    const doc = `${"Snow falls.\n\n".repeat(2000)}LINA arrives.\n`;
    expect(linksIn(doc)).toEqual([{ path: "world/Lina.md", count: 1, mentions: [at(doc, "", "LINA")] }]);
  });
});

// Each line's kind as the tokenizer names it, "" for a line it leaves bare.
function kinds(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: fountain() });
  const names: string[] = Array.from({ length: state.doc.lines }, () => "");
  ensureSyntaxTree(state, state.doc.length, 1000)?.iterate({
    enter(node) {
      if (node.name.startsWith("fountain-")) names[state.doc.lineAt(node.from).number - 1] = node.name.slice(9);
    },
  });
  return names;
}

describe("the tokenizer", () => {
  it("keeps a dialogue block across a line of two spaces, and ends it at an empty line", () => {
    expect(kinds("LINA\nFirst.\n  \nStill talking.\n\nSnow falls.")).toEqual([
      "character",
      "dialogue",
      "dialogue",
      "dialogue",
      "",
      "action",
    ]);
  });

  it("takes a line of spaces for content, not the blank line a scene heading needs", () => {
    expect(kinds("Snow falls.\n  \nINT. ROOM - DAY")).toEqual(["action", "action", "action"]);
  });

  it("keeps the title page going through a line of spaces, as a screenplay's description does", () => {
    expect(kinds("Title: Big Fish\n  \n= Still the title page\n\n= A synopsis")).toEqual([
      "title-page",
      "title-page",
      "title-page",
      "",
      "synopsis",
    ]);
  });
});

// The lines reading view draws, as the reader sees them.
function shownLines(view: EditorView): string[] {
  return [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "");
}

function reading(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [fountain(), EditorView.editable.of(false)] });
  const view = new EditorView({ state, parent: document.body });
  const lines = shownLines(view);
  view.destroy();
  return lines;
}

describe("notes in reading view", () => {
  it("hides a note inside a line, with one space beside it", () => {
    expect(reading("He opens the door [[check blocking]] and leaves.")).toEqual(["He opens the door and leaves."]);
    expect(reading("[[one]] [[two]] Snow falls.")).toEqual(["Snow falls."]);
    expect(reading("A door[[x]].")).toEqual(["A door."]);
  });

  it("hides a note with emphasis in it, or inside emphasis", () => {
    expect(reading("Snow. [[He *really* waits]] Go.")).toEqual(["Snow. Go."]);
    expect(reading("*He waits [[now]] alone.*")).toEqual(["He waits alone."]);
  });

  it("drops a paragraph of notes, and one blank line with it", () => {
    expect(reading("Snow falls.\n\n[[fix this]]\n[[and this]]\n\nLINA\nHi.")).toEqual([
      "Snow falls.",
      "",
      "LINA",
      "Hi.",
    ]);
  });

  it("takes no blank line for a note inside a paragraph", () => {
    expect(reading("LINA\n[[whisper]]\nHi.\n\nSnow falls.")).toEqual(["LINA", "Hi.", "", "Snow falls."]);
  });

  it("takes the blank on the far side of a note at either end of the script", () => {
    expect(reading("[[draft 3]]\n\nSnow falls.")).toEqual(["Snow falls."]);
    expect(reading("Snow falls.\n\n[[the end?]]")).toEqual(["Snow falls."]);
  });

  it("keeps blank lines the writer typed", () => {
    expect(reading("Snow falls.\n\n[[fix]]\n\n\nLINA\nHi.")).toEqual(["Snow falls.", "", "", "LINA", "Hi."]);
  });

  it("drops a note over several lines whole, and one blank line with it", () => {
    expect(reading("Snow falls.\n\n[[Ask Lina about\n= the ending\nbefore Friday]]\n\nLINA\nHi.")).toEqual([
      "Snow falls.",
      "",
      "LINA",
      "Hi.",
    ]);
  });

  it("hides what a note over several lines covers of its first and last lines, with one space beside it", () => {
    expect(reading("He opens the door [[check the\nblocking here]] and leaves.")).toEqual([
      "He opens the door",
      "and leaves.",
    ]);
  });

  it("shows notes again for editing", () => {
    const lock = new Compartment();
    const doc = "Snow falls. [[cold?]]\n\n[[fix]]\n\nLINA\nHi.";
    const state = EditorState.create({ doc, extensions: [fountain(), lock.of(EditorView.editable.of(false))] });
    const view = new EditorView({ state, parent: document.body });
    expect(shownLines(view)).toEqual(["Snow falls.", "", "LINA", "Hi."]);
    view.dispatch({ effects: lock.reconfigure(EditorView.editable.of(true)) });
    expect(shownLines(view)).toEqual(doc.split("\n"));
    view.destroy();
  });
});

// Each line's kind and the note text it shades, while editing.
function editing(doc: string) {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: fountain() }), parent: document.body });
  const lines = [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => ({
    kind: [...line.classList].find((name) => name.startsWith("cm-fountain-")),
    notes: [...line.querySelectorAll(".cm-fountain-note")].map((note) => note.textContent),
  }));
  view.destroy();
  return lines;
}

describe("a note over several lines while editing", () => {
  it("shades the note on each line, and keeps the kind of the line it opened on, a `=` inside it included", () => {
    expect(editing("Snow falls. [[Ask Lina about\n= the ending\nbefore Friday]] She goes.")).toEqual([
      { kind: "cm-fountain-action", notes: ["[[Ask Lina about"] },
      { kind: "cm-fountain-action", notes: ["= the ending"] },
      { kind: "cm-fountain-action", notes: ["before Friday]]"] },
    ]);
  });

  it("links no name inside the note", () => {
    const doc = "LINA waits. [[ask LINA\nabout THE THING]] THE THING stays.\n";
    expect(linksIn(doc)).toEqual([
      { path: "world/Lina.md", count: 1, mentions: [at(doc, "", "LINA")] },
      { path: "world/The Thing.md", count: 1, mentions: [at(doc, "]] ", "THE THING")] },
    ]);
  });
});

describe("synopses in reading view", () => {
  it("drops a synopsis paragraph, and one blank line with it", () => {
    expect(reading("= The whole file.\n\nEXT. SNOW - DAY\n\n= A door opens.\n\nSnow falls.")).toEqual([
      "EXT. SNOW - DAY",
      "",
      "Snow falls.",
    ]);
  });

  it("takes no blank line for a synopsis written under a scene heading", () => {
    expect(reading("EXT. SNOW - DAY\n= A door opens.\n\nSnow falls.")).toEqual(["EXT. SNOW - DAY", "", "Snow falls."]);
  });
});

// The lines Source mode draws: the screenplay with no formatting.
function source(doc: string): string[] {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: fountain() }), parent: document.body });
  const lines = shownLines(view);
  view.destroy();
  return lines;
}

// The lines the formatted view draws, the syntax it shows faint and the
// hint of each link glyph. With a `cursor` the editor has focus and the
// selection sits there; without one, no selection counts.
function formatted(doc: string, cursor?: number): { lines: string[]; faint: string[]; links: string[] } {
  const state = EditorState.create({ doc, extensions: [fountain(), fountainFormatting()] });
  const view = new EditorView({ state, parent: document.body });
  if (cursor !== undefined) {
    // jsdom never gives the editor focus.
    Object.defineProperty(view, "hasFocus", { get: () => true });
    view.dispatch({ selection: { anchor: cursor } });
  }
  const lines = shownLines(view);
  const faint = [...view.contentDOM.querySelectorAll(".cm-shown-syntax")].map((node) => node.textContent ?? "");
  const links = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-fountain-link-note")].map(
    (icon) => icon.dataset.tooltip ?? "",
  );
  view.destroy();
  return { lines, faint, links };
}

describe("the marks that force a line's kind", () => {
  const SCRIPT = [
    ".THE CELLAR STAIRS",
    "",
    "!BOOM. The door gives.",
    "",
    "@McCLANE",
    "Yippee.",
    "",
    "BRICK ^",
    "Hi.",
    "",
    "> Smash cut.",
    "",
    ">  THE END  <",
  ].join("\n");
  const PRINTED = [
    "THE CELLAR STAIRS",
    "",
    "BOOM. The door gives.",
    "",
    "McCLANE",
    "Yippee.",
    "",
    "BRICK",
    "Hi.",
    "",
    "Smash cut.",
    "",
    "THE END",
  ];

  it("are hidden in reading view, with the spaces that set them off", () => {
    expect(reading(SCRIPT)).toEqual(PRINTED);
  });

  it("are hidden in the formatted view, and show faint on a line the selection touches", () => {
    expect(formatted(SCRIPT).lines).toEqual(PRINTED);
    const { lines, faint } = formatted(SCRIPT, SCRIPT.indexOf("Smash"));
    expect(lines).toEqual(PRINTED.map((line, index) => (index === 10 ? "> Smash cut." : line)));
    expect(faint).toEqual(["> "]);
  });

  it("show as written in Source mode", () => {
    expect(source(SCRIPT)).toEqual(SCRIPT.split("\n"));
  });

  it("stay text inside a note over several lines", () => {
    expect(formatted("Snow falls. [[ask her\n!loudly]]").lines).toEqual(["Snow falls. ask her", "!loudly"]);
  });
});

describe("the formatted view", () => {
  it("hides emphasis marks except where the selection touches them, drawn faint there", () => {
    const doc = "He **roars** and *hisses*.";
    expect(formatted(doc).lines).toEqual(["He roars and hisses."]);
    const { lines, faint } = formatted(doc, doc.indexOf("roars") + 2);
    expect(lines).toEqual(["He **roars** and hisses."]);
    expect(faint).toEqual(["**", "**"]);
  });

  it("hides a note's brackets and a synopsis's `=`, keeping sections and the boneyard as written", () => {
    const doc = "# ACT ONE\n\n= Mara finds the door.\n\nSnow falls. [[colder?]]\n\n/* cut\nthis */";
    expect(formatted(doc).lines).toEqual([
      "# ACT ONE",
      "",
      "Mara finds the door.",
      "",
      "Snow falls. colder?",
      "",
      "/* cut",
      "this */",
    ]);
  });

  it("shows a note's brackets where the selection touches the note, and a synopsis's `=` on its line, faint", () => {
    const doc = "= Mara finds the door.\n\nSnow falls. [[colder?]]";
    const inNote = formatted(doc, doc.indexOf("colder"));
    expect(inNote.lines).toEqual(["Mara finds the door.", "", "Snow falls. [[colder?]]"]);
    expect(inNote.faint).toEqual(["[[", "]]"]);
    const onSynopsis = formatted(doc, doc.indexOf("finds"));
    expect(onSynopsis.lines).toEqual(["= Mara finds the door.", "", "Snow falls. colder?"]);
    expect(onSynopsis.faint).toEqual(["= "]);
  });

  it("shows both brackets of a note over several lines where the selection touches any of it", () => {
    const doc = "Snow falls. [[Ask Lina about\nthe ending]] She goes.";
    expect(formatted(doc).lines).toEqual(["Snow falls. Ask Lina about", "the ending She goes."]);
    const { lines, faint } = formatted(doc, doc.indexOf("ending"));
    expect(lines).toEqual(doc.split("\n"));
    expect(faint).toEqual(["[[", "]]"]);
  });

  it("keeps the marks of a note or synopsis with nothing in it, so it still shows", () => {
    const doc = "Snow falls. [[]] [[ ]]\n\n=\n\nRain.";
    expect(formatted(doc).lines).toEqual(doc.split("\n"));
  });

  it("draws a link note as a glyph, its target the hint, and as written, faint, where the selection touches it", () => {
    const doc = "INT. CARGO HOLD - DAY [[>sid_k3x9m2q7v1pa]]";
    expect(formatted(doc)).toEqual({ lines: ["INT. CARGO HOLD - DAY "], faint: [], links: ["sid_k3x9m2q7v1pa"] });
    expect(formatted(doc, doc.indexOf("k3x"))).toEqual({ lines: [doc], faint: ["[[>sid_k3x9m2q7v1pa]]"], links: [] });
    expect(source(doc)).toEqual([doc]);
    expect(reading(doc)).toEqual(["INT. CARGO HOLD - DAY"]);
  });

  it("keeps a link note's text out of a heading's capitals, as written and in Source mode", () => {
    const doc = "INT. CARGO HOLD - DAY [[>sid_k3x9m2q7v1pa]]";
    for (const extensions of [fountain(), [fountain(), fountainFormatting()]]) {
      const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
      Object.defineProperty(view, "hasFocus", { get: () => true });
      view.dispatch({ selection: { anchor: doc.indexOf("k3x") } });
      const kept = [...view.contentDOM.querySelectorAll(".cm-fountain-link-text")].map((node) => node.textContent);
      expect(kept.join("")).toBe("[[>sid_k3x9m2q7v1pa]]");
      view.destroy();
    }
  });

  it("reads no emphasis in a link note's target, and draws a note with nothing after the `>` as a comment", () => {
    expect(formatted("Snow falls. [[>shot_2_final]]").links).toEqual(["shot_2_final"]);
    expect(formatted("Snow falls. [[>]]")).toEqual({ lines: ["Snow falls. >"], faint: [], links: [] });
  });

  it("copies a note the selection cuts into without its brackets, and a whole one with them, with Hide format syntax on", () => {
    hideFormatSyntax.set(true);
    const doc = "Snow falls. [[colder now?]] She goes.";
    const copied = (from: number, to: number) => {
      const extensions = [fountain(), fountainFormatting()];
      const state = EditorState.create({ doc, selection: { anchor: from, head: to }, extensions });
      ensureSyntaxTree(state, doc.length);
      const filters = state.facet(EditorView.clipboardOutputFilter);
      return filters.reduce((out, filter) => filter(out, state), state.sliceDoc(from, to));
    };
    expect(copied(doc.indexOf("now?"), doc.indexOf(" goes"))).toBe("now? She");
    expect(copied(doc.indexOf("colder"), doc.indexOf("]]"))).toBe("[[colder now?]]");
  });
});

// The lines a view draws, each one's margin number ("" for none), the
// numbers it shows as written and the syntax it shows faint. A `cursor`
// focuses the editor there; a `room` is the characters of number the margins
// were measured to hold.
function numbered(doc: string, extensions: Extension, cursor?: number, room?: number) {
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  if (room !== undefined) view.dispatch({ effects: numberRoomMeasured.of(room) });
  if (cursor !== undefined) {
    Object.defineProperty(view, "hasFocus", { get: () => true });
    view.dispatch({ selection: { anchor: cursor } });
  }
  const lines = shownLines(view);
  const margins = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].map(
    (line) => line.dataset.sceneNumber ?? "",
  );
  const kept = [...view.contentDOM.querySelectorAll(".cm-fountain-scene-number")].map((node) => node.textContent);
  const faint = [...view.contentDOM.querySelectorAll(".cm-shown-syntax")].map((node) => node.textContent);
  view.destroy();
  return { lines, margins, kept, faint };
}

describe("a scene heading's number", () => {
  const doc = "EXT. RUNWAY - DAY #110a#\n\nSnow falls. #4#";
  const READING = [fountain(), EditorView.editable.of(false)];
  const FORMATTED = [fountain(), fountainFormatting()];

  it("leaves the text with the blank before it, for both margins, in reading view and the formatted view", () => {
    for (const extensions of [READING, FORMATTED]) {
      expect(numbered(doc, extensions)).toMatchObject({
        lines: ["EXT. RUNWAY - DAY", "", "Snow falls. #4#"],
        margins: ["110a", "", ""],
        kept: [],
      });
    }
  });

  it("takes only the one blank before it, so a blank typed at the end of what shows stays in view", () => {
    expect(numbered("EXT. RUNWAY - DAY  #110a#", FORMATTED).lines).toEqual(["EXT. RUNWAY - DAY "]);
  });

  it("stays in its line, faint, where the margins can't hold it", () => {
    for (const extensions of [READING, FORMATTED]) {
      expect(numbered(doc, extensions, undefined, 3)).toMatchObject({
        lines: doc.split("\n"),
        margins: ["", "", ""],
        kept: ["#110a#"],
        faint: ["#110a#"],
      });
      expect(numbered(doc, extensions, undefined, 4).margins).toEqual(["110a", "", ""]);
    }
  });

  it("shows as written, faint and in its own case, where the selection touches it, the margins kept", () => {
    expect(numbered(doc, FORMATTED, doc.indexOf("110a"))).toMatchObject({
      lines: doc.split("\n"),
      margins: ["110a", "", ""],
      kept: ["#110a#"],
      faint: ["#110a#"],
    });
    expect(numbered(doc, FORMATTED, doc.indexOf(" #110a#")).lines[0]).toBe("EXT. RUNWAY - DAY");
  });

  it("shows where the selection touches it with Hide format syntax on too, as a link note does", () => {
    hideFormatSyntax.set(true);
    expect(numbered(doc, FORMATTED, doc.indexOf("#\n")).lines[0]).toBe("EXT. RUNWAY - DAY #110a#");
  });

  it("stays in the text in Source mode, in its own case, with no margins", () => {
    expect(numbered(doc, fountain())).toMatchObject({
      lines: doc.split("\n"),
      margins: ["", "", ""],
      kept: ["#110a#"],
    });
  });

  it("leaves a note after it to the note's own rules", () => {
    const linked = "INT. CARGO HOLD - LANDED #150# [[>sid_k3x9m2q7v1pa]]";
    expect(numbered(linked, READING)).toMatchObject({ lines: ["INT. CARGO HOLD - LANDED"], margins: ["150"] });
    expect(numbered(linked, FORMATTED)).toMatchObject({ lines: ["INT. CARGO HOLD - LANDED "], margins: ["150"] });
  });

  it("takes a caret that lands at the heading's end to the end of what shows, unless the number shows", () => {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: FORMATTED }), parent: document.body });
    Object.defineProperty(view, "hasFocus", { get: () => true });
    const end = doc.indexOf("\n");
    view.dispatch({ selection: { anchor: end } });
    expect(view.state.selection.main.head).toBe(doc.indexOf(" #110a#"));
    view.dispatch({ selection: { anchor: doc.indexOf("110a") } });
    view.dispatch({ selection: { anchor: end } });
    expect(view.state.selection.main.head).toBe(end);
    view.destroy();

    const source = new EditorView({
      state: EditorState.create({ doc, extensions: fountain() }),
      parent: document.body,
    });
    source.dispatch({ selection: { anchor: end } });
    expect(source.state.selection.main.head).toBe(end);
    source.destroy();
  });

  it("is selected by a press in a margin, which shows it to edit", () => {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: FORMATTED }), parent: document.body });
    Object.defineProperty(view, "hasFocus", { get: () => true });
    const heading = view.contentDOM.querySelector(".cm-line[data-scene-number]");
    // jsdom lays nothing out: every box is empty, so any press is beside it.
    heading?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 40 }));
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe("110a");
    expect(shownLines(view)[0]).toBe("EXT. RUNWAY - DAY #110a#");
    view.destroy();
  });
});

describe("underline", () => {
  it("nests with bold and italic either way round, drawn with them, its marks hidden with theirs", () => {
    const doc = "He **_waits_** and _*hides*_.";
    expect(reading(doc)).toEqual(["He waits and hides."]);
    expect(formatted(doc).lines).toEqual(["He waits and hides."]);
    expect(source(doc)).toEqual([doc]);
    const view = new EditorView({ state: EditorState.create({ doc, extensions: fountain() }), parent: document.body });
    const nested = view.contentDOM.querySelectorAll(
      ".cm-fountain-bold .cm-fountain-underline, .cm-fountain-underline .cm-fountain-italic, .cm-fountain-italic .cm-fountain-underline",
    );
    expect(nested.length).toBeGreaterThan(0);
    expect(view.contentDOM.querySelectorAll(".cm-fountain-underline").length).toBeGreaterThanOrEqual(2);
    view.destroy();
  });
});

describe("a font loading while a screenplay shows", () => {
  it("gives the editor a fresh theme, so CodeMirror measures its lines again, until the editor goes", () => {
    // jsdom has no font set of its own.
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    try {
      const state = EditorState.create({ doc: "Snow falls.", extensions: fountain() });
      const view = new EditorView({ state, parent: document.body });
      const before = view.dom.className;
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(view.dom.className).not.toBe(before);
      view.destroy();
      expect(() => fonts.dispatchEvent(new Event("loadingdone"))).not.toThrow();
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });
});
