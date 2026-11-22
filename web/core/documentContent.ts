// A text document's parts as the editor holds them: the title bar's heading,
// the properties and the body, split on load and put back together on save;
// also its display title, its file's name read as a title, and its word count.
import {
  composeFrontmatter,
  readFrontmatterYaml,
  splitFrontmatter,
  withoutBom,
} from "../../src/protocol/frontmatter.ts";
import { splitNoteTitle } from "../../src/protocol/markdownTitle.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import type { DocumentType } from "../../src/protocol/types.ts";
import { countText } from "../lib/dom.ts";
import { splitLeadingHeading } from "../markdownRender.ts";
import type { ActiveTitle, FileResponse, TextFileResponse } from "./apiClient.ts";
import { stripExtension } from "./paths.ts";

// A title bar's state for the file at `path`, from its display title: `text`
// is the title (empty when it has none), `placeholder` the filename, shown
// grey until a title is set. Every kind's title bar takes it, so a title of
// the document's own always reads apart from the filename standing in.
export function activeTitleFor(title: string | undefined, path: string): ActiveTitle {
  return { text: title ?? "", placeholder: stripExtension(basenameOf(path)) };
}

// English words a title leaves lowercase between its first and last word.
const MINOR_WORDS = new Set("a an and as at but by for in nor of on or the to via vs".split(" "));

/** A file's name read as a title: `music-references` reads "Music References".
 * A dash or underscore is a space, except a dash between digits, so a date
 * stays one. A lowercase word takes a capital, unless it is a minor word inside
 * the title or opens with a digit (`2nd`); a word with a capital already, such
 * as `iPhone`, keeps its casing. */
export function titleFromName(name: string): string {
  const words = name
    .replace(/_|(?<!\d)-|-(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const last = words.length - 1;
  return words
    .map((word, at) =>
      word !== word.toLowerCase() || (at > 0 && at < last && MINOR_WORDS.has(word))
        ? word
        : word.replace(/^[^\p{L}\p{N}]*\p{L}/u, (start) => start.toUpperCase()),
    )
    .join(" ");
}

// A note's title bar, unless its block doesn't parse: the heading
// then stays in the body below that block, and a title typed above the block
// would push it out of the frontmatter position.
export function titleBarOf(
  documentType: DocumentType,
  split: { title: string | undefined; frontmatterError: string | undefined },
  path: string,
): ActiveTitle | undefined {
  return documentType === "note" && split.frontmatterError === undefined
    ? activeTitleFor(split.title, path)
    : undefined;
}

/** A note's leading heading as its file holds it: the title it reads as, and
 * its lines with the line breaks after them, exactly, `lead` first: the
 * comments above it, which stay when the title changes. */
export interface ReadHeading {
  text: string;
  heading: string;
  lead: string;
}

/** A text document as the editor holds it: the body, and what is lifted out
 * above it, the frontmatter and a note's leading heading. */
export interface DocumentParts {
  properties: Record<string, unknown> | undefined;
  frontmatter: string | undefined;
  frontmatterError: string | undefined;
  gap?: string;
  body: string;
  lineOffset: number;
  title: string | undefined;
  read?: ReadHeading;
}

// Recomposes the full file content from the editor's body-only doc, the
// title bar's heading, and the frontmatter block's YAML and gap. Every save
// path and the reading-view render need this, not the raw CodeMirror doc,
// which for a note is no longer the whole file. A screenplay or
// the empty state passes neither title nor block and gets `doc` back.
export function composeDocumentContent(
  doc: string,
  title: string | undefined,
  frontmatter: string | undefined,
  read?: ReadHeading,
  gap?: string,
): string {
  return composeDocumentHead(title, frontmatter, read, gap, doc !== "") + doc;
}

/** The text above a note's body: the frontmatter block and the blank lines
 * after it, or with no block the blank lines the file opens with, then the
 * title's heading. */
export function composeDocumentHead(
  title: string | undefined,
  frontmatter: string | undefined,
  read: ReadHeading | undefined,
  gap: string | undefined,
  bodyFollows: boolean,
): string {
  const heading = titleHeading(title, read, bodyFollows);
  return frontmatter === undefined ? `${gap ?? ""}${heading}` : composeFrontmatter(frontmatter, heading, gap);
}

/** What stands for the title above the body: the heading as the file held it
 * while the title still reads as it did, so a save never reformats a title
 * nobody edited; else `# title`, written to read back as typed, below the
 * comments the file held above the heading. A blank title writes no heading,
 * only those comments. */
export function titleHeading(title: string | undefined, read: ReadHeading | undefined, bodyFollows: boolean): string {
  const trimmed = title?.trim();
  const lead = read?.lead ?? "";
  if (!trimmed) return lead;
  if (read?.text === trimmed) {
    return read.heading.endsWith("\n") || !bodyFollows ? read.heading : `${read.heading}\n\n`;
  }
  return `${lead}# ${headingText(trimmed)}\n\n`;
}

// A typed title as heading text that reads back as exactly that title: as
// typed where it already does, else with its ASCII punctuation escaped,
// which Markdown always reads as itself. A title is one line.
function headingText(title: string): string {
  const line = title.replace(/\s*\n\s*/g, " ");
  if (splitLeadingHeading(`# ${line}`).title === line) return line;
  return line.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

// The inverse of the compose above: derives the working frontmatter data and
// the body CodeMirror holds from a freshly fetched file. Only a note
// is split, and it always yields a (possibly empty) properties
// object so "+ Add property" works without a frontmatter block; a screenplay
// comes back with `properties` undefined and `body` the untouched content.
//
// `frontmatter` is the block's YAML as written, so a save can keep every
// line no edit touched, and `gap` the blank lines after it. Their line
// breaks are "\n", as the rest of a saved document's are.
//
// A block that doesn't parse is left in the body, as written, with no
// properties or title lifted and `frontmatterError` saying why: the text is
// the only place it can be fixed, and a title composed above it would push
// it out of the frontmatter position.
export function splitDocumentProperties(file: Pick<TextFileResponse, "documentType" | "content">): DocumentParts {
  const whole = { properties: undefined, frontmatter: undefined, body: file.content, lineOffset: 0, title: undefined };
  if (file.documentType !== "note") return { ...whole, frontmatterError: undefined };
  const split = splitFrontmatter(file.content);
  const { data, error } = split ? readFrontmatterYaml(split.yaml) : { data: {}, error: undefined };
  if (error !== undefined) return { ...whole, body: withoutBom(file.content), frontmatterError: error };
  const body = split ? split.body : withoutBom(file.content);
  // The blank lines after a block, or with none the ones the file opens
  // with, are set aside as the gap, so CodeMirror's first line is never an
  // empty one, and composing writes them back as they were.
  const trimmedBody = body.replace(/^\n+/, "");
  // A leading `# Heading`, with any comments above it, is lifted into the
  // editor title bar the same way the frontmatter above is lifted into the
  // properties panel — the CodeMirror doc holds neither. `rest` stays a
  // suffix of `file.content` (only ever a prefix is removed), so the
  // lineOffset math below is unchanged.
  const { title, lead, rest } = splitLeadingHeading(trimmedBody);
  // How many file lines precede CodeMirror's line 1 — fed to the gutter's
  // custom line numbers so it shows the document's real line numbers, not a
  // restart at 1 after the stripped frontmatter and title. Counting newlines
  // in the stripped prefix is exact because `rest` is always a suffix of
  // `file.content`.
  const prefix = file.content.slice(0, file.content.length - rest.length);
  const lineOffset = (prefix.match(/\n/g) ?? []).length;
  const frontmatter = split?.yaml.replace(/\r\n?/g, "\n");
  const gap = split ? split.gap.replace(/\r\n/g, "\n") : body.slice(0, body.length - trimmedBody.length);
  const heading = trimmedBody.slice(0, trimmedBody.length - rest.length).replace(/\r\n?/g, "\n");
  const read = title === undefined ? undefined : { text: title, heading, lead: lead.replace(/\r\n?/g, "\n") };
  return { properties: data, frontmatter, frontmatterError: undefined, gap, body: rest, lineOffset, title, read };
}

/** A note's parts split from text the editor holds whole, as Source mode
 * does, composing back to exactly that text: split as a file is on load, or
 * kept whole as the body while it is text a save would not write back as is,
 * such as a closing `---` with no line break after it. */
export function splitExactly(file: Pick<TextFileResponse, "documentType" | "content">): DocumentParts {
  const parts = splitDocumentProperties(file);
  const back = composeDocumentContent(parts.body, parts.title, parts.frontmatter, parts.read, parts.gap);
  if (back === file.content) return parts;
  return {
    properties: {},
    frontmatter: undefined,
    frontmatterError: undefined,
    body: file.content,
    lineOffset: 0,
    title: undefined,
  };
}

// A document's own title, per docs/protocol.md's Display titles section, or
// undefined where the rule falls back to the file's name.
export function displayTitleOf(file: FileResponse): string | undefined {
  switch (file.kind) {
    case "text":
      return file.documentType === "note" ? splitNoteTitle(file.content).title : undefined;
    case "applet":
      return file.manifest.meta?.name || undefined;
    default:
      return file.name || undefined;
  }
}

// Keeps a scalar frontmatter value's YAML type stable across an edit: the
// properties panel edits every scalar as a string, so re-typing "5" would
// write a quoted string where a number stood.
// Deliberately narrow: only number/boolean literals round-trip; anything
// else (the string "null" included) stays as typed.
export function coerceScalarPropertyValue(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "number" || typeof parsed === "boolean") return parsed;
  } catch {
    // Not JSON — the raw string is the value.
  }
  return raw;
}

// Words = whitespace-delimited runs, so fountain and markdown syntax chars
// like `#`/`*` count as part of whatever word they're attached to, never
// stripped. Characters counts everything in the string, spaces included,
// the more common "character count" convention.
export function countWordsAndChars(text: string): { words: number; chars: number } {
  const trimmed = text.trim();
  return { words: trimmed === "" ? 0 : trimmed.split(/\s+/).length, chars: text.length };
}

/** A count in the status bar's words, which a previewed note's bar repeats
 * so the two never disagree. `wordsOnly` for a bar too narrow for both. */
export function formatWordCount({ words, chars }: { words: number; chars: number }, wordsOnly = false): string {
  const counted = countText(words, "word");
  return wordsOnly ? counted : `${counted} · ${countText(chars, "character")}`;
}
