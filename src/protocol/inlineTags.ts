// docs/protocol.md's Tags: a tag written in a note's text as `#name`. One
// reading, for the host's index, reading view and the editor, so what the
// editor draws as a tag is what Search finds by it. Markdown only: in
// Fountain, `#` opens a section.
import type { Tree } from "@lezer/common";
import { isTagName, TAG_NAME_CHARACTER } from "./tags.ts";

/** A tag written in a note: its name as written, without the `#`, and where
 * it sits, `#` included. */
export interface InlineTag {
  name: string;
  from: number;
  to: number;
}

// A `#` and every tag name character that follows it.
const TAG = new RegExp(`#(${TAG_NAME_CHARACTER.source}+)`, "g");

// A `#` in these is never a tag: code, math, a link, wikilink or URL, and HTML.
const NOT_PROSE = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "InlineMath",
  "BlockMath",
  "Link",
  "Image",
  "URL",
  "Autolink",
  "Wikilink",
  "LinkReference",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
]);

/** Whether a Markdown node's text can hold a tag. */
export function holdsProse(nodeName: string): boolean {
  return !NOT_PROSE.has(nodeName);
}

/** The tags in `text`, a run of prose that starts at `from` in its document,
 * `before` being the character ahead of it, "" at the start. A tag starts its
 * line or follows whitespace, and what follows its `#` is a tag's name. */
export function tagsInProse(text: string, from: number, before: string): InlineTag[] {
  const tags: InlineTag[] = [];
  for (const match of text.matchAll(TAG)) {
    const previous = match.index === 0 ? before : text[match.index - 1];
    if ((previous !== "" && !/\s/.test(previous)) || !isTagName(match[1])) continue;
    tags.push({ name: match[1], from: from + match.index, to: from + match.index + match[0].length });
  }
  return tags;
}

/** The tags written between `from` and `to` in a Markdown document, by
 * `tree`, its parse, with `read` giving the document's text in a range. */
export function tagsInTree(
  tree: Tree,
  read: (from: number, to: number) => string,
  from = 0,
  to = tree.length,
): InlineTag[] {
  const tags: InlineTag[] = [];
  let pos = from;
  const prose = (end: number) => {
    if (end > pos) tags.push(...tagsInProse(read(pos, end), pos, pos === 0 ? "" : read(pos - 1, pos)));
  };
  tree.iterate({
    from,
    to,
    enter(node) {
      if (holdsProse(node.name)) return true;
      prose(Math.min(node.from, to));
      pos = Math.max(pos, node.to);
      return false;
    },
  });
  prose(to);
  return tags;
}
