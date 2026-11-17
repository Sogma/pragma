import { describe, expect, it } from "vitest";
import { heightAtLine, lineAtHeight, risingAnchors } from "../../../web/core/scrollPlace.ts";

// Line 1 from the very top, a 400px image on line 3, then line 5.
const page = [
  { line: 1, y: 0 },
  { line: 3, y: 100 },
  { line: 5, y: 500 },
  { line: 6, y: 540 },
];

describe("risingAnchors", () => {
  it("keeps the first of the blocks that start on one line or at one height", () => {
    const list = { line: 3, y: 100 };
    const item = { line: 3, y: 100 };
    const nestedParagraph = { line: 4, y: 100 };
    expect(risingAnchors([{ line: 1, y: 0 }, list, item, nestedParagraph, { line: 5, y: 180 }])).toEqual([
      { line: 1, y: 0 },
      list,
      { line: 5, y: 180 },
    ]);
  });

  it("drops a block under the start of the file's first line, so the page's top is that line", () => {
    expect(
      risingAnchors([
        { line: 1, y: 0 },
        { line: 1, y: 60 },
        { line: 3, y: 120 },
      ]),
    ).toEqual([
      { line: 1, y: 0 },
      { line: 3, y: 120 },
    ]);
  });
});

describe("lineAtHeight and heightAtLine", () => {
  it("spread a block's lines over its height, so an image's line spans the image", () => {
    expect(lineAtHeight(page, 50)).toBe(2);
    expect(lineAtHeight(page, 300)).toBe(4);
    expect(heightAtLine(page, 4)).toBe(300);
    expect(heightAtLine(page, 5.5)).toBe(520);
  });

  it("run either way to the same place", () => {
    for (const y of [0, 37, 100, 299, 512]) expect(heightAtLine(page, lineAtHeight(page, y))).toBeCloseTo(y);
  });

  it("hold the nearer end past either end", () => {
    expect(lineAtHeight(page, -20)).toBe(1);
    expect(lineAtHeight(page, 900)).toBe(6);
    expect(heightAtLine(page, 0.5)).toBe(0);
    expect(heightAtLine(page, 40)).toBe(540);
  });

  it("answer a lone anchor's place for anything", () => {
    expect(lineAtHeight([{ line: 7, y: 20 }], 300)).toBe(7);
    expect(heightAtLine([{ line: 7, y: 20 }], 2)).toBe(20);
  });
});
