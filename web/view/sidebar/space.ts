// The Space view: the space tree, what only the space does to its rows
// (reorder a folder kept in manual order, folder properties, Find in
// context), and the Trash, Tags, Presets and History sections pinned under
// it. Create, rename, duplicate, drag, drop and delete are the shared tree
// actions, which this view hosts for the space.
//
// The tree knows files and folders; it does not know tabs. Opening a row,
// moving an entry (which re-points every tab on it), and what happens to
// tabs after a delete all arrive as dependencies, so this view stays
// correct whatever the editor does with the paths it hands over.
import type { FindContextResponse, SpaceInfoResponse } from "../../../src/protocol/api.ts";
import { entryNameKey, isNamed } from "../../../src/protocol/entryName.ts";
import { toSortValue } from "../../../src/protocol/folderSort.ts";
import { editFrontmatter, isPrivate, readFrontmatter } from "../../../src/protocol/frontmatter.ts";
import { PRESET_KINDS, type PresetKind, presetFolderOf } from "../../../src/protocol/presets.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryPath,
  type PathRoot,
  parseRootedPath,
} from "../../../src/protocol/rootedPath.ts";
import {
  isSettingsBlock,
  SCOPE_SETTINGS,
  type ScopeSetting,
  settingValue,
  startingSettings,
  writeSetting,
} from "../../../src/protocol/scopeSettings.ts";
import { isAgentsFile, opensScope } from "../../../src/protocol/scopes.ts";
import { setupNeedOf } from "../../../src/protocol/setupNeed.ts";
import type { TemplateEntry } from "../../../src/protocol/templates.ts";
import { isLutFile, isMarkdownFile } from "../../../src/protocol/types.ts";
import {
  fetchFile,
  fetchLibraryTree,
  fetchPragmaTemplates,
  fetchSpaceInfo,
  fetchTrash,
  postCreateEntry,
  postDeleteFromTrash,
  postEmptyTrash,
  postFindContext,
  postMoveFromTrash,
  type SpaceTreeNode,
  type TrashEntry,
} from "../../core/apiClient.ts";
import { splitDocumentProperties } from "../../core/documentContent.ts";
import { ownSortOf } from "../../core/folderOrder.ts";
import { isLibraryLocated, libraryIds, libraryName } from "../../core/libraries.ts";
import {
  displayName,
  type EntryIcon,
  entryIcon,
  fileTypeClass,
  fileTypeLabel,
  flattenTreeFilePaths,
  hasScope,
  TRASH_DRAG_TYPE,
  treeTotalsLabel,
} from "../../core/paths.ts";
import { changePresets, onPresetsChanged, presetFoldersOf, presets } from "../../core/presets.ts";
import * as spaceTree from "../../core/spaceTree.ts";
import { onWritten } from "../../core/written.ts";
import { countText, must, renderTreeIcon } from "../../lib/dom.ts";
import { createDragHold } from "../../lib/dragHold.ts";
import { Emitter } from "../../lib/emitter.ts";
import { flash } from "../../lib/flash.ts";
import { oneAtATime } from "../../lib/oneAtATime.ts";
import { createPathLabel } from "../../lib/pathLabel.ts";
import { createSectionAction, createSectionStack } from "../../lib/sectionStack.ts";
import { SPACE_ICON } from "../../lib/spaceIcon.ts";
import { toggleSettingRow } from "../../lib/toggleRow.ts";
import { LOOKS } from "../../lib/videoLut.ts";
import type { CollapsedFolders } from "../../services/collapsedFolders.ts";
import type { CommandContext, CommandRegistry } from "../../services/commands.ts";
import { contextSettingsGroups, inheritedSetting, type SettingRow } from "../../services/contextSettings.ts";
import type { DialogService } from "../../services/dialog.ts";
import { openFolderChooser } from "../../services/folderChooser.ts";
import { onFolderSortChanged, setOwnArrangement } from "../../services/folderSorts.ts";
import type { ScopeSettingWords } from "../../services/formats.ts";
import type { KeybindingRegistry } from "../../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuItem, type MenuRegistry } from "../../services/menus.ts";
import type { ModelConsole } from "../../services/modelConsole.ts";
import { createPathField } from "../../services/pathField.ts";
import {
  countPresets,
  PRAGMA_SOURCE,
  type PresetRow,
  type PresetSource,
  pragmaTemplateRows,
  presetSources,
} from "../../services/presetMenu.ts";
import type { Setting } from "../../services/settings.ts";
import * as settings from "../../services/settings.ts";
import type { SidebarView } from "../../services/sidebarViews.ts";
import { spaceChanges } from "../../services/spaceChanges.ts";
import {
  amongPresets,
  createTreeActions,
  inSpace,
  isDirectory,
  notFile,
  parentPathOf,
  type TreeActions,
  type TreeActionsDeps,
  type TreeTarget,
} from "../../services/treeActions.ts";
import type { ContextMenu } from "../contextMenu.ts";
import type { TreeRenderContext, TreeView } from "../fileTreeView.ts";
import type { ActiveRowMarker } from "../treeRows.ts";
import type { HistorySection, HistorySectionDeps } from "./history.ts";
import type { TagsSection } from "./tags.ts";

export interface SpaceViewElements {
  /** `#tree`, the panel the sidebar shell adopts. */
  panel: HTMLElement;
  /** The space switcher's button atop the tree: this view writes only its
   * name and tooltip. */
  spaceName: HTMLButtonElement;
  spaceNameLabel: HTMLSpanElement;
  nodes: HTMLDivElement;
  newFile: HTMLButtonElement;
  newFolder: HTMLButtonElement;
  refresh: HTMLButtonElement;
}

export interface SpaceViewDeps extends Pick<TreeActionsDeps, "open" | "openBeside" | "move" | "onDeleted"> {
  collapsed: CollapsedFolders;
  /** The open file's row highlight, which the tree follows into view. */
  active: Pick<ActiveRowMarker, "subscribe">;
  /** Read at use, not construction: the dialog service is built later. */
  dialog(): DialogService;
  modelConsole: Pick<ModelConsole, "logLlmCall">;
  // The tree and the History section are views themselves, so they are
  // handed in rather than imported (a view never imports a view).
  createTree: (listPath: string | (() => string)) => TreeView;
  createHistorySection: (deps: HistorySectionDeps) => HistorySection;
  // The Tags section's content, held under the tree beside the Trash.
  tagsSection: TagsSection;
  /** A document kind's words for the settings it declares in a context, by
   * the kind's name: the Context dialog's group headings and rows. */
  settingWords(kind: string): ScopeSettingWords | undefined;
  /** Edits a note's frontmatter through its open model when it has one, as
   * the Context switch does a folder's AGENTS.md. */
  editProperties(path: string, edit: (properties: Record<string, unknown>) => void): Promise<void>;
  openDirectory(path: string): void;
  /** Whether Delete offers the trash, read as each menu and confirmation
   * opens, and followed by the Trash section. */
  moveToTrash: Pick<Setting<boolean>, "get" | "subscribe">;
  openFindContextResults(dirPath: string, result: FindContextResponse): Promise<void>;
  // The tree's own commands and right-click menu are registered here, with
  // the two contributions only the app can make.
  commands: CommandRegistry;
  menus: MenuRegistry;
  contextMenu: ContextMenu;
  /** Runs as the menu opens, so an item gated on remote state reads fresh. */
  beforeMenu(): void;
  newSite(parentPath: string): void;
  /** A space with no publisher configured never sees New Site at all. */
  hasPublishers(): boolean;
  keybindings: KeybindingRegistry;
  /** Brings the Space view up, for a create or rename started away from it. */
  show(): void;
  /** The tree was redrawn; whatever mirrors it redraws too. */
  onRendered(): void;
  /** The space's contents changed, not just its drawing. */
  onChanged(): void;
}

export interface SpaceView
  extends Pick<TreeActions, "revealCreated" | "startCreate" | "startRename" | "confirmDelete" | "trash"> {
  view: SidebarView;
  /** The tree actions this view hosts for the space, which other trees
   * register with for their own roots. */
  treeActions: TreeActions;
  render(): void;
  refresh(): Promise<void>;
  /** Reads the space's name and folder for the header atop the tree, and
   * again after Manage Spaces renames it. */
  loadName(): Promise<void>;
  /** The main tree's editing context, so a rename, create or drag started
   * from another host (a site's accordion) behaves identically. */
  renderContext(): TreeRenderContext;
  hasRow(path: string): boolean;
  /** Expands every ancestor and redraws, so `path`'s row exists to be
   * highlighted; false if the tree has no such path. */
  reveal(path: string): boolean;
  /** Brings this view up with the folder at `path` open, its row in view. */
  revealFolder(path: string): void;
  /** A write just landed: redraws the tree if it moved the document within a
   * folder ordered by property, or changed an AGENTS.md's icon. */
  noteSaved(path: string, content: string): void;
  openFindContext(dirPath: string): void;
  openFolderContext(node: SpaceTreeNode, focus?: string): void;
  /** The Context dialog of the space folder at `folder`, focused on the
   * setting with this id and flashing it, as a reveal does. */
  openContext(folder: string, setting?: string): void;
}

// The Context dialog's words: what the switch is for, and what a context
// does.
const CONTEXT_DESCRIPTION =
  "A context scope keeps related work together, with cascading directives that tell Pragma which documents, data, and decisions are relevant.";
const CONTEXT_EFFECTS = [
  {
    glyph: "links",
    title: "Links",
    text: "New links between its files are relative, so they keep working wherever the folder moves.",
  },
  { glyph: "copilot", title: "Copilot", text: "The copilot keeps a separate chat for this context." },
  {
    glyph: "preferences",
    title: "Preferences",
    text: "Preferences such as guides, looks and the Save frame folder are kept separately for this context.",
  },
] as const;

function effectGlyph(glyph: string): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.dataset.effect = glyph;
  return icon;
}

function effectTitle(text: string): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "field-row-title";
  title.textContent = text;
  return title;
}

function code(text: string): HTMLElement {
  const element = document.createElement("code");
  element.textContent = text;
  return element;
}

// One line of what a context does: its glyph, its name and what it changes.
function contextEffect(icon: HTMLElement, title: HTMLElement, text: readonly (string | Node)[]): HTMLElement {
  icon.classList.add("folder-context-effect-icon");
  icon.setAttribute("aria-hidden", "true");
  const description = document.createElement("div");
  description.className = "field-row-description";
  description.append(...text);
  const words = document.createElement("div");
  words.append(title, description);
  const row = document.createElement("div");
  row.className = "folder-context-effect";
  row.append(icon, words);
  return row;
}

export function createSpaceView(elements: SpaceViewElements, deps: SpaceViewDeps): SpaceView {
  const { collapsed } = deps;

  // Read by the space tree's drops alone, apart from the rows' own drag.
  const trashDrag = createDragHold<TrashEntry>();
  let trashEntries: TrashEntry[] = [];

  const tree = deps.createTree("");
  elements.nodes.appendChild(tree.element);
  const actions = createTreeActions({
    ...deps,
    templateSources: () => presetSources("templates", pragmaRows("templates")),
  });
  actions.attach((root) => root === "space", {
    findEntry: (path) => spaceTree.findEntry(path),
    children: (path) => spaceTree.findDirectoryChildren(path),
    hasRow,
    render,
    refresh,
    bringIntoView: (path) => {
      deps.show();
      collapsed.reveal(path);
    },
    expand: (path) => collapsed.expand(path),
    listsWhole: true,
    trashName: "the Trash",
    takeDrop: takeTrashDrop,
    reorder,
    removalWarning: unpublishWarningForAll,
  });

  // The Trash, then Tags, then Presets, pinned under the tree. The Trash
  // shows while Delete moves things there or it still holds any: with
  // neither, it has nothing to list and nothing will arrive.
  const trashList = document.createElement("ul");
  trashList.className = "trash-list";
  // Its rows' hints wait their delay, as the tree's do.
  trashList.dataset.tooltipWait = "";
  const trashEmpty = document.createElement("p");
  trashEmpty.className = "stack-section-message";
  trashEmpty.textContent = "The trash is empty.";
  const trashBody = document.createElement("div");
  trashBody.append(trashEmpty, trashList);
  const emptyTrash = createSectionAction("Empty Trash", "trash", () => void confirmEmptyTrash());

  // The Presets section: each kind of preset, each source under its mark, and
  // a folder's presets drawn as the tree draws them. Its rows only open: a
  // preset is renamed, moved or made in the tree, where its folder is a
  // folder like any other.
  const presetsBody = document.createElement("div");
  presetsBody.className = "presets-section";
  const presetTrees = new Map<string, TreeView>();
  const shutKinds = settings.createSetting<string>("pragma:presets-shut", (value) => value ?? "");
  // Pragma's own templates, asked for once: they ship with the app, so they
  // never change while it runs. Until they arrive, or if they can't, the
  // space's are offered alone.
  let pragmaTemplates: readonly TemplateEntry[] = [];
  void fetchPragmaTemplates().then(
    (entries) => {
      pragmaTemplates = entries;
      renderPresets();
    },
    () => undefined,
  );
  // Earlier versions of the space's files, a deleted one's too while they last.
  const history = deps.createHistorySection({
    exists: (path) => spaceTree.findEntry(path) !== undefined,
    showExtensions: () => settings.showExtensions.get(),
    openVersion: (path, version) => void deps.open(path, { version }),
  });
  const stack = createSectionStack(elements.nodes, [
    {
      title: "Trash",
      glyph: "trash",
      body: trashBody,
      actions: [emptyTrash],
      open: settings.trashSectionOpen,
      height: settings.trashSectionHeight,
    },
    {
      title: "Tags",
      glyph: "tag",
      body: deps.tagsSection.body,
      actions: deps.tagsSection.actions,
      open: settings.tagsSectionOpen,
      height: settings.tagsSectionHeight,
      onOpen: deps.tagsSection.refresh,
    },
    {
      title: "Presets",
      glyph: "template",
      body: presetsBody,
      open: settings.presetsSectionOpen,
      height: settings.presetsSectionHeight,
      onOpen: () => renderPresets(),
    },
    {
      title: "History",
      glyph: "history",
      body: history.body,
      open: settings.historySectionOpen,
      height: settings.historySectionHeight,
      onOpen: history.refresh,
    },
  ]);
  const [trashSection, tagsSection, presetsSection, historySection] = stack.sections;
  deps.tagsSection.showCountIn(tagsSection.setCount);
  history.showCountIn(historySection.setCount);
  trashSection.header.addEventListener("contextmenu", (event) => {
    if (trashEntries.length > 0) openTrashMenu(event, null);
    else event.preventDefault();
  });
  elements.panel.append(stack.element);
  // A change made outside this window (another program, another device, an
  // agent) re-reads the tree the way the refresh button does, and so does a
  // write this window made in the space, at once: unless a read started since
  // will list it, as one does after the tree's own actions. One at a time.
  const refreshOnce = oneAtATime(refresh);
  spaceChanges.followSpace(refreshOnce);
  onWritten((paths, through) => {
    if (paths.some((path) => !isLibraryPath(path)) && !spaceTree.listingCovers(through)) refreshOnce();
  });
  onPresetsChanged(() => renderPresets());

  function hasRow(path: string): boolean {
    return tree.hasRow(path);
  }

  function renderContext(): TreeRenderContext {
    return {
      onOpen: (filePath, label) => void deps.open(filePath, { from: { anchor: label, marked: true } }),
      onOpenDirectory: (path) => deps.openDirectory(path),
      onContextMenu: openMenu,
      ...actions.editing(),
      isCollapsed: collapsed.isCollapsed,
      onToggleCollapse: collapsed.setCollapsed,
      showExtensions: settings.showExtensions.get(),
      countsFolders: true,
    };
  }

  // A preset's rows open and nothing more, in either root.
  function presetsContext(root: PathRoot, kind: PresetKind): TreeRenderContext {
    const nothing = () => undefined;
    return {
      root,
      readOnly: true,
      onOpen: (filePath, label) => void deps.open(filePath, { from: { anchor: label, marked: true } }),
      onOpenDirectory: (path) => deps.openDirectory(path),
      onContextMenu: (event, node) => {
        if (node.type !== "directory") return;
        const folder = node.path;
        const listed = presetFoldersOf(kind).find(
          (view) => view.missing === undefined && entryNameKey(view.path) === entryNameKey(folder),
        );
        folderMenu(event, folder, listed && { kind, folder: listed.path });
      },
      onDragStart: nothing,
      onDrop: nothing,
      isCollapsed: collapsed.isCollapsed,
      onToggleCollapse: collapsed.setCollapsed,
      showExtensions: settings.showExtensions.get(),
      editingPath: undefined,
      onRenameSubmit: nothing,
      onRenameCancel: nothing,
      pendingCreate: undefined,
      onCreateSubmit: nothing,
      onCreateCancel: nothing,
    };
  }

  function render(): void {
    tree.render(spaceTree.getTree(), { ...renderContext(), pinsFolders: true });
    renderPresets();
    renderTrash();
    deps.onRendered();
  }

  // ---- presets -----------------------------------------------------------

  const KIND_NAMES: Record<PresetKind, string> = { templates: "Templates", luts: "LUTs" };
  const pragmaLooks: PresetRow[] = LOOKS.map(({ lut, label }) => ({
    path: lut,
    label,
    icon: { glyph: "lut" },
    pragma: true,
  }));
  const pragmaRows = (kind: PresetKind): PresetRow[] =>
    kind === "templates" ? pragmaTemplateRows(pragmaTemplates) : pragmaLooks;
  const isShut = (kind: PresetKind) => shutKinds.get().split(",").includes(kind);
  function setShut(kind: PresetKind, shut: boolean): void {
    const others = shutKinds
      .get()
      .split(",")
      .filter((held) => held && held !== kind);
    shutKinds.set([...others, ...(shut ? [kind] : [])].join(","));
  }

  // A LUTs folder shows its LUTs, and the folders holding any.
  function lutNodes(nodes: readonly SpaceTreeNode[]): SpaceTreeNode[] {
    return nodes.flatMap((node): SpaceTreeNode[] => {
      if (node.type === "file") return isLutFile(node.name) ? [node] : [];
      const children = lutNodes(node.children ?? []);
      return children.length > 0 ? [{ ...node, children }] : [];
    });
  }

  // A library folder's presets as tree nodes, each path within the library.
  // A folder template lists nothing under it here: it is copied whole.
  function rowNode(row: PresetRow): SpaceTreeNode {
    const path = parseRootedPath(row.path).path;
    const name = basenameOf(path);
    if (row.rows) return { name, path, type: "directory", children: row.rows.map(rowNode) };
    return row.icon.glyph === "folder" ? { name, path, type: "directory", children: [] } : { name, path, type: "file" };
  }

  // What a source's tree lists: one folder's own entries, or each of its
  // folders as a row, the space's as the space tree lists them.
  function sourceNodes(kind: PresetKind, source: PresetSource): SpaceTreeNode[] {
    const found = source.folders.filter((folder) => folder.missing === undefined);
    const nodesOf = (folder: PresetSource["folders"][number]): SpaceTreeNode[] => {
      if (source.key !== "space") return folder.rows.map(rowNode);
      const children = spaceTree.findDirectoryChildren(folder.path) ?? [];
      return kind === "luts" ? lutNodes(children) : children;
    };
    if (found.length === 1) return nodesOf(found[0]);
    return found.map((folder) => {
      const path = parseRootedPath(folder.path).path;
      return { name: basenameOf(path) || folder.label, path, type: "directory", children: nodesOf(folder) };
    });
  }

  function plainRow(icon: EntryIcon, label: string, detail?: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "presets-row";
    const name = document.createElement("span");
    name.className = "presets-row-name";
    name.textContent = label;
    row.append(renderTreeIcon(icon, undefined), name);
    if (detail) {
      const note = document.createElement("span");
      note.className = "caption presets-row-detail";
      note.textContent = detail;
      row.append(note);
    }
    return row;
  }

  // A source's heading, and what it lists: its trees, drawn once attached,
  // and a row for each folder this computer can't find.
  function renderPresetSource(
    kind: PresetKind,
    source: PresetSource,
    keep: Set<string>,
    draws: (() => void)[],
  ): HTMLElement[] {
    const heading = plainRow(source.mark, source.label);
    heading.classList.add("presets-source");
    if (source.key === PRAGMA_SOURCE) {
      const flat = (rows: readonly PresetRow[]): PresetRow[] =>
        rows.flatMap((row) => (row.rows ? flat(row.rows) : [row]));
      return [heading, ...flat(source.folders[0].rows).map((row) => plainRow(row.icon, row.label))];
    }
    const shown: HTMLElement[] = [heading];
    const [only] = source.folders;
    if (source.folders.length === 1)
      heading.addEventListener("contextmenu", (event) =>
        only.missing === undefined
          ? folderMenu(event, only.path, { kind, folder: only.path })
          : removeMenu(event, kind, only.path),
      );
    for (const folder of source.folders) {
      if (folder.missing === undefined) continue;
      const row = plainRow({ glyph: "folder" }, folder.label, folder.missing);
      row.classList.add("is-missing");
      row.addEventListener("contextmenu", (event) => removeMenu(event, kind, folder.path));
      shown.push(row);
    }
    if (!source.folders.some((folder) => folder.missing === undefined)) return shown;
    const root: PathRoot = source.key === "space" ? "space" : { library: source.key.slice("lib:".length) };
    const found = source.folders.filter((folder) => folder.missing === undefined);
    const listPath = found.length === 1 ? found[0].path : source.key === "space" ? "" : source.key;
    const key = `${kind}|${source.key}|${listPath}`;
    keep.add(key);
    let view = presetTrees.get(key);
    if (!view) {
      view = deps.createTree(listPath);
      presetTrees.set(key, view);
    }
    const drawn = view;
    shown.push(drawn.element);
    draws.push(() => drawn.render(sourceNodes(kind, source), presetsContext(root, kind)));
    return shown;
  }

  function renderPresetKind(kind: PresetKind, keep: Set<string>, draws: (() => void)[]): HTMLElement {
    const block = document.createElement("div");
    block.className = "presets-kind";
    const shut = isShut(kind);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "presets-kind-toggle";
    toggle.setAttribute("aria-expanded", String(!shut));
    const chevron = document.createElement("span");
    chevron.className = "disclosure";
    toggle.append(chevron, KIND_NAMES[kind]);
    toggle.addEventListener("click", () => {
      setShut(kind, !shut);
      renderPresets();
    });
    const add = createSectionAction(`Add to ${KIND_NAMES[kind]}`, "plus", () => openAddMenu(kind, add));
    const header = document.createElement("div");
    header.className = "presets-kind-header";
    header.append(toggle, add);
    block.append(header);
    if (shut) return block;
    const sources = presetSources(kind, pragmaRows(kind));
    if (!sources.some((source) => source.key !== PRAGMA_SOURCE)) {
      const empty = document.createElement("p");
      empty.className = "stack-section-message presets-empty";
      empty.textContent = "empty";
      block.append(empty);
    }
    for (const source of sources) block.append(...renderPresetSource(kind, source, keep, draws));
    return block;
  }

  function renderPresets(): void {
    const keep = new Set<string>();
    const draws: (() => void)[] = [];
    presetsBody.replaceChildren(...PRESET_KINDS.map((kind) => renderPresetKind(kind, keep, draws)));
    for (const draw of draws) draw();
    for (const [key, view] of presetTrees) {
      if (keep.has(key)) continue;
      view.dispose();
      presetTrees.delete(key);
    }
    const count = PRESET_KINDS.reduce((total, kind) => total + countPresets(presetSources(kind)), 0);
    presetsSection.setCount(count > 0 ? count.toLocaleString() : "");
  }

  async function addPreset(kind: PresetKind, folder: string): Promise<void> {
    try {
      await changePresets({ add: kind }, folder);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Couldn't add that folder.");
    }
  }

  async function removePreset(kind: PresetKind, folder: string): Promise<void> {
    try {
      await changePresets({ remove: kind }, folder);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Couldn't remove that folder.");
    }
  }

  // A preset folder's menu: where it lives, and, for one the space lists,
  // taking it out.
  function folderMenu(event: MouseEvent, folder: string, listed?: { kind: PresetKind; folder: string }): void {
    event.preventDefault();
    const items: MenuItem[] = [
      { command: "space.reveal", group: "show" },
      { command: "library.show", group: "show" },
    ];
    if (listed)
      items.push({
        label: "Remove from Presets",
        group: "presets",
        run: () => void removePreset(listed.kind, listed.folder),
      });
    deps.contextMenu.open({ at: { x: event.clientX, y: event.clientY }, items, arg: { folder } });
  }

  function removeMenu(event: MouseEvent, kind: PresetKind, folder: string): void {
    event.preventDefault();
    deps.contextMenu.open({
      at: { x: event.clientX, y: event.clientY },
      items: [{ label: "Remove from Presets", run: () => void removePreset(kind, folder) }],
    });
  }

  // + beside a kind: a new template in the first folder the space lists for
  // them, a folder of the space chosen from its tree, or a whole library.
  function openAddMenu(kind: PresetKind, anchor: HTMLElement): void {
    const templateFolder = presetFoldersOf("templates").find((view) => !view.library && !view.missing)?.path;
    // A library listed whole, for any kind, has no folder left to add.
    const listedLibraries = new Set(
      presets().folders.flatMap((view) =>
        view.library && presetFolderOf(view.written)?.path === "" ? [view.library.id] : [],
      ),
    );
    const libraries = libraryIds().filter((id) => isLibraryLocated(id) && !listedLibraries.has(id));
    const items: MenuItem[] = [];
    if (kind === "templates" && templateFolder !== undefined) {
      items.push({ label: "New Template", group: "new", run: () => newTemplate(templateFolder) });
    }
    items.push({
      label: "Space",
      icon: true,
      entryIcon: { glyph: "space" },
      group: "roots",
      run: () => chooseFolder(kind, anchor),
    });
    for (const id of libraries) {
      items.push({
        label: libraryName(id) ?? id,
        icon: true,
        entryIcon: { glyph: "library" },
        group: "roots",
        run: () => void chooseLibraryFolder(kind, anchor, id),
      });
    }
    deps.contextMenu.open({ anchor, align: "end", items, ariaLabel: `Add to ${KIND_NAMES[kind]}` });
  }

  function newTemplate(folder: string): void {
    deps.show();
    collapsed.reveal(folder);
    actions.startCreate(folder, "file", "note");
  }

  function chooseFolder(kind: PresetKind, anchor: HTMLElement): void {
    openFolderChooser({
      anchor,
      alignTo: anchor,
      within: "",
      label: `Add a folder to ${KIND_NAMES[kind]}`,
      isOpen: (folder) => !collapsed.isCollapsed(folder),
      openFolder: (folder) => deps.openDirectory(folder),
      onPick: (folder) => void addPreset(kind, folder),
    });
  }

  // A library's folders, its top first and open, so the whole library can be
  // picked too; every path is rooted in the library, as the file lists it.
  async function chooseLibraryFolder(kind: PresetKind, anchor: HTMLElement, id: string): Promise<void> {
    let listing: SpaceTreeNode[];
    try {
      listing = await fetchLibraryTree(id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Couldn't read that library.");
      return;
    }
    const rooted = (nodes: readonly SpaceTreeNode[]): SpaceTreeNode[] =>
      nodes.map((node) => ({
        ...node,
        path: formatRootedPath({ root: { library: id }, path: node.path }),
        children: node.children && rooted(node.children),
      }));
    const top = formatRootedPath({ root: { library: id }, path: "" });
    openFolderChooser({
      anchor,
      alignTo: anchor,
      within: "",
      folders: [{ name: libraryName(id) ?? id, path: top, type: "directory", children: rooted(listing) }],
      icon: (node) => (node.path === top ? { glyph: "library" } : entryIcon(node)),
      label: `Add a folder to ${KIND_NAMES[kind]}`,
      isOpen: (folder) => folder === top,
      openFolder: (folder) => deps.openDirectory(folder),
      onPick: (folder) => void addPreset(kind, folder),
    });
  }

  async function refresh(): Promise<void> {
    await Promise.all([spaceTree.refresh(), loadTrash()]);
    // Read closed too: the headers count the tags and the files with history.
    deps.tagsSection.refresh();
    history.refresh();
    listed = true;
    render();
    describeSpace();
    revealOpenFile();
    deps.onChanged();
  }

  // The header atop the tree names the space, and its tooltip says where the
  // space is and what it holds. The tooltip waits for the first listing, or it
  // would count an empty tree, and counts the whole listing: the templates
  // folder is never a row of the tree, but it is the space's all the same.
  let info: SpaceInfoResponse | undefined;
  async function loadName(): Promise<void> {
    try {
      info = await fetchSpaceInfo();
    } catch {
      // Best-effort: the header stays blank and has no tooltip.
      return;
    }
    elements.spaceNameLabel.textContent = info.label || info.name;
    describeSpace();
  }

  function describeSpace(): void {
    if (!info || !listed) return;
    elements.spaceName.dataset.tooltip = [info.path, treeTotalsLabel(spaceTree.getTree())].filter(Boolean).join("\n");
  }

  // The open file's row, brought into view on every tab switch: its folders
  // opened, and the row scrolled to the middle when off screen. Only while
  // this view shows, so a switch made behind another view, or before the
  // first listing, waits for both; once tried, it is dropped, so a later
  // redraw never re-opens a folder folded since.
  let unrevealed: string | undefined;
  let listed = false;
  function revealOpenFile(): void {
    const path = unrevealed;
    if (path === undefined || !listed || elements.nodes.clientHeight === 0) return;
    unrevealed = undefined;
    if (spaceTree.findEntry(path) === undefined) return;
    if (collapsed.reveal(path)) render();
    tree.reveal(path);
  }
  // An entry brought up from elsewhere: its row centred and flashed, since it
  // turns up away from the click, and a folder opened too.
  //
  // The open file's reveal still waiting for this view to show is dropped,
  // or it would scroll the entry away as the view comes up.
  function revealEntry(path: string): void {
    unrevealed = undefined;
    deps.show();
    if (spaceTree.findEntry(path)?.type === "directory") collapsed.expand(path);
    collapsed.reveal(path);
    render();
    if (!tree.reveal(path)) return;
    const label = tree.element.querySelector<HTMLElement>(`.node-label[data-path="${CSS.escape(path)}"]`);
    if (label) flash(label);
  }

  // A library's file is the Libraries view's to show.
  deps.active.subscribe((path) => {
    unrevealed = path === undefined || isLibraryPath(path) ? undefined : path;
    revealOpenFile();
  });
  // A hidden view's scroller has no height, so it gaining one is this view
  // showing, however it came up: its rail button, or the sidebar reopening.
  if (typeof ResizeObserver === "function") new ResizeObserver(revealOpenFile).observe(elements.nodes);

  function collapseAll(): void {
    const folders: string[] = [];
    const walk = (nodes: SpaceTreeNode[]): void => {
      for (const node of nodes) {
        if (node.type !== "directory") continue;
        folders.push(node.path);
        walk(node.children ?? []);
      }
    };
    walk(spaceTree.getTree());
    collapsed.foldAll(folders);
    render();
  }

  // ---- drag: reorder, out of the Trash -----------------------------------

  // Only a folder whose own order is manual takes a drag's arrangement. The
  // space root has no node of its own to carry an order, so it never does.
  function showsManual(dirPath: string): boolean {
    const node = dirPath === "" ? undefined : spaceTree.findDirectoryNode(dirPath);
    return node !== undefined && ownSortOf(node).by === "manual";
  }

  async function reorderEntries(
    dragged: readonly SpaceTreeNode[],
    target: SpaceTreeNode,
    position: "before" | "after",
  ): Promise<void> {
    // The folder *containing* target — a directory sibling's own path would
    // turn "reorder next to this folder" into "move inside it".
    const parentPath = dirnameOf(target.path);
    const siblings = spaceTree.findDirectoryChildren(parentPath);
    if (!siblings) return;

    const moving = new Set(dragged.map((node) => node.path));
    const names = siblings.filter((sibling) => !moving.has(sibling.path)).map((sibling) => sibling.name);
    const targetIndex = names.indexOf(target.name);
    const insertAt = position === "before" ? targetIndex : targetIndex + 1;
    names.splice(insertAt, 0, ...dragged.map((node) => node.name));

    // Into the folder's own order, the one the tree lists: an arrangement
    // kept on this install alone would show only in its gallery.
    try {
      await setOwnArrangement(parentPath, names);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to reorder.");
    }
  }

  // Only a folder shown in manual order takes an arrangement; any other
  // ignores a before/after drop rather than switching its sort.
  function reorder(dragged: readonly SpaceTreeNode[], target: SpaceTreeNode, position: "before" | "after"): void {
    if (showsManual(dirnameOf(target.path))) void reorderEntries(dragged, target, position);
  }

  // Every sort change is a fresh listing: Set as default or a drag here
  // changes the order the tree lists, and an open gallery lists again with
  // it. A library's folders are the Libraries panel's.
  onFolderSortChanged((path) => {
    if (!isLibraryPath(path)) void refresh();
  });

  // The entries a save to `filePath` can move: the document in its folder,
  // and, for an `index.md`, the folder in its parent. A README's save can
  // also change its icon, read as the server reads it: a block that stops
  // parsing opens no scope.
  function noteSaved(filePath: string, content: string): void {
    if (!isMarkdownFile(filePath)) return;
    const { data, error } = readFrontmatter(content);
    const listed = spaceTree.findEntry(filePath);
    if (listed && opensScope(filePath, () => data) !== (listed.opensScope === true)) {
      void refresh();
      return;
    }
    if (error) return;
    const entries = isNamed(basenameOf(filePath), "index.md") ? [filePath, dirnameOf(filePath)] : [filePath];
    for (const entryPath of entries) {
      if (entryPath === "") continue;
      const folder = spaceTree.findDirectoryNode(dirnameOf(entryPath));
      const sort = folder && ownSortOf(folder);
      if (sort?.by !== "property") continue;
      const entry = folder?.children?.find((child) => child.path === entryPath);
      if (entry && toSortValue(data[sort.property]) !== entry.sortValue) {
        void refresh();
        return;
      }
    }
  }

  // A Trash row lands in the space tree and nowhere else: no other tree's
  // drop asks for one.
  //
  // The drop's own type is asked too: a Trash list redrawn mid-drag takes the
  // dragged row off the page, its dragend never reaches the document, and the
  // row would be left over for the next drag dropped on the tree.
  function takeTrashDrop(event: DragEvent, folder: string): boolean {
    if (!event.dataTransfer?.types.includes(TRASH_DRAG_TYPE)) return false;
    const trashed = trashDrag.take();
    if (!trashed) return false;
    void moveOutOfTrash(trashed, folder);
    return true;
  }
  elements.nodes.addEventListener("dragover", (event) => actions.acceptDrag(event));
  elements.nodes.addEventListener("drop", (event) => actions.dropInto(event, ""));
  elements.nodes.addEventListener("contextmenu", (event) => openMenu(event, null));
  elements.newFile.addEventListener("click", () => actions.startCreate("", "file", "note"));
  elements.newFolder.addEventListener("click", () => actions.startCreate("", "directory"));
  elements.refresh.addEventListener("click", () => void refresh());
  must<HTMLButtonElement>("#tree-collapse-all", elements.panel).addEventListener("click", collapseAll);
  deps.moveToTrash.subscribe(() => renderTrash());

  // ---- trash -------------------------------------------------------------

  async function loadTrash(): Promise<void> {
    // A trash that won't list only loses its section; the tree still draws.
    trashEntries = await fetchTrash().catch(() => []);
  }

  async function reloadTrash(): Promise<void> {
    await loadTrash();
    render();
  }

  // Not a tree move: nothing opens an entry in the trash, so no tab or model
  // has to follow it out, only the tree.
  async function moveOutOfTrash(entry: TrashEntry, dir: string): Promise<void> {
    try {
      await postMoveFromTrash(entry.name, dir);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to move out of the trash.");
      return;
    }
    collapsed.expand(dir);
    await refresh();
  }

  // Its rows open nothing and take no drop: a trashed document is never
  // edited where it sits, under a dot segment. A row drags out to the space
  // tree only. They are drawn as the tree's rows are, so they share its
  // columns.
  function renderTrash(): void {
    const count = trashEntries.length;
    trashSection.setHidden(count === 0 && !deps.moveToTrash.get());
    trashSection.setCount(count > 0 ? count.toLocaleString() : "");
    trashEmpty.hidden = count > 0;
    emptyTrash.hidden = count === 0;
    const showExtensions = settings.showExtensions.get();
    const rows: HTMLLIElement[] = [];
    for (const entry of trashEntries) {
      const row = document.createElement("li");
      row.className = entry.type === "directory" ? "tree-row file trashed-folder" : "tree-row file";
      const typeClass = entry.type === "file" ? fileTypeClass(entry.name) : undefined;
      if (typeClass) row.classList.add(typeClass);
      const entryLabel = document.createElement("span");
      entryLabel.className = "node-label";
      entryLabel.dataset.tooltip = entry.name;
      entryLabel.appendChild(
        entry.type === "directory"
          ? renderTreeIcon({ glyph: "folder" }, "Folder")
          : renderTreeIcon({ glyph: typeClass }, fileTypeLabel(typeClass)),
      );
      const entryName = document.createElement("span");
      entryName.className = "node-name";
      entryName.textContent = displayName(entry, showExtensions);
      entryLabel.appendChild(entryName);
      entryLabel.draggable = true;
      entryLabel.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(TRASH_DRAG_TYPE, entry.type);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        trashDrag.start(entry);
      });
      entryLabel.addEventListener("contextmenu", (event) => openTrashMenu(event, entry));
      row.append(entryLabel);
      rows.push(row);
    }
    trashList.replaceChildren(...rows);
  }

  function openTrashMenu(event: MouseEvent, entry: TrashEntry | null): void {
    event.preventDefault();
    event.stopPropagation();
    deps.contextMenu.open({
      menu: "trash",
      arg: { entry },
      at: { x: event.clientX, y: event.clientY },
      ariaLabel: "Trash actions",
    });
  }

  function confirmDeleteFromTrash(entry: TrashEntry): Promise<boolean> {
    return deps.dialog().confirm({
      title: `Permanently delete "${entry.name}"?`,
      message:
        entry.type === "directory"
          ? "This permanently deletes the folder and everything inside it. This cannot be undone."
          : "This permanently deletes the file. This cannot be undone.",
      confirmLabel: "Delete",
      busyLabel: "Deleting…",
      danger: true,
      failureMessage: "Failed to delete.",
      action: async () => {
        await postDeleteFromTrash(entry.name);
        await reloadTrash();
      },
    });
  }

  function confirmEmptyTrash(): Promise<boolean> {
    const count = trashEntries.length;
    return deps.dialog().confirm({
      title: "Empty Trash?",
      message: `This permanently deletes the ${countText(count, "item")} in the trash. This cannot be undone.`,
      confirmLabel: "Empty Trash",
      busyLabel: "Emptying…",
      danger: true,
      failureMessage: "Failed to empty the trash.",
      action: async () => {
        await postEmptyTrash();
        await reloadTrash();
      },
    });
  }

  // ---- the right-click menu ---------------------------------------------

  const onRow = (act: (node: SpaceTreeNode) => void) => (_: CommandContext, arg: TreeTarget) => {
    if (arg.node) act(arg.node);
  };
  const { commands, menus } = deps;
  commands.register({
    id: "tree.newSite",
    label: "New Site…",
    when: (context, arg: TreeTarget) =>
      notFile(context, arg) && inSpace(arg) && deps.hasPublishers() && !amongPresets(arg),
    run: (_, arg: TreeTarget) => deps.newSite(parentPathOf(arg.node)),
  });
  commands.register({
    id: "tree.findContext",
    label: "Find in context…",
    when: (context, arg: TreeTarget) => isDirectory(context, arg) && inSpace(arg),
    run: onRow((node) => openFindContext(node.path)),
  });
  // A folder's AGENTS.md offers its folder's Context… too. The space root's
  // never does: the space is always a context, so there is nothing to switch.
  const isFolderAgentsFile = (_: CommandContext, arg: TreeTarget) =>
    arg.node?.type === "file" && isAgentsFile(arg.node.path) && dirnameOf(arg.node.path) !== "";
  commands.register({
    id: "tree.context",
    label: "Context…",
    when: (context, arg: TreeTarget) => inSpace(arg) && (isDirectory(context, arg) || isFolderAgentsFile(context, arg)),
    run: onRow((node) => {
      const folder = node.type === "directory" ? node : spaceTree.findDirectoryNode(dirnameOf(node.path));
      if (folder) openFolderContext(folder);
    }),
  });
  // A context's AGENTS.md opens its dialog from the Properties tab, by path
  // rather than by a tree row, focused on the setting it was asked for.
  commands.register({
    id: "context.open",
    label: "Context…",
    when: (_, arg) => isContextTarget(arg),
    run: (_, arg) => {
      if (isContextTarget(arg)) openContext(arg.folder, arg.setting);
    },
  });
  // Where a file or folder named elsewhere sits in the tree: a tab's, a
  // site's or a preset folder's, as `{ file }` or `{ folder }`. A library's
  // entry is the Libraries view's to reveal, and one the tree doesn't list
  // has no row to bring up.
  const revealedEntry = (arg: unknown): string | undefined => {
    if (typeof arg !== "object" || arg === null) return undefined;
    const path = "file" in arg ? arg.file : "folder" in arg ? arg.folder : undefined;
    return typeof path === "string" && !isLibraryPath(path) && spaceTree.findEntry(path) !== undefined
      ? path
      : undefined;
  };
  commands.register({
    id: "space.reveal",
    label: "Reveal in space",
    when: (_, arg) => revealedEntry(arg) !== undefined,
    run: (_, arg) => {
      const path = revealedEntry(arg);
      if (path !== undefined) revealEntry(path);
    },
  });
  type TrashTarget = { entry: TrashEntry | null };
  commands.register({
    id: "trash.deletePermanently",
    label: "Delete Permanently",
    when: (_, arg?: TrashTarget) => Boolean(arg?.entry),
    run: (_, arg?: TrashTarget) => {
      if (arg?.entry) void confirmDeleteFromTrash(arg.entry);
    },
  });
  commands.register({
    id: "trash.empty",
    label: "Empty Trash",
    when: () => trashEntries.length > 0,
    run: () => void confirmEmptyTrash(),
  });
  menus.register("trash", [
    { command: "trash.deletePermanently", group: "delete", danger: true },
    // Only on the Trash title, so it never sits next to a single item's delete.
    {
      command: "trash.empty",
      group: "empty",
      danger: true,
      when: (_, arg) => !(arg as TrashTarget).entry,
    },
  ]);
  menus.register(COMMAND_PALETTE, [{ command: "trash.empty" }]);

  function openMenu(event: MouseEvent, node: SpaceTreeNode | null, selection?: SpaceTreeNode[]): void {
    event.preventDefault();
    deps.beforeMenu();
    deps.contextMenu.open({
      menu: selection ? "tree-selection" : "tree",
      arg: { node, selection } satisfies TreeTarget,
      at: { x: event.clientX, y: event.clientY },
      ariaLabel: "Tree actions",
    });
  }

  // ---- the node dialogs --------------------------------------------------

  // What removing `node` would unpublish, as the line its confirmation warns
  // with, or undefined when it unpublishes nothing. Cheap where it can be: a
  // synchronous site-root lookup on the loaded tree decides whether fetching
  // the file is worth it, so removing something outside any site never
  // fetches. Shared by the delete dialog and chat's Undo, so they agree.
  async function unpublishWarningFor(node: SpaceTreeNode, trash: boolean): Promise<string | undefined> {
    if (spaceTree.findSiteRoot(node.path) === undefined) return undefined;
    if (node.type === "directory") {
      return flattenTreeFilePaths(node.children ?? []).length > 0
        ? "Any already-published documents inside will also be queued to unpublish from their site."
        : undefined;
    }
    if (!isMarkdownFile(node.name)) return undefined;
    // Mirrors the server's own eligibility check (src/server/sites.ts)
    // exactly, not private and has an id, so this never promises an
    // unpublish attempt the server wouldn't make.
    try {
      const file = await fetchFile(node.path);
      if (file.kind !== "text") return undefined;
      const { properties } = splitDocumentProperties(file);
      if (!properties || isPrivate(properties) || typeof properties.id !== "string") return undefined;
      const removing = trash ? "moving it to the Trash" : "deleting it";
      return typeof properties.url === "string"
        ? `This document is published at ${properties.url}, so ${removing} will also attempt to unpublish it from its site.`
        : `This document is published, so ${removing} will also attempt to unpublish it from its site.`;
    } catch {
      return undefined; // best-effort: the confirmation goes without the line
    }
  }

  // Several entries' warning is one line, not one per published entry.
  async function unpublishWarningForAll(nodes: readonly SpaceTreeNode[], trash: boolean): Promise<string | undefined> {
    if (nodes.length === 1) return unpublishWarningFor(nodes[0], trash);
    const warned = await Promise.all(nodes.map((node) => unpublishWarningFor(node, trash)));
    if (!warned.some(Boolean)) return undefined;
    const removing = trash ? "moving them to the Trash" : "deleting them";
    return `Some of these are published, so ${removing} will also attempt to unpublish them from their sites.`;
  }

  // Find in context: a paragraph of prose
  // against one directory's markdown files; the ranked answer opens as its
  // own tab.
  function openFindContext(dirPath: string): void {
    const label = `Find in context: ${dirPath || "(space root)"}`;
    let found: FindContextResponse | undefined;
    void deps
      .dialog()
      .prompt({
        title: "Find in context",
        message: dirPath || "(space root)",
        multiline: true,
        rows: 5,
        placeholder: "Paste or describe what you're looking for…",
        submitLabel: "Search",
        busyLabel: "Searching…",
        className: "dialog-wide",
        validate: (value) => (value.trim() ? undefined : "Describe what you're looking for."),
        submit: async (value) => {
          try {
            const result = await postFindContext(dirPath, value.trim());
            if (result.model) {
              deps.modelConsole.logLlmCall(label, {
                failed: false,
                model: result.model,
                prompt: result.prompt,
                options: result.candidates.map(
                  (candidate) =>
                    `${candidate.path} (${Math.round(candidate.score * 100)}%): ${candidate.reasoning.join("; ")}`,
                ),
              });
            } else {
              deps.modelConsole.logLlmCall(label, { failed: true, message: "No markdown files in this directory." });
            }
            found = result;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Find in context failed.";
            const need = setupNeedOf(error);
            deps.modelConsole.logLlmCall(label, { failed: true, message, need });
            return { message, need };
          }
        },
      })
      .then((answer) => {
        if (answer !== null && found) void deps.openFindContextResults(dirPath, found);
      });
  }

  // The Context switch is the `pragma` key in the folder's AGENTS.md, the key
  // that opens a scope (docs/protocol.md, Scopes). It writes through the
  // document models, so an open AGENTS.md follows; never into frontmatter
  // that doesn't parse; and off removes that key, its settings with it. With
  // no AGENTS.md, on makes one.
  //
  // Turned on, a context takes each setting's start folder its folder holds,
  // written into the file, so a setting never means anything unwritten.
  function openContext(folder: string, setting?: string): void {
    const node = spaceTree.findDirectoryNode(folder);
    if (node) openFolderContext(node, setting);
  }

  function openFolderContext(node: SpaceTreeNode, focus?: string): void {
    let agents = node.children?.find((child) => child.type === "file" && isAgentsFile(child.path))?.path;
    const on = new Emitter(hasScope(node));
    let busy = false;
    // The block as the dialog last read or wrote it.
    let pragma: unknown = spaceTree.scopeBlock(node.path);
    let unreadable = false;

    // The dialog's title says what it is and the folder's path which folder,
    // its icon taking the switch's state before the tree catches up.
    const folderPath = (): HTMLElement =>
      createPathLabel(
        node.path,
        { ...spaceTree.pathNames, icon: () => ({ ...entryIcon(node), scope: on.get() }) },
        { type: "directory", standalone: true },
      );
    let shownPath = folderPath();
    const switchRow = toggleSettingRow({
      title: "Pragma context",
      shownTitle: shownPath,
      description: CONTEXT_DESCRIPTION,
      setting: {
        get: () => on.get(),
        set: (value) => {
          if (!busy) void turn(value);
        },
        subscribe: (listener) => on.subscribe(listener),
      },
    });
    const toggle = must<HTMLButtonElement>(".toggle-switch", switchRow);
    const switchCard = document.createElement("div");
    switchCard.className = "settings-card";
    switchCard.append(switchRow);
    const note = document.createElement("p");
    note.className = "settings-group-note";
    const top = document.createElement("div");
    top.className = "settings-group";
    top.append(switchCard, note);

    const settingsHost = document.createElement("div");
    settingsHost.className = "folder-context-settings";

    const effectsTitle = document.createElement("h3");
    effectsTitle.className = "section-label settings-group-title";
    effectsTitle.textContent = "What a pragma context does";
    const effectsCard = document.createElement("div");
    effectsCard.className = "settings-card";
    effectsCard.append(
      ...CONTEXT_EFFECTS.map(({ glyph, title, text }) => contextEffect(effectGlyph(glyph), effectTitle(title), [text])),
    );
    const effects = document.createElement("div");
    effects.className = "settings-group folder-context-effects";
    effects.append(effectsTitle, effectsCard);

    const error = document.createElement("div");
    error.className = "inline-error";
    error.hidden = true;
    const content = document.createElement("div");
    content.className = "dialog-body folder-context";
    content.append(top, settingsHost, effects, error);

    // The mark a context's AGENTS.md wears, in its colors whether or not the
    // switch is on: it names the dialog, and the path's icon shows the state.
    const handle = deps.dialog().open({
      title: "Pragma context",
      icon: { glyph: "scope" },
      content,
      className: "dialog-wide",
    });

    const labelOf = (setting: ScopeSetting): string =>
      (setting.kind === undefined ? undefined : deps.settingWords(setting.kind)?.keys[setting.key]?.label) ??
      setting.key;

    // The settings a context turned on here would take, written from its
    // AGENTS.md as any path is.
    const starts = () =>
      startingSettings(node.path, (path) => spaceTree.findDirectoryNode(path) !== undefined).flatMap(
        ({ setting, folder }) => {
          const written = spaceTree.writePathFrom(node.path, { root: "space", path: folder }, { folder: true });
          return written === undefined ? [] : [{ setting, written }];
        },
      );

    // What turning the context off takes with it: the settings it holds,
    // named while they are few, and counted with any key nothing declares.
    const held = (): string => {
      if (!isSettingsBlock(pragma)) return "";
      const block = pragma;
      const kinds = new Set(SCOPE_SETTINGS.flatMap((setting) => (setting.kind === undefined ? [] : [setting.kind])));
      const total = Object.entries(block).reduce(
        (count, [key, value]) => count + (kinds.has(key) && isSettingsBlock(value) ? Object.keys(value).length : 1),
        0,
      );
      const named = SCOPE_SETTINGS.filter((setting) => {
        const value = settingValue(block, setting);
        return typeof value === "string" && value.trim() !== "";
      }).map(labelOf);
      if (total === 0) return "";
      if (named.length === total && total === 1) return ` and its ${named[0]} setting`;
      if (named.length === total && total === 2) return ` and its ${named[0]} and ${named[1]} settings`;
      return ` and its ${total} settings`;
    };

    const describe = (value: boolean) => {
      const name = agents ? basenameOf(agents) : "AGENTS.md";
      const file = `${node.name}/${name}`;
      if (value) {
        note.replaceChildren("Turning it off removes the ", code("pragma"), ` key${held()} from ${file}.`);
        return;
      }
      const taken = starts();
      const parts: (string | Node)[] = ["A ", code("pragma"), ` key will be added to ${file}`];
      taken.forEach(({ setting, written }, index) => {
        parts.push(index === 0 ? ", with " : " and ", `${labelOf(setting)} set to `, code(written));
      });
      parts.push(".");
      note.replaceChildren(...parts);
    };

    function settingField(row: SettingRow): HTMLElement {
      const own = settingValue(pragma, row.setting);
      return createPathField({
        docPath: agents ?? `${node.path}/AGENTS.md`,
        value: typeof own === "string" ? own : "",
        readOnly: !on.get() || unreadable,
        onChange: (next) => void writeSettingValue(row.setting, next.trim() === "" ? undefined : next),
        openPath: (path) => void deps.open(path),
        notify: (message) => window.alert(message),
        contextMenu: deps.contextMenu,
        folders: {
          within: node.path,
          isOpen: (folder) => !collapsed.isCollapsed(folder),
          openFolder: (folder) => {
            handle.close();
            deps.openDirectory(folder);
          },
          inherited: inheritedSetting(node.path, row.setting),
        },
      });
    }

    function focusSetting(id: string, mark: boolean): void {
      const row = settingsHost.querySelector<HTMLElement>(`.field-row[data-setting="${CSS.escape(id)}"]`);
      if (!row) return;
      row.querySelector<HTMLElement>(".field-row-control :is(button, input):not(:disabled)")?.focus();
      if (mark) flash(row);
    }

    // Rebuilt for what changes every field: the switch, and the block read
    // from the file. A pick redraws only its own field, keeping focus there.
    function renderSettings(): void {
      const focused = document.activeElement?.closest<HTMLElement>(".folder-context-settings .field-row")?.dataset
        .setting;
      settingsHost.classList.toggle("is-off", !on.get());
      settingsHost.replaceChildren(
        ...contextSettingsGroups(node.path, pragma, deps.settingWords, (row) => settingField(row)),
      );
      if (focused) focusSetting(focused, false);
    }

    async function writeSettingValue(setting: ScopeSetting, value: string | undefined): Promise<void> {
      if (!agents) return;
      error.hidden = true;
      try {
        await deps.editProperties(agents, (properties) => {
          writeSetting(properties, setting, value);
          pragma = properties.pragma;
        });
        describe(on.get());
        void refresh();
      } catch (thrown) {
        error.textContent = thrown instanceof Error ? thrown.message : "Couldn't change the setting.";
        error.hidden = false;
        renderSettings();
      }
    }

    on.subscribe((value) => {
      effects.classList.toggle("is-off", !value);
      const next = folderPath();
      shownPath.replaceWith(next);
      shownPath = next;
      describe(value);
      renderSettings();
    });
    if (focus) focusSetting(focus, true);

    // An AGENTS.md whose block doesn't parse keeps its switch where it is: an
    // edit would have to rewrite text no one can read.
    if (agents) {
      const path = agents;
      void fetchFile(path)
        .then((file) => {
          if (file.kind !== "text") return;
          const read = readFrontmatter(file.content);
          if (read.error === undefined) {
            if (JSON.stringify(read.data.pragma) === JSON.stringify(pragma)) return;
            pragma = read.data.pragma;
            describe(on.get());
            renderSettings();
            return;
          }
          unreadable = true;
          toggle.disabled = true;
          note.classList.add("inline-error");
          note.textContent = `${basenameOf(path)}'s frontmatter can't be read, so this can't change here. Open ${basenameOf(path)} to fix it.`;
          renderSettings();
        })
        .catch(() => undefined);
    }

    async function turn(value: boolean): Promise<void> {
      busy = true;
      error.hidden = true;
      const taken = value ? starts() : [];
      on.set(value);
      try {
        if (agents) {
          await deps.editProperties(agents, (properties) => {
            if (!value) delete properties.pragma;
            else if (!Object.hasOwn(properties, "pragma")) {
              properties.pragma = "";
              for (const { setting, written } of taken) writeSetting(properties, setting, written);
            }
            pragma = properties.pragma;
          });
        } else {
          const data: Record<string, unknown> = { pragma: "" };
          for (const { setting, written } of taken) writeSetting(data, setting, written);
          const plain = `---\npragma: ""\n---\n\n# ${node.name}\n`;
          const created = taken.length > 0 ? editFrontmatter(plain, data) : plain;
          agents = (await postCreateEntry(node.path, "AGENTS.md", "file", created)).path;
          pragma = data.pragma;
        }
        describe(value);
        renderSettings();
        await refresh();
      } catch (thrown) {
        on.set(!value);
        error.textContent = thrown instanceof Error ? thrown.message : "Couldn't change the folder's context.";
        error.hidden = false;
      } finally {
        busy = false;
      }
    }
  }

  return {
    view: { id: "space", label: "Space", icon: SPACE_ICON, panel: elements.panel },
    treeActions: actions,
    render,
    refresh,
    loadName,
    renderContext,
    hasRow,
    reveal(path) {
      collapsed.reveal(path);
      render();
      return hasRow(path);
    },
    revealFolder: revealEntry,
    revealCreated: actions.revealCreated,
    startCreate: actions.startCreate,
    startRename: actions.startRename,
    noteSaved,
    confirmDelete: actions.confirmDelete,
    trash: actions.trash,
    openFindContext,
    openFolderContext,
    openContext,
  };
}

function isContextTarget(arg: unknown): arg is { folder: string; setting?: string } {
  return typeof arg === "object" && arg !== null && typeof (arg as { folder?: unknown }).folder === "string";
}
