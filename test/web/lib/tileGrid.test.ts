import { describe, expect, it } from "vitest";
import { fitTile, gridColumns } from "../../../web/lib/tileGrid.ts";

describe("tileGrid", () => {
  it("has six columns, and two on a grid narrower than 650px", () => {
    expect(gridColumns(1238)).toBe(6); // a 1,286px pane, less its padding
    expect(gridColumns(650)).toBe(6);
    expect(gridColumns(649)).toBe(2);
    expect(gridColumns(518)).toBe(2); // the same pane at split width
    expect(gridColumns(0)).toBe(2);
  });

  it("clamps a tile's columns to the grid's and caps its rows at 8", () => {
    expect(fitTile({ columns: 4, rows: 3 }, 8)).toEqual({ columns: 4, rows: 3 });
    expect(fitTile({ columns: 4, rows: 12 }, 3)).toEqual({ columns: 3, rows: 8 });
  });
});
