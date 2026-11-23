import { isMap, isScalar, type Pair, type ParsedNode, parse, parseDocument, stringify, YAMLError } from "yaml";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

// The standard `---`-delimited YAML frontmatter convention (Jekyll, Hugo and
// most static site generators) — deliberately not a pragma-specific format,
// since space files should stay readable by other tools. Schema-less on purpose: this doesn't
// know about `tags`, `title`, or any other specific key — callers read
// whatever field they need off `data` themselves.
//
// Throws when the block doesn't parse, for a writer that must not guess at
// what it holds. A reader that only shows or filters uses the read below.
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const split = splitFrontmatter(content);
  if (split === undefined) return { data: {}, body: withoutBom(content) };
  return { data: parseFrontmatterYaml(split.yaml), body: split.body };
}

/** A document's frontmatter, read without throwing: a block that doesn't
 * parse holds no properties, and `error` says why. */
export function readFrontmatter(content: string): ParsedFrontmatter & { error?: string } {
  const split = splitFrontmatter(content);
  if (split === undefined) return { data: {}, body: withoutBom(content) };
  return { ...readFrontmatterYaml(split.yaml), body: split.body };
}

/** The properties a block's YAML holds: its top-level map, or `{}` for a
 * block holding none — empty, comments only, a list or a lone value. Throws
 * when the YAML doesn't parse. */
export function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  const parsed: unknown = parse(yaml);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** A block's properties, or `{}` and the parser's reason when it doesn't
 * parse, with the line of the file the reason points at. */
export function readFrontmatterYaml(yaml: string): { data: Record<string, unknown>; error?: string } {
  try {
    return { data: parseFrontmatterYaml(yaml) };
  } catch (error) {
    return { data: {}, error: yamlErrorReason(error) };
  }
}

// The parser counts lines from the block's first, which sits one below the
// opening `---`, so its line moves down one to name the file's.
function yamlErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "");
  const line = error instanceof YAMLError ? error.linePos?.[0].line : undefined;
  return line === undefined ? reason : `line ${line + 1}: ${reason}`;
}

/** A Markdown document's text without the byte order mark some editors put
 * first, which is no part of it: a reader looks past one, and a writer never
 * puts one back (docs/protocol.md's Frontmatter). */
export function withoutBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Whether `content` opens a frontmatter block: its first line is exactly
 * `---`, a byte order mark aside. */
export function opensFrontmatter(content: string): boolean {
  return /^---\r?\n/.test(withoutBom(content));
}

/** A Markdown document below its frontmatter, or the whole of it when it has
 * none, a byte order mark skipped either way. Cut without reading the block,
 * and a suffix of `content`. */
export function documentBody(content: string): string {
  return splitFrontmatter(content)?.body ?? withoutBom(content);
}

/** Where the `---` block ends, without reading what is in it — pure string
 * work, so it cannot throw on malformed YAML, for a caller that has no
 * business failing over a block it never reads. Undefined means no
 * frontmatter, by docs/protocol.md's rule. `body` is always a suffix of
 * `content`, so a caller reporting offsets can recover the difference.
 *
 * `gap` is the blank lines above the body, for an edit to write back as
 * they were. `yaml` excludes the line breaks around it whole, CRLF ones
 * included: a block written back between its own `---` lines must not gain
 * a stray `\r`. */
export function splitFrontmatter(content: string): { yaml: string; gap: string; body: string } | undefined {
  const text = withoutBom(content);
  const opening = /^---\r?\n/.exec(text);
  if (!opening) return undefined;
  const rest = text.slice(opening[0].length);
  const closing = /(?:^|\n)---(?:\r?\n|$)/.exec(rest);
  if (!closing) return undefined;

  const after = rest.slice(closing.index + closing[0].length);
  const gap = /^(?:\r?\n)*/.exec(after)?.[0] ?? "";
  return { yaml: rest.slice(0, closing.index).replace(/\r$/, ""), gap, body: after.slice(gap.length) };
}

/** A file from a block's YAML and the body below it, `gap` the blank lines
 * between them: one for a block Pragma creates, and for an edited block the
 * ones it already had. No YAML is no block. */
export function composeFrontmatter(yaml: string | undefined, body: string, gap = "\n"): string {
  if (yaml === undefined) return body;
  return `---\n${yaml}${yaml ? "\n" : ""}---\n${gap}${body}`;
}

/** `content` with its frontmatter edited to hold `next`, by the block rule
 * below, and returned as it is when the block already holds `next`. An
 * edited block keeps the blank lines after it; a new one gets one. Throws
 * when the block doesn't parse. */
export function editFrontmatter(content: string, next: Record<string, unknown>): string {
  const split = splitFrontmatter(content);
  const yaml = editFrontmatterYaml(split?.yaml, next);
  return yaml === split?.yaml ? content : composeFrontmatter(yaml, split?.body ?? withoutBom(content), split?.gap);
}

/** A block's YAML edited to hold `next`, every byte of a key `next` leaves
 * alone kept as written. A changed value is rewritten where it stands, a
 * removed key takes its own lines, a new key goes after the last, and one
 * key swapped for another holding the same value in its place is renamed.
 *
 * Keys `next` lists in another order move, each with the comment lines right
 * above it, as `sameKeyOrder` counts order.
 *
 * `undefined` is no block. A `next` with keys gets one; one with none drops
 * it, unless the block held none either, as a comments-only block doesn't.
 * Throws when `yaml` doesn't parse. */
export function editFrontmatterYaml(yaml: string | undefined, next: Record<string, unknown>): string | undefined {
  const held = yaml === undefined ? {} : parseFrontmatterYaml(yaml);
  if (sameFrontmatter(held, next) && sameKeyOrder(held, next)) return yaml;
  if (definedKeys(next).length === 0) return undefined;
  return (yaml === undefined ? undefined : spliceFrontmatter(yaml, held, next)) ?? stringify(next).slice(0, -1);
}

/** Whether two frontmatter values hold the same thing: maps compared key by
 * key in any order, and a key set to `undefined` counted absent, as YAML
 * writes it. */
export function sameFrontmatter(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameFrontmatter(item, b[i]))
    );
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = definedKeys(a);
  return keys.length === definedKeys(b).length && keys.every((key) => sameFrontmatter(a[key], b[key]));
}

/** Whether two blocks list their keys in the same order. A key that reads as
 * an array index never counts: an object lists it first wherever the file
 * wrote it, so its place can't be told, and is never moved. */
export function sameKeyOrder(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const order = (data: Record<string, unknown>) => definedKeys(data).filter((key) => !isIndexKey(key));
  const [x, y] = [order(a), order(b)];
  return x.length === y.length && x.every((key, i) => key === y[i]);
}

function isIndexKey(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function definedKeys(data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => data[key] !== undefined);
}

type BlockPair = Pair<ParsedNode, ParsedNode | null>;

interface Splice {
  from: number;
  to: number;
  text: string;
}

// Undefined sends the caller to writing the block afresh: a block that isn't
// a plain block map (`{a: 1}`, a complex key), or an edit that reads back
// as something other than `next`. An anchor another key aliases, an indented
// map, or a keep-chomped block scalar can each turn a splice into a
// different value, so the read-back is what makes the splice safe.
function spliceFrontmatter(
  yaml: string,
  held: Record<string, unknown>,
  next: Record<string, unknown>,
): string | undefined {
  const pairs = blockPairs(yaml);
  if (pairs === undefined) return undefined;
  const heldKeys = pairs.map((entry) => entry.key);
  const nextKeys = definedKeys(next);
  const removed = heldKeys.filter((key) => !nextKeys.includes(key));
  const added = nextKeys.filter((key) => !heldKeys.includes(key));
  const renamed =
    removed.length === 1 &&
    added.length === 1 &&
    heldKeys.indexOf(removed[0]) === nextKeys.indexOf(added[0]) &&
    sameFrontmatter(held[removed[0]], next[added[0]]);

  const splices: Splice[] = [];
  for (const { key, pair } of pairs) {
    if (renamed && key === removed[0]) {
      const text = inlineKey(added[0]);
      if (text === undefined) return undefined;
      splices.push({ from: pair.key.range[0], to: pair.key.range[1], text });
    } else if (removed.includes(key)) {
      splices.push(removal(yaml, pair));
    } else if (!sameFrontmatter(held[key], next[key])) {
      splices.push(rewrite(yaml, pair, key, next[key]));
    }
  }
  let edited = yaml;
  for (const { from, to, text } of splices.sort((a, b) => b.from - a.from)) {
    edited = edited.slice(0, from) + text + edited.slice(to);
  }
  // The block's last line keeps having no break after it. Pairs cut from the
  // end leave the break of the line above them, a blank line before the
  // closing `---`. It goes once every cut is made: taken with the last pair
  // instead, it would overlap the cut of a pair removed or rewritten above.
  if (!yaml.endsWith("\n") && edited.endsWith("\n")) edited = edited.slice(0, -1);
  if (!renamed && added.length) {
    const appended = appendPairs(edited, Object.fromEntries(added.map((key) => [key, next[key]])));
    if (appended === undefined) return undefined;
    edited = appended;
  }
  const reordered = reorderPairs(edited, next);
  if (reordered === undefined) return undefined;
  try {
    const back = parseFrontmatterYaml(reordered);
    return sameFrontmatter(back, next) && sameKeyOrder(back, next) ? reordered : undefined;
  } catch {
    return undefined;
  }
}

// Each movable pair's place is filled by the pair `next` lists there, which
// brings the comment lines right above it; everything else, an index key
// included, stays where it was. The block's last line keeps having no break.
function reorderPairs(yaml: string, next: Record<string, unknown>): string | undefined {
  const pairs = blockPairs(yaml);
  if (pairs === undefined) return undefined;
  const order = definedKeys(next).filter((key) => !isIndexKey(key));
  const slots = pairs.filter(({ key }) => !isIndexKey(key));
  if (slots.length !== order.length) return undefined;
  if (slots.every(({ key }, i) => key === order[i])) return yaml;
  const units = new Map<string, { start: number; end: number }>();
  let floor = 0;
  for (const { key, pair } of pairs) {
    const { start, end } = pairRegion(yaml, pair);
    units.set(key, { start: commentsAbove(yaml, start, floor), end });
    floor = end;
  }
  const lineBreak = yaml.includes("\r\n") ? "\r\n" : "\n";
  let out = "";
  let at = 0;
  for (const [i, { key }] of slots.entries()) {
    const slot = units.get(key);
    const unit = units.get(order[i]);
    if (!slot || !unit) return undefined;
    const text = yaml.slice(unit.start, unit.end);
    out += yaml.slice(at, slot.start) + (text.endsWith("\n") ? text : text + lineBreak);
    at = slot.end;
  }
  out += yaml.slice(at);
  return yaml.endsWith("\n") || !out.endsWith(lineBreak) ? out : out.slice(0, -lineBreak.length);
}

// Where the comment lines directly above `start` begin, no further up than
// `floor`. A blank line ends them, so a comment set apart at the top of the
// block stays there.
function commentsAbove(yaml: string, start: number, floor: number): number {
  while (start > floor) {
    const lineStart = yaml.lastIndexOf("\n", start - 2) + 1;
    if (lineStart < floor || !/^[ \t]*#/.test(yaml.slice(lineStart, start))) break;
    start = lineStart;
  }
  return start;
}

function blockPairs(yaml: string): { key: string; pair: BlockPair }[] | undefined {
  const { contents } = parseDocument(yaml);
  if (contents === null) return [];
  if (!isMap(contents) || contents.flow) return undefined;
  const pairs: { key: string; pair: BlockPair }[] = [];
  for (const pair of contents.items) {
    if (!isScalar(pair.key)) return undefined;
    pairs.push({ key: String(pair.key.value), pair });
  }
  return pairs;
}

// A pair's own lines: its key's line through its value's last, that line's
// comment and break included. A block value's range already ends past it.
function pairRegion(yaml: string, pair: BlockPair): { start: number; end: number } {
  const start = yaml.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
  const valueEnd = (pair.value ?? pair.key).range[1];
  if (yaml[valueEnd - 1] === "\n") return { start, end: valueEnd };
  const lineEnd = yaml.indexOf("\n", valueEnd);
  return { start, end: lineEnd === -1 ? yaml.length : lineEnd + 1 };
}

function removal(yaml: string, pair: BlockPair): Splice {
  const { start, end } = pairRegion(yaml, pair);
  return { from: start, to: end, text: "" };
}

// A one-line value over a one-line scalar replaces just the scalar, so its
// key and same-line comment stay as written; an anchored or tagged one
// doesn't, since its marks sit outside the scalar. Anything else rewrites
// the pair's lines whole.
function rewrite(yaml: string, pair: BlockPair, key: string, value: unknown): Splice {
  const old = pair.value;
  const inline = /^x: ([^\n]*)\n$/.exec(stringify({ x: value }))?.[1];
  if (inline !== undefined && isScalar(old) && !old.anchor && !old.tag) {
    const [from, to] = old.range;
    if (!yaml.slice(from, to).includes("\n")) {
      return { from, to, text: from === to && yaml[from - 1] === ":" ? ` ${inline}` : inline };
    }
  }
  const { start, end } = pairRegion(yaml, pair);
  const text = stringify({ [key]: value });
  return { from: start, to: end, text: yaml[end - 1] === "\n" ? text : text.slice(0, -1) };
}

function inlineKey(key: string): string | undefined {
  return /^([^\n]*): null\n$/.exec(stringify({ [key]: null }))?.[1];
}

// New keys go after the last pair, ahead of any comment closing the block;
// a block with no pairs takes them after its last line of text.
function appendPairs(yaml: string, data: Record<string, unknown>): string | undefined {
  const pairs = blockPairs(yaml);
  if (pairs === undefined) return undefined;
  const last = pairs.at(-1);
  const at = last ? pairRegion(yaml, last.pair).end : yaml.trimEnd().length;
  const text = stringify(data);
  const insert = at > 0 && yaml[at - 1] === "\n" ? text : `${at > 0 ? "\n" : ""}${text.slice(0, -1)}`;
  return yaml.slice(0, at) + insert + yaml.slice(at);
}

// The one frontmatter key pragma itself gives meaning to, on top of the
// schema-less parser above — see docs/architecture.md's Privacy
// section. Only `private` is acted on;
// `unlisted`/`public` are reserved vocabulary, with no anonymous-serving
// layer to enforce them against.
export function isPrivate(data: Record<string, unknown>): boolean {
  return data.visibility === "private";
}

/** Whether a document's content is kept from every model call: one marked
 * `visibility: private`, or one whose block doesn't parse, since nothing can
 * show that it isn't. The rule every privacy check made from a file's text
 * goes through. */
export function isPrivateDocument(content: string): boolean {
  const { data, error } = readFrontmatter(content);
  return error !== undefined || isPrivate(data);
}

/** A Markdown document's description: its `description` key, when that is
 * a non-empty string (docs/protocol.md's Descriptions). */
export function frontmatterDescription(data: Record<string, unknown>): string | undefined {
  const value = data.description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Frontmatter keys the properties editor and reading view treat as a *list*
// regardless of the value's shape — so a freshly created `tags` property
// gets the pill + add-tag UI immediately instead of a plain text input. A
// host-rendering hint only; the parser above stays schema-less. `tags` is
// the protocol-known field (docs/protocol.md's Tags → Sources).
const LIST_FRONTMATTER_KEYS = ["tags"] as const;

export function isListFrontmatterKey(key: string): boolean {
  return (LIST_FRONTMATTER_KEYS as readonly string[]).includes(key);
}

// The author's publication date: edited with a date picker, and sent to the
// publisher as the date a page is listed under. Distinct from `created`/
// `updated` (local file bookkeeping) and `pushed` (when pragma last sent it).
export const PUBLICATION_DATE_KEY = "date";

/** A copy's content without the keys a publish writes back, `id` and
 * `pushed`, so the copy's first publish makes a page of its own instead of
 * updating the original's. Undefined when it holds neither, or when its YAML
 * won't parse, which was never published, so it is copied as it stands. */
export function withoutPublishState(content: string): string | undefined {
  try {
    const { data } = parseFrontmatter(content);
    if (!("id" in data) && !("pushed" in data)) return undefined;
    const { id: _id, pushed: _pushed, ...rest } = data;
    return editFrontmatter(content, rest);
  } catch {
    return undefined;
  }
}

// The keys a publish writes back into a document's frontmatter, given what
// that frontmatter holds by the time it writes: `id` and `pushed` always, a
// first push's seeded `date` only where no date has been set meanwhile.
// Shared by the server's write-back and an editor applying the same write
// to its unsaved copy, so the two can't disagree over whose `date` wins.
export function publishWriteBackKeys(
  data: Record<string, unknown>,
  writeBack: { id: string; pushed: string; date?: string },
): Record<string, string> {
  return {
    ...(writeBack.date !== undefined && !(PUBLICATION_DATE_KEY in data)
      ? { [PUBLICATION_DATE_KEY]: writeBack.date }
      : {}),
    id: writeBack.id,
    pushed: writeBack.pushed,
  };
}
