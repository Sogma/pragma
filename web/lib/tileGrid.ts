// A grid of tiles that fill it row by row in order, each spanning whole
// cells. Six columns, or two on a narrow grid, so a stored width is a share
// of the row its designer can predict, and a tile wider than the grid spans
// it whole (docs/protocol.md's App mode section).
//
// A tile moves by its handle, resizes by its corner grip, takes Alt with the
// arrows, and leaves by its x where the caller allows. Its looks are
// tile-grid.css's.

/** A tile's span in whole cells, as stored or by default. Its columns may be
 * FULL_ROW, spanning the row whatever the grid's width. */
export interface TileSize {
  columns: number;
  rows: number;
}

export const FULL_ROW = Number.POSITIVE_INFINITY;

const COLUMNS = 6;
const NARROW_COLUMNS = 2;
// Below this width six columns would be too narrow for a toggle's title.
const NARROW_BELOW_PX = 650;
export const TILE_MAX_ROWS = 8;

export function gridColumns(width: number): number {
  return width < NARROW_BELOW_PX ? NARROW_COLUMNS : COLUMNS;
}

/** A size as a grid of `columns` shows it. */
export function fitTile(size: TileSize, columns: number): TileSize {
  return { columns: Math.min(size.columns, columns), rows: Math.min(size.rows, TILE_MAX_ROWS) };
}

export type DropZone = "before" | "after";

export interface TileGridOptions {
  // The stem of the grid's class names: its board, guides and grid, a tile's
  // grip, a move's ghost and a resize's badge are `<prefix>-board` and so on.
  prefix: string;
  // Where a press can start a move, where it never can, and what takes a
  // tile's keys: selectors inside a tile.
  handles: { move: string; not: string; keys: string };
  // Whether the tiles may move or resize now; absent, they always may.
  canArrange?: () => boolean;
  // A tile dropped beside another, never beside itself. The grid leaves the
  // move to the caller, whose order it is.
  onMove(tile: HTMLElement, target: HTMLElement, zone: DropZone): void;
  // A tile's grip set a new size, which the grid already shows.
  onResize(tile: HTMLElement, size: TileSize): void;
  // A tile's x, or Delete on its handle, asks the caller to take the tile
  // away, through `remove` or by drawing the grid again. `label` names the
  // x. Absent, tiles have none.
  removal?: { label: string; onRemove(tile: HTMLElement): void };
}

export interface TileGrid {
  // What the caller mounts: the tiles, over the cell guides an arranging
  // gesture shows.
  readonly el: HTMLDivElement;
  // The tiles, in order.
  tiles(): HTMLElement[];
  // Appends a tile, last in the sequence.
  add(tile: HTMLElement, size: TileSize): void;
  // Takes a tile out of the grid.
  remove(tile: HTMLElement): void;
  // Keeps the cell guides showing while on, not only during a gesture.
  setGuides(on: boolean): void;
  // Measures the grid now, rather than on its next resize.
  layout(): void;
  dispose(): void;
}

// What the gestures need of the grid they arrange.
interface Arrangeable {
  board: HTMLElement;
  grid: HTMLElement;
  // The element of `tile` that takes its keys.
  handleOf(tile: HTMLElement): HTMLElement;
  columns(): number;
  sizeOf(tile: HTMLElement): TileSize;
  // Shows `size` on `tile` now; the grid reflows around it.
  show(tile: HTMLElement, size: TileSize): void;
  guides(on: boolean): void;
}

// The grid's column count is set here rather than by CSS auto-fill, so each
// tile's span can clamp to it: a span wider than the grid would make CSS add
// implicit columns and overflow the pane.
export function createTileGrid(options: TileGridOptions): TileGrid {
  const { prefix } = options;
  const board = document.createElement("div");
  board.className = `tile-grid ${prefix}-board`;
  const guides = document.createElement("div");
  guides.className = `tile-grid-guides ${prefix}-guides`;
  const grid = document.createElement("div");
  grid.className = `tile-grid-tiles ${prefix}-grid`;
  board.append(guides, grid);
  const sizes = new Map<HTMLElement, TileSize>();
  let columns = 1;
  // Whether a gesture shows the guides now, and whether they show anyway.
  let gesturing = false;
  let pinned = false;
  const keyHandle = options.handles.keys
    .split(",")
    .map((selector) => `:scope > ${selector.trim()}`)
    .join(", ");
  const handleOf = (tile: HTMLElement) => tile.querySelector<HTMLElement>(keyHandle) ?? tile;

  function applySpan(tile: HTMLElement, size: TileSize): void {
    const span = fitTile(size, columns);
    tile.style.setProperty("--tile-columns", String(span.columns));
    tile.style.setProperty("--tile-rows", String(span.rows));
  }

  function layout(): void {
    const next = gridColumns(grid.clientWidth);
    if (next !== columns) {
      columns = next;
      board.style.setProperty("--app-columns", String(columns));
      for (const [tile, size] of sizes) applySpan(tile, size);
    }
    if (gesturing || pinned) drawGuides();
  }

  function showGuides(): void {
    const on = gesturing || pinned;
    board.classList.toggle("arranging", on);
    if (on) drawGuides();
  }

  // One dashed cell for every cell the tiles reach, and a row more below
  // them, so a tile shows the room it can grow into.
  function drawGuides(): void {
    const style = getComputedStyle(grid);
    const row = Number.parseFloat(style.gridAutoRows);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const rows = row > 0 ? Math.round((grid.offsetHeight + gap) / (row + gap)) + 1 : 0;
    const cells = columns * rows;
    while (guides.childElementCount < cells) guides.appendChild(document.createElement("i"));
    while (guides.childElementCount > cells) guides.lastElementChild?.remove();
  }

  const observer = new ResizeObserver(layout);
  observer.observe(grid);
  board.style.setProperty("--app-columns", String(columns));
  const gestures = bindGestures(
    {
      board,
      grid,
      handleOf,
      columns: () => columns,
      sizeOf: (tile) => sizes.get(tile) ?? { columns: 1, rows: 1 },
      show(tile, size) {
        sizes.set(tile, size);
        applySpan(tile, size);
        if (gesturing || pinned) drawGuides();
      },
      guides(on) {
        gesturing = on;
        showGuides();
      },
    },
    options,
  );

  return {
    el: board,
    tiles: () => [...grid.children] as HTMLElement[],
    add(tile, size) {
      sizes.set(tile, size);
      applySpan(tile, size);
      // A tile added while the grid can't be arranged gets no stop in the
      // tab order and claims no keys, so Tab goes from field to field. A
      // caller whose answer changes adds its tiles again.
      if (!options.canArrange || options.canArrange()) {
        const handle = handleOf(tile);
        handle.tabIndex = 0;
        handle.setAttribute("aria-keyshortcuts", options.removal ? `${KEY_SHORTCUTS} Delete` : KEY_SHORTCUTS);
      }
      const grip = document.createElement("span");
      grip.className = `corner-grip tile-grid-grip ${prefix}-tile-grip`;
      tile.appendChild(grip);
      const { removal } = options;
      if (removal) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = `icon-button tile-grid-remove ${prefix}-tile-remove`;
        remove.tabIndex = -1;
        remove.setAttribute("aria-label", removal.label);
        remove.addEventListener("click", () => {
          if (!options.canArrange || options.canArrange()) removal.onRemove(tile);
        });
        tile.appendChild(remove);
      }
      grid.appendChild(tile);
      if (gesturing || pinned) drawGuides();
    },
    remove(tile) {
      sizes.delete(tile);
      tile.remove();
      if (gesturing || pinned) drawGuides();
    },
    setGuides(on) {
      pinned = on;
      showGuides();
    },
    layout,
    dispose() {
      observer.disconnect();
      gestures.cancel();
    },
  };
}

// A press becomes a move only past this distance, so a press still clicks.
const MOVE_THRESHOLD_PX = 5;
// A gesture this close to the pane's top or bottom edge scrolls the pane, up
// to SCROLL_MAX_PX a frame at the very edge.
const SCROLL_EDGE_PX = 48;
const SCROLL_MAX_PX = 16;
const GHOST_MAX_WIDTH = 340;
const GHOST_MAX_HEIGHT = 200;

interface Arrow {
  place: -1 | 1;
  columns: number;
  rows: number;
}

// With Alt, an arrow moves a tile a place earlier or later; with Shift too,
// it makes the tile a cell narrower, wider, shorter or taller.
const ARROWS: Record<string, Arrow> = {
  ArrowLeft: { place: -1, columns: -1, rows: 0 },
  ArrowRight: { place: 1, columns: 1, rows: 0 },
  ArrowUp: { place: -1, columns: 0, rows: -1 },
  ArrowDown: { place: 1, columns: 0, rows: 1 },
};

const KEY_SHORTCUTS = Object.keys(ARROWS)
  .flatMap((key) => [`Alt+${key}`, `Alt+Shift+${key}`])
  .join(" ");

interface Move {
  ghost: HTMLElement;
  // Where the pointer holds the ghost.
  dx: number;
  dy: number;
  target?: { tile: HTMLElement; zone: DropZone };
}

interface Resize {
  badge: HTMLElement;
  // The tile's box at the press, and the cell it is measured in.
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  // What the tile held and showed when the grip was pressed.
  stored: TileSize;
  shown: TileSize;
  size: TileSize;
}

interface Press {
  tile: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  // The pointer now, and the pane's scroll at the press, so a gesture
  // follows the content as the pane scrolls under it.
  atX: number;
  atY: number;
  scrollTop: number;
  move?: Move;
  resize?: Resize;
  // Escape ended the gesture, and the release must still click nothing.
  cancelled?: boolean;
  frame: number;
}

function bindGestures(arrange: Arrangeable, options: TileGridOptions): { cancel(): void } {
  const { board, grid } = arrange;
  const { prefix, handles } = options;
  const pane = () => board.parentElement;
  let press: Press | null = null;
  let swallowClick = false;

  // The grid's own child holding `under`, if any.
  function tileOf(under: Element | null): HTMLElement | undefined {
    let node = under;
    while (node && node.parentElement !== grid) node = node.parentElement;
    return node instanceof HTMLElement ? node : undefined;
  }

  grid.addEventListener("pointerdown", (event) => {
    const under = event.target;
    if (press || event.button !== 0 || !(under instanceof Element)) return;
    if (options.canArrange && !options.canArrange()) return;
    const tile = tileOf(under);
    if (!tile) return;
    const grip = under.closest(`.${prefix}-tile-grip`);
    if (!grip && (!under.closest(handles.move) || under.closest(handles.not))) return;
    const { clientX: x, clientY: y, pointerId } = event;
    press = { tile, pointerId, x, y, atX: x, atY: y, scrollTop: pane()?.scrollTop ?? 0, frame: 0 };
    if (grip) {
      event.preventDefault();
      begin(press);
      press.resize = startResize(press);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
  });

  // Mod+Alt+Arrow is the app's Back and Forward, so it passes through, as
  // every arrow does in a field.
  grid.addEventListener("keydown", (event) => {
    const arrow = ARROWS[event.key];
    const handle = event.target;
    if (!arrow || !event.altKey || event.ctrlKey || event.metaKey || press) return;
    if (options.canArrange && !options.canArrange()) return;
    if (!(handle instanceof HTMLElement) || !handle.matches(handles.keys)) return;
    const tile = tileOf(handle);
    if (!tile) return;
    event.preventDefault();
    if (event.shiftKey) resizeBy(tile, arrow);
    else moveBy(tile, arrow.place);
    handle.scrollIntoView?.({ block: "nearest" });
  });

  // Delete on a tile's handle takes the tile away, as its x does, and hands
  // focus to the tile now in its place, or the one before at the end.
  grid.addEventListener("keydown", (event) => {
    const { removal } = options;
    if (!removal || press || (event.key !== "Delete" && event.key !== "Backspace")) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (options.canArrange && !options.canArrange()) return;
    const handle = event.target;
    if (!(handle instanceof HTMLElement) || !handle.matches(handles.keys)) return;
    const tile = tileOf(handle);
    if (!tile) return;
    event.preventDefault();
    const next = tile.nextElementSibling ?? tile.previousElementSibling;
    removal.onRemove(tile);
    if (!tile.isConnected && next instanceof HTMLElement) arrange.handleOf(next).focus();
  });

  // The neighbour crosses the tile, not the tile the neighbour: taking the
  // focused handle out of the document to move it would drop its focus.
  function moveBy(tile: HTMLElement, place: Arrow["place"]): void {
    const neighbour = place < 0 ? tile.previousElementSibling : tile.nextElementSibling;
    if (neighbour instanceof HTMLElement) options.onMove(neighbour, tile, place < 0 ? "after" : "before");
  }

  function resizeBy(tile: HTMLElement, arrow: Arrow): void {
    const stored = arrange.sizeOf(tile);
    const shown = fitTile(stored, arrange.columns());
    const size = {
      columns: Math.max(1, Math.min(arrange.columns(), shown.columns + arrow.columns)),
      rows: Math.max(1, Math.min(TILE_MAX_ROWS, shown.rows + arrow.rows)),
    };
    commit(tile, stored, shown, size);
  }

  // The release that ends a gesture would click what it was pressed on.
  grid.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );

  function onPointerMove(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId || press.cancelled) return;
    press.atX = event.clientX;
    press.atY = event.clientY;
    if (!press.move && !press.resize) {
      if (Math.hypot(press.atX - press.x, press.atY - press.y) < MOVE_THRESHOLD_PX) return;
      begin(press);
      press.move = startMove(press);
    }
    follow(press);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    const { tile, move, resize, cancelled } = press;
    finish();
    if (!move && !resize && !cancelled) return;
    swallowClick = true;
    setTimeout(() => {
      swallowClick = false;
    });
    if (cancelled) return;
    if (move?.target && move.target.tile !== tile) options.onMove(tile, move.target.tile, move.target.zone);
    if (resize) commit(tile, resize.stored, resize.shown, resize.size);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!press || event.pointerId !== press.pointerId) return;
    if (press.resize) arrange.show(press.tile, press.resize.stored);
    finish();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !press || (!press.move && !press.resize)) return;
    event.preventDefault();
    event.stopPropagation();
    if (press.resize) arrange.show(press.tile, press.resize.stored);
    end(press);
    press.cancelled = true;
  }

  // What every gesture does as it starts: hold the pointer, show the guides,
  // and follow the pane's edges.
  function begin(press: Press): void {
    grid.setPointerCapture(press.pointerId);
    window.getSelection()?.removeAllRanges();
    arrange.guides(true);
    const scroll = () => {
      if (scrollNearEdge(press)) follow(press);
      press.frame = requestAnimationFrame(scroll);
    };
    press.frame = requestAnimationFrame(scroll);
  }

  function startMove(press: Press): Move {
    const rect = press.tile.getBoundingClientRect();
    const ghost = press.tile.cloneNode(true) as HTMLElement;
    // A frame in the copy would load and run its page a second time.
    for (const el of ghost.querySelectorAll("iframe, .tile-grid-grip, .tile-grid-remove")) el.remove();
    ghost.classList.add("tile-grid-ghost", `${prefix}-move-ghost`);
    const width = Math.min(rect.width, GHOST_MAX_WIDTH);
    const height = Math.min(rect.height, GHOST_MAX_HEIGHT);
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
    document.body.appendChild(ghost);
    press.tile.classList.add("moving");
    board.classList.add("moving");
    return { ghost, dx: Math.min(press.x - rect.left, width - 20), dy: Math.min(press.y - rect.top, height - 20) };
  }

  // The cell is measured from the tile itself, which spans whole cells and
  // the gaps between them.
  function startResize(press: Press): Resize {
    const rect = press.tile.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const columnGap = Number.parseFloat(style.columnGap) || 0;
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const stored = arrange.sizeOf(press.tile);
    const shown = fitTile(stored, arrange.columns());
    const badge = document.createElement("span");
    badge.className = `tile-grid-badge ${prefix}-tile-badge`;
    badge.textContent = `${shown.columns} × ${shown.rows}`;
    press.tile.appendChild(badge);
    press.tile.classList.add("resizing");
    board.classList.add("resizing");
    return {
      badge,
      width: rect.width,
      height: rect.height,
      cellWidth: (rect.width - (shown.columns - 1) * columnGap) / shown.columns,
      cellHeight: (rect.height - (shown.rows - 1) * rowGap) / shown.rows,
      stored,
      shown,
      size: shown,
    };
  }

  function follow(press: Press): void {
    if (press.move) aim(press, press.move);
    if (press.resize) reshape(press, press.resize);
  }

  function aim(press: Press, move: Move): void {
    const { atX: x, atY: y } = press;
    move.ghost.style.transform = `translate(${x - move.dx}px, ${y - move.dy}px) rotate(1.5deg)`;
    move.target?.tile.classList.remove("drop-before", "drop-after");
    move.target = dropTarget(document.elementFromPoint(x, y), x, y);
    if (move.target && move.target.tile !== press.tile) move.target.tile.classList.add(`drop-${move.target.zone}`);
  }

  // The tile under the pointer takes the drop before it on its left half and
  // after it on its right. The grid's own background, or the pane below its
  // last row, takes it last; anywhere else takes nothing.
  function dropTarget(under: Element | null, x: number, y: number): Move["target"] {
    const tile = tileOf(under);
    if (tile) {
      const rect = tile.getBoundingClientRect();
      return { tile, zone: x < rect.left + rect.width / 2 ? "before" : "after" };
    }
    const last = grid.lastElementChild;
    const below = !!under && !!pane()?.contains(under) && y > grid.getBoundingClientRect().bottom;
    return last instanceof HTMLElement && (under === grid || below) ? { tile: last, zone: "after" } : undefined;
  }

  // Snaps the corner to the nearest whole cell, within the grid's columns
  // and TILE_MAX_ROWS.
  function reshape(press: Press, resize: Resize): void {
    const style = getComputedStyle(grid);
    const columnGap = Number.parseFloat(style.columnGap) || 0;
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const dx = press.atX - press.x;
    const dy = press.atY - press.y + (pane()?.scrollTop ?? 0) - press.scrollTop;
    const cells = (length: number, cell: number, gap: number, most: number) =>
      Math.max(1, Math.min(most, Math.round((length + gap) / (cell + gap))));
    const size = {
      columns: cells(resize.width + dx, resize.cellWidth, columnGap, arrange.columns()),
      rows: cells(resize.height + dy, resize.cellHeight, rowGap, TILE_MAX_ROWS),
    };
    if (size.columns === resize.size.columns && size.rows === resize.size.rows) return;
    resize.size = size;
    resize.badge.textContent = `${size.columns} × ${size.rows}`;
    arrange.show(press.tile, size);
  }

  // A dimension a resize left as it was keeps what the tile held, so making
  // a tile taller at split width doesn't narrow it at full width.
  function commit(tile: HTMLElement, stored: TileSize, shown: TileSize, size: TileSize): void {
    if (size.columns === shown.columns && size.rows === shown.rows) {
      arrange.show(tile, stored);
      return;
    }
    const kept = {
      columns: size.columns === shown.columns && Number.isInteger(stored.columns) ? stored.columns : size.columns,
      rows: size.rows === shown.rows ? stored.rows : size.rows,
    };
    arrange.show(tile, kept);
    options.onResize(tile, kept);
  }

  function scrollNearEdge(press: Press): boolean {
    const scroller = pane();
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    const rect = scroller.getBoundingClientRect();
    const depth = (into: number) => Math.min(into, SCROLL_EDGE_PX) / SCROLL_EDGE_PX;
    const above = rect.top + SCROLL_EDGE_PX - press.atY;
    const below = press.atY - (rect.bottom - SCROLL_EDGE_PX);
    const step = above > 0 ? -depth(above) : below > 0 ? depth(below) : 0;
    const before = scroller.scrollTop;
    scroller.scrollTop += Math.round(step * SCROLL_MAX_PX);
    return scroller.scrollTop !== before;
  }

  // Undoes what a gesture showed while it ran; the press itself stays until
  // its release.
  function end(press: Press): void {
    cancelAnimationFrame(press.frame);
    if (press.move) {
      press.move.ghost.remove();
      press.move.target?.tile.classList.remove("drop-before", "drop-after");
    }
    press.resize?.badge.remove();
    press.tile.classList.remove("moving", "resizing");
    board.classList.remove("moving", "resizing");
    arrange.guides(false);
    if (grid.hasPointerCapture(press.pointerId)) grid.releasePointerCapture(press.pointerId);
  }

  function finish(): void {
    if (press && (press.move || press.resize) && !press.cancelled) end(press);
    press = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
  }

  return { cancel: finish };
}
