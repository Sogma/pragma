// An HTML comment in a Markdown document, `<!-- … -->`, says nothing the
// document says: reading view and a card's opening leave it out, a title
// reads past it (docs/protocol.md's Display title) and the editor draws it
// apart. One reading of where comments are, for each of them.

/** A comment's place in its document, `<!--` and `-->` included. */
export interface CommentSpan {
  from: number;
  to: number;
}

// `<!--` to the first `-->` after it, as Markdown ends one, `<!-->` and
// `<!--->` ending themselves; to the end of the text when nothing ends it, as
// a comment block left open runs to its end.
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/g;

/** The comments a node of a Markdown parse holds: an inline comment whole,
 * and each one a comment block holds. A block's last line may hold HTML
 * past them, which is no comment. */
export function commentsOf(
  node: { name: string; from: number; to: number },
  read: (from: number, to: number) => string,
): CommentSpan[] {
  if (node.name === "Comment") return [{ from: node.from, to: node.to }];
  if (node.name !== "CommentBlock") return [];
  return [...read(node.from, node.to).matchAll(COMMENT)].map((match) => ({
    from: node.from + match.index,
    to: node.from + match.index + match[0].length,
  }));
}

/** A comment block's text with its comments taken out: the HTML it holds
 * past them, or only blanks. */
export function withoutComments(text: string): string {
  return text.replace(COMMENT, "");
}

/** Where the comment blocks a Markdown body opens with end, the blank lines
 * among them skipped: the start of its first other block, or the body's end
 * while a comment is still open. A comment block starts on a line opening
 * with `<!--`, indented less than code, and ends on the first line holding
 * `-->`, whatever else that line holds. */
export function leadingCommentsEnd(body: string): number {
  const blankLines = /(?:[ \t]*\r?\n)*/y;
  let pos = 0;
  for (;;) {
    blankLines.lastIndex = pos;
    blankLines.exec(body);
    pos = blankLines.lastIndex;
    if (!/^ {0,3}<!--/.test(body.slice(pos, pos + 7))) return pos;
    const close = body.indexOf("-->", pos);
    const end = close === -1 ? -1 : body.indexOf("\n", close);
    if (end === -1) return body.length;
    pos = end + 1;
  }
}
