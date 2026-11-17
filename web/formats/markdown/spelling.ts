// What the spellchecker skips in a note: code, an address, a wikilink, HTML
// and a tag, by the reading of prose that finds tags
// (src/protocol/inlineTags.ts). A link's or image's label is the one
// exception, since it is prose a reader sees: only its address is skipped.
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { holdsProse, tagsInTree } from "../../../src/protocol/inlineTags.ts";
import { unchecked } from "../../lib/spellcheck.ts";

const LABELLED = new Set(["Link", "Image"]);

function skipped(view: EditorView): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const marks: Range<Decoration>[] = [];
  const skip = (from: number, to: number) => {
    if (from < to) marks.push(unchecked.range(from, to));
  };
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (LABELLED.has(node.name) || holdsProse(node.name)) return true;
        skip(Math.max(node.from, from), Math.min(node.to, to));
        return false;
      },
    });
    for (const tag of tagsInTree(tree, (a, b) => state.doc.sliceString(a, b), from, to)) skip(tag.from, tag.to);
  }
  return Decoration.set(marks, true);
}

export const markdownSpellcheckSkips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = skipped(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = skipped(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
