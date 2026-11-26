// The rows ticked in a listing, for what acts on several at once. A pane
// keeps one for its life and hands it to every grid it draws, so the ticks
// outlast a redraw: a row is known by the pane's key for it, never by its
// place, and a row no longer shown drops out.

export interface RowSelectionOptions<Row> {
  /** Every row the listing shows, in the order shown, across its groups. */
  rows(): readonly Row[];
  /** What a row is known by across redraws: its file's path, or the row. */
  key(row: Row): unknown;
  /** Told after every change. */
  changed?(): void;
  /** What holds every grid the listing draws: a drawn element out of it is
   * one a redraw replaced. The page itself where absent. */
  root?: Element;
}

/** How a pick extends the ticks, as the file tree's selection does: a range
 * adds the run from the anchor to the rows picked before it, a toggle adds
 * or removes the row, and a plain pick ticks it alone. */
export interface RowPick {
  range?: boolean;
  toggle?: boolean;
}

export interface RowSelection<Row> {
  /** The ticked rows, in the order shown. */
  selected(): Row[];
  count(): number;
  has(row: Row): boolean;
  pick(row: Row, how?: RowPick): void;
  /** Ticks every row shown, or none once every one is. */
  toggleAll(): void;
  clear(): void;
  /** Drops the rows no longer shown, and the elements a redraw replaced:
   * called once a redraw is in the page, never during one. */
  prune(): void;
  /** Marks a row a grid drew, and finds it again by its element. */
  bind(element: HTMLTableRowElement, row: Row): void;
  rowOf(element: Element): Row | undefined;
  elementOf(row: Row): HTMLTableRowElement | undefined;
  /** The checkbox ending a row, and the header's, kept as the ticks are. */
  box(row: Row): HTMLInputElement;
  headerBox(): HTMLInputElement;
}

export function createRowSelection<Row>(options: RowSelectionOptions<Row>): RowSelection<Row> {
  let ticked = new Set<unknown>();
  // Where a range starts, and what was ticked before the run from it: a
  // second Shift pick replaces the run, never the rows picked apart from it.
  let anchor: unknown;
  let base: unknown[] = [];
  const rowsByElement = new WeakMap<Element, Row>();
  const elements = new Map<unknown, HTMLTableRowElement>();
  const boxes = new Map<HTMLInputElement, Row>();
  const headers = new Set<HTMLInputElement>();

  const keys = () => options.rows().map((row) => options.key(row));
  const has = (row: Row) => ticked.has(options.key(row));

  function headerState(box: HTMLInputElement): void {
    const total = options.rows().length;
    const count = selection.count();
    box.checked = total > 0 && count === total;
    box.indeterminate = count > 0 && count < total;
  }

  // A redraw builds its rows apart from the listing, so an element is let go
  // only once it is out of the listing after one: sweeping mid-redraw would
  // drop the rows being built.
  const held = (element: Element) => (options.root ? options.root.contains(element) : element.isConnected);
  function sweep(): void {
    for (const box of boxes.keys()) if (!held(box)) boxes.delete(box);
    for (const [key, element] of elements) if (!held(element)) elements.delete(key);
    for (const box of headers) if (!held(box)) headers.delete(box);
  }

  function paint(): void {
    for (const [box, row] of boxes) box.checked = has(row);
    for (const [key, element] of elements) element.classList.toggle("is-selected", ticked.has(key));
    for (const box of headers) headerState(box);
  }

  function set(next: Iterable<unknown>, from: unknown, before: unknown[]): void {
    ticked = new Set(next);
    anchor = from;
    base = before;
    paint();
    options.changed?.();
  }

  function checkbox(label: string): HTMLInputElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "row-select-box";
    box.tabIndex = -1;
    box.setAttribute("aria-label", label);
    return box;
  }

  const selection: RowSelection<Row> = {
    selected: () => options.rows().filter(has),
    count: () => keys().filter((key) => ticked.has(key)).length,
    has,
    pick(row, how = {}) {
      const key = options.key(row);
      if (how.range) {
        const order = keys();
        const from = anchor !== undefined && order.includes(anchor) ? anchor : key;
        const [a, b] = [order.indexOf(from), order.indexOf(key)].sort((x, y) => x - y);
        const before = from === anchor ? base : [];
        set([...before, ...order.slice(a, b + 1)], from, before);
      } else if (how.toggle) {
        const next = new Set(ticked);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        set(next, key, [...next]);
      } else {
        set([key], key, [key]);
      }
    },
    toggleAll() {
      const all = keys();
      set(all.every((key) => ticked.has(key)) ? [] : all, undefined, []);
    },
    clear() {
      if (ticked.size > 0) set([], undefined, []);
    },
    prune() {
      sweep();
      const shown = new Set(keys());
      const kept = [...ticked].filter((key) => shown.has(key));
      if (kept.length === ticked.size) return;
      set(
        kept,
        shown.has(anchor) ? anchor : undefined,
        base.filter((key) => shown.has(key)),
      );
    },
    bind(element, row) {
      rowsByElement.set(element, row);
      elements.set(options.key(row), element);
      element.classList.toggle("is-selected", has(row));
    },
    rowOf(element) {
      const row = element.closest("tr");
      return row ? rowsByElement.get(row) : undefined;
    },
    elementOf(row) {
      const element = elements.get(options.key(row));
      return element && held(element) ? element : undefined;
    },
    box(row) {
      const box = checkbox("Select row");
      box.checked = has(row);
      boxes.set(box, row);
      // The box's own click is the pick; the row's click never also takes it.
      box.addEventListener("click", (event) => {
        event.stopPropagation();
        selection.pick(row, { range: event.shiftKey, toggle: true });
      });
      return box;
    },
    headerBox() {
      const box = checkbox("Select all rows");
      headerState(box);
      headers.add(box);
      box.addEventListener("click", () => selection.toggleAll());
      return box;
    },
  };
  return selection;
}
