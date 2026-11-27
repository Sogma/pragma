// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { TableColumn, TableRow } from "../../../src/protocol/types.ts";
import {
  cardParts,
  createCard,
  createGridTable,
  createTableForm,
  focusRowAt,
  ROW_MENU,
  startLabelRename,
  type TableFormSpec,
  wireRowSelection,
} from "../../../web/lib/dataGrid.ts";
import { createRowSelection } from "../../../web/lib/rowSelection.ts";
import { installTextMenu } from "../../../web/lib/textMenu.ts";
import type { MenuOpenOptions } from "../../../web/services/menus.ts";

const column = (id: string, type: TableColumn["type"], options?: string[]): TableColumn => ({
  id,
  type,
  label: id,
  ...(options ? { options } : {}),
});

describe("cardParts", () => {
  it("claims the picture before the title, then the first select as the badge", () => {
    const columns = [
      column("frame", "media"),
      column("name", "text"),
      column("status", "select"),
      column("n", "integer"),
    ];
    const parts = cardParts(columns);
    expect([parts.picture?.id, parts.title?.id, parts.badge?.id]).toEqual(["frame", "name", "status"]);
    expect(parts.lines.map((each) => each.id)).toEqual(["n"]);
  });

  it("takes no title from the columns for rows that bring their own", () => {
    const parts = cardParts([column("status", "select"), column("n", "integer")], true);
    expect(parts.title).toBeUndefined();
    expect(parts.badge?.id).toBe("status");
    expect(parts.lines.map((each) => each.id)).toEqual(["n"]);
  });
});

describe("createCard", () => {
  it("leaves out a head with nothing in it", () => {
    const control = document.createElement("span");
    const card = createCard({ lines: [{ label: "Take", control }] });
    expect(card.querySelector(".data-cards-head")).toBeNull();
    expect(card.querySelector(".data-cards-field-label")?.textContent).toBe("Take");
  });
});

describe("createGridTable", () => {
  it("draws a header for every column and a cell only where a column has one", () => {
    const grid = createGridTable<string>([
      {
        header: document.createElement("span"),
        cell: (row) => Object.assign(document.createElement("b"), { textContent: row }),
      },
      { headerClass: "add" },
      { cell: (_row, index) => Object.assign(document.createElement("i"), { textContent: String(index) }) },
    ]);
    grid.setRows(["a", "b"]);
    expect(grid.table.querySelectorAll("thead th")).toHaveLength(3);
    expect(grid.table.querySelector("thead th.add")).not.toBeNull();
    const body = [...grid.table.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(body).toEqual(["a0", "b1"]);

    const head = grid.table.querySelector("thead");
    grid.setRows(["c"]);
    expect(grid.table.querySelector("thead")).toBe(head);
    expect(grid.table.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  // Hovering a row shows all its quiet fields (controls.css), as a card
  // does; the header row holds none.
  it("marks each body row, and each card, as a row of fields", () => {
    const grid = createGridTable<string>([
      { cell: (row) => Object.assign(document.createElement("b"), { textContent: row }) },
    ]);
    grid.setRows(["a", "b"]);
    expect([...grid.table.querySelectorAll("tbody tr")].every((tr) => tr.classList.contains("form-input-row"))).toBe(
      true,
    );
    expect(grid.table.querySelector("thead tr")?.classList.contains("form-input-row")).toBe(false);
    expect(createCard({ lines: [] }).classList.contains("form-input-row")).toBe(true);
  });
});

describe("createTableForm", () => {
  const takes = () => [
    column("still", "media"),
    column("take", "text"),
    column("status", "select"),
    column("note", "text"),
  ];
  const rows = (): TableRow[] => [
    { values: { still: "a.png", take: "wide", status: "final", note: "" } },
    { values: { still: "", take: "close", status: "draft", note: "soft" } },
  ];
  // Each cell shows its value as text, so a test reads what was drawn where.
  const form = (overrides: Partial<TableFormSpec> = {}) =>
    createTableForm({
      columns: takes(),
      rows: rows(),
      layout: "list",
      version: "1.0",
      editable: false,
      readOnly: true,
      cell: (each, row) => Object.assign(document.createElement("span"), { textContent: row.values[each.id] }),
      ...overrides,
    });
  const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((el) => el.textContent);

  it("draws the grid by the cells handed in, each column headed by its label", () => {
    const drawn = form();
    expect(drawn.classList.contains("is-read-only")).toBe(true);
    expect(texts(drawn, "thead th")).toEqual(["still", "take", "status", "note"]);
    expect(texts(drawn, "tbody tr")).toEqual(["a.pngwidefinal", "closedraftsoft"]);
  });

  it("draws a card per row, leaving out a line with no value only while values are content", () => {
    const reading = form({ layout: "cards" });
    expect(texts(reading, ".data-cards-title")).toEqual(["wide", "close"]);
    expect(texts(reading, ".data-cards-badge")).toEqual(["final", "draft"]);
    expect(texts(reading, ".data-cards-field-label")).toEqual(["note"]);

    const editing = form({ layout: "cards", editable: true, readOnly: false });
    expect(editing.classList.contains("is-read-only")).toBe(false);
    expect(texts(editing, ".data-cards-field-label")).toEqual(["note", "note"]);
  });

  it("says why a locked file is read-only, and draws nothing past the notice of an unreadable one", () => {
    const newer = form({ locked: "newer-format", version: "2.0" });
    expect(newer.querySelector(".document-locked-notice")).not.toBeNull();
    expect(newer.querySelectorAll("tbody tr")).toHaveLength(2);

    const after = document.createElement("button");
    const unreadable = form({ locked: "unreadable", columns: [], rows: [], after });
    expect([...unreadable.children].map((child) => child.className)).toEqual(["document-locked-notice inline-warning"]);
  });

  it("says a Table with no columns has none, with what comes after it", () => {
    const after = document.createElement("button");
    const empty = form({ columns: [], rows: [], after });
    expect(empty.querySelector(".data-table-empty")?.textContent).toBe("This Table has no columns defined yet.");
    expect(empty.lastElementChild).toBe(after);
  });

  it("deletes a row from its card's remove button, last on the card, drawing the cards again once it is gone", () => {
    const shown = rows();
    const deleteRow = (row: TableRow, redraw: () => void) => {
      shown.splice(shown.indexOf(row), 1);
      redraw();
    };
    const smallCard = [{ title: true as const }, { field: "note" }];
    for (const arranged of [undefined, smallCard]) {
      const drawn = form({ layout: "cards", rows: shown, deleteRow, smallCard: arranged });
      const removes = [...drawn.querySelectorAll<HTMLButtonElement>(".data-cards-card > .data-cards-remove")];
      expect(removes.map((each) => each.parentElement?.lastElementChild === each)).toEqual(shown.map(() => true));
      expect(removes[0].getAttribute("aria-label")).toBe("Delete entry");
    }
    const drawn = form({ layout: "cards", rows: shown, deleteRow });
    (drawn.querySelector(".data-cards-remove") as HTMLButtonElement).click();
    expect(drawn.querySelectorAll(".data-cards-remove")).toHaveLength(1);
    expect(drawn.textContent).not.toContain("wide");
    expect(form({ rows: shown, deleteRow }).querySelector(".data-cards-remove")).toBeNull();
  });

  it("takes headers of the pane's own, and a last header cell with no cell in any row", () => {
    const drawn = form({
      header: (each) => Object.assign(document.createElement("b"), { textContent: each.label.toUpperCase() }),
      lastHeader: { header: document.createElement("i"), headerClass: "add" },
    });
    expect(texts(drawn, "thead th")).toEqual(["STILL", "TAKE", "STATUS", "NOTE", ""]);
    expect(drawn.querySelector("thead th.add > i")).not.toBeNull();
    expect(drawn.querySelector("tbody tr")?.children).toHaveLength(4);
  });
});

describe("startLabelRename", () => {
  function rename(keys: string, typed: string) {
    const holder = document.createElement("div");
    const label = Object.assign(document.createElement("span"), { textContent: "Status" });
    holder.appendChild(label);
    document.body.appendChild(holder);
    const onRename = vi.fn();
    startLabelRename(label, onRename);
    const input = holder.querySelector("input") as HTMLInputElement;
    input.value = typed;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: keys }));
    holder.remove();
    return { holder, label, onRename };
  }

  it("commits a changed label on Enter, trimmed", () => {
    const { holder, label, onRename } = rename("Enter", "  State ");
    expect(onRename).toHaveBeenCalledWith("State");
    expect(label.textContent).toBe("State");
    expect(holder.firstChild).toBe(label);
  });

  it("keeps the label for a blank commit, an unchanged one, and Escape", () => {
    for (const [key, typed] of [
      ["Enter", "  "],
      ["Enter", "Status"],
      ["Escape", "Other"],
    ]) {
      const { label, onRename } = rename(key, typed);
      expect(onRename).not.toHaveBeenCalled();
      expect(label.textContent).toBe("Status");
    }
  });
});

describe("a row's card from the grid", () => {
  const columns = () => [column("take", "text"), column("note", "text")];
  const rows = (): TableRow[] => [
    { values: { take: "wide", note: "soft" } },
    { values: { take: "close", note: "" } },
    { values: { take: "insert", note: "bell" } },
  ];
  // Each cell a text field holding its value, as an editable grid's are.
  const form = (overrides: Partial<TableFormSpec> = {}) => {
    const drawn = createTableForm({
      columns: columns(),
      rows: rows(),
      layout: "list",
      version: "1.0",
      editable: true,
      readOnly: false,
      cell: (each, row) => Object.assign(document.createElement("input"), { value: row.values[each.id] ?? "" }),
      ...overrides,
    });
    document.body.append(drawn);
    onTestFinished(() => drawn.remove());
    return drawn;
  };
  const key = (target: Element, key: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const selected = (root: Element) =>
    [...root.querySelectorAll("tbody > tr")].findIndex((tr) => tr.classList.contains("is-selected"));

  it("opens a row's card from a gutter before its values in the list, and from its corner on a card", () => {
    const openRow = vi.fn();
    const list = form({ openRow });
    expect(list.querySelector("thead th")?.className).toBe("row-gutter");
    const gutters = [...list.querySelectorAll<HTMLElement>("tbody td.row-gutter:first-child > .row-open")];
    expect(gutters).toHaveLength(3);
    expect(gutters[1].getAttribute("aria-label")).toBe("Open card");
    expect(gutters[1].tabIndex).toBe(-1);
    gutters[1].click();
    expect(openRow).toHaveBeenLastCalledWith(expect.objectContaining({ values: { take: "close", note: "" } }), 1);

    const cards = form({ openRow, layout: "cards" });
    expect(cards.querySelector(".data-cards-head .row-open")).toBeNull();
    cards.querySelectorAll<HTMLElement>(".data-cards-card > .row-open")[2].click();
    expect(openRow).toHaveBeenLastCalledWith(expect.objectContaining({ values: { take: "insert", note: "bell" } }), 2);
  });

  it("has no gutter where rows open no card", () => {
    const list = form();
    expect(list.querySelector(".row-gutter, .row-open")).toBeNull();
  });

  it("selects a field's row on Escape, moves the selection with Up and Down, and opens its card on Space", () => {
    const openRow = vi.fn();
    const list = form({ openRow });
    const undo = wireRowSelection(list);
    const field = list.querySelectorAll("tbody > tr")[0].querySelectorAll("input")[1];
    field.focus();
    key(field, "Escape");
    expect(selected(list)).toBe(0);
    expect(document.activeElement).toBe(list.querySelector("tbody > tr"));

    key(document.activeElement as Element, "ArrowDown");
    key(document.activeElement as Element, "ArrowDown");
    key(document.activeElement as Element, "ArrowDown");
    expect(selected(list)).toBe(2);
    key(document.activeElement as Element, "ArrowUp");
    expect(selected(list)).toBe(1);
    key(document.activeElement as Element, " ");
    expect(openRow).toHaveBeenCalledWith(expect.anything(), 1);
    undo();
  });

  it("goes back on Enter into the field Escape left, its caret at the end, the row still selected", () => {
    const list = form({ openRow: vi.fn() });
    wireRowSelection(list);
    const field = list.querySelectorAll("tbody > tr")[2].querySelectorAll("input")[1];
    field.focus();
    key(field, "Escape");
    key(document.activeElement as Element, "Enter");
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
    expect(selected(list)).toBe(2);
  });

  it("keeps the selection while a field takes focus", () => {
    const list = form({ openRow: vi.fn() });
    wireRowSelection(list);
    const [first, second] = list.querySelectorAll("tbody > tr");
    const field = first.querySelector("input") as HTMLInputElement;
    field.focus();
    key(field, "Escape");
    (second.querySelector("input") as HTMLInputElement).focus();
    expect(selected(list)).toBe(0);
  });

  it("leaves Escape to a field in a row that opens no card", () => {
    const list = form();
    wireRowSelection(list);
    const field = list.querySelector("tbody input") as HTMLInputElement;
    field.focus();
    expect(key(field, "Escape")).toBe(true);
    expect(selected(list)).toBe(-1);
  });

  it("offers Open card from a right-click on a row or a card, outside its fields, selecting a list's row", () => {
    const opened: MenuOpenOptions[] = [];
    const installed = installTextMenu({ open: (options) => void opened.push(options) });
    onTestFinished(() => installed.dispose());
    const openRow = vi.fn();
    const rightClick = (target: Element) =>
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const pick = (label: string) =>
      opened
        .at(-1)
        ?.items?.find((item) => item.label === label)
        ?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);

    const list = form({ openRow });
    wireRowSelection(list);
    rightClick(list.querySelectorAll("tbody td.row-gutter")[2]);
    expect(selected(list)).toBe(2);
    pick("Open card");
    expect(openRow).toHaveBeenLastCalledWith(expect.anything(), 2);

    const before = opened.length;
    rightClick(list.querySelectorAll("tbody input")[0]);
    expect(opened.slice(before).flatMap((menu) => menu.items?.map((item) => item.label))).not.toContain("Open card");

    const cards = form({ openRow, layout: "cards" });
    wireRowSelection(cards);
    rightClick(cards.querySelectorAll(".data-cards-card")[1]);
    pick("Open card");
    expect(openRow).toHaveBeenLastCalledWith(expect.anything(), 1);
  });

  it("puts what the pane gives for the row under Open card, and names the row to the registered menu", () => {
    const opened: MenuOpenOptions[] = [];
    const installed = installTextMenu({ open: (options) => void opened.push(options) });
    onTestFinished(() => installed.dispose());
    const menuOf = vi.fn((index: number) => ({
      items: [{ label: "Delete entry", group: "trash", run: vi.fn() }],
      arg: { file: `shots/${index}.md` },
    }));
    const rightClick = (target: Element) =>
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    const list = form({ openRow: vi.fn() });
    wireRowSelection(list, { menuOf });
    rightClick(list.querySelectorAll("tbody td.row-gutter")[1]);
    expect(menuOf).toHaveBeenLastCalledWith(1);
    expect(opened.at(-1)).toEqual(expect.objectContaining({ menu: ROW_MENU, arg: { file: "shots/1.md" } }));
    expect(opened.at(-1)?.items?.map((item) => item.label)).toEqual(["Open card", "Delete entry"]);

    const cards = form({ openRow: vi.fn(), layout: "cards" });
    wireRowSelection(cards, { menuOf });
    rightClick(cards.querySelectorAll(".data-cards-card")[2]);
    expect(menuOf).toHaveBeenLastCalledWith(2);
  });

  it("leaves a right-click something nearer took to it", () => {
    const list = form({ openRow: vi.fn() });
    wireRowSelection(list);
    const gutter = list.querySelector("tbody td.row-gutter") as HTMLElement;
    gutter.addEventListener("contextmenu", (event) => event.preventDefault());
    gutter.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(selected(list)).toBe(-1);
  });

  it("lands back on a row by its place: selected in the list, its button focused on a card", () => {
    const list = form({ openRow: vi.fn() });
    focusRowAt(list, 2);
    expect(selected(list)).toBe(2);
    expect(document.activeElement).toBe(list.querySelectorAll("tbody > tr")[2]);

    const cards = form({ openRow: vi.fn(), layout: "cards" });
    focusRowAt(cards, 1);
    expect(document.activeElement).toBe(cards.querySelectorAll(".row-open")[1]);
  });

  it("lands on the last row once none is at the place, as after the last row is deleted", () => {
    const list = form({ openRow: vi.fn() });
    focusRowAt(list, 3);
    expect(selected(list)).toBe(2);

    const cards = form({ openRow: vi.fn(), layout: "cards" });
    focusRowAt(cards, 3);
    expect(document.activeElement).toBe(cards.querySelectorAll(".row-open")[2]);
  });
});

describe("a listing's selection", () => {
  const columns = () => [column("take", "text"), column("note", "text")];
  // Values as content, as a locked grid draws them, or fields, as Edit does.
  const listing = (locked: boolean) => {
    const rows: TableRow[] = [
      { values: { take: "wide", note: "soft" } },
      { values: { take: "close", note: "" } },
      { values: { take: "insert", note: "bell" } },
      { values: { take: "cutaway", note: "gulls" } },
    ];
    const selection = createRowSelection<TableRow>({ rows: () => rows, key: (row) => row });
    const openRow = vi.fn();
    const drawn = createTableForm({
      columns: columns(),
      rows,
      layout: "list",
      version: "1.0",
      editable: !locked,
      readOnly: locked,
      cell: (each, row) =>
        locked
          ? Object.assign(document.createElement("span"), {
              className: "data-table-value",
              textContent: row.values[each.id],
            })
          : Object.assign(document.createElement("input"), { value: row.values[each.id] ?? "" }),
      openRow,
      selection,
    });
    document.body.append(drawn);
    const undo = wireRowSelection(drawn, { selection, locked: () => locked });
    onTestFinished(() => {
      undo();
      drawn.remove();
    });
    const tr = (index: number) => drawn.querySelectorAll<HTMLTableRowElement>("tbody > tr")[index];
    const ticked = () =>
      [...drawn.querySelectorAll("tbody > tr")].flatMap((each, index) =>
        each.classList.contains("is-selected") ? [index] : [],
      );
    const click = (target: Element, init: MouseEventInit = {}) => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    };
    return { drawn, rows, selection, openRow, tr, ticked, click };
  };
  const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

  it("ends each row, and the header, with a checkbox outside the cells", () => {
    const { drawn } = listing(true);
    const row = drawn.querySelector("tbody > tr") as HTMLTableRowElement;
    expect(row.lastElementChild?.className).toBe("row-select");
    expect(row.lastElementChild?.querySelector(".row-select-box")?.getAttribute("aria-label")).toBe("Select row");
    expect(drawn.querySelector("thead th:last-child .row-select-box")?.getAttribute("aria-label")).toBe(
      "Select all rows",
    );
  });

  it("selects a row alone on a click while values are locked, a run on Shift, and one more on Ctrl", () => {
    const { tr, ticked, click } = listing(true);
    click(tr(1).cells[1]);
    expect(ticked()).toEqual([1]);
    expect(document.activeElement).toBe(tr(1));
    click(tr(3).cells[2], { shiftKey: true });
    expect(ticked()).toEqual([1, 2, 3]);
    click(tr(0).cells[1], { ctrlKey: true });
    expect(ticked()).toEqual([0, 1, 2, 3]);
    click(tr(2).cells[1], { ctrlKey: true });
    expect(ticked()).toEqual([0, 1, 3]);
    // The run starts from the row last picked, and the rows picked apart
    // from it stay.
    click(tr(3).cells[1], { shiftKey: true });
    expect(ticked()).toEqual([0, 1, 2, 3]);
    click(tr(2).cells[1]);
    expect(ticked()).toEqual([2]);
  });

  it("leaves a click to the fields while values can be typed in", () => {
    const { tr, ticked, click } = listing(false);
    click(tr(1).cells[1]);
    expect(ticked()).toEqual([]);
  });

  it("ticks nothing for a press that travelled, as a text selection is made", () => {
    const { tr, ticked } = listing(true);
    const cell = tr(1).cells[1];
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 40, clientY: 12 }));
    expect(ticked()).toEqual([]);
  });

  it("adds or removes a row from its checkbox in any mode, Shift ticking the run", () => {
    const { drawn, ticked } = listing(false);
    const boxes = drawn.querySelectorAll<HTMLInputElement>("tbody .row-select-box");
    boxes[0].click();
    boxes[2].click();
    expect(ticked()).toEqual([0, 2]);
    expect([...boxes].map((box) => box.checked)).toEqual([true, false, true, false]);
    boxes[2].click();
    expect(ticked()).toEqual([0]);
    // The run starts at the row last picked, unticked or not, as the file
    // tree's does.
    boxes[3].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    expect(ticked()).toEqual([0, 2, 3]);
  });

  it("ticks every row from the header's checkbox, a dash for some, and none once all are", () => {
    const { drawn, ticked } = listing(true);
    const all = drawn.querySelector("thead .row-select-box") as HTMLInputElement;
    const boxes = drawn.querySelectorAll<HTMLInputElement>("tbody .row-select-box");
    boxes[1].click();
    expect([all.checked, all.indeterminate]).toEqual([false, true]);
    all.click();
    expect(ticked()).toEqual([0, 1, 2, 3]);
    expect([all.checked, all.indeterminate]).toEqual([true, false]);
    all.click();
    expect(ticked()).toEqual([]);
    expect([all.checked, all.indeterminate]).toEqual([false, false]);
  });

  it("moves the selection with Up and Down, extends it with Shift, and clears it on Escape", () => {
    const { tr, ticked, click } = listing(true);
    click(tr(1).cells[1]);
    key(tr(1), "ArrowDown");
    expect(ticked()).toEqual([2]);
    key(tr(2), "ArrowDown", { shiftKey: true });
    expect(ticked()).toEqual([2, 3]);
    key(tr(3), "ArrowUp", { shiftKey: true });
    key(tr(2), "ArrowUp", { shiftKey: true });
    expect(ticked()).toEqual([1, 2]);
    const escaped = key(tr(1), "Escape");
    expect(escaped).toBe(false);
    expect(ticked()).toEqual([]);
  });

  it("selects a field's row alone on Escape, as the list's selection", () => {
    const { tr, ticked, drawn } = listing(false);
    drawn.querySelectorAll<HTMLInputElement>("tbody .row-select-box")[0].click();
    const field = tr(2).querySelector("input:not(.row-select-box)") as HTMLInputElement;
    field.focus();
    key(field, "Escape");
    expect(ticked()).toEqual([2]);
    expect(document.activeElement).toBe(tr(2));
  });

  it("opens a row's card on a double-click while values are locked", () => {
    const { tr, openRow } = listing(true);
    tr(2).cells[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(openRow).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it("selects a row alone on its right-click, so its menu acts on that row", () => {
    const installed = installTextMenu({ open: () => undefined });
    onTestFinished(() => installed.dispose());
    const { tr, ticked, click } = listing(true);
    click(tr(0).cells[1]);
    click(tr(2).cells[1], { shiftKey: true });
    tr(3).cells[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(ticked()).toEqual([3]);
  });

  it("lands back on a row from its card: one ticked row follows it, several stay", () => {
    const { drawn, selection, rows, tr, ticked, click } = listing(true);
    click(tr(0).cells[1]);
    focusRowAt(drawn, 2, selection);
    expect(ticked()).toEqual([2]);
    expect(document.activeElement).toBe(tr(2));
    click(tr(3).cells[1], { shiftKey: true });
    focusRowAt(drawn, 0, selection);
    expect(ticked()).toEqual([2, 3]);
    expect(document.activeElement).toBe(tr(0));
    expect(selection.selected()).toEqual([rows[2], rows[3]]);
  });
});
