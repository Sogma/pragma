// A format's text edited with its syntax hidden from the selection too, by
// the Hide format syntax switch, as a rich text editor shows its text. The
// marks stay in the text, so the caret steps over them, an edit keeps a
// run's two marks together, and a run never takes a blank or a line break
// its format would no longer read it as a run with.
//
// A format says where its formatting hides syntax. It leaves out what still
// shows at the caret, such as a link's syntax: typing there would otherwise
// go into text no one sees.
import {
  ChangeSet,
  type ChangeSpec,
  CharCategory,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  findClusterBreak,
  type Line,
  Prec,
  type SelectionRange,
  StateEffect,
  StateField,
  type Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { type Command, EditorView, type KeyBinding, keymap, ViewPlugin } from "@codemirror/view";
import { hideFormatSyntax } from "./services/settings.ts";
import type { Span } from "./shownSyntax.ts";

/** What a run's text may hold and still read as a run: a blank at its
 * start, at its end, anywhere, and a line break. */
export interface RunRules {
  lead: boolean;
  tail: boolean;
  blanks: boolean;
  lines: boolean;
}

/** A run of formatting with its two marks. Runs of a name that meet become
 * one; a mark's toggle finds the runs whose `kinds` hold it, by default
 * their name. */
export interface Run extends Span {
  name: string;
  kinds?: readonly string[];
  open: Span;
  close: Span;
  rules: RunRules;
}

export interface HiddenNear {
  runs: Run[];
  // Each escape: its backslash and the character it escapes.
  escapes: Span[];
  // Marks that end a line's text, with the blanks before them.
  closings: Span[];
}

/** The markers a line's text starts after: where they end, and where the
 * one nearest the text starts, which Backspace at the text's start takes. */
export interface LinePrefix {
  end: number;
  last: number;
}

/** Where a format's formatting hides syntax, none that a proposal's change
 * or a Find match shows: what touches from..to, and a line's markers. */
export interface HiddenSyntax {
  near(state: EditorState, from: number, to: number): HiddenNear;
  prefix(state: EditorState, line: Line): LinePrefix | undefined;
}

const formatSyntax = Facet.define<HiddenSyntax, HiddenSyntax | undefined>({ combine: (values) => values[0] });

/** Whether syntax hides from the selection too: in a formatted view, while
 * the switch is on. */
export function syntaxHidden(state: EditorState): boolean {
  return state.facet(formatSyntax) !== undefined && hideFormatSyntax.get();
}

/** Dispatched when the switch flips, so a format's formatting redraws. */
export const hidingSwitched = StateEffect.define<null>();

// The setting fires its subscriber at once; only later flips are news.
const switchWatcher = ViewPlugin.fromClass(
  class {
    private readonly stop: () => void;
    constructor(view: EditorView) {
      let subscribed = false;
      this.stop = hideFormatSyntax.subscribe(() => {
        if (subscribed) view.dispatch({ effects: hidingSwitched.of(null) });
        subscribed = true;
      });
    }
    destroy() {
      this.stop();
    }
  },
);

const noSyntax: HiddenNear = { runs: [], escapes: [], closings: [] };

const syntaxNear = (state: EditorState, from: number, to: number): HiddenNear =>
  state.facet(formatSyntax)?.near(state, from, to) ?? noSyntax;

const linePrefix = (state: EditorState, line: Line): LinePrefix | undefined =>
  state.facet(formatSyntax)?.prefix(state, line);

/** A mark's two delimiters, as written. */
export interface Delimiters {
  open: string;
  close: string;
}

// What typing at the caret does besides inserting: open runs around the
// text, pull a run's closing marks past it, or type plainly at a caret Mod+B
// put beside a run's marks.
type Typing =
  | { kind: "open"; at: number; marks: readonly Delimiters[] }
  | { kind: "pull"; at: number; from: number; to: number }
  | { kind: "held"; at: number };

const setTyping = StateEffect.define<Typing | null>();

// Lasts until the caret moves or the text changes, unless the change is the
// typing it shaped, which sets it again.
const typing = StateField.define<Typing | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setTyping)) return effect.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
});

/** The marks Mod+B and its kin opened at the caret for what is typed next,
 * by their opening delimiters. */
export function openedMarks(state: EditorState): readonly string[] {
  const current = state.field(typing, false);
  return current?.kind === "open" && current.at === state.selection.main.head
    ? current.marks.map((mark) => mark.open)
    : [];
}

interface Group extends Span {
  // Where an escape's backslash in it starts.
  escape?: number;
}

// The syntax hidden on a line, as groups of pieces that meet: its markers,
// its runs' marks, a heading's closing marks and each escape's backslash.
function hiddenGroups(state: EditorState, line: Line): Group[] {
  const pieces: Group[] = [];
  const prefix = linePrefix(state, line);
  if (prefix) pieces.push({ from: line.from, to: prefix.end });
  const near = syntaxNear(state, line.from, line.to);
  const on = (span: Span) => span.from >= line.from && span.to <= line.to;
  for (const { open, close } of near.runs) pieces.push(...[open, close].filter(on));
  pieces.push(...near.closings.filter(on));
  for (const { from } of near.escapes) if (from >= line.from) pieces.push({ from, to: from + 1, escape: from });
  pieces.sort((a, b) => a.from - b.from);
  const groups: Group[] = [];
  for (const piece of pieces) {
    const last = groups.at(-1);
    if (last && piece.from <= last.to) {
      last.to = Math.max(last.to, piece.to);
      last.escape ??= piece.escape;
    } else groups.push({ ...piece });
  }
  return groups;
}

// Where a caret within hidden syntax sits: before it, so new text takes the
// formatting of the character before, or at a line's start after it, short
// of an escape's backslash, which belongs to the character after it.
function caretSide(group: Group, line: Line): number {
  if (group.from > line.from) return group.from;
  return group.escape ?? group.to;
}

function canonical(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  const group = hiddenGroups(state, line).find((each) => pos >= each.from && pos <= each.to);
  return group ? caretSide(group, line) : pos;
}

// The hidden syntax a step from `pos` crosses before its first visible
// character.
function crossed(state: EditorState, pos: number, forward: boolean): Group | undefined {
  const groups = hiddenGroups(state, state.doc.lineAt(pos));
  return groups.find((group) => (forward ? pos >= group.from && pos < group.to : pos > group.from && pos <= group.to));
}

type Step = (view: EditorView, pos: number, forward: boolean) => number;

// One visible character on, a line break counting as one.
const byChar: Step = ({ state }, pos, forward) => {
  const { doc } = state;
  const line = doc.lineAt(pos);
  const group = crossed(state, pos, forward);
  let at = group ? (forward ? group.to : group.from) : pos;
  if (at === (forward ? line.to : line.from)) {
    if (line.number === (forward ? doc.lines : 1)) return canonical(state, pos);
    at += forward ? 1 : -1;
  } else at = line.from + findClusterBreak(line.text, at - line.from, forward);
  return canonical(state, at);
};

// One group of letters, or of other characters, on past the blanks before
// it, as CodeMirror moves by group, but reading only the visible text: a
// run's hidden marks would otherwise stop it short of the run's first word.
const byGroup: Step = ({ state }, pos, forward) => {
  const categorize = state.charCategorizer(pos);
  let at = pos;
  let kind: CharCategory | undefined;
  for (;;) {
    const group = crossed(state, at, forward);
    if (group) {
      at = forward ? group.to : group.from;
      continue;
    }
    const line = state.doc.lineAt(at);
    if (at === (forward ? line.to : line.from)) {
      if (kind === undefined && line.number !== (forward ? state.doc.lines : 1)) at += forward ? 1 : -1;
      break;
    }
    const next = line.from + findClusterBreak(line.text, at - line.from, forward);
    const category = categorize(state.sliceDoc(Math.min(at, next), Math.max(at, next)));
    if (kind === undefined && category === CharCategory.Space) {
      at = next;
      continue;
    }
    if (kind !== undefined && category !== kind) break;
    kind = category;
    at = next;
  }
  return canonical(state, at);
};

const byLineStart: Step = (view, pos) =>
  canonical(view.state, view.moveToLineBoundary(EditorSelection.cursor(pos), false).head);

function move(step: Step, forward: boolean, extend: boolean): Command {
  return (view) => {
    const { state } = view;
    if (!syntaxHidden(state)) return false;
    const ranges = state.selection.ranges.map((range) => {
      if (!extend && !range.empty) return EditorSelection.cursor(forward ? range.to : range.from);
      const head = step(view, range.head, forward);
      return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
    });
    const selection = EditorSelection.create(ranges, state.selection.mainIndex);
    if (selection.eq(state.selection)) return false;
    view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

function remove(view: EditorView, from: number, to: number, userEvent: string): boolean {
  if (from < to) view.dispatch({ changes: { from, to }, scrollIntoView: true, userEvent });
  return true;
}

// Backspace takes the visible character before the caret, or at the start
// of a line's text the marker nearest it: a heading's here, a list item's,
// a task's or a quote's by the Markdown keys, which see the key first.
const deleteBackward: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!syntaxHidden(state) || state.readOnly || state.selection.ranges.length > 1 || !range.empty) return false;
  const pos = range.head;
  const line = state.doc.lineAt(pos);
  const at = crossed(state, pos, false)?.from ?? pos;
  if (at > line.from)
    return remove(view, line.from + findClusterBreak(line.text, at - line.from, false), at, "delete.backward");
  const prefix = pos > line.from ? linePrefix(state, line) : undefined;
  if (prefix) return remove(view, prefix.last, prefix.end, "delete.backward");
  return line.number === 1 || remove(view, at - 1, at, "delete.backward");
};

// Delete takes the visible character after the caret; at a line's end, the
// line break with the next line's markers, which have no place mid-line.
const deleteForward: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!syntaxHidden(state) || state.readOnly || state.selection.ranges.length > 1 || !range.empty) return false;
  const { doc } = state;
  const line = doc.lineAt(range.head);
  const at = crossed(state, range.head, true)?.to ?? range.head;
  if (at < line.to)
    return remove(view, at, line.from + findClusterBreak(line.text, at - line.from, true), "delete.forward");
  if (line.number === doc.lines) return true;
  const next = doc.line(line.number + 1);
  return remove(view, at, linePrefix(state, next)?.end ?? next.from, "delete.forward");
};

const KEYS: readonly KeyBinding[] = [
  { key: "ArrowLeft", run: move(byChar, false, false), shift: move(byChar, false, true) },
  { key: "ArrowRight", run: move(byChar, true, false), shift: move(byChar, true, true) },
  { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: move(byGroup, false, false), shift: move(byGroup, false, true) },
  { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: move(byGroup, true, false), shift: move(byGroup, true, true) },
  { key: "Home", shift: move(byLineStart, false, true) },
  { mac: "Cmd-ArrowLeft", shift: move(byLineStart, false, true) },
  { key: "Backspace", run: deleteBackward },
  { key: "Delete", run: deleteForward },
];

/** A mark's toggle at a bare caret while syntax hides, as a rich text
 * editor's: at the edge of a run of `kind`, the caret steps over the run's
 * marks, out of it or into it, for what is typed next; outside any word,
 * or anywhere but in a run of it when `anywhere`, the run opens around what
 * is typed next. False leaves the usual rule. */
export function toggleAtCaret(view: EditorView, kind: string, delimiters: Delimiters, anywhere = false): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!syntaxHidden(state) || state.selection.ranges.length > 1 || !range.empty) return false;
  const pos = range.head;
  const current = state.field(typing, false);
  const marks = current?.kind === "open" && current.at === pos ? current.marks : [];
  const opened = marks.some((mark) => mark.open === delimiters.open);
  const place = (at: number, next: Typing | null) =>
    view.dispatch({ selection: EditorSelection.cursor(at), effects: setTyping.of(next) });
  if (!opened) {
    for (const run of syntaxNear(state, pos, pos).runs) {
      if (!(run.kinds ?? [run.name]).includes(kind)) continue;
      const { open, close } = run;
      const across = new Map([
        [close.from, close.to],
        [close.to, close.from],
        [open.to, open.from],
        [open.from, open.to],
      ]).get(pos);
      if (across !== undefined) {
        place(across, { kind: "held", at: across });
        return true;
      }
      // Inside the run, the usual rule takes it off.
      if (run.from < pos && pos < run.to) return false;
    }
    if (!anywhere && state.wordAt(pos)) return false;
  }
  const next = opened ? marks.filter((mark) => mark.open !== delimiters.open) : [...marks, delimiters];
  place(pos, next.length ? { kind: "open", at: pos, marks: next } : null);
  return true;
}

// A caret within hidden syntax goes to the side new text belongs on, unless
// the transaction holds it beside the marks.
function placeCaret(tr: Transaction): Transaction | readonly TransactionSpec[] {
  const selection = tr.selection;
  if (!selection) return tr;
  let held: number | undefined;
  for (const effect of tr.effects) if (effect.is(setTyping) && effect.value?.kind === "held") held = effect.value.at;
  let moved = false;
  const ranges = selection.ranges.map((range) => {
    if (!range.empty || range.head === held) return range;
    const head = canonical(tr.startState, range.head);
    if (head === range.head) return range;
    moved = true;
    return EditorSelection.cursor(head, range.assoc, range.bidiLevel ?? undefined, range.goalColumn);
  });
  if (!moved) return tr;
  return [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }];
}

// Edits typed or deleted by hand, as against a format action's, a
// proposal's, a peer's, undo's or an input method's mid-composition.
function byHand(tr: Transaction): boolean {
  if (tr.isUserEvent("input.type.compose")) return false;
  return (
    tr.isUserEvent("input.type") ||
    tr.isUserEvent("input.paste") ||
    tr.annotation(Transaction.userEvent) === "input" ||
    tr.isUserEvent("delete")
  );
}

function merged(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
}

function without(spans: readonly Span[], holes: readonly Span[]): Span[] {
  let out = [...spans];
  for (const hole of holes) {
    out = out.flatMap((span) => {
      if (hole.to <= span.from || hole.from >= span.to) return [span];
      const parts: Span[] = [];
      if (span.from < hole.from) parts.push({ from: span.from, to: hole.from });
      if (hole.to < span.to) parts.push({ from: hole.to, to: span.to });
      return parts;
    });
  }
  return out;
}

// What a deletion of from..to takes: a run's mark only with its pair, an
// escaped character with its backslash. An insertion there goes where the
// first part taken starts, so it takes the formatting of the text it
// replaces.
function deletion(state: EditorState, from: number, to: number): { parts: Span[]; at: number; changed: boolean } {
  if (from === to) return { parts: [], at: from, changed: false };
  const near = syntaxNear(state, from, to);
  const within = (span: Span) => span.from >= from && span.to <= to;
  const meets = (span: Span) => span.to > from && span.from < to;
  const kept: Span[] = [];
  const added: Span[] = [];
  for (const { open, close } of near.runs) {
    if (within(open) && within(close)) continue;
    for (const mark of [open, close]) if (meets(mark)) kept.push(mark);
  }
  for (const escaped of near.escapes) {
    const slash = { from: escaped.from, to: escaped.from + 1 };
    if (within({ from: slash.to, to: escaped.to }) && !meets(slash)) added.push(slash);
    else if (meets(slash) && !within({ from: slash.to, to: escaped.to })) kept.push(slash);
  }
  if (!kept.length && !added.length) return { parts: [{ from, to }], at: from, changed: false };
  const parts = without(merged([{ from, to }, ...added]), kept);
  return { parts, at: parts[0]?.from ?? from, changed: true };
}

// The closing marks that follow `at` one after another, and the opening
// marks that lead up to it: the runs `at` is at the inner edge of.
function edgeRuns(runs: readonly Run[], at: number): { ends: Run[]; starts: Run[]; end: number; start: number } {
  const ends: Run[] = [];
  const starts: Run[] = [];
  let end = at;
  let start = at;
  for (
    let run = runs.find((each) => each.close.from === end);
    run;
    run = runs.find((each) => each.close.from === end)
  ) {
    ends.push(run);
    end = run.close.to;
  }
  for (let run = runs.find((each) => each.open.to === start); run; run = runs.find((each) => each.open.to === start)) {
    starts.push(run);
    start = run.open.from;
  }
  return { ends, starts, end, start };
}

// Text that ends the runs it lands in: a line break, or a blank in a run
// that holds none. At a run's inner edge it goes outside the run's marks,
// the caret after it when it went past closing ones; inside a run, the run
// closes before it and opens again after it.
function brokenRuns(
  state: EditorState,
  at: number,
  text: string,
): { from: number; insert: string; past: boolean } | undefined {
  const breaks = ({ rules }: Run) => (text.includes("\n") && !rules.lines) || (!rules.blanks && /\s/.test(text));
  const runs = syntaxNear(state, at, at).runs.filter((run) => run.open.to <= at && at <= run.close.from && breaks(run));
  if (!runs.length) return undefined;
  const edges = edgeRuns(runs, at);
  const from = edges.ends.length ? edges.end : edges.starts.length ? edges.start : at;
  const inside = runs
    .filter((run) => !edges.ends.includes(run) && !edges.starts.includes(run))
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const close = inside
    .map((run) => state.sliceDoc(run.close.from, run.close.to))
    .reverse()
    .join("");
  const open = inside.map((run) => state.sliceDoc(run.open.from, run.open.to)).join("");
  return { from, insert: close + text + open, past: edges.ends.length > 0 };
}

// Where a caret just past hidden syntax mid-line goes: before it, as one
// placed there would.
function leftOf(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  const group = hiddenGroups(state, line).find((each) => each.to === pos && each.from > line.from);
  return group ? group.from : pos;
}

interface Typed {
  changes: ChangeSpec[];
  caret: number;
  typing: Typing | null;
}

// Typing at a caret the typing state shapes, positions given in the text
// after it: text inside runs Mod+B opened, a run's closing marks pulled past
// what follows a blank typed at its end, or plain text beside held marks.
function typedAt(state: EditorState, at: number, text: string): Typed | undefined {
  const current = state.field(typing, false);
  if (!current || current.at !== at || text.includes("\n")) return undefined;
  const plain = { changes: [{ from: at, insert: text }], caret: at + text.length };
  if (current.kind === "held") return { ...plain, typing: null };
  if (!/\S/.test(text)) return { ...plain, typing: { ...current, at: at + text.length } };
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const tail = /\s*$/.exec(text)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - tail.length);
  let closing: string;
  let start: number;
  const changes: ChangeSpec[] = [];
  if (current.kind === "open") {
    const opening = current.marks.map((mark) => mark.open).join("");
    closing = current.marks
      .map((mark) => mark.close)
      .reverse()
      .join("");
    start = at + lead.length + opening.length;
    changes.push({ from: at, insert: lead + opening + core + closing + tail });
  } else {
    closing = state.sliceDoc(current.from, current.to);
    start = at - closing.length + lead.length;
    changes.push({ from: current.from, to: current.to }, { from: at, insert: lead + core + closing + tail });
  }
  const from = start + core.length;
  const to = from + closing.length;
  if (!tail) return { changes, caret: from, typing: null };
  return { changes, caret: to + tail.length, typing: { kind: "pull", at: to + tail.length, from, to } };
}

interface Tidied {
  fixes: ChangeSet;
  caret?: number;
  typing?: Typing;
}

// After an edit, the runs it touched read as runs again: one left with no
// text loses its marks, a blank at a flanked run's edge goes outside its
// marks, and two runs of a kind that meet become one. A blank moved out
// from under the caret takes the caret along, and the run's closing marks
// follow what is typed next.
function tidy(state: EditorState, changes: ChangeSet, doc: Text, region: Span, caret?: number): Tidied {
  const mark = (span: Span): Span | undefined => {
    const from = changes.mapPos(span.from, 1);
    const to = changes.mapPos(span.to, -1);
    return to - from === span.to - span.from && doc.sliceString(from, to) === state.sliceDoc(span.from, span.to)
      ? { from, to }
      : undefined;
  };
  const runs = syntaxNear(state, region.from, region.to).runs.flatMap((run) => {
    const open = mark(run.open);
    const close = mark(run.close);
    return open && close && open.to <= close.from ? [{ ...run, open, close }] : [];
  });
  const fixes = new Map<string, ChangeSpec[]>();
  const joined = new Set<Run>();
  for (const run of runs) {
    const next = runs.find(
      (other) =>
        other.name === run.name &&
        other.open.from === run.close.to &&
        doc.sliceString(other.open.from, other.open.to) === doc.sliceString(run.close.from, run.close.to),
    );
    if (!next) continue;
    fixes.set(`join:${run.close.from}`, [{ from: run.close.from, to: next.open.to }]);
    joined.add(run).add(next);
  }
  // Where the caret goes, by a position in `doc` and the side it keeps of
  // what the fixes insert there.
  let place: { at: number; assoc: number; pull?: Span } | undefined;
  for (const run of runs) {
    const text = doc.sliceString(run.open.to, run.close.from);
    const { rules } = run;
    if (!text || (!/\S/.test(text) && !(rules.lead && rules.tail))) {
      if (!joined.has(run)) fixes.set(`empty:${run.open.from}`, [run.open, run.close]);
      continue;
    }
    if (joined.has(run)) continue;
    const lead = rules.lead ? undefined : /^\s+/.exec(text)?.[0];
    if (lead) {
      const { start } = edgeRuns(runs, run.open.to);
      fixes.set(`lead:${start}`, [
        { from: start, insert: lead },
        { from: run.open.to, to: run.open.to + lead.length },
      ]);
      if (caret === run.open.to) place = { at: start, assoc: -1 };
    }
    const tail = rules.tail ? undefined : /\s+$/.exec(text)?.[0];
    if (tail) {
      const { end } = edgeRuns(runs, run.close.from);
      fixes.set(`tail:${end}`, [
        { from: run.close.from - tail.length, to: run.close.from },
        { from: end, insert: tail },
      ]);
      if (caret === run.close.from) place = { at: end, assoc: 1, pull: { from: run.close.from, to: end } };
    }
  }
  const set = ChangeSet.of([...fixes.values()].flat(), doc.length);
  if (!place) return { fixes: set };
  const at = set.mapPos(place.at, place.assoc);
  const { pull } = place;
  return {
    fixes: set,
    caret: at,
    typing: pull && { kind: "pull", at, from: set.mapPos(pull.from, 1), to: set.mapPos(pull.to, -1) },
  };
}

// An edit by hand kept to its format's rules for hidden runs. An edit that
// places its own selection is left as it is.
function keepRuns(tr: Transaction): Transaction | readonly TransactionSpec[] {
  const { startState: state } = tr;
  if (!tr.newSelection.eq(state.selection.map(tr.changes, 1))) return tr;
  const edits: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, text: inserted.toString() }));
  if (!edits.length) return tr;
  const { main, ranges } = state.selection;
  const single = ranges.length === 1 ? main : undefined;
  const lone = edits.length === 1 ? edits[0] : undefined;
  const typed =
    lone && lone.from === lone.to && single?.empty && lone.from === single.head
      ? typedAt(state, lone.from, lone.text)
      : undefined;
  const specs: ChangeSpec[] = typed ? [...typed.changes] : [];
  let changed = typed !== undefined;
  // Each edit's span and where what it inserts went, which the caret follows.
  const landings: (Span & { at: number })[] = [];
  for (const { from, to, text } of typed ? [] : edits) {
    const { parts, at, changed: kept } = deletion(state, from, to);
    specs.push(...parts);
    const broken = text ? brokenRuns(state, at, text) : undefined;
    if (text) specs.push(broken ?? { from: at, insert: text });
    landings.push({ from, to, at: broken?.past ? broken.from : at });
    changed = changed || kept || broken !== undefined;
  }
  const changes = changed ? ChangeSet.of(specs, state.doc.length) : tr.changes;
  const touched: Span[] = [];
  changes.iterChangedRanges((from, to) => touched.push({ from, to }));
  const region = { from: touched[0]?.from ?? edits[0].from, to: touched.at(-1)?.to ?? edits[0].to };
  const doc = changed ? changes.apply(state.doc) : tr.newDoc;
  const land = (range: SelectionRange) => {
    const landing = landings.find((each) => each.from <= range.from && each.to >= range.to);
    return changes.mapPos(landing ? landing.at : range.head, 1);
  };
  let caret = typed ? typed.caret : single && land(single);
  const tidied = tidy(state, changes, doc, region, caret);
  const { fixes } = tidied;
  if (caret !== undefined && !typed && fixes.empty && !edits.some((edit) => edit.text)) caret = leftOf(state, caret);
  const carried = (value: Typing | null | undefined): Typing | null => {
    if (!value) return null;
    const at = fixes.mapPos(value.at, 1);
    if (value.kind !== "pull") return { ...value, at };
    return { ...value, at, from: fixes.mapPos(value.from, 1), to: fixes.mapPos(value.to, -1) };
  };
  const next = tidied.typing ?? carried(typed?.typing);
  if (!changed && fixes.empty && !next && (caret === undefined || caret === tr.newSelection.main.head)) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  const history = tr.annotation(Transaction.addToHistory);
  return [
    {
      changes,
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
      annotations: [
        ...(userEvent === undefined ? [] : [Transaction.userEvent.of(userEvent)]),
        ...(history === undefined ? [] : [Transaction.addToHistory.of(history)]),
      ],
    },
    {
      changes: fixes,
      selection:
        caret === undefined
          ? EditorSelection.create(
              ranges.map((range) => EditorSelection.cursor(fixes.mapPos(land(range), -1))),
              state.selection.mainIndex,
            )
          : EditorSelection.cursor(tidied.caret ?? fixes.mapPos(caret, -1)),
      effects: setTyping.of(next),
      sequential: true,
    },
  ];
}

const rules = EditorState.transactionFilter.of((tr) => {
  if (!syntaxHidden(tr.startState)) return tr;
  if (!tr.docChanged) return placeCaret(tr);
  return byHand(tr) ? keepRuns(tr) : tr;
});

// Copied text keeps each run whole: one the selection starts or ends in
// gets the marks it lacks, so pasting it formats the same text.
function balanced(text: string, state: EditorState): string {
  const { ranges } = state.selection;
  if (!syntaxHidden(state) || ranges.some((range) => range.empty)) return text;
  const slices = ranges.map(({ from, to }) => state.sliceDoc(from, to));
  if (slices.join(state.lineBreak) !== text) return text;
  return ranges
    .map(({ from, to }, index) => {
      let slice = slices[index];
      const near = syntaxNear(state, from, to);
      const has = (span: Span) => span.from >= from && span.to <= to;
      const runs = near.runs
        .filter((run) => Math.max(from, run.open.to) < Math.min(to, run.close.from))
        .sort((a, b) => a.from - b.from || b.to - a.to);
      const open = runs.filter((run) => !has(run.open)).map((run) => state.sliceDoc(run.open.from, run.open.to));
      const close = runs.filter((run) => !has(run.close)).map((run) => state.sliceDoc(run.close.from, run.close.to));
      if (near.escapes.some((escaped) => escaped.from + 1 === to)) slice = slice.slice(0, -1);
      if (near.escapes.some((escaped) => escaped.from + 1 === from)) slice = `\\${slice}`;
      return open.join("") + slice + close.reverse().join("");
    })
    .join(state.lineBreak);
}

/** Editing by the switch's rules, wherever `syntax` says a format's
 * formatting hides syntax. */
export function hiddenSyntax(syntax: HiddenSyntax): Extension {
  return [
    formatSyntax.of(syntax),
    typing,
    rules,
    Prec.high(keymap.of(KEYS)),
    EditorView.clipboardOutputFilter.of(balanced),
    switchWatcher,
  ];
}
