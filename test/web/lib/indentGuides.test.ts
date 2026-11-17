// @vitest-environment jsdom
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeGuide,
  guideLevels,
  guideRuns,
  indentColumns,
  indentGuides,
  wrappedLineIndent,
} from "../../../web/lib/indentGuides.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

// A style sheet indented by two, with blank lines inside and between blocks.
const SHEET = [
  ".a {", //            1
  "  color: red;", //   2
  "", //                3
  "  margin: 0;", //    4
  "    deep: 1;", //    5
  "", //                6
  "}", //               7
  "", //                8
  ".b {}", //           9
];

const levels = (lines: string[], unit = 2, tabSize = 4) => {
  const level = guideLevels(Text.of(lines), unit, tabSize);
  return lines.map((_, index) => level(index + 1));
};

describe("indentColumns", () => {
  it("counts spaces, runs a tab to its next stop, and has nothing for a blank line", () => {
    expect(indentColumns("    x", 4)).toBe(4);
    expect(indentColumns("\tx", 4)).toBe(4);
    expect(indentColumns("  \tx", 4)).toBe(4);
    expect(indentColumns("x", 4)).toBe(0);
    expect(indentColumns("", 4)).toBeUndefined();
    expect(indentColumns("   ", 4)).toBeUndefined();
  });
});

describe("guideLevels", () => {
  it("gives a line one guide per step of its indentation, a part step counting", () => {
    expect(levels(["x", "  x", "    x", "   x"])).toEqual([0, 1, 2, 2]);
    expect(levels(["\t\tx"], 4, 4)).toEqual([2]);
  });

  it("carries a block's guides through its blank lines, and none past its end", () => {
    expect(levels(SHEET)).toEqual([0, 1, 1, 1, 2, 1, 0, 0, 0]);
  });

  it("gives a blank line between a block's opening and its first line the block's guide", () => {
    expect(levels([".a {", "", "  color: red;", "}"])).toEqual([0, 1, 1, 0]);
  });

  it("gives a blank line at either end of the document none", () => {
    expect(levels(["", "  x", ""])).toEqual([0, 1, 0]);
  });
});

describe("activeGuide", () => {
  const level = guideLevels(Text.of(SHEET), 2, 4);
  const active = (line: number) => activeGuide(level, SHEET.length, line);

  it("is the guide beside a line inside a block, down the whole block, blank lines included", () => {
    expect(active(2)).toEqual({ level: 1, from: 2, to: 6 });
  });

  it("is the block's guide on the line that opens it", () => {
    expect(active(1)).toEqual({ level: 1, from: 2, to: 6 });
    expect(active(4)).toEqual({ level: 2, from: 5, to: 5 });
  });

  it("is none on a line outside every block", () => {
    expect(active(7)).toBeUndefined();
    expect(active(9)).toBeUndefined();
  });
});

describe("guideRuns", () => {
  const extents = SHEET.map((_, index) => ({ line: index + 1, top: index * 10, bottom: index * 10 + 10 }));
  const level = guideLevels(Text.of(SHEET), 2, 4);

  it("draws each level as one run down the lines that have it", () => {
    expect(guideRuns(extents, level, undefined)).toEqual([
      { level: 2, top: 40, bottom: 50, active: false },
      { level: 1, top: 10, bottom: 60, active: false },
    ]);
  });

  it("marks the cursor's block on its own level, split from the rest of that level", () => {
    expect(guideRuns(extents, level, { level: 1, from: 2, to: 3 })).toEqual([
      { level: 1, top: 10, bottom: 30, active: true },
      { level: 2, top: 40, bottom: 50, active: false },
      { level: 1, top: 30, bottom: 60, active: false },
    ]);
  });
});

describe("the editor extensions", () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  it("indents an indented line's wrapped rows by its indentation, and the first row back", () => {
    view = new EditorView({
      state: EditorState.create({ doc: SHEET.join("\n"), extensions: [wrappedLineIndent(), indentGuides()] }),
      parent: document.body,
    });
    const styles = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].map((line) =>
      line.getAttribute("style"),
    );
    expect(styles[0]).toBeNull();
    expect(styles[1]).toContain("padding-left: calc(6px + 2 * var(--indent-space, 0px))");
    expect(styles[1]).toContain("text-indent: calc(-1 * 2 * var(--indent-space, 0px))");
    expect(styles[4]).toContain("4 * var(--indent-space, 0px)");
    expect(styles[2]).toBeNull();
    expect(view.dom.querySelector(".cm-indent-guide-layer")).not.toBeNull();
  });
});
