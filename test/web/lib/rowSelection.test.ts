// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createRowSelection } from "../../../web/lib/rowSelection.ts";

interface Row {
  path: string;
}

function setup(paths = ["a", "b", "c", "d", "e"]) {
  let rows: Row[] = paths.map((path) => ({ path }));
  const changed = vi.fn();
  const selection = createRowSelection<Row>({ rows: () => rows, key: (row) => row.path, changed });
  const at = (path: string) => rows.find((row) => row.path === path) as Row;
  const ticked = () => selection.selected().map((row) => row.path);
  return {
    selection,
    changed,
    at,
    ticked,
    show: (next: string[]) => {
      rows = next.map((path) => ({ path }));
    },
  };
}

// A drawn row, its box and a header box, in the page as a grid's are.
function drawn(selection: ReturnType<typeof setup>["selection"], row: Row) {
  const table = document.createElement("table");
  const tr = table.insertRow();
  const box = selection.box(row);
  tr.insertCell().append(box);
  const head = selection.headerBox();
  table.createTHead().insertRow().insertCell().append(head);
  selection.bind(tr, row);
  document.body.append(table);
  onTestFinished(() => table.remove());
  return { table, tr, box, head };
}

describe("createRowSelection", () => {
  it("picks a row alone, and keeps the ticked rows in the order shown", () => {
    const { selection, at, ticked, changed } = setup();
    selection.pick(at("c"));
    selection.pick(at("a"), { toggle: true });
    expect(ticked()).toEqual(["a", "c"]);
    expect(selection.count()).toBe(2);
    expect(selection.has(at("c"))).toBe(true);
    selection.pick(at("d"));
    expect(ticked()).toEqual(["d"]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("ticks a run from the anchor on a range, replacing the last run but keeping rows picked apart", () => {
    const { selection, at, ticked } = setup();
    selection.pick(at("b"));
    selection.pick(at("d"), { range: true });
    expect(ticked()).toEqual(["b", "c", "d"]);
    selection.pick(at("a"), { range: true });
    expect(ticked()).toEqual(["a", "b"]);
    selection.pick(at("e"), { toggle: true });
    selection.pick(at("c"), { range: true });
    expect(ticked()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("starts a range at the row picked when no anchor is shown", () => {
    const { selection, at, ticked } = setup();
    selection.pick(at("c"), { range: true });
    expect(ticked()).toEqual(["c"]);
    selection.pick(at("e"), { range: true });
    expect(ticked()).toEqual(["c", "d", "e"]);
  });

  it("ticks every row, then none, from toggleAll, and clears without a word when nothing is ticked", () => {
    const { selection, at, ticked, changed } = setup(["a", "b"]);
    selection.pick(at("a"));
    selection.toggleAll();
    expect(ticked()).toEqual(["a", "b"]);
    selection.toggleAll();
    expect(ticked()).toEqual([]);
    changed.mockClear();
    selection.clear();
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps a row across a fresh read by its key, and drops one no longer shown", () => {
    const { selection, at, ticked, show, changed } = setup(["a", "b", "c"]);
    selection.pick(at("a"));
    selection.pick(at("c"), { toggle: true });
    show(["a", "b", "c"]);
    changed.mockClear();
    selection.prune();
    expect(ticked()).toEqual(["a", "c"]);
    expect(changed).not.toHaveBeenCalled();
    show(["a", "b"]);
    selection.prune();
    expect(ticked()).toEqual(["a"]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("marks a drawn row and its boxes as it changes, and finds the row by its element", () => {
    const { selection, at } = setup(["a", "b"]);
    const { tr, box, head } = drawn(selection, at("a"));
    expect(selection.rowOf(tr.cells[0])).toBe(at("a"));
    expect(selection.elementOf(at("a"))).toBe(tr);
    selection.pick(at("a"));
    expect(tr.classList.contains("is-selected")).toBe(true);
    expect(box.checked).toBe(true);
    expect([head.checked, head.indeterminate]).toEqual([false, true]);
    selection.toggleAll();
    expect([head.checked, head.indeterminate]).toEqual([true, false]);
  });

  it("draws a new row's box and header as the ticks stand", () => {
    const { selection, at } = setup(["a", "b"]);
    selection.pick(at("b"));
    const { tr, box, head } = drawn(selection, at("b"));
    expect(tr.classList.contains("is-selected")).toBe(true);
    expect(box.checked).toBe(true);
    expect(head.indeterminate).toBe(true);
  });

  it("marks a row still being built out of the page, and lets go of rows out of it once pruned", () => {
    const { selection, at } = setup(["a"]);
    const building = document.createElement("tr");
    selection.bind(building, at("a"));
    selection.pick(at("a"));
    expect(building.classList.contains("is-selected")).toBe(true);
    selection.prune();
    expect(selection.elementOf(at("a"))).toBeUndefined();
  });
});
