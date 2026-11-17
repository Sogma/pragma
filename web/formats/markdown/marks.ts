// Which of a note's syntax its formatting hides, by node: a run's
// delimiters and a heading's marks with the blanks beside them, and what it
// leaves as written. The formatting draws by these, and editing with the
// syntax hidden steps over the same marks.
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Line, Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { HiddenNear, HiddenSyntax, LinePrefix, RunRules } from "../../hiddenSyntax.ts";
import { revealedSpans, type Span } from "../../shownSyntax.ts";

/** A run of inline formatting, by its node: the node of its delimiters. */
export const RUN_DELIMITERS: Readonly<Record<string, string>> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  Superscript: "SuperscriptMark",
  Subscript: "SubscriptMark",
  Highlight: "HighlightMark",
  InlineCode: "CodeMark",
};

export const HEADING_LEVELS: Readonly<Record<string, number>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

// Images and tables until they are drawn; HTML, which reading view shows as
// text; reference definitions, which it hides.
export const AS_WRITTEN: ReadonlySet<string> = new Set([
  "Image",
  "Table",
  "HTMLBlock",
  "HTMLTag",
  "ProcessingInstructionBlock",
  "ProcessingInstruction",
  "LinkReference",
]);

export function isBlank(doc: Text, pos: number): boolean {
  const char = doc.sliceString(pos, pos + 1);
  return char === " " || char === "\t";
}

/** An ATX heading's marks, the opening one first, each with the blanks
 * between it and the heading's text. */
export function headingMarks(doc: Text, node: SyntaxNode): Span[] {
  const line = doc.lineAt(node.from);
  const spans: Span[] = [];
  let hiddenTo: number | undefined;
  for (const mark of node.getChildren("HeaderMark")) {
    let { from, to } = mark;
    if (hiddenTo === undefined) while (to < line.to && isBlank(doc, to)) to++;
    else while (from > hiddenTo && isBlank(doc, from - 1)) from--;
    spans.push({ from, to });
    hiddenTo = to;
  }
  return spans;
}

// What a run's text may hold: emphasis no blank at either edge, a
// superscript or subscript no blank at all, a code span any. None holds a
// line break, which would end it in a list item, a heading or at a blank line.
const FLANKED: RunRules = { lead: false, tail: false, blanks: true, lines: false };
const RUN_RULES: Readonly<Record<string, RunRules>> = {
  Superscript: { lead: false, tail: false, blanks: false, lines: false },
  Subscript: { lead: false, tail: false, blanks: false, lines: false },
  InlineCode: { lead: true, tail: true, blanks: true, lines: false },
};

const touching = (spans: readonly Span[], from: number, to: number) =>
  spans.some((span) => span.from <= to && span.to >= from);

// The markers a line's text starts after.
const MARKERS = new Set(["QuoteMark", "ListMark", "TaskMarker", "HeaderMark"]);

/** Where a note's formatting hides syntax: runs, escapes and a heading's
 * closing marks, and a line's quote, list, task and heading markers with the
 * blanks around them. A link's syntax shows at the caret, so it is none. */
export const noteSyntax: HiddenSyntax = {
  near(state: EditorState, from: number, to: number): HiddenNear {
    const { doc } = state;
    const shown = revealedSpans(state, [{ from: doc.lineAt(from).from, to: doc.lineAt(to).to }]);
    const near: HiddenNear = { runs: [], escapes: [], closings: [] };
    syntaxTree(state).iterate({
      from,
      to,
      enter(ref) {
        if (AS_WRITTEN.has(ref.name) || ref.name === "Wikilink") return false;
        const delimiter = RUN_DELIMITERS[ref.name];
        if (delimiter) {
          const marks = ref.node.getChildren(delimiter);
          const open = marks[0];
          const close = marks.at(-1);
          if (open && close && open !== close && !touching(shown, ref.from, ref.to)) {
            near.runs.push({
              name: ref.name,
              from: ref.from,
              to: ref.to,
              open: { from: open.from, to: open.to },
              close: { from: close.from, to: close.to },
              rules: RUN_RULES[ref.name] ?? FLANKED,
            });
          }
          return ref.name !== "InlineCode";
        }
        if (ref.name === "Escape") {
          if (!touching(shown, ref.from, ref.to)) near.escapes.push({ from: ref.from, to: ref.to });
          return false;
        }
        if (ref.name.startsWith("ATXHeading")) {
          const line = doc.lineAt(ref.from);
          if (touching(shown, line.from, line.to)) return;
          for (const span of headingMarks(doc, ref.node).slice(1)) if (span.from < span.to) near.closings.push(span);
        }
      },
    });
    return near;
  },

  prefix(state: EditorState, line: Line): LinePrefix | undefined {
    const { doc } = state;
    let end = line.from;
    let last: number | undefined;
    let reading = true;
    syntaxTree(state).iterate({
      from: line.from,
      to: line.to,
      enter(ref) {
        if (!reading || AS_WRITTEN.has(ref.name)) return false;
        if (!MARKERS.has(ref.name)) return;
        // A heading's closing marks and an underline are no line's markers.
        if (ref.from < line.from || (ref.name === "HeaderMark" && ref.from !== ref.node.parent?.from)) return false;
        if (doc.sliceString(end, ref.from).trim()) reading = false;
        else {
          end = ref.to;
          last = ref.from;
        }
        return false;
      },
    });
    if (last === undefined) return undefined;
    while (end < line.to && isBlank(doc, end)) end++;
    return { end, last };
  },
};
