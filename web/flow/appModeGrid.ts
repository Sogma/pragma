// App Mode's tile grid: the shared grid (lib/tileGrid.ts) with App Mode's
// tiles, their default sizes and the handles they move by.

import {
  createTileGrid,
  FULL_ROW,
  TILE_MAX_ROWS,
  type TileGrid,
  type TileGridOptions,
  type TileSize,
} from "../lib/tileGrid.ts";

/** A field's default tile, by what it shows. */
export const TILE_SIZES = {
  // A single-line text or number, a dropdown, a table row, a folder pick.
  line: { columns: 2, rows: 1 },
  textBox: { columns: 3, rows: 2 },
  toggle: { columns: 1, rows: 1 },
  imagePicker: { columns: 2, rows: 3 },
  imageResult: { columns: 3, rows: 3 },
  videoResult: { columns: 4, rows: 3 },
  chart: { columns: 4, rows: 3 },
  applet: { columns: 4, rows: 4 },
  textResult: { columns: FULL_ROW, rows: 3 },
  run: { columns: 2, rows: 1 },
} as const satisfies Record<string, TileSize>;

/** Several fields in one tile: the widest one's columns and the sum of their
 * rows. */
export function combinedTileSize(sizes: readonly TileSize[]): TileSize {
  return {
    columns: Math.max(...sizes.map((size) => size.columns)),
    rows: Math.min(
      TILE_MAX_ROWS,
      sizes.reduce((sum, size) => sum + size.rows, 0),
    ),
  };
}

// Where a press can start a move: a tile's title, or anywhere on a tile that
// is one control, a toggle or Run. Never a field, so typing, picking and
// copying in a tile stay what they were. A title or Run's own button takes
// a tile's keys.
const HANDLES = {
  move: ".flow-app-node-title, .flow-app-toggle, .flow-app-run-item",
  not: "input, textarea, select, .flow-node-textbox-copy",
  keys: ".flow-app-node-title, .flow-app-run-button",
};

export function createAppModeGrid(options: Pick<TileGridOptions, "onMove" | "onResize">): TileGrid {
  return createTileGrid({ ...options, prefix: "flow-app", handles: HANDLES });
}
