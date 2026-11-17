// How Return and Tab write a screenplay, so the writer never types the blank
// lines Fountain reads its elements by. Return at the end of an element
// leaves the blank line the next one needs, and under a cue or a
// parenthetical goes straight to the dialogue line; Shift+Return breaks a
// line inside a speech. Tab starts a cue, offering the script's names.
import {
  acceptCompletion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Line, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { sceneNumber } from "../../../src/protocol/fountainSceneNumber.ts";
import { screenplayActions } from "./actions.ts";
import {
  findInlineRanges,
  fountainLanguage,
  fountainLine,
  lineOpened,
  multiLineNotes,
  NOTE_CLASS,
  openedLine,
} from "./language.ts";

const CUES = new Set(["fountain-character", "fountain-character-dual"]);
// Dialogue goes under these with no blank line between.
const LEADS_INTO_DIALOGUE = new Set([...CUES, "fountain-parenthetical"]);
const SPEECH = new Set([...LEADS_INTO_DIALOGUE, "fountain-dialogue"]);
// Their lines run on with no blank between, so Return leaves them as written.
const AS_WRITTEN = new Set(["fountain-title-page", "fountain-boneyard"]);

// What may follow the caret at the end of a line's text: the marks closing
// it, which the formatted view can hide, so a caret before a parenthetical's
// `)` or a dual cue's `^` still ends the line and Return never splits them.
// So may a heading's scene number, which the margins can hold.
const CLOSING = /^[\s*_)<^]*$/;

function closes(state: EditorState, line: Line, head: number): boolean {
  const at = head - line.from;
  const number = sceneNumber(line.text);
  const rest =
    number && at <= number.from && fountainLine(state, line).kind === "fountain-scene-heading"
      ? line.text.slice(at, number.from) + line.text.slice(number.to)
      : line.text.slice(at);
  return CLOSING.test(rest);
}

function insideNote(state: EditorState, line: Line, head: number): boolean {
  const at = head - line.from;
  const notes = findInlineRanges(line.text).filter((range) => range.className === NOTE_CLASS);
  return (
    notes.some((note) => note.from < at && at < note.to) ||
    multiLineNotes(state.doc).some((note) => note.from < head && head < note.to)
  );
}

// The line a lone caret ends the text of, in a screenplay that can be
// edited. A note never holds an empty line, so a caret in one ends none.
function endedLine(state: EditorState): Line | undefined {
  const { main, ranges } = state.selection;
  if (state.readOnly || ranges.length > 1 || !main.empty) return undefined;
  const line = state.doc.lineAt(main.head);
  if (!line.text.trim() || !closes(state, line, main.head)) return undefined;
  return insideNote(state, line, main.head) ? undefined : line;
}

function breakAfter(view: EditorView, line: Line, breaks: string, dialogue: boolean): boolean {
  const at = line.to + breaks.length;
  view.dispatch({
    changes: { from: line.to, insert: breaks },
    selection: { anchor: at },
    effects: dialogue ? lineOpened.of({ at, kind: "dialogue" }) : [],
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

// Return: a blank line after an element that ends here, so what's typed next
// reads as an element of its own; one line break where the element runs on
// below, into its dialogue, or into a song's next lyric. An empty line, or a
// caret inside the text, gets CodeMirror's own.
function newElement(view: EditorView): boolean {
  const { state } = view;
  const line = endedLine(state);
  const token = line && fountainLine(state, line).token;
  if (!line || token === undefined || AS_WRITTEN.has(token)) return false;
  const runsOn = line.number < state.doc.lines && state.doc.line(line.number + 1).text !== "";
  const lyric = line.text.trimStart().startsWith("~");
  const single = runsOn || lyric || LEADS_INTO_DIALOGUE.has(token);
  return breakAfter(view, line, single ? "\n" : "\n\n", single && SPEECH.has(token));
}

function speechLineBreak(view: EditorView): boolean {
  const line = endedLine(view.state);
  const token = line && fountainLine(view.state, line).token;
  return line !== undefined && token !== undefined && SPEECH.has(token) && breakAfter(view, line, "\n", true);
}

const CHARACTER = screenplayActions.lines.find((action) => action.id === "character");

// Tab: takes the name the list offers while it's open, or does nothing
// there, never moving focus out of the page. On an empty line it starts a
// cue, with the empty line above that a cue needs; after a name typed on a
// line of its own, it makes that line the cue, as the Format column's
// Character does. Anywhere else it leaves the key alone.
function startCue(view: EditorView): boolean {
  const { state } = view;
  if (completionStatus(state) === "active") {
    acceptCompletion(view);
    return true;
  }
  const { main, ranges } = state.selection;
  if (state.readOnly || ranges.length > 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  const above = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  if (line.text === "") {
    const at = line.from + (above ? 1 : 0);
    view.dispatch({
      changes: above ? { from: line.from, insert: "\n" } : [],
      selection: { anchor: at },
      effects: lineOpened.of({ at, kind: "character" }),
      scrollIntoView: true,
      userEvent: "input",
    });
    startCompletion(view);
    return true;
  }
  const below = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
  if (above || below || endedLine(state)?.from !== line.from) return false;
  if (!CHARACTER || fountainLine(state, line).kind !== "fountain-action") return false;
  CHARACTER.run(view);
  return true;
}

// A line opened for a cue takes what's typed in capitals, as a cue is
// written, unless a leading `@` forces one that keeps its case.
const capitals = EditorView.inputHandler.of((view, from, to, text) => {
  const opened = view.state.field(openedLine, false);
  const line = view.state.doc.lineAt(from);
  if (view.composing || opened?.kind !== "character" || line.from !== opened.at) return false;
  const upper = text.toUpperCase();
  if (upper === text || line.text.trimStart().startsWith("@")) return false;
  view.dispatch({
    changes: { from, to, insert: upper },
    selection: { anchor: from + upper.length },
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

// A cue's name, without its forcing `@`, a dual cue's `^`, notes, and the
// extensions after it, such as (V.O.).
function cueName(text: string): string {
  let name = text.replace(/\[\[.*?\]\]/g, "").trim();
  if (name.endsWith("^")) name = name.slice(0, -1).trimEnd();
  if (name.startsWith("@")) name = name.slice(1).trimStart();
  return name.replace(/(\s*\([^)]*\))+$/, "").trim();
}

// The names the script's cues give, but the cue on line `here`: those above
// it latest first, the speaker before last ahead of the last, as the likelier
// to answer; then those only further down. A cue with nothing under it is
// action.
function cueNames(state: EditorState, here: number): string[] {
  const { doc } = state;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const above = new Map<string, number>();
  const below = new Set<string>();
  tree.iterate({
    enter(node) {
      if (!CUES.has(node.name)) return;
      const line = doc.lineAt(node.from);
      const spoken = line.number < doc.lines && doc.line(line.number + 1).text !== "";
      const name = cueName(line.text);
      if (line.number === here || !spoken || !name) return;
      if (line.number > here) below.add(name);
      else {
        above.delete(name);
        above.set(name, line.number);
      }
    },
  });
  const latest = [...above.keys()].reverse();
  if (latest.length > 1) latest.unshift(...latest.splice(1, 1));
  return [...latest, ...[...below].filter((name) => !above.has(name))];
}

/** The names a cue can take while one is typed: on a line opened for a cue,
 * or where a cue can go once what's typed there is in capitals. A name
 * typed whole closes the list, or Return after BOB would pick BOBBY. */
export function cueNameSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  if (state.sliceDoc(pos, line.to).trim()) return null;
  const opened = state.field(openedLine, false);
  let from = line.from + (line.text.length - line.text.trimStart().length);
  let typed = state.sliceDoc(from, pos);
  const forced = typed.startsWith("@");
  if (forced) {
    from += 1;
    typed = typed.slice(1);
  }
  const forCue = opened?.kind === "character" && opened.at === line.from;
  const atCue = line.number === 1 || state.doc.line(line.number - 1).text === "";
  const capitals = /\p{L}/u.test(typed) && typed === typed.toUpperCase();
  if (!forCue && !(atCue && (forced || capitals))) return null;
  const names = cueNames(state, line.number);
  if (names.includes(typed)) return null;
  const options = names
    .filter((name) => name.toUpperCase().startsWith(typed.toUpperCase()))
    .map((name) => ({ label: name, apply: !forced && /\p{Ll}/u.test(name) ? `@${name}` : name }));
  return options.length ? { from, options, filter: false } : null;
}

/** Return, Shift+Return and Tab as a screenplay is written, the capitals a
 * cue is typed in, and the names one is offered. */
export function screenplayTyping(): Extension {
  return [
    Prec.high(
      keymap.of([
        { key: "Enter", run: newElement, shift: speechLineBreak },
        { key: "Tab", run: startCue },
      ]),
    ),
    capitals,
    fountainLanguage.data.of({ autocomplete: cueNameSource }),
  ];
}
