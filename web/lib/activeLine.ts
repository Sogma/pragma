// Marks the cursor's line as CodeMirror's own extension does, but only while
// nothing is selected. The mark's fill (codemirror.css) is a solid preset, and
// a line's background paints over the selection CodeMirror draws beneath the
// text, so during a selection it would hide the selection on that line.
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const mark = Decoration.line({ class: "cm-activeLine" });

function decorate(view: EditorView): DecorationSet {
  const { ranges } = view.state.selection;
  if (ranges.some((range) => !range.empty)) return Decoration.none;
  const marks = [];
  let last = -1;
  for (const range of ranges) {
    // The visual line's start: a range replaced across a line break joins
    // two lines into one.
    const { from } = view.lineBlockAt(range.head);
    if (from > last) marks.push(mark.range(from));
    last = from;
  }
  return Decoration.set(marks);
}

export const activeLineHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
