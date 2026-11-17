// The selected text in an editor, marked on the text itself. CodeMirror draws
// its selection on a layer beneath the text, where a fill a format draws on
// its text or line (inline code, a code block) hides it; the mark's own fill
// (selection.css) paints over theirs.
import { Prec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

const mark = Decoration.mark({ class: "cm-selected-text" });

/** Each selected range's text, focused or not, as CodeMirror's layer is.
 * Highest precedence makes the mark the innermost element, split by the
 * formats' marks rather than splitting them: a split code span would draw
 * its padding twice, mid-word. */
export const selectedTextMark = Prec.highest(
  EditorView.decorations.compute(["selection"], (state) =>
    Decoration.set(
      state.selection.ranges.filter((range) => !range.empty).map((range) => mark.range(range.from, range.to)),
    ),
  ),
);

/** Settings → Editor → Bright selection, as a class on the root, which
 * selection.css keys its colours on. */
export function applyBrightSelection(on: boolean): void {
  document.documentElement.classList.toggle("bright-selection", on);
}
