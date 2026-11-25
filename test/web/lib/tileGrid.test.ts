// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTileGrid, FULL_ROW, fitTile, gridColumns, type TileGridOptions } from "../../../web/lib/tileGrid.ts";

// The grid measures itself as it is observed; here every grid is six
// columns wide.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly measure: ResizeObserverCallback) {}
    observe() {
      this.measure([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
});

afterEach(() => document.body.replaceChildren());

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

// Three tiles, each a handle and a field, on a grid of the caller's.
function grid(options: Partial<TileGridOptions> = {}) {
  const deps = { onMove: vi.fn(), onResize: vi.fn(), ...options };
  const made = createTileGrid({
    prefix: "demo",
    handles: { move: ".demo-handle", not: "input", keys: ".demo-handle" },
    ...deps,
  });
  document.body.append(made.el);
  const tiles = ["a", "b", "c"].map((name) => {
    const tile = document.createElement("div");
    const handle = Object.assign(document.createElement("div"), { className: "demo-handle", textContent: name });
    tile.append(handle, document.createElement("input"));
    made.add(tile, name === "a" ? { columns: FULL_ROW, rows: 2 } : { columns: 2, rows: 1 });
    return tile;
  });
  const handle = (tile: HTMLElement) => tile.querySelector(".demo-handle") as HTMLElement;
  const key = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  return { grid: made, deps, tiles, handle, key };
}

describe("createTileGrid", () => {
  it("names its parts by the shared grid and by the caller, and spans each tile clamped to the grid", () => {
    const { grid: made, tiles } = grid();
    expect(made.el.className).toBe("tile-grid demo-board is-arrangeable");
    expect([...made.el.children].map((child) => child.className)).toEqual([
      "tile-grid-guides demo-guides",
      "tile-grid-tiles demo-grid",
    ]);
    expect(made.tiles()).toEqual(tiles);
    expect(tiles.map((tile) => tile.style.getPropertyValue("--tile-columns"))).toEqual(["6", "2", "2"]);
    expect(tiles[0].querySelector(".corner-grip")?.className).toBe("corner-grip tile-grid-grip demo-tile-grip");
  });

  it("moves a tile by Alt with the arrows on its handle, and sizes it with Shift too", () => {
    const { deps, tiles, handle, key } = grid();
    key(handle(tiles[1]), "ArrowRight", { altKey: true });
    expect(deps.onMove).toHaveBeenCalledWith(tiles[2], tiles[1], "before");
    key(handle(tiles[1]), "ArrowDown", { altKey: true, shiftKey: true });
    expect(deps.onResize).toHaveBeenCalledWith(tiles[1], { columns: 2, rows: 2 });
  });

  it("takes a tile away by its x or by Delete on its handle, focusing the tile in its place", () => {
    const onRemove = vi.fn((tile: HTMLElement) => made.remove(tile));
    const { grid: made, tiles, handle, key } = grid({ removal: { label: "Remove from demo", onRemove } });
    const remove = tiles[0].querySelector(".tile-grid-remove") as HTMLButtonElement;
    expect([remove.getAttribute("aria-label"), remove.tabIndex]).toEqual(["Remove from demo", -1]);
    expect(handle(tiles[1]).getAttribute("aria-keyshortcuts")).toContain("Delete");

    remove.click();
    expect(onRemove).toHaveBeenLastCalledWith(tiles[0]);
    expect(made.tiles()).toEqual([tiles[1], tiles[2]]);

    handle(tiles[1]).focus();
    key(handle(tiles[1]), "Delete");
    expect(made.tiles()).toEqual([tiles[2]]);
    expect(document.activeElement).toBe(handle(tiles[2]));
    key(handle(tiles[2]), "Backspace");
    expect(made.tiles()).toEqual([]);
  });

  it("has no x without a removal, and asks nothing, nor stops Tab, while it can't be arranged", () => {
    expect(grid().tiles[0].querySelector(".tile-grid-remove")).toBeNull();
    document.body.replaceChildren();

    const onRemove = vi.fn();
    const { deps, tiles, handle, key } = grid({ arrangeable: false, removal: { label: "Remove", onRemove } });
    (tiles[0].querySelector(".tile-grid-remove") as HTMLButtonElement).click();
    key(handle(tiles[1]), "Delete");
    key(handle(tiles[1]), "ArrowRight", { altKey: true });
    expect(onRemove).not.toHaveBeenCalled();
    expect(deps.onMove).not.toHaveBeenCalled();
    expect(handle(tiles[1]).hasAttribute("tabindex")).toBe(false);
  });

  it("lets its tiles be arranged, or not, in place: the tab stops and keys follow", () => {
    const { grid: made, deps, tiles, handle, key } = grid({ arrangeable: false });
    expect(made.el.classList.contains("is-arrangeable")).toBe(false);
    made.setArrangeable(true);
    expect(made.el.classList.contains("is-arrangeable")).toBe(true);
    expect([handle(tiles[1]).tabIndex, handle(tiles[1]).hasAttribute("aria-keyshortcuts")]).toEqual([0, true]);
    key(handle(tiles[1]), "ArrowRight", { altKey: true });
    expect(deps.onMove).toHaveBeenCalledTimes(1);
    made.setArrangeable(false);
    expect([handle(tiles[1]).hasAttribute("tabindex"), handle(tiles[1]).hasAttribute("aria-keyshortcuts")]).toEqual([
      false,
      false,
    ]);
    key(handle(tiles[1]), "ArrowRight", { altKey: true });
    expect(deps.onMove).toHaveBeenCalledTimes(1);
  });

  it("keeps the cell guides showing while set, as a gesture shows them", () => {
    const { grid: made } = grid();
    expect(made.el.classList.contains("arranging")).toBe(false);
    made.setGuides(true);
    expect(made.el.classList.contains("arranging")).toBe(true);
    made.setGuides(false);
    expect(made.el.classList.contains("arranging")).toBe(false);
  });
});
