// `[[target]]` / `[[target|display]]` as one Markdown node, so the editor
// colors the whole wikilink. CommonMark has none: left alone, Lezer reads the
// inner `[target]` as a shortcut-reference Link and the outer brackets as
// text. The span matched is wikilinkPattern's — at least one character, no
// brackets inside — so the editor marks what the reading view links.
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

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
        if (end === pos + 2 || cx.char(end) !== CLOSE || cx.char(end + 1) !== CLOSE) return -1;
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
