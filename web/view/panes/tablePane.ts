import { cardWithField, cardWithoutField } from "../../../src/protocol/card.ts";
import { stampTableDates, TABLE_DATE_KEYS } from "../../../src/protocol/metadata.ts";
import { basenameOf, dirnameOf } from "../../../src/protocol/rootedPath.ts";
import { serializeTableFile } from "../../../src/protocol/tableHtml.ts";
import type {
  CardTile,
  MetadataEntry,
  TableColumn,
  TableFile,
  TableLayout,
  TableRow,
} from "../../../src/protocol/types.ts";
import {
  emptyFieldValue,
  FIELD_VALUE_TYPE_OPTIONS,
  isTableLayout,
  newRowValue,
  TABLE_LAYOUTS,
} from "../../../src/protocol/types.ts";
import { type FileResponse, postTableLayout, type TableFileResponse } from "../../core/apiClient.ts";
import { contextOfTab } from "../../core/tabContext.ts";
import {
  createMediaPreview,
  createSelectedSection,
  type PreviewSources,
  previewedFile,
  type SelectedReads,
  servedPreviewSources,
} from "../../filePreview.ts";
import {
  type CellOptions,
  cardParts,
  createCell,
  createColumnHeader,
  createTableForm,
  focusRowAt,
  startLabelRename,
  valueCells,
  wireRowSelection,
} from "../../lib/dataGrid.ts";
import { buildTableRowDeleteButton } from "../../lib/dom.ts";
import { createFieldPopover } from "../../lib/fieldPopover.ts";
import { type Flyout, openFlyout } from "../../lib/flyout.ts";
import { uniqueSlug } from "../../lib/slug.ts";
import { createPageFind } from "../../pageFind.ts";
import { createRowCard } from "../../rowCard.ts";
import type { DialogHandle, DialogService } from "../../services/dialog.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
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
    onSubmit: ({ label, type, options, default: fill }) => {
      // No id field: the id keys every row's value, but the label already
      // implies a fair one, so typing it by hand isn't worth the friction.
      const column: TableColumn = {
        id: uniqueSlug(label, existingIds, "column"),
        type: type as TableColumn["type"],
        label,
      };
      if (options) column.options = options;
      if (fill) column.default = fill;
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

function confirmDeleteRow(dialog: DialogService, name: string, onConfirm: () => void): void {
  void dialog
    .confirm({
      title: name ? `Delete "${name}" entry?` : "Delete this entry?",
      message: "This permanently deletes the entry and its data. This cannot be undone.",
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
  scheduleSave: (path: string, content: string) => void;
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
  // A click on a media cell's picture, with the cell's field.
  openMedia: (rootedPath: string, field: HTMLElement) => void;
  // The pane's box, which a row's card lies over; without one, rows have
  // no card.
  overlayHost?: HTMLElement;
}

export interface TableView {
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
      }
    | undefined;
  let designing = false;
  let layout: TableLayout = "list";
  let drawn: HTMLElement | undefined;

  // Every save bumps `modified` to today; `created` is set the same way the
  // first time a table's ever saved through pragma (there's no separate
  // "new table" flow to have set it earlier — see docs/protocol.md's Tables
  // section) and left untouched after that.
  function persistActiveTable(): void {
    if (!activeTable) return;
    const { file, columns, rows, card } = activeTable;
    // Belt-and-braces against the pane's own read-only lock: re-serializing a
    // locked file drops whatever this build couldn't parse out of it.
    if (file.locked) return;
    const today = new Date().toISOString().slice(0, 10);
    const content = serializeTableFile({
      version: file.version,
      name: file.name,
      metadata: stampTableDates(file.metadata, today),
      columns,
      rows,
      // The file's own default, carried through untouched: a layout switch
      // is not an edit.
      layout: file.layout,
      card,
    } satisfies TableFile);
    deps.scheduleSave(file.path, content);
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
    const value = emptyFieldValue(column);
    for (const row of activeTable.rows) row.values[column.id] = value;
    persistActiveTable();
    renderActiveTablePane();
  }

  // The column menu's switch for a timestamp: whether new rows get the time
  // they're added. Rows already there keep what they have either way.
  function toggleTimestampDefault(column: TableColumn): void {
    if (column.default) delete column.default;
    else column.default = "now";
    persistActiveTable();
  }

  // The column menu's switch for media: whether each file's name shows
  // beside its picture. Redrawn, so every cell takes it at once.
  function toggleShowName(column: TableColumn): void {
    if (column.showName) delete column.showName;
    else column.showName = true;
    persistActiveTable();
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
    for (const row of activeTable.rows) delete row.values[column.id];
    persistActiveTable();
    renderActiveTablePane();
  }

  // A row's or card's delete button, behind its confirm; `redraw` is the
  // layout's own update once the row is gone. Matched by identity in the
  // working copy, so a reload while the confirm is up deletes nothing.
  function rowDeleteButton(columns: TableColumn[], row: TableRow, redraw: () => void): HTMLButtonElement {
    return buildTableRowDeleteButton(() =>
      confirmDeleteRow(deps.dialog, rowName(columns, row), () => {
        const index = activeTable?.rows.indexOf(row) ?? -1;
        if (!activeTable || index === -1) return;
        activeTable.rows.splice(index, 1);
        persistActiveTable();
        redraw();
      }),
    );
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
        title(index) {
          const { title } = cardParts(activeTable?.columns ?? []);
          const text = title ? (activeTable?.rows[index]?.values[title.id] ?? "").trim() : "";
          return text || `Row ${index + 1}`;
        },
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
          focusRowAt(deps.editorTable, index);
        },
        contextMenu: deps.contextMenu,
      })
    : undefined;
  wireRowSelection(deps.editorTable);

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
          ...(column.type === "media"
            ? [
                { label: "Show name", checked: () => column.showName === true, run: () => toggleShowName(column) },
                { label: "Media folder…", run: () => editMediaFolder(column) },
              ]
            : []),
          ...(column.type === "timestamp"
            ? [
                {
                  label: "Fill new rows with the time added",
                  checked: () => column.default === "now",
                  run: () => toggleTimestampDefault(column),
                },
              ]
            : []),
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

  // Draws editorTable from the working copy, in editing mode (inputs, delete
  // buttons, "+ Add"), design mode (the column tools over a locked grid) or
  // reading mode (the same grid, locked) — the table's half of the
  // reading-view toggle text documents follow too.
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
      // Design is always the list: its tools are column-shaped and live in a
      // header a card has none of.
      layout: designing ? "list" : layout,
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
      rowControl: readOnly ? undefined : (row, redraw) => rowDeleteButton(columns, row, redraw),
      openRow: rowCard ? (_row, index) => rowCard.open(index) : undefined,
      after,
    });
    deps.editorTable.appendChild(drawn);
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

  return {
    isDesigning: () => designing,
    setDesigning(on) {
      designing = on;
      if (!activeTable) return;
      renderActiveTablePane();
      rowCard?.refresh();
      deps.onRendered();
    },
    getLayout: () => layout,
    setLayout(next) {
      layout = next;
      if (!activeTable) return;
      renderActiveTablePane();
      deps.onRendered();
    },
    render(file: TableFileResponse): void {
      const another = activeTable !== undefined && activeTable.file.path !== file.path;
      if (another) {
        designing = false;
        folderPrompt?.close();
        rowCard?.close(false);
      }
      if (activeTable === undefined || another) layout = file.localLayout ?? file.layout ?? "list";
      activeTable = {
        file,
        columns: file.columns,
        rows: file.rows.map((row) => ({ values: { ...row.values } })),
        ...(file.card ? { card: file.card.map((tile) => ({ ...tile })) } : {}),
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
      rowCard?.close(false);
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
  };
}

// ---- The Table pane ---------------------------------------------------
// The editor-group contract over createTableView above (docs/architecture.md's
// Files and views section): the pane owns its element, loads the file, and adapts the view.

export interface TablePaneDeps extends Omit<TableViewDeps, "editorTable" | "openMedia"> {
  loadFile: (path: string) => Promise<FileResponse>;
  // The base the pane's next save names (see services/saveQueue.ts).
  noteRevision: (path: string, revision: string) => void;
  metadataProperties: () => MetadataProperties;
  // Keeps the layout picked for the Table at `path` on this install.
  saveLayout: (path: string, layout: TableLayout) => Promise<void>;
  // What a media cell's preview and the Info section it fills read.
  previewSources: PreviewSources & SelectedReads;
  formats: Pick<FormatRegistry, "get">;
}

// What a descriptor is wired with: everything but the hooks a pane takes
// from the group it is created in, the ones it reaches the server by, and
// the opens it makes through the tabs.
export type TablePaneWiring = Omit<
  TablePaneDeps,
  "isReadingView" | "onRendered" | "dialogHost" | "saveLayout" | "previewSources" | "openPath"
> & { tabs: () => Pick<Tabs, "openSpacePath"> };

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
        isReadingView: () => group.isReadingView(),
        onRendered: () => group.rendered(),
        dialogHost: group.element,
      }),
  };
}

export function createTablePane(deps: TablePaneDeps): EditorPane {
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
  const view = createTableView({ ...deps, editorTable: element, openMedia: media.open, overlayHost: frame });
  const properties = deps.metadataProperties();
  // Find searches the values in every mode, never replacing them.
  const find = createPageFind({ root: element, values: valueCells });

  // The file the view holds, whose metadata the Properties tab edits.
  let shown: TableFileResponse | undefined;

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

  return {
    kind: "table",
    element: frame,
    inspector: selected.section,
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
      find.show(file.path);
      showProperties(file);
    },
    clearInput: () => {
      media.close(false);
      find.show(undefined);
      view.clear();
      shown = undefined;
      properties.clear();
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
      // Drawn at once, since the view holds every row it needs; the pick is
      // kept for the table's next open.
      set: (id) => {
        if (!shown || !isTableLayout(id) || id === view.getLayout()) return;
        view.setLayout(id);
        deps.saveLayout(shown.path, id).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Failed to change the layout.");
        });
      },
      available: () => TABLE_LAYOUTS,
    },
    dispose() {
      media.dispose();
      find.dispose();
      view.clear();
      frame.remove();
    },
  };
}
