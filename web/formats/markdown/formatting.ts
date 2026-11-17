// A note drawn formatted while it is edited: a heading at its size, bold as
// bold, a link as its text, a tag as its pill, a bullet as a dot, with the
// syntax hidden except where the selection touches it. All of it is drawn
// over the text, never written into it; the one edit made here is a task
// checkbox's character.
//
// It formats what reading view renders, as reading view draws it, a comment,
// which reading view leaves out, in a look of its own, and leaves images,
// tables, math and HTML as written.
import { syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type Line,
  Prec,
  type Range,
  type RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutterLineClass,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tagsInTree } from "../../../src/protocol/inlineTags.ts";
import { commentsOf } from "../../../src/protocol/markdownComments.ts";
import { basenameOf } from "../../../src/protocol/rootedPath.ts";
import type { TagDefinition } from "../../../src/protocol/tags.ts";
import { splitWikilinkLabel } from "../../../src/protocol/wikilink.ts";
import { hiddenSyntax, hidingSwitched, syntaxHidden } from "../../hiddenSyntax.ts";
import { tagPillColors } from "../../lib/tagPill.ts";
import { autolinkHref, isSafeHref } from "../../markdownRender.ts";
import { type Span, shownSpans, shownSpansChanged, syntaxMark } from "../../shownSyntax.ts";
import { bareUrlHref, linkDestination } from "../../webLinks.ts";
import { AS_WRITTEN, HEADING_LEVELS, headingMarks, isBlank, noteSyntax, RUN_DELIMITERS } from "./marks.ts";

/** Where a link in the note leads, by reading view's resolvers, and how one
 * opens; the space's declared tags, which color a tag, and how a tag opens. */
export interface FormattingLinks {
  // Undefined while the editor shows no file.
  resolvers(): { link(href: string): string | undefined; wikilink(target: string): string | undefined } | undefined;
  open(path: string, anchor: HTMLElement): void;
  tags?(): readonly TagDefinition[];
  openTag?(name: string): void;
  // Calls `redraw` whenever the declared tags change; returns how to stop.
  watchTags?(redraw: () => void): () => void;
}

/** Dispatched when what the note's links resolve to may have changed. */
export const formattingChanged = StateEffect.define<null>();

const formattingLinks = Facet.define<FormattingLinks, FormattingLinks | undefined>({
  combine: (values) => values[0],
});

const hidden = Decoration.replace({});
// A list's bullets by how deep it nests in other lists, as reading view's are.
const bullets = ["", " cm-md-bullet-circle", " cm-md-bullet-square"].map((shape) =>
  Decoration.mark({ class: `cm-md-bullet${shape}` }),
);
const quoteMark = Decoration.mark({ class: "cm-md-quote-mark" });
// What reading view draws as a link: underlined, the editor's own highlighting
// giving the color. A line takes the color of the element that draws it, so
// this mark nests inside the highlighter's colored span; drawn around it, the
// line would be in the plain text's color.
const anchor = Decoration.mark({ class: "cm-md-anchor" });
const plainLabel = Decoration.mark({ class: "cm-md-plain" });
const unresolved = Decoration.mark({ class: "cm-md-unresolved" });
const commentText = Decoration.mark({ class: "cm-md-comment" });

// A tag, as written and whole, drawn as reading view draws it: its pill,
// filled with its declared color.
function tagMark(name: string, definitions: readonly TagDefinition[]): Decoration {
  const colors = tagPillColors(name, definitions);
  return Decoration.mark({
    class: colors ? "inline-tag has-tag-color" : "inline-tag",
    attributes: {
      "data-md-tag": name,
      ...(colors ? { style: `background: ${colors.background}; color: ${colors.color}` } : {}),
    },
  });
}

// How a run of inline formatting looks, by its node.
const RUN_LOOKS: Record<string, Decoration> = {
  Emphasis: Decoration.mark({ class: "cm-md-em" }),
  StrongEmphasis: Decoration.mark({ class: "cm-md-strong" }),
  Strikethrough: Decoration.mark({ class: "cm-md-strike" }),
  Superscript: Decoration.mark({ class: "cm-md-sup" }),
  Subscript: Decoration.mark({ class: "cm-md-sub" }),
  Highlight: Decoration.mark({ class: "cm-md-highlight" }),
  InlineCode: Decoration.mark({ class: "cm-md-code" }),
};

// What a click on a link to a space file opens. Its underline is a mark of its
// own: a mark inside the highlighter's span splits wherever bold or italic
// starts in the label, and the link preview takes each piece for a link.
function spaceLink(path: string): Decoration {
  return Decoration.mark({ class: "cm-md-link", attributes: { "data-space-path": path } });
}

/** Where in a wikilink's raw label the text reading view shows sits: the
 * display after a pipe, else the target, or only its name when relative. */
export function wikilinkShown(raw: string): Span | undefined {
  const { display } = splitWikilinkLabel(raw);
  const pipe = raw.indexOf("|");
  const target = pipe === -1 ? raw : raw.slice(0, pipe);
  let start = 0;
  if (pipe !== -1 && raw.slice(pipe + 1).trim()) start = pipe + 1;
  else if (display !== target.trim()) {
    // A name is the target's last segment, a folder's trailing slash aside.
    const path = target.replace(/[\s/]+$/, "");
    start = path.length - basenameOf(path).length;
  }
  const at = raw.indexOf(display, start);
  return at === -1 ? undefined : { from: at, to: at + display.length };
}

// The lines a heading's text is on: an underlined heading's underline is not
// one of them.
function headingTextLines(doc: Text, node: SyntaxNode): Line[] {
  const first = doc.lineAt(node.from);
  if (node.name.startsWith("ATX")) return [first];
  const underline = node.getChild("HeaderMark");
  const last = underline ? doc.lineAt(underline.from).number - 1 : doc.lineAt(node.to).number;
  const lines: Line[] = [];
  for (let number = first.number; number <= last; number++) lines.push(doc.line(number));
  return lines;
}

// Where the gap reading view leaves under a heading goes: below the heading's
// last line when text follows it, or as the height of a blank line that
// follows it instead, so a heading written either way sits as on the page.
function headingGap(doc: Text, node: SyntaxNode): { line: Line; blank: boolean } | undefined {
  const end = doc.lineAt(node.to);
  if (end.number >= doc.lines) return undefined;
  const next = doc.line(end.number + 1);
  return next.text.trim() ? { line: end, blank: false } : { line: next, blank: true };
}

interface Pass {
  state: EditorState;
  visible: readonly Span[];
  // Where syntax shows: the selection, find's matches, a proposal's changes,
  // the selection left out while the syntax hides from it.
  shown: readonly Span[];
  // Where a link's, a code fence's and a rule's syntax shows: `shown` and
  // the selection, since typing there would otherwise go into text no one
  // sees. A fence shows only while the selection is on its line when the
  // syntax hides from the selection.
  opened: readonly Span[];
  hiding: boolean;
  links: FormattingLinks | undefined;
  // A list item's line style, wrapping its rows at `content`.
  hang(key: string, line: Line, content: number): string;
}

interface Formatting {
  marks: DecorationSet;
  underlines: DecorationSet;
}

/** The note's formatting over the visible ranges. */
function formattingDecorations({ state, visible, shown, opened, hiding, links, hang }: Pass): Formatting {
  if (!visible.length) return { marks: Decoration.none, underlines: Decoration.none };
  const { doc } = state;
  const resolvers = links?.resolvers();
  const ranges: Range<Decoration>[] = [];
  const underlines: Range<Decoration>[] = [];
  const lineClasses = new Map<number, string[]>();
  const lineStyles = new Map<number, string>();

  const touches = (from: number, to: number) => shown.some((span) => span.from <= to && span.to >= from);
  const opens = (from: number, to: number) => opened.some((span) => span.from <= to && span.to >= from);
  const onScreen = (from: number, to: number) => visible.some((range) => from <= range.to && to >= range.from);
  const addLine = (line: Line, className: string) => {
    const classes = lineClasses.get(line.from);
    if (!classes) lineClasses.set(line.from, [className]);
    else if (!classes.includes(className)) classes.push(className);
  };
  const eachLine = (from: number, to: number, apply: (line: Line) => void) => {
    for (const range of visible) {
      for (let pos = Math.max(from, range.from); pos <= Math.min(to, range.to); ) {
        const line = doc.lineAt(pos);
        apply(line);
        pos = line.to + 1;
      }
    }
  };
  // Syntax hidden, or drawn faint while it shows.
  const syntaxSpan = (from: number, to: number, show: boolean) => {
    if (from < to) ranges.push((show ? syntaxMark : hidden).range(from, to));
  };
  const fileLink = (path: string, from: number, to: number) => {
    ranges.push(spaceLink(path).range(from, to));
    underlines.push(anchor.range(from, to));
  };

  const heading = (node: SyntaxNode, level: number) => {
    const lines = headingTextLines(doc, node);
    for (const line of lines) addLine(line, `cm-md-heading cm-md-h${level}`);
    const gap = headingGap(doc, node);
    if (gap) addLine(gap.line, `${gap.blank ? "cm-md-gap-line" : "cm-md-gap-below"} cm-md-gap-h${level}`);
    if (!node.name.startsWith("ATX")) return;
    const [line] = lines;
    const show = touches(line.from, line.to);
    for (const { from, to } of headingMarks(doc, node)) syntaxSpan(from, to, show);
  };

  // A line's wrapped rows hang at the text after `from`, its blanks skipped.
  // A deeper quote or a list item on the line, met later, hangs it further.
  const hangLine = (line: Line, from: number, box = false) => {
    let content = from;
    while (content < line.to && isBlank(doc, content)) content++;
    if (content >= line.to) return;
    // A checkbox is not as wide as the brackets it stands for.
    lineStyles.set(line.from, hang(`${doc.sliceString(line.from, content)}${box ? "☐" : ""}`, line, content));
  };

  const quote = (node: SyntaxNode) => {
    const line = doc.lineAt(node.from);
    // The first `>` stands see-through beside the line's bar; a nested quote's show.
    if (!touches(line.from, line.to) && !doc.sliceString(line.from, node.from).trim()) {
      ranges.push(quoteMark.range(node.from, node.to));
    } else syntaxSpan(node.from, node.to, true);
    hangLine(line, node.to);
  };

  const hangItem = (node: SyntaxNode) => {
    const mark = node.getChild("ListMark");
    if (!mark) return;
    const line = doc.lineAt(mark.from);
    const task = node.getChild("Task")?.getChild("TaskMarker") ?? undefined;
    if (task && task.from <= line.to) hangLine(line, task.to, !touches(task.from, task.to));
    else hangLine(line, mark.to);
  };

  const listMark = (node: SyntaxNode) => {
    const list = node.parent?.parent;
    if (list?.name !== "BulletList") return;
    if (touches(node.from, node.to)) {
      syntaxSpan(node.from, node.to, true);
      return;
    }
    let depth = 0;
    for (let up = list.parent; up; up = up.parent) if (up.name === "BulletList" || up.name === "OrderedList") depth++;
    ranges.push(bullets[Math.min(depth, bullets.length - 1)].range(node.from, node.to));
  };

  const task = (node: SyntaxNode) => {
    if (touches(node.from, node.to)) syntaxSpan(node.from, node.to, true);
    else ranges.push(taskBoxes[/x/i.test(doc.sliceString(node.from, node.to)) ? 1 : 0].range(node.from, node.to));
  };

  const link = (node: SyntaxNode) => {
    const [open, close] = node.getChildren("LinkMark");
    if (!open || !close) return;
    const show = opens(node.from, node.to);
    syntaxSpan(open.from, open.to, show);
    syntaxSpan(close.from, node.to, show);
    const destination = linkDestination(node);
    const href = destination ? doc.sliceString(destination.from, destination.to) : undefined;
    if (open.to >= close.from) return;
    if (href !== undefined && isSafeHref(href)) {
      underlines.push(anchor.range(open.to, close.from));
      return;
    }
    const path = href === undefined ? undefined : resolvers?.link(href);
    if (path === undefined) ranges.push(plainLabel.range(open.to, close.from));
    else fileLink(path, open.to, close.from);
  };

  // An autolink, or a bare URL, reading view links.
  const address = (node: SyntaxNode) => {
    if (node.name === "Autolink") {
      const show = opens(node.from, node.to);
      for (const mark of node.getChildren("LinkMark")) syntaxSpan(mark.from, mark.to, show);
    }
    const url = node.name === "URL" ? node : node.getChild("URL");
    if (!url) return;
    const text = doc.sliceString(url.from, url.to);
    const links = node.name === "URL" ? bareUrlHref(text) !== undefined : isSafeHref(autolinkHref(text));
    if (links) underlines.push(anchor.range(url.from, url.to));
  };

  const wikilink = (node: SyntaxNode) => {
    const [open, close] = node.getChildren("WikilinkMark");
    if (!open || !close) return;
    const raw = doc.sliceString(open.to, close.from);
    const part = wikilinkShown(raw);
    const from = open.to + (part?.from ?? 0);
    const to = open.to + (part?.to ?? raw.length);
    const show = opens(node.from, node.to);
    syntaxSpan(node.from, from, show);
    syntaxSpan(to, node.to, show);
    const path = resolvers?.wikilink(splitWikilinkLabel(raw).target);
    if (from >= to) return;
    if (path === undefined) ranges.push(unresolved.range(from, to));
    else fileLink(path, from, to);
  };

  // Fence lines stay as the block's top and bottom, their text hidden.
  const codeBlock = (node: SyntaxNode) => {
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    eachLine(node.from, node.to, (line) => {
      addLine(line, "cm-md-codeblock");
      if (line.number === first.number) addLine(line, "cm-md-codeblock-start");
      if (line.number === last.number) addLine(line, "cm-md-codeblock-end");
    });
    if (node.name !== "FencedCode") return;
    const show = (line: Line) => (hiding ? opens(line.from, line.to) : opens(node.from, node.to));
    const marks = node.getChildren("CodeMark");
    const [opening] = marks;
    const closing = marks.at(-1);
    if (opening) syntaxSpan(opening.from, first.to, show(first));
    if (closing && closing.from > first.to) syntaxSpan(closing.from, closing.to, show(last));
  };

  const rule = (node: SyntaxNode) => {
    const line = doc.lineAt(node.from);
    if (opens(line.from, line.to)) syntaxSpan(node.from, node.to, true);
    else addLine(line, "cm-md-hr");
  };

  // What reading view leaves out, in a look of its own: a comment's text
  // muted between its `<!--` and `-->`, which show faint wherever the
  // selection is. `<!-->` and `<!--->` are all syntax, and a comment left
  // open has no `-->`.
  const comment = (node: SyntaxNode) => {
    for (const { from, to } of commentsOf(node, (start, end) => doc.sliceString(start, end))) {
      const text = doc.sliceString(from, to);
      const whole = text === "<!-->" || text === "<!--->";
      const open = whole ? to : from + 4;
      const close = !whole && text.endsWith("-->") ? to - 3 : to;
      syntaxSpan(from, open, true);
      if (open < close) ranges.push(commentText.range(open, close));
      syntaxSpan(close, to, true);
    }
  };

  syntaxTree(state).iterate({
    from: visible[0].from,
    to: visible[visible.length - 1].to,
    enter(ref) {
      // A node wholly inside a fold is passed over.
      if (!onScreen(ref.from, ref.to) || AS_WRITTEN.has(ref.name)) return false;
      const node = ref.node;
      const level = HEADING_LEVELS[ref.name];
      if (level !== undefined) {
        heading(node, level);
        return;
      }
      const delimiter = RUN_DELIMITERS[ref.name];
      if (delimiter) {
        ranges.push(RUN_LOOKS[ref.name].range(ref.from, ref.to));
        const show = touches(ref.from, ref.to);
        for (const mark of node.getChildren(delimiter)) syntaxSpan(mark.from, mark.to, show);
        return ref.name !== "InlineCode";
      }
      switch (ref.name) {
        case "Blockquote":
          eachLine(ref.from, ref.to, (line) => addLine(line, "cm-md-quote"));
          return;
        case "QuoteMark":
          quote(node);
          return false;
        case "ListItem":
          hangItem(node);
          return;
        case "ListMark":
          listMark(node);
          return false;
        case "TaskMarker":
          task(node);
          return false;
        case "Link":
          link(node);
          return;
        case "Autolink":
          address(node);
          return false;
        // A link's own URL, in its label or its destination, is the link's.
        case "URL":
          if (node.parent?.name !== "Link") address(node);
          return false;
        case "Wikilink":
          wikilink(node);
          return false;
        case "Escape":
          syntaxSpan(ref.from, ref.from + 1, touches(ref.from, ref.to));
          return false;
        case "FencedCode":
        case "CodeBlock":
          codeBlock(node);
          return false;
        case "HorizontalRule":
          rule(node);
          return false;
        case "Comment":
        case "CommentBlock":
          comment(node);
          return false;
      }
    },
  });

  // A table is left as written, its tags too.
  const tree = syntaxTree(state);
  const definitions = links?.tags?.() ?? [];
  for (const range of visible) {
    for (const tag of tagsInTree(tree, (from, to) => doc.sliceString(from, to), range.from, range.to)) {
      let inTable = false;
      for (let node: SyntaxNode | null = tree.resolveInner(tag.from, 1); node && !inTable; node = node.parent) {
        inTable = node.name === "Table";
      }
      if (!inTable) ranges.push(tagMark(tag.name, definitions).range(tag.from, tag.to));
    }
  }

  for (const from of new Set([...lineClasses.keys(), ...lineStyles.keys()])) {
    const style = lineStyles.get(from);
    const line = Decoration.line({
      class: lineClasses.get(from)?.join(" "),
      attributes: style ? { style } : undefined,
    });
    ranges.push(line.range(from));
  }
  return { marks: Decoration.set(ranges, true), underlines: Decoration.set(underlines, true) };
}

// A task's `[ ]` as reading view's checkbox. A click writes the one character
// between the brackets, an ordinary edit undo reverts; the press itself takes
// no focus and moves no cursor.
class TaskBox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskBox): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const at = view.posAtDOM(box) + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" }, userEvent: "input.check" });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const taskBoxes = [false, true].map((checked) => Decoration.replace({ widget: new TaskBox(checked) }));

function needsRedraw(update: ViewUpdate): boolean {
  const { startState: before, state } = update;
  return (
    update.docChanged ||
    update.viewportChanged ||
    shownSpansChanged(update) ||
    syntaxTree(before) !== syntaxTree(state) ||
    before.facet(formattingLinks) !== state.facet(formattingLinks) ||
    update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(formattingChanged) || effect.is(hidingSwitched)),
    )
  );
}

// A list item's wrapped rows hang at its text, past the marker, by the width
// of what comes before the text, measured where it lands, never assumed from
// the font. Each distinct prefix holds its width in a custom property, so a
// new measure moves the lines without a redraw. The 6px is CodeMirror's own
// .cm-line padding.
class Hanging {
  private readonly ids = new Map<string, number>();
  private readonly samples = new Map<number, Span>();
  private readonly widths = new Map<number, number>();

  constructor(private readonly view: EditorView) {}

  begin(): void {
    this.samples.clear();
  }

  style(key: string, line: Line, content: number): string {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(key, id);
    }
    this.samples.set(id, { from: line.from, to: content });
    const width = `var(--md-hang-${id}, ${Math.round((content - line.from) * this.view.defaultCharacterWidth)}px)`;
    return `padding-left: calc(6px + ${width}); text-indent: calc(-1 * ${width})`;
  }

  measure(): void {
    if (!this.samples.size) return;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const found = new Map<number, number>();
        for (const [id, { from, to }] of this.samples) {
          if (to > view.state.doc.length) continue;
          const start = view.coordsAtPos(from, 1);
          const end = view.coordsAtPos(to, 1);
          if (start && end && end.left > start.left) found.set(id, end.left - start.left);
        }
        return found;
      },
      write: (found, view) => {
        for (const [id, width] of found) {
          if (Math.abs((this.widths.get(id) ?? -1) - width) < 0.5) continue;
          this.widths.set(id, width);
          view.dom.style.setProperty(`--md-hang-${id}`, `${width}px`);
        }
      },
    });
  }

  destroy(): void {
    for (const id of this.widths.keys()) this.view.dom.style.removeProperty(`--md-hang-${id}`);
  }
}

// The Link or Wikilink around `pos`.
function linkAround(state: EditorState, pos: number): Span | undefined {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "Link" || node.name === "Wikilink") return node;
  }
  return undefined;
}

// The tag drawn at `element`, by its place in the text.
function tagAround(view: EditorView, element: HTMLElement): Span {
  const from = view.posAtDOM(element);
  return { from, to: from + (element.textContent?.length ?? 0) };
}

class Formatter {
  formatting: Formatting;
  private readonly hanging: Hanging;
  // A press on a link to a space file or on a tag, kept until its click:
  // what it opens, and the selection from before the press, put back so the
  // click leaves the cursor where it was.
  private press: { open(): void; selection: EditorSelection } | undefined;
  private readonly unwatch: (() => void) | undefined;
  // Set while a button is held: redrawing waits, so nothing moves under a
  // press or a drag, and catches up when it lets go.
  private release: ((event: MouseEvent) => void) | undefined;
  private destroyed = false;

  constructor(readonly view: EditorView) {
    this.hanging = new Hanging(view);
    this.formatting = this.build();
    this.unwatch = view.state.facet(formattingLinks)?.watchTags?.(() => this.refreshSoon());
  }

  update(update: ViewUpdate): void {
    // An input method's composition holds the text still as a press does.
    if (this.release || update.view.composing) {
      const { marks, underlines } = this.formatting;
      this.formatting = { marks: marks.map(update.changes), underlines: underlines.map(update.changes) };
      return;
    }
    if (needsRedraw(update)) this.formatting = this.build();
    else if (update.geometryChanged) this.hanging.measure();
  }

  build(): Formatting {
    const { view } = this;
    this.hanging.begin();
    const hiding = syntaxHidden(view.state);
    const opened = shownSpans(view);
    const formatting = formattingDecorations({
      state: view.state,
      visible: view.visibleRanges,
      shown: hiding ? shownSpans(view, false) : opened,
      opened,
      hiding,
      links: view.state.facet(formattingLinks),
      hang: (key, line, content) => this.hanging.style(key, line, content),
    });
    this.hanging.measure();
    return formatting;
  }

  mousedown(event: MouseEvent, view: EditorView): boolean {
    if (event.button === 0) this.hold();
    this.press = undefined;
    if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }
    const target = event.target instanceof Element ? event.target : null;
    const links = view.state.facet(formattingLinks);
    const anchor = target?.closest<HTMLElement>("[data-space-path]");
    const path = anchor?.dataset.spacePath;
    const tag = target?.closest<HTMLElement>("[data-md-tag]");
    const name = tag?.dataset.mdTag;
    let span: Span | undefined;
    let open: (() => void) | undefined;
    if (anchor && path !== undefined) {
      span = linkAround(view.state, view.posAtDOM(anchor));
      open = () => links?.open(path, anchor.isConnected ? anchor : view.contentDOM);
    } else if (tag && name !== undefined && links?.openTag) {
      span = tagAround(view, tag);
      open = () => links.openTag?.(name);
    }
    // A cursor in the link or tag, or just past its end, makes the click edit it, as a web link's does.
    if (!span || !open || view.state.selection.ranges.some((range) => range.to > span.from && range.from <= span.to)) {
      return false;
    }
    this.press = { open, selection: view.state.selection };
    return false;
  }

  click(view: EditorView): boolean {
    const press = this.press;
    this.press = undefined;
    if (!press || !view.state.selection.main.empty) return false;
    view.dispatch({ selection: press.selection });
    press.open();
    return true;
  }

  hold(): void {
    if (this.release) return;
    // A button let go outside the window sends no mouseup; the next move says so.
    const release = (event: MouseEvent) => {
      if (event.type === "mousemove" && event.buttons & 1) return;
      this.stopHolding();
      this.refreshSoon();
    };
    this.release = release;
    window.addEventListener("mouseup", release, true);
    window.addEventListener("mousemove", release, true);
  }

  stopHolding(): void {
    if (!this.release) return;
    window.removeEventListener("mouseup", this.release, true);
    window.removeEventListener("mousemove", this.release, true);
    this.release = undefined;
  }

  // After the click a press ends in, which may put the selection back.
  refreshSoon(): void {
    setTimeout(() => {
      if (!this.destroyed) this.view.dispatch({ effects: formattingChanged.of(null) });
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unwatch?.();
    this.stopHolding();
    this.hanging.destroy();
  }
}

const formatter = ViewPlugin.fromClass(Formatter, {
  decorations: (plugin) => plugin.formatting.marks,
  // Above the highlighter's own raised precedence, so a link's underline
  // nests inside the span that colors it.
  provide: (plugin) =>
    Prec.highest(EditorView.decorations.of((view) => view.plugin(plugin)?.formatting.underlines ?? Decoration.none)),
  eventHandlers: {
    mousedown(event, view) {
      return this.mousedown(event, view);
    },
    click(_event, view) {
      return this.click(view);
    },
    compositionend() {
      this.refreshSoon();
      return false;
    },
  },
});

class GutterClass extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const headingGutters = [1, 2, 3, 4, 5, 6].map((level) => new GutterClass(`cm-md-heading cm-md-h${level}`));
const gapLineGutter = new GutterClass("cm-md-gap-line");

// What holds blocks, the only nodes walked to find every heading.
const BLOCK_HOLDERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

function headingLines(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  syntaxTree(state).iterate({
    enter(ref) {
      const level = HEADING_LEVELS[ref.name];
      if (level === undefined) return BLOCK_HOLDERS.has(ref.name);
      for (const line of headingTextLines(state.doc, ref.node)) {
        builder.add(line.from, line.from, headingGutters[level - 1]);
      }
      const gap = headingGap(state.doc, ref.node);
      if (gap?.blank) builder.add(gap.line.from, gap.line.from, gapLineGutter);
      return false;
    },
  });
  return builder.finish();
}

// Each heading line's gutter cells, classed so a line number and fold arrow
// sit on the heading's baseline, and a blank line drawn as a heading's gap,
// too short for its number. The whole note, not the screen: the gutter reads
// the classes from the state.
const headingGutter = StateField.define<RangeSet<GutterMarker>>({
  create: headingLines,
  update: (lines, tr) =>
    tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? headingLines(tr.state) : lines,
  provide: (field) => gutterLineClass.from(field),
});

/** A note's formatting, its links resolved and opened by `links`. */
export function markdownFormatting(links: FormattingLinks): Extension {
  return [formattingLinks.of(links), formatter, headingGutter, hiddenSyntax(noteSyntax)];
}
