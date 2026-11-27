// The Class pane: a Class's notes as rows, each value read from the
// note's own frontmatter, drawn as a Table draws its rows — the grid or one
// card per row. A row's title opens its note beside this tab, so the
// Class stays.
//
// The Class itself is changed where it shows, with no mode to enter:
// Filter, Sort, Group and Fields in the floating toolbar, the views' tabs,
// and a column header's menu. The reading view is the only lock.

import { cardWithoutField } from "../../../src/protocol/card.ts";
import {
  CLASS_FIELD_TYPE_OPTIONS,
  type ClassPlace,
  type ClassRow,
  cellValue,
  classFolders,
  classLinkUse,
  classViews,
  fieldAsRead,
  folderValueOf,
  frontmatterValue,
  groupRows,
  holdsTags,
  isFileField,
  matchesRules,
  newNoteProperties,
  noteFolderOf,
  type RowGroup,
  readsFolder,
  rowValue,
  viewFields,
  viewRows,
} from "../../../src/protocol/class.ts";
import { serializeClassFile } from "../../../src/protocol/classHtml.ts";
import { entryNameForTitle } from "../../../src/protocol/entryName.ts";
import { editFrontmatter } from "../../../src/protocol/frontmatter.ts";
import { resolveFileReference } from "../../../src/protocol/relativeReference.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
  sameRoot,
} from "../../../src/protocol/rootedPath.ts";
import { scopeOf } from "../../../src/protocol/scopes.ts";
import {
  type ClassFile,
  type ClassView,
  FIELD_TYPES,
  isFlowFile,
  type MetadataEntry,
  retypeField,
  TABLE_LAYOUTS,
  type TableColumn,
} from "../../../src/protocol/types.ts";
import {
  ApiError,
  type ClassFileResponse,
  type CreateEntryResponse,
  type FileResponse,
  fetchClassRows,
  postCreateEntry,
  postCreateFromTemplate,
} from "../../core/apiClient.ts";
import { isWritableRoot } from "../../core/libraries.ts";
import { DRAGGED_ENTRY_TYPE, pathHint, readDraggedPath, stripExtension } from "../../core/paths.ts";
import { inTemplateFolders } from "../../core/presets.ts";
import {
  classLinkFiles,
  entryIconAt,
  manualArrangement,
  readingResolvers,
  scopesOf,
  writePathFrom,
} from "../../core/spaceTree.ts";
import { contextOfTab } from "../../core/tabContext.ts";
import { tagVocabulary } from "../../core/tagVocabulary.ts";
import { onWritten, writesNotified } from "../../core/written.ts";
import {
  createMediaPreview,
  createSelectedSection,
  type PreviewSources,
  previewedFile,
  type SelectedReads,
  servedPreviewSources,
} from "../../filePreview.ts";
import { createLayoutPanel } from "../../layoutPanel.ts";
import { type ChangeScope, type ClassTool, createClassToolbar, describeRule } from "../../lib/classToolbar.ts";
import { openColorPicker } from "../../lib/colorPicker.ts";
import {
  cardParts,
  createCard,
  createCardList,
  createCardRemoveButton,
  createColumnHeader,
  createGridTable,
  createRowOpenButton,
  focusRowAt,
  type RowMenu,
  rowGutterColumn,
  rowSelectColumn,
  startLabelRename,
  valueCells,
  wireRowSelection,
} from "../../lib/dataGrid.ts";
import { buildLockNotice, countText, onLinkClick } from "../../lib/dom.ts";
import { type CellControls, createCell, createFieldValue } from "../../lib/fieldValue.ts";
import { oneAtATime } from "../../lib/oneAtATime.ts";
import { createRowSelection } from "../../lib/rowSelection.ts";
import { createArrangedCard, resolveSmallCard } from "../../lib/smallCard.ts";
import { createPill, createTagPill, paintTagPills } from "../../lib/tagPill.ts";
import type { TagSource } from "../../lib/tagSuggestions.ts";
import { installLinkPreview } from "../../notePreview.ts";
import { createPageFind } from "../../pageFind.ts";
import { createRowCard } from "../../rowCard.ts";
import type { DialogHandle, DialogService } from "../../services/dialog.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import { fieldSettingItems } from "../../services/fieldSettings.ts";
import { pickFile } from "../../services/filePicker.ts";
import { onFolderSortChanged, setOwnArrangement } from "../../services/folderSorts.ts";
import type { FormatRegistry } from "../../services/formats.ts";
import { createMediaField, mediaImportFor, promptMediaFolder, resolveMediaFolder } from "../../services/mediaField.ts";
import type { ContextMenuService, MenuItem, MenuRegistry } from "../../services/menus.ts";
import { createPathField } from "../../services/pathField.ts";
import type { Tabs } from "../../services/tabs.ts";
import type { MetadataProperties } from "../metadataProperties.ts";

export interface ClassPaneDeps {
  loadFile: (path: string) => Promise<FileResponse>;
  // What draws a row's document of another type on its preview's page.
  formats: Pick<FormatRegistry, "get">;
  loadRows: (path: string) => Promise<ClassRow[]>;
  // Opens a row's note, or what a media or path value names, in this tab's
  // place, as a link opens it: a path ending in `/` as its folder.
  openPath: (rootedPath: string) => void;
  dialog: DialogService;
  contextMenu: ContextMenuService;
  // The base the pane's next save names, and the save itself, whose
  // `onWritten` runs once that content is on disk.
  noteRevision: (path: string, revision: string) => void;
  scheduleSave: (path: string, content: string, onWritten?: () => void) => void;
  // Its group's reading-view toggle.
  isReadingView: () => boolean;
  // Called after every render, so the group re-places its title bar.
  onRendered: () => void;
  // Where a pane-scoped prompt is anchored, so a folder can be dragged in
  // from the tree beside it.
  dialogHost: HTMLElement;
  // A note's frontmatter, edited through the model its editor uses, so an
  // open note with unsaved edits is changed in place rather than raced.
  editProperties: (path: string, edit: (properties: Record<string, unknown>) => void) => Promise<void>;
  // A new file, refused with a 409 when the name is taken.
  createFile: (folder: string, name: string, content: string) => Promise<CreateEntryResponse>;
  // The names a folder lists in its own order, while that order is manual,
  // so a drag can arrange it; undefined while it is another.
  arrangement: (folder: string) => string[] | undefined;
  // Makes `names` the folder's own order, as a drag in the tree does.
  arrange: (folder: string, names: string[]) => Promise<void>;
  // Hears which folder's order changed, from anywhere; returns the unsubscribe.
  onFolderSorted: (listener: (folder: string) => void) => () => void;
  // Hears the paths each write the page makes leaves, with the count of
  // writes told by then, which a read started at that count holds.
  onWritten: (listener: (paths: readonly string[], through: number) => void) => () => void;
  writesNotified: () => number;
  // Every file the Class can link, by path.
  files: () => string[];
  // A copy of the template at `template` in `folder`, titled `title`, as
  // New ▸ Template makes one.
  createFromTemplate: (template: string, folder: string, title: string) => Promise<CreateEntryResponse>;
  // Its group's status-bar line: which note a change went to.
  reportReadout: (text: string) => void;
  metadataProperties: () => MetadataProperties;
  // The space's tags, whose colors fill a tag's pill.
  tags: TagSource;
  // What a media value's preview and the Info section it fills read, and
  // where its open button opens.
  previewSources: PreviewSources & SelectedReads;
  openBeside: (rootedPath: string) => void;
  // A row's file trashed as its right-click trashes it: what a card's
  // remove button is named and does.
  removal: (path: string) => { label: string; run(): void };
}

// What only main holds; the descriptor binds the rest.
export type ClassPaneWiring = Pick<
  ClassPaneDeps,
  | "loadFile"
  | "formats"
  | "dialog"
  | "contextMenu"
  | "noteRevision"
  | "scheduleSave"
  | "editProperties"
  | "metadataProperties"
> & {
  menus: MenuRegistry;
  tabs: () => Pick<Tabs, "openSpacePath" | "openEntryBeside">;
};

/** A Class's pane, with what its group's ⋮ menu offers while the toolbar is
 * too narrow for the Class's own buttons. */
export interface ClassPane extends EditorPane {
  toolsFolded(): boolean;
  openTool(tool: ClassTool): void;
}

function isClassPane(pane: EditorPane): pane is ClassPane {
  return pane.kind === "class";
}

// The buttons a narrow pane's toolbar leaves out, in the ⋮ menu instead, so
// the menu never repeats one the toolbar shows.
function registerClassMenu(menus: MenuRegistry): void {
  menus.register("editor.toolbar", (context) => {
    const pane = context.pane && isClassPane(context.pane) ? context.pane : undefined;
    if (!pane?.toolsFolded()) return [];
    return [
      { label: "Filter…", run: () => pane.openTool("filter") },
      { label: "Sort…", run: () => pane.openTool("sort") },
      { label: "Group…", run: () => pane.openTool("group") },
      { label: "Fields…", run: () => pane.openTool("fields") },
      { label: "Links…", run: () => pane.openTool("links") },
      ...(pane.design?.isActive() ? [{ label: "Layout…", run: () => pane.openTool("layout") }] : []),
    ];
  });
}

/** The Class's pane and its ⋮ menu. The routes, the folder sorts and the
 * space's tags are bound here; the pane factory still takes them as deps, for
 * tests. */
export function classPane({ menus, tabs, ...deps }: ClassPaneWiring): EditorPaneDescriptor {
  registerClassMenu(menus);
  return {
    kind: "class",
    chrome: { toolbar: true, readingView: true, statusbar: true, actions: ["data-design"] },
    create: (group) =>
      createClassPane({
        ...deps,
        openPath: (path) => void tabs().openSpacePath(path),
        openBeside: (path) => void tabs().openEntryBeside(path),
        previewSources: servedPreviewSources(),
        loadRows: fetchClassRows,
        createFile: (folder, name, content) => postCreateEntry(folder, name, "file", content),
        arrangement: manualArrangement,
        arrange: setOwnArrangement,
        onFolderSorted: onFolderSortChanged,
        onWritten,
        writesNotified,
        files: classLinkFiles,
        createFromTemplate: postCreateFromTemplate,
        isReadingView: () => group.isReadingView(),
        onRendered: () => group.rendered(),
        dialogHost: group.element,
        reportReadout: (text) => group.reportReadout(text),
        tags: tagVocabulary,
        removal: (path) => group.fileRemoval(path),
      }),
  };
}

function viewLabel(view: ClassView, index: number): string {
  return view.name || `View ${index + 1}`;
}

function findField(file: ClassFile, id: string): TableColumn | undefined {
  return file.fields.find((field) => field.id === id);
}

// A row in flight carries its own type, so no other drop target takes it
// for a file to move or link.
const CLASS_ROW_TYPE = "application/x-pragma-class-row";

// Whether a Class at `place` reads `folder`'s order: as a folder it reads,
// or one below a folder whose subfolders it reads.
function readsOrderOf(file: ClassFile, place: ClassPlace, folder: string): boolean {
  return classFolders(place, file.filter).some((read) => readsFolder(read, folder));
}

export function createClassPane(deps: ClassPaneDeps): ClassPane {
  const element = document.createElement("div");
  element.className = "editor-class";
  // The pane's box, which stays still while the rows scroll in `element`.
  const frame = document.createElement("div");
  frame.className = "editor-class-pane";
  frame.append(element);
  // A row's title shows its file while the pointer rests on it, as a link in
  // a note does, with the rest of the Class muted.
  const linkPreview = installLinkPreview(element, {
    loadFile: deps.loadFile,
    readingResolvers,
    formats: deps.formats,
    openPath: deps.openPath,
    openBeside: deps.openBeside,
    area: frame,
    runs: "right",
    contextMenu: deps.contextMenu,
    dialog: deps.dialog,
  });
  // A media value shows over the Class on a click, as a Table's does.
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
  const properties = deps.metadataProperties();
  // Find searches the rows' titles and values, never replacing them.
  const find = createPageFind({ root: element, values: valueCells });
  let open:
    | {
        file: ClassFileResponse;
        rows: ClassRow[];
        view: number;
        // What last went wrong reading rows or writing a note, shown above
        // the rows until the next one succeeds.
        notice?: string;
        // A new note being titled, under the group it was started in.
        drafting?: { group: string | undefined; error?: string; template?: string };
      }
    | undefined;
  let folderPrompt: DialogHandle | undefined;
  // The rows the view shows, in the order shown, which a row's card steps
  // through.
  let displayed: ClassRow[] = [];
  // Design mode governs the card alone: its tiles arrange and its values
  // lock, while the list and its tools work as in Edit.
  let designing = false;

  // A row's full card over the pane, its values its note's.
  const rowCard = createRowCard({
    host: frame,
    count: () => displayed.length,
    fields: () => open?.file.fields ?? [],
    card: () => open?.file.card,
    cell(field, index, { multiline }) {
      const row = displayed[index];
      return row ? buildCell(field, row, multiline, designing) : document.createElement("span");
    },
    title: (index) => displayed[index]?.title ?? "",
    source: () => open?.file.name || basenameOf(open?.file.path ?? "").replace(/\.class\.html$/, ""),
    pathOf: (index) => displayed[index]?.path,
    openBeside: deps.openBeside,
    arrangeable: () => designing && editable(),
    arrange(tiles) {
      if (!open || !designing || !editable()) return;
      open.file.card = tiles;
      save();
    },
    closed(index) {
      render();
      focusRowAt(element, index, selection);
    },
    menuOf: rowMenu,
    contextMenu: deps.contextMenu,
  });
  // The rows ticked in the list, known by their file's path, so a fresh read
  // of the rows keeps them.
  const selection = createRowSelection<ClassRow>({
    rows: () => displayed,
    key: (row) => row.path,
    root: element,
    changed() {
      const count = selection.count();
      const total = displayed.length;
      deps.reportReadout(count === 0 ? "" : `${count} of ${countText(total, "item")} selected`);
    },
  });
  wireRowSelection(element, { menuOf: rowMenu, selection, locked: () => !editable() });

  function openCard(row: ClassRow): void {
    const index = displayed.indexOf(row);
    if (index !== -1) rowCard.open(index);
  }

  // A row's file, named to its card's ⋮ and its right-click, whose
  // registered items offer its trash as its tab's menu does.
  function rowMenu(index: number): RowMenu {
    const row = displayed[index];
    return row ? { arg: { file: row.path } } : {};
  }

  function editable(): boolean {
    return open !== undefined && open.file.locked === undefined && !deps.isReadingView();
  }

  function currentView(): ClassView | undefined {
    if (!open) return undefined;
    const views = classViews(open.file);
    return views[open.view] ?? views[0];
  }

  function classDir(): string {
    return dirnameOf(open?.file.path ?? "");
  }

  // The rooted folder of the scope the Class sits in, at or above its own:
  // what its Folder values are written from.
  function scopeFolder(): string {
    const dir = classDir();
    const { root, path } = parseRootedPath(dir);
    return formatRootedPath({ root, path: isLibraryRoot(root) ? "" : scopeOf(scopesOf(dir), path) });
  }

  function place(): ClassPlace {
    return { scope: scopeFolder(), folder: classDir() };
  }

  function save(onWritten?: () => void): void {
    if (!open || open.file.locked) return;
    const { version, name, metadata, filter, fields, views, links, card, smallCard } = open.file;
    const file: ClassFile = { version, name, metadata, filter, fields, views, links, card, smallCard };
    deps.scheduleSave(open.file.path, serializeClassFile(file), onWritten);
  }

  // Unlike every other edit here, the metadata block reaches no view: it
  // writes out no view, and draws nothing again.
  function setMetadata(metadata: MetadataEntry[]): void {
    if (!open || !editable()) return;
    open.file.metadata = metadata;
    save();
  }

  // The count of writes told when a read of the rows last started: that
  // read holds them all, landed or still going.
  let readThrough = 0;
  // Reads started, so one that lands after a newer one draws nothing: a
  // write's notice can start a read before the write's last save lands.
  let reads = 0;

  // Rows come from the host, which reads the Class's own filter from the
  // file on disk, so they are read again once a change to it is written.
  async function reloadRows(): Promise<void> {
    const target = open;
    if (!target) return;
    const read = ++reads;
    readThrough = deps.writesNotified();
    try {
      const rows = await deps.loadRows(target.file.path);
      if (open !== target || read !== reads) return;
      target.rows = rows;
      delete target.notice;
    } catch (error) {
      if (open !== target || read !== reads) return;
      target.notice = `Couldn't refresh this Class: ${error instanceof Error ? error.message : String(error)}`;
    }
    render();
  }

  // A folder arranged anywhere, in the tree or by a drag here, reorders the
  // rows a view with no sort shows in its order.
  const stopHearingSorts = deps.onFolderSorted((folder) => {
    if (open && readsOrderOf(open.file, place(), folder)) void reloadRows();
  });

  // A write this page makes in a folder the Class reads, such as a row's
  // note moved to the Trash, shows in its rows at once, unless a read
  // started since holds it. A folder named as written into counts too.
  const rereadRows = oneAtATime(reloadRows);
  const stopHearingWrites = deps.onWritten((paths, through) => {
    if (!open || readThrough >= through) return;
    const reads = classFolders(place(), open.file.filter);
    const lists = (path: string) => reads.some((read) => readsFolder(read, dirnameOf(path)) || readsFolder(read, path));
    if (paths.some(lists)) rereadRows();
  });

  // Every change to the Class goes through here. One with no views
  // writes out the one it showed first, so a view's change has a view to
  // land in.
  function change(edit: (file: ClassFile, view: ClassView) => void, scope: ChangeScope): void {
    if (!open || !editable()) return;
    const { file } = open;
    if (file.views.length === 0) file.views.push({ name: "All", layout: "list", filter: [] });
    const view = file.views[open.view] ?? file.views[0];
    edit(file, view);
    open.view = Math.min(open.view, Math.max(file.views.length - 1, 0));
    save(scope === "rows" ? () => void reloadRows() : undefined);
    showProperties(file);
    render();
    // A field added, retyped or removed changes what the card shows.
    rowCard.refresh();
  }

  const toolbar = createClassToolbar({
    current: () => {
      const view = currentView();
      return open && view ? { file: open.file, view, editable: editable(), designing } : undefined;
    },
    layoutPanel: () =>
      createLayoutPanel({
        layout: () => currentView()?.layout ?? "list",
        setLayout: (layout) =>
          change((_file, view) => {
            view.layout = layout;
          }, "view"),
        fields: () => open?.file.fields ?? [],
        parts: () => {
          const { picture, badge } = cardParts((open?.file.fields ?? []).map(fieldAsRead), true);
          return { picture, badge };
        },
        ownTitle: true,
        card: () => open?.file.smallCard,
        arrange: (tiles) =>
          change((file) => {
            file.smallCard = tiles;
          }, "view"),
        count: () => displayed.length,
        title: (index) => displayed[index]?.title ?? "",
        content(tile, index) {
          const row = displayed[index];
          if (!row) return undefined;
          if (tile.part === "title") return buildTitle(row);
          if (tile.part === "picture") return cardPicture(row, tile.field, true);
          return tile.field && buildCell(tile.field, row, tile.size.rows > 1, true);
        },
        contextMenu: deps.contextMenu,
      }),
    keys: () => {
      const keys = new Map<string, boolean>();
      for (const row of open?.rows ?? []) {
        for (const [key, value] of Object.entries(row.properties)) {
          keys.set(key, (keys.get(key) ?? false) || Array.isArray(value));
        }
      }
      return [...keys].map(([key, list]) => ({ key, list }));
    },
    change,
    droppedFolder: (event) => {
      if (!event.dataTransfer?.types.includes(DRAGGED_ENTRY_TYPE)) return undefined;
      const dragged = readDraggedPath(event);
      if (!dragged) return undefined;
      if (event.dataTransfer.getData(DRAGGED_ENTRY_TYPE) !== "directory")
        return { refused: "Drop a folder, not a file." };
      const scope = scopeFolder();
      if (!sameRoot(parseRootedPath(scope).root, dragged.root)) {
        return { refused: "A Class reads folders in its own space or library." };
      }
      return { folder: folderValueOf(scope, formatRootedPath(dragged)) };
    },
    pickFile: (anchor, pick) => {
      const written = (path: string) => writePathFrom(classDir(), parseRootedPath(path)) ?? path;
      pickFile(deps.contextMenu, {
        files: deps.files(),
        anchor,
        ariaLabel: "Link a file to this Class",
        chosen: (path) => open?.file.links.includes(written(path)) ?? false,
        pick: (path) => pick(written(path)),
      });
    },
    // A Flow gives buttons only from the space's own, whatever root the
    // Class is in; a library's file still serves as a reference.
    droppedFile: (event) => {
      if (!event.dataTransfer?.types.includes(DRAGGED_ENTRY_TYPE)) return undefined;
      const dragged = readDraggedPath(event);
      if (!dragged) return undefined;
      if (event.dataTransfer.getData(DRAGGED_ENTRY_TYPE) === "directory")
        return { refused: "Drop a file, not a folder." };
      if (isLibraryRoot(dragged.root) && isFlowFile(dragged.path))
        return { refused: "A Class's Flows come from this space." };
      const link = writePathFrom(classDir(), dragged);
      return link ? { link } : { refused: "This Class can't name that file." };
    },
    describeLink: (link) => {
      const path = resolveFileReference(classDir(), link) ?? link;
      return {
        use: classLinkUse(path, inTemplateFolders),
        icon: entryIconAt(path, "file"),
        name: stripExtension(basenameOf(path)),
        path,
      };
    },
  });
  const resizing =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => toolbar.fitTo(frame.clientWidth));
  resizing?.observe(frame);

  // ---- Values ----

  const cellControls: CellControls = {
    // Unused: a media or path cell is drawn by the pane, from the note's
    // folder.
    media: () => document.createElement("span"),
    path: () => document.createElement("span"),
    pickColor: (anchor, value, onPick) => openColorPicker({ anchor, value, onPick }),
  };

  // Rows move when a value they're filtered, sorted or grouped by changes;
  // any other edit leaves the grid as it is, focus included.
  function shapesView(property: string): boolean {
    const view = currentView();
    if (!open || !view) return false;
    return (
      [...open.file.filter, ...view.filter].some((rule) => rule.property === property) ||
      view.sort?.property === property ||
      view.groupBy === property
    );
  }

  // A note's values are set from here. A screenplay's title page, a media
  // file and a file's own facts aren't.
  function settable(row: ClassRow, field: TableColumn): boolean {
    return row.error === undefined && !isFileField(field.id) && row.kind === "note";
  }

  // One cell writes one key of one file: the row shows the new value at
  // once, and takes back the old one if the write fails.
  function setValue(row: ClassRow, field: TableColumn, text: string): void {
    const value = frontmatterValue(field, text);
    const before = row.properties[field.id];
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    const put = (properties: Record<string, unknown>, next: unknown) => {
      if (next === undefined) Reflect.deleteProperty(properties, field.id);
      else properties[field.id] = next;
    };
    put(row.properties, value);
    const name = basenameOf(row.path);
    deps
      .editProperties(row.path, (properties) => put(properties, value))
      .then(
        () => deps.reportReadout(`Saved ${field.label} in ${name}`),
        (error: unknown) => {
          put(row.properties, before);
          if (open)
            open.notice = `Couldn't save ${field.label} in ${name}: ${error instanceof Error ? error.message : String(error)}`;
          render();
        },
      );
    if (shapesView(field.id)) render();
  }

  // A drop lands in the field's folder, read from the Class's, and its
  // value is written from the note's, as an embed in that note would be.
  function mediaFolderFor(field: TableColumn, row: ClassRow): string | undefined {
    if (!field.mediaFolder) return undefined;
    const folder = resolveMediaFolder(classDir(), field.mediaFolder);
    if (folder === undefined) return field.mediaFolder;
    const noteDir = dirnameOf(row.path);
    return writePathFrom(noteDir, parseRootedPath(folder), { folder: true });
  }

  function pills(field: TableColumn, items: string[]): HTMLElement {
    const list = document.createElement("span");
    list.className = "class-pills";
    const tags = holdsTags(field.id) ? deps.tags.known() : undefined;
    list.append(...items.map((item) => (tags ? createTagPill(item, tags) : createPill(item))));
    return list;
  }

  // A value that isn't its field's type shows as the text it is, and stays
  // until someone sets the field: a click swaps in an empty editor.
  function unfitCell(field: TableColumn, row: ClassRow, text: string, multiline = false): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "class-unfit";
    const type = FIELD_TYPES[field.type].label.toLowerCase();
    button.append(text, Object.assign(document.createElement("span"), { textContent: ` · not ${type}` }));
    button.dataset.tooltip = `Set ${field.label} to replace it`;
    button.addEventListener("click", () => {
      const editor = createCell(field, "", (next) => setValue(row, field, next), false, cellControls, {
        commit: "change",
        asHeld: true,
        multiline,
      });
      button.replaceWith(editor);
      editor.focus();
    });
    return button;
  }

  // `locked` holds a value that could otherwise be set: a card's, in Design
  // mode.
  function buildCell(defined: TableColumn, row: ClassRow, multiline = false, locked = false): HTMLElement {
    const field = fieldAsRead(defined);
    const value = cellValue(field, rowValue(row, field.id));
    const canSet = editable() && !locked && settable(row, field);
    // A list has no editor until there is a list type. Tags are a list even
    // written as one bare value, as Properties reads them.
    if (value.items) return pills(field, value.items);
    if (holdsTags(field.id) && value.text.trim() !== "") return pills(field, [value.text.trim()]);
    // An empty media value is the media field's own empty slot, as a Table's
    // is, so a card with no picture yet still reads as one.
    if (field.type === "media" && value.fits) {
      return createMediaField({
        docDir: dirnameOf(row.path),
        value: value.text,
        folder: mediaFolderFor(field, row),
        readOnly: !canSet,
        onChange: (next) => setValue(row, field, next),
        strip: field.id,
        showName: field.showName,
        openItem: media.open,
        dialog: deps.dialog,
        notify: (message) => window.alert(message),
        importFiles: mediaImportFor(deps.dialog),
      });
    }
    if (field.type === "path" && value.fits) {
      return createPathField({
        docPath: row.path,
        value: value.text,
        readOnly: !canSet,
        onChange: (next) => setValue(row, field, next),
        openPath: deps.openPath,
        notify: (message) => window.alert(message),
        contextMenu: deps.contextMenu,
      });
    }
    if (!canSet) return createFieldValue(value.fits ? field : { type: "text" }, value.text);
    if (!value.fits && field.type !== "select") return unfitCell(field, row, value.text, multiline);
    return createCell(field, value.text, (next) => setValue(row, field, next), false, cellControls, {
      commit: "change",
      asHeld: true,
      multiline,
    });
  }

  // A note whose frontmatter doesn't parse says why under its title: it has
  // no values to show, and none can be set until the block is fixed.
  function buildTitle(row: ClassRow): HTMLElement {
    const title = document.createElement("button");
    title.type = "button";
    title.className = "class-row-title";
    title.textContent = row.title;
    title.dataset.spacePath = row.path;
    const hint = pathHint(row.path, row.title);
    if (hint) title.dataset.tooltip = hint;
    onLinkClick(title, () => deps.openPath(row.path));
    if (row.error === undefined) return title;
    const cell = document.createElement("div");
    const reason = document.createElement("div");
    reason.className = "class-row-error inline-error";
    reason.textContent = `Its frontmatter doesn't parse: ${row.error}`;
    cell.append(title, reason);
    return cell;
  }

  // ---- New notes ----

  // The folder a new note goes in, never one below it, and only where its
  // root takes writes.
  function noteFolder(): string | undefined {
    if (!open || !editable()) return undefined;
    const folder = noteFolderOf(place(), open.file.filter);
    return isWritableRoot(parseRootedPath(folder).root) ? folder : undefined;
  }

  function folderLabel(folder: string): string {
    return folder === "" ? "the space's top folder" : `${folder}/`;
  }

  // The templates New note starts from: the Class's links to its space's
  // Markdown templates, in its order, as paths from the root.
  function noteTemplates(): string[] {
    if (!open) return [];
    const dir = classDir();
    return open.file.links.flatMap((link) => {
      const path = resolveFileReference(dir, link);
      return path !== undefined && classLinkUse(path, inTemplateFolders) === "template" ? [path] : [];
    });
  }

  const templateName = (path: string) => stripExtension(basenameOf(path));

  function startNote(group: string | undefined): void {
    if (!open || noteFolder() === undefined) return;
    open.drafting = { group };
    render();
    element.querySelector<HTMLInputElement>(".class-new-note-input")?.focus();
  }

  // What a new note is given so it stays in this view, said before it is
  // made: a filter's value, and the group it was started under. A file's
  // own facts are never given.
  function keepsInView(file: ClassFile, view: ClassView, group: string | undefined): string[] {
    const kept = [...file.filter, ...view.filter].flatMap((rule) =>
      !isFileField(rule.property) && (rule.test === "has" || (rule.test === "is" && rule.values.length === 1))
        ? [`${rule.property}: ${rule.values[0]}`]
        : [],
    );
    if (view.groupBy && group && !isFileField(view.groupBy)) kept.push(`${view.groupBy}: ${group}`);
    return kept;
  }

  // A taken name steps to the next free one, as a duplicate's does.
  async function createNamed(folder: string, stem: string, content: string): Promise<CreateEntryResponse> {
    for (let n = 1; ; n++) {
      try {
        return await deps.createFile(folder, n === 1 ? `${stem}.md` : `${stem} ${n}.md`, content);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409) || n >= 99) throw error;
      }
    }
  }

  // A template's copy takes the title where the template writes
  // `{{$title}}`, as New ▸ Template's does, then over its own frontmatter
  // the values that keep it in view.
  async function fromTemplate(
    template: string,
    folder: string,
    title: string,
    file: ClassFile,
    view: ClassView,
    group: string | undefined,
  ): Promise<CreateEntryResponse> {
    const created = await deps.createFromTemplate(template, folder, title);
    await deps.editProperties(created.path, (properties) => {
      const next = newNoteProperties(file, view, group, new Date(), properties);
      for (const key of Object.keys(properties)) if (!(key in next)) delete properties[key];
      Object.assign(properties, next);
    });
    return created;
  }

  // The title is kept as the note's heading and a legal file name derived
  // from it (docs/protocol.md's Entry names section).
  async function createNote(title: string, group: string | undefined): Promise<void> {
    const target = open;
    const folder = noteFolder();
    const view = currentView();
    if (!target || folder === undefined || !view) return;
    const template = target.drafting?.template ?? noteTemplates()[0];
    try {
      const created = template
        ? await fromTemplate(template, folder, title, target.file, view, group)
        : await createNamed(
            folder,
            entryNameForTitle(title) || "Untitled",
            editFrontmatter(`# ${title}\n`, newNoteProperties(target.file, view, group, new Date())),
          );
      if (open !== target) return;
      delete target.drafting;
      deps.reportReadout(`Made ${basenameOf(created.path)} in ${folderLabel(folder)}`);
      await reloadRows();
    } catch (error) {
      if (open !== target) return;
      target.drafting = { group, template, error: error instanceof Error ? error.message : String(error) };
      render();
    }
  }

  function buildNewNote(group: string | undefined): HTMLElement | undefined {
    const folder = noteFolder();
    const view = currentView();
    if (!open || folder === undefined || !view) return undefined;
    if (!open.drafting || open.drafting.group !== group) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "action-button data-table-add-row";
      add.textContent = "+ New note";
      add.addEventListener("click", () => startNote(group));
      return add;
    }
    const box = document.createElement("div");
    box.className = "class-new-note";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-input class-new-note-input";
    input.placeholder = "Title";
    input.setAttribute("aria-label", "New note's title");
    const kept = keepsInView(open.file, view, group);
    const templates = noteTemplates();
    const from = templates.length === 1 ? ` from ${templateName(templates[0])}` : "";
    const hint = document.createElement("div");
    hint.className = "caption class-new-note-hint";
    hint.textContent = kept.length
      ? `Made in ${folderLabel(folder)}${from}${from ? "," : ""} with ${kept.join(", ")}, so it stays in view.`
      : `Made in ${folderLabel(folder)}${from}.`;
    box.append(input);
    // Several templates: the note asks which, the first until another is chosen.
    const choice = document.createElement("select");
    if (templates.length > 1) {
      choice.className = "form-input class-new-note-template";
      choice.setAttribute("aria-label", "Template");
      for (const path of templates) {
        choice.appendChild(
          Object.assign(document.createElement("option"), { value: path, textContent: templateName(path) }),
        );
      }
      choice.value = open.drafting.template ?? templates[0];
      choice.addEventListener("change", () => {
        if (open?.drafting) open.drafting.template = choice.value;
      });
      box.append(choice);
    }
    box.append(hint);
    if (open.drafting.error) {
      const error = document.createElement("div");
      error.className = "inline-error class-rows-error";
      error.textContent = open.drafting.error;
      box.appendChild(error);
    }
    const cancel = () => {
      if (!open?.drafting) return;
      delete open.drafting;
      render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter" && input.value.trim()) {
        event.preventDefault();
        input.disabled = true;
        void createNote(input.value.trim(), group);
      }
    });
    // Choosing a template takes focus without leaving the draft.
    input.addEventListener("blur", (event) => {
      if ((event as FocusEvent).relatedTarget === choice) return;
      if (!input.value.trim() && !input.disabled) cancel();
    });
    return box;
  }

  // ---- A field's menu, from its column header ----

  function editOptions(field: TableColumn): void {
    void deps.dialog
      .prompt({
        title: `${field.label} options`,
        message: "Comma-separated, in the order a group shows them. Changing them rewrites no note.",
        label: "Options",
        value: (field.options ?? []).join(", "),
        submitLabel: "Save",
      })
      .then((value) => {
        if (value === null) return;
        const options = value
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean);
        change((file) => {
          const target = findField(file, field.id);
          if (target) target.options = options;
        }, "view");
      });
  }

  function editMediaFolder(field: TableColumn): void {
    void promptMediaFolder({
      dialog: deps.dialog,
      docDir: classDir(),
      current: field.mediaFolder ?? "",
      host: deps.dialogHost,
      onOpen: (handle) => {
        folderPrompt = handle;
      },
    }).then((folder) => {
      folderPrompt = undefined;
      if (folder === null) return;
      change((file) => {
        const target = findField(file, field.id);
        if (!target) return;
        if (folder) target.mediaFolder = folder;
        else delete target.mediaFolder;
      }, "view");
    });
  }

  function confirmDeleteField(field: TableColumn): void {
    void deps.dialog
      .confirm({
        title: `Delete the "${field.label}" field?`,
        message: isFileField(field.id)
          ? "This removes the field from this Class."
          : `This removes the field from this Class. Every note keeps its ${field.id} property.`,
        confirmLabel: "Delete",
        danger: true,
      })
      .then((confirmed) => {
        if (!confirmed) return;
        change((file) => {
          file.fields = file.fields.filter((each) => each.id !== field.id);
          file.card = cardWithoutField(file.card, field.id);
          file.smallCard = cardWithoutField(file.smallCard, field.id);
          for (const view of file.views) {
            if (view.fields) view.fields = view.fields.filter((key) => key !== field.id);
          }
        }, "view");
      });
  }

  function openFieldMenu(field: TableColumn, anchor: HTMLElement, label: HTMLElement): void {
    if (deps.contextMenu.isOpen(anchor)) {
      deps.contextMenu.close();
      return;
    }
    toolbar.close();
    // A file's own fact has its type from the file: only its label and where
    // it shows are the Class's.
    const typed = isFileField(field.id) ? [] : typeItems(field);
    deps.contextMenu.open({
      anchor,
      ariaLabel: `${field.label} field`,
      items: [
        {
          label: "Rename…",
          run: () =>
            startLabelRename(label, (next) =>
              change((file) => {
                const target = findField(file, field.id);
                if (target) target.label = next;
              }, "view"),
            ),
        },
        ...typed,
        {
          label: "Hide in this view",
          run: () =>
            change((file, view) => {
              view.fields = viewFields(file.fields, view)
                .map((each) => each.id)
                .filter((key) => key !== field.id);
            }, "view"),
        },
        { label: "Delete field", danger: true, run: () => confirmDeleteField(field) },
      ],
    });
  }

  // A field's type, and what only that type has.
  function typeItems(field: TableColumn): MenuItem[] {
    return [
      {
        label: "Type",
        submenu: CLASS_FIELD_TYPE_OPTIONS.map(({ value, label: typeLabel }) => ({
          label: typeLabel,
          checked: () => field.type === value,
          run: () =>
            change((file) => {
              const target = findField(file, field.id);
              if (target && target.type !== value) retypeField(target, value);
            }, "view"),
        })),
      },
      ...fieldSettingItems(field, {
        change: (edit) =>
          change((file) => {
            const target = findField(file, field.id);
            if (target) edit(target);
          }, "view"),
        dialog: deps.dialog,
        options: () => editOptions(field),
        mediaFolder: () => editMediaFolder(field),
      }),
    ];
  }

  // A header is its field's menu while the Class can change; while
  // it can't, the header is only the label.
  function buildHeader(field: TableColumn): HTMLElement {
    const canChange = editable();
    const header = createColumnHeader(field.label, canChange ? fieldAsRead(field).type : undefined);
    if (!canChange) return header.element;
    header.element.classList.add("class-field-header");
    header.element.setAttribute("role", "button");
    header.element.tabIndex = 0;
    header.element.setAttribute("aria-haspopup", "menu");
    const show = () => openFieldMenu(field, header.element, header.label);
    header.element.addEventListener("click", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      show();
    });
    header.element.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      show();
    });
    return header.element;
  }

  // ---- Arranging rows ----

  // Where a drag arranges rows: in one folder's own order, so one folder
  // without its subfolders, in a view with no sort or groups, and only while
  // the folder shows its manual order here, as a drag in the tree needs.
  function arrangedFolder(): string | undefined {
    const view = currentView();
    if (!open || !view || !editable() || view.sort || view.groupBy) return undefined;
    const folders = classFolders(place(), open.file.filter);
    if (folders.length !== 1 || folders[0].subfolders) return undefined;
    return deps.arrangement(folders[0].folder) ? folders[0].folder : undefined;
  }

  let dragged: ClassRow | undefined;
  let marked: HTMLElement | undefined;

  function mark(item: HTMLElement | undefined, after = false): void {
    marked?.classList.remove("class-drop-before", "class-drop-after");
    marked = item;
    item?.classList.add(after ? "class-drop-after" : "class-drop-before");
  }

  // A row drags by its title and lands before or after another by the half
  // it is over: above or below in the list, left or right among cards.
  function arrangeRows(
    folder: string,
    container: HTMLElement,
    items: readonly { element: HTMLElement; row: ClassRow }[],
    across: boolean,
  ): void {
    for (const { element: item, row } of items) {
      const title = item.querySelector<HTMLElement>(".class-row-title");
      if (!title) continue;
      title.draggable = true;
      title.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        dragged = row;
        event.dataTransfer.setData(CLASS_ROW_TYPE, row.path);
        event.dataTransfer.effectAllowed = "move";
      });
      title.addEventListener("dragend", () => {
        dragged = undefined;
        mark(undefined);
      });
    }
    const dropAt = (event: DragEvent) => {
      const item = dragged && items.find(({ element }) => element.contains(event.target as Node | null));
      if (!item || item.row === dragged) return undefined;
      const box = item.element.getBoundingClientRect();
      const after = across ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2;
      return { item, after };
    };
    container.addEventListener("dragover", (event) => {
      const drop = dropAt(event);
      mark(drop?.item.element, drop?.after);
      if (!drop) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    container.addEventListener("dragleave", (event) => {
      if (!container.contains(event.relatedTarget as Node | null)) mark(undefined);
    });
    container.addEventListener("drop", (event) => {
      const drop = dropAt(event);
      const moved = dragged;
      mark(undefined);
      if (!drop || !moved) return;
      event.preventDefault();
      dragged = undefined;
      void arrange(folder, moved, drop.item.row, drop.after);
    });
  }

  // The row moves among all the folder's entries, so one a view filters out
  // keeps its place. The rows are read again once the folder says it changed.
  async function arrange(folder: string, moved: ClassRow, target: ClassRow, after: boolean): Promise<void> {
    const names = deps.arrangement(folder)?.filter((name) => name !== moved.name);
    const at = names?.indexOf(target.name) ?? -1;
    if (!names || at === -1) return;
    names.splice(at + (after ? 1 : 0), 0, moved.name);
    try {
      await deps.arrange(folder, names);
    } catch (error) {
      if (!open) return;
      open.notice = `Couldn't arrange ${folderLabel(folder)}: ${error instanceof Error ? error.message : String(error)}`;
      render();
    }
  }

  // ---- Rows ----

  function buildList(fields: TableColumn[], rows: ClassRow[], folder: string | undefined): HTMLElement {
    const grid = createGridTable<ClassRow>(
      [
        rowGutterColumn<ClassRow>(openCard),
        { header: createColumnHeader("Title", undefined).element, cell: buildTitle },
        ...fields.map((field) => ({ header: buildHeader(field), cell: (row: ClassRow) => buildCell(field, row) })),
        rowSelectColumn(selection),
      ],
      (tr, row) => selection.bind(tr, row),
    );
    grid.setRows(rows);
    if (folder !== undefined) {
      const items = [...grid.table.tBodies[0].rows].map((element, index) => ({ element, row: rows[index] }));
      arrangeRows(folder, grid.table, items, false);
    }
    return grid.table;
  }

  // A media file is its own row's picture, as its tile is in a gallery: an
  // image, a video's frame, a PDF's icon. Nothing about it can be set. It
  // steps with the cards' other pictures, `strip`.
  function ownPicture(row: ClassRow, strip: string): HTMLElement {
    const dir = dirnameOf(row.path);
    return createMediaField({
      docDir: dir,
      value: writePathFrom(dir, parseRootedPath(row.path)) ?? "",
      readOnly: true,
      onChange: () => undefined,
      strip,
      openItem: media.open,
      dialog: deps.dialog,
      notify: (message) => window.alert(message),
      importFiles: mediaImportFor(deps.dialog),
    });
  }

  // A card's picture: a media file's own, beside the picture field's values
  // or with none (no field's key is empty), else the picture field's value.
  function cardPicture(row: ClassRow, picture: TableColumn | undefined, locked = false): HTMLElement | undefined {
    if (row.kind === "image" || row.kind === "video" || row.kind === "pdf") return ownPicture(row, picture?.id ?? "");
    return picture && buildCell(picture, row, false, locked);
  }

  // A Table's card, with the row's title for its title. A badge or line
  // with no value is left out.
  function buildCards(fields: TableColumn[], rows: ClassRow[], folder: string | undefined): HTMLElement {
    const { picture, badge, lines } = cardParts(fields.map(fieldAsRead), true);
    const filled = (field: TableColumn, row: ClassRow) => cellValue(field, rowValue(row, field.id)).text.trim() !== "";
    const pictureOf = (row: ClassRow) => cardPicture(row, picture);
    const arranged = open?.file.smallCard && resolveSmallCard(fields, open.file.smallCard, { picture, badge });
    const list = createCardList();
    // Offered where a Table's card offers its delete: in Edit mode alone.
    const removable = editable() && !designing;
    const items = rows.map((row) => {
      const openButton = createRowOpenButton(() => openCard(row));
      const removal = removable ? deps.removal(row.path) : undefined;
      const remove = removal && createCardRemoveButton(removal.label, removal.run);
      const card = arranged
        ? createArrangedCard(
            arranged.map(({ part, size, label, field }) => ({
              part,
              size,
              label,
              control:
                part === "title"
                  ? buildTitle(row)
                  : part === "picture"
                    ? pictureOf(row)
                    : field && buildCell(field, row),
            })),
            openButton,
            remove,
          )
        : createCard({
            picture: pictureOf(row),
            title: buildTitle(row),
            badge: badge && filled(badge, row) ? buildCell(badge, row) : undefined,
            open: openButton,
            lines: lines
              .filter((field) => filled(field, row))
              .map((field) => ({ label: field.label, control: buildCell(field, row) })),
            remove,
          });
      list.appendChild(card);
      return { element: card, row };
    });
    if (folder !== undefined) arrangeRows(folder, list, items, true);
    return list;
  }

  function buildRows(view: ClassView, fields: TableColumn[], rows: ClassRow[]): HTMLElement {
    const folder = arrangedFolder();
    return view.layout === "cards" ? buildCards(fields, rows, folder) : buildList(fields, rows, folder);
  }

  // `field` is the grouping one, which the view need not show.
  function buildGroups(
    view: ClassView,
    fields: TableColumn[],
    field: TableColumn | undefined,
    groups: RowGroup[],
  ): HTMLElement[] {
    return groups.flatMap((group) => {
      const heading = document.createElement("h3");
      heading.className = "class-group-heading";
      heading.textContent = group.value || `No ${field?.label ?? view.groupBy}`;
      const count = document.createElement("span");
      count.className = "class-group-count";
      count.textContent = String(group.rows.length);
      heading.appendChild(count);
      // A note made under a group of a file's own facts couldn't be given
      // its value, so it is made once, after them all.
      const add = view.groupBy && isFileField(view.groupBy) ? undefined : buildNewNote(group.value);
      return add ? [heading, buildRows(view, fields, group.rows), add] : [heading, buildRows(view, fields, group.rows)];
    });
  }

  // ---- Views and chips ----

  function renameView(index: number): void {
    const view = classViews(open?.file ?? { views: [] })[index];
    if (!view) return;
    void deps.dialog
      .prompt({
        title: "Rename view",
        label: "Name",
        value: viewLabel(view, index),
        submitLabel: "Rename",
        validate: (value) => (value.trim() ? undefined : "Enter a name."),
      })
      .then((value) => {
        if (value === null) return;
        change((file) => {
          const target = file.views[index];
          if (target) target.name = value.trim();
        }, "view");
      });
  }

  function openViewMenu(index: number, anchor: HTMLElement, at?: { x: number; y: number }): void {
    if (!open) return;
    const count = open.file.views.length;
    toolbar.close();
    const move = (by: number) =>
      change((file) => {
        const [moved] = file.views.splice(index, 1);
        file.views.splice(index + by, 0, moved);
        if (open) open.view = index + by;
      }, "view");
    deps.contextMenu.open({
      ...(at ? { at } : { anchor }),
      ariaLabel: "View options",
      items: [
        { label: "Rename…", run: () => renameView(index) },
        {
          label: "Layout",
          submenu: TABLE_LAYOUTS.map(({ id, label }) => ({
            label,
            checked: () => (classViews(open?.file ?? { views: [] })[index]?.layout ?? "list") === id,
            run: () =>
              change((file) => {
                const target = file.views[index];
                if (target) target.layout = id;
              }, "view"),
          })),
        },
        { label: "Move left", group: "move", disabled: () => index === 0, run: () => move(-1) },
        { label: "Move right", group: "move", disabled: () => index >= count - 1, run: () => move(1) },
        {
          label: "Delete view",
          group: "delete",
          danger: true,
          disabled: () => count === 0,
          run: () =>
            change((file) => {
              file.views.splice(index, 1);
              if (open) open.view = Math.max(0, index - 1);
            }, "view"),
        },
      ],
    });
  }

  function addView(): void {
    change((file) => {
      file.views.push({ name: `View ${file.views.length + 1}`, layout: "list", filter: [] });
      if (open) open.view = file.views.length - 1;
    }, "view");
  }

  function buildViewBar(views: ClassView[], current: number, count: number): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "class-views";
    const tabs = document.createElement("div");
    tabs.className = "class-view-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Views");
    const canChange = editable();
    views.forEach((view, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "class-view";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(index === current));
      // A Class with no views shows every row, under the name the view
      // is given once a change writes it out.
      button.textContent = open?.file.views.length === 0 ? "All" : viewLabel(view, index);
      // The tab showing opens its own menu, as a second click on it can
      // mean nothing else.
      button.addEventListener("click", () => {
        if (!open) return;
        if (open.view !== index) {
          open.view = index;
          render();
        } else if (canChange) openViewMenu(index, button);
      });
      button.addEventListener("contextmenu", (event) => {
        if (!canChange) return;
        event.preventDefault();
        openViewMenu(index, button, { x: event.clientX, y: event.clientY });
      });
      tabs.appendChild(button);
    });
    if (canChange) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "icon-button class-view-add";
      add.setAttribute("aria-label", "Add a view");
      add.appendChild(Object.assign(document.createElement("span"), { className: "class-icon class-icon-plus" }));
      add.addEventListener("click", addView);
      tabs.appendChild(add);
    }
    const counter = document.createElement("span");
    counter.className = "class-count";
    counter.textContent = countText(count, "item");
    bar.append(tabs, counter);
    return bar;
  }

  function chip(text: string, onOpen: (() => void) | undefined, onRemove: (() => void) | undefined): HTMLElement {
    const each = document.createElement("span");
    each.className = "class-chip";
    if (onOpen) {
      const label = document.createElement("button");
      label.type = "button";
      label.className = "class-chip-label";
      label.textContent = text;
      label.addEventListener("click", onOpen);
      each.appendChild(label);
    } else {
      each.appendChild(
        Object.assign(document.createElement("span"), { className: "class-chip-label", textContent: text }),
      );
    }
    if (onRemove) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button class-chip-remove";
      remove.setAttribute("aria-label", `Remove: ${text}`);
      remove.appendChild(Object.assign(document.createElement("span"), { className: "class-icon class-icon-x" }));
      remove.addEventListener("click", onRemove);
      each.appendChild(remove);
    }
    return each;
  }

  // This view's own filters and sort, each removable where it was set. The
  // Class's own filter says which notes every view starts from, and is
  // in Filter's "All views" alone.
  function buildChips(file: ClassFile, view: ClassView): HTMLElement | undefined {
    if (view.filter.length === 0 && !view.sort) return undefined;
    const canChange = editable();
    const chips = document.createElement("div");
    chips.className = "class-chips";
    view.filter.forEach((rule, index) => {
      chips.appendChild(
        chip(
          describeRule(rule, file.fields),
          canChange ? () => toolbar.openFilter() : undefined,
          canChange ? () => change((_file, target) => target.filter.splice(index, 1), "view") : undefined,
        ),
      );
    });
    if (view.sort) {
      const field = findField(file, view.sort.property)?.label ?? view.sort.property;
      const text = `Sorted by ${field}, ${view.sort.order === "desc" ? "descending" : "ascending"}`;
      chips.appendChild(
        chip(
          text,
          undefined,
          canChange
            ? () =>
                change((_file, target) => {
                  delete target.sort;
                }, "view")
            : undefined,
        ),
      );
    }
    return chips;
  }

  // The row a card shows, found again once the rows are drawn anew: the
  // same row moved by a sort keeps its controls, focus included; one read
  // again is drawn from its new read; one that left the view takes its card
  // with it, as it leaves the grid.
  function followCard(row: ClassRow, at: number): void {
    const same = displayed.indexOf(row);
    if (same !== -1) {
      rowCard.moved(same);
      return;
    }
    const again = displayed.findIndex((each) => each.path === row.path);
    if (again === -1) {
      rowCard.close(false);
      focusRowAt(element, at, selection);
      return;
    }
    rowCard.moved(again);
    rowCard.refresh();
  }

  function render(): void {
    const carded = rowCard.shown();
    const cardRow = carded === undefined ? undefined : displayed[carded];
    displayed = [];
    element.replaceChildren();
    toolbar.update();
    if (!open) return;
    const { file } = open;
    const form = document.createElement("div");
    form.className = "data-table-form";
    form.classList.toggle("is-read-only", !editable());
    element.appendChild(form);
    if (file.locked) form.appendChild(buildLockNotice(file.locked, file.version));
    if (file.locked !== "unreadable") {
      // The host already kept the rows the Class's filter does, as the
      // file on disk said; it applies here too, so a filter just tightened
      // shows before the rows are read again.
      const at = place();
      const rows = open.rows.filter((row) => matchesRules(row, file.filter, at));
      const views = classViews(file);
      const view = views[open.view] ?? views[0];
      const shown = viewRows(rows, view, at);
      displayed = shown;
      form.appendChild(buildViewBar(views, open.view, shown.length));
      const chips = buildChips(file, view);
      if (chips) form.appendChild(chips);
      if (open.notice) {
        const notice = document.createElement("div");
        notice.className = "inline-error class-rows-error";
        notice.textContent = open.notice;
        form.appendChild(notice);
      }
      if (shown.length === 0) {
        const empty = document.createElement("div");
        empty.className = "data-table-empty";
        empty.textContent = rows.length === 0 ? "This Class is empty." : "Nothing in this view.";
        form.appendChild(empty);
      } else if (view.groupBy) {
        const field = findField(file, view.groupBy);
        const groups = groupRows(shown, view.groupBy, field);
        displayed = groups.flatMap((group) => group.rows);
        form.append(...buildGroups(view, viewFields(file.fields, view), field, groups));
      } else {
        form.appendChild(buildRows(view, viewFields(file.fields, view), shown));
      }
      // A grouped view has a New note under each group, save groups of a
      // file's own facts. A draft begun under no group, before the view was
      // grouped or while it was empty, keeps its title after them all.
      const groupedByFact = view.groupBy !== undefined && isFileField(view.groupBy);
      const draftedAlone = open.drafting !== undefined && open.drafting.group === undefined;
      if (!view.groupBy || groupedByFact || shown.length === 0 || draftedAlone) {
        const add = buildNewNote(undefined);
        if (add) form.appendChild(add);
      }
    }
    // Cards tick nothing, so ticks left in a list would act unseen.
    if (currentView()?.layout === "cards") selection.clear();
    else selection.prune();
    paintTagPills(element, deps.tags);
    if (cardRow && carded !== undefined) followCard(cardRow, carded);
    deps.onRendered();
  }

  function showProperties(file: ClassFileResponse): void {
    properties.show(file.path, file.metadata, { onChange: editable() ? setMetadata : undefined });
  }

  return {
    kind: "class",
    element: frame,
    inspector: selected.section,
    properties: properties.section,
    toolbar: toolbar.element,
    toolbarAside: find.host,
    async setInput(tab, ctx, prefetched) {
      if (tab.kind !== "class") throw new Error(`the Class pane can't show a "${tab.kind}" tab`);
      const file = prefetched ?? (await deps.loadFile(tab.path));
      if (file.kind !== "class") throw new Error(`${tab.path} is not a Class`);
      readThrough = deps.writesNotified();
      const rows = file.locked === "unreadable" ? [] : await deps.loadRows(file.path);
      if (!ctx.isCurrent()) return;
      deps.noteRevision(file.path, file.revision);
      context = contextOfTab(tab);
      // The view picked stays while the same Class is shown again.
      const another = open?.file.path !== file.path;
      if (another) {
        toolbar.close();
        folderPrompt?.close();
        linkPreview.close();
        media.close(false);
        rowCard.close(false);
        selection.clear();
        designing = false;
      }
      open = { file, rows, view: another ? 0 : (open?.view ?? 0) };
      showProperties(file);
      render();
      find.show(file.path);
    },
    clearInput() {
      toolbar.close();
      folderPrompt?.close();
      linkPreview.close();
      media.close(false);
      rowCard.close(false);
      selection.clear();
      designing = false;
      find.show(undefined);
      open = undefined;
      element.replaceChildren();
      toolbar.update();
      properties.clear();
    },
    title: () => open?.file.name,
    titleHost: () => element,
    refresh: () => {
      render();
      rowCard.refresh();
      if (open) showProperties(open.file);
    },
    hasTransient: () => media.isOpen() || rowCard.isOpen() || find.isOpen(),
    dismissTransient: () => {
      if (media.isOpen()) media.close();
      else if (rowCard.isOpen()) rowCard.close();
      else find.close();
    },
    selectedFile: () => previewedFile(media.shownPath()),
    findable: () => (open ? "find" : undefined),
    design: {
      isActive: () => designing,
      toggle() {
        designing = !designing;
        rowCard.refresh();
        toolbar.update();
      },
    },
    openFind: () => find.open(),
    toolsFolded: () => toolbar.isFolded(),
    openTool: (tool) => toolbar.openTool(tool),
    dispose() {
      resizing?.disconnect();
      stopHearingSorts();
      stopHearingWrites();
      toolbar.close();
      folderPrompt?.close();
      linkPreview.dispose();
      media.dispose();
      find.dispose();
      frame.remove();
    },
  };
}
