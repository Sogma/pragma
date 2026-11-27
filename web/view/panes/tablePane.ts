import type { TextToolkitInfo } from "../../../src/protocol/api.ts";
import { cardWithField, cardWithFieldRenamed, cardWithoutField } from "../../../src/protocol/card.ts";
import { columnIdFor, columnIdOf } from "../../../src/protocol/columnId.ts";
import { isPrivateMetadata, stampTableDates, TABLE_DATE_KEYS } from "../../../src/protocol/metadata.ts";
import { resolveFileReference } from "../../../src/protocol/relativeReference.ts";
import { basenameOf, dirnameOf, isLibraryRoot, parseRootedPath } from "../../../src/protocol/rootedPath.ts";
import { serializeTableFile } from "../../../src/protocol/tableHtml.ts";
import type {
  CardTile,
  MetadataEntry,
  SmallCardTile,
  TableColumn,
  TableFile,
  TableLayout,
  TableRow,
} from "../../../src/protocol/types.ts";
import {
  emptyFieldValue,
  FIELD_VALUE_TYPE_OPTIONS,
  isFlowFile,
  isTableLayout,
  newRowValue,
  TABLE_LAYOUTS,
} from "../../../src/protocol/types.ts";
import {
  changeTableColumnId,
  type FileResponse,
  postTableLayout,
  type TableFileResponse,
} from "../../core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE, readDraggedPath, stripExtension } from "../../core/paths.ts";
import { entryIconAt, offeredFiles, pathNames, writePathFrom } from "../../core/spaceTree.ts";
import { contextOfTab } from "../../core/tabContext.ts";
import {
  createMediaPreview,
  createSelectedSection,
  type PreviewSources,
  previewedFile,
  type SelectedReads,
  servedPreviewSources,
} from "../../filePreview.ts";
import type { TableAtClick } from "../../flow/toolkitAction.ts";
import { createLayoutPanel } from "../../layoutPanel.ts";
import {
  cardParts,
  createColumnHeader,
  createTableForm,
  focusRowAt,
  type RowMenu,
  startLabelRename,
  valueCells,
  wireRowSelection,
} from "../../lib/dataGrid.ts";
import { el, iconButton } from "../../lib/dom.ts";
import { createFieldPopover } from "../../lib/fieldPopover.ts";
import { type CellOptions, createCell } from "../../lib/fieldValue.ts";
import { type Flyout, openFlyout } from "../../lib/flyout.ts";
import { createLinksPopover } from "../../lib/linksPopover.ts";
import { createPathLabel } from "../../lib/pathLabel.ts";
import { createRowSelection } from "../../lib/rowSelection.ts";
import { createPageFind } from "../../pageFind.ts";
import { createRowCard } from "../../rowCard.ts";
import type { DialogHandle, DialogService } from "../../services/dialog.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import { fieldSettingItems } from "../../services/fieldSettings.ts";
import { pickFile } from "../../services/filePicker.ts";
import type { FormatRegistry } from "../../services/formats.ts";
import { promptMediaFolder } from "../../services/mediaField.ts";
import type { ContextMenuService } from "../../services/menus.ts";
import type { Tabs } from "../../services/tabs.ts";
import { tableCellControls } from "../../tableCells.ts";
import type { MetadataProperties } from "../metadataProperties.ts";

let addColumnFlyout: Flyout | undefined;

function closeAddColumnPopover(): void {
  addColumnFlyout?.close();
}

// Opens the "Add column" popover anchored to `anchor`: the shared field form
// (lib/fieldPopover.ts), whose submitted name, type and options become a
// fully-formed TableColumn, id already derived, handed to `onAdd`. It never
// touches `columns`/`rows`/persistence — the caller owns backfilling existing
// rows and re-rendering.
function openAddColumnPopover(
  anchor: HTMLElement,
  existingIds: ReadonlySet<string>,
  onAdd: (column: TableColumn) => void,
): void {
  const { element: popover, focus } = createFieldPopover({
    title: "Add column",
    nameLabel: "Column name",
    typeLabel: "Column type",
    types: FIELD_VALUE_TYPE_OPTIONS,
    onSubmit: ({ label, type, options, default: fill, max, reject }) => {
      // No id field: the name implies a fair one, and the column's menu
      // changes it, so typing one here isn't worth the friction.
      const column: TableColumn = {
        id: columnIdFor(label, existingIds),
        type: type as TableColumn["type"],
        label,
      };
      if (options) column.options = options;
      if (fill) column.default = fill;
      if (max !== undefined) column.max = max;
      if (reject) column.reject = reject;
      onAdd(column);
      closeAddColumnPopover();
    },
    onCancel: closeAddColumnPopover,
  });

  addColumnFlyout = openFlyout(anchor, popover, () => {
    addColumnFlyout = undefined;
  });
  focus();
}

// Deleting a column only changes the working copy and schedules a debounced
// save — no network round-trip to await, so the confirmation has no busy
// state.
function confirmDeleteColumn(
  dialog: DialogService,
  column: TableColumn,
  onConfirm: (column: TableColumn) => void,
): void {
  void dialog
    .confirm({
      title: `Delete "${column.label}" column?`,
      message: `This permanently deletes the "${column.label}" column and its data from every row. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    })
    .then((confirmed) => {
      if (confirmed) onConfirm(column);
    });
}

// The Flows an id change rewrites, as its confirm lists them: a path a line.
function flowList(flows: readonly string[]): HTMLElement {
  const list = el("span", "dialog-path-list");
  for (const flow of flows) {
    if (list.childElementCount > 0) list.append(document.createElement("br"));
    list.append(createPathLabel(flow, pathNames, { type: "file" }));
  }
  return list;
}

// A row is named in its confirm by the text its card shows as its title,
// on one line and cut short so a long one can't fill the dialog. A title
// that isn't text names nothing.
const ROW_NAME_LENGTH = 40;

function rowName(columns: TableColumn[], row: TableRow): string {
  const { title } = cardParts(columns);
  if (title?.type !== "text") return "";
  const text = (row.values[title.id] ?? "").replace(/\s+/g, " ").trim();
  return text.length > ROW_NAME_LENGTH ? `${text.slice(0, ROW_NAME_LENGTH).trimEnd()}…` : text;
}

// One entry is named in its confirm, several counted.
function confirmDeleteRows(dialog: DialogService, names: readonly string[], onConfirm: () => void): void {
  const [name] = names;
  const one = names.length === 1;
  void dialog
    .confirm({
      title: !one ? `Delete ${names.length} entries?` : name ? `Delete "${name}" entry?` : "Delete this entry?",
      message: one
        ? "This permanently deletes the entry and its data. This cannot be undone."
        : "This permanently deletes the entries and their data. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    })
    .then((confirmed) => {
      if (confirmed) onConfirm();
    });
}

export interface TableViewDeps {
  // Draws the column ⋮ menu (services/menus.ts).
  contextMenu: ContextMenuService;
  editorTable: HTMLElement;
  dialog: DialogService;
  // Its group's reading-view toggle — session state, not a persisted
  // setting — read here to decide editable vs. locked grid.
  isReadingView: () => boolean;
  // `onWritten` runs once that content is written, unless a newer save of
  // the path supersedes it first.
  scheduleSave: (path: string, content: string, onWritten?: () => void) => void;
  // Called after every (re-)render, once editorTable's new content — and
  // the table's name, once known — is in hand, so the group re-places its
  // title bar.
  onRendered: () => void;
  // Where a pane-scoped prompt is anchored: the pane's editor group, which
  // outlives every redraw of this view and leaves the sidebar live beside it.
  dialogHost: HTMLElement;
  // Opens what a path cell names, by its rooted path, as a link opens it: a
  // path ending in `/` as its folder.
  openPath: (rootedPath: string) => void;
  // Reads an open document again, after a write it didn't make: a Flow an
  // id change rewrote.
  reloadPath: (path: string) => void;
  // A click on a media cell's picture, with the cell's field.
  openMedia: (rootedPath: string, field: HTMLElement) => void;
  // The pane's box, which a row's card lies over; without one, rows have
  // no card.
  overlayHost?: HTMLElement;
  // The status bar's line of the pane's own: how many rows are ticked.
  reportReadout?: (text: string) => void;
  // A layout picked from Layout: the pane draws it and keeps it for the
  // table's next open, as it keeps ⋮ › Layout's.
  pickLayout?: (layout: TableLayout) => void;
  // A change to the Table's links was written, so its toolkits are read again.
  linksWritten?: () => void;
}

export interface TableView {
  // The view's own controls for the floating toolbar: Delete, for the
  // ticked rows.
  readonly toolbar: HTMLElement;
  // Design mode: the column tools shown, over the same grid locked. Off
  // again when the view lets its table go or draws a different one: the view
  // outlives its tab, so a mode entered for one table would otherwise reach
  // the next one opened in its group.
  isDesigning(): boolean;
  setDesigning(on: boolean): void;
  // Which way the rows are drawn. A table is first drawn in the layout
  // picked for it on this install, else in the one its file names; a redraw
  // of the same table keeps the one shown. Never written back to the file.
  getLayout(): TableLayout;
  setLayout(layout: TableLayout): void;
  // Sets the working copy from a freshly fetched file and draws it — a
  // fresh open always starts from file.rows; a later refresh() (e.g. a
  // reading-view toggle) reuses the same working copy instead of
  // re-deriving from this now-stale `file` snapshot.
  render(file: TableFileResponse): void;
  // Re-draws from the current working copy — main.ts calls this on a
  // reading-view toggle while a table is open.
  refresh(): void;
  // Replaces the working copy's metadata block and saves it.
  setMetadata(metadata: MetadataEntry[]): void;
  // Clears the working copy — every pane-switcher that isn't opening a
  // table calls this (one shadow variable per pane-switcher, owned by this
  // module instead of a bare main.ts closure variable).
  clear(): void;
  isActive(): boolean;
  // For refreshEditorTitle's title-bar fallback (main.ts) — undefined
  // outside a table tab.
  getFileName(): string | undefined;
  // A row's card, while one shows over the pane.
  isCardOpen(): boolean;
  closeCard(): void;
  // The Table as a toolkit click takes it; undefined with none drawn.
  atClick(): TableAtClick | undefined;
}

// Owns the open `.table.html` file's live working copy (columns + rows) and
// draws it into `editorTable`. `rows` is persisted file content (see
// docs/protocol.md's "Tables" section), so every add/edit/delete
// re-serializes the whole file through the debounced-PUT save a CodeMirror
// document's edits use — nothing is session-only but the working copy.
export function createTableView(deps: TableViewDeps): TableView {
  let activeTable:
    | {
        file: TableFileResponse;
        columns: TableColumn[];
        rows: TableRow[];
        card?: CardTile[];
        smallCard?: SmallCardTile[];
        links: string[];
      }
    | undefined;
  let designing = false;
  // A change to the links written since the toolkits were last read.
  let linksUnread = false;
  let layout: TableLayout = "list";
  let drawn: HTMLElement | undefined;

  // Every save bumps `modified` to today; `created` is set the same way the
  // first time a table's ever saved through pragma (there's no separate
  // "new table" flow to have set it earlier — see docs/protocol.md's Tables
  // section) and left untouched after that.
  function persistActiveTable(onWritten?: () => void): void {
    if (!activeTable) return;
    const { file } = activeTable;
    // Belt-and-braces against the pane's own read-only lock: re-serializing a
    // locked file drops whatever this build couldn't parse out of it.
    if (file.locked) return;
    const today = new Date().toISOString().slice(0, 10);
    const working = workingFile(activeTable);
    const content = serializeTableFile({ ...working, metadata: stampTableDates(working.metadata, today) });
    // A save that overtakes the one carrying a links change carries it too,
    // so whichever lands reads the toolkits again.
    deps.scheduleSave(file.path, content, () => {
      onWritten?.();
      if (!linksUnread) return;
      linksUnread = false;
      deps.linksWritten?.();
    });
  }

  // The file's own layout is carried through untouched: a layout switch is
  // not an edit.
  function workingFile(table: NonNullable<typeof activeTable>): TableFile {
    const { file, columns, rows, card, smallCard, links } = table;
    return {
      version: file.version,
      name: file.name,
      metadata: file.metadata,
      columns,
      rows,
      layout: file.layout,
      card,
      smallCard,
      links,
    };
  }

  // Shared by both Add-column entry points (the empty-table state and the
  // header's "+" cell). Redraws the whole pane: a new column changes every
  // row's cell count, so there's no narrower update worth doing.
  //
  // Backfills the rows already there with the type's empty value, never a
  // new row's: the moment a timestamp column appeared is no time they were
  // added at.
  function addColumn(column: TableColumn): void {
    if (!activeTable) return;
    activeTable.columns.push(column);
    activeTable.card = cardWithField(activeTable.card, column.id);
    activeTable.smallCard = cardWithField(activeTable.smallCard, column.id);
    const value = emptyFieldValue(column);
    for (const row of activeTable.rows) row.values[column.id] = value;
    persistActiveTable();
    renderActiveTablePane();
  }

  // A setting from the column menu, such as a media column's Show name,
  // applied by column id to the Table it was asked on, if still open: a
  // prompt can outlive a reload. Redrawn, so every cell takes it at once;
  // rows keep their values.
  function changeColumn(path: string, id: string, edit: (column: TableColumn) => void): void {
    const target = activeTable?.file.path === path ? activeTable.columns.find((each) => each.id === id) : undefined;
    if (!target) return;
    edit(target);
    persistActiveTable();
    renderActiveTablePane();
  }

  // The column menu's "Change id…": the id every row's value and every Flow
  // naming the column key it by. The Flows change first, behind a confirm
  // that lists them, then this Table. An open Flow is read again once the
  // Table's save lands, or its Make Object would read the old id and drop
  // the wires the rewrite moved.
  async function changeColumnId(path: string, column: TableColumn): Promise<void> {
    const from = column.id;
    const typed = await deps.dialog.prompt({
      title: `Id of "${column.label}"`,
      message: "Flows name the column by its id. Renaming the column never changes it.",
      label: "Id",
      value: from,
      submitLabel: "Change",
      validate: (value) => {
        const id = columnIdOf(value);
        if (!id) return "An id needs a letter or a digit.";
        if (id !== from && activeTable?.columns.some((each) => each.id === id))
          return `"${id}" is another column's id.`;
        return undefined;
      },
    });
    const to = typed === null ? from : columnIdOf(typed);
    if (to === from) return;
    let changed: string[] = [];
    try {
      const flows = await changeTableColumnId({ path, from, to, apply: false });
      if (flows.length > 0) {
        const confirmed = await deps.dialog.confirm({
          title: `Change the id "${from}" to "${to}"?`,
          message: [
            "These Flows use the column, and will be updated to the new id:",
            flowList(flows),
            "Anything else that names the old id won't follow, such as another Table with the same columns that a Flow reaches through a wired path.",
          ],
          confirmLabel: "Change id",
        });
        if (!confirmed) return;
        changed = await changeTableColumnId({ path, from, to, apply: true });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Changing the column's id failed.");
      return;
    }
    renameColumnId(path, from, to, () => {
      for (const flow of changed) deps.reloadPath(flow);
    });
  }

  // A column's id, changed in the working copy: the column, every row's
  // value and the cards' tiles, everything else as it was.
  function renameColumnId(path: string, from: string, to: string, onWritten: () => void): void {
    const column = activeTable?.file.path === path ? activeTable.columns.find((each) => each.id === from) : undefined;
    if (!activeTable || !column) return;
    column.id = to;
    for (const row of activeTable.rows) {
      if (!Object.hasOwn(row.values, from)) continue;
      row.values[to] = row.values[from];
      delete row.values[from];
    }
    activeTable.card = cardWithFieldRenamed(activeTable.card, from, to);
    activeTable.smallCard = cardWithFieldRenamed(activeTable.smallCard, from, to);
    persistActiveTable(onWritten);
    renderActiveTablePane();
  }

  // The column menu's "Delete column", behind its confirm: removes the
  // column and every row's value for it, persists, and redraws the whole
  // pane, since a removal changes every row's cell count. `column` is
  // matched by identity, not id or index — nothing can mutate
  // activeTable.columns while the confirm modal is open.
  function deleteColumn(column: TableColumn): void {
    if (!activeTable) return;
    const index = activeTable.columns.indexOf(column);
    if (index === -1) return;
    activeTable.columns.splice(index, 1);
    activeTable.card = cardWithoutField(activeTable.card, column.id);
    activeTable.smallCard = cardWithoutField(activeTable.smallCard, column.id);
    for (const row of activeTable.rows) delete row.values[column.id];
    persistActiveTable();
    renderActiveTablePane();
  }

  // Rows deleted behind their confirm: from a card's delete button, a card's
  // ⋮, a right-click, or the toolbar for the ticked rows; `redraw` updates
  // the view once they are gone. Matched by identity in the working copy, so
  // a reload while the confirm is up deletes nothing.
  function deleteRows(rows: readonly TableRow[], redraw: () => void): void {
    if (rows.length === 0) return;
    const names = rows.map((row) => rowName(activeTable?.columns ?? [], row));
    confirmDeleteRows(deps.dialog, names, () => {
      if (!activeTable) return;
      const gone = new Set(rows);
      const kept = activeTable.rows.filter((row) => !gone.has(row));
      if (kept.length === activeTable.rows.length) return;
      // In place: a card list redraws from the array it was drawn with.
      activeTable.rows.splice(0, activeTable.rows.length, ...kept);
      persistActiveTable();
      redraw();
    });
  }

  // After a delete: from the card, the card closes onto the row that takes
  // its place.
  function redrawAfterDelete(): void {
    if (rowCard?.isOpen()) {
      rowCard.close();
      return;
    }
    renderActiveTablePane();
    deps.onRendered();
  }

  // A row's Delete entry, on its card's ⋮ and its right-click, offered in
  // Edit mode alone, as the toolbar's Delete is.
  function rowMenu(index: number): RowMenu {
    const row = activeTable?.rows[index];
    if (!row || valuesLocked()) return {};
    return {
      items: [{ label: "Delete entry", group: "trash", danger: true, run: () => deleteRows([row], redrawAfterDelete) }],
    };
  }

  // Governs where the next drop lands, never what's already linked: no
  // value is re-pointed or moved. Redrawn so every cell's drop picks it up.
  // Applied by column id to whatever is open when it's saved: a reload
  // while the prompt was up replaces the column object it was opened for.
  let folderPrompt: DialogHandle | undefined;
  function editMediaFolder(column: TableColumn): void {
    if (!activeTable) return;
    const path = activeTable.file.path;
    void promptMediaFolder({
      dialog: deps.dialog,
      docDir: dirnameOf(path),
      current: column.mediaFolder ?? "",
      host: deps.dialogHost,
      onOpen: (handle) => {
        folderPrompt = handle;
      },
    }).then((folder) => {
      folderPrompt = undefined;
      const target = activeTable?.file.path === path ? activeTable.columns.find((c) => c.id === column.id) : undefined;
      if (folder === null || !target || folder === (target.mediaFolder ?? "")) return;
      if (folder) target.mediaFolder = folder;
      else delete target.mediaFolder;
      persistActiveTable();
      renderActiveTablePane();
    });
  }

  const cellControls = tableCellControls({
    tablePath: () => activeTable?.file.path ?? "",
    openMedia: deps.openMedia,
    openPath: deps.openPath,
    dialog: deps.dialog,
    contextMenu: deps.contextMenu,
  });

  // One cell, by the column's type: its editor in Edit, its value as content
  // wherever values are locked (reading view, Design, a locked file). A blank
  // select takes its first option, as a new row's would.
  function buildTableCell(
    column: TableColumn,
    row: TableRow,
    onChange: () => void,
    readOnly: boolean,
    options?: CellOptions,
  ): HTMLElement {
    if (column.type === "select" && !readOnly) row.values[column.id] ||= column.options?.[0] ?? "";
    const set = (value: string): void => {
      row.values[column.id] = value;
      onChange();
    };
    return createCell(column, row.values[column.id] ?? "", set, readOnly, cellControls, options);
  }

  // Values lock as the grid's do. The card's layout is the Table's shape,
  // so it is arranged in Design mode alone, as the columns are.
  const valuesLocked = (): boolean => deps.isReadingView() || activeTable?.file.locked !== undefined || designing;
  const arrangeable = (): boolean =>
    designing && !deps.isReadingView() && activeTable !== undefined && !activeTable.file.locked;

  // The rows ticked in the list, known by the row itself, so a fresh read
  // of the file starts with none.
  const selection = createRowSelection<TableRow>({
    rows: () => activeTable?.rows ?? [],
    key: (row) => row,
    changed: showToolbar,
    root: deps.editorTable,
  });
  const deleteButton = iconButton("table-delete-selected", "Delete entry");
  deleteButton.append(el("span", "table-delete-selected-icon"));
  deleteButton.addEventListener("click", () => deleteRows(selection.selected(), redrawAfterDelete));
  const layoutButton = el("button", "flat-button table-toolbar-button", "Layout");
  layoutButton.type = "button";
  layoutButton.setAttribute("aria-haspopup", "dialog");
  layoutButton.addEventListener("click", openLayout);
  // How many Flows the Table links, in the pill a count wears on any control.
  const linksButton = el("button", "flat-button table-toolbar-button");
  linksButton.type = "button";
  linksButton.setAttribute("aria-haspopup", "dialog");
  const linksCount = el("span", "count-badge");
  const linksDigits = el("span");
  linksCount.append(linksDigits);
  linksButton.append("Links", linksCount);
  linksButton.addEventListener("click", openLinks);
  const toolbar = el("div", "table-toolbar");
  toolbar.hidden = true;
  // Links first, so neither Delete nor Layout moves it as they come and go.
  toolbar.append(linksButton, deleteButton, layoutButton);
  let layoutFlyout: Flyout | undefined;
  let linksFlyout: Flyout | undefined;

  // Delete for the ticked rows is offered where rows can change: Edit mode,
  // on the list. Its label, which its tooltip shows, counts them. Layout is
  // offered in Design mode alone, where the Table's shape changes. Links,
  // wherever the Table can be saved.
  function showToolbar(): void {
    const count = selection.count();
    const total = activeTable?.rows.length ?? 0;
    deleteButton.hidden = count === 0 || valuesLocked() || layout !== "list";
    layoutButton.hidden = !arrangeable();
    linksButton.hidden = !linksEditable();
    toolbar.hidden = deleteButton.hidden && layoutButton.hidden && linksButton.hidden;
    if (layoutButton.hidden) layoutFlyout?.close();
    if (linksButton.hidden) linksFlyout?.close();
    const links = activeTable?.links.length ?? 0;
    linksCount.hidden = links === 0;
    linksDigits.textContent = String(links);
    linksButton.setAttribute("aria-pressed", String(links > 0));
    deleteButton.setAttribute("aria-label", count === 1 ? "Delete entry" : `Delete ${count} entries`);
    deps.reportReadout?.(count === 0 ? "" : `${count} of ${total} ${total === 1 ? "entry" : "entries"} selected`);
  }

  // A Table in a library has no toolkits, so nothing to link.
  const linksEditable = (): boolean =>
    activeTable !== undefined &&
    !deps.isReadingView() &&
    activeTable.file.locked === undefined &&
    !isLibraryRoot(parseRootedPath(activeTable.file.path).root);
  const tableDir = (): string => dirnameOf(activeTable?.file.path ?? "");

  // A Table's Flows come from the space, as its toolkits do.
  function droppedFlow(event: DragEvent): { link: string } | { refused: string } | undefined {
    if (!event.dataTransfer?.types.includes(DRAGGED_ENTRY_TYPE)) return undefined;
    const dragged = readDraggedPath(event);
    if (!dragged) return undefined;
    if (event.dataTransfer.getData(DRAGGED_ENTRY_TYPE) === "directory")
      return { refused: "Drop a Flow, not a folder." };
    if (!isFlowFile(dragged.path)) return { refused: "A Table links Flows." };
    if (isLibraryRoot(dragged.root)) return { refused: "A Table's Flows come from this space." };
    const link = writePathFrom(tableDir(), dragged);
    return link ? { link } : { refused: "This Table can't name that file." };
  }

  // Built fresh from the Table each time it opens, so a second press closes
  // it before a new one is made.
  function openLinks(): void {
    if (linksFlyout) {
      linksFlyout.close();
      return;
    }
    const written = (path: string) => writePathFrom(tableDir(), parseRootedPath(path)) ?? path;
    const panel = createLinksPopover({
      owner: "table",
      links: () => activeTable?.links ?? [],
      change(edit) {
        if (!activeTable || !linksEditable()) return;
        edit(activeTable.links);
        linksUnread = true;
        persistActiveTable();
        showToolbar();
      },
      pickFile: (anchor, pick) =>
        pickFile(deps.contextMenu, {
          files: offeredFiles().filter((path) => isFlowFile(path)),
          anchor,
          ariaLabel: "Link a Flow to this Table",
          chosen: (path) => activeTable?.links.includes(written(path)) ?? false,
          pick: (path) => pick(written(path)),
        }),
      droppedFile: droppedFlow,
      describeLink(link) {
        const path = resolveFileReference(tableDir(), link) ?? link;
        const use = isFlowFile(path) ? "toolkit" : "reference";
        return { use, icon: entryIconAt(path, "file"), name: stripExtension(basenameOf(path)), path };
      },
      resized: () => linksFlyout?.reposition(),
    });
    linksButton.setAttribute("aria-expanded", "true");
    linksFlyout = openFlyout(linksButton, panel, () => {
      linksButton.setAttribute("aria-expanded", "false");
      linksFlyout = undefined;
    });
  }

  // A row's name: its title column's value, else its place.
  function rowTitle(index: number): string {
    const { title } = cardParts(activeTable?.columns ?? []);
    const text = title ? (activeTable?.rows[index]?.values[title.id] ?? "").trim() : "";
    return text || `Row ${index + 1}`;
  }

  // Built fresh from the Table each time it opens, so a second press closes
  // it before a new one is made.
  function openLayout(): void {
    if (layoutFlyout) {
      layoutFlyout.close();
      return;
    }
    const panel = createLayoutPanel({
      layout: () => layout,
      setLayout: (next) => (deps.pickLayout ? deps.pickLayout(next) : showLayout(next)),
      fields: () => activeTable?.columns ?? [],
      parts: () => cardParts(activeTable?.columns ?? []),
      ownTitle: false,
      card: () => activeTable?.smallCard,
      arrange(tiles) {
        if (!activeTable || !arrangeable()) return;
        activeTable.smallCard = tiles;
        persistActiveTable();
        renderActiveTablePane();
      },
      count: () => activeTable?.rows.length ?? 0,
      title: rowTitle,
      content(tile, index) {
        const row = activeTable?.rows[index];
        return row && tile.field ? buildTableCell(tile.field, row, persistActiveTable, true) : undefined;
      },
      contextMenu: deps.contextMenu,
    });
    layoutButton.setAttribute("aria-expanded", "true");
    layoutFlyout = openFlyout(layoutButton, panel.element, () => {
      layoutButton.setAttribute("aria-expanded", "false");
      panel.dispose();
      layoutFlyout = undefined;
    });
  }

  // A row's full card over the pane, its values the grid's own.
  const rowCard = deps.overlayHost
    ? createRowCard({
        host: deps.overlayHost,
        count: () => activeTable?.rows.length ?? 0,
        fields: () => activeTable?.columns ?? [],
        card: () => activeTable?.card,
        cell(column, index, { multiline }) {
          const row = activeTable?.rows[index] ?? { values: {} };
          return buildTableCell(column, row, persistActiveTable, valuesLocked(), { multiline });
        },
        title: rowTitle,
        source: () => activeTable?.file.name || basenameOf(activeTable?.file.path ?? "").replace(/\.table\.html$/, ""),
        arrangeable,
        arrange(tiles) {
          if (!activeTable || !arrangeable()) return;
          activeTable.card = tiles;
          persistActiveTable();
        },
        closed(index) {
          renderActiveTablePane();
          deps.onRendered();
          focusRowAt(deps.editorTable, index, selection);
        },
        menuOf: rowMenu,
        contextMenu: deps.contextMenu,
      })
    : undefined;
  wireRowSelection(deps.editorTable, { menuOf: rowMenu, selection, locked: valuesLocked });

  // The column's ⋮ menu — the only way to Rename or Delete it. Its rows act
  // on this column directly; the shared component draws it.
  function buildColumnMenuButton(column: TableColumn, labelEl: HTMLElement): HTMLElement {
    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "icon-button data-table-column-menu";
    menuButton.setAttribute("aria-label", "Column options");
    const menuIcon = document.createElement("span");
    menuIcon.className = "data-table-column-menu-icon";
    menuButton.appendChild(menuIcon);
    menuButton.addEventListener("click", () => {
      closeAddColumnPopover();
      if (deps.contextMenu.isOpen(menuButton)) {
        deps.contextMenu.close();
        return;
      }
      const path = activeTable?.file.path ?? "";
      deps.contextMenu.open({
        anchor: menuButton,
        ariaLabel: "Column options",
        items: [
          {
            label: "Rename…",
            run: () =>
              startLabelRename(labelEl, (label) => {
                column.label = label;
                persistActiveTable();
              }),
          },
          { label: "Change id…", run: () => void changeColumnId(path, column) },
          ...fieldSettingItems(column, {
            change: (edit) => changeColumn(path, column.id, edit),
            dialog: deps.dialog,
            mediaFolder: () => editMediaFolder(column),
          }),
          {
            label: "Delete column",
            danger: true,
            run: () => confirmDeleteColumn(deps.dialog, column, deleteColumn),
          },
        ],
      });
    });
    return menuButton;
  }

  // Draws editorTable from the working copy, in editing mode (inputs, "+ Add"),
  // design mode (the column tools over a locked grid) or reading mode (the
  // same grid, locked) — the table's half of the reading-view toggle text
  // documents follow too.
  function renderActiveTablePane(): void {
    if (!activeTable) return;
    const { file, columns, rows } = activeTable;
    // Two independent locks on the whole grid: the session's reading-view
    // toggle, and a file this build must not save over (the save refuses it too).
    //
    // Past them, Edit and Design each change one thing: Edit values and rows,
    // Design the columns. Neither reaches the other's, so a mis-click while
    // entering data cannot delete a column and one while reshaping cannot
    // change a value. An empty table is the one exception: with no columns
    // there is nothing to protect and nothing else to do.
    const editable = !deps.isReadingView() && file.locked === undefined;
    const schemaTools = editable && designing;
    const readOnly = !editable || designing;

    // An empty Table offers its first column, in Edit as in Design; one with
    // columns offers a row in Edit.
    let after: HTMLElement | undefined;
    if (columns.length === 0) after = editable ? addFirstColumnButton() : undefined;
    else if (!readOnly) after = addRowButton();

    // Only what the last draw drew: the group's title bar shares this
    // element, and a redraw not followed by onRendered would leave none.
    drawn?.remove();
    drawn = createTableForm({
      columns,
      rows,
      // Design draws the layout picked too, so a card arranged from Layout
      // shows on the cards behind it. The column tools live in the list's
      // header, which cards have none of, so they show on List alone.
      layout,
      smallCard: activeTable.smallCard,
      locked: file.locked,
      version: file.version,
      editable,
      readOnly,
      cell: (column, row) => buildTableCell(column, row, persistActiveTable, readOnly),
      header: (column) => {
        const header = createColumnHeader(column.label, editable ? column.type : undefined);
        // Rename and delete are reachable only via the "⋮" menu, never a
        // click on the label, so a stray click while reading the table can't
        // start a rename. Renaming touches only this label, never the
        // column's identity (data-field/`column.id`, which row values and
        // options key off).
        if (schemaTools) header.element.appendChild(buildColumnMenuButton(column, header.label));
        return header.element;
      },
      lastHeader: schemaTools
        ? { header: addColumnHeader(columns), headerClass: "data-table-add-column-cell" }
        : undefined,
      // A card deletes from its own corner; a list row is ticked and deleted
      // from the toolbar.
      deleteRow: readOnly ? undefined : (row, redraw) => deleteRows([row], redraw),
      openRow: rowCard ? (_row, index) => rowCard.open(index) : undefined,
      // Design's grid ticks nothing: its tools are the columns'.
      selection: designing ? undefined : selection,
      after,
    });
    deps.editorTable.appendChild(drawn);
    selection.prune();
    showToolbar();
  }

  // Design's "+" at the end of the header row.
  function addColumnHeader(columns: TableColumn[]): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button data-table-add-column";
    button.setAttribute("aria-label", "Add column");
    const icon = document.createElement("span");
    icon.className = "data-table-add-column-icon";
    button.appendChild(icon);
    button.addEventListener("click", () => {
      openAddColumnPopover(button, new Set(columns.map((column) => column.id)), addColumn);
    });
    return button;
  }

  function addFirstColumnButton(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button data-table-add-row";
    button.textContent = "+ Add column";
    button.addEventListener("click", () => openAddColumnPopover(button, new Set(), addColumn));
    return button;
  }

  function addRowButton(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button data-table-add-row";
    button.textContent = "+ Add";
    button.addEventListener("click", () => {
      if (!activeTable) return;
      const now = new Date();
      const values: Record<string, string> = {};
      for (const column of activeTable.columns) values[column.id] = newRowValue(column, now);
      activeTable.rows.push({ values });
      persistActiveTable();
      // A full redraw rather than the grid's own row append, since the new
      // row may be a card.
      renderActiveTablePane();
    });
    return button;
  }

  function showLayout(next: TableLayout): void {
    layout = next;
    // Cards tick nothing either.
    if (next !== "list") selection.clear();
    if (!activeTable) return;
    renderActiveTablePane();
    deps.onRendered();
  }

  return {
    toolbar,
    isDesigning: () => designing,
    setDesigning(on) {
      designing = on;
      // Design's grid ticks nothing, so ticks kept through it would act unseen.
      if (on) selection.clear();
      if (!activeTable) return;
      renderActiveTablePane();
      rowCard?.refresh();
      deps.onRendered();
    },
    getLayout: () => layout,
    setLayout: showLayout,
    render(file: TableFileResponse): void {
      const another = activeTable !== undefined && activeTable.file.path !== file.path;
      if (another) {
        designing = false;
        folderPrompt?.close();
        rowCard?.close(false);
        selection.clear();
      }
      if (activeTable === undefined || another) layout = file.localLayout ?? file.layout ?? "list";
      activeTable = {
        file,
        columns: file.columns,
        rows: file.rows.map((row) => ({ values: { ...row.values } })),
        ...(file.card ? { card: file.card.map((tile) => ({ ...tile })) } : {}),
        ...(file.smallCard ? { smallCard: file.smallCard.map((tile) => ({ ...tile })) } : {}),
        links: [...(file.links ?? [])],
      };
      renderActiveTablePane();
      rowCard?.refresh();
      deps.onRendered(); // now that activeTable.file.name is in hand
    },
    refresh(): void {
      renderActiveTablePane();
      rowCard?.refresh();
      deps.onRendered();
    },
    setMetadata(metadata: MetadataEntry[]): void {
      if (!activeTable || activeTable.file.locked || deps.isReadingView()) return;
      activeTable.file.metadata = metadata;
      persistActiveTable();
    },
    clear(): void {
      // Hosted outside this view, so nothing else would take it down with
      // the table it was about.
      folderPrompt?.close();
      layoutFlyout?.close();
      linksFlyout?.close();
      rowCard?.close(false);
      selection.clear();
      activeTable = undefined;
      designing = false;
    },
    isActive(): boolean {
      return activeTable !== undefined;
    },
    getFileName(): string | undefined {
      return activeTable?.file.name;
    },
    isCardOpen: () => rowCard?.isOpen() ?? false,
    closeCard: () => rowCard?.close(),
    atClick() {
      if (!activeTable) return undefined;
      return {
        content: serializeTableFile(workingFile(activeTable)),
        columns: structuredClone(activeTable.columns),
        rows: selection.selected().map((row) => ({ values: { ...row.values } })),
        private: isPrivateMetadata(activeTable.file.metadata),
      };
    },
  };
}

// ---- The Table pane ---------------------------------------------------
// The editor-group contract over createTableView above (docs/architecture.md's
// Files and views section): the pane owns its element, loads the file, and adapts the view.

export interface TablePaneDeps extends Omit<TableViewDeps, "editorTable" | "openMedia" | "linksWritten"> {
  loadFile: (path: string) => Promise<FileResponse>;
  // The base the pane's next save names (see services/saveQueue.ts).
  noteRevision: (path: string, revision: string) => void;
  metadataProperties: () => MetadataProperties;
  // Keeps the layout picked for the Table at `path` on this install.
  saveLayout: (path: string, layout: TableLayout) => Promise<void>;
  // What a media cell's preview and the Info section it fills read.
  previewSources: PreviewSources & SelectedReads;
  formats: Pick<FormatRegistry, "get">;
  // The pane read the toolkits of the Table it shows: on each open, and once
  // a change to its links is written.
  toolkitsRead?: (pane: TablePane) => void;
}

/** A Table's pane, as the Tools tab reads it: the Table shown with the
 * toolkits its last read gave, and the Table as a click there takes it. */
export interface TablePane extends EditorPane {
  readonly kind: "table";
  shownTable(): { path: string; toolkits: readonly TextToolkitInfo[] } | undefined;
  atClick(): (TableAtClick & { path: string }) | undefined;
}

export function isTablePane(pane: EditorPane): pane is TablePane {
  return pane.kind === "table";
}

// What a descriptor is wired with: everything but the hooks a pane takes
// from the group it is created in, the ones it reaches the server by, and
// the opens it makes through the tabs.
export type TablePaneWiring = Omit<
  TablePaneDeps,
  | "isReadingView"
  | "onRendered"
  | "dialogHost"
  | "saveLayout"
  | "previewSources"
  | "openPath"
  | "reloadPath"
  | "reportReadout"
> & { tabs: () => Pick<Tabs, "openSpacePath" | "reloadPath"> };

export function tablePane({ tabs, ...deps }: TablePaneWiring): EditorPaneDescriptor {
  return {
    kind: "table",
    chrome: { toolbar: true, readingView: true, statusbar: true, actions: ["data-design"] },
    create: (group) =>
      createTablePane({
        ...deps,
        saveLayout: postTableLayout,
        previewSources: servedPreviewSources(),
        openPath: (path) => void tabs().openSpacePath(path),
        reloadPath: (path) => void tabs().reloadPath(path),
        isReadingView: () => group.isReadingView(),
        onRendered: () => group.rendered(),
        dialogHost: group.element,
        reportReadout: (text) => group.reportReadout(text),
      }),
  };
}

export function createTablePane(deps: TablePaneDeps): TablePane {
  const element = document.createElement("div");
  element.className = "editor-table";
  // The pane's box, which stays still while the rows scroll in `element`,
  // so a preview laid over it doesn't scroll away with them.
  const frame = document.createElement("div");
  frame.className = "editor-table-pane";
  frame.append(element);
  // The context the tab is seen in, whose guides and look a previewed
  // still or clip shows.
  let context = "";
  const selected = createSelectedSection(deps.previewSources);
  const media = createMediaPreview({
    ...deps.previewSources,
    details: selected,
    host: frame,
    context: () => context,
    fields: element,
    loadFile: deps.loadFile,
    formats: deps.formats,
    contextMenu: deps.contextMenu,
    dialog: deps.dialog,
    openPath: deps.openPath,
  });
  const view = createTableView({
    ...deps,
    editorTable: element,
    openMedia: media.open,
    overlayHost: frame,
    pickLayout,
    linksWritten: () => void readToolkits(),
  });
  const properties = deps.metadataProperties();
  // Find searches the values in every mode, never replacing them.
  const find = createPageFind({ root: element, values: valueCells });

  // The file the view holds, whose metadata the Properties tab edits.
  let shown: TableFileResponse | undefined;
  // Its toolkits, as the server resolved them from its links.
  let toolkits: readonly TextToolkitInfo[] = [];

  // A failed read keeps the buttons shown until the next open.
  async function readToolkits(): Promise<void> {
    const path = shown?.path;
    if (!path) return;
    const file = await deps.loadFile(path).catch(() => undefined);
    if (shown?.path !== path || file?.kind !== "table") return;
    toolkits = file.toolkits ?? [];
    deps.toolkitsRead?.(pane);
  }

  // Drawn at once, since the view holds every row it needs; the pick is kept
  // for the table's next open, from ⋮ › Layout and from Layout alike.
  function pickLayout(id: string): void {
    if (!shown || !isTableLayout(id) || id === view.getLayout()) return;
    view.setLayout(id);
    deps.saveLayout(shown.path, id).catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : "Failed to change the layout.");
    });
  }

  // Shown on open and on a reading-view toggle, from the working copy: a
  // save's `modified` bump goes into the serialized file, not the working
  // copy, so it shows on the next open.
  function showProperties(file: TableFileResponse): void {
    const editable = !deps.isReadingView() && file.locked === undefined;
    properties.show(file.path, file.metadata, {
      onChange: editable ? (metadata) => view.setMetadata(metadata) : undefined,
      readOnlyKeys: TABLE_DATE_KEYS,
    });
  }

  const pane: TablePane = {
    kind: "table",
    element: frame,
    inspector: selected.section,
    toolbar: view.toolbar,
    toolbarAside: find.host,
    properties: properties.section,
    async setInput(tab, ctx, prefetched) {
      if (tab.kind !== "table") throw new Error(`the table pane can't show a "${tab.kind}" tab`);
      const file = prefetched ?? (await deps.loadFile(tab.path));
      if (!ctx.isCurrent()) return;
      if (file.kind !== "table") throw new Error(`${tab.path} is not a table`);
      deps.noteRevision(file.path, file.revision);
      if (shown?.path !== file.path) media.close(false);
      context = contextOfTab(tab);
      view.render(file);
      shown = file;
      toolkits = file.toolkits ?? [];
      find.show(file.path);
      showProperties(file);
      deps.toolkitsRead?.(pane);
    },
    clearInput: () => {
      media.close(false);
      find.show(undefined);
      view.clear();
      shown = undefined;
      toolkits = [];
      properties.clear();
    },
    shownTable: () => (shown ? { path: shown.path, toolkits } : undefined),
    atClick() {
      const at = shown && view.atClick();
      return shown && at ? { ...at, path: shown.path } : undefined;
    },
    title: () => view.getFileName(),
    titleHost: () => element,
    refresh: () => {
      view.refresh();
      if (shown) showProperties(shown);
    },
    hasTransient: () => media.isOpen() || view.isCardOpen() || find.isOpen(),
    dismissTransient: () => {
      if (media.isOpen()) media.close();
      else if (view.isCardOpen()) view.closeCard();
      else find.close();
    },
    selectedFile: () => previewedFile(media.shownPath()),
    findable: () => (shown ? "find" : undefined),
    openFind: () => find.open(),
    design: { isActive: () => view.isDesigning(), toggle: () => view.setDesigning(!view.isDesigning()) },
    layout: {
      current: () => view.getLayout(),
      set: pickLayout,
      available: () => TABLE_LAYOUTS,
    },
    dispose() {
      media.dispose();
      find.dispose();
      view.clear();
      frame.remove();
    },
  };
  return pane;
}
