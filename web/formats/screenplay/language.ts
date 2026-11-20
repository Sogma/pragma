// Fountain screenplay language for CodeMirror 6: block-level classification
// via StreamLanguage, inline marks via a ViewPlugin's own regex pass.
// Fountain's `[[...]]` is a Note (see `INLINE_PATTERNS`), never a wikilink.
// The same pass hides the marks Fountain never prints: always in reading
// view, and in the formatted view except where the selection touches them.
import {
  ensureSyntaxTree,
  StreamLanguage,
  type StreamParser,
  type StringStream,
  syntaxTree,
} from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  type Line,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { Tag } from "@lezer/highlight";
import { fountainToken, settledToken } from "../../../src/protocol/fountainElements.ts";
import {
  type FrameState,
  fountainNotes,
  frameLine,
  type NoteSpan,
  startFrame,
} from "../../../src/protocol/fountainLines.ts";
import { type SceneNumber, sceneNumber } from "../../../src/protocol/fountainSceneNumber.ts";
import { synopsisLines } from "../../../src/protocol/fountainSynopsis.ts";
import { findWorldNames, worldNameLine } from "../../../src/protocol/worldNames.ts";
import {
  type HiddenNear,
  type HiddenSyntax,
  hiddenSyntax,
  hidingSwitched,
  type LinePrefix,
  type Run,
  type RunRules,
  syntaxHidden,
} from "../../hiddenSyntax.ts";
import { revealedSpans, shownSpans, shownSpansChanged, syntaxMark } from "../../shownSyntax.ts";

// One custom Tag per Fountain block type. We don't use these for CM6's
// built-in token-coloring (`syntaxHighlighting`/`HighlightStyle`) — only to
// satisfy `StreamParser.tokenTable`, which requires every returned token
// string to resolve to a real Tag before the syntax tree will name a node
// after it. The tag itself is otherwise inert.
const fountainTags = {
  titlePage: Tag.define(),
  section: Tag.define(),
  synopsis: Tag.define(),
  pageBreak: Tag.define(),
  sceneHeading: Tag.define(),
  character: Tag.define(),
  characterDual: Tag.define(),
  dialogue: Tag.define(),
  parenthetical: Tag.define(),
  transition: Tag.define(),
  centered: Tag.define(),
  action: Tag.define(),
  boneyard: Tag.define(),
};

// Every token name returned by `token()` below must have exactly one entry
// here — see the comment on `fountainTags`.
const tokenTable = {
  "fountain-title-page": fountainTags.titlePage,
  "fountain-section": fountainTags.section,
  "fountain-synopsis": fountainTags.synopsis,
  "fountain-page-break": fountainTags.pageBreak,
  "fountain-scene-heading": fountainTags.sceneHeading,
  "fountain-character": fountainTags.character,
  "fountain-character-dual": fountainTags.characterDual,
  "fountain-dialogue": fountainTags.dialogue,
  "fountain-parenthetical": fountainTags.parenthetical,
  "fountain-transition": fountainTags.transition,
  "fountain-centered": fountainTags.centered,
  "fountain-action": fountainTags.action,
  "fountain-boneyard": fountainTags.boneyard,
};

// Every syntax-tree node name this language can ever produce — the
// ViewPlugin below only turns nodes with one of these names into a line
// decoration, ignoring everything else the tree might contain.
const FOUNTAIN_LINE_TAGS = new Set(Object.keys(tokenTable));

// The boneyard, the title page and blank lines are framed by
// src/protocol/fountainLines.ts, as a screenplay's description is; the
// element rules below run on what that frame calls text.
interface FountainState extends FrameState {
  // Several rules ("must be preceded by a blank line") key off whether the
  // line just finished was empty. Treat the very start of the document as
  // if a blank line preceded it, so the first real line can still be a
  // scene heading or character cue.
  previousBlank: boolean;
  // True while inside a dialogue block (a character cue, and every
  // parenthetical/dialogue line directly under it with no blank line
  // between), so plain text there is read as dialogue rather than action.
  inDialogue: boolean;
}

const fountainStreamParser: StreamParser<FountainState> = {
  name: "fountain",
  tokenTable,

  startState(): FountainState {
    return { ...startFrame(), previousBlank: true, inDialogue: false };
  },

  // CodeMirror calls this for an empty line only; a line of spaces reaches
  // the tokenizer, as content.
  blankLine(state) {
    frameLine(state, "");
    state.previousBlank = true;
    state.inDialogue = false;
  },

  token(stream: StringStream, state: FountainState): string | null {
    const line = stream.string;
    stream.skipToEnd();

    // Boneyard short-circuits everything else: a commented-out block can
    // contain text that would otherwise look like a scene heading or
    // character cue. Whole lines only, which over-styles a comment's open
    // and close lines in exchange for never splitting a line into tokens.
    const frame = frameLine(state, line);
    const afterBlank = state.previousBlank;
    state.previousBlank = false;
    if (frame === "boneyard") {
      state.inDialogue = false;
      return "fountain-boneyard";
    }
    if (frame === "title-page") return "fountain-title-page";

    const read = fountainToken(line.trim(), afterBlank, state.inDialogue);
    state.inDialogue = read.inDialogue;
    return read.token;
  },
};

/** The Fountain grammar every screenplay editor shares. */
export const fountainLanguage = StreamLanguage.define(fountainStreamParser);

// Inline emphasis is a regex pass over each line's text, independent of the
// syntax tree — these are mid-line spans, not block types. One source line
// each: Fountain doesn't spec emphasis across a manual line break, and
// spanning one would need boneyard's cross-line state. Order matters:
// `***x***` claims its range before `**`/`*` can partially match inside it.
//
// A single `*` never touches another: matchAll resumes past a skipped
// overlap, so `*, *` read across bold's closing `**` would swallow the next
// italic's opening star. Underline nests with the star marks either way
// round, as Fountain writes `_**bold underline**_`, so never claims on them.
//
// A note claims first, as src/protocol/fountainLines.ts reads one, so no
// emphasis is read in it, a link's target included, though emphasis may hold
// a whole one. Reading view hides a note whole, brackets and text: Fountain
// never prints one, and hiding only its brackets would pass it off as
// script. `marker` is each end's delimiter length, which both views hide.
export const NOTE_CLASS = "cm-fountain-note";
const UNDERLINE_CLASS = "cm-fountain-underline";
const STAR_CLASSES = new Set(["cm-fountain-bold-italic", "cm-fountain-bold", "cm-fountain-italic"]);
const INLINE_PATTERNS: { regex: RegExp; className: string; marker: number }[] = [
  { regex: /\[\[(.*?)\]\]/g, className: NOTE_CLASS, marker: 0 },
  { regex: /\*\*\*([^\s*][^*]*?)\*\*\*/g, className: "cm-fountain-bold-italic", marker: 3 },
  { regex: /\*\*([^\s*][^*]*?)\*\*/g, className: "cm-fountain-bold", marker: 2 },
  { regex: /(?<!\*)\*([^\s*][^*]*?)\*(?!\*)/g, className: "cm-fountain-italic", marker: 1 },
  { regex: /_([^\s_][^_]*?)_/g, className: UNDERLINE_CLASS, marker: 1 },
];

/** The marks a run of emphasis puts on its text, by its class. */
export const MARKS_OF: Readonly<Record<string, readonly string[]>> = {
  "cm-fountain-bold-italic": ["bold", "italic"],
  "cm-fountain-bold": ["bold"],
  "cm-fountain-italic": ["italic"],
  [UNDERLINE_CLASS]: ["underline"],
};

const nests = (a: string, b: string) =>
  (a === UNDERLINE_CLASS && STAR_CLASSES.has(b)) || (b === UNDERLINE_CLASS && STAR_CLASSES.has(a));

/** What a one-line note links to: its text after a leading `>`, if any.
 * Such a note is drawn as a link, never as a comment. */
export function linkTarget(note: string): string | undefined {
  const target = /^\[\[>(.*)\]\]$/.exec(note)?.[1].trim();
  return target || undefined;
}

// Lines already handled some other way don't get scanned for emphasis: a
// boneyard line is commented-out, a title-page line is plain key/value
// metadata, and a page-break has no real text.
const SKIP_INLINE_TAGS = new Set(["fountain-boneyard", "fountain-title-page", "fountain-page-break"]);

export interface InlineRange {
  from: number;
  to: number;
  className: string;
  marker: number;
}

const hiddenMarker = Decoration.replace({});

/** A line's marks and one-line notes, relative to its start. */
export function findInlineRanges(text: string): InlineRange[] {
  const ranges: InlineRange[] = [];
  const overlapsClaimed = (from: number, to: number, className: string) =>
    ranges.some(
      (r) =>
        from < r.to &&
        to > r.from &&
        !nests(className, r.className) &&
        !(r.className === NOTE_CLASS && from < r.from && r.to < to),
    );

  for (const { regex, className, marker } of INLINE_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const from = match.index;
      const to = from + match[0].length;
      if (overlapsClaimed(from, to, className)) continue;
      ranges.push({ from, to, className, marker });
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return ranges;
}

// A note over several lines is found by the protocol's rule, which a line's
// own regex can't apply: it never runs across an empty line. Found once per
// version of the document, for the decorator, reading view and Links alike.
const multiLineNoteCache = new WeakMap<Text, NoteSpan[]>();

export function multiLineNotes(doc: Text): NoteSpan[] {
  let notes = multiLineNoteCache.get(doc);
  if (!notes) {
    notes = fountainNotes(doc.toString()).filter((note) => doc.lineAt(note.from).number !== doc.lineAt(note.to).number);
    multiLineNoteCache.set(doc, notes);
  }
  return notes;
}

interface Span {
  from: number;
  to: number;
}

/** What notes over several lines cover of `line`, relative to its start. */
function noteParts(line: Line, notes: readonly NoteSpan[]): Span[] {
  return notes
    .filter((note) => note.from < line.to && note.to > line.from)
    .map((note) => ({ from: Math.max(note.from, line.from) - line.from, to: Math.min(note.to, line.to) - line.from }));
}

const overlaps = (spans: readonly Span[], from: number, to: number) =>
  spans.some((span) => from < span.to && to > span.from);

// The marks that force a line's kind, each with the spaces that set it off:
// a forced heading's `.`, action's `!` and cue's `@`, a dual cue's `^`, and a
// transition's or centered line's `>` and `<`. Read from the kind the line
// is drawn as, so a mark the line doesn't read as stays text.
function forcingMarks(text: string, tag: string): Span[] {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const lead = (mark: string) => (text[start] === mark ? [{ from: start, to: start + 1 }] : []);
  const opening = () => {
    let to = start + 1;
    while (to < end && text[to] === " ") to++;
    return { from: start, to };
  };
  const closing = (after: number) => {
    let from = end - 1;
    while (from > after && text[from - 1] === " ") from--;
    return { from, to: end };
  };
  switch (tag) {
    case "fountain-scene-heading":
      return lead(".");
    case "fountain-action":
      return lead("!");
    case "fountain-character":
      return lead("@");
    case "fountain-character-dual": {
      const cue = lead("@");
      return [...cue, closing(cue[0]?.to ?? start)];
    }
    case "fountain-transition":
      return text[start] === ">" ? [opening()] : [];
    case "fountain-centered": {
      const open = opening();
      return [open, closing(open.to)];
    }
    default:
      return [];
  }
}

// The brackets of each comment on `line`, relative to its start, with the
// whole comment's span. A comment with nothing in it has none to hide, or
// nothing of it would show.
function commentBrackets(line: Line, doc: Text, comments: readonly Span[]): (Span & { comment: Span })[] {
  const brackets: (Span & { comment: Span })[] = [];
  for (const comment of comments) {
    if (!doc.sliceString(comment.from + 2, comment.to - 2).trim()) continue;
    if (comment.from >= line.from)
      brackets.push({ from: comment.from - line.from, to: comment.from + 2 - line.from, comment });
    if (comment.to <= line.to) brackets.push({ from: comment.to - 2 - line.from, to: comment.to - line.from, comment });
  }
  return brackets;
}

// A synopsis's `=` and the spaces after it; none for a synopsis of nothing.
function synopsisMark(text: string): Span[] {
  const from = text.length - text.trimStart().length;
  let to = from + 1;
  while (to < text.length && text[to] === " ") to++;
  return text.slice(to).trim() ? [{ from, to }] : [];
}

// A scene number with the one blank before it, which leaves the line with
// it. One only: a blank typed at the end of what shows stays in view, or the
// caret after it would sit in hidden text, and what came next would land
// past the number.
function numberWithBlank(text: string, number: SceneNumber): Span {
  const blank = text[number.from - 1] === " " || text[number.from - 1] === "\t";
  return { from: blank ? number.from - 1 : number.from, to: number.to };
}

// One line's hidden spans, joined where they overlap so each character is
// hidden once: the space a note hides with it can be a forcing mark's.
function joined(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
}

function isNoteOnly(text: string, parts: readonly Span[]): boolean {
  const notes = [
    ...parts,
    ...findInlineRanges(text).filter(
      (range) => range.className === NOTE_CLASS && !overlaps(parts, range.from, range.to),
    ),
  ].sort((a, b) => a.from - b.from);
  let rest = "";
  let at = 0;
  for (const note of notes) {
    rest += text.slice(at, note.from);
    at = Math.max(at, note.to);
  }
  return notes.length > 0 && (rest + text.slice(at)).trim() === "";
}

// A synopsis, or a line of nothing but notes, is a paragraph Fountain never
// prints, so reading view drops the line, and one blank line beside it, else
// the blank lines on either side stack into a gap the printed page doesn't
// have. Only that one blank goes: blank lines the writer typed stay.
//
// Hiding a whole line takes a block decoration, which CodeMirror refuses
// from a ViewPlugin, hence a state field beside the decorator below.
function unprintedLineDecorations(state: EditorState): DecorationSet {
  if (state.facet(EditorView.editable)) return Decoration.none;
  const doc = state.doc;
  const synopses = new Set(synopsisLines(doc.toString()).map((line) => line.number));
  const hidden: boolean[] = [];
  let lastShown = 0;
  let lastShownBlank = true; // the document's start reads as a blank line
  let dropped = false;
  const notes = multiLineNotes(doc);
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const blank = line.text === "";
    if (synopses.has(n) || isNoteOnly(line.text, noteParts(line, notes)) || (blank && dropped && lastShownBlank)) {
      hidden[n] = true;
      dropped = !blank;
      continue;
    }
    lastShown = n;
    lastShownBlank = blank;
    dropped = false;
  }
  // Notes ending the document have no blank after them to take.
  if (dropped && lastShownBlank && lastShown > 0) hidden[lastShown] = true;

  const builder = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= doc.lines; n++) {
    if (!hidden[n]) continue;
    const first = n;
    while (hidden[n + 1]) n++;
    builder.add(doc.line(first).from, doc.line(n).to, hiddenLines);
  }
  return builder.finish();
}

const hiddenLines = Decoration.replace({ block: true });

const unprintedLines = StateField.define<DecorationSet>({
  create: unprintedLineDecorations,
  update(decorations, tr) {
    const lockChanged = tr.startState.facet(EditorView.editable) !== tr.state.facet(EditorView.editable);
    return tr.docChanged || lockChanged ? unprintedLineDecorations(tr.state) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Links a screenplay's names to its project's world, by docs/protocol.md's
 * World names rules. */
export interface WorldLinks {
  // Asked on every redraw, so it answers for wherever the file is open now.
  resolver: () => ((name: string) => string | undefined) | undefined;
}

/** Dispatched when the space's files changed, so names re-resolve. */
export const worldNamesChanged = StateEffect.define<null>();

/** Dispatched with how many characters of scene number the page's margins
 * hold, on their narrower side. */
export const numberRoomMeasured = StateEffect.define<number>();

// Until measured, the margins are taken to hold any number. A pane too
// narrow for one keeps it in its heading's line: cut short at the pane's
// edge, it would read as another number.
const numberRoom = StateField.define<number>({
  create: () => Number.POSITIVE_INFINITY,
  update(room, tr) {
    for (const effect of tr.effects) if (effect.is(numberRoomMeasured)) room = effect.value;
    return room;
  },
});

function inMargins(state: EditorState, number: SceneNumber): boolean {
  return number.number.length <= state.field(numberRoom);
}

const worldLinks = Facet.define<WorldLinks, WorldLinks | undefined>({ combine: (values) => values[0] });

// On while the group draws the screenplay formatted, off in its Source mode.
const formattedView = Facet.define<boolean, boolean>({ combine: (values) => values.some((on) => on) });

/** A screenplay drawn formatted while it is edited: the marks reading view
 * hides, hidden except where the selection touches them, or there too while
 * Hide format syntax is on. */
export function fountainFormatting(): Extension {
  return [formattedView.of(true), hiddenSyntax(screenplaySyntax)];
}

function worldLinkMark(path: string): Decoration {
  return Decoration.mark({ class: "cm-fountain-link", attributes: { "data-space-path": path } });
}

// A link note in the formatted view: a glyph, its target in the hint.
// A press goes to the editor, which puts the caret beside the note, and the
// note then shows as written, to edit.
class LinkIcon extends WidgetType {
  constructor(readonly target: string) {
    super();
  }

  eq(other: LinkIcon): boolean {
    return other.target === this.target;
  }

  toDOM(): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "cm-fountain-link-note";
    icon.dataset.tooltip = this.target;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", this.target);
    return icon;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const linkText = Decoration.mark({ class: "cm-fountain-link-text" });
const numberText = Decoration.mark({ class: "cm-fountain-scene-number" });

/** A line a key opened for what is typed next, by its start: a cue's, or
 * dialogue's under one. */
export interface OpenedLine {
  at: number;
  kind: "character" | "dialogue";
}

export const lineOpened = StateEffect.define<OpenedLine>({
  map: (opened, changes) => ({ ...opened, at: changes.mapPos(opened.at, -1) }),
});

// Fountain can't tell a cue from action until dialogue is under it. While
// the caret stays on an opened line, the line is drawn as what it was opened
// for, and a cue over an empty dialogue line stays a cue. Once the caret
// leaves, the text alone says what each line is.
export const openedLine = StateField.define<OpenedLine | null>({
  create: () => null,
  update(value, tr) {
    let next = value && { ...value, at: tr.changes.mapPos(value.at, -1) };
    for (const effect of tr.effects) if (effect.is(lineOpened)) next = effect.value;
    if (!next || !stillOpen(next, tr.newDoc, tr.newSelection.main.head)) return null;
    return value && next.at === value.at && next.kind === value.kind ? value : next;
  },
});

// A cue's line needs an empty line above it; dialogue's, the speech it goes on.
function stillOpen(opened: OpenedLine, doc: Text, head: number): boolean {
  const line = doc.lineAt(opened.at);
  if (line.from !== opened.at || doc.lineAt(head).from !== opened.at) return false;
  const above = line.number > 1 ? doc.line(line.number - 1).text : undefined;
  return opened.kind === "character" ? !above : above !== undefined && above !== "";
}

// An opened line with nothing on it yet has no token to be drawn by.
const openedLineDrawn = EditorView.decorations.compute(["doc", openedLine], (state) => {
  const opened = state.field(openedLine);
  if (!opened || state.doc.lineAt(opened.at).text !== "") return Decoration.none;
  return Decoration.set(Decoration.line({ class: `cm-fountain-${opened.kind}` }).range(opened.at));
});

// A provisional cue (see the tokenizer) with no dialogue under it, because a
// blank line or the document's end follows, is action after all, unless a
// line is open for it or for its dialogue.
function lineTag(name: string, line: Line, doc: Text, opened: OpenedLine | null): string {
  if (opened && opened.at === (opened.kind === "character" ? line.from : line.to + 1)) return name;
  return settledToken(name, line.number < doc.lines ? doc.line(line.number + 1).text : undefined);
}

// A line inside a note over several lines takes the kind of the line the
// note opened on, so a `=` inside the note is no synopsis and what follows
// the note on its last line goes on as that paragraph.
function lineKind(tree: Tree, name: string, line: Line, state: EditorState, notes: readonly NoteSpan[]): string {
  const { doc } = state;
  const opened = state.field(openedLine, false) ?? null;
  const note = notes.find((span) => span.from < line.from && line.from < span.to);
  const opener = note && tree.resolve(note.from, 1);
  if (note && opener && FOUNTAIN_LINE_TAGS.has(opener.name)) {
    return lineTag(opener.name, doc.lineAt(note.from), doc, opened);
  }
  return lineTag(name, line, doc, opened);
}

/** A line's token as the tokenizer gave it, and the kind it is drawn as;
 * neither for an empty line. */
export function fountainLine(state: EditorState, line: Line): { token?: string; kind?: string } {
  const tree = ensureSyntaxTree(state, line.to, 200) ?? syntaxTree(state);
  const node = tree.resolveInner(line.from, 1);
  if (!FOUNTAIN_LINE_TAGS.has(node.name)) return {};
  return { token: node.name, kind: lineKind(tree, node.name, line, state, multiLineNotes(state.doc)) };
}

/** The marks forcing a line's kind, relative to its start, as the editor
 * draws them: none inside a note. */
export function lineForcingMarks(state: EditorState, line: Line): Span[] {
  const { kind } = fountainLine(state, line);
  if (kind === undefined) return [];
  const notes = [
    ...noteParts(line, multiLineNotes(state.doc)),
    ...findInlineRanges(line.text).filter((range) => range.className === NOTE_CLASS),
  ];
  return forcingMarks(line.text, kind).filter((mark) => !overlaps(notes, mark.from, mark.to));
}

// What a run's text may hold: emphasis no blank at its start and no line
// break, a comment anything, over several lines too.
const EMPHASIS: RunRules = { lead: false, tail: true, blanks: true, lines: false };
const COMMENT: RunRules = { lead: true, tail: true, blanks: true, lines: true };

const touching = (spans: readonly Span[], from: number, to: number) =>
  spans.some((span) => span.from <= to && span.to >= from);

// A comment as a run, its brackets the marks. One with nothing in it keeps
// them, so it still shows.
function commentRun(doc: Text, from: number, to: number): Run[] {
  if (!doc.sliceString(from + 2, to - 2).trim()) return [];
  const open = { from, to: from + 2 };
  const close = { from: to - 2, to };
  return [{ name: NOTE_CLASS, kinds: ["comment"], from, to, open, close, rules: COMMENT }];
}

/** Where a screenplay's formatting hides syntax: emphasis and comments as
 * runs, a dual cue's `^` and a centered line's `<` closing a line, and a
 * line's leading forcing mark or synopsis `=`. A link note shows at the
 * caret, so it is none. */
export const screenplaySyntax: HiddenSyntax = {
  near(state: EditorState, from: number, to: number): HiddenNear {
    const { doc } = state;
    const first = doc.lineAt(from);
    const last = doc.lineAt(to);
    const shown = revealedSpans(state, [{ from: first.from, to: last.to }]);
    const near: HiddenNear = { runs: [], escapes: [], closings: [] };
    const notes = multiLineNotes(doc);
    for (const note of notes) {
      if (note.to >= first.from && note.from <= last.to && !touching(shown, note.from, note.to)) {
        near.runs.push(...commentRun(doc, note.from, note.to));
      }
    }
    for (let number = first.number; number <= last.number; number++) {
      const line = doc.line(number);
      const { token, kind } = fountainLine(state, line);
      if (kind === undefined) continue;
      const parts = token === "fountain-boneyard" ? [] : noteParts(line, notes);
      const ranges = SKIP_INLINE_TAGS.has(kind)
        ? []
        : findInlineRanges(line.text).filter((range) => !overlaps(parts, range.from, range.to));
      for (const range of ranges) {
        const at = { from: line.from + range.from, to: line.from + range.to };
        if (touching(shown, at.from, at.to)) continue;
        if (range.className === NOTE_CLASS) {
          if (!linkTarget(line.text.slice(range.from, range.to))) near.runs.push(...commentRun(doc, at.from, at.to));
          continue;
        }
        near.runs.push({
          name: range.className,
          kinds: MARKS_OF[range.className],
          ...at,
          open: { from: at.from, to: at.from + range.marker },
          close: { from: at.to - range.marker, to: at.to },
          rules: EMPHASIS,
        });
      }
      if (touching(shown, line.from, line.to)) continue;
      const start = line.text.length - line.text.trimStart().length;
      for (const mark of lineForcingMarks(state, line)) {
        if (mark.from !== start) near.closings.push({ from: line.from + mark.from, to: line.from + mark.to });
      }
    }
    return near;
  },

  prefix(state: EditorState, line: Line): LinePrefix | undefined {
    const { kind } = fountainLine(state, line);
    if (kind === undefined || touching(revealedSpans(state, [line]), line.from, line.to)) return undefined;
    const start = line.text.length - line.text.trimStart().length;
    const marks = kind === "fountain-synopsis" ? synopsisMark(line.text) : lineForcingMarks(state, line);
    const lead = marks.find((mark) => mark.from === start);
    return lead && { end: line.from + lead.to, last: line.from + lead.from };
  },
};

/** Every world file the screenplay in `state` names, once, in order of
 * first mention, with where and how often. Reads the whole document, not
 * just what is on screen, so it parses ahead of the editor when it has to. */
export function screenplayWorldLinks(
  state: EditorState,
  resolve: (name: string) => string | undefined,
): { path: string; count: number; mentions: { from: number; to: number }[] }[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const notes = multiLineNotes(state.doc);
  const found = new Map<string, { from: number; to: number }[]>();
  let lastLine = -1;
  tree.iterate({
    enter(node) {
      if (!FOUNTAIN_LINE_TAGS.has(node.name)) return;
      const line = state.doc.lineAt(node.from);
      if (line.number === lastLine) return;
      lastLine = line.number;
      const nameLine = worldNameLine(lineKind(tree, node.name, line, state, notes));
      if (!nameLine) return;
      const parts = noteParts(line, notes);
      for (const name of findWorldNames(line.text, nameLine, resolve)) {
        if (overlaps(parts, name.from, name.to)) continue;
        const mention = { from: line.from + name.from, to: line.from + name.to };
        const mentions = found.get(name.path);
        if (mentions) mentions.push(mention);
        else found.set(name.path, [mention]);
      }
    },
  });
  return [...found].map(([path, mentions]) => ({ path, count: mentions.length, mentions }));
}

function buildFountainDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  // Reading view locks the editor and shows a plain script: no world links,
  // so no underline and no world menu, no notes, and none of the marks
  // Fountain never prints. The formatted view hides those marks, a comment's
  // brackets, a synopsis's `=` and a link note too, except where the
  // selection touches them; Source mode shows every one.
  //
  // With Hide format syntax on, the selection shows only a link note.
  const reading = !view.state.facet(EditorView.editable);
  const formatting = !reading && view.state.facet(formattedView);
  const hiding = reading || formatting;
  const opened = formatting ? shownSpans(view) : [];
  const shown = formatting && syntaxHidden(view.state) ? shownSpans(view, false) : opened;
  const touches = (from: number, to: number) => shown.some((span) => span.from <= to && span.to >= from);
  const opens = (from: number, to: number) => opened.some((span) => span.from <= to && span.to >= from);
  const resolve = reading ? undefined : view.state.facet(worldLinks)?.resolver();
  const notes = multiLineNotes(doc);
  let lastLine = -1;

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (!FOUNTAIN_LINE_TAGS.has(node.name)) return;

        const line = doc.lineAt(node.from);
        // A single logical token always spans exactly one line (see the
        // tokenizer's unconditional `stream.skipToEnd()`), but a visible
        // range can still touch the same line twice at its edges — only
        // decorate each line once.
        if (line.number === lastLine) return;
        lastLine = line.number;

        const tag = lineKind(tree, node.name, line, view.state, notes);
        // Reading view and the formatted view draw a heading's scene number
        // in both margins where they hold it, as the printed page does;
        // Source mode leaves it in the text.
        const number = tag === "fountain-scene-heading" ? sceneNumber(line.text) : undefined;
        const margins =
          hiding && number && inMargins(view.state, number) ? { "data-scene-number": number.number } : undefined;
        builder.add(line.from, line.from, Decoration.line({ class: `cm-${tag}`, attributes: margins }));

        const marks: { from: number; to: number; mark: Decoration }[] = [];
        const hidden: Span[] = [];
        const syntax = (from: number, to: number, show: boolean) => {
          if (show) marks.push({ from, to, mark: syntaxMark });
          else hidden.push({ from, to });
        };
        // A note over several lines owns what it covers of this line, so no
        // emphasis, one-line note or name is read inside it.
        const parts = node.name === "fountain-boneyard" ? [] : noteParts(line, notes);
        const ranges = SKIP_INLINE_TAGS.has(tag)
          ? []
          : findInlineRanges(line.text).filter((range) => !overlaps(parts, range.from, range.to));
        const lineNotes = [...parts, ...ranges.filter((range) => range.className === NOTE_CLASS)].sort(
          (a, b) => a.from - b.from,
        );
        // The formatted view draws a link note as its glyph, and as written,
        // faint, where the selection touches it; Source mode keeps its band.
        // Its text keeps its case on a line drawn in capitals.
        const links = reading
          ? []
          : ranges.flatMap((range) => {
              const target = range.className === NOTE_CLASS && linkTarget(line.text.slice(range.from, range.to));
              return target ? [{ from: range.from, to: range.to, target }] : [];
            });
        const drawnAsLink = (note: Span) => formatting && links.some((link) => link.from === note.from);
        for (const link of links) {
          if (formatting && !opens(line.from + link.from, line.from + link.to)) {
            marks.push({
              from: link.from,
              to: link.to,
              mark: Decoration.replace({ widget: new LinkIcon(link.target) }),
            });
            continue;
          }
          if (formatting) marks.push({ from: link.from, to: link.to, mark: syntaxMark });
          marks.push({ from: link.from, to: link.to, mark: linkText });
        }
        let hiddenTo = 0;
        for (const note of lineNotes) {
          if (!reading) {
            if (!drawnAsLink(note))
              marks.push({ from: note.from, to: note.to, mark: Decoration.mark({ class: NOTE_CLASS }) });
            continue;
          }
          // One space goes with the note, so the words either side of it
          // don't sit two spaces apart.
          let { from, to } = note;
          if (from > hiddenTo && line.text[from - 1] === " ") from--;
          else if (line.text[to] === " ") to++;
          hidden.push({ from, to });
          hiddenTo = to;
        }
        for (const range of ranges) {
          if (range.className === NOTE_CLASS) continue;
          marks.push({ from: range.from, to: range.to, mark: Decoration.mark({ class: range.className }) });
          if (hiding && range.marker) {
            const show = !reading && touches(line.from + range.from, line.from + range.to);
            syntax(range.from, range.from + range.marker, show);
            syntax(range.to - range.marker, range.to, show);
          }
        }
        // A forcing mark shows with its whole line, so the caret never
        // crosses one it can't see, unless Hide format syntax keeps it hidden
        // and the caret steps over it.
        if (hiding) {
          const show = !reading && touches(line.from, line.to);
          for (const mark of forcingMarks(line.text, tag)) {
            if (!overlaps(lineNotes, mark.from, mark.to)) syntax(mark.from, mark.to, show);
          }
        }
        // A number the margins hold leaves the text with the blank before
        // it. Where the selection touches it, it shows as written, faint,
        // Hide format syntax or not, as a link note does: it is no formatting,
        // and the writer edits it there. One the margins can't hold stays.
        if (number) {
          if (margins && (reading || !opens(line.from + number.from, line.from + number.to))) {
            hidden.push(numberWithBlank(line.text, number));
          } else {
            if (hiding) marks.push({ from: number.from, to: number.to, mark: syntaxMark });
            marks.push({ from: number.from, to: number.to, mark: numberText });
          }
        }
        // What reading view drops keeps its band while edited; only its
        // marks hide, a comment's while the selection is off the comment, a
        // synopsis's while it is off the line.
        if (formatting) {
          const comments = [
            ...(node.name === "fountain-boneyard"
              ? []
              : notes.filter((note) => note.from < line.to && note.to > line.from)),
            ...ranges
              .filter((range) => range.className === NOTE_CLASS && !drawnAsLink(range))
              .map((range) => ({ from: line.from + range.from, to: line.from + range.to })),
          ];
          for (const bracket of commentBrackets(line, doc, comments)) {
            syntax(bracket.from, bracket.to, touches(bracket.comment.from, bracket.comment.to));
          }
          if (tag === "fountain-synopsis") {
            for (const mark of synopsisMark(line.text)) syntax(mark.from, mark.to, touches(line.from, line.to));
          }
        }
        for (const span of joined(hidden)) marks.push({ from: span.from, to: span.to, mark: hiddenMarker });
        const nameLine = worldNameLine(tag);
        if (resolve && nameLine) {
          for (const name of findWorldNames(line.text, nameLine, resolve)) {
            if (overlaps(parts, name.from, name.to)) continue;
            marks.push({ from: name.from, to: name.to, mark: worldLinkMark(name.path) });
          }
        }
        // RangeSetBuilder takes ties in startSide order, and a hidden
        // delimiter sits lower than the emphasis mark starting with it.
        marks.sort((a, b) => a.from - b.from || a.mark.startSide - b.mark.startSide);
        for (const { from, to, mark } of marks) builder.add(line.from + from, line.from + to, mark);
      },
    });
  }

  return builder.finish();
}

const fountainDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFountainDecorations(view);
    }
    update(update: ViewUpdate) {
      const worldChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(worldNamesChanged)));
      const lockChanged = update.startState.facet(EditorView.editable) !== update.state.facet(EditorView.editable);
      // A jump shows lines the parse hasn't reached; it reaches them in a
      // later update of its own, which changes nothing else.
      const parsed = syntaxTree(update.startState) !== syntaxTree(update.state);
      // Into or out of Source mode, and in the formatted view whatever moves
      // where its syntax shows.
      const formatted = update.state.facet(formattedView);
      const switched = update.startState.facet(formattedView) !== formatted;
      const revealed = formatted && update.state.facet(EditorView.editable) && shownSpansChanged(update);
      const hidingFlipped = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(hidingSwitched)));
      const opened = update.startState.field(openedLine, false) !== update.state.field(openedLine, false);
      const room = update.startState.field(numberRoom) !== update.state.field(numberRoom);
      if (
        room ||
        update.docChanged ||
        update.viewportChanged ||
        parsed ||
        worldChanged ||
        lockChanged ||
        switched ||
        revealed ||
        hidingFlipped ||
        opened
      ) {
        this.decorations = buildFountainDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// The page's margins, measured where fountain.css sets the numbers: the left
// one past the gutter and three cells off the text, the right one three cells
// past the page's 60th. A measure can't dispatch, so its result goes in the
// turn after.
const roomWatch = ViewPlugin.fromClass(
  class {
    private gone = false;
    constructor(private readonly view: EditorView) {
      this.measure();
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged) this.measure();
    }
    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const page = view.contentDOM.getBoundingClientRect();
          const pane = view.scrollDOM.getBoundingClientRect();
          const gutter = view.scrollDOM.querySelector(".cm-gutters")?.getBoundingClientRect().width ?? 0;
          const ch = view.defaultCharacterWidth;
          if (!(ch > 0) || !pane.width) return view.state.field(numberRoom);
          const left = page.left - pane.left - Math.max(3 * ch - 6, gutter + ch);
          const right = pane.left + view.scrollDOM.clientWidth - page.right - (2 * ch - 2);
          return Math.floor(Math.min(left, right) / ch);
        },
        write: (room, view) => {
          if (room === view.state.field(numberRoom)) return;
          setTimeout(() => this.gone || view.dispatch({ effects: numberRoomMeasured.of(room) }));
        },
      });
    }
    destroy() {
      this.gone = true;
    }
  },
);

// A caret that lands at the end of a heading whose number the margins hold
// goes before the number, to the end of what shows: text typed after the
// number would end it. A caret already on the number, showing it, stays.
function beforeHiddenNumber(state: EditorState, pos: number): number | undefined {
  const line = state.doc.lineAt(pos);
  const number = sceneNumber(line.text);
  if (!number || pos !== line.from + number.to || !inMargins(state, number)) return undefined;
  if (fountainLine(state, line).kind !== "fountain-scene-heading") return undefined;
  const shown = [...state.selection.ranges, ...revealedSpans(state, [line])];
  if (touching(shown, line.from + number.from, pos)) return undefined;
  return line.from + numberWithBlank(line.text, number).from;
}

const caretBeforeNumber = EditorState.transactionFilter.of((tr) => {
  const { startState: state, selection } = tr;
  if (!selection || tr.docChanged || !state.facet(formattedView) || !state.facet(EditorView.editable)) return tr;
  let moved = false;
  const ranges = selection.ranges.map((range) => {
    const at = range.empty ? beforeHiddenNumber(state, range.head) : undefined;
    if (at === undefined) return range;
    moved = true;
    return EditorSelection.cursor(at, -1);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }] : tr;
});

// A margin number is drawn by its heading's line, so a press on one lands on
// the line, outside its box. It selects the number as written, which then
// shows, to edit.
const sceneNumberPress = EditorView.domEventHandlers({
  mousedown(event, view) {
    const line = event.target instanceof HTMLElement ? event.target : null;
    if (!line?.matches(".cm-line[data-scene-number]") || event.button !== 0) return false;
    const box = line.getBoundingClientRect();
    if (event.clientX >= box.left && event.clientX <= box.right) return false;
    if (!view.state.facet(EditorView.editable)) return false;
    const heading = view.state.doc.lineAt(view.posAtDOM(line));
    const number = sceneNumber(heading.text);
    if (!number) return false;
    event.preventDefault();
    view.focus();
    view.dispatch({
      selection: { anchor: heading.from + number.from + 1, head: heading.from + number.to - 1 },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  },
});

// A pane's one editor is made long before a screenplay's face first loads,
// so CodeMirror's own check for fonts is over by then: lines the face
// rewraps keep their old heights, and a click lands lines away. A font
// loading while a screenplay shows gives the editor a fresh, empty theme,
// and a changed theme makes CodeMirror measure every line it draws.
const remeasure = new Compartment();

const remeasureOnFontLoad = ViewPlugin.fromClass(
  class {
    private readonly loaded = () => this.view.dispatch({ effects: remeasure.reconfigure(EditorView.theme({})) });
    constructor(private readonly view: EditorView) {
      document.fonts?.addEventListener("loadingdone", this.loaded);
    }
    destroy() {
      document.fonts?.removeEventListener("loadingdone", this.loaded);
    }
  },
);

export function fountain(links?: WorldLinks) {
  return [
    fountainLanguage,
    links ? worldLinks.of(links) : [],
    openedLine,
    openedLineDrawn,
    fountainDecorator,
    unprintedLines,
    numberRoom,
    roomWatch,
    caretBeforeNumber,
    sceneNumberPress,
    remeasure.of([]),
    remeasureOnFontLoad,
    // Screenplay convention is monospace (Courier); the shared editor CSS
    // otherwise sets a proportional font for every document type. Adding a
    // class here — rather than fighting that rule's specificity from
    // web/styles/codemirror.css — scopes the override to Fountain documents only.
    EditorView.editorAttributes.of({ class: "fountain-editor" }),
    // The CSS caps the content column at a fixed 60ch (a real screenplay
    // page's text width), so long lines need to actually wrap there instead
    // of overflowing into horizontal scroll.
    EditorView.lineWrapping,
  ];
}
