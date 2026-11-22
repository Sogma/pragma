// The parts of a Format column edit that don't depend on the format's syntax:
// the edit's event, wrapping spans in marks, carrying the selection through,
// and the lines a selection touches. Every format's actions use these, so an
// edit treats a selection the same way in all of them.
import {
  type ChangeSet,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { Span } from "./shownSyntax.ts";

/** The userEvent every Format column edit is dispatched with. */
export const FORMAT_EVENT = "input.format";

/** Whether `span` holds `from` to `to`. A caret counts only strictly inside,
 * so one just past a closing mark has left it; a selection counts inside or
 * on the edges. */
export const holds = (span: Span, from: number, to: number): boolean =>
  from === to ? span.from < from && from < span.to : span.from <= from && to <= span.to;

/** `span` without the blanks at either end, empty when it is all blanks. */
export function trimmed(doc: Text, span: Span): Span {
  let { from, to } = span;
  while (from < to && /\s/.test(doc.sliceString(from, from + 1))) from++;
  while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

/** The changes that write `open` before each span and `close` after it. */
export function wrapping(spans: readonly Span[], open: string, close = open): ChangeSpec[] {
  return spans.flatMap(({ from, to }) => [
    { from, insert: open },
    { from: to, insert: close },
  ]);
}

/** A selection moved onto `span` once `changes` wrap it: its start after what
 * they insert there, its end before. Its head stays at the end it was on, so
 * the next Shift+arrow moves the end it moved before. */
export function selectWrapped(range: SelectionRange, changes: ChangeSet, span: Span): SelectionRange {
  const from = changes.mapPos(span.from, 1);
  const to = changes.mapPos(span.to, -1);
  return range.head === range.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}

/** A range carried through `changes`, kept on the text it covered. */
export function carried(range: SelectionRange, changes: ChangeSet): SelectionRange {
  return range.empty ? EditorSelection.cursor(changes.mapPos(range.head, 1)) : selectWrapped(range, changes, range);
}

/** The lines the selection touches, in order. A selection dragged through a
 * line's end stops at the next line's start, a line it doesn't touch. */
export function touchedLines(state: EditorState): Line[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(end).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map((number) => state.doc.line(number));
}
