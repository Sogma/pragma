// The editor region (docs/architecture.md, Workspace and UI ownership): its groups side by side,
// each a strip in the app header, a host for one pane, and its own chrome,
// title bar and status bar. Composed here, outside view/, because those are
// separate views that may not import one another.
//
// Which group has focus is the tab session's; a press or focus inside a
// group's frame or strip is what moves it, so a toolbar or pill in the other
// group retargets every command before its own click runs.
import { foldedRanges, unfoldEffect, unfoldAll as unfoldView } from "@codemirror/language";
import type { StateEffect } from "@codemirror/state";
import type { ProposedFileEdit } from "../src/protocol/api.ts";
import { isNamed } from "../src/protocol/entryName.ts";
import { basenameOf, dirnameOf, formatRootedPath, parseRootedPath } from "../src/protocol/rootedPath.ts";
import { isAppletFile, isMarkdownFile } from "../src/protocol/types.ts";
import { type FileResponse, putFile, type Tab } from "./core/apiClient.ts";
import type { PaneSelection } from "./core/chatContext.ts";
import { onLibraryNames } from "./core/libraries.ts";
import { displayName, extensionOf, isReadOnlyTab, OPEN_IN_NEW_TAB, pendingFileType } from "./core/paths.ts";
import * as spaceTree from "./core/spaceTree.ts";
import type { Direction } from "./core/tabHistory.ts";
import type { EditorGroup } from "./core/workspace.ts";
import * as workspace from "./core/workspace.ts";
import type { ProposalOutcome } from "./editProposal.ts";
import { PREVIEW_CLIP_MENU, PREVIEW_FILE_MENU } from "./filePreview.ts";
import { registerFlowKeys } from "./flow/flowKeys.ts";
import { CHIP_MENU, CLEAR_CHIP, chipClearOf } from "./flow/flowMenus.ts";
import type { FlowView } from "./flow/xyflowAdapter.ts";
import { GRAPH_NODE_MENU } from "./graph/graphView.ts";
import { DisposableStore, listen } from "./lib/disposable.ts";
import { flash } from "./lib/flash.ts";
import { createPlaceholder, createTitle, type NamingSurface } from "./lib/inlineEdit.ts";
import { pixelToken, wirePanelResize } from "./lib/panelResize.ts";
import { COPY_PATH } from "./lib/pathChipMenu.ts";
import { PREVIEW_OPEN_MENU } from "./notePreview.ts";
import { createScrollSync } from "./scrollSync.ts";
import type { CommandContext, CommandRegistry } from "./services/commands.ts";
import type { DialogService } from "./services/dialog.ts";
import type { EditorPane, EditorPaneRegistry, PaneGroup } from "./services/editorPanes.ts";
import type { FileNotices } from "./services/fileNotices.ts";
import type { FormatRegistry } from "./services/formats.ts";
import type { KeybindingRegistry } from "./services/keybindings.ts";
import { COMMAND_PALETTE, type MenuItem, type MenuRegistry } from "./services/menus.ts";
import { formatColumn, type Setting } from "./services/settings.ts";
import { inOneGroupOnly, type Tabs } from "./services/tabs.ts";
import { guidesMenuItem, lutsMenuItem } from "./services/videoMenu.ts";
import type { Inspector } from "./view/assistantPanel.ts";
import type { ContextMenu } from "./view/contextMenu.ts";
import { createEditorChrome, type EditorChrome, registerEditorChromeCommands } from "./view/editorChrome.ts";
import { createEditorGroupView, type EditorGroupView, tabLabel } from "./view/editorGroup.ts";
import { createEditorTitleBar } from "./view/editorTitleBar.ts";
import {
  type DocumentPane,
  type DocumentPaneKind,
  isDocumentPane,
  LINKED_FILE_MENU,
  LINKED_FROM_MENU,
  LINKED_NAME_MENU,
} from "./view/panes/documentPane.ts";
import { EMPTY_TAB_MENU } from "./view/panes/emptyPane.ts";
import { isFlowPane } from "./view/panes/flowPane.ts";
import { isGalleryPane, treeRowMenu } from "./view/panes/galleryPane.ts";
import { versionPane } from "./view/panes/versionPane.ts";
import { type AppIndicators, createStatusbar, PATH_FOLDER_MENU, type Statusbar } from "./view/statusbar.ts";
import { createTabDrag, type TabDragStrip } from "./view/tabDrag.ts";
import { installTabPreview } from "./view/tabPreview.ts";

export interface EditorAreaDeps {
  // The row the groups sit in, and the header's tab area their strips go in.
  root: HTMLElement;
  stripHost: HTMLElement;
  panes: EditorPaneRegistry;
  // Each format's actions, which the toolbar's commands run, and what draws
  // a document of its type on a tab's preview.
  formats: FormatRegistry;
  // A file as a document route reads it, for a tab's preview.
  loadFile(path: string): Promise<FileResponse>;
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  contextMenu: ContextMenu;
  dialog(): DialogService;
  // The save warning and model activity, which one group's status bar holds.
  indicators: AppIndicators;
  // What each open file has to say for itself, each status bar counting its
  // own file's, and each pane adding its own.
  notices: Pick<FileNotices, "subscribe" | "reveal" | "begin" | "add">;
  inspector: Pick<Inspector, "setPane" | "show">;
  tabs: Tabs;
  // Where the divider between two groups was left.
  split: Setting<number | undefined>;
  // Whether a name shows its extension, as a tab's rename field follows.
  showExtensions: Pick<Setting<boolean>, "get">;
}

export interface EditorArea {
  /** The tab session's outlets into a group. */
  mount(group: EditorGroup, tab: Tab, prefetched?: FileResponse): Promise<void>;
  renderStrip(group: EditorGroup): void;
  /** The focused group's mounted pane, and the typed views behind it. */
  focusedPane(): EditorPane | undefined;
  focusedDocumentPane(): DocumentPane | undefined;
  /** What the focused group's pane has selected: a document's text, or a
   * Flow's node. */
  focusedSelection(): PaneSelection;
  /** Puts the keyboard in the focused group's document, as a launch does,
   * unless something already holds it or the document is read: typing into
   * an editor hidden under reading view would change text out of sight. */
  focusDocumentIfIdle(): void;
  /** Lists every gallery on screen again: a library's files changed, which
   * nothing else on screen draws. */
  refreshGalleries(): void;
  /** Tells every pane on screen, in either group, that the space's files
   * changed: a gallery lists its folder again, a screenplay re-resolves its
   * names. */
  noteSpaceChanged(): void;
  /** Lists a gallery on screen again after a save to a note in its folder,
   * while this install sorts it by a property: the value may have moved the
   * note, and the tree, listing the folder's own order, doesn't relist. */
  noteSaved(path: string): void;
  /** Draws a proposed edit over the document it is for, in the focused group
   * when that shows it, else the other; undefined when neither does. With
   * `apply`, accepts it there at once. */
  propose(edit: ProposedFileEdit, onSettled: (outcome: ProposalOutcome) => void, apply?: boolean): number | undefined;
  /** Unfolds every open tab of one kind, notes and screenplays or Edit
   * code: the views on screen directly, every other tab through its cached
   * state. */
  unfoldAll(kind: DocumentPaneKind): void;
  /** The other group, while its active tab and `group`'s scroll as one. */
  scrollPartner(group: EditorGroup): EditorGroup | undefined;
}

/** Back and Forward in the focused tab, as commands. */
export const GO_COMMANDS: Record<Direction, string> = { back: "editor.goBack", forward: "editor.goForward" };

// A mouse's back and forward buttons, by MouseEvent.button.
const MOUSE_GO: Record<number, Direction> = { 3: "back", 4: "forward" };

// What a pill's menu acts on: a tab, by its place in its group.
interface TabTarget {
  groupId: string;
  index: number;
}

interface GroupParts {
  readonly element: HTMLElement;
  // Where the group's pane shows, under its strip and over its status bar.
  readonly host: HTMLElement;
  readonly view: EditorGroupView;
  readonly chrome: EditorChrome;
  readonly statusbar: Statusbar;
  readonly store: DisposableStore;
  // The strip as the tab drag sees it.
  readonly dragStrip: TabDragStrip;
  // What the strip was last drawn from, so a redraw that would change
  // nothing keeps its pills.
  stripShows: string | undefined;
}

// Everything a strip's pills are drawn from.
// A pill's icon and label count as well as its path: a README's icon comes
// and goes with its `pragma` key, and a library's name with a rename, under
// a path that stays the same.
function stripContent(group: EditorGroup): string {
  const tabs = group.tabs.map((tab) =>
    tab.kind === "empty" ? "empty" : `${tab.kind}:${tab.path}:${spaceTree.fileTypeAt(tab.path) ?? ""}:${tabLabel(tab)}`,
  );
  return `${group.activeTabIndex}\n${tabs.join("\n")}`;
}

/** The file a tree menu's argument names: a file row of the space's tree, a
 * site's, or a library's. Undefined for a folder or empty area, which hides
 * the item. */
// A tree row's `{ node, libraryId }`, or `{ file }`, a rooted path named
// some other way: a linked name in a screenplay, a row in Links.
function fileOf(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("file" in arg && typeof arg.file === "string") return arg.file;
  if (!("node" in arg)) return undefined;
  const { node, libraryId } = arg as { node?: { type: string; path: string } | null; libraryId?: string };
  if (node?.type !== "file") return undefined;
  return libraryId === undefined ? node.path : formatRootedPath({ root: { library: libraryId }, path: node.path });
}

// A Backlinks row's `{ file, target }`: the document the note links to.
function targetOf(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null || !("target" in arg)) return undefined;
  return typeof arg.target === "string" ? arg.target : undefined;
}

export function createEditorArea(deps: EditorAreaDeps): EditorArea {
  const { panes, tabs } = deps;
  const parts = new Map<string, GroupParts>();

  const isFocused = (group: EditorGroup) => group === workspace.focusedGroup();
  const isLive = (group: EditorGroup) => workspace.groupById(group.id) === group;
  const declaresStatusbar = (tab: Tab) => panes.get(tab.kind)?.chrome.statusbar ?? false;

  // The left group's share of the row. Kept and saved as a share, not px, so
  // a split left in one window keeps its proportions in another.
  let leftShare = deps.split.get() ?? 0.5;
  const divider = document.createElement("div");
  divider.className = "resize-handle ew editor-group-divider";
  // The divider's part in the header, between the two strips. The divider
  // can't reach up there itself: #editor clips what overflows it.
  const headerDivider = document.createElement("div");
  headerDivider.className = "resize-handle ew editor-group-header-divider";

  const shownParts = () => workspace.groups().flatMap((group) => parts.get(group.id) ?? []);
  const groupOfStrip = (strip: TabDragStrip) =>
    workspace.groups().find((group) => parts.get(group.id)?.dragStrip === strip);

  // A tab is picked up and carried across the strips in the header, and the
  // model moves it once it has landed: along its own strip, or into the
  // other one. Its pill goes with it, handed from view to view, so neither
  // strip redraws it when the model catches up.
  const tabDrag = createTabDrag({
    host: deps.stripHost,
    strips: () => shownParts().map((record) => record.dragStrip),
    onPress: (strip, index) => {
      const group = groupOfStrip(strip);
      if (group) void tabs.switchTo(group.id, index);
    },
    onDrop: ({ from, index, to, at }) => {
      const source = groupOfStrip(from);
      const target = groupOfStrip(to);
      if (!source || !target) return;
      if (source === target) {
        // Counted with the moved tab in the row, as reorder takes it.
        tabs.reorder(source.id, index, at > index ? at + 1 : at);
        return;
      }
      const { tab, pill } = partsFor(source).view.detach(index);
      partsFor(target).view.attach(tab, pill, at);
      void tabs.moveToOtherGroup(source.id, index, at);
    },
  });

  // A tab whose file isn't on screen shows it while the pointer rests on its
  // pill, in the pill's own group.
  installTabPreview(deps.stripHost, {
    loadFile: deps.loadFile,
    readingResolvers: spaceTree.readingResolvers,
    formats: deps.formats,
    dialog: deps.dialog(),
    contextMenu: deps.contextMenu,
    pathNames: spaceTree.pathNames,
    areaOf: (pill) => shownParts().find((record) => record.view.strip.contains(pill))?.host,
  });

  // The two tabs of a file that scrolls as one wear a mark; the pointer on
  // one side's mark lights the other side's tab and pane. The tab session
  // asks for the pair too: a note opened on one side opens on the other.
  let scrollPair: readonly DocumentPane[] = [];
  const inScrollPair = (group: EditorGroup) => {
    const pane = parts.get(group.id)?.view.activePane();
    return pane !== undefined && scrollPair.some((side) => side === pane);
  };
  const scrollSync = createScrollSync(
    () =>
      workspace.groups().flatMap((group) => {
        const pane = parts.get(group.id)?.view.activePane();
        return pane && isDocumentPane(pane) ? [pane] : [];
      }),
    (paired) => {
      scrollPair = paired;
      for (const { view } of parts.values()) {
        const pane = view.activePane();
        view.setScrollSynced(paired.some((side) => side === pane));
      }
    },
  );

  function layout(): void {
    const shown = shownParts();
    const shares = shown.length === 2 ? [leftShare, 1 - leftShare] : [1];
    shown.forEach((record, index) => {
      record.element.style.flexGrow = String(shares[index] ?? 1);
    });
    if (shown.length === 2) {
      shown[1].element.before(divider);
      shown[1].view.strip.before(headerDivider);
    } else {
      divider.remove();
      headerDivider.remove();
    }
    alignStrips();
  }

  // A strip can't take its group's share of its own row: the header's tab
  // area and the groups' row needn't share an edge, with a hidden assistant's
  // toggle at one end and, on macOS, the traffic lights at the other. The
  // first strip runs to where its group ends, so the second starts where its
  // group does; it may shrink, rather than push into the header's controls.
  function alignStrips(): void {
    const shown = shownParts();
    const start = deps.stripHost.getBoundingClientRect().left;
    shown.forEach((record, index) => {
      const end = index === 0 && shown.length > 1 ? record.element.getBoundingClientRect().right : undefined;
      record.view.strip.style.flex = end === undefined ? "" : `0 1 ${Math.max(0, end - start)}px`;
    });
  }
  // The tab area's own edge moves without any group resizing when the traffic
  // lights come and go with fullscreen.
  const resizes = new ResizeObserver(alignStrips);
  resizes.observe(deps.stripHost);

  // The save warning and model activity are the app's, not a file's, so one
  // bar holds them: the rightmost that shows, else the rightmost, which then
  // shows while a save is failing.
  function placeIndicators(): void {
    const shown = workspace.groups().filter((group) => parts.has(group.id));
    const holder = shown.findLast((group) => declaresStatusbar(workspace.activeTabOf(group))) ?? shown.at(-1);
    for (const group of shown) parts.get(group.id)?.statusbar.holdIndicators(group === holder);
  }

  let rowWidth = 1;
  wirePanelResize({
    handle: [divider, headerDivider],
    axis: "ew",
    minSize: pixelToken("--editor-group-min-width"),
    beginDrag: () => {
      const row = deps.root.getBoundingClientRect();
      rowWidth = row.width || 1;
      const max = row.width - pixelToken("--editor-group-min-width");
      return (moveEvent) => Math.min(max, moveEvent.clientX - row.left);
    },
    apply: (width) => {
      leftShare = Math.min(1, width / rowWidth);
      layout();
    },
    commit: () => deps.split.set(leftShare),
  });

  function createParts(group: EditorGroup): GroupParts {
    const element = document.createElement("div");
    element.className = "editor-group";
    const host = document.createElement("div");
    host.className = "editor-pane-host";
    host.id = `editor-pane-${group.id}`;
    host.setAttribute("role", "tabpanel");
    host.hidden = true;

    const chrome = createEditorChrome({
      panes,
      contextMenu: deps.contextMenu,
      titleBar: createEditorTitleBar(),
      activeTab: () => workspace.activeTabOf(group),
      activePane: () => view.activePane(),
      activeFlowView: () => flowViewOf(view.activePane()),
      readingView: () => group.readingView,
      setReadingView: (on) => tabs.setReadingView(group.id, on),
      sourceMode: () => group.sourceMode,
      setSourceMode: (on) => tabs.setSourceMode(group.id, on),
      showRuns: () => deps.inspector.show("tools"),
      announce: (text) => statusbar.announce(text),
    });
    // A bar acts on its own group. A press in it has already focused the
    // group; focusing it here too covers a click no press came before.
    const statusbar = createStatusbar(
      {
        go: (direction) => {
          tabs.focusGroup(group.id);
          void deps.commands.run(GO_COMMANDS[direction], { tab: workspace.activeTab(), pane: focusedPane() });
        },
        shortcutFor: (direction) => deps.keybindings.labelFor(GO_COMMANDS[direction]),
        showNotices: (path, level) => deps.notices.reveal(path, level),
        openFolder: (path) => {
          tabs.focusGroup(group.id);
          void tabs.openFolder(path);
        },
        contextMenu: deps.contextMenu,
      },
      deps.indicators,
    );
    const paneGroup: PaneGroup = {
      element,
      isReadingView: () => chrome.isReadingView(),
      // A read-only tab stays in reading view whatever the mode says, so
      // setting the mode for it would only turn reading view off for the
      // group's next file.
      leaveReadingView: () => {
        if (chrome.isReadingView() && !isReadOnlyTab(workspace.activeTabOf(group))) chrome.setMode("edit");
      },
      isSourceMode: () => chrome.isSourceMode(),
      rendered: () => {
        chrome.refreshTitle();
        chrome.refreshFlowRun();
      },
      setFlowRuns: (count) => chrome.setFlowRuns(count),
      showRuns: () => deps.inspector.show("tools"),
      setAddPropertyAvailable: (available) => chrome.setAddPropertyAvailable(available),
      reportWordCount: (count) => statusbar.setWordCount(count),
      reportReadout: (text) => statusbar.setReadout(text),
      announce: (text) => statusbar.announce(text),
      notices: deps.notices,
      placeChanged: () => tabs.placeChanged(),
      viewChanged: () => chrome.viewChanged(),
      openToSide: (path) => tabs.openBeside(path, group.id),
    };
    const view = createEditorGroupView({
      stripHost: deps.stripHost,
      host,
      panes,
      paneGroup,
      tabs: {
        onSwitch: (index) => void tabs.switchTo(group.id, index),
        onClose: (index) => void tabs.close(group.id, index),
        onNew: () => void tabs.openNew(group.id),
        onMenu: (index, event) =>
          deps.contextMenu.open({
            menu: "editor.tab",
            arg: { groupId: group.id, index } satisfies TabTarget,
            at: { x: event.clientX, y: event.clientY },
            ariaLabel: "Tab actions",
          }),
      },
      // What shows the pane's own sections in the inspector follows the
      // focused group's pane, not any group's.
      onPaneMounted: (pane) => {
        chrome.mountPane(pane);
        if (isFocused(group)) deps.inspector.setPane(pane);
        scrollSync.refresh();
      },
      onScrollMarkHover: (over) => {
        for (const other of parts.values()) if (other.view !== view) other.view.lightScrollPartner(over);
      },
    });
    element.append(chrome.toolbar, host, statusbar.element);
    deps.root.append(element);
    resizes.observe(element);

    const store = new DisposableStore();
    store.add(() => resizes.unobserve(element));
    store.add(statusbar);
    store.add(deps.notices.subscribe(statusbar.renderNotices));
    for (const target of [element, view.strip]) {
      store.add(listen(target, "pointerdown", () => tabs.focusGroup(group.id), { capture: true }));
      store.add(listen(target, "focusin", () => tabs.focusGroup(group.id)));
    }
    const dragStrip: TabDragStrip = {
      strip: view.strip,
      pills: () => view.pills(),
      indexOf: (pill) => view.indexOf(pill),
      settle: () => view.settle(),
    };
    return { element, host, view, chrome, statusbar, store, dragStrip, stripShows: undefined };
  }

  function partsFor(group: EditorGroup): GroupParts {
    let record = parts.get(group.id);
    if (!record) {
      record = createParts(group);
      parts.set(group.id, record);
      layout();
      placeIndicators();
    }
    return record;
  }

  function flowViewOf(pane: EditorPane | undefined): FlowView | undefined {
    return pane && isFlowPane(pane) ? pane.flowView : undefined;
  }

  function focusedPane(): EditorPane | undefined {
    return partsFor(workspace.focusedGroup()).view.activePane();
  }

  function focusedDocumentPane(): DocumentPane | undefined {
    const pane = focusedPane();
    return pane && isDocumentPane(pane) ? pane : undefined;
  }

  // Restore lands on the file's own tab, beside the version rather than over
  // it, so the version stays to compare again. An open document takes the
  // text as one edit Undo takes back; a deleted file, or a kind with no text
  // editor, is written whole and read again.
  async function restoreVersion(path: string, text: string, gone: boolean): Promise<void> {
    if (gone) await putFile(path, text, undefined, "restored");
    await tabs.openEntryBeside(path);
    const pane = focusedDocumentPane();
    if (gone || (pane?.path() === path && pane.restore(text))) return;
    await putFile(path, text, undefined, "restored");
    await tabs.reloadPath(path);
  }
  panes.register(versionPane({ restore: restoreVersion }));

  // The focused group's pane first, so a document open on both sides takes
  // a proposal where the writer is working.
  function visiblePanes(): EditorPane[] {
    const groups = [workspace.focusedGroup(), ...workspace.groups().filter((group) => !isFocused(group))];
    return groups.flatMap((group) => parts.get(group.id)?.view.activePane() ?? []);
  }

  function dropGroup(group: EditorGroup): void {
    const record = parts.get(group.id);
    if (!record) return;
    parts.delete(group.id);
    record.store.dispose();
    record.view.dispose();
    record.element.remove();
    layout();
    placeIndicators();
    scrollSync.refresh();
  }

  registerEditorChromeCommands({
    commands: deps.commands,
    keybindings: deps.keybindings,
    menus: deps.menus,
    panes,
    dialog: deps.dialog,
    focused: () => partsFor(workspace.focusedGroup()).chrome,
    activeFlowView: () => flowViewOf(focusedPane()),
    activeDocumentPane: focusedDocumentPane,
    openAppletCode: (path) => tabs.openAppletCode(path),
    runApplet: (path) => tabs.runApplet(path),
    formats: deps.formats,
    formatColumn,
  });
  registerFlowKeys(deps.commands, deps.keybindings, () => flowViewOf(focusedPane()));

  // The keyboard goes with the split: typing lands in the new view, which is
  // the group every command now acts on.
  deps.commands.register({
    id: "editor.split",
    label: "Split Editor",
    run: async () => {
      await tabs.split();
      focusedDocumentPane()?.view.focus();
    },
  });
  deps.commands.register({
    id: "editor.focusOtherGroup",
    label: "Focus Other Side",
    when: () => workspace.groups().length > 1,
    run: () => {
      const other = workspace.groups().find((group) => !isFocused(group));
      if (other) tabs.focusGroup(other.id);
    },
  });
  deps.commands.register({
    id: "editor.open",
    label: "Open",
    when: (_, arg) => fileOf(arg) !== undefined,
    run: (_, arg) => {
      const path = fileOf(arg);
      if (path !== undefined) void tabs.openSpacePath(path);
    },
  });
  deps.commands.register({
    id: "editor.openInNewTab",
    label: OPEN_IN_NEW_TAB,
    when: (_, arg) => fileOf(arg) !== undefined,
    run: (_, arg) => {
      const path = fileOf(arg);
      if (path !== undefined) void tabs.openEntryBeside(path);
    },
  });
  deps.commands.register({
    id: "editor.openToSide",
    label: "Open to the side",
    when: (_, arg) => fileOf(arg) !== undefined,
    run: (_, arg) => {
      const path = fileOf(arg);
      if (path !== undefined) void tabs.openToSide(path);
    },
  });
  // A row or link names its Applet; the toolbar's menu and the palette name
  // none, and take the focused tab while it runs one.
  const appletOf = (context: CommandContext, arg: unknown): string | undefined => {
    const path = arg === undefined ? (context.tab.kind === "applet" ? context.tab.path : undefined) : fileOf(arg);
    return path !== undefined && isAppletFile(path) ? path : undefined;
  };
  // The note or screenplay the toolbar's menu or the palette acts on, as the
  // focused group reads it or edits it, which `reading` asks: shown in the
  // other mode on the side. A read-only file is only ever read.
  const documentIn = (context: CommandContext, arg: unknown, reading: boolean): string | undefined => {
    const { tab, pane } = context;
    if (arg !== undefined || tab.kind !== "document" || isReadOnlyTab(tab)) return undefined;
    return pane && isDocumentPane(pane) && pane.isReading() === reading ? tab.path : undefined;
  };
  // The keyboard goes to whichever side edits: reading on the side leaves it
  // in the editor, and editing on the side brings it to the new editor, with
  // the cursor at the place being read.
  async function showBeside(path: string, reading: boolean): Promise<void> {
    const from = workspace.focusedGroup();
    const place = focusedDocumentPane()?.topLine();
    await tabs.openToSide(path);
    const side = workspace.focusedGroup();
    if (side === from) return;
    partsFor(side).chrome.setMode(reading ? "read" : "edit");
    if (reading) tabs.focusGroup(from.id);
    else if (place !== undefined) focusedDocumentPane()?.scrollToLine(place, true);
    focusedDocumentPane()?.view.focus();
  }
  deps.commands.register({
    id: "editor.editToSide",
    label: "Edit on the side",
    when: (context, arg) => appletOf(context, arg) !== undefined || documentIn(context, arg, true) !== undefined,
    // The keyboard goes with the code, past the closing menu handing focus back.
    run: async (context, arg) => {
      const docPath = documentIn(context, arg, true);
      if (docPath !== undefined) return showBeside(docPath, false);
      const path = appletOf(context, arg);
      if (path === undefined) return;
      await tabs.openToSide(path, { view: "code" });
      focusedDocumentPane()?.view.focus();
    },
  });
  deps.commands.register({
    id: "editor.readToSide",
    label: "Read on the side",
    when: (context, arg) => documentIn(context, arg, false) !== undefined,
    run: (context, arg) => {
      const docPath = documentIn(context, arg, false);
      return docPath === undefined ? undefined : showBeside(docPath, true);
    },
  });
  // Reveals the focused pane's row: a right-click focused that pane's group.
  deps.commands.register({
    id: "editor.showInLinks",
    label: "Show in links",
    when: (_, arg) => fileOf(arg) !== undefined && focusedDocumentPane() !== undefined,
    run: (_, arg) => {
      const path = fileOf(arg);
      const pane = focusedDocumentPane();
      if (path === undefined || !pane) return;
      deps.inspector.show("links");
      pane.revealLink(path);
      // The closing menu took focus with it; the writer goes on typing.
      pane.view.focus();
    },
  });
  // From a Links row, which is the focused pane's. Reading view has no text
  // to select, so it gives way to editing; a read-only tab never can.
  deps.commands.register({
    id: "editor.showInEditor",
    label: "Show in editor",
    when: (context, arg) =>
      fileOf(arg) !== undefined && focusedDocumentPane() !== undefined && !isReadOnlyTab(context.tab),
    run: (_, arg) => {
      const path = fileOf(arg);
      const pane = focusedDocumentPane();
      if (path === undefined || !pane) return;
      const { chrome } = partsFor(workspace.focusedGroup());
      if (chrome.isReadingView()) chrome.setMode("edit");
      pane.revealMention(path);
    },
  });
  // From a Backlinks row: the linking note opens in place of the document
  // that listed it, with its first mention of that document selected.
  deps.commands.register({
    id: "editor.showLinkingMention",
    label: "Show in editor",
    when: (_, arg) => fileOf(arg) !== undefined && targetOf(arg) !== undefined,
    run: async (_, arg) => {
      const path = fileOf(arg);
      const target = targetOf(arg);
      if (path === undefined || target === undefined) return;
      await tabs.openSpacePath(path);
      const group = workspace.focusedGroup();
      const { chrome } = partsFor(group);
      if (chrome.isReadingView() && !isReadOnlyTab(workspace.activeTabOf(group))) chrome.setMode("edit");
      focusedDocumentPane()?.revealMention(target);
    },
  });
  deps.menus.register(LINKED_FILE_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "editor.showInEditor", group: "links" },
  ]);
  deps.menus.register(LINKED_FROM_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "editor.showLinkingMention", group: "links" },
  ]);
  deps.menus.register(LINKED_NAME_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "editor.showInLinks", group: "links" },
  ]);
  deps.commands.register({
    id: CLEAR_CHIP,
    label: "Clear",
    when: (_, arg) => chipClearOf(arg) !== undefined,
    run: (_, arg) => chipClearOf(arg)?.(),
  });
  // Nothing here opens in the current tab, as a link's Open does: that
  // would put the file or folder in the Flow's place.
  deps.menus.register(CHIP_MENU, [
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "editor.editToSide", group: "open" },
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
    { command: COPY_PATH, group: "copy" },
    { command: CLEAR_CHIP, group: "clear" },
  ]);
  deps.menus.register(PREVIEW_OPEN_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
  ]);
  deps.menus.register(PREVIEW_CLIP_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    guidesMenuItem(),
    lutsMenuItem(),
    { command: "bookmarks.add", group: "bookmark" },
    { command: "bookmarks.remove", group: "bookmark" },
  ]);
  deps.menus.register(PREVIEW_FILE_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "bookmarks.add", group: "bookmark" },
    { command: "bookmarks.remove", group: "bookmark" },
  ]);
  deps.menus.register(GRAPH_NODE_MENU, [
    { command: "editor.open", group: "open" },
    { command: "editor.openInNewTab", group: "open" },
    { command: "editor.openToSide", group: "open" },
    { command: "gallery.openFolder", group: "open" },
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
  ]);
  // A click already opens the folder in place, so the menu holds the other
  // two ways; a library's top folder adds the way to its row.
  deps.menus.register(PATH_FOLDER_MENU, [
    { command: "gallery.openFolderInNewTab", group: "open" },
    { command: "gallery.openFolderToSide", group: "open" },
    { command: "library.show", group: "library" },
  ]);
  deps.keybindings.register({ key: "Mod+\\", command: "editor.split" });
  // An Applet's Edit on the side follows the chrome's Edit code with no line
  // between; a document's sits with Split Editor, the other way to a side.
  const runsApplet = (context: CommandContext) => context.tab.kind === "applet";
  const showsDocument = (context: CommandContext) => context.tab.kind === "document";
  deps.menus.register("editor.toolbar", [
    { command: "editor.editToSide", when: runsApplet },
    { command: "editor.readToSide", group: "split" },
    { command: "editor.editToSide", group: "split", when: showsDocument },
    { command: "editor.split", group: "split" },
  ]);
  deps.menus.register(COMMAND_PALETTE, [
    { command: "editor.split" },
    { command: "editor.focusOtherGroup" },
    { command: "editor.editToSide", label: "Applet: Edit on the side", when: runsApplet },
    { command: "editor.readToSide" },
    { command: "editor.editToSide", when: showsDocument },
  ]);

  // Not Alt+arrow, a browser's own: in a document CodeMirror takes it first
  // and moves the cursor, so it would never arrive here.
  for (const [direction, label, key] of [
    ["back", "Go Back", "Mod+Alt+ArrowLeft"],
    ["forward", "Go Forward", "Mod+Alt+ArrowRight"],
  ] as const) {
    const id = GO_COMMANDS[direction];
    deps.commands.register({ id, label, when: () => tabs.canGo(direction), run: () => tabs.go(direction) });
    deps.keybindings.register({ key, command: id });
    deps.menus.register(COMMAND_PALETTE, [{ command: id }]);
  }
  // The press already focused the group under the pointer. Every phase's
  // default is prevented, or a browser leaves the app for its previous page.
  for (const type of ["mousedown", "mouseup"]) {
    listen(document, type, (event) => {
      const direction = MOUSE_GO[(event as MouseEvent).button];
      if (!direction) return;
      event.preventDefault();
      if (type === "mouseup") {
        void deps.commands.run(GO_COMMANDS[direction], { tab: workspace.activeTab(), pane: focusedPane() });
      }
    });
  }

  // A gallery lists its folder from disk, and nothing watches the disk, so a
  // file added outside the app shows once the window is back in front.
  const refreshGalleries = () => {
    for (const pane of visiblePanes()) if (isGalleryPane(pane)) pane.refresh();
  };
  listen(window, "focus", refreshGalleries);
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") refreshGalleries();
  });

  // A pill's own menu acts on that tab, wherever it sits in its strip.
  const pillTab = (arg: unknown) => {
    const { groupId, index } = arg as TabTarget;
    const group = workspace.groupById(groupId);
    const tab = group?.tabs[index];
    return group && tab ? { group, tab } : undefined;
  };
  deps.commands.register({
    id: "tab.split",
    label: "Split",
    when: (_, arg) => {
      const tab = pillTab(arg)?.tab;
      return tab !== undefined && tab.kind !== "empty" && !inOneGroupOnly(tab);
    },
    run: async (_, arg) => {
      await tabs.split(arg as TabTarget);
      focusedDocumentPane()?.view.focus();
    },
  });
  deps.commands.register({
    id: "tab.moveToOtherGroup",
    label: "Move to the side",
    when: (_, arg) => {
      const pill = pillTab(arg);
      if (!pill || pill.tab.kind === "empty") return false;
      return workspace.groups().length > 1 || pill.group.tabs.length > 1;
    },
    run: (_, arg) => tabs.moveToOtherGroup((arg as TabTarget).groupId, (arg as TabTarget).index),
  });
  // A key or the palette names no pill, so Close takes the focused group's
  // active tab.
  const closeTarget = (arg: unknown): TabTarget | undefined => {
    if (arg !== undefined) return pillTab(arg) ? (arg as TabTarget) : undefined;
    const group = workspace.focusedGroup();
    return { groupId: group.id, index: group.activeTabIndex };
  };
  deps.commands.register({
    id: "tab.close",
    label: "Close",
    when: (_, arg) => closeTarget(arg) !== undefined,
    run: (_, arg) => {
      const target = closeTarget(arg);
      return target && tabs.close(target.groupId, target.index);
    },
  });
  // The strip's own +, in the focused group.
  deps.commands.register({ id: "tab.new", label: "New Tab", run: () => tabs.openNew(workspace.focusedGroup().id) });
  deps.menus.register(COMMAND_PALETTE, [{ command: "tab.close", label: "Close Tab" }, { command: "tab.new" }]);
  // A browser keeps Mod+T and Mod+W for its own tabs and never hands them to
  // the page, so only the desktop app binds them.
  if (window.pragmaElectron) {
    deps.keybindings.register({ key: "Mod+T", command: "tab.new" });
    deps.keybindings.register({ key: "Mod+W", command: "tab.close" });
  }
  deps.commands.register({
    id: "tab.closeOthers",
    label: "Close others",
    when: (_, arg) => (pillTab(arg)?.group.tabs.length ?? 0) > 1,
    run: (_, arg) => tabs.closeOthers((arg as TabTarget).groupId, (arg as TabTarget).index),
  });
  // A tab's Rename is its tree row's, the name typed in a dialog: a pill
  // can't hold a field, and the sidebar may be hidden. A root has no name of
  // its own to change.
  const renameItems = (arg: unknown): MenuItem[] => {
    const tab = arg === undefined ? undefined : pillTab(arg)?.tab;
    if (!tab || tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version") return [];
    if (!parseRootedPath(tab.path).path) return [];
    const type = tab.kind === "gallery" ? "directory" : "file";
    const entry = { name: basenameOf(tab.path), path: tab.path, type } as const;
    const row = treeRowMenu(entry, renameDialog(entry));
    return [{ command: row.menu === "tree" ? "tree.rename" : "libraryTree.rename", arg: row.arg, group: "bookmark" }];
  };
  // The name shows as the entry's row shows it, and a hidden extension goes
  // back on.
  const renameDialog = (entry: { name: string; type: "file" | "directory" }): NamingSurface => ({
    rename(_, submit) {
      const shown = displayName(entry, deps.showExtensions.get());
      const extension = shown === entry.name ? "" : extensionOf(entry.name);
      releasePill();
      void deps
        .dialog()
        .prompt({
          title: entry.type === "directory" ? "Rename folder" : "Rename file",
          value: shown,
          submitLabel: "Rename",
          validate: (value) => (value.trim() ? undefined : "Enter a name."),
        })
        .then((value) => {
          if (value !== null) submit(value + extension);
        });
    },
    // A tab's menu creates nothing.
    create: () => undefined,
  });
  // The right-click focused the pill, and a dialog hands focus back to it,
  // ringed by Chrome after the key that closed it. The text takes it before
  // the dialog opens, or with no text on screen, nothing holds it.
  const releasePill = () => {
    const pill = document.activeElement;
    if (!(pill instanceof HTMLElement) || ![...parts.values()].some((part) => part.view.strip.contains(pill))) return;
    focusedDocumentPane()?.view.focus();
    if (document.activeElement === pill) pill.blur();
  };
  deps.menus.register("editor.tab", (_, arg) => [
    { command: "tab.split", group: "group" },
    { command: "tab.moveToOtherGroup", group: "group" },
    ...renameItems(arg),
    { command: "bookmarks.add", group: "bookmark" },
    { command: "bookmarks.remove", group: "bookmark" },
    { command: "tab.close", group: "close" },
    { command: "tab.closeOthers", group: "close" },
  ]);
  // An empty tab offers the tree's document creates, made at the space's
  // top (the tree's argument for the space around its rows) and
  // opened in the tab's place. The name is typed in a dialog, as a tab's
  // Rename is: an empty tab draws no entry to type it on.
  const createDialog: NamingSurface = {
    // An empty tab renames nothing.
    rename: () => undefined,
    create(pending, submit) {
      // Nothing holds focus while the name is asked for. The dialog hands it
      // back on close: to a caret in the other group, where a press doesn't
      // focus a button, which would move the open there; or to the pressed
      // button, ringed by Chrome until the new file takes its place.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      void deps
        .dialog()
        .prompt({
          title: createTitle(pending),
          icon: { glyph: pendingFileType(pending) },
          placeholder: createPlaceholder(pending),
          submitLabel: "Create",
          validate: (value) => (value.trim() ? undefined : "Enter a name."),
        })
        .then((value) => {
          if (value !== null) submit(value);
        });
    },
  };
  const spaceTop = { node: null, naming: createDialog };
  deps.menus.register(EMPTY_TAB_MENU, [
    { command: "tree.newNote", arg: spaceTop, entryIcon: { glyph: "markdown" } },
    { command: "tree.newTable", arg: spaceTop, entryIcon: { glyph: "table" } },
    { command: "tree.newFlow", arg: spaceTop, entryIcon: { glyph: "flow" } },
    { command: "tree.newClass", arg: spaceTop, entryIcon: { glyph: "class" } },
  ]);

  // A group's chrome and status bar follow its own tab; the inspector's pane
  // sections follow the focused one.
  tabs.onActivate((group, tab) => {
    if (!isLive(group)) return;
    const record = partsFor(group);
    record.chrome.activate(tab);
    record.statusbar.setDeclared(declaresStatusbar(tab));
    record.statusbar.clearWordCount();
    placeIndicators();
  });
  tabs.onGroupClosed(dropGroup);
  // A run put the file there, not the writer, so its tab flashes
  // (architecture.md, Feedback and interaction).
  tabs.onOpenedBeside((group) => {
    if (!isLive(group)) return;
    const pill = partsFor(group).view.pills()[group.activeTabIndex];
    if (pill) flash(pill);
  });
  tabs.onHistoryChange(() => {
    for (const group of workspace.groups()) {
      const can = { back: tabs.canGo("back", group.id), forward: tabs.canGo("forward", group.id) };
      parts.get(group.id)?.statusbar.setNavigation(can);
    }
  });
  tabs.onFocus(() => {
    const record = partsFor(workspace.focusedGroup());
    deps.inspector.setPane(record.view.activePane());
    // Focus moved by a command or a closed group rather than by a press in
    // the group: a caret left in the other group would keep taking keys
    // that every command now sends here.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || record.element.contains(active)) return;
    for (const other of parts.values()) {
      if (other !== record && (other.element.contains(active) || other.view.strip.contains(active))) active.blur();
    }
  });

  for (const group of workspace.groups()) partsFor(group);

  // Redrawn only when its tabs changed: a move of focus alone has nothing
  // to draw. The status bar's path follows the list rather than activation,
  // since a move re-points a tab without activating it.
  function renderStrip(group: EditorGroup): void {
    if (!isLive(group)) return;
    const record = partsFor(group);
    const shows = stripContent(group);
    if (shows !== record.stripShows) {
      // A list changed under a drag ends it first, the carried tab back in
      // its place; a drop that landed is written to the model here.
      if (!record.view.showing(group.tabs)) tabDrag.release(record.view.strip);
      record.view.renderTabs(group.tabs, group.activeTabIndex);
    }
    record.stripShows = shows;
    record.view.strip.classList.toggle("unfocused", workspace.groups().length > 1 && !isFocused(group));
    const tab = workspace.activeTabOf(group);
    if (tab.kind !== "empty") record.statusbar.setPath(tab.path);
  }

  function noteSpaceChanged(): void {
    for (const pane of visiblePanes()) {
      if (isGalleryPane(pane)) pane.refresh();
      else if (isDocumentPane(pane)) pane.spaceChanged();
    }
    for (const group of workspace.groups()) renderStrip(group);
  }

  // A folder's place in its parent goes by its index.md's value. A sort the
  // folder keeps is the tree's to check, whose relist reaches galleries too.
  function noteSaved(path: string): void {
    if (!isMarkdownFile(path)) return;
    const folders = [dirnameOf(path)];
    if (isNamed(basenameOf(path), "index.md")) folders.push(dirnameOf(folders[0]));
    for (const pane of visiblePanes()) {
      if (!isGalleryPane(pane)) continue;
      const target = pane.sortTarget();
      if (target?.order.local?.by === "property" && folders.includes(target.path)) pane.refresh();
    }
  }
  // A library's file list lands after its document is already showing,
  // and only then do that document's links resolve.
  spaceTree.onLibraryTreeLoaded(noteSpaceChanged);
  // A renamed library keeps its paths, so its tab and its top folder's title
  // are told rather than finding out from a tab change.
  onLibraryNames(() => {
    for (const group of workspace.groups()) {
      renderStrip(group);
      partsFor(group).chrome.refreshTitle();
    }
  });

  return {
    async mount(group, tab, prefetched) {
      if (isLive(group)) await partsFor(group).view.open(tab, prefetched);
    },
    renderStrip,
    focusedPane,
    focusedDocumentPane,
    focusedSelection: () => ({
      range: focusedDocumentPane()?.selectedRange(),
      node: flowViewOf(focusedPane())?.selectedNode(),
    }),
    focusDocumentIfIdle() {
      const pane = focusedDocumentPane();
      const idle = document.activeElement === null || document.activeElement === document.body;
      if (idle && pane && !pane.isReading()) pane.view.focus();
    },
    refreshGalleries,
    noteSpaceChanged,
    noteSaved,
    scrollPartner: (group) =>
      inScrollPair(group) ? workspace.groups().find((other) => other !== group && inScrollPair(other)) : undefined,
    propose(edit, onSettled, apply) {
      for (const pane of visiblePanes()) {
        const shown = isDocumentPane(pane) ? pane.propose(edit, onSettled, apply) : undefined;
        if (shown !== undefined) return shown;
      }
      return undefined;
    },
    unfoldAll(kind) {
      for (const group of workspace.groups()) {
        const pane = parts.get(group.id)?.view.activePane();
        // The view on screen holds the live state; the tab's cached copy is
        // written back from it on the next switch.
        const live = workspace.activeTabOf(group).kind === kind && pane && isDocumentPane(pane);
        if (live) unfoldView(pane.view);
        group.tabs = group.tabs.map((tab, index) => {
          if (tab.kind !== kind || !tab.state) return tab;
          if (live && index === group.activeTabIndex) return tab;
          const folded = foldedRanges(tab.state);
          if (!folded.size) return tab;
          const effects: StateEffect<unknown>[] = [];
          folded.between(0, tab.state.doc.length, (from, to) => {
            effects.push(unfoldEffect.of({ from, to }));
          });
          return { ...tab, state: tab.state.update({ effects }).state };
        });
      }
    },
  };
}
