// The grid and cards a Table's rows are drawn with, shared with every pane
// that draws rows the same way. A pane keeps its rows and saves them; these
// only build the controls and hand each edit back.
import type { DocumentLock } from "../../src/protocol/api.ts";
import type { FieldValueType, TableColumn, TableLayout, TableRow } from "../../src/protocol/types.ts";
import { createColorChip, paintColorChip } from "./colorChip.ts";
import { buildLockNotice } from "./dom.ts";
import { fieldTypeIcon } from "./fieldTypeIcon.ts";
import { createFieldValue } from "./fieldValue.ts";
import { leadTextMenu } from "./textMenu.ts";
import { createTimestampField } from "./timestampField.ts";

/** The cell controls that live above `lib/`, which a pane hands in: a
 * media value's slot, a path value's, and the color picker's popover. */
export interface CellControls {
  media: (column: TableColumn, value: string, readOnly: boolean, onChange: (value: string) => void) => HTMLElement;
  path: (value: string, readOnly: boolean, onChange: (value: string) => void) => HTMLElement;
  pickColor: (anchor: HTMLElement, value: string, onPick: (hex: string) => void) => void;
}

export interface CellOptions {
  // When typed text is handed back: as each key lands, or once the field is
  // left, for a pane whose every hand-back is a write to another file.
  commit?: "input" | "change";
  // A select shows the value it holds as it is — blank for none, one not
  // among its options marked as such — rather than its first option, for a
  // pane that must not show a value the file doesn't hold.
  asHeld?: boolean;
  // Text wraps over several lines, as a tall tile of a row's card has room
  // for.
  multiline?: boolean;
}

/** One cell, by its column's type: its editor, or the value as content
 * wherever values are locked. A media or path cell is always its slot,
 * which takes the lock itself. */
export function createCell(
  column: TableColumn,
  value: string,
  onChange: (value: string) => void,
  readOnly: boolean,
  controls: CellControls,
  options: CellOptions = {},
): HTMLElement {
  if (column.type === "media") return controls.media(column, value, readOnly, onChange);
  if (column.type === "path") return controls.path(value, readOnly, onChange);
  if (readOnly) return createFieldValue(column.type, value);

  if (column.type === "timestamp") return createTimestampField({ value, onChange });

  if (column.type === "select") {
    const select = document.createElement("select");
    select.className = "form-input form-input-quiet data-table-cell-select";
    const listed = column.options ?? [];
    if (options.asHeld && !listed.includes(value)) {
      const held = document.createElement("option");
      held.value = value;
      held.textContent = value ? `${value} · not an option` : "";
      select.appendChild(held);
    }
    for (const option of listed) {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option;
      select.appendChild(optionEl);
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  if (column.type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "data-table-cell-checkbox";
    input.checked = value === "true";
    input.addEventListener("change", () => onChange(input.checked ? "true" : "false"));
    return input;
  }

  if (column.type === "color") {
    // An unrecognized value shows as "None" but is kept until a color is
    // picked: the format's lenient-preserve rule.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "form-input form-input-quiet data-table-cell-color";
    let current = value;
    const chip = createColorChip(current);
    button.append(chip);
    button.addEventListener("click", () => {
      controls.pickColor(button, current, (hex) => {
        current = hex;
        paintColorChip(chip, hex);
        onChange(hex);
      });
    });
    return button;
  }

  if (options.multiline && column.type === "text") {
    const area = document.createElement("textarea");
    area.className = "form-input form-input-quiet data-table-cell-text";
    area.value = value;
    area.addEventListener(options.commit ?? "input", () => onChange(area.value));
    return area;
  }

  const input = document.createElement("input");
  input.type = column.type === "integer" ? "number" : "text";
  if (column.type === "integer") input.step = "1";
  input.className = "form-input form-input-quiet data-table-cell-text";
  input.value = value;
  input.addEventListener(options.commit ?? "input", () => onChange(input.value));
  return input;
}

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

const FIELDS = "input, select, textarea, [contenteditable='true']";

// The rows under `root` that open a card, in the order shown, across every
// grid it holds.
function openableRows(root: HTMLElement): HTMLTableRowElement[] {
  return [...root.querySelectorAll<HTMLTableRowElement>("tbody > tr")].filter((tr) => tr.querySelector(GUTTER_OPEN));
}

/** Back on the row at `index` of those shown, once its card closes: the row
 * selected in a list, its open button focused on a card. */
export function focusRowAt(root: HTMLElement, index: number): void {
  const tr = openableRows(root)[index];
  if (tr) selectRow(root, tr);
  else root.querySelectorAll<HTMLElement>(".row-open")[index]?.focus();
}

/** Marks `tr` as the selected row and gives it focus, so its keys follow. */
export function selectRow(root: HTMLElement, tr: HTMLTableRowElement): void {
  for (const each of root.querySelectorAll("tbody > tr.is-selected")) each.classList.remove("is-selected");
  tr.classList.add("is-selected");
  tr.tabIndex = -1;
  tr.focus({ preventScroll: false });
}

/** Keys on the rows under `root` that open a card: Escape in a field selects
 * its row; on a selected row, Up and Down move the selection, Space opens
 * the row's card and Enter goes back into the field left, the caret at its
 * end. A field taking focus ends the selection. A right-click on a row or a
 * card, outside its fields, offers Open card. Returns its undoing. */
export function wireRowSelection(root: HTMLElement): () => void {
  let left: { tr: HTMLTableRowElement; cell: number } | undefined;
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
      selectRow(root, tr);
      return;
    }
    if (event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = openableRows(root);
      const at = rows.indexOf(tr) + (event.key === "ArrowUp" ? -1 : 1);
      if (rows[at]) selectRow(root, rows[at]);
    } else if (event.key === " ") {
      event.preventDefault();
      tr.querySelector<HTMLButtonElement>(GUTTER_OPEN)?.click();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const cell = left?.tr === tr ? tr.cells[left.cell] : undefined;
      const field = (cell ?? tr).querySelector<HTMLElement>(FIELDS);
      tr.classList.remove("is-selected");
      field?.focus();
      if (field instanceof HTMLInputElement && field.type === "text")
        field.setSelectionRange(field.value.length, field.value.length);
    }
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && event.target.matches(FIELDS)) {
      for (const each of root.querySelectorAll("tbody > tr.is-selected")) each.classList.remove("is-selected");
    }
  };
  // A field keeps the text menu alone, the browser's spelling included, and
  // a right-click something nearer took (a picture's menu) is left to it.
  // Elsewhere the row's item leads the text menu, so a value read there
  // still copies; a list's row is selected first, to show what it acts on.
  const onMenu = (event: MouseEvent) => {
    const target = event.target;
    if (event.defaultPrevented || !(target instanceof Element) || target.closest(FIELDS)) return;
    const holder = target.closest<HTMLElement>("tbody > tr, .data-cards-card");
    const open = holder && root.contains(holder) ? holder.querySelector<HTMLButtonElement>(".row-open") : null;
    if (!holder || !open) return;
    if (holder instanceof HTMLTableRowElement) selectRow(root, holder);
    leadTextMenu(event, { items: [{ label: "Open card", run: () => open.click() }], ariaLabel: "Row" });
  };
  root.addEventListener("keydown", onKey);
  root.addEventListener("focusin", onFocus);
  root.addEventListener("contextmenu", onMenu);
  return () => {
    root.removeEventListener("keydown", onKey);
    root.removeEventListener("focusin", onFocus);
    root.removeEventListener("contextmenu", onMenu);
  };
}

/** A grid of rows, whose body redraws alone from `setRows`. */
export function createGridTable<Row>(columns: readonly GridColumn<Row>[]): {
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
  const card = (row: TableRow, index: number) =>
    createCard({
      picture: picture && spec.cell(picture, row),
      title: title && spec.cell(title, row),
      badge: badge && spec.cell(badge, row),
      actions: [
        ...(openRow ? [createRowOpenButton(() => openRow(row, index))] : []),
        ...(spec.rowControl ? [spec.rowControl(row, draw)] : []),
      ],
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
  const { rowControl } = spec;
  const draw = () => grid.setRows(spec.rows);
  if (rowControl) columns.push({ cell: (row) => rowControl(row, draw) });
  const grid = createGridTable(columns);
  draw();
  return grid.table;
}
