// The display-title rule in docs/protocol.md's Display titles section, for a caller with no DOM: the
// plain text of a leading level-1 heading, and the body with that heading
// removed. The editor's own split (web/markdownRender.ts) builds its title
// through the renderer; this walks the same syntax tree down to a string, so
// `# **Draft** [one](a.md)` reads "Draft one" here as it does there.
//
// A note's opening, which a card shows where the note has no description, is
// read down to text the same way, and Add to Note's prepend lands where that
// body starts.
import type { SyntaxNode, Tree } from "@lezer/common";
import { GFM, parser, Subscript, Superscript } from "@lezer/markdown";
import { documentBody } from "./frontmatter.ts";
import { highlightSyntax } from "./highlightSyntax.ts";
import { leadingCommentsEnd, withoutComments } from "./markdownComments.ts";
import { isWikilinkNode, referenceLabel, wikilinkRawLabel } from "./markdownLinks.ts";
import { mathSyntax } from "./mathSyntax.ts";
import { splitWikilinkLabel, wikilinkPattern } from "./wikilink.ts";

// The editor's grammar, minus Emoji: an emoji shortcode is plain text either way.
const markdownParser = parser.configure([GFM, Subscript, Superscript, highlightSyntax, mathSyntax]);

const MARK_TYPES = [
  "HeaderMark",
  "QuoteMark",
  "TaskMarker",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "CodeMark",
  "SuperscriptMark",
  "SubscriptMark",
  "HighlightMark",
];

// Runs of ASCII blanks and line breaks fold to one space, as a Setext title's
// lines join. A no-break or other Unicode space is the writer's and stays.
const BLANKS = /[ \t\r\n]+/g;

// A title drops an inline HTML tag and keeps a picture's alt text. An excerpt
// keeps the tag as reading view shows it, so a `<placeholder>` in prose
// survives, and has no room for a picture. Neither keeps a comment, which
// reading view leaves out.
const TITLE_SKIPS = new Set([...MARK_TYPES, "HTMLTag", "Comment"]);
const EXCERPT_SKIPS = new Set([...MARK_TYPES, "Image", "Comment"]);

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Numeric entities and the common named ones. Any other named entity stays
// as written: decoding the full HTML table is a DOM's job, and a title that
// keeps `&hellip;` literally is still the right title.
function decodeEntity(raw: string): string {
  const numeric = /^&#(x?)([0-9a-f]+);$/i.exec(raw);
  if (numeric) {
    const code = Number.parseInt(numeric[2], numeric[1] ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  }
  return NAMED_ENTITIES[raw.slice(1, -1)] ?? raw;
}

function gapText(text: string): string {
  return text.replace(wikilinkPattern(), (_match, raw: string) => splitWikilinkLabel(raw).display);
}

// A link or image contributes only its label: the walk stops at the label's
// closing `]`, as the renderer's does, so a URL written inside the label
// is text rather than taken for the destination.
function inlineText(node: SyntaxNode, doc: string, skip: ReadonlySet<string>, labelOnly = false): string {
  let text = "";
  let pos = node.from;
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (isWikilinkNode(child, doc, pos)) {
      if (child.from - 1 > pos) text += gapText(doc.slice(pos, child.from - 1));
      text += splitWikilinkLabel(wikilinkRawLabel(child, doc)).display;
      pos = child.to + 1;
      continue;
    }
    if (child.from > pos) text += gapText(doc.slice(pos, child.from));
    if (labelOnly && child.name === "LinkMark" && ++marks === 2) return text;
    text += childText(child, doc, skip);
    pos = child.to;
  }
  if (pos < node.to) text += gapText(doc.slice(pos, node.to));
  return text;
}

// A title or an opening is read without the definitions that could make a
// reference-style link a link, so each reads as the text it is, brackets
// included, as the renderer reads one no definition names.
function referenceText(node: SyntaxNode, doc: string, skip: ReadonlySet<string>): string {
  let text = "";
  let pos = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark" || child.name === "LinkLabel") continue;
    if (child.from > pos) text += gapText(doc.slice(pos, child.from));
    text += childText(child, doc, skip);
    pos = child.to;
  }
  if (pos < node.to) text += gapText(doc.slice(pos, node.to));
  return text;
}

function childText(node: SyntaxNode, doc: string, skip: ReadonlySet<string>): string {
  if (skip.has(node.name)) return "";
  switch (node.name) {
    case "Escape":
      return doc.slice(node.from + 1, node.to);
    case "Entity":
      return decodeEntity(doc.slice(node.from, node.to));
    case "HardBreak":
      return " ";
    // Math reads as written, its marks included: its TeX is no prose to
    // strip, and a title edited back keeps the formula.
    case "InlineMath":
      return doc.slice(node.from, node.to);
    case "Autolink": {
      const url = node.getChild("URL");
      return url ? doc.slice(url.from, url.to) : "";
    }
    case "Link":
    case "Image":
      return referenceLabel(node, doc) === undefined
        ? inlineText(node, doc, skip, true)
        : referenceText(node, doc, skip);
    default:
      return inlineText(node, doc, skip);
  }
}

/** The heading a Markdown body's title is read from, by `parse`: its first
 * block when that is a level-1 heading, ATX or Setext, past any blocks of
 * comments alone. Only the text it can be in is parsed, since no heading runs
 * across a blank line, so a note edited whole re-reads it on a keystroke. */
export function titleHeadingNode(body: string, parse: (text: string) => Tree): SyntaxNode | undefined {
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = leadingCommentsEnd(body);
  const text = body.slice(0, blank.exec(body)?.index ?? body.length);
  let node = parse(text).topNode.firstChild;
  while (node?.name === "CommentBlock" && !withoutComments(text.slice(node.from, node.to)).trim()) {
    node = node.nextSibling;
  }
  return node?.name === "ATXHeading1" || node?.name === "SetextHeading1" ? node : undefined;
}

/** Splits a leading level-1 heading off a Markdown body that is already past
 * any frontmatter. `rest` is always a suffix of `body`, so the comments above
 * the heading go with it. A heading with no text is not a title and stays in
 * `rest`. */
export function splitTitleHeading(body: string): { title: string | undefined; rest: string } {
  const heading = titleHeadingNode(body, (text) => markdownParser.parse(text));
  const title = heading ? headingText(heading, body) : "";
  if (!heading || !title) return { title: undefined, rest: body };
  return { title, rest: body.slice(heading.to).replace(/^\n+/, "") };
}

/** Where a body's title heading lies, by the rule `splitTitleHeading` reads a
 * title by; undefined when the body has none. */
export function titleHeadingSpan(body: string): { from: number; to: number } | undefined {
  const heading = titleHeadingNode(body, (text) => markdownParser.parse(text));
  return heading && headingText(heading, body) ? { from: heading.from, to: heading.to } : undefined;
}

const headingText = (heading: SyntaxNode, body: string): string =>
  inlineText(heading, body, TITLE_SKIPS).replace(BLANKS, " ").trim();

/** A whole note's title heading and the prose after it, frontmatter skipped.
 * The frontmatter is cut without parsing it, so malformed YAML never costs a
 * note its title. */
export function splitNoteTitle(content: string): { title: string | undefined; body: string } {
  const afterFrontmatter = documentBody(content).replace(/^\n+/, "");
  const { title, rest } = splitTitleHeading(afterFrontmatter);
  return { title, body: rest };
}

/** A whole note with `text` added on lines of its own: at the end, or where
 * `splitNoteTitle`'s body starts, so the frontmatter and title stay above it.
 * Every byte already there is kept, the added lines take the note's line
 * breaks, and an empty `text` adds nothing. */
export function addTextToNote(content: string, text: string, mode: "prepend" | "append"): string {
  if (!text) return content;
  const lineBreak = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n?$/, "\n").replaceAll("\n", lineBreak);
  let at = content.length;
  if (mode === "prepend") {
    // The body is a suffix of the note. A CRLF note's body still opens with
    // the breaks after its title, and the text goes below them.
    at -= splitNoteTitle(content).body.length;
    at += /^[\r\n]*/.exec(content.slice(at))?.[0].length ?? 0;
  }
  const before = content.slice(0, at);
  const opening = before.replace(/^﻿/, "") && !before.endsWith("\n") ? lineBreak : "";
  return before + opening + lines + content.slice(at);
}

// A list or quote is read through to its items: its marks are no text.
const READ_THROUGH = new Set(["BulletList", "OrderedList", "ListItem", "Blockquote"]);

function isProse(name: string): boolean {
  return name === "Paragraph" || name === "Task" || name.startsWith("ATXHeading") || name.startsWith("SetextHeading");
}

/** A note's opening as plain text, after its frontmatter and title: a line
 * per paragraph, heading or list item, worded as reading view shows it but
 * for pictures. Code, tables, HTML blocks and comments are left out. Past
 * `maxChars` it ends at a word, with an ellipsis; undefined when no text is
 * left. */
export function noteExcerpt(content: string, maxChars: number): string | undefined {
  const { body } = splitNoteTitle(content);
  const lines: string[] = [];
  let length = 0;
  const read = (node: SyntaxNode): void => {
    for (let child = node.firstChild; child && length <= maxChars; child = child.nextSibling) {
      if (READ_THROUGH.has(child.name)) read(child);
      if (!isProse(child.name)) continue;
      const line = inlineText(child, body, EXCERPT_SKIPS).replace(BLANKS, " ").trim();
      if (!line) continue;
      lines.push(line);
      length += line.length + 1;
    }
  };
  read(markdownParser.parse(body).topNode);
  const text = lines.join("\n");
  if (text.length <= maxChars) return text || undefined;
  const cut = text.slice(0, maxChars);
  const whole = /\s/.test(text.charAt(maxChars)) ? cut : cut.replace(/\S*$/, "");
  return `${whole.trimEnd() || cut}…`;
}
