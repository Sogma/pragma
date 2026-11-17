// `==text==`, a highlight as other Markdown apps write it, parsed as one node
// between its two delimiters by GFM's strikethrough rules. Shared by the
// editor, reading view and the title rule (markdownTitle.ts), so each reads
// the same `==` as a highlight.
import { tags } from "@lezer/highlight";
import type { DelimiterType, MarkdownConfig } from "@lezer/markdown";

const EQUALS = 61; // "="

const HIGHLIGHT: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

// Punctuation and symbols, by which CommonMark's flanking rules decide
// whether a delimiter can open or close.
const PUNCTUATION = /[\p{P}\p{S}]/u;

export const highlightSyntax: MarkdownConfig = {
  defineNodes: ["Highlight", { name: "HighlightMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctuationBefore = PUNCTUATION.test(before);
        const punctuationAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HIGHLIGHT,
          pos,
          pos + 2,
          !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore),
          !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};
