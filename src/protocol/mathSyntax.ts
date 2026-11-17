// Math by docs/protocol.md's Text documents section: TeX between `$` marks,
// or between `$$` marks as display math, inline or as a block of its own.
// Shared by the editor, reading view, the title rule and the host's link and
// tag index, so each reads the same math and none finds a link or a tag in it.
//
// The rules are the common Markdown ones, so notes from other editors read
// the same, but for a `$` right after `{{`, which is a placeholder's, as in
// `{{$date}}`, and never opens math.
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

const DOLLAR = 36;
const BACKSLASH = 92;
const BRACE = 123;
const SPACE = 32;
const TAB = 9;

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB || code === 10 || code === 13 || code === -1;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isPlaceholderMark(cx: InlineContext, pos: number): boolean {
  return cx.char(pos - 1) === BRACE && cx.char(pos - 2) === BRACE;
}

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR || isPlaceholderMark(cx, pos)) return -1;
  const display = cx.char(pos + 1) === DOLLAR;
  const from = pos + (display ? 2 : 1);
  if (!display && isBlank(cx.char(from))) return -1;
  for (let i = from; i < cx.end; i++) {
    const code = cx.char(i);
    if (code === BACKSLASH) {
      i++;
      continue;
    }
    if (code !== DOLLAR || isPlaceholderMark(cx, i)) continue;
    if (display ? cx.char(i + 1) !== DOLLAR : isBlank(cx.char(i - 1)) || isDigit(cx.char(i + 1))) continue;
    if (i === from) return -1;
    const to = i + (display ? 2 : 1);
    return cx.addElement(cx.elt("InlineMath", pos, to, [cx.elt("MathMark", pos, from), cx.elt("MathMark", i, to)]));
  }
  return -1;
}

// Where a line's opening `$` run ends when the line opens a block: two marks
// or more, indented less than code, and no other `$` after them.
function blockOpening(line: Line): number {
  if (line.next !== DOLLAR || line.indent - line.baseIndent >= 4) return -1;
  let end = line.pos;
  while (line.text.charCodeAt(end) === DOLLAR) end++;
  return end - line.pos < 2 || line.text.includes("$", end) ? -1 : end;
}

// Where `text` ends before the blanks closing it, a CRLF file's `\r`
// among them: Lezer keeps it on the line.
function trimmedEnd(text: string, from: number, to: number): number {
  while (to > from && isBlank(text.charCodeAt(to - 1))) to--;
  return to;
}

// The closing run on a line holding `$` only at its end: as long as the
// opening one at least, after any TeX the line holds.
function closingRun(text: string, from: number, length: number): { from: number; to: number } | undefined {
  const to = trimmedEnd(text, from, text.length);
  let run = to;
  while (run > from && text.charCodeAt(run - 1) === DOLLAR) run--;
  return to - run >= length && text.indexOf("$", from) === run ? { from: run, to } : undefined;
}

function addText(children: Element[], cx: BlockContext, text: string, from: number, to: number): void {
  const end = trimmedEnd(text, from, to);
  if (from < end) children.push(cx.elt("MathText", cx.lineStart + from, cx.lineStart + end));
}

// The public Line has no count of the containers it is inside. Lezer's own
// fenced code reads the same field to end with the quote or list item
// holding it, and a test pins that.
function containerDepth(line: Line): number {
  return (line as Line & { depth: number }).depth;
}

// A block runs to its closing line, blank lines included, or to the end of
// its container when none comes, as fenced code does. Each line's TeX past
// the opening run's indent is a MathText, without its container's marks.
function parseBlockMath(cx: BlockContext, line: Line): boolean {
  const end = blockOpening(line);
  if (end < 0) return false;
  const from = cx.lineStart + line.pos;
  const length = end - line.pos;
  const indent = line.indent - line.baseIndent;
  const children: Element[] = [cx.elt("MathMark", from, cx.lineStart + end)];
  addText(children, cx, line.text, line.skipSpace(end), line.text.length);
  while (cx.nextLine() && containerDepth(line) >= cx.depth) {
    children.push(...line.markers);
    let start = line.basePos;
    while (start - line.basePos < indent && line.text.charCodeAt(start) === SPACE) start++;
    const close = closingRun(line.text, start, length);
    if (close) {
      addText(children, cx, line.text, start, close.from);
      children.push(cx.elt("MathMark", cx.lineStart + close.from, cx.lineStart + close.to));
      cx.nextLine();
      break;
    }
    addText(children, cx, line.text, start, line.text.length);
  }
  cx.addElement(cx.elt("BlockMath", from, cx.prevLineEnd(), children));
  return true;
}

export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    "InlineMath",
    { name: "BlockMath", block: true },
    { name: "MathMark", style: tags.processingInstruction },
    "MathText",
  ],
  parseInline: [{ name: "InlineMath", parse: parseInlineMath }],
  parseBlock: [
    {
      name: "BlockMath",
      parse: parseBlockMath,
      endLeaf: (_cx, line) => blockOpening(line) >= 0,
      after: "FencedCode",
    },
  ],
};

/** The TeX an InlineMath or BlockMath node holds, a block's lines joined,
 * and whether it is display math: a block, or inline between `$$` marks, or
 * TeX's `\[` ones where a chat reply reads them. */
export function readMath(
  node: SyntaxNode,
  read: (from: number, to: number) => string,
): { tex: string; display: boolean } {
  if (node.name === "BlockMath") {
    return {
      tex: node
        .getChildren("MathText")
        .map((text) => read(text.from, text.to))
        .join("\n"),
      display: true,
    };
  }
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open === close) return { tex: "", display: false };
  const mark = read(open.from, open.to);
  return { tex: read(open.to, close.from), display: mark === "$$" || mark === "\\[" };
}
