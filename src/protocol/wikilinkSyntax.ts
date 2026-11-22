// `[[target]]` / `[[target|display]]` as one Markdown node, which every reader
// parses with: the editor, reading view, backlinks, renames and titles, so
// none takes for a link what another takes for text.
//
// CommonMark has none: left alone, Lezer reads the inner `[target]` as a
// shortcut-reference Link, the outer brackets as text, and an address inside
// as a web link. A wikilink holds no bracket, and names a target: `[[ ]]` and
// `[[|shown]]` are text.
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { splitWikilinkLabel } from "./wikilink.ts";

const OPEN = 91; // "["
const CLOSE = 93; // "]"

export const wikilinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink", style: { "Wikilink/...": tags.link } },
    { name: "WikilinkMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Wikilink",
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
        let end = pos + 2;
        while (end < cx.end && cx.char(end) !== OPEN && cx.char(end) !== CLOSE) end++;
        if (cx.char(end) !== CLOSE || cx.char(end + 1) !== CLOSE) return -1;
        if (!splitWikilinkLabel(cx.slice(pos + 2, end)).target) return -1;
        return cx.addElement(
          cx.elt("Wikilink", pos, end + 2, [
            cx.elt("WikilinkMark", pos, pos + 2),
            cx.elt("WikilinkMark", end, end + 2),
          ]),
        );
      },
      // Link's own parser would otherwise claim the first "[".
      before: "Link",
    },
  ],
};

/** A Wikilink node's text between its brackets. */
export function wikilinkLabel(node: { from: number; to: number }, doc: string): string {
  return doc.slice(node.from + 2, node.to - 2);
}
