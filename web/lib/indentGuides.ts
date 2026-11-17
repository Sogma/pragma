// Code's indentation guides and the indent of its wrapped rows. A guide runs
// down each step of indentation through the lines inside the block, blank
// ones included, and the cursor's block has its own; a long line's wrapped
// rows start at its indentation, clear of the guides.
//
// Both are placed by a space's width measured where the text lands, never
// assumed from the font, so they line up in any font. The guides are
// borders on a layer of their own, as the file tree draws its guides: a 1px
// gradient stripe lands one or two device pixels wide at 125% and 150%.
import { getIndentUnit } from "@codemirror/language";
import { RangeSetBuilder, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  layer,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** The columns a line's leading whitespace takes, a tab running to its next
 * stop; undefined for a line with nothing else on it. */
export function indentColumns(text: string, tabSize: number): number | undefined {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns++;
    else if (char === "\t") columns += tabSize - (columns % tabSize);
    else return columns;
  }
  return undefined;
}

// How far a blank line looks for code above and below it, and the cursor's
// block for its ends.
const SCAN_LIMIT = 1000;

/** Each line's guide count, by line number. A blank line takes its count
 * from the code around it, so a block's guides run on through the blank
 * lines inside it and stop with the block. */
export function guideLevels(doc: Text, unit: number, tabSize: number): (line: number) => number {
  const levels = new Map<number, number>();
  const columns = (line: number) => indentColumns(doc.line(line).text, tabSize);
  const nearest = (line: number, step: 1 | -1) => {
    for (let n = line + step, scanned = 0; n >= 1 && n <= doc.lines && scanned < SCAN_LIMIT; n += step, scanned++) {
      const found = columns(n);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return (line) => {
    const known = levels.get(line);
    if (known !== undefined) return known;
    const own = columns(line);
    let level: number;
    if (own !== undefined) level = Math.ceil(own / unit);
    else {
      const above = nearest(line, -1);
      const below = nearest(line, 1);
      if (above === undefined || below === undefined) level = 0;
      else if (above === below) level = Math.ceil(below / unit);
      else level = 1 + Math.floor(Math.min(above, below) / unit);
    }
    levels.set(line, level);
    return level;
  };
}

export interface ActiveGuide {
  level: number;
  from: number;
  to: number;
}

/** The guide of the cursor's block and the lines it runs down: a line that
 * opens a block shows that block's, any other line the one beside it. */
export function activeGuide(level: (line: number) => number, lines: number, line: number): ActiveGuide | undefined {
  const here = level(line);
  const opens = line < lines && level(line + 1) > here;
  const active = opens ? here + 1 : here;
  if (active === 0) return undefined;
  let from = opens ? line + 1 : line;
  let to = from;
  for (let scanned = 0; from > 1 && level(from - 1) >= active && scanned < SCAN_LIMIT; scanned++) from--;
  for (let scanned = 0; to < lines && level(to + 1) >= active && scanned < SCAN_LIMIT; scanned++) to++;
  return { level: active, from, to };
}

// A space's width as drawn, read off a rendered line indented with spaces;
// CodeMirror's average character width where none is.
function spaceWidth(view: EditorView): number {
  for (const { from } of view.viewportLineBlocks) {
    const text = view.state.doc.lineAt(from).text;
    const spaces = /^ +/.exec(text)?.[0].length;
    if (!spaces || spaces === text.length) continue;
    const start = view.coordsAtPos(from, 1);
    const end = view.coordsAtPos(from + spaces, 1);
    if (start && end && end.left > start.left) return (end.left - start.left) / spaces;
  }
  return view.defaultCharacterWidth;
}

export interface GuideRun {
  level: number;
  top: number;
  bottom: number;
  active: boolean;
}

/** Each level's guide as runs down consecutive lines, given each line's
 * extent; a run splits where the cursor's block starts or ends. */
export function guideRuns(
  lines: readonly { line: number; top: number; bottom: number }[],
  level: (line: number) => number,
  active: ActiveGuide | undefined,
): GuideRun[] {
  const runs: GuideRun[] = [];
  const open: (GuideRun | undefined)[] = [];
  for (const { line, top, bottom } of lines) {
    const count = level(line);
    const activeLevel = active && line >= active.from && line <= active.to ? active.level : 0;
    for (let k = 1; k <= Math.max(count, open.length); k++) {
      const run = open[k - 1];
      const isActive = k === activeLevel;
      if (run && (k > count || run.active !== isActive)) {
        runs.push(run);
        open[k - 1] = undefined;
      }
      if (k > count) continue;
      const current = open[k - 1];
      if (current) current.bottom = bottom;
      else open[k - 1] = { level: k, top, bottom, active: isActive };
    }
  }
  for (const run of open) if (run) runs.push(run);
  return runs;
}

function guideMarkers(view: EditorView): RectangleMarker[] {
  const { state } = view;
  const blocks = view.viewportLineBlocks;
  const origin = blocks.length ? view.coordsAtPos(blocks[0].from, 1) : null;
  if (!origin) return [];
  const unit = getIndentUnit(state);
  const level = guideLevels(state.doc, unit, state.tabSize);
  const active = activeGuide(level, state.doc.lines, state.doc.lineAt(state.selection.main.head).number);
  const step = unit * spaceWidth(view);
  // Placed from the scroller's content origin, as the selection's markers are.
  const scroller = view.scrollDOM.getBoundingClientRect();
  const left = origin.left - (scroller.left - view.scrollDOM.scrollLeft * view.scaleX);
  const top = view.documentTop - (scroller.top - view.scrollDOM.scrollTop * view.scaleY);
  const lines = blocks.map((block) => ({
    line: state.doc.lineAt(block.from).number,
    top: top + block.top * view.scaleY,
    bottom: top + block.bottom * view.scaleY,
  }));
  return guideRuns(lines, level, active).map(
    (run) =>
      new RectangleMarker(
        run.active ? "cm-indent-guide active" : "cm-indent-guide",
        left + (run.level - 1) * step,
        run.top,
        null,
        run.bottom - run.top,
      ),
  );
}

/** The guides, on a layer under the text. */
export function indentGuides() {
  return layer({
    above: false,
    class: "cm-indent-guide-layer",
    markers: guideMarkers,
    update: (update) =>
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      getIndentUnit(update.startState) !== getIndentUnit(update.state),
  });
}

// CodeMirror's own .cm-line padding is 6px on the left, so a wrapped row
// starts that far plus the indentation in, and the first row takes the
// indentation back through text-indent. The fallback keeps the 6px until a
// space has been measured.
const wrapIndents = new Map<number, Decoration>();
function wrapIndent(columns: number): Decoration {
  let decoration = wrapIndents.get(columns);
  if (!decoration) {
    const width = `${columns} * var(--indent-space, 0px)`;
    decoration = Decoration.line({
      attributes: { style: `padding-left: calc(6px + ${width}); text-indent: calc(-1 * ${width})` },
    });
    wrapIndents.set(columns, decoration);
  }
  return decoration;
}

/** Starts a long line's wrapped rows at its indentation. */
export function wrappedLineIndent() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(readonly view: EditorView) {
        this.decorations = this.build();
        this.measure();
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = this.build();
        if (update.docChanged || update.viewportChanged || update.geometryChanged) this.measure();
      }
      measure() {
        this.view.requestMeasure({
          key: this,
          read: spaceWidth,
          write: (width, view) => view.dom.style.setProperty("--indent-space", `${width}px`),
        });
      }
      build(): DecorationSet {
        const { doc, tabSize } = this.view.state;
        const builder = new RangeSetBuilder<Decoration>();
        for (let pos = this.view.viewport.from; pos <= this.view.viewport.to; ) {
          const line = doc.lineAt(pos);
          const columns = indentColumns(line.text, tabSize);
          if (columns) builder.add(line.from, line.from, wrapIndent(columns));
          pos = line.to + 1;
        }
        return builder.finish();
      }
      destroy() {
        this.view.dom.style.removeProperty("--indent-space");
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
