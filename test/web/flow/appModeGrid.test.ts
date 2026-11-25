import { describe, expect, it } from "vitest";
import { combinedTileSize, TILE_SIZES } from "../../../web/flow/appModeGrid.ts";
import { FULL_ROW, fitTile } from "../../../web/lib/tileGrid.ts";

describe("appModeGrid", () => {
  it("fits a full-row tile to the grid's columns", () => {
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
