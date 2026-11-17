// Find over a page rather than an editor's text: a note's rendered reading
// view, a Table's or a Class's values. The query is CodeMirror's, run over
// the text the page shows, so its options read that text as the editor's do.
//
// Matches are marked through the browser's highlight registry, never in the
// page's markup. No highlight reaches a field's text, so a field holding a
// match is marked whole.
import type { SearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { COUNT_LIMIT, createPaneFind, type Finder, type PaneFind, seedText, visibleArea } from "./findCard.ts";

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// A text node's part of the page's text, `start` to `end`. Where the page
// collapses its spaces, `raw` maps each character back into the node.
interface TextRun {
  node: Text;
  start: number;
  end: number;
  raw?: number[];
}

interface FieldRun {
  field: Field;
  start: number;
  end: number;
}

interface PageText {
  text: string;
  texts: TextRun[];
  fields: FieldRun[];
}

interface Match {
  from: number;
  range?: Range;
  fields: Field[];
}

// Elements whose text runs on into their neighbours'. Any other starts and
// ends a line of the page's text, so a match never runs between blocks, or
// between two cells.
const INLINE = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BUTTON",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "I",
  "IMG",
  "INS",
  "KBD",
  "LABEL",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);
const UNREAD = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
const TEXT_TYPES = new Set(["text", "number", "search", "email", "url", "tel"]);

function isField(node: unknown): node is Field {
  if (node instanceof HTMLInputElement) return TEXT_TYPES.has(node.type);
  return node instanceof HTMLTextAreaElement || (node instanceof HTMLSelectElement && !node.multiple);
}

function fieldText(field: Field): string {
  return field instanceof HTMLSelectElement ? (field.selectedOptions[0]?.text ?? "") : field.value;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function readPage(values: readonly HTMLElement[]): PageText {
  let text = "";
  const texts: TextRun[] = [];
  const fields: FieldRun[] = [];
  const endLine = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };

  // Spaces collapse as the page draws them: a run of them reads as one, and
  // none starts a line. Inside a <pre> they stay as written.
  function addText(node: Text, kept: boolean): void {
    const data = node.data;
    if (kept) {
      if (!data) return;
      texts.push({ node, start: text.length, end: text.length + data.length });
      text += data;
      return;
    }
    let out = "";
    const raw: number[] = [];
    let dropped = false;
    for (let index = 0; index < data.length; index++) {
      if (!isSpace(data.charCodeAt(index))) {
        raw.push(index);
        out += data[index];
        continue;
      }
      const before = out ? out[out.length - 1] : text[text.length - 1];
      if (before === undefined || before === " " || before === "\n") {
        dropped = true;
        continue;
      }
      raw.push(index);
      out += " ";
    }
    if (!out) return;
    raw.push(data.length);
    texts.push({ node, start: text.length, end: text.length + out.length, raw: dropped ? raw : undefined });
    text += out;
  }

  function walk(node: Node, kept: boolean): void {
    if (node instanceof Text) {
      addText(node, kept);
      return;
    }
    if (!(node instanceof HTMLElement) || node.hidden || UNREAD.has(node.tagName)) return;
    if (node.getAttribute("aria-hidden") === "true") return;
    if (isField(node)) {
      endLine();
      const value = fieldText(node);
      if (value) fields.push({ field: node, start: text.length, end: text.length + value.length });
      text += value;
      endLine();
      return;
    }
    // A checkbox, a radio: nothing to read.
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) return;
    const block = !INLINE.has(node.tagName);
    if (block) endLine();
    const keeps = kept || node.tagName === "PRE";
    for (const child of node.childNodes) walk(child, keeps);
    if (block) endLine();
  }

  for (const value of values) {
    endLine();
    walk(value, value.closest("pre") !== null);
  }
  return { text, texts, fields };
}

// The first run that ends after `pos`.
function firstEndingAfter(runs: readonly { end: number }[], pos: number): number {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (runs[middle].end > pos) high = middle;
    else low = middle + 1;
  }
  return low;
}

function nodeOffset(run: TextRun, pos: number): number {
  const at = pos - run.start;
  return run.raw ? run.raw[at] : at;
}

function locate(page: PageText, from: number, to: number): Match {
  const match: Match = { from, fields: [] };
  for (let index = firstEndingAfter(page.fields, from); index < page.fields.length; index++) {
    const run = page.fields[index];
    if (run.start >= to) break;
    match.fields.push(run.field);
  }
  const first = firstEndingAfter(page.texts, from);
  const start = page.texts[first];
  if (!start || start.start >= to) return match;
  let last = first;
  while (last + 1 < page.texts.length && page.texts[last + 1].start < to) last++;
  const end = page.texts[last];
  match.range = document.createRange();
  match.range.setStart(start.node, nodeOffset(start, Math.max(from, start.start)));
  match.range.setEnd(end.node, nodeOffset(end, Math.min(to, end.end)));
  return match;
}

function findMatches(query: SearchQuery, page: PageText): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  if (!query.valid) return { matches, capped: false };
  const cursor = query.getCursor(EditorState.create({ doc: page.text }));
  for (let found = cursor.next(); !found.done; found = cursor.next()) {
    if (matches.length === COUNT_LIMIT) return { matches, capped: true };
    matches.push(locate(page, found.value.from, found.value.to));
  }
  return { matches, capped: false };
}

// One registry entry per kind of mark, shared by every page that finds: the
// stylesheet names them, so two groups' finds add to the same two.
let marks: { match: Highlight; current: Highlight } | undefined;

function sharedMarks(): typeof marks {
  if (marks) return marks;
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return undefined;
  marks = { match: new Highlight(), current: new Highlight() };
  CSS.highlights.set("find-match", marks.match);
  CSS.highlights.set("find-current", marks.current);
  return marks;
}

function scrollerOf(from: Element, axis: "x" | "y"): HTMLElement | undefined {
  for (let node: Element | null = from; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (axis === "y" ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth) return node;
  }
  return undefined;
}

// A selection read as the page's text is, so a search started from it finds
// it: a selection across two blocks or two cells spans two lines.
function rangeText(range: Range): string {
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  if (element?.closest("pre")) return range.toString();
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return readPage([holder]).text.replace(/\n+$/, "");
}

/** Text selected inside `root` to start a search with, as the editor starts
 * one from its selection: on one line and at most 100 characters. A field's
 * own selection counts while it has focus. */
export function selectedText(root: HTMLElement): string | undefined {
  const active = document.activeElement;
  let text = "";
  if (isField(active) && !(active instanceof HTMLSelectElement) && root.contains(active)) {
    const { selectionStart, selectionEnd, value } = active;
    if (selectionStart !== null && selectionEnd !== null) text = value.slice(selectionStart, selectionEnd);
  } else {
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed ? selection.getRangeAt(0) : undefined;
    if (range && root.contains(range.commonAncestorContainer)) text = rangeText(range);
  }
  return seedText(text);
}

export interface PageFinderOptions {
  // What holds the page, watched for its content changing.
  root: HTMLElement;
  // The elements searched, in reading order, each apart from the others.
  values: () => readonly HTMLElement[];
  // The card, which hides what is under it.
  card: () => HTMLElement | undefined;
  // The page changed under the search, which ran again.
  changed: () => void;
}

export function createPageFinder(options: PageFinderOptions): Finder {
  let query: SearchQuery | undefined;
  let matches: Match[] = [];
  let capped = false;
  let current = -1;
  const painted: Range[] = [];
  const marked = new Set<Field>();

  function paint(): void {
    const shared = sharedMarks();
    const fieldMarks = new Map<Field, "match" | "current">();
    matches.forEach((match, index) => {
      const isCurrent = index === current;
      if (match.range && shared) {
        (isCurrent ? shared.current : shared.match).add(match.range);
        painted.push(match.range);
      }
      for (const field of match.fields) {
        if (isCurrent || !fieldMarks.has(field)) fieldMarks.set(field, isCurrent ? "current" : "match");
      }
    });
    for (const [field, mark] of fieldMarks) {
      field.dataset.find = mark;
      marked.add(field);
    }
  }

  function unpaint(): void {
    const shared = sharedMarks();
    for (const range of painted) {
      shared?.match.delete(range);
      shared?.current.delete(range);
    }
    painted.length = 0;
    for (const field of marked) delete field.dataset.find;
    marked.clear();
  }

  // The match that starts at `pos` or after it, wrapping past the end.
  function firstFrom(pos: number): number {
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (matches[middle].from >= pos) high = middle;
      else low = middle + 1;
    }
    return low < matches.length ? low : 0;
  }

  function run(): void {
    const anchor = matches[current]?.from;
    unpaint();
    const found = query ? findMatches(query, readPage(options.values())) : { matches: [], capped: false };
    matches = found.matches;
    capped = found.capped;
    current = anchor === undefined || !matches.length ? -1 : firstFrom(anchor);
    paint();
  }

  function rectOf(match: Match): DOMRect | undefined {
    return match.range?.getBoundingClientRect() ?? match.fields[0]?.getBoundingClientRect();
  }

  function elementOf(match: Match): Element | undefined {
    const node = match.range?.startContainer;
    if (node) return node instanceof Element ? node : (node.parentElement ?? undefined);
    return match.fields[0];
  }

  // The first match whose foot is below the top of what shows, or the first
  // of all when every one is above it.
  function firstInView(): number {
    const top = visibleArea(options.root, undefined, { left: 0, right: 0 }).top;
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const rect = rectOf(matches[middle]);
      if (rect && rect.bottom > top) high = middle;
      else low = middle + 1;
    }
    return low < matches.length ? low : 0;
  }

  // A match in view stays where it is; any other is brought to the middle,
  // so what is around it shows too.
  function reveal(): void {
    const match = matches[current];
    const element = match && elementOf(match);
    let rect = match && rectOf(match);
    if (!element || !rect) return;
    const area = visibleArea(element, options.card(), rect);
    const yScroller = rect.top < area.top || rect.bottom > area.bottom ? scrollerOf(element, "y") : undefined;
    if (yScroller) {
      const box = yScroller.getBoundingClientRect();
      yScroller.scrollTop += (rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2;
      rect = rectOf(match) ?? rect;
    }
    const xScroller = rect.left < area.left || rect.right > area.right ? scrollerOf(element, "x") : undefined;
    if (xScroller) {
      const box = xScroller.getBoundingClientRect();
      xScroller.scrollLeft += (rect.left + rect.right) / 2 - (box.left + box.right) / 2;
    }
  }

  function select(index: number): void {
    current = index;
    unpaint();
    paint();
    reveal();
  }

  const refresh = () => {
    if (!query) return;
    run();
    options.changed();
  };
  // Typing in a field changes no markup, so the page's own input events
  // count too. A mark is an attribute, which the observer doesn't watch.
  const observer = new MutationObserver(refresh);
  observer.observe(options.root, { childList: true, subtree: true, characterData: true });
  options.root.addEventListener("input", refresh);
  options.root.addEventListener("change", refresh);

  return {
    search(next) {
      query = next;
      run();
    },
    count: () => ({ total: matches.length, current, capped }),
    fromView() {
      if (matches.length) select(firstInView());
    },
    seek() {
      if (matches.length) select(current < 0 ? firstInView() : current);
    },
    step(backward) {
      if (!matches.length) return;
      if (current >= 0) select((current + (backward ? matches.length - 1 : 1)) % matches.length);
      else {
        const first = firstInView();
        select(backward ? (first + matches.length - 1) % matches.length : first);
      }
    },
    dispose() {
      observer.disconnect();
      options.root.removeEventListener("input", refresh);
      options.root.removeEventListener("change", refresh);
      unpaint();
      matches = [];
      current = -1;
      query = undefined;
    },
  };
}

/** Find's card for a page with no editor: a Table's or a Class's values,
 * the `values` of `root`. */
export function createPageFind(options: {
  root: HTMLElement;
  values: (root: HTMLElement) => readonly HTMLElement[];
}): PaneFind {
  const { root, values } = options;
  return createPaneFind({
    finder: (card, changed) => createPageFinder({ root, values: () => values(root), card, changed }),
    selected: () => selectedText(root),
    root,
  });
}
