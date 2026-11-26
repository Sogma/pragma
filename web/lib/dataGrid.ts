// The grid and cards a Table's rows are drawn with, shared with every pane
// that draws rows the same way. A pane keeps its rows and saves them; these
// only build the controls and hand each edit back.
import type { DocumentLock } from "../../src/protocol/api.ts";
import type { FieldValueType, SmallCardTile, TableColumn, TableLayout, TableRow } from "../../src/protocol/types.ts";
import { currentPlatform } from "../services/keybindings.ts";
import type { MenuItem } from "../services/menus.ts";
import { buildLockNotice } from "./dom.ts";
import { fieldTypeIcon } from "./fieldTypeIcon.ts";
import type { RowPick, RowSelection } from "./rowSelection.ts";
import { createArrangedCard, resolveSmallCard } from "./smallCard.ts";
import { leadTextMenu } from "./textMenu.ts";

/** A column's header: its type's icon, when given, then its label, which is
 * returned too for a rename to swap out. A pane gives the type only while
 * values can be entered; while nothing is editable it is clutter beside the
 * label. */
export function createColumnHeader(
  labelText: string,
  type: FieldValueType | undefined,
): { element: HTMLElement; label: HTMLElement } {
  const element = document.createElement("div");
  element.className = "data-table-column-header";
  const label = document.createElement("span");
  label.className = "data-table-column-label";
  label.textContent = labelText;
  if (type) element.appendChild(fieldTypeIcon(type));
  element.appendChild(label);
  return { element, label };
}

/** Swaps a label for an input in place, the same click-to-rename shape as a
 * Flow node's title: Enter and blur commit, Escape cancels. A blank commit is
 * rejected and the label kept, since a column has no default label to fall
 * back to. `onRename` hears only a label that changed. */
export function startLabelRename(labelEl: HTMLElement, onRename: (label: string) => void): void {
  const before = labelEl.textContent ?? "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-input data-table-column-label-input";
  input.value = before;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const trimmed = input.value.trim();
    if (commit && trimmed && trimmed !== before) {
      labelEl.textContent = trimmed;
      onRename(trimmed);
    }
    input.replaceWith(labelEl);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** One column of a grid: its header cell's content and class, and each
 * row's cell. A column with no `cell` adds a header alone, leaving each row
 * one cell short. */
export interface GridColumn<Row> {
  header?: HTMLElement;
  headerClass?: string;
  cell?: (row: Row, index: number) => HTMLElement;
  cellClass?: string;
}

// A row's gutter, the cell before its values: the button that opens the
// row's full card, shown while the row is hovered or selected.
const ROW_GUTTER = "row-gutter";
const GUTTER_OPEN = `:scope > .${ROW_GUTTER} .row-open`;

export function createRowOpenButton(onOpen: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button row-open";
  button.tabIndex = -1;
  button.setAttribute("aria-label", "Open card");
  button.addEventListener("click", onOpen);
  return button;
}

/** The gutter column a grid's rows open their card from. */
export function rowGutterColumn<Row>(open: (row: Row, index: number) => void): GridColumn<Row> {
  return {
    headerClass: ROW_GUTTER,
    cell: (row, index) => createRowOpenButton(() => open(row, index)),
    cellClass: ROW_GUTTER,
  };
}

// The column ending each row, drawn as margin as the gutter is: the row's
// checkbox, and in the header the one for every row.
const ROW_SELECT = "row-select";

function selectSlot(box: HTMLInputElement): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "row-select-slot";
  slot.append(box);
  return slot;
}

export function rowSelectColumn<Row>(selection: RowSelection<Row>): GridColumn<Row> {
  return {
    header: selectSlot(selection.headerBox()),
    headerClass: ROW_SELECT,
    cell: (row) => selectSlot(selection.box(row)),
    cellClass: ROW_SELECT,
  };
}

// A row's checkbox is a control, never a field to type in or go back to.
const FIELDS = "input:not(.row-select-box), select, textarea, [contenteditable='true']";
// What keeps its own click on a row: a click anywhere else ticks the row.
const CONTROLS = `button, a, label, input, ${FIELDS}`;
// A press that travels this far drags or selects text, and ticks nothing.
const TRAVEL = 4;

/** The registered menu under Open card on a row's right-click, reading the
 * row's argument. */
export const ROW_MENU = "row";

/** What a row's right-click and its card's ⋮ offer for it: the pane's own
 * items, and the argument their registered menus read, naming the row's
 * file where it is one. */
export interface RowMenu {
  items?: MenuItem[];
  arg?: unknown;
}

// The rows under `root` that open a card, in the order shown, across every
// grid it holds.
function openableRows(root: HTMLElement): HTMLTableRowElement[] {
  return [...root.querySelectorAll<HTMLTableRowElement>("tbody > tr")].filter((tr) => tr.querySelector(GUTTER_OPEN));
}

function focusRow(tr: HTMLTableRowElement): void {
  tr.tabIndex = -1;
  tr.focus({ preventScroll: false });
}

/** Back on the row at `index` of those shown, or on the last once no row is
 * there, as after the row is deleted: the row focused and selected in a
 * list, its open button focused on a card. Several ticked rows stay ticked;
 * one or none follows the row landed on. */
export function focusRowAt<Row>(root: HTMLElement, index: number, selection?: RowSelection<Row>): void {
  const rows = openableRows(root);
  const opens = root.querySelectorAll<HTMLElement>(".row-open");
  if (rows.length === 0) {
    opens[Math.min(index, opens.length - 1)]?.focus();
    return;
  }
  const tr = rows[Math.min(index, rows.length - 1)];
  const row = selection?.rowOf(tr);
  if (!selection || row === undefined) {
    selectRow(root, tr);
    return;
  }
  if (selection.count() <= 1) selection.pick(row);
  focusRow(tr);
}

/** Marks `tr` as the selected row and gives it focus, so its keys follow:
 * the one row, in a listing that ticks none. */
export function selectRow(root: HTMLElement, tr: HTMLTableRowElement): void {
  for (const each of root.querySelectorAll("tbody > tr.is-selected")) each.classList.remove("is-selected");
  tr.classList.add("is-selected");
  focusRow(tr);
}

/** What a listing's rows answer besides their own fields. */
export interface RowGestures<Row> {
  /** What a row's right-click and its card's ⋮ offer, by the row's place. */
  menuOf?(index: number): RowMenu;
  /** The rows ticked, in a listing that ticks any. */
  selection?: RowSelection<Row>;
  /** While values show as content (reading view, a locked file), a click on
   * a row is free to tick it; otherwise it belongs to the row's fields. */
  locked?(): boolean;
}

/** Keys and clicks on the rows under `root` that open a card. Escape in a
 * field selects its row. On a selected row, Up and Down move the selection,
 * Shift extending it, Escape clears it, Space opens the row's card and Enter
 * goes back into the field left, the caret at its end.
 *
 * While values are locked, a click selects a row as the file tree selects a
 * file, Shift for a range and Ctrl or Cmd to add or remove one, and a
 * double-click opens its card. Returns its undoing.
 *
 * A right-click on a row or a card, outside its fields, offers Open card,
 * then what `menuOf` gives for the row at that place. */
export function wireRowSelection<Row>(root: HTMLElement, gestures: RowGestures<Row> = {}): () => void {
  const { menuOf, selection, locked } = gestures;
  let left: { tr: HTMLTableRowElement; cell: number } | undefined;
  let press: { x: number; y: number } | undefined;

  const land = (tr: HTMLTableRowElement, how?: RowPick) => {
    const row = selection?.rowOf(tr);
    if (!selection || row === undefined) {
      selectRow(root, tr);
      return;
    }
    selection.pick(row, how);
    focusRow(tr);
  };

  // A row a click may tick: values locked, and the press on the row itself,
  // not on a control or a field of it.
  const freeRow = (event: MouseEvent): HTMLTableRowElement | undefined => {
    const target = event.target;
    if (!selection || !locked?.() || event.button !== 0 || !(target instanceof Element)) return undefined;
    if (target.closest(CONTROLS)) return undefined;
    const tr = target.closest<HTMLTableRowElement>("tbody > tr");
    return tr && root.contains(tr) && selection.rowOf(tr) !== undefined ? tr : undefined;
  };

  const onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || event.altKey || event.ctrlKey || event.metaKey) return;
    const tr = target.closest<HTMLTableRowElement>("tbody > tr");
    if (!tr || !root.contains(tr) || !tr.querySelector(GUTTER_OPEN)) return;
    if (target !== tr) {
      if (event.key !== "Escape" || !target.matches(FIELDS)) return;
      event.preventDefault();
      event.stopPropagation();
      left = { tr, cell: target.closest("td")?.cellIndex ?? -1 };
      target.blur();
      land(tr);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = openableRows(root);
      const next = rows[rows.indexOf(tr) + (event.key === "ArrowUp" ? -1 : 1)];
      if (next) land(next, { range: event.shiftKey });
      return;
    }
    if (event.shiftKey) return;
    if (event.key === " ") {
      event.preventDefault();
      tr.querySelector<HTMLButtonElement>(GUTTER_OPEN)?.click();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const cell = left?.tr === tr ? tr.cells[left.cell] : undefined;
      const field = (cell ?? tr).querySelector<HTMLElement>(FIELDS);
      field?.focus();
      if (field instanceof HTMLInputElement && field.type === "text")
        field.setSelectionRange(field.value.length, field.value.length);
    } else if (event.key === "Escape" && selection && selection.count() > 0) {
      // Before anything the pane closes on Escape: the nearer thing to undo.
      event.preventDefault();
      event.stopPropagation();
      selection.clear();
    }
  };

  // Shift extends a text selection, unless the press ticks a row.
  const onPress = (event: MouseEvent) => {
    press = { x: event.clientX, y: event.clientY };
    if (event.shiftKey && freeRow(event)) event.preventDefault();
  };

  const onClick = (event: MouseEvent) => {
    const tr = freeRow(event);
    if (!tr || event.defaultPrevented) return;
    const travelled = press !== undefined && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= TRAVEL;
    if (travelled || document.getSelection()?.isCollapsed === false) return;
    const toggle = currentPlatform() === "mac" ? event.metaKey : event.ctrlKey;
    land(tr, { range: event.shiftKey, toggle });
  };

  const onDouble = (event: MouseEvent) => {
    const tr = freeRow(event);
    if (!tr) return;
    document.getSelection()?.removeAllRanges();
    tr.querySelector<HTMLButtonElement>(GUTTER_OPEN)?.click();
  };

  // A field keeps the text menu alone, the browser's spelling included, and
  // a right-click something nearer took (a picture's menu) is left to it.
  // Elsewhere the row's item leads the text menu, so a value read there
  // still copies; a list's row is selected alone first, to show what the
  // menu acts on.
  const onMenu = (event: MouseEvent) => {
    const target = event.target;
    if (event.defaultPrevented || !(target instanceof Element) || target.closest(FIELDS)) return;
    const holder = target.closest<HTMLElement>("tbody > tr, .data-cards-card");
    const open = holder && root.contains(holder) ? holder.querySelector<HTMLButtonElement>(".row-open") : null;
    if (!holder || !open) return;
    if (holder instanceof HTMLTableRowElement) land(holder);
    const row = menuOf?.([...root.querySelectorAll(".row-open")].indexOf(open));
    leadTextMenu(event, {
      items: [{ label: "Open card", run: () => open.click() }, ...(row?.items ?? [])],
      menu: ROW_MENU,
      arg: row?.arg,
      ariaLabel: "Row",
    });
  };

  root.addEventListener("keydown", onKey);
  root.addEventListener("mousedown", onPress);
  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDouble);
  root.addEventListener("contextmenu", onMenu);
  return () => {
    root.removeEventListener("keydown", onKey);
    root.removeEventListener("mousedown", onPress);
    root.removeEventListener("click", onClick);
    root.removeEventListener("dblclick", onDouble);
    root.removeEventListener("contextmenu", onMenu);
  };
}

/** A grid of rows, whose body redraws alone from `setRows`; `bind` hears of
 * each row it draws. */
export function createGridTable<Row>(
  columns: readonly GridColumn<Row>[],
  bind?: (element: HTMLTableRowElement, row: Row) => void,
): {
  table: HTMLTableElement;
  setRows: (rows: readonly Row[]) => void;
} {
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    if (column.headerClass) th.className = column.headerClass;
    if (column.header) th.appendChild(column.header);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);

  return {
    table,
    setRows(rows) {
      tbody.innerHTML = "";
      rows.forEach((row, index) => {
        const tr = document.createElement("tr");
        tr.className = "form-input-row";
        for (const column of columns) {
          if (!column.cell) continue;
          const td = document.createElement("td");
          if (column.cellClass) td.className = column.cellClass;
          td.appendChild(column.cell(row, index));
          tr.appendChild(td);
        }
        bind?.(tr, row);
        tbody.appendChild(tr);
      });
    },
  };
}

export interface CardParts {
  picture?: TableColumn;
  title?: TableColumn;
  badge?: TableColumn;
  lines: TableColumn[];
}

/** Which column plays which part on a card, by docs/protocol.md's Tables
 * section: the first media column is the picture, the first other column the
 * title, the first select other than the title the badge, and every other
 * column a line. Rows that bring a title of their own take none from their
 * columns.
 *
 * The picture is claimed before the title: a table whose first column is its
 * media would otherwise show that file as a one-line title and no picture,
 * the opposite of what a card is for. */
export function cardParts(columns: readonly TableColumn[], ownTitle = false): CardParts {
  const picture = columns.find((column) => column.type === "media");
  const title = ownTitle ? undefined : columns.find((column) => column !== picture);
  const badge = columns.find((column) => column.type === "select" && column !== title);
  const lines = columns.filter((column) => column !== picture && column !== title && column !== badge);
  return { picture, title, badge, lines };
}

export interface CardContent {
  picture?: HTMLElement;
  title?: HTMLElement;
  badge?: HTMLElement;
  // Controls at the end of the card's head, such as its delete button.
  actions?: HTMLElement[];
  lines: { label: string; control: HTMLElement }[];
}

/** One card, its parts already built. A head with nothing in it is left
 * out. */
export function createCard(content: CardContent): HTMLElement {
  const card = document.createElement("article");
  card.className = "card data-cards-card form-input-row";
  if (content.picture) {
    const figure = document.createElement("div");
    figure.className = "data-cards-picture";
    figure.appendChild(content.picture);
    card.appendChild(figure);
  }
  const head = document.createElement("div");
  head.className = "data-cards-head";
  if (content.title) {
    const titleEl = document.createElement("div");
    titleEl.className = "data-cards-title";
    titleEl.appendChild(content.title);
    head.appendChild(titleEl);
  }
  if (content.badge) {
    const badgeEl = document.createElement("div");
    badgeEl.className = "data-cards-badge";
    badgeEl.appendChild(content.badge);
    head.appendChild(badgeEl);
  }
  for (const action of content.actions ?? []) head.appendChild(action);
  if (head.childElementCount > 0) card.appendChild(head);
  for (const { label, control } of content.lines) {
    const line = document.createElement("div");
    line.className = "data-cards-field";
    const labelEl = document.createElement("span");
    labelEl.className = "data-cards-field-label";
    labelEl.textContent = label;
    const controlEl = document.createElement("div");
    controlEl.className = "data-cards-field-control";
    controlEl.appendChild(control);
    line.append(labelEl, controlEl);
    card.appendChild(line);
  }
  return card;
}

const VALUE_CELLS = [
  ".data-table > tbody > tr > td",
  ".data-cards-picture",
  ".data-cards-title",
  ".data-cards-badge",
  ".data-cards-field-control",
].join(", ");

/** Where the grids and cards under `root` draw their values, in reading
 * order: each row's cells and each card's parts, never a column's header
 * or a card's labels, which every card repeats. */
export function valueCells(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(VALUE_CELLS)];
}

/** The list cards sit in. */
export function createCardList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "data-cards";
  return list;
}

/** A Table's form as every view of it draws one: its Table tab in each mode,
 * and a preview of it. The tab passes the controls its mode adds. */
export interface TableFormSpec {
  columns: readonly TableColumn[];
  rows: TableRow[];
  layout: TableLayout;
  /** The cards view's card, as the file arranges it; absent composes it. */
  smallCard?: readonly SmallCardTile[];
  /** Why the file is shown read-only, said above its rows. */
  locked?: DocumentLock;
  version: string;
  /** Whether anything can be changed: column names and card labels are
   * text to select only while nothing can. */
  editable: boolean;
  /** Values are shown as content: a card leaves out a line with no value. */
  readOnly: boolean;
  cell(column: TableColumn, row: TableRow): HTMLElement;
  /** A column's header in the list; its label alone where absent. */
  header?(column: TableColumn): HTMLElement;
  /** A header cell after the columns' own, with no cell in any row. */
  lastHeader?: GridColumn<TableRow>;
  /** A row's own control, at the end of its line or in its card's head,
   * given how to draw the rows again once the row is gone. */
  rowControl?(row: TableRow, redraw: () => void): HTMLElement;
  /** Opens the row's full card: from its gutter in the list, from its
   * head in a card. */
  openRow?(row: TableRow, index: number): void;
  /** The rows ticked: each list row ends in its checkbox. A card has none. */
  selection?: RowSelection<TableRow>;
  /** Below the rows, or below an empty Table's notice. */
  after?: HTMLElement;
}

export function createTableForm(spec: TableFormSpec): HTMLElement {
  const form = document.createElement("div");
  form.className = "data-table-form";
  form.classList.toggle("is-read-only", !spec.editable);
  if (spec.locked) form.appendChild(buildLockNotice(spec.locked, spec.version));
  // An unreadable file reads as no columns, so past its notice the empty
  // state would only claim none are defined yet.
  if (spec.locked === "unreadable") return form;
  if (spec.columns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "data-table-empty";
    empty.textContent = "This Table has no columns defined yet.";
    form.appendChild(empty);
  } else {
    form.appendChild(spec.layout === "cards" ? tableCards(spec) : tableGrid(spec));
  }
  if (spec.after) form.appendChild(spec.after);
  return form;
}

// One card per row, composed by convention (docs/protocol.md, Tables). The
// controls are the grid's own, laid out vertically, so the two layouts can't
// drift; only what a blank says differs: nothing worth a line while reading,
// the place the value goes while editing.
function tableCards(spec: TableFormSpec): HTMLElement {
  const { picture, title, badge, lines } = cardParts(spec.columns);
  const list = createCardList();
  const draw = () => list.replaceChildren(...spec.rows.map(card));
  const { openRow } = spec;
  const arranged = spec.smallCard && resolveSmallCard(spec.columns, spec.smallCard, { picture, title, badge });
  const actions = (row: TableRow, index: number) => [
    ...(openRow ? [createRowOpenButton(() => openRow(row, index))] : []),
    ...(spec.rowControl ? [spec.rowControl(row, draw)] : []),
  ];
  const card = (row: TableRow, index: number) =>
    arranged
      ? createArrangedCard(
          arranged.map(({ part, size, label, field }) => ({
            part,
            size,
            label,
            control: field && spec.cell(field, row),
          })),
          actions(row, index),
        )
      : createCard({
          picture: picture && spec.cell(picture, row),
          title: title && spec.cell(title, row),
          badge: badge && spec.cell(badge, row),
          actions: actions(row, index),
          lines: lines
            .filter((column) => !spec.readOnly || (row.values[column.id] ?? "").trim())
            .map((column) => ({ label: column.label, control: spec.cell(column, row) })),
        });
  draw();
  return list;
}

function tableGrid(spec: TableFormSpec): HTMLElement {
  const columns: GridColumn<TableRow>[] = [
    ...(spec.openRow ? [rowGutterColumn<TableRow>(spec.openRow)] : []),
    ...spec.columns.map((column) => ({
      header: spec.header?.(column) ?? createColumnHeader(column.label, undefined).element,
      cell: (row: TableRow) => spec.cell(column, row),
    })),
  ];
  if (spec.lastHeader) columns.push(spec.lastHeader);
  const { rowControl, selection } = spec;
  const draw = () => grid.setRows(spec.rows);
  if (rowControl) columns.push({ cell: (row) => rowControl(row, draw) });
  if (selection) columns.push(rowSelectColumn(selection));
  const grid = createGridTable(columns, selection && ((element, row) => selection.bind(element, row)));
  draw();
  return grid.table;
}
