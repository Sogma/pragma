// Every reference a Markdown document makes to another file, located in the
// source text. Parsed, not regex-scanned: a fenced block or inline code
// produces no Link node, so `[[x]]` inside one is never taken for a
// reference. Markdown only — Fountain spells its Notes `[[...]]` too, and a
// screenplay's "[[cut this?]]" is prose, not a link.
import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/markdown";
import { documentBody } from "./frontmatter.ts";
import { type InlineTag, tagsInTree } from "./inlineTags.ts";
import { mathSyntax } from "./mathSyntax.ts";
import type { PathForm } from "./relativeReference.ts";

// Math holds no reference: `$[[0,1]]$` is an interval, never a link.
const markdownParser = parser.configure([mathSyntax]);

/** True when `child` is the inner `[target]` of a `[[target]]` /
 * `[[target|display]]` wikilink: a bare shortcut-reference Link (no URL)
 * wrapped in one extra `[` before and `]` after. `pos` is the caller's
 * cursor — the extra `[` must be *unclaimed*, so a preceding sibling ending
 * exactly at `child.from` makes this decline.
 *
 * Shared with the reading-view renderer so the two never disagree about what
 * counts as a wikilink. */
export function isWikilinkNode(child: SyntaxNode, doc: string, pos: number): boolean {
  const url = child.getChild("URL");
  return (
    child.name === "Link" &&
    url === null &&
    child.from > pos &&
    doc.charAt(child.from - 1) === "[" &&
    doc.charAt(child.to) === "]"
  );
}

/** The label span of a wikilink's Link node — `child.from`/`child.to` minus
 * the one-character `[`/`]` the Link node itself owns; the *outer* wikilink
 * brackets sit one further out again. */
export function wikilinkRawLabel(child: SyntaxNode, doc: string): string {
  return doc.slice(child.from + 1, child.to - 1);
}

/** A reference-style Link or Image node's label, folded as
 * `foldReferenceLabel` folds a definition's: the second bracket pair's, else
 * the link text's own (`[text][]`, `[text]`). Undefined for an inline link,
 * whose destination is in parentheses. The parser reads any bracket pair as
 * a link, so a label no definition names must read as the text it is. */
export function referenceLabel(node: SyntaxNode, doc: string): string | undefined {
  const marks = node.getChildren("LinkMark");
  if (marks.length !== 2) return undefined;
  const label = node.getChild("LinkLabel");
  const named = label && label.to - label.from > 2;
  return foldReferenceLabel(named ? doc.slice(label.from + 1, label.to - 1) : doc.slice(marks[0].to, marks[1].from));
}

/** CommonMark matches a label to its definition ignoring case and runs of
 * whitespace. Upper-casing the lower case folds what lower-casing alone
 * misses (`ß` and `SS`), as commonmark.js does. */
export function foldReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
}

export interface MarkdownReference {
  /** A `[[target]]`, or the destination of a link, image, or reference
   * definition. The two are rewritten differently — a wikilink names a file
   * from the space root, a url names one relative to the document. */
  kind: "wikilink" | "url";
  /** The span a rewrite replaces: a wikilink's target half only, never its
   * display text; a url's own characters, never the `<>` or the title
   * beside it. */
  from: number;
  to: number;
  /** The text between `from` and `to`, exactly as written. */
  raw: string;
  /** True for the destination of an `![alt](path)` embed. A link and an
   * image share one URL node, so anything that rewrites only one of them —
   * publishing swaps an embed for an uploaded file's URL and must leave
   * prose links untouched — has nothing else to tell them apart by. */
  isImage: boolean;
}

/** Locates every reference in `text`, in source order. A `URL` node covers
 * inline links, images, and `[ref]: path` definitions alike; an
 * angle-bracketed destination (`<./a file.md>`) reports the span inside the
 * brackets, so a rewrite leaves them in place.
 *
 * Frontmatter is cut off before parsing — a Markdown parser would read a
 * YAML flow sequence (`tags: [[a, b]]`) as a wikilink — and offsets are still
 * reported against the whole document. */
export function findMarkdownReferences(text: string): MarkdownReference[] {
  return referencesIn(parseBody(text));
}

interface ParsedBody {
  body: string;
  offset: number;
  tree: Tree;
}

// Split, never parsed: what the YAML *means* is no business of this module's,
// and reading it would make a malformed block throw here. `body` is always a
// suffix of `text`, so the difference in length is where it starts.
function parseBody(text: string): ParsedBody {
  const body = documentBody(text);
  return { body, offset: text.length - body.length, tree: markdownParser.parse(body) };
}

function referencesIn({ body, offset, tree }: ParsedBody): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  tree.iterate({
    enter: (ref) => {
      if (ref.name === "URL") {
        const angled = body.charAt(ref.from) === "<" && body.charAt(ref.to - 1) === ">";
        const from = angled ? ref.from + 1 : ref.from;
        const to = angled ? ref.to - 1 : ref.to;
        references.push({
          kind: "url",
          from: from + offset,
          to: to + offset,
          raw: body.slice(from, to),
          // The parent is Image for an embed, Link for an inline link, and
          // LinkReference for a `[ref]: path` definition. A thumbnail
          // wrapped in a link nests one inside the other, and reading the
          // immediate parent still gives each its own answer.
          isImage: ref.node.parent?.name === "Image",
        });
        return false;
      }

      if (ref.name !== "Link") return true;

      const node = ref.node;
      const previous = node.prevSibling;
      const pos = previous ? previous.to : (node.parent?.from ?? 0);
      if (!isWikilinkNode(node, body, pos)) return true;

      // The target is everything before the first `|`; the display half
      // after it is the author's and is left untouched by a rewrite.
      const labelFrom = node.from + 1;
      const label = wikilinkRawLabel(node, body);
      const pipe = label.indexOf("|");
      const to = labelFrom + (pipe === -1 ? label.length : pipe);
      references.push({
        kind: "wikilink",
        from: labelFrom + offset,
        to: to + offset,
        raw: body.slice(labelFrom, to),
        // No `![[embed]]` form exists in pragma's Markdown, so a wikilink
        // never names an image (docs/protocol.md's Links section).
        isImage: false,
      });
      return false;
    },
  });

  return references;
}

/** One link a note makes to a file, as its Links tab lists it. */
export interface NoteLink {
  form: PathForm;
  /** The path as written, between `from` and `to`. */
  raw: string;
  from: number;
  to: number;
}

const NOT_A_PATH = /^(?!(?:lib|space):)[A-Za-z][A-Za-z0-9+.-]*:|^\/\/|^#/;

/** Whether a Markdown link's destination is a path, a `lib:` or `space:` one
 * included, and not a web link, `mailto:` and the like, or a bare `#anchor`. */
export function isPathDestination(destination: string): boolean {
  return !NOT_A_PATH.test(destination.trim());
}

/** What a note links to: its wikilinks and its Markdown links to paths, in
 * source order. An embed is left out, since the page shows it, and so are a
 * web link and a bare `#anchor`. The Links tab and the host's backlinks both
 * read a note this way, so the two can't disagree. */
export function noteLinks(text: string): NoteLink[] {
  return linksIn(findMarkdownReferences(text));
}

function linksIn(references: readonly MarkdownReference[]): NoteLink[] {
  const links: NoteLink[] = [];
  for (const reference of references) {
    if (reference.isImage) continue;
    const form = reference.kind === "wikilink" ? "wikilink" : "markdown";
    if (form === "markdown" && !isPathDestination(reference.raw)) continue;
    links.push({ form, raw: reference.raw, from: reference.from, to: reference.to });
  }
  return links;
}

/** A note's links, as noteLinks reads them, the paths of the images it
 * embeds, and the tags written in its text, from one parse, each link and
 * tag at its offset in the whole file. */
export function noteLinksAndTags(text: string): { links: NoteLink[]; embeds: string[]; tags: InlineTag[] } {
  const parsed = parseBody(text);
  const { body, offset } = parsed;
  const tags = tagsInTree(parsed.tree, (from, to) => body.slice(from, to)).map((tag) => ({
    name: tag.name,
    from: tag.from + offset,
    to: tag.to + offset,
  }));
  const references = referencesIn(parsed);
  const embeds = references.flatMap((reference) =>
    reference.isImage && isPathDestination(reference.raw) ? [reference.raw] : [],
  );
  return { links: linksIn(references), embeds, tags };
}

/** Applies `edits` to `text`. Each is a located reference's span and its
 * replacement; they never overlap, so applying them back to front keeps
 * every earlier offset valid. */
export function applyReferenceEdits(
  text: string,
  edits: Array<{ from: number; to: number; replacement: string }>,
): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
  }
  return result;
}
