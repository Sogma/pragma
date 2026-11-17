// What a screenplay's Format column, the palette and their keys do to its
// text: a mark put on words or taken off them, a comment written or taken
// off, and a line turned into another kind. Each writes plain Fountain where
// the text allows it and a forcing mark only where it doesn't, reading every
// line as the editor draws it.
import {
  type ChangeSet,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type StateEffect,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fountainToken, isForcedSceneHeading } from "../../../src/protocol/fountainElements.ts";
import { openedMarks, toggleAtCaret } from "../../hiddenSyntax.ts";
import type { FormatAction, FormatActions } from "../../services/formats.ts";
import {
  findInlineRanges,
  fountainLine,
  lineForcingMarks,
  lineOpened,
  linkTarget,
  MARKS_OF,
  multiLineNotes,
  NOTE_CLASS,
} from "./language.ts";

const FORMAT_EVENT = "input.format";

interface Span {
  from: number;
  to: number;
}

type Mark = "bold" | "italic" | "underline";

const DELIMITER: Record<Mark, string> = { bold: "**", italic: "*", underline: "_" };

// Lines that hold no marks and no kind the column can write: the boneyard
// and the title page, which the tokenizer frames apart, and a page break.
const FIXED = new Set(["fountain-boneyard", "fountain-title-page", "fountain-page-break"]);

function writable(state: EditorState): boolean {
  const { kind } = fountainLine(state, state.doc.lineAt(state.selection.main.head));
  return kind === undefined || !FIXED.has(kind);
}

// A caret counts only strictly inside a span, so one just past its closing
// mark has left it; a selection counts inside it or on its edges.
const holds = (span: Span, from: number, to: number) =>
  from === to ? span.from < from && from < span.to : span.from <= from && to <= span.to;

// Where a line's text runs between the marks that force its kind. A mark or
// a comment goes only there: around a forcing mark, it would leave the mark
// no longer first or last on the line, and the line no longer its kind.
function textOf(state: EditorState, line: Line): Span {
  const start = line.text.length - line.text.trimStart().length;
  let from = line.from;
  let to = line.to;
  for (const mark of lineForcingMarks(state, line)) {
    if (mark.from === start) from = line.from + mark.to;
    else to = line.from + mark.from;
  }
  return { from, to };
}

// A range kept to that text: a caret moved onto it; a selection past its
// first line's opening mark and, ending on that line, before its closing one.
function offForcing(state: EditorState, range: Span): Span {
  const line = state.doc.lineAt(range.from);
  const text = textOf(state, line);
  if (range.from === range.to) {
    const at = Math.min(Math.max(range.from, text.from), text.to);
    return { from: at, to: at };
  }
  const from = Math.max(range.from, text.from);
  const to = range.to <= line.to ? Math.max(from, Math.min(range.to, text.to)) : range.to;
  return { from, to };
}

// A line's marks and one-line notes, in the document's positions. A note is
// a comment unless it is a link note.
function inlineOn(line: Line) {
  return findInlineRanges(line.text).map((range) => {
    const note = range.className === NOTE_CLASS;
    const link = note && linkTarget(line.text.slice(range.from, range.to)) !== undefined;
    return {
      from: line.from + range.from,
      to: line.from + range.to,
      marker: range.marker,
      marks: MARKS_OF[range.className] ?? [],
      note,
      comment: note && !link,
      link,
    };
  });
}

// The link note a range is in. Comment leaves one alone: it is no comment,
// and brackets opened inside it would end it early.
function linkAround(state: EditorState, range: Span) {
  return inlineOn(state.doc.lineAt(range.from)).find((each) => each.link && holds(each, range.from, range.to));
}

// A range carried through `changes`, kept on the text it covered: its
// start after anything inserted there, its end before.
function carried(range: SelectionRange, changes: ChangeSet): SelectionRange {
  if (range.empty) return EditorSelection.cursor(changes.mapPos(range.head, 1));
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  return range.head === range.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}'’]/u.test(c);

// The word a caret is in, from letters, digits and apostrophes, so a mark's
// own `_` or `*` is never part of it.
function wordAt(line: Line, pos: number): Span | undefined {
  let from = pos - line.from;
  let to = from;
  while (isWordChar(line.text[from - 1])) from--;
  while (isWordChar(line.text[to])) to++;
  return from < to ? { from: line.from + from, to: line.from + to } : undefined;
}

// What a mark goes around: for a caret, its word; else the selection on
// each line it touches, without its outer spaces or forcing marks. Bold or
// italic inside a run of the other takes the whole run, as the editor draws
// no star mark inside another.
function markTargets(state: EditorState, range: SelectionRange, mark: Mark): Span[] {
  const line = state.doc.lineAt(range.head);
  if (range.empty) {
    const { from: head } = offForcing(state, range);
    const target = wordAt(line, head) ?? { from: head, to: head };
    return [widenToStarRun(line, target, mark)];
  }
  const targets: Span[] = [];
  for (let number = state.doc.lineAt(range.from).number; number <= state.doc.lineAt(range.to).number; number++) {
    const each = state.doc.line(number);
    const text = textOf(state, each);
    let from = Math.max(range.from, text.from);
    let to = Math.min(range.to, text.to);
    while (from < to && /\s/.test(state.doc.sliceString(from, from + 1))) from++;
    while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to--;
    if (from < to) targets.push(widenToStarRun(each, { from, to }, mark));
  }
  return targets;
}

function widenToStarRun(line: Line, target: Span, mark: Mark): Span {
  if (mark === "underline" || target.from === target.to) return target;
  const run = inlineOn(line).find(
    (each) => each.marks.length && !each.marks.includes("underline") && holds(each, target.from, target.to),
  );
  if (!run) return target;
  const inner = { from: run.from + run.marker, to: run.to - run.marker };
  return inner.from === target.from && inner.to === target.to ? target : inner;
}

// The run of `mark` a range is in, or on the edges of, its forcing marks
// left out; none for a range over several lines.
function markAround(state: EditorState, range: Span, mark: Mark) {
  const { from, to } = offForcing(state, range);
  const line = state.doc.lineAt(from);
  if (line.number !== state.doc.lineAt(to).number) return undefined;
  return inlineOn(line).find((each) => each.marks.includes(mark) && holds(each, from, to));
}

function toggleMark(mark: Mark): (view: EditorView) => void {
  return (view) => {
    if (toggleAtCaret(view, mark, { open: DELIMITER[mark], close: DELIMITER[mark] })) return;
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const on = markAround(state, range, mark);
      if (on) {
        // Off a bold italic run, the other mark stays on it.
        const keep = on.marker === 3 ? (mark === "bold" ? "*" : "**") : "";
        const changes = state.changes([
          { from: on.from, to: on.from + on.marker, insert: keep },
          { from: on.to - on.marker, to: on.to, insert: keep },
        ]);
        return { changes, range: carried(range, changes) };
      }
      const targets = markTargets(state, range, mark);
      if (!targets.length) return { range };
      const delimiter = DELIMITER[mark];
      const changes = state.changes(
        targets.flatMap(({ from, to }) => [
          { from, insert: delimiter },
          { from: to, insert: delimiter },
        ]),
      );
      const [first] = targets;
      // A caret between new delimiters goes between them, to type into; one
      // in a word keeps its place in it, at the word's end too.
      if (range.empty) {
        const { from: head } = offForcing(state, range);
        const at = first.from === first.to ? head + delimiter.length : changes.mapPos(head, head === first.to ? -1 : 1);
        return { changes, range: EditorSelection.cursor(at) };
      }
      const from = changes.mapPos(first.from, 1);
      const to = changes.mapPos(targets[targets.length - 1].to, -1);
      return {
        changes,
        range: range.head === range.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to),
      };
    });
    view.dispatch(spec, { userEvent: FORMAT_EVENT, scrollIntoView: true });
  };
}

// Takes both delimiters off every mark the selection touches, so none is
// left half closed, or off the marks a caret is in.
function clearMarks(view: EditorView): void {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let number = state.doc.lineAt(range.from).number; number <= state.doc.lineAt(range.to).number; number++) {
      for (const each of inlineOn(state.doc.line(number))) {
        if (each.note || seen.has(each.from)) continue;
        const touched = range.empty
          ? each.from < range.head && range.head < each.to
          : each.to > range.from && each.from < range.to;
        if (!touched) continue;
        seen.add(each.from);
        changes.push({ from: each.from, to: each.from + each.marker }, { from: each.to - each.marker, to: each.to });
      }
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: FORMAT_EVENT });
}

// The comment holding a range, on one line or over several, its forcing
// marks left out.
function commentAround(state: EditorState, range: Span): Span | undefined {
  const { from, to } = offForcing(state, range);
  const oneLine = inlineOn(state.doc.lineAt(from)).find((each) => each.comment && holds(each, from, to));
  return oneLine ?? multiLineNotes(state.doc).find((note) => holds(note, from, to));
}

const COMMENT_MARKS = { open: "[[", close: "]]" };

// In a comment, takes its brackets off. A caret elsewhere opens an empty one
// to type into; a selection is wrapped, each run of lines between empty
// ones in a comment of its own, as a comment never spans an empty line.
// Each opens after its first line's forcing mark and, ending on that line,
// closes before its closing one.
function toggleComment(view: EditorView): void {
  const { state } = view;
  if (!linkAround(state, state.selection.main) && toggleAtCaret(view, "comment", COMMENT_MARKS, true)) return;
  const spec = state.changeByRange((range) => {
    if (linkAround(state, range)) return { range };
    const comment = commentAround(state, range);
    if (comment) {
      const changes = state.changes([
        { from: comment.from, to: comment.from + 2 },
        { from: comment.to - 2, to: comment.to },
      ]);
      return { changes, range: carried(range, changes) };
    }
    if (range.empty) {
      const { from: at } = offForcing(state, range);
      const changes = state.changes({ from: at, insert: "[[]]" });
      return { changes, range: EditorSelection.cursor(at + 2) };
    }
    const runs: Span[] = [];
    let run: Span | undefined;
    for (let number = state.doc.lineAt(range.from).number; number <= state.doc.lineAt(range.to).number; number++) {
      const line = state.doc.line(number);
      if (!line.text.trim()) {
        run = undefined;
        continue;
      }
      const from = Math.max(range.from, line.from);
      const to = Math.min(range.to, line.to);
      if (from >= to) continue;
      if (run) {
        run.to = to;
        continue;
      }
      run = { from, to };
      runs.push(run);
    }
    const targets = runs
      .map((run) => {
        const { from, to } = offForcing(state, run);
        const text = state.doc.sliceString(from, to);
        return { from: from + (text.length - text.trimStart().length), to: to - (text.length - text.trimEnd().length) };
      })
      .filter(({ from, to }) => from < to);
    if (!targets.length) return { range };
    const changes = state.changes(
      targets.flatMap(({ from, to }) => [
        { from, insert: "[[" },
        { from: to, insert: "]]" },
      ]),
    );
    const from = changes.mapPos(targets[0].from, 1);
    const to = changes.mapPos(targets[targets.length - 1].to, -1);
    return { changes, range: EditorSelection.range(from, to) };
  });
  view.dispatch(spec, { userEvent: FORMAT_EVENT, scrollIntoView: true });
}

function markAction(id: Mark, label: string, key: string): FormatAction {
  return {
    id,
    label,
    glyph: id,
    group: "marks",
    key,
    applies: writable,
    isOn: (state) =>
      markAround(state, state.selection.main, id) !== undefined || openedMarks(state).includes(DELIMITER[id]),
    run: toggleMark(id),
  };
}

type Kind =
  | "action"
  | "sceneHeading"
  | "character"
  | "parenthetical"
  | "dialogue"
  | "transition"
  | "centered"
  | "synopsis";

const KIND_OF: Record<string, Kind> = {
  "fountain-action": "action",
  "fountain-scene-heading": "sceneHeading",
  "fountain-character": "character",
  "fountain-character-dual": "character",
  "fountain-parenthetical": "parenthetical",
  "fountain-dialogue": "dialogue",
  "fountain-transition": "transition",
  "fountain-centered": "centered",
  "fountain-synopsis": "synopsis",
};

const SPEECH_TOKENS = new Set([
  "fountain-character",
  "fountain-character-dual",
  "fountain-parenthetical",
  "fountain-dialogue",
]);

// The kind a line is drawn as: action for an empty one, none for a section.
function kindOf(state: EditorState, line: Line): Kind | undefined {
  const { kind } = fountainLine(state, line);
  if (kind === undefined) return line.text === "" ? "action" : undefined;
  return KIND_OF[kind];
}

const currentKind = (state: EditorState) => kindOf(state, state.doc.lineAt(state.selection.main.head));

function inSpeech(state: EditorState): boolean {
  const kind = currentKind(state);
  return writable(state) && (kind === "dialogue" || kind === "parenthetical");
}

// The kind `text` would be drawn as on a line: after an empty line or not,
// a speech running into it or not, and an empty line after it or not.
function readsAs(text: string, afterBlank: boolean, speech: boolean, blankAfter: boolean): Kind | undefined {
  const { token } = fountainToken(text.trim(), afterBlank, !afterBlank && speech);
  const cue = token === "fountain-character" || token === "fountain-character-dual";
  return KIND_OF[cue && blankAfter ? "fountain-action" : token];
}

// The text of a line without the marks that make it its kind.
function unforced(text: string, tag: string | undefined): string {
  let core = text.trim();
  if (tag === "fountain-character-dual") core = core.replace(/\s*\^$/, "");
  if (tag === "fountain-section") return core.replace(/^#+\s*/, "");
  if (core.length > 1 && core.startsWith(">") && core.endsWith("<")) return core.slice(1, -1).trim();
  if (core.startsWith(">") || core.startsWith("!") || core.startsWith("@")) return core.slice(1).trim();
  if (isForcedSceneHeading(core)) return core.slice(1).trim();
  if (core.startsWith("=") && !/^={3,}$/.test(core)) return core.slice(1).trim();
  return core;
}

interface LineEdit {
  change: ChangeSpec;
  // A blank line put above it, a line opened under it.
  above: boolean;
  opened: boolean;
  // Where its text starts, before and after: the old one a position in the
  // document, the new one an offset into the line written.
  oldCoreAt: number;
  coreAt: number;
  coreLength: number;
  lineLength: number;
}

// What turning `line` into `kind` writes: plain Fountain where its text
// allows it, a forcing mark where it doesn't, a blank line above where the
// kind needs one, and under a name with nothing to say a line for it.
function lineEdit(state: EditorState, line: Line, kind: Kind): LineEdit | undefined {
  const { kind: tag } = fountainLine(state, line);
  if (tag !== undefined && FIXED.has(tag)) return undefined;
  const current = tag === undefined ? "action" : KIND_OF[tag];
  const speech = current === "dialogue" || current === "parenthetical";
  if (kind === "dialogue" || (kind === "parenthetical" && !speech)) return undefined;

  const indent = line.text.slice(0, line.text.length - line.text.trimStart().length);
  let core = unforced(line.text, tag);
  if (current === "parenthetical") core = core.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : undefined;
  const afterBlank = !prev || prev.text === "";
  const prevToken = prev && !afterBlank ? fountainLine(state, prev).token : undefined;
  const speechAbove = prevToken !== undefined && SPEECH_TOKENS.has(prevToken);
  const blankAfter = line.number === state.doc.lines || state.doc.line(line.number + 1).text === "";

  let above = false;
  let opened = false;
  let prefix = "";
  let text = core;
  let suffix = "";
  switch (kind) {
    case "action":
      above = speech && !afterBlank;
      if (readsAs(core, afterBlank || above, speechAbove, blankAfter) !== "action") prefix = "!";
      break;
    case "parenthetical":
      prefix = "(";
      suffix = ")";
      break;
    case "sceneHeading":
      above = !afterBlank;
      if (readsAs(core, true, false, blankAfter) !== "sceneHeading") prefix = ".";
      break;
    case "character":
      above = !afterBlank;
      opened = blankAfter;
      if (readsAs(core.toUpperCase(), true, false, false) === "character") text = core.toUpperCase();
      else prefix = "@";
      break;
    case "transition":
      above = !afterBlank;
      if (readsAs(core.toUpperCase(), true, false, blankAfter) === "transition") text = core.toUpperCase();
      else prefix = "> ";
      break;
    case "centered":
      above = speech && !afterBlank;
      prefix = "> ";
      suffix = " <";
      break;
    case "synopsis":
      prefix = "= ";
      break;
  }
  const written = `${indent}${prefix}${text}${suffix}`;
  if (!above && !opened && written === line.text) return undefined;
  return {
    change: { from: line.from, to: line.to, insert: `${above ? "\n" : ""}${written}${opened ? "\n" : ""}` },
    above,
    opened,
    oldCoreAt: line.from + indent.length + Math.max(0, line.text.trimStart().indexOf(core)),
    coreAt: indent.length + prefix.length,
    coreLength: core.length,
    lineLength: written.length,
  };
}

// The lines the selection touches, in order. A selection dragged through a
// line's end stops at the next line's start, a line it doesn't touch, and
// empty lines among several stay as they are.
function touchedLines(state: EditorState): Line[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(end).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) numbers.add(number);
  }
  const lines = [...numbers].sort((a, b) => a - b).map((number) => state.doc.line(number));
  return lines.length > 1 ? lines.filter((line) => line.text !== "") : lines;
}

// Turns every line the selection touches into `kind`. A caret keeps its
// place in its line's text, or goes to the line opened under a name.
function setKind(kind: Kind): (view: EditorView) => void {
  return (view) => {
    const { state } = view;
    const edits = touchedLines(state).flatMap((line) => {
      const edit = lineEdit(state, line, kind);
      return edit ? [{ line, edit }] : [];
    });
    if (!edits.length) return;
    const changes = state.changes(edits.map(({ edit }) => edit.change));
    const main = state.selection.main;
    const own =
      edits.length === 1 && edits[0].line.number === state.doc.lineAt(main.head).number ? edits[0] : undefined;
    let selection: EditorSelection;
    let effects: StateEffect<unknown>[] = [];
    if (own && main.empty) {
      const start = changes.mapPos(own.line.from, -1) + (own.edit.above ? 1 : 0);
      const at = own.edit.opened
        ? start + own.edit.lineLength + 1
        : start + own.edit.coreAt + Math.max(0, Math.min(main.head - own.edit.oldCoreAt, own.edit.coreLength));
      selection = EditorSelection.single(at);
      if (own.edit.opened) effects = [lineOpened.of({ at, kind: "dialogue" })];
    } else {
      const first = edits[0];
      const last = edits[edits.length - 1];
      selection = EditorSelection.single(
        changes.mapPos(first.line.from, -1) + (first.edit.above ? 1 : 0),
        changes.mapPos(last.line.to, 1) - (last.edit.opened ? 1 : 0),
      );
    }
    view.dispatch({ changes, selection, effects, userEvent: FORMAT_EVENT, scrollIntoView: true });
  };
}

function lineAction(
  id: Kind,
  label: string,
  glyph: string,
  group: string,
  options: { more?: boolean; unlistedKind?: boolean; applies?: (state: EditorState) => boolean } = {},
): FormatAction {
  return {
    id,
    label,
    glyph,
    group,
    more: options.more,
    unlistedKind: options.unlistedKind,
    applies: options.applies ?? writable,
    isOn: (state) => currentKind(state) === id,
    run: setKind(id),
  };
}

const SCENE_HEADING = lineAction("sceneHeading", "Scene heading", "clapperboard", "kind", { more: true });
const ACTION = lineAction("action", "Action", "pilcrow", "kind", { more: true });
const CHARACTER = lineAction("character", "Character", "user", "kind", { more: true });
const TRANSITION = lineAction("transition", "Transition", "arrow-right-to-line", "kind", { more: true });
// A kind of line, though the column and the picker's menu group it with the
// marks, as style.
const CENTERED = lineAction("centered", "Centered", "text-align-center", "marks", { unlistedKind: true });
const SYNOPSIS = lineAction("synopsis", "Synopsis", "description", "unprinted", { unlistedKind: true });

const BOLD = markAction("bold", "Bold", "Mod+B");
const ITALIC = markAction("italic", "Italic", "Mod+I");
const UNDERLINE = markAction("underline", "Underline", "Mod+U");
const CLEAR_FORMATTING: FormatAction = {
  id: "clearFormatting",
  label: "Clear formatting",
  glyph: "eraser",
  group: "marks",
  last: true,
  applies: writable,
  run: clearMarks,
};
const NOTE: FormatAction = {
  id: "comment",
  label: "Script note",
  glyph: "sticky-note",
  group: "unprinted",
  applies: (state) => writable(state) && !linkAround(state, state.selection.main),
  isOn: (state) =>
    commentAround(state, state.selection.main) !== undefined || openedMarks(state).includes(COMMENT_MARKS.open),
  run: toggleComment,
};

/** What a screenplay's Format column offers. */
export const screenplayActions: FormatActions = {
  plain: ACTION,
  lines: [
    SCENE_HEADING,
    ACTION,
    CHARACTER,
    // Typing makes these two under a name, so the picker leaves them out:
    // any line there is dialogue, and one opening with ( a parenthetical.
    // Dialogue is never something to turn a line into; Parenthetical wraps
    // one only inside a speech.
    lineAction("dialogue", "Dialogue", "message-circle", "kind", { applies: () => false, unlistedKind: true }),
    lineAction("parenthetical", "Parenthetical", "parentheses", "kind", { applies: inSpeech, unlistedKind: true }),
    TRANSITION,
    CENTERED,
    SYNOPSIS,
  ],
  marks: [BOLD, ITALIC, UNDERLINE, CLEAR_FORMATTING, NOTE],
  // Style, then what never prints, then the picker's kinds.
  tools: [
    BOLD,
    ITALIC,
    UNDERLINE,
    CENTERED,
    SYNOPSIS,
    NOTE,
    SCENE_HEADING,
    ACTION,
    CHARACTER,
    TRANSITION,
    CLEAR_FORMATTING,
  ],
};
