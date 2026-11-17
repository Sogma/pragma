import { describe, expect, it } from "vitest";
import { combinedTileSize, FULL_ROW, fitTile, gridColumns, TILE_SIZES } from "../../../web/flow/appModeGrid.ts";

describe("appModeGrid", () => {
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
    expect(fitTile(TILE_SIZES.textResult, 5)).toEqual({ columns: 5, rows: 3 });
  });

  it("gives several fields the widest one's columns and the sum of their rows, capped at 8", () => {
    expect(combinedTileSize([TILE_SIZES.line, TILE_SIZES.textBox])).toEqual({ columns: 3, rows: 3 });
    expect(combinedTileSize([TILE_SIZES.applet, TILE_SIZES.imagePicker, TILE_SIZES.line])).toEqual({
      columns: 4,
      rows: 8,
    });
    expect(combinedTileSize([TILE_SIZES.toggle, TILE_SIZES.textResult]).columns).toBe(FULL_ROW);
  });
});
