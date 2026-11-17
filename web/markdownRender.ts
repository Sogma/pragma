import { markdownLanguage } from "@codemirror/lang-markdown";
import { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { documentBody, isListFrontmatterKey } from "../src/protocol/frontmatter.ts";
import { highlightSyntax } from "../src/protocol/highlightSyntax.ts";
import { holdsProse, tagsInProse } from "../src/protocol/inlineTags.ts";
import { withoutComments } from "../src/protocol/markdownComments.ts";
import { foldReferenceLabel, isWikilinkNode, referenceLabel, wikilinkRawLabel } from "../src/protocol/markdownLinks.ts";
import { titleHeadingNode } from "../src/protocol/markdownTitle.ts";
import { mathSyntax, readMath } from "../src/protocol/mathSyntax.ts";
import { parseVideoEmbed, type VideoEmbed } from "../src/protocol/videoEmbed.ts";
import { splitWikilinkLabel, wikilinkPattern } from "../src/protocol/wikilink.ts";
import { propertyIcon } from "./lib/propertyIcon.ts";
import { createPill, createTagPill } from "./lib/tagPill.ts";
import { typesetMath } from "./mathTypeset.ts";
import { texMathSyntax } from "./texMathSyntax.ts";
import { bareUrlHref, linkDestination } from "./webLinks.ts";

// Pure punctuation tokens — the `#`, `**`, `[`/`]`, backticks, etc. that
// mark a construct's boundaries but carry no content. Reading view hides
// these while keeping the structure they delimit; the inline walker below
// still excludes a skipped node's span from the surrounding text.
const SKIP_TYPES = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "CodeMark",
  "CodeInfo",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "SuperscriptMark",
  "SubscriptMark",
  "HighlightMark",
  "TableDelimiter",
]);

// With highlights and math, as the editor and the title rule parse them. The
// language's parser is a MarkdownParser, typed as Lezer's base Parser.
const markdownParser = (markdownLanguage.parser as MarkdownParser).configure([highlightSyntax, mathSyntax]);
const replyParser = markdownParser.configure([texMathSyntax]);

const HEADING_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
  ATXHeading1: "h1",
  ATXHeading2: "h2",
  ATXHeading3: "h3",
  ATXHeading4: "h4",
  ATXHeading5: "h5",
  ATXHeading6: "h6",
  SetextHeading1: "h1",
  SetextHeading2: "h2",
};

// A link/image target must be an http(s)/mailto URL before it's allowed
// into a live href — a space file is untrusted content, and a bare
// `javascript:` (or similarly executable) scheme in a markdown link must
// never become clickable.
const SAFE_URL = /^(https?:|mailto:)/i;

/** Whether a link to `href` leaves the space: reading view gives it a live
 * href, where any other target must resolve to a space file. */
export function isSafeHref(href: string): boolean {
  return SAFE_URL.test(href);
}

/** Where an autolink's text, its `<` and `>` dropped, leads: as written
 * with a scheme, else mail for an address, else the web. */
export function autolinkHref(text: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return text.includes("@") ? `mailto:${text}` : `https://${text}`;
}

// Decodes a numeric/named HTML entity (e.g. "&amp;", "&#8212;") into its
// character via a detached element — this never touches the live document,
// so it can't execute anything, unlike innerHTML on a mounted node.
function decodeEntity(raw: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = raw;
  return el.value;
}

// A video embed shows the video's thumbnail until clicked, and only then the
// player. Reading view is rebuilt on every toggle and edit, so live players
// would reload each time — and a thumbnail makes no request to the player
// before the reader asks for one.
//
// The frame is sandboxed without allow-top-navigation, so nothing inside it
// can navigate pragma itself; its popups (Watch on YouTube) leave through the
// host's new-window handling.
function videoEmbedElement(video: VideoEmbed, alt: string): HTMLElement {
  const title = alt || "YouTube video";
  const box = document.createElement("span");
  box.className = "video-embed";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "video-embed-poster";
  play.setAttribute("aria-label", `Play ${title}`);
  const poster = document.createElement("img");
  poster.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  poster.alt = "";
  const icon = document.createElement("span");
  icon.className = "video-embed-play";
  play.append(poster, icon);

  play.addEventListener("click", () => {
    const params = new URLSearchParams({ autoplay: "1", rel: "0" });
    if (video.start !== undefined) params.set("start", String(video.start));
    const frame = document.createElement("iframe");
    frame.src = `https://www.youtube-nocookie.com/embed/${video.id}?${params}`;
    frame.title = title;
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    // The player refuses to start without a referrer naming the embedding
    // origin, which a stricter policy would withhold.
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
    );
    play.replaceWith(frame);
  });

  box.appendChild(play);
  return box;
}

// A block's leading mark (`# `, `- `, `> `, ...) covers only the marker
// character in the syntax tree — the mandatory space after it is gap text,
// and would show as a stray leading space in every heading. Trims only the
// element's own edge text nodes, so it can't eat meaningful whitespace inside
// a nested span/strong/em.
function trimEdgeWhitespace(el: HTMLElement): void {
  const first = el.firstChild;
  if (first?.nodeType === Node.TEXT_NODE) first.textContent = (first.textContent ?? "").replace(/^[ \t]+/, "");
  const last = el.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) last.textContent = (last.textContent ?? "").replace(/[ \t]+$/, "");
}

// A line break inside a paragraph, which Markdown reads as a space, wrapped
// whatever the setting, so reading.css can start a new line there under
// Single line breaks without a redraw. A code span's line break is a space
// in Markdown either way, so code is left alone, and so is math, whose TeX
// MathJax reads.
function markSoftBreaks(el: Element): void {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const [first, ...rest] = (child.textContent ?? "").split("\n");
      if (rest.length > 0) child.replaceWith(first, ...rest.flatMap((line) => [softBreak(), line]));
    } else if (child instanceof Element && child.localName !== "code" && !child.classList.contains("math")) {
      markSoftBreaks(child);
    }
  }
}

function softBreak(): HTMLElement {
  const el = document.createElement("span");
  el.className = "soft-break";
  el.textContent = "\n";
  return el;
}

// Resolves a non-http(s) image `href` (e.g. a space-relative embed path)
// into a servable `src`, or undefined if it isn't one — the caller (main.ts)
// owns what "servable" means (space paths, the /api/file/raw route), so this
// file stays a pure syntax-tree-to-DOM renderer with no knowledge of space
// layout or HTTP routes, same as it had none before images were supported.
type ImageSrcResolver = (href: string) => string | undefined;

// Resolves a non-http(s) link `href` (e.g. `./AGENTS.md`) into the
// space-relative path it points to, or undefined if it doesn't resolve to
// one — same division of labor as ImageSrcResolver above. The resolved path
// is stashed on the rendered `<a>` (see the Link case) for main.ts's click
// handler to navigate with; this file never resolves or navigates itself.
type LinkPathResolver = (href: string) => string | undefined;

// Resolves a `[[target]]` wikilink's raw target text (not a URL — no
// leading `./`, no encoding) into the space-relative path it names, or
// undefined if it doesn't resolve to exactly one file. The rule is
// docs/protocol.md's Links section; it needs a space-wide file list, so the
// caller's cached tree does the lookup, never this file.
type WikilinkResolver = (target: string) => string | undefined;

interface MarkdownResolvers {
  image: ImageSrcResolver;
  link: LinkPathResolver;
  wikilink: WikilinkResolver;
  // The file line an offset into the rendered text sits on, when that text
  // is a file's: each block is then marked with the line it starts on, the
  // place a view scrolling beside the editor finds it by.
  line?: (offset: number) => number;
  // Whether a `#tag` in the text is drawn as one: a note's are, a chat
  // reply's aren't.
  tags?: boolean;
  // Whether math is typeset: a page's and a reply's is, a title's reads as
  // written.
  math?: boolean;
  // The rendered text's link reference definitions, by folded label. Without
  // them, as in a title read from its heading alone, every reference-style
  // link reads as the text it is.
  references?: ReadonlyMap<string, string>;
}

// A block's element, marked as MarkdownResolvers' `line` says.
function blockElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  node: SyntaxNode,
  resolvers: MarkdownResolvers,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (resolvers.line) el.dataset.line = String(resolvers.line(node.from));
  return el;
}

// A wikilink isn't CommonMark, but Lezer still builds a Link node for
// `[[target]]`'s inner `[target]`, a shortcut-reference shape with an empty
// href. Left to the ordinary "Link" case it renders as a broken anchor flanked
// by literal `[`/`]`, so the inline walker below consumes that shape. The
// text scan below is the fallback when no such node exists (an empty `[[]]`).
function appendWikilinkElement(raw: string, container: Node, resolvers: MarkdownResolvers): void {
  const { target, display } = splitWikilinkLabel(raw);
  const spacePath = resolvers.wikilink(target);
  if (spacePath !== undefined) {
    const el = document.createElement("a");
    el.href = spacePath;
    el.dataset.spacePath = spacePath;
    el.textContent = display;
    container.appendChild(el);
  } else {
    const el = document.createElement("span");
    el.className = "wikilink-unresolved";
    el.textContent = display;
    container.appendChild(el);
  }
}

function appendTextWithWikilinks(text: string, container: Node, resolvers: MarkdownResolvers): void {
  const re = wikilinkPattern();
  let pos = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the standard regex-exec-loop idiom; the extra parens are the intentional-assignment signal.
  while ((match = re.exec(text))) {
    if (match.index > pos) container.appendChild(document.createTextNode(text.slice(pos, match.index)));
    appendWikilinkElement(match[1], container, resolvers);
    pos = match.index + match[0].length;
  }
  if (pos < text.length) container.appendChild(document.createTextNode(text.slice(pos)));
}

// A run of prose from `from` to `to`: on a note's page its tags as pills,
// each carrying its name for the pane to color and open, and the text
// between them as above.
function appendProse(doc: string, from: number, to: number, container: Node, resolvers: MarkdownResolvers): void {
  let pos = from;
  if (resolvers.tags) {
    for (const tag of tagsInProse(doc.slice(from, to), from, from === 0 ? "" : doc[from - 1])) {
      appendTextWithWikilinks(doc.slice(pos, tag.from), container, resolvers);
      const pill = document.createElement("span");
      pill.className = "inline-tag";
      pill.dataset.tag = tag.name;
      pill.textContent = doc.slice(tag.from, tag.to);
      container.appendChild(pill);
      pos = tag.to;
    }
  }
  appendTextWithWikilinks(doc.slice(pos, to), container, resolvers);
}

// Walks `node`'s children, rendering the ones with dedicated handling and
// re-emitting everything else as literal text — including the gaps between
// children, where all of Lezer's inline prose lives, since plain text is no
// node of its own. A SKIP_TYPES child still advances the position past its
// span but never renders, which is what makes its marker characters vanish.
function appendInlineChildren(node: SyntaxNode, doc: string, container: Node, resolvers: MarkdownResolvers): void {
  let pos = node.from;
  let child = node.firstChild;
  while (child) {
    if (isWikilinkNode(child, doc, pos)) {
      // The gap up to but excluding the wikilink's leading "[" (that
      // character belongs to the wikilink, not to plain surrounding text).
      if (child.from - 1 > pos) appendProse(doc, pos, child.from - 1, container, resolvers);
      appendWikilinkElement(wikilinkRawLabel(child, doc), container, resolvers);
      pos = child.to + 1; // also claims the trailing "]"
      child = child.nextSibling;
      continue;
    }
    if (child.from > pos) appendProse(doc, pos, child.from, container, resolvers);
    if (!SKIP_TYPES.has(child.name)) renderNode(child, doc, container, resolvers);
    pos = child.to;
    child = child.nextSibling;
  }
  if (pos < node.to) appendProse(doc, pos, node.to, container, resolvers);
}

// Link and Image share a `[label](url "title")` / `[label][ref]` shape. Only
// the label renders, so this stops at the label's closing `]`, the second
// LinkMark; a URL before it is written in the label and stays text, since an
// anchor can't hold another.
function appendLinkLabel(node: SyntaxNode, doc: string, container: Node, resolvers: MarkdownResolvers): void {
  let pos = node.from;
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    // Gap text has to be emitted before checking SKIP_TYPES, not instead of
    // it — a plain-text label like "pragma" in `[pragma](url)` lives in the
    // gap between the opening and closing LinkMark, not as a child node of
    // its own, so skipping straight to `pos = child.to` on the closing mark
    // (without emitting first) would silently drop the label entirely.
    if (child.from > pos) container.appendChild(document.createTextNode(doc.slice(pos, child.from)));
    if (child.name === "LinkMark" && ++marks === 2) return;
    if (child.name === "URL") container.appendChild(document.createTextNode(doc.slice(child.from, child.to)));
    else if (!SKIP_TYPES.has(child.name)) renderNode(child, doc, container, resolvers);
    pos = child.to;
  }
}

// CommonMark's rule: a list is loose when a blank line separates two of its
// items, or two blocks inside one of them, and tight otherwise. So each block
// is checked against the one before it, across items too. Inside a quote a
// line of only `>` is blank, and the item before it holds that `>`.
function isTightList(list: SyntaxNode, doc: string): boolean {
  let last: number | undefined;
  for (const item of list.getChildren("ListItem")) {
    for (let block = item.firstChild; block; block = block.nextSibling) {
      if (block.name === "ListMark" || block.name === "QuoteMark") continue;
      if (last !== undefined && /\n[ \t>]*\n/.test(doc.slice(last, block.from))) return false;
      last = block.to;
    }
  }
  return true;
}

// A link's or image's destination, its own or its reference definition's.
// Undefined for a reference no definition names.
function linkHref(node: SyntaxNode, doc: string, resolvers: MarkdownResolvers): string | undefined {
  const urlNode = linkDestination(node);
  if (urlNode) return doc.slice(urlNode.from, urlNode.to);
  const label = referenceLabel(node, doc);
  return label === undefined ? "" : resolvers.references?.get(label);
}

// A reference no definition names is the text it is, brackets and all, with
// the markup inside its label still drawn.
function appendUnresolvedReference(node: SyntaxNode, doc: string, container: Node, resolvers: MarkdownResolvers): void {
  let pos = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark" || child.name === "LinkLabel") continue;
    if (child.from > pos) appendProse(doc, pos, child.from, container, resolvers);
    renderNode(child, doc, container, resolvers);
    pos = child.to;
  }
  if (pos < node.to) appendProse(doc, pos, node.to, container, resolvers);
}

// The first definition of a label wins, wherever in the document it sits.
function linkReferences(tree: Tree, doc: string): Map<string, string> {
  const references = new Map<string, string>();
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== "LinkReference") return;
      const label = ref.node.getChild("LinkLabel");
      const url = ref.node.getChild("URL");
      const key = label && foldReferenceLabel(doc.slice(label.from + 1, label.to - 1));
      if (key && url && !references.has(key)) {
        references.set(key, doc.slice(url.from, url.to).replace(/^<(.*)>$/, "$1"));
      }
      return false;
    },
  });
  return references;
}

function renderNode(node: SyntaxNode, doc: string, container: Node, resolvers: MarkdownResolvers): void {
  const heading = HEADING_TAGS[node.name];
  if (heading) {
    const el = blockElement(heading, node, resolvers);
    appendInlineChildren(node, doc, el, resolvers);
    trimEdgeWhitespace(el);
    container.appendChild(el);
    return;
  }

  switch (node.name) {
    case "Document":
      appendInlineChildren(node, doc, container, resolvers);
      return;

    case "Paragraph":
    case "Task": {
      // A task is its item's first paragraph, checkbox first, not a wrapper
      // around the item: a nested list or a later paragraph in the item
      // follows it, as it follows any item's first paragraph.
      const el = blockElement("p", node, resolvers);
      appendInlineChildren(node, doc, el, resolvers);
      trimEdgeWhitespace(el);
      markSoftBreaks(el);
      container.appendChild(el);
      return;
    }

    case "Blockquote": {
      const el = blockElement("blockquote", node, resolvers);
      appendInlineChildren(node, doc, el, resolvers);
      trimEdgeWhitespace(el);
      container.appendChild(el);
      return;
    }

    case "HorizontalRule":
      container.appendChild(blockElement("hr", node, resolvers));
      return;

    case "BulletList": {
      const el = blockElement("ul", node, resolvers);
      el.classList.toggle("tight-list", isTightList(node, doc));
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "OrderedList": {
      const el = blockElement("ol", node, resolvers);
      el.classList.toggle("tight-list", isTightList(node, doc));
      const firstMark = node.getChild("ListItem")?.getChild("ListMark");
      if (firstMark) {
        const start = Number.parseInt(doc.slice(firstMark.from, firstMark.to), 10);
        if (Number.isFinite(start) && start !== 1) el.start = start;
      }
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "ListItem": {
      const el = blockElement("li", node, resolvers);
      appendInlineChildren(node, doc, el, resolvers);
      trimEdgeWhitespace(el);
      container.appendChild(el);
      return;
    }

    case "TaskMarker": {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = true;
      checkbox.checked = /x/i.test(doc.slice(node.from, node.to));
      container.appendChild(checkbox);
      return;
    }

    case "FencedCode":
    case "CodeBlock": {
      const pre = blockElement("pre", node, resolvers);
      const code = document.createElement("code");
      const info = node.getChild("CodeInfo");
      const lang = info ? doc.slice(info.from, info.to).trim() : "";
      if (lang) code.className = `language-${lang}`;
      const parts: string[] = [];
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeText") parts.push(doc.slice(child.from, child.to));
      }
      code.textContent = parts.join("");
      pre.appendChild(code);
      container.appendChild(pre);
      return;
    }

    case "InlineMath":
    case "BlockMath": {
      const source = doc.slice(node.from, node.to);
      if (!resolvers.math) {
        container.appendChild(document.createTextNode(source));
        return;
      }
      const { tex, display } = readMath(node, (from, to) => doc.slice(from, to));
      const host = node.name === "BlockMath" ? blockElement("div", node, resolvers) : document.createElement("span");
      host.className = display ? "math math-display" : "math";
      // Math holding no TeX, such as a `$$` left open at the end, shows as
      // written rather than as nothing.
      if (tex.trim()) typesetMath(host, tex, display);
      else host.textContent = source;
      container.appendChild(host);
      return;
    }

    case "HTMLBlock":
    case "HTMLTag":
      // Shown as literal text, never interpreted — a space file is
      // untrusted content, and reading view rendering it must not become a
      // way to run embedded HTML/script.
      container.appendChild(document.createTextNode(doc.slice(node.from, node.to)));
      return;

    case "Comment":
      return;

    case "CommentBlock": {
      // Only what its last line holds past the comments shows: HTML, as text.
      const html = withoutComments(doc.slice(node.from, node.to)).trim();
      if (html) container.appendChild(document.createTextNode(html));
      return;
    }

    case "LinkReference":
      // A bare `[label]: url "title"` definition line isn't visible
      // prose — the reading view hides these.
      return;

    case "Table": {
      const table = blockElement("table", node, resolvers);
      let tbody: HTMLTableSectionElement | undefined;
      for (let row = node.firstChild; row; row = row.nextSibling) {
        if (row.name === "TableHeader" || row.name === "TableRow") {
          const tr = blockElement("tr", row, resolvers);
          const cellTag = row.name === "TableHeader" ? "th" : "td";
          for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
            if (cell.name !== "TableCell") continue;
            const cellEl = document.createElement(cellTag);
            appendInlineChildren(cell, doc, cellEl, resolvers);
            tr.appendChild(cellEl);
          }
          if (row.name === "TableHeader") {
            const thead = document.createElement("thead");
            thead.appendChild(tr);
            table.appendChild(thead);
          } else {
            if (!tbody) {
              tbody = document.createElement("tbody");
              table.appendChild(tbody);
            }
            tbody.appendChild(tr);
          }
        }
      }
      container.appendChild(table);
      return;
    }

    case "Emphasis": {
      const el = document.createElement("em");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "StrongEmphasis": {
      const el = document.createElement("strong");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "Strikethrough": {
      const el = document.createElement("del");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "Superscript": {
      const el = document.createElement("sup");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "Subscript": {
      const el = document.createElement("sub");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "Highlight": {
      const el = document.createElement("mark");
      appendInlineChildren(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "InlineCode": {
      // Unlike block code, inline `code` spans have no CodeText child —
      // just an opening and closing CodeMark around the raw text, same as
      // any other delimiter pair, so the content is the gap between them.
      const el = document.createElement("code");
      let openMark: SyntaxNode | undefined;
      let closeMark: SyntaxNode | undefined;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "CodeMark") continue;
        if (!openMark) openMark = child;
        closeMark = child;
      }
      el.textContent = openMark && closeMark ? doc.slice(openMark.to, closeMark.from) : doc.slice(node.from, node.to);
      container.appendChild(el);
      return;
    }

    case "HardBreak":
      container.appendChild(document.createElement("br"));
      return;

    case "Escape":
      // Skip the leading backslash — `\*` should read as a literal `*`.
      container.appendChild(document.createTextNode(doc.slice(node.from + 1, node.to)));
      return;

    case "Entity":
      container.appendChild(document.createTextNode(decodeEntity(doc.slice(node.from, node.to))));
      return;

    case "Link": {
      const href = linkHref(node, doc, resolvers);
      if (href === undefined) {
        appendUnresolvedReference(node, doc, container, resolvers);
        return;
      }
      const spacePath = SAFE_URL.test(href) ? undefined : resolvers.link(href);
      const el =
        SAFE_URL.test(href) || spacePath !== undefined ? document.createElement("a") : document.createElement("span");
      if (el instanceof HTMLAnchorElement) {
        el.href = href;
        if (spacePath !== undefined) {
          // Left as an in-space href (not target=_blank/rel) — main.ts's
          // click handler intercepts this via data-space-path and routes it
          // through in-app navigation instead of a real page load.
          el.dataset.spacePath = spacePath;
        } else {
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        }
      }
      appendLinkLabel(node, doc, el, resolvers);
      container.appendChild(el);
      return;
    }

    case "Image": {
      const href = linkHref(node, doc, resolvers);
      if (href === undefined) {
        appendUnresolvedReference(node, doc, container, resolvers);
        return;
      }
      const labelHost = document.createElement("span");
      appendLinkLabel(node, doc, labelHost, resolvers);
      const alt = labelHost.textContent ?? "";
      const video = parseVideoEmbed(href);
      if (video) {
        container.appendChild(videoEmbedElement(video, alt));
        return;
      }
      // An http(s) source becomes a real <img> directly; anything else (a
      // space-relative embed path, most commonly) goes through the caller's
      // resolver — undefined means it isn't a servable image, so it degrades
      // to its alt text same as always.
      const src = SAFE_URL.test(href) ? href : resolvers.image(href);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = alt;
        container.appendChild(img);
      } else {
        container.appendChild(document.createTextNode(alt ? `[image: ${alt}]` : "[image]"));
      }
      return;
    }

    case "Autolink": {
      let text = doc.slice(node.from, node.to);
      if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
      const href = autolinkHref(text);
      const el = SAFE_URL.test(href) ? document.createElement("a") : document.createElement("span");
      if (el instanceof HTMLAnchorElement) {
        el.href = href;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
      }
      el.textContent = text;
      container.appendChild(el);
      return;
    }

    case "URL": {
      // Only a bare URL in prose gets here: a link, image, autolink or
      // reference definition reads its own.
      const text = doc.slice(node.from, node.to);
      const href = bareUrlHref(text);
      if (!href) {
        container.appendChild(document.createTextNode(text));
        return;
      }
      const el = document.createElement("a");
      el.href = href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.textContent = text;
      container.appendChild(el);
      return;
    }

    default:
      // Anything not handled above (LinkLabel inside a reference-style
      // link, a future Lezer markdown extension's node type, ...)
      // degrades to its rendered content with no wrapper, rather than
      // silently dropping it or throwing. What holds no prose, a processing
      // instruction, stays text, so a `#` in it is no tag.
      if (holdsProse(node.name)) appendInlineChildren(node, doc, container, resolvers);
      else container.appendChild(document.createTextNode(doc.slice(node.from, node.to)));
  }
}

// A scalar frontmatter value renders as plain text, an array as one pill per
// item — branching on shape, since frontmatter is deliberately schema-less.
// The exception: a list key (`tags`) renders as pills even as a bare scalar
// (`tags: poetry`), matching the properties panel's list UI for those keys.
function appendFrontmatterValue(container: Node, key: string, value: unknown): void {
  if (Array.isArray(value) || isListFrontmatterKey(key)) {
    const items = Array.isArray(value)
      ? value
      : value === null || value === undefined || String(value).trim() === ""
        ? []
        : [value];
    for (const item of items) {
      const text = String(item);
      container.appendChild(key === "tags" ? createTagPill(text) : createPill(text));
    }
    return;
  }
  if (value === null || value === undefined) return;
  const text = document.createElement("span");
  text.className = "meta-text";
  text.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
  container.appendChild(text);
}

// Parsed frontmatter as read-only key/value rows: a document's properties
// section while reading view locks it. `path` is the document's, for the
// `pragma` key's scope mark.
export function renderFrontmatter(data: Record<string, unknown>, path?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "meta-rows";
  for (const [key, value] of Object.entries(data)) {
    const row = document.createElement("div");
    row.className = "meta-row";
    const keyEl = document.createElement("span");
    keyEl.className = "meta-key";
    keyEl.dataset.tooltipOverflow = "";
    keyEl.append(propertyIcon(key, data, path), key);
    const valueEl = document.createElement("span");
    valueEl.className = "meta-value";
    appendFrontmatterValue(valueEl, key, value);
    row.append(keyEl, valueEl);
    el.appendChild(row);
  }
  return el;
}

// Inert resolvers for plain-text heading extraction — a heading's own text
// is all that's wanted there, never a live link/image.
const INERT_RESOLVERS: MarkdownResolvers = {
  image: () => undefined,
  link: () => undefined,
  wikilink: () => undefined,
};

// The heading lifted into the editor's title bar (the rule is in
// docs/protocol.md), read in this file's grammar.
function leadingH1Node(body: string): SyntaxNode | undefined {
  return titleHeadingNode(body, (text) => markdownParser.parse(text));
}

// Splits a leading `# Heading` off a body already past its frontmatter: the
// heading's plain text, `lead`, the comments above it, and `rest`, a suffix of
// `body` without them, the heading or the blank lines after it. The editor
// shows the heading in its title bar — see docs/protocol.md's
// "Display titles" section.
//
// An empty heading (`#` with no text) is left in place — splitting it out
// would silently drop it from the file on the next save.
export function splitLeadingHeading(body: string): { title: string | undefined; lead: string; rest: string } {
  const heading = leadingH1Node(body);
  if (!heading) return { title: undefined, lead: "", rest: body };
  const host = document.createElement("div");
  appendInlineChildren(heading, body, host, INERT_RESOLVERS);
  trimEdgeWhitespace(host);
  const title = host.textContent?.trim();
  if (!title) return { title: undefined, lead: "", rest: body };
  return { title, lead: body.slice(0, heading.from), rest: body.slice(heading.to).replace(/^\n+/, "") };
}

// Shared by both entry points below: parses `body` with the same extended
// CommonMark grammar the live editor highlights with, and renders it into
// `fragment` as real elements — no innerHTML step anywhere for content from
// outside the app (a space file, a model reply). `omitLeadingH1` drops a
// leading level-1 heading, which reading view shows in the title bar.
//
// `file` is the whole file `body` was cut from, when there is one: each block
// is then marked with its line.
function appendMarkdownBody(
  body: string,
  fragment: DocumentFragment,
  resolvers: MarkdownResolvers,
  omitLeadingH1 = false,
  file?: string,
  parser: MarkdownParser = markdownParser,
): void {
  let source = body;
  if (omitLeadingH1) {
    const heading = leadingH1Node(body);
    if (heading) source = body.slice(heading.to).replace(/^\n+/, "");
  }
  const tree = parser.parse(source);
  const references = linkReferences(tree, source);
  const marking =
    file === undefined ? { ...resolvers, references } : { ...resolvers, references, line: fileLines(file, source) };
  renderNode(tree.topNode, source, fragment, marking);
}

// The file line, counted from 1, of an offset into `source`, which is a tail
// of `file`: what is cut off ahead of it still counts.
function fileLines(file: string, source: string): (offset: number) => number {
  const first = file.slice(0, file.length - source.length).split("\n").length;
  const lines = Text.of(source.split("\n"));
  return (offset) => first + lines.lineAt(offset).number - 1;
}

// Renders `content` as a space document, for reading view: the body only,
// each block marked with the file line it starts on (`data-line`), and its
// tags drawn.
//
// The frontmatter is the properties section's, but it must still be stripped
// here — handed to the parser, an unblank-lined `---` block reads as a
// paragraph plus a Setext underline, one run-on heading of `key: value`
// lines. `omitLeadingH1` drops a leading `# Heading`; the title bar has it.
export function renderMarkdown(
  content: string,
  resolvers: MarkdownResolvers,
  options: { omitLeadingH1?: boolean } = {},
): DocumentFragment {
  // Cut off unread, so a block that doesn't parse is hidden like any other.
  const body = documentBody(content);
  const fragment = document.createDocumentFragment();
  appendMarkdownBody(body, fragment, { ...resolvers, tags: true, math: true }, options.omitLeadingH1 ?? false, content);
  return fragment;
}

// Renders `content` as-is, with no frontmatter handling — for markdown that
// didn't come from a space file (a chat reply, say). Not just skipped work:
// a reply that opens with a `---` rule and has another later would get
// everything between misread as YAML. A reply's math may also be marked as
// TeX marks it, `\(…\)` and `\[…\]`, as models write it.
export function renderMarkdownInline(content: string, resolvers: MarkdownResolvers): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendMarkdownBody(content, fragment, { ...resolvers, math: true }, false, undefined, replyParser);
  return fragment;
}
