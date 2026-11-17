// TeX's own math marks, `\(…\)` and `\[…\]` for display math, as model
// replies write them: a chat reply reads them as math, a note never does.
// Markdown writes `\[` to escape a bracket, so a note's math is `$` marks
// alone (docs/protocol.md's Text documents section). Without its closing
// mark, `\(` stays the escaped bracket it was.
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

const BACKSLASH = 92;
const CLOSING: Readonly<Record<number, number>> = { 40: 41, 91: 93 };

function parseTexMath(cx: InlineContext, next: number, pos: number): number {
  const closing = next === BACKSLASH ? CLOSING[cx.char(pos + 1)] : undefined;
  if (closing === undefined) return -1;
  for (let i = pos + 2; i < cx.end; i++) {
    if (cx.char(i) !== BACKSLASH) continue;
    if (cx.char(i + 1) !== closing) {
      i++;
      continue;
    }
    if (i === pos + 2) return -1;
    return cx.addElement(
      cx.elt("InlineMath", pos, i + 2, [cx.elt("MathMark", pos, pos + 2), cx.elt("MathMark", i, i + 2)]),
    );
  }
  return -1;
}

/** Over a grammar that already reads math's `$` marks, whose nodes these
 * reuse. */
export const texMathSyntax: MarkdownConfig = {
  parseInline: [{ name: "TexMath", parse: parseTexMath, before: "Escape" }],
};
