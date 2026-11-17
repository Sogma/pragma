// Where a format's formatted view shows the syntax it otherwise hides, one
// rule for every format: each selection range while the editor has focus, a
// pending proposal's changes, so a removed `**` reads as removed, and find's
// matches while its card is open, so a match inside hidden syntax shows.
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { Decoration, type EditorView, type ViewUpdate } from "@codemirror/view";
import { pendingChanges } from "./editProposal.ts";
import type { TextHunk } from "./lineDiff.ts";

export interface Span {
  from: number;
  to: number;
}

/** Syntax a formatted view shows, drawn faint the same way in every format. */
export const syntaxMark = Decoration.mark({ class: "cm-shown-syntax" });

// Find's matches past this many on screen show no syntax of their own.
const MATCH_LIMIT = 1000;

/** Where syntax shows whatever the selection: a pending proposal's changes,
 * and find's matches within `ranges`. */
export function revealedSpans(state: EditorState, ranges: readonly Span[]): Span[] {
  const spans: Span[] = pendingChanges(state).map(({ from, to }) => ({ from, to }));
  const query = getSearchQuery(state);
  if (searchPanelOpen(state) && query.valid) {
    for (const { from, to } of ranges) {
      const matches = query.getCursor(state, from, to);
      for (let match = matches.next(), count = 0; !match.done && count < MATCH_LIMIT; match = matches.next(), count++) {
        spans.push(match.value);
      }
    }
  }
  return spans;
}

/** Where syntax shows on screen, the selection left out when `selection`
 * is false. */
export function shownSpans(view: EditorView, selection = true): Span[] {
  const { state } = view;
  const selected = selection && view.hasFocus ? state.selection.ranges.map(({ from, to }) => ({ from, to })) : [];
  return [...selected, ...revealedSpans(state, view.visibleRanges)];
}

const sameHunks = (a: readonly TextHunk[], b: readonly TextHunk[]) => a === b || (!a.length && !b.length);

/** Whether `update` may have moved what `shownSpans` finds. */
export function shownSpansChanged(update: ViewUpdate): boolean {
  const { startState: before, state } = update;
  const searching = searchPanelOpen(before) || searchPanelOpen(state);
  return (
    update.selectionSet ||
    update.focusChanged ||
    !sameHunks(pendingChanges(before), pendingChanges(state)) ||
    (searching &&
      (searchPanelOpen(before) !== searchPanelOpen(state) || getSearchQuery(before) !== getSearchQuery(state)))
  );
}
