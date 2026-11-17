// What a note's Format column, the palette and their keys do to its text: a
// mark wrapped around words or taken off them, a line turned into another
// kind, a link. Each edits the Markdown as written, so Source mode shows
// what it did, and finds what the selection is in from the syntax tree that
// formats the note.
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSet,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type CommentSpan, commentsOf } from "../../../src/protocol/markdownComments.ts";
import { openedMarks, toggleAtCaret } from "../../hiddenSyntax.ts";
import type { FormatAction, FormatActions } from "../../services/formats.ts";
import type { Span } from "../../shownSyntax.ts";
import { bareUrlHref } from "../../webLinks.ts";

// A mark by the node it parses as and the delimiter written for it. Italic
// writes `*`, which a word's own letters never end.
interface Mark {
  node: string;
  delimiter: string;
}

const BOLD: Mark = { node: "StrongEmphasis", delimiter: "**" };
const ITALIC: Mark = { node: "Emphasis", delimiter: "*" };
const CODE: Mark = { node: "InlineCode", delimiter: "`" };
const STRIKETHROUGH: Mark = { node: "Strikethrough", delimiter: "~~" };
const HIGHLIGHT: Mark = { node: "Highlight", delimiter: "==" };
const SUPERSCRIPT: Mark = { node: "Superscript", delimiter: "^" };
const SUBSCRIPT: Mark = { node: "Subscript", delimiter: "~" };
const MARKS = [BOLD, ITALIC, CODE, STRIKETHROUGH, HIGHLIGHT, SUPERSCRIPT, SUBSCRIPT];

const FORMAT_EVENT = "input.format";

// The innermost node named `name` holding `range`. A caret counts only
// strictly inside, so one just past a closing delimiter has left the mark.
function around(state: EditorState, range: SelectionRange, name: string): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.from, 1); node; node = node.parent) {
    if (node.name !== name) continue;
    const holds = range.empty
      ? node.from < range.from && range.from < node.to
      : node.from <= range.from && range.to <= node.to;
    if (holds) return node;
  }
  return null;
}

// A range carried through `changes`, kept on the text it covered: its
// start after anything inserted there, its end before.
function carried(range: SelectionRange, changes: ChangeSet): SelectionRange {
  if (range.empty) return EditorSelection.cursor(changes.mapPos(range.head, 1));
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  return range.head === range.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}

// A line's own markers after its indent: quote markers, then a heading's,
// a task's, a bullet's or a number's.
const LINE_PREFIX =
  /^([ \t]*)((?:>[ \t]?)*)(#{1,6}(?:[ \t]+|$)|[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))?/;

// Every part of the pattern is optional, so it matches every line.
function prefixOf(text: string): RegExpExecArray {
  return LINE_PREFIX.exec(text) as RegExpExecArray;
}

// The text a mark goes around: for a caret, the word it is in; else the
// selection without its outer spaces, split at line ends and kept off each
// line's markers, which no mark may hold.
function markTargets(state: EditorState, range: SelectionRange): { from: number; to: number }[] {
  if (range.empty) {
    const word = state.wordAt(range.head);
    return [word ? { from: word.from, to: word.to } : { from: range.head, to: range.head }];
  }
  const targets: { from: number; to: number }[] = [];
  const last = state.doc.lineAt(range.to).number;
  for (let number = state.doc.lineAt(range.from).number; number <= last; number++) {
    const line = state.doc.line(number);
    let from = Math.max(range.from, line.from + prefixOf(line.text)[0].length);
    let to = Math.min(range.to, line.to);
    if (from >= to) continue;
    const text = state.sliceDoc(from, to);
    from += text.length - text.trimStart().length;
    to -= text.length - text.trimEnd().length;
    if (from < to) targets.push({ from, to });
  }
  return targets;
}

function toggleMark(mark: Mark): (view: EditorView) => void {
  return (view) => {
    if (toggleAtCaret(view, mark.node, { open: mark.delimiter, close: mark.delimiter })) return;
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const node = around(state, range, mark.node);
      const open = node?.firstChild;
      const close = node?.lastChild;
      if (node && open && close && open !== close) {
        const changes = state.changes([
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ]);
        return { changes, range: carried(range, changes) };
      }
      const targets = markTargets(state, range);
      if (!targets.length) return { range };
      const changes = state.changes(
        targets.flatMap(({ from, to }) => [
          { from, insert: mark.delimiter },
          { from: to, insert: mark.delimiter },
        ]),
      );
      const [first] = targets;
      // A caret between new delimiters goes between them, to type into; one
      // in a word keeps its place in it, at the word's end too.
      if (range.empty) {
        const at =
          first.from === first.to
            ? range.head + mark.delimiter.length
            : changes.mapPos(range.head, range.head === first.to ? -1 : 1);
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

function markAction(
  id: string,
  label: string,
  mark: Mark,
  options: { key?: string; group?: string; glyph?: string; more?: boolean } = {},
): FormatAction {
  return {
    id,
    label,
    glyph: options.glyph ?? id,
    group: options.group ?? "marks",
    key: options.key,
    more: options.more,
    isOn: (state) =>
      around(state, state.selection.main, mark.node) !== null || openedMarks(state).includes(mark.delimiter),
    run: toggleMark(mark),
  };
}

// Takes both delimiters off every mark the selection touches, so none is
// left half closed, or off the marks a caret is in.
function clearMarks(view: EditorView): void {
  const { state } = view;
  const names = new Set(MARKS.map((mark) => mark.node));
  const nodes = new Map<string, SyntaxNode>();
  const keep = (node: SyntaxNode) => nodes.set(`${node.name}:${node.from}`, node);
  for (const range of state.selection.ranges) {
    if (range.empty) {
      for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, 1); node; node = node.parent) {
        if (names.has(node.name) && node.from < range.head && range.head < node.to) keep(node);
      }
      continue;
    }
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        if (names.has(ref.name) && ref.to > range.from && ref.from < range.to) keep(ref.node);
      },
    });
  }
  const changes: ChangeSpec[] = [];
  for (const node of nodes.values()) {
    const open = node.firstChild;
    const close = node.lastChild;
    if (open && close && open !== close)
      changes.push({ from: open.from, to: open.to }, { from: close.from, to: close.to });
  }
  if (changes.length) view.dispatch({ changes, userEvent: FORMAT_EVENT });
}

// In a link, takes the link off its text. Anywhere else it writes one around
// the selection with the caret where the address goes, or around an address
// with the caret where its text goes.
function toggleLink(view: EditorView): void {
  const { state } = view;
  const spec = state.changeByRange((range) => {
    const link = around(state, range, "Link");
    const [open, close] = link?.getChildren("LinkMark") ?? [];
    if (link && open && close) {
      const label = state.sliceDoc(open.to, close.from);
      const changes = state.changes({ from: link.from, to: link.to, insert: label });
      const at = (pos: number) => link.from + Math.max(0, Math.min(pos - open.to, label.length));
      return { changes, range: EditorSelection.range(at(range.anchor), at(range.head)) };
    }
    const text = state.sliceDoc(range.from, range.to);
    const address = text.trim();
    if (address && bareUrlHref(address) !== undefined) {
      const changes = state.changes({ from: range.from, to: range.to, insert: `[](${address})` });
      return { changes, range: EditorSelection.cursor(range.from + 1) };
    }
    const changes = state.changes({ from: range.from, to: range.to, insert: `[${text}]()` });
    return { changes, range: EditorSelection.cursor(range.from + text.length + (text ? 3 : 1)) };
  });
  view.dispatch(spec, { userEvent: FORMAT_EVENT, scrollIntoView: true });
}

const COMMENT_OPEN = "<!-- ";
const COMMENT_CLOSE = " -->";

// What a comment goes around: a selection on one line as it is, its outer
// blanks left out; else the lines it touches whole, blank ones at either end
// left out, so the comment opens a line and holds whole blocks. A caret on a
// blank line has nothing to go around.
function commentTarget(state: EditorState, range: SelectionRange): Span {
  const { doc } = state;
  const end = range.to > range.from && doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
  let first = doc.lineAt(range.from);
  let last = doc.lineAt(end);
  if (!range.empty && first.number === last.number) {
    const text = state.sliceDoc(range.from, end);
    const from = range.from + (text.length - text.trimStart().length);
    const to = end - (text.length - text.trimEnd().length);
    if (from < to) return { from, to };
  }
  while (first.number < last.number && !first.text.trim()) first = doc.line(first.number + 1);
  while (last.number > first.number && !last.text.trim()) last = doc.line(last.number - 1);
  const from = first.from + (first.text.length - first.text.trimStart().length);
  const to = last.to - (last.text.length - last.text.trimEnd().length);
  return from < to ? { from, to } : { from: range.head, to: range.head };
}

// The comments `span` overlaps, a caret on a blank line counting only inside one.
function commentsOver(state: EditorState, span: Span): CommentSpan[] {
  const found: CommentSpan[] = [];
  syntaxTree(state).iterate({
    from: span.from,
    to: span.to,
    enter: (ref) => {
      if (ref.name !== "Comment" && ref.name !== "CommentBlock") return;
      for (const comment of commentsOf(ref, (from, to) => state.sliceDoc(from, to))) {
        if (comment.from < span.to && comment.to > span.from) found.push(comment);
      }
      return false;
    },
  });
  return found;
}

// A comment's ends, each with the blank the action writes inside it, or with
// its whole line where it stands alone on one. `<!-->` and `<!--->` go whole,
// and a comment left open has only its `<!--`.
function commentEnds(doc: Text, comment: CommentSpan): Span[] {
  const text = doc.sliceString(comment.from, comment.to);
  if (text === "<!-->" || text === "<!--->") return [comment];
  const first = doc.lineAt(comment.from);
  const last = doc.lineAt(comment.to);
  const several = first.number < last.number;
  const open = { from: comment.from, to: comment.from + 4 };
  const close = text.endsWith("-->") ? { from: comment.to - 3, to: comment.to } : undefined;
  const inner = close?.from ?? comment.to;
  if (several && !doc.sliceString(first.from, open.from).trim() && !doc.sliceString(open.to, first.to).trim()) {
    open.from = first.from;
    open.to = first.to + 1;
  } else if (open.to < inner && /[ \t]/.test(doc.sliceString(open.to, open.to + 1))) open.to++;
  if (!close) return [open];
  if (several && !doc.sliceString(last.from, close.from).trim() && !doc.sliceString(close.to, last.to).trim()) {
    close.from = last.from - 1;
    close.to = last.to;
  } else if (close.from > open.to && /[ \t]/.test(doc.sliceString(close.from - 1, close.from))) close.from--;
  return close.from < open.to ? [{ from: open.from, to: close.to }] : [open, close];
}

// Takes off every comment the text it would go around overlaps, or writes
// one around it. A comment never goes around another: the first `-->` would
// end both, and the rest would show as text.
function toggleComment(view: EditorView): void {
  const { state } = view;
  const targets = state.selection.ranges.map((range) => commentTarget(state, range));
  const held = new Map<number, CommentSpan>();
  const wrapped = new Set<Span>();
  for (const target of targets) {
    const comments = commentsOver(state, target);
    for (const comment of comments) held.set(comment.from, comment);
    if (!comments.length) wrapped.add(target);
  }
  // Ranges whose texts overlap, such as two on one line, share one comment.
  const spans: Span[] = [];
  for (const target of [...wrapped].sort((a, b) => a.from - b.from)) {
    const last = spans.at(-1);
    if (last && target.from < last.to) last.to = Math.max(last.to, target.to);
    else spans.push({ ...target });
  }
  const changes: ChangeSpec[] = [...held.values()].flatMap((comment) => commentEnds(state.doc, comment));
  for (const { from, to } of spans) {
    if (from === to) changes.push({ from, insert: `${COMMENT_OPEN}${COMMENT_CLOSE}` });
    else changes.push({ from, insert: COMMENT_OPEN }, { from: to, insert: COMMENT_CLOSE });
  }
  const set = state.changes(changes);
  const empty = new Set(spans.filter((span) => span.from === span.to).map((span) => span.from));
  // A caret stays in the text it was in, a selection takes the text the
  // comment holds, as a mark's does, and an empty comment takes the caret.
  const ranges = state.selection.ranges.map((range, index) => {
    const target = targets[index];
    if (!wrapped.has(target)) return carried(range, set);
    if (target.from === target.to && empty.has(target.from)) {
      return EditorSelection.cursor(set.mapPos(target.from, -1) + COMMENT_OPEN.length);
    }
    if (range.empty) return EditorSelection.cursor(set.mapPos(range.head, range.head === target.to ? -1 : 1));
    const from = set.mapPos(target.from, 1);
    const to = set.mapPos(target.to, -1);
    return range.head === range.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
  });
  view.dispatch({
    changes: set,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    userEvent: FORMAT_EVENT,
    scrollIntoView: true,
  });
}

type LineKind = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "bullet" | "numbered" | "task" | "quote" | "code";

const PREFIXES: Record<Exclude<LineKind, "numbered" | "code">, string> = {
  p: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  h4: "#### ",
  h5: "##### ",
  h6: "###### ",
  bullet: "- ",
  task: "- [ ] ",
  quote: "> ",
};

const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function fenceAround(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "FencedCode") return node;
  }
  return null;
}

function kindOf(state: EditorState, line: Line): LineKind {
  if (fenceAround(state, line.from)) return "code";
  const [, , quote, marker] = prefixOf(line.text);
  if (marker?.startsWith("#")) return `h${marker.trim().length}` as LineKind;
  if (marker && /\[[ xX]\]/.test(marker)) return "task";
  if (marker && /^[-*+]/.test(marker)) return "bullet";
  if (marker) return "numbered";
  return quote ? "quote" : "p";
}

// The lines the selection touches, in order. A selection dragged through a
// line's end stops at the next line's start, a line it doesn't touch.
function touchedLines(state: EditorState): Line[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(end).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map((number) => state.doc.line(number));
}

function fencedBlocks(state: EditorState, from: number, to: number): SyntaxNode[] {
  const blocks: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      if (ref.name !== "FencedCode") return;
      blocks.push(ref.node);
      return false;
    },
  });
  return blocks;
}

// Turns every line the selection touches into `kind`, the line's own
// markers replaced and its text kept. A fenced block the lines are in loses
// its fences first, its lines kept as written; lines turned into a code
// block are fenced as they are. Blank lines among several stay blank.
function setLines(kind: LineKind): (view: EditorView) => void {
  return (view) => {
    const { state } = view;
    const lines = touchedLines(state);
    const blocks = fencedBlocks(state, lines[0].from, lines[lines.length - 1].to);
    const changes: ChangeSpec[] = [];
    const fenceLines = new Set<number>();
    const inBlock = (line: Line) => blocks.some((block) => block.from <= line.from && line.from < block.to);
    for (const block of blocks) {
      const open = state.doc.lineAt(block.from);
      const close = state.doc.lineAt(block.to);
      fenceLines.add(open.number);
      if (kind === "code") continue;
      if (close.number > open.number && FENCE.test(close.text)) {
        fenceLines.add(close.number);
        if (close.number === open.number + 1) changes.push({ from: open.from, to: close.to });
        else changes.push({ from: open.from, to: open.to + 1 }, { from: close.from - 1, to: close.to });
      } else {
        changes.push({ from: open.from, to: Math.min(open.to + 1, state.doc.length) });
      }
    }
    if (kind === "code") {
      if (blocks.length) return;
      const first = lines[0];
      const last = lines[lines.length - 1];
      for (const line of lines) {
        const [whole, indent] = prefixOf(line.text);
        if (whole.length > indent.length)
          changes.push({ from: line.from + indent.length, to: line.from + whole.length });
      }
      changes.push({ from: first.from, insert: "```\n" }, { from: last.to, insert: "\n```" });
    } else {
      let number = 1;
      for (const line of lines) {
        if (fenceLines.has(line.number) || (lines.length > 1 && !line.text.trim())) continue;
        const code = inBlock(line);
        const [whole, indent] = prefixOf(line.text);
        // A list keeps its nesting; any other kind starts at the margin.
        const nests = !code && (kind === "bullet" || kind === "numbered" || kind === "task");
        const from = line.from + (nests ? indent.length : 0);
        const to = code ? line.from : line.from + whole.length;
        const insert = kind === "numbered" ? `${number++}. ` : PREFIXES[kind];
        if (state.sliceDoc(from, to) !== insert) changes.push({ from, to, insert });
      }
    }
    if (!changes.length) return;
    const set = state.changes(changes);
    const selection = EditorSelection.create(
      state.selection.ranges.map((range) => carried(range, set)),
      state.selection.mainIndex,
    );
    view.dispatch({ changes: set, selection, userEvent: FORMAT_EVENT, scrollIntoView: true });
  };
}

function lineAction(
  id: string,
  label: string,
  glyph: string,
  group: string,
  kind: LineKind,
  more = false,
): FormatAction {
  return {
    id,
    label,
    glyph,
    group,
    more,
    isOn: (state) => kindOf(state, state.doc.lineAt(state.selection.main.head)) === kind,
    run: setLines(kind),
  };
}

const HEADINGS = [1, 2, 3, 4, 5, 6] as const;

const TEXT = lineAction("text", "Text", "pilcrow", "text", "p");

const LINE_ACTIONS: readonly FormatAction[] = [
  TEXT,
  // A note's title is its leading # heading (docs/protocol.md's Display
  // title rule).
  { ...lineAction("heading1", "Heading 1", "heading-1", "text", "h1"), title: true },
  ...HEADINGS.slice(1).map((level) =>
    lineAction(`heading${level}`, `Heading ${level}`, `heading-${level}`, "text", `h${level}`),
  ),
  lineAction("bulletList", "Bullet list", "list-bullets", "list", "bullet", true),
  lineAction("numberedList", "Numbered list", "list-numbers", "list", "numbered", true),
  lineAction("taskList", "Task list", "list-checks", "list", "task", true),
  lineAction("quote", "Quote", "text-quote", "block", "quote", true),
  lineAction("codeBlock", "Code block", "square-code", "block", "code", true),
];

const MARK_ACTIONS: readonly FormatAction[] = [
  markAction("bold", "Bold", BOLD, { key: "Mod+B" }),
  markAction("italic", "Italic", ITALIC, { key: "Mod+I" }),
  markAction("strikethrough", "Strikethrough", STRIKETHROUGH, { more: true }),
  markAction("highlight", "Highlight", HIGHLIGHT, { glyph: "highlighter", more: true }),
  markAction("code", "Code", CODE),
  { id: "clearFormatting", label: "Clear formatting", glyph: "eraser", group: "marks", last: true, run: clearMarks },
  markAction("superscript", "Superscript", SUPERSCRIPT, { group: "scripts", more: true }),
  markAction("subscript", "Subscript", SUBSCRIPT, { group: "scripts", more: true }),
  {
    id: "link",
    label: "Link",
    glyph: "link",
    group: "link",
    key: "Mod+K",
    isOn: (state) => around(state, state.selection.main, "Link") !== null,
    run: toggleLink,
  },
];

// Not `comment`: that is a screenplay's Note, and formats sharing an id
// share its command, label and key. It takes Mod-/ from CodeMirror's comment
// toggle, which writes one comment inside another.
const COMMENT: FormatAction = {
  id: "htmlComment",
  label: "Comment",
  glyph: "comment",
  group: "comment",
  key: "Mod+/",
  more: true,
  isOn: (state) => commentsOver(state, commentTarget(state, state.selection.main)).length > 0,
  run: toggleComment,
};

/** What a note's Format column offers. */
export const markdownActions: FormatActions = {
  sourceGlyph: "markdown-source-mode",
  plain: TEXT,
  lines: LINE_ACTIONS,
  marks: [...MARK_ACTIONS, COMMENT],
  tools: [...MARK_ACTIONS, ...LINE_ACTIONS.filter((line) => line.more), COMMENT],
};
