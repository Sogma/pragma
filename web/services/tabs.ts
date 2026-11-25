// The tab session: which tabs are open in each editor group, which is active
// in each, which group has focus, and how a path becomes a tab — it drives
// core/workspace.ts's model, persists and restores it, and owns the race
// guard every open needs. It reaches the editor groups and tree only through
// injected functions, never by import.
//
// Activation is published *before* the pane mounts: chrome that must be torn
// down (the group's title bar) has to go before the next pane can re-mount it.

import { readTabPlace, readTabViewport } from "../../src/protocol/api.ts";
import { dirnameOf, isLibraryPath } from "../../src/protocol/rootedPath.ts";
import { documentTypeFor, hasKnownKind, isAppletFile } from "../../src/protocol/types.ts";
import type {
  FileResponse,
  FindContextResponse,
  fetchFile,
  fetchLayout,
  HistoryVersion,
  LayoutGroup,
  LayoutTab,
  postSetGroups,
  Tab,
  TabHistory,
} from "../core/apiClient.ts";
import { ensureLibraryPermissions } from "../core/libraries.ts";
import { isForeignRootTab, isReadOnlyTab, rawTabKind } from "../core/paths.ts";
import { type Direction, historyAfter, pruned, repathed, type Step, step } from "../core/tabHistory.ts";
import type { EditorGroup } from "../core/workspace.ts";
import * as workspace from "../core/workspace.ts";
import type { DocumentModel, DocumentsService } from "./documents.ts";

/** The element an open came from — a tree row, a tile, a link — which a
 * file Pragma can't open shows its menu beside. `marked` when the element
 * already says Pragma can't open it, as a tree row or a gallery tile does. */
export interface OpenSource {
  anchor: HTMLElement;
  marked?: boolean;
}

/** A view an open asks for: `code` is an Applet's Source mode. A file whose
 * kind has the view shows in it wherever the open lands; any other opens as
 * it would have. */
export type OpenView = "code";

export interface OpenOptions {
  from?: OpenSource;
  view?: OpenView;
  /** A version History kept of the file, opened beside what the group shows
   * to compare with the file's text now. */
  version?: HistoryVersion;
}

/** An open from a path, which may land in a new tab right after the current
 * one rather than in its place. */
export interface SpacePathOptions extends OpenOptions {
  beside?: boolean;
}

export interface TabsDeps {
  documents: Pick<DocumentsService, "adopt" | "release" | "get">;
  loadFile: typeof fetchFile;
  loadLayout: typeof fetchLayout;
  saveGroups: typeof postSetGroups;
  /** Writes anything still queued before the pane changes. */
  flush(): Promise<unknown>;
  /** Mounts the pane for `tab` in `group`; `prefetched` when the open
   * already holds the file, so the pane makes no second round trip. */
  mount(group: EditorGroup, tab: Tab, prefetched?: FileResponse): Promise<void>;
  renderStrip(group: EditorGroup): void;
  /** Expands and redraws the tree so `path`'s row exists to be highlighted;
   * false when the space has no such path. */
  revealInTree(path: string): boolean;
  notify(message: string): void;
  /** A file Pragma can't open, which never becomes a tab: what else it can
   * do with it shows instead. */
  openElsewhere(path: string, from?: OpenSource): void;
  /** The other group, while its active tab and `group`'s scroll as one. */
  scrollPartner?(group: EditorGroup): EditorGroup | undefined;
}

export interface Tabs {
  /** Fires when a group's active tab changes, before its pane mounts. Unlike
   * an Emitter it does not fire on subscribe: nothing is active until
   * `restore` says so. */
  onActivate(listener: (group: EditorGroup, tab: Tab) => void): () => void;
  /** Fires when the focused tab changes — an activation in the focused
   * group, or focus moving to another group. Whatever follows "the open
   * document" listens here. */
  onFocus(listener: (tab: Tab) => void): () => void;
  /** Fires when a group closes, its last tab gone, before focus moves on. */
  onGroupClosed(listener: (group: EditorGroup) => void): () => void;
  /** Fires when a run's open lands a file in a group, with that group: no
   * one moved the writer there, so whatever draws it marks where it went. */
  onOpenedBeside(listener: (group: EditorGroup) => void): () => void;
  /** The open text document's path in `groupId`, or in the focused group
   * without one; undefined for every other kind. A Source mode tab counts:
   * it is an editable file behind a CodeMirror view. */
  activePath(groupId?: string): string | undefined;
  /** The model behind the focused document tab, undefined for every other
   * kind. A Map lookup, so a per-call read costs nothing and cannot go stale
   * the way a stored copy does when a move re-points the tab. */
  activeDocument(): DocumentModel | undefined;
  /** Paths most recently shown, newest first: every tab restored at launch,
   * then each activation and focus since. Held for the session only. */
  recentPaths(): readonly string[];
  /** Gives `groupId` focus — a click inside it, say. */
  focusGroup(groupId: string): void;
  /** Puts the group in or out of reading view, saved with its tabs. */
  setReadingView(groupId: string, on: boolean): void;
  /** Puts the group in or out of Source mode, saved with its tabs. */
  setSourceMode(groupId: string, on: boolean): void;
  /** The list changed under the strips — a tab re-pointed by a move, say. */
  listChanged(): void;
  /** A pane wrote where its tab is left onto the tab: the layout saves it. */
  placeChanged(): void;
  switchTo(groupId: string, index: number): Promise<void>;
  close(groupId: string, index: number): Promise<void>;
  openNew(groupId: string): Promise<void>;
  /** Shows the focused tab — or `source`, a tab's place in its group — in
   * the other group too, opening that group if there is only one, and gives
   * it focus. A tab only one group may show stays where it is, and a new
   * group starts empty. */
  split(source?: { groupId: string; index: number }): Promise<void>;
  /** Moves a tab to the other group, opening one if there is only one, and
   * gives it focus there: at `at` among its tabs when given (a drop), else
   * beside its current one. A group left with no tab closes. */
  moveToOtherGroup(groupId: string, index: number, at?: number): Promise<void>;
  /** Closes every tab in the group but the one at `index`. */
  closeOthers(groupId: string, index: number): Promise<void>;
  /** Closes every tab in the group, as closing its last one does. */
  closeAll(groupId: string): Promise<void>;
  /** Puts the tab at `index` into slot `to` of its own strip — counting the
   * tabs as the strip showed them, the moved one included. What the group
   * shows stays as it was. */
  reorder(groupId: string, index: number, to: number): void;
  /** Opens `path` in the group beside the focused one, opening that group
   * if there is only one, and gives it focus. */
  openToSide(path: string, options?: OpenOptions): Promise<void>;
  /** Opens `path` in the group beside `groupId`, opening that group if there
   * is only one, and leaves focus where it is: what a run opens beside the
   * document or Flow it came from. A file only one group may show, open
   * behind `groupId`'s tab, moves across. Rejects, naming why, when the file
   * can't be opened. */
  openBeside(path: string, groupId: string): Promise<void>;
  /** Find in context's ranked answer, in a new tab beside the current one. The
   * results ride on the tab — one search's answer, never persisted. */
  pushFindContext(dirPath: string, result: FindContextResponse): Promise<void>;
  /** Tabs on paths that no longer exist become empty; an active one is
   * re-rendered rather than moved, since a sync isn't a place the writer
   * navigated. */
  dropGone(paths: readonly string[]): void;
  /** Re-reads `path` from disk into whatever shows it, discarding the
   * working copy — after the writer chose disk over their own unsaved edits.
   * An inactive tab of a kind that holds its copy in the pane re-reads the
   * next time it mounts. */
  reloadPath(path: string): Promise<void>;
  /** Every path an open tab holds a working copy of: each document's, and
   * the file under each group's active tab of a kind that keeps its own copy:
   * a kind only one group may show, or a running Applet. */
  openCopies(): string[];
  /** Re-points every tab at or under `from` to the same place under `to`,
   * in every group. Resolves whether any tab moved. */
  repath(from: string, to: string): boolean;
  /** After a move re-pointed tabs to `to`: a pane showing one that holds its
   * own copy of the file (a flow, table or applet) reads it again at
   * the new path, or its next save writes the old file back. A document's
   * model was re-keyed in place, so its editor and undo history stay. */
  followMove(to: string): Promise<void>;
  /** Drops every tab under a deleted entry — the entry itself, or anything
   * inside a deleted folder — and moves each group's active one somewhere
   * sensible. */
  dropDeleted(path: string): void;
  /** The one dispatcher every tree-entry open goes through — a tree click, a
   * gallery tile, a copilot reveal — so an image is handled the same way
   * from each, and a failed open is reported rather than lost. Opens into
   * the focused group. */
  openEntry(filePath: string, options?: OpenOptions): Promise<void>;
  /** The same open, into a new tab right after the current one rather than
   * in its place, so what the tab showed stays: Open in new tab and a file
   * just made both open this way. A file already open still focuses its
   * tab, and a blank current tab is replaced rather than kept beside it. */
  openEntryBeside(filePath: string, options?: OpenOptions): Promise<void>;
  /** A path that didn't come from a rendered row (a reading-view link, a
   * Pragma link): the tree is expanded to it first, and a path the space
   * doesn't hold is reported. A file under another root has no row and opens
   * directly. */
  openSpacePath(path: string, options?: SpacePathOptions): Promise<void>;
  /** A folder as a gallery. A tab already showing it is focused instead;
   * `beside` opens it in a new tab after the current one rather than in its
   * place. */
  openFolder(dirPath: string, beside?: boolean): Promise<void>;
  /** The same, in the group beside the focused one, as `openToSide` opens
   * a file. A folder may show in both groups, so nothing elsewhere is
   * focused instead. */
  openFolderToSide(dirPath: string): Promise<void>;
  /** Source mode: the running applet's tab becomes its raw source in
   * CodeMirror, an open in the focused group asking for the `code` view. */
  openAppletCode(path: string): Promise<void>;
  /** The reverse: re-fetches and mounts the running iframe. */
  runApplet(path: string): Promise<void>;
  /** Whether the active tab in `groupId`, or in the focused group without
   * one, has a place to go back or forward to. */
  canGo(direction: Direction, groupId?: string): boolean;
  /** Back or Forward in the focused tab: the place opens in its place, by
   * the same rules as any open, so one already open in another tab is
   * focused there instead. */
  go(direction: Direction): Promise<void>;
  /** Fires whenever what Back or Forward would do may have changed. */
  onHistoryChange(listener: () => void): () => void;
  /** Rebuilds the list from the saved layout, reading no file: a document
   * tab reads its own the first time it shows. Runs before the tree takes
   * clicks, so an open from it lands among the restored tabs. */
  restore(): Promise<void>;
  /** Shows each group's restored tab, unless an open or a switch got there
   * first. Must run after the tree has rendered: activation looks each tab's
   * row up to highlight it. */
  showRestored(): Promise<void>;
}

// The thin, serializable shape the layout stores — dropping the view
// state none of which survives a reload anyway.
function toLayoutTab(tab: Tab): LayoutTab {
  if (tab.kind === "empty") return { kind: "empty" };
  // One search's answer, and a version of a week's standing: neither worth keeping.
  if (tab.kind === "find-context" || tab.kind === "version") return { kind: "empty" };
  if (tab.kind === "document" && tab.place) return { kind: tab.kind, path: tab.path, place: tab.place };
  if (tab.kind === "flow" && tab.viewport) return { kind: tab.kind, path: tab.path, viewport: tab.viewport };
  return { kind: tab.kind, path: tab.path };
}

type DocumentTab = Extract<Tab, { kind: "document" }>;

// A saved group as it came back: only the tabs that could still be restored,
// with `activeTabIndex` counted among them.
interface RestoredGroup {
  tabs: Tab[];
  activeTabIndex: number;
  readingView: boolean;
  sourceMode: boolean;
  focused: boolean;
}

/** The tab kind `view` asks for, where `path`'s kind has that view. */
function viewKind(path: string, view?: OpenView): "applet-source" | undefined {
  return view === "code" && isAppletFile(path) ? "applet-source" : undefined;
}

/** Whether `path` is the entry at `from` or something that was inside it. */
function under(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

// A pane of one of these kinds keeps its own copy of the file and saves the
// whole of it, while the save queue holds one base revision per path: two
// such panes on one file would each save over the other's edits, and no
// conflict would be raised. So a file shown this way is in one group at a
// time, and opening it from the other focuses it where it is.
//
// A running Applet saves nothing, so it may run in both groups; its Edit
// code is in one.
const SINGLE_GROUP_KINDS: ReadonlySet<Tab["kind"]> = new Set(["table", "class", "flow", "applet-source"]);

/** Whether `tab` is a file only one group may show at a time. */
export function inOneGroupOnly(tab: Tab): boolean {
  return SINGLE_GROUP_KINDS.has(tab.kind);
}

const MAX_GROUPS = 2;
const MAX_RECENT = 50;

export function createTabs(deps: TabsDeps): Tabs {
  const activateListeners = new Set<(group: EditorGroup, tab: Tab) => void>();
  const focusListeners = new Set<(tab: Tab) => void>();
  const closeListeners = new Set<(group: EditorGroup) => void>();
  const besideListeners = new Set<(group: EditorGroup) => void>();
  const historyListeners = new Set<() => void>();

  // Bumped on every open into a group and re-checked after each open's own
  // awaits: two opens started moments apart can resolve in either order, and
  // without this guard the stale one would win, switching the pane back to
  // what had already been replaced.
  //
  // Per group, so an open landing in one group never cancels one still
  // loading in the other; and never current once its group has closed.
  const openTokens = new Map<string, number>();
  function nextToken(group: EditorGroup): number {
    const token = (openTokens.get(group.id) ?? 0) + 1;
    openTokens.set(group.id, token);
    return token;
  }
  const alive = (group: EditorGroup) => workspace.groupById(group.id) === group;
  const isCurrent = (group: EditorGroup, token: number) => alive(group) && openTokens.get(group.id) === token;

  const activeTabOf = workspace.activeTabOf;

  function activePath(groupId?: string): string | undefined {
    const group = groupId === undefined ? workspace.focusedGroup() : workspace.groupById(groupId);
    const tab = group && activeTabOf(group);
    return tab?.kind === "document" || tab?.kind === "applet-source" ? tab.path : undefined;
  }

  function activeDocument(): DocumentModel | undefined {
    const tab = workspace.activeTab();
    return tab.kind === "document" ? deps.documents.get(tab.path) : undefined;
  }

  // Best-effort: a failed save costs only what the next load restores.
  function saveGroups(): void {
    const groups = workspace.groups();
    const saved: LayoutGroup[] = groups.map((group) => ({
      tabs: group.tabs.map(toLayoutTab),
      activeTabIndex: group.activeTabIndex,
      readingView: group.readingView,
      sourceMode: group.sourceMode,
    }));
    void deps.saveGroups(saved, groups.indexOf(workspace.focusedGroup())).catch(() => undefined);
  }

  // The one place every mutation of a list or an active index funnels
  // through to redraw the strips, so persisting here needs no call site of
  // its own.
  function listChanged(): void {
    for (const group of workspace.groups()) deps.renderStrip(group);
    saveGroups();
    for (const listener of historyListeners) listener();
  }

  // Every tab's history, rewritten after a move or a delete: those change
  // places a tab holds without replacing the tab itself.
  function rewriteHistories(rewrite: (history: TabHistory, tab: Tab) => TabHistory): void {
    for (const group of workspace.groups()) {
      for (const tab of group.tabs) if (tab.history) tab.history = rewrite(tab.history, tab);
    }
    for (const listener of historyListeners) listener();
  }

  const recent: string[] = [];
  function remember(tab: Tab): void {
    if (tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version") return;
    const { path } = tab;
    const index = recent.indexOf(path);
    if (index !== -1) recent.splice(index, 1);
    recent.unshift(path);
    recent.length = Math.min(recent.length, MAX_RECENT);
  }

  function announce(group: EditorGroup, tab: Tab): void {
    remember(tab);
    for (const listener of activateListeners) listener(group, tab);
    if (group === workspace.focusedGroup()) for (const listener of focusListeners) listener(tab);
  }

  function announceFocus(): void {
    const tab = workspace.activeTab();
    remember(tab);
    for (const listener of focusListeners) listener(tab);
  }

  function focusGroup(groupId: string): void {
    const group = workspace.groupById(groupId);
    if (!group || group === workspace.focusedGroup()) return;
    workspace.setFocusedGroup(groupId);
    announceFocus();
    listChanged();
  }

  // A new group shows its empty tab at once, so its chrome is applied before
  // anything opens into it — an open that fails still leaves a sane group.
  async function addGroup(): Promise<EditorGroup> {
    const group = workspace.addGroup();
    await renderActive(group);
    return group;
  }

  // Focus leaving with the group lands on its neighbour, and is announced
  // like any other move, or what follows the focus keeps the closed tab.
  function removeGroup(group: EditorGroup): void {
    const hadFocus = group === workspace.focusedGroup();
    openTokens.delete(group.id);
    workspace.removeGroup(group.id);
    for (const listener of closeListeners) listener(group);
    if (hadFocus) announceFocus();
    listChanged();
  }

  // The group beside `group`, opened if there is none: with at most two, the
  // other group is always the side.
  async function sideGroupOf(group: EditorGroup): Promise<EditorGroup> {
    return workspace.groups().find((other) => other !== group) ?? addGroup();
  }

  // Opens `tab` as `group`'s *current* tab — replacing whatever is at its
  // active index in place, or creating the very first tab if none exists
  // yet. This is what a tree click means (docs/architecture.md, Files and views): it
  // never creates a tab of its own; only "+" does. The tab being replaced is
  // discarded outright, and a document's model reference goes with it.
  //
  // `beside` is for the opens that add a tab rather than replace one: the
  // new tab goes right after the current one, which is left as it was.
  //
  // A replacement records the place it replaced on the tab's history, unless
  // it is Back or Forward arriving (`arrival`), which brings the history the
  // step worked out instead.
  function activate(group: EditorGroup, tab: Tab, beside = false, arrival?: Step): void {
    const tabsList = group.tabs;
    if (tabsList.length === 0) {
      tabsList.push(tab);
      group.activeTabIndex = tabsList.length - 1;
    } else if (beside) {
      const index = group.activeTabIndex + 1;
      tabsList.splice(index, 0, tab);
      group.activeTabIndex = index;
    } else {
      const outgoing = tabsList[group.activeTabIndex];
      if (outgoing) releaseModel(outgoing);
      tabsList[group.activeTabIndex] = tab;
      const history = arrival ? arrival.history : outgoing && historyAfter(outgoing, tab);
      if (outgoing) outgoing.history = undefined; // a place in a history holds none of its own
      if (history) tab.history = history;
      // Back lands where the place was left, not at its top.
      if (arrival && "scrollTop" in arrival.to && (tab.kind === "document" || tab.kind === "applet-source")) {
        tab.scrollTop = arrival.to.scrollTop;
      }
      if (arrival?.to.kind === "document" && tab.kind === "document") {
        tab.readingScrollTop = arrival.to.readingScrollTop;
      }
    }
    announce(group, tab);
    listChanged();
  }

  // Puts `tab` at `at` among the group's tabs as its active one: where a
  // dragged tab was dropped. A group holding only a blank tab takes it in
  // place of the blank, which held the place of nothing.
  function insertAt(group: EditorGroup, tab: Tab, at: number): void {
    if (group.tabs.length === 1 && group.tabs[0].kind === "empty") {
      group.tabs[0] = tab;
      group.activeTabIndex = 0;
    } else {
      group.activeTabIndex = Math.min(Math.max(at, 0), group.tabs.length);
      group.tabs.splice(group.activeTabIndex, 0, tab);
    }
    announce(group, tab);
    listChanged();
  }

  // Renders whatever tab now sits at the group's active index — the async
  // half of switching. The group's own stale-open guard covers a switch
  // mid-load.
  async function renderActive(group: EditorGroup): Promise<void> {
    if (!alive(group)) return;
    const tab = activeTabOf(group);
    if (tab.kind === "document" && tab.deferred) return showDeferred(group, tab);
    announce(group, tab);
    listChanged();
    await deps.mount(group, tab);
  }

  // A file is open in at most one tab per group, whatever view shows it: a
  // running applet and its Source mode are one file, and the tab
  // already holding it is where its unsaved edits live. A blank tab gets no
  // exception. A second view of one file is a split, never a second tab.
  function tabShowing(group: EditorGroup, path: string): number {
    return group.tabs.findIndex(
      (tab) => tab.kind !== "empty" && tab.kind !== "find-context" && tab.kind !== "version" && tab.path === path,
    );
  }

  // A tab in a group other than `except` showing `path` the way only one
  // group may (see SINGLE_GROUP_KINDS): as an ordinary open shows it, or as
  // `kind`. An ordinary open never shows Source mode, so the code open in one
  // group never stops its Applet running in another.
  function heldElsewhere(
    path: string,
    except?: EditorGroup,
    kind?: "applet-source",
  ): { group: EditorGroup; index: number } | undefined {
    for (const group of workspace.groups()) {
      if (group === except) continue;
      const index = group.tabs.findIndex(
        (tab) =>
          tab.kind !== "empty" &&
          tab.path === path &&
          SINGLE_GROUP_KINDS.has(tab.kind) &&
          (kind === undefined ? tab.kind !== "applet-source" : tab.kind === kind),
      );
      if (index !== -1) return { group, index };
    }
    return undefined;
  }

  async function switchToIndex(group: EditorGroup, index: number): Promise<void> {
    if (index === group.activeTabIndex) return;
    await deps.flush();
    if (!alive(group)) return;
    group.activeTabIndex = index;
    await renderActive(group);
  }

  async function openFile(
    group: EditorGroup,
    filePath: string,
    token: number,
    beside: boolean,
    arrival?: Step,
    view?: OpenView,
  ): Promise<void> {
    await deps.flush();

    const file = await deps.loadFile(filePath);
    if (!isCurrent(group, token)) return; // a newer open has since started — this response lost the race

    if (file.kind === "table" || file.kind === "flow") {
      if (file.kind === "table") activate(group, { kind: "table", path: file.path }, beside, arrival);
      else activate(group, { kind: "flow", path: file.path }, beside, arrival);
      await deps.mount(group, activeTabOf(group), file);
      return;
    }

    if (file.kind === "applet") {
      activate(group, { kind: viewKind(file.path, view) ?? "applet", path: file.path }, beside, arrival);
      await deps.mount(group, activeTabOf(group), file);
      return;
    }

    if (file.kind === "class") {
      activate(group, { kind: "class", path: file.path }, beside, arrival);
      await deps.mount(group, activeTabOf(group), file);
      return;
    }

    // The tab takes its reference on the model before activate releases the
    // outgoing tab's, so re-opening the same file keeps its working copy.
    deps.documents.adopt(file);
    activate(group, { kind: "document", path: file.path, documentType: file.documentType }, beside, arrival);
    await deps.mount(group, activeTabOf(group), file);
  }

  async function openFolderIn(group: EditorGroup, dirPath: string, beside = false, arrival?: Step): Promise<void> {
    const token = nextToken(group);
    const open = tabShowing(group, dirPath);
    if (open !== -1) return switchToIndex(group, open);
    await deps.flush();
    if (!isCurrent(group, token)) return;
    if (isLibraryPath(dirPath)) await ensureLibraryPermissions();
    activate(group, { kind: "gallery", path: dirPath }, beside && activeTabOf(group).kind !== "empty", arrival);
    await deps.mount(group, activeTabOf(group));
  }

  const openFolder = (dirPath: string, beside = false) => openFolderIn(workspace.focusedGroup(), dirPath, beside);

  // No /api/file round trip: there is no text to fetch, just a path for the
  // pane to read the bytes of.
  async function openMedia(
    group: EditorGroup,
    kind: "image" | "video" | "pdf" | "lut",
    filePath: string,
    token: number,
    beside: boolean,
    arrival?: Step,
  ): Promise<void> {
    await deps.flush();
    if (!isCurrent(group, token)) return; // a newer open has since started — this response lost the race

    activate(group, { kind, path: filePath }, beside, arrival);
    await deps.mount(group, activeTabOf(group));
  }

  // Beside what the group shows, never in its place: a version is read
  // against its file. One tab per version, and the file's own tab stays its
  // file's, so restoring from the version lands on the file.
  async function openVersion(group: EditorGroup, filePath: string, version: HistoryVersion): Promise<void> {
    const open = group.tabs.findIndex(
      (tab) => tab.kind === "version" && tab.path === filePath && tab.version.id === version.id,
    );
    if (open !== -1) return switchToIndex(group, open);
    const token = nextToken(group);
    await deps.flush();
    if (!isCurrent(group, token)) return;
    activate(group, { kind: "version", path: filePath, version }, activeTabOf(group).kind !== "empty");
    await deps.mount(group, activeTabOf(group));
  }

  // Every caller fires this with `void`, so a rejection left unhandled would
  // vanish as a silent no-op instead of telling the writer their click did
  // nothing — hence the catch rather than a thrown error.
  async function openEntryIn(
    group: EditorGroup,
    filePath: string,
    beside: boolean,
    arrival?: Step,
    { from, view, version }: OpenOptions = {},
  ): Promise<void> {
    if (version) return openVersion(group, filePath, version);
    // Before the race token, so it never cancels an open still loading.
    if (!hasKnownKind(filePath)) return deps.openElsewhere(filePath, from);
    try {
      await openKnownIn(group, filePath, beside, arrival, view);
    } catch (error: unknown) {
      deps.notify(error instanceof Error ? error.message : `Failed to open "${filePath}".`);
    }
  }

  // A tab from `from` into the other group, opening one if there is only
  // one: at `at` among its tabs when given (a drop), else beside its current
  // one. A group left with no tab closes. `focus` is false for a run's move,
  // which must leave the writer in the document they clicked in.
  async function moveTab(from: EditorGroup, tab: Tab, at: number | undefined, focus: boolean): Promise<void> {
    // Read before it goes, as the other group mounts it at once.
    if (tab.kind === "document" && tab.deferred) {
      const read = await readDeferred(tab, () => alive(from) && from.tabs.includes(tab));
      if (read === "unreadable") await emptyUnreadable(from, tab);
      if (read !== "ready") return;
    }
    await deps.flush();
    const target = await sideGroupOf(from);
    const was = from.tabs.indexOf(tab);
    if (!alive(target) || !alive(from) || was === -1) return;

    const wasActive = was === from.activeTabIndex;
    from.tabs.splice(was, 1);
    if (wasActive) from.activeTabIndex = Math.min(was, from.tabs.length - 1);
    else if (was < from.activeTabIndex) from.activeTabIndex--;
    // Settled before the tab mounts again, so the pane leaving it writes
    // its view state back first, not over the new pane's.
    if (from.tabs.length === 0) removeGroup(from);
    else if (wasActive) await renderActive(from);
    if (!alive(target)) return;
    // A Source mode state is the old pane's, wired to its saves: the new
    // pane reads the file again instead. A document's is rebuilt anyway.
    if (tab.kind === "applet-source") tab.state = undefined;

    nextToken(target); // an open still loading there must not land over it
    if (focus) focusGroup(target.id);
    const open =
      tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version" ? -1 : tabShowing(target, tab.path);
    if (open !== -1) {
      releaseModel(tab);
      await switchToIndex(target, open);
      listChanged();
      return;
    }
    if (at === undefined) activate(target, tab, activeTabOf(target).kind !== "empty");
    else insertAt(target, tab, at);
    await deps.mount(target, tab);
  }

  // The open itself, its failure thrown: a run's open fails the node that
  // asked for it, where any other open reports it.
  async function openKnownIn(
    group: EditorGroup,
    filePath: string,
    beside: boolean,
    arrival?: Step,
    view?: OpenView,
  ): Promise<void> {
    const token = nextToken(group);
    const kind = viewKind(filePath, view);
    // The code already open in the other group is where Source mode goes,
    // even from a running tab of its own here: converted, that tab would be
    // a second Source mode, saving over the first's edits.
    const held = heldElsewhere(filePath, group, kind);
    if (kind && held) {
      focusGroup(held.group.id);
      return await switchToIndex(held.group, held.index);
    }
    const open = tabShowing(group, filePath);
    if (open !== -1) {
      await switchToIndex(group, open);
      if (kind) await showApplet(group, kind, token);
      return;
    }
    if (held) {
      focusGroup(held.group.id);
      return await switchToIndex(held.group, held.index);
    }
    // A library tab's editability comes from its registry entry, so that
    // has to be known before the tab renders rather than a moment after,
    // or the pane opens locked and then silently unlocks itself.
    if (isLibraryPath(filePath)) await ensureLibraryPermissions();
    const media = rawTabKind(filePath);
    await (media
      ? openMedia(group, media, filePath, token, beside, arrival)
      : openFile(group, filePath, token, beside, arrival, view));
  }

  // A note opened in place on either side of a pair that scrolls as one
  // opens on the other side too, in that side's own mode, so the pair holds
  // (docs/architecture.md, Files and views). Anything else, or a note only ever read,
  // leaves the other side as it was, as does that side moving on while this
  // open loads.
  async function openInPlace(
    group: EditorGroup,
    filePath: string,
    arrival?: Step,
    options?: OpenOptions,
  ): Promise<void> {
    const partner = deps.scrollPartner?.(group);
    const partnerTab = partner ? activeTabOf(partner) : undefined;
    await openEntryIn(group, filePath, false, arrival, options);
    if (!partner || !partnerTab || !alive(partner) || activeTabOf(partner) !== partnerTab) return;
    const tab = activeTabOf(group);
    if (tab.kind !== "document" || isReadOnlyTab(tab)) return;
    if (partnerTab.kind === "document" && partnerTab.path === tab.path) return;
    await openEntryIn(partner, tab.path, false);
  }

  const openEntry = (filePath: string, options?: OpenOptions) =>
    openInPlace(workspace.focusedGroup(), filePath, undefined, options);
  const openBeside = (filePath: string, options?: OpenOptions) => {
    const group = workspace.focusedGroup();
    return openEntryIn(group, filePath, activeTabOf(group).kind !== "empty", undefined, options);
  };

  // A step opens its place the way that place was first opened. A Find
  // Context answer comes back from the history itself, having no file to
  // fetch it from.
  async function go(direction: Direction): Promise<void> {
    const group = workspace.focusedGroup();
    const arrival = step(activeTabOf(group), direction);
    if (!arrival) return;
    const { to } = arrival;
    if (to.kind === "gallery") return openFolderIn(group, to.path, false, arrival);
    if (to.kind !== "find-context" && to.kind !== "version") return openInPlace(group, to.path, arrival);
    const token = nextToken(group);
    await deps.flush();
    if (!isCurrent(group, token)) return;
    const place: Tab =
      to.kind === "version"
        ? { kind: "version", path: to.path, version: to.version }
        : { kind: "find-context", path: to.path, result: to.result };
    activate(group, place, false, arrival);
    await deps.mount(group, activeTabOf(group));
  }

  // What a split brings along: the same file in `target`, in a new tab
  // unless the group shows only a blank one.
  async function showIn(target: EditorGroup, tab: Exclude<Tab, { kind: "empty" }>): Promise<void> {
    const beside = activeTabOf(target).kind !== "empty";
    if (tab.kind === "gallery" || tab.kind === "find-context" || tab.kind === "version") {
      const open = tabShowing(target, tab.path);
      if (open !== -1 && tab.kind === "gallery") return switchToIndex(target, open);
      const token = nextToken(target);
      await deps.flush();
      if (!isCurrent(target, token)) return;
      activate(target, { ...tab, history: undefined }, beside); // a second view starts with no way back
      return deps.mount(target, activeTabOf(target));
    }
    return openEntryIn(target, tab.path, beside);
  }

  // Swaps the group's active tab, an Applet's, for its other view in place,
  // rather than opening a second tab on the same file. Flushed first, so the
  // code's queued edit is on disk before the running view reads it.
  async function showApplet(group: EditorGroup, kind: "applet" | "applet-source", token: number): Promise<void> {
    const tab = activeTabOf(group);
    if (tab.kind === "empty" || tab.kind === kind) return;
    await deps.flush();
    const file = await deps.loadFile(tab.path);
    if (!isCurrent(group, token) || file.kind !== "applet") return;
    activate(group, { kind, path: file.path });
    await deps.mount(group, activeTabOf(group), file);
  }

  // Each group's active tab as restore left it: a group whose tab differs by
  // the time the tree is drawn was reached by an open or a switch first.
  let launched: { group: EditorGroup; tab: Tab }[] = [];

  // Reconstructs one persisted tab, reading no file: a document comes back
  // deferred and reads its own the first time it shows, so a launch reads only
  // what the groups show however many tabs were saved; every other kind is
  // re-derived when activated. Undefined for a malformed record, or a document
  // renamed to a type Pragma can't open, so one bad entry can't fail the restore.
  function restoreOne(entry: LayoutTab): Tab | undefined {
    if (entry.kind === "empty") return { kind: "empty" };
    // The one kind whose path may be "": a gallery of the space's root.
    if (entry.kind === "gallery" && entry.path !== undefined) return { kind: "gallery", path: entry.path };
    if (!entry.path) return undefined;
    const path = entry.path;

    // A plain switch, not `{ kind: entry.kind, path }` — TS won't carry a
    // variable-typed `kind` back into a discriminated union's members.
    switch (entry.kind) {
      // A saved corkboard tab shows its folder as a gallery.
      case "corkboard":
        return { kind: "gallery", path };
      case "image":
        return { kind: "image", path };
      case "video":
        return { kind: "video", path };
      case "pdf":
        return { kind: "pdf", path };
      case "lut":
        return { kind: "lut", path };
      case "table":
        return { kind: "table", path };
      case "class":
        return { kind: "class", path };
      case "flow": {
        const viewport = readTabViewport(entry.viewport);
        return viewport ? { kind: "flow", path, viewport } : { kind: "flow", path };
      }
      case "applet":
        return { kind: "applet", path };
      case "applet-source":
        return { kind: "applet-source", path };
    }

    if (!hasKnownKind(path)) return undefined;
    const tab: DocumentTab = { kind: "document", path, documentType: documentTypeFor(path), deferred: true };
    const place = readTabPlace(entry.place);
    if (place) tab.place = place;
    return tab;
  }

  // Reads a deferred tab's file, the read an open makes, and takes the tab's
  // reference on its model if `wanted` still holds once the file is in. A
  // file that can't be read, gone since the layout was saved say, is reported
  // with the read's own error unless `report` is off.
  async function readDeferred(
    tab: DocumentTab,
    wanted: () => boolean,
    report = true,
  ): Promise<"ready" | "unreadable" | "stale"> {
    let file: FileResponse;
    try {
      file = await deps.loadFile(tab.path);
    } catch (error: unknown) {
      if (!wanted()) return "stale";
      if (report) deps.notify(error instanceof Error ? error.message : `Failed to open "${tab.path}".`);
      return "unreadable";
    }
    if (!wanted()) return "stale";
    if (!tab.deferred) return "ready"; // another show read it meanwhile
    if (file.kind !== "text") return "unreadable";
    deps.documents.adopt(file);
    tab.deferred = undefined;
    return "ready";
  }

  // An open or a switch that starts while the file loads wins. The tab is
  // announced only once its model is in, as an open is: whatever follows the
  // open document reads the model then. One that can't be read becomes
  // empty, as a deleted file's tab does.
  async function showDeferred(group: EditorGroup, tab: DocumentTab, report = true): Promise<void> {
    const token = nextToken(group);
    listChanged(); // the strip moves now; the pane follows once the file is in
    const read = await readDeferred(tab, () => isCurrent(group, token) && activeTabOf(group) === tab, report);
    if (read === "unreadable") return emptyUnreadable(group, tab);
    if (read === "stale") return;
    announce(group, tab);
    listChanged();
    await deps.mount(group, tab);
  }

  async function emptyUnreadable(group: EditorGroup, tab: DocumentTab): Promise<void> {
    if (emptyTabs(group, (other) => other === tab).activeAffected) await renderActive(group);
    else listChanged();
  }

  // A document tab holds one reference on its model, but a deferred one holds
  // none: releasing for it would take another tab's reference on the same
  // file, and the last release flushes and forgets a model still on screen.
  function releaseModel(tab: Tab): void {
    if (tab.kind === "document" && !tab.deferred) void deps.documents.release(tab.path);
  }

  // Empties every tab `gone` matches, releasing documents, and reports
  // whether the group's active tab was among them.
  function emptyTabs(group: EditorGroup, gone: (tab: Exclude<Tab, { kind: "empty" }>) => boolean) {
    let activeAffected = false;
    let anyAffected = false;
    group.tabs.forEach((tab, index) => {
      // A deleted file's version stays open: it is what brings the file back.
      if (tab.kind === "empty" || tab.kind === "version" || !gone(tab)) return;
      releaseModel(tab);
      group.tabs[index] = { kind: "empty", history: tab.history };
      anyAffected = true;
      if (index === group.activeTabIndex) activeAffected = true;
    });
    return { activeAffected, anyAffected };
  }

  return {
    onActivate(listener) {
      activateListeners.add(listener);
      return () => activateListeners.delete(listener);
    },
    onFocus(listener) {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    onGroupClosed(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onOpenedBeside(listener) {
      besideListeners.add(listener);
      return () => besideListeners.delete(listener);
    },
    activePath,
    activeDocument,
    recentPaths: () => recent,
    focusGroup,
    listChanged,
    placeChanged: saveGroups,

    setReadingView(groupId, on) {
      const group = workspace.groupById(groupId);
      if (!group || group.readingView === on) return;
      group.readingView = on;
      saveGroups();
    },

    setSourceMode(groupId, on) {
      const group = workspace.groupById(groupId);
      if (!group || group.sourceMode === on) return;
      group.sourceMode = on;
      saveGroups();
    },

    // Never replaces or creates a tab — just moves the group's active index.
    async switchTo(groupId, index) {
      const group = workspace.groupById(groupId);
      if (group) await switchToIndex(group, index);
    },

    // Closing a group's last tab closes the group, unless it is the only
    // one: that never goes to zero, and gets a fresh empty tab, the same as
    // "+" produces. Closing an inactive tab only drops it from the strip;
    // the active pane is untouched.
    async close(groupId, index) {
      const group = workspace.groupById(groupId);
      if (!group) return;
      await deps.flush();
      const wasActive = index === group.activeTabIndex;
      const [closed] = group.tabs.splice(index, 1);
      if (closed) releaseModel(closed);

      if (group.tabs.length === 0 && workspace.groups().length > 1) {
        removeGroup(group);
        return;
      }
      if (group.tabs.length === 0) {
        group.tabs.push({ kind: "empty" });
        group.activeTabIndex = 0;
        await renderActive(group);
        return;
      }

      if (!wasActive) {
        if (index < group.activeTabIndex) group.activeTabIndex--;
        listChanged();
        return;
      }

      group.activeTabIndex = Math.min(index, group.tabs.length - 1);
      await renderActive(group);
    },

    async openNew(groupId) {
      const group = workspace.groupById(groupId);
      if (!group) return;
      await deps.flush();
      group.tabs.push({ kind: "empty" });
      group.activeTabIndex = group.tabs.length - 1;
      await renderActive(group);
    },

    async split(source) {
      const from = source ? workspace.groupById(source.groupId) : workspace.focusedGroup();
      const tab = source ? from?.tabs[source.index] : from && activeTabOf(from);
      if (!from || !tab) return;
      const target = await sideGroupOf(from);
      if (!alive(target)) return;
      focusGroup(target.id);
      if (tab.kind !== "empty" && !SINGLE_GROUP_KINDS.has(tab.kind)) await showIn(target, tab);
    },

    // The tab itself moves, its document reference with it: a file only one
    // group may show reaches the other group this way, never by a copy.
    async moveToOtherGroup(groupId, index, at) {
      const from = workspace.groupById(groupId);
      const tab = from?.tabs[index];
      if (!from || !tab) return;
      await moveTab(from, tab, at, true);
    },

    reorder(groupId, index, to) {
      const group = workspace.groupById(groupId);
      const tab = group?.tabs[index];
      if (!group || !tab) return;
      const at = Math.min(Math.max(to > index ? to - 1 : to, 0), group.tabs.length - 1);
      if (at === index) return;
      const shown = activeTabOf(group);
      group.tabs.splice(index, 1);
      group.tabs.splice(at, 0, tab);
      group.activeTabIndex = group.tabs.indexOf(shown);
      listChanged();
    },

    async closeOthers(groupId, index) {
      const group = workspace.groupById(groupId);
      const keep = group?.tabs[index];
      if (!group || !keep) return;
      await deps.flush();
      if (!alive(group) || !group.tabs.includes(keep)) return;
      const wasActive = activeTabOf(group) === keep;
      for (const tab of group.tabs) if (tab !== keep) releaseModel(tab);
      group.tabs = [keep];
      group.activeTabIndex = 0;
      if (wasActive) listChanged();
      else await renderActive(group);
    },

    // All at once, so none of them is drawn on its way out.
    async closeAll(groupId) {
      const group = workspace.groupById(groupId);
      if (!group) return;
      await deps.flush();
      if (!alive(group)) return;
      for (const tab of group.tabs) releaseModel(tab);
      group.tabs = [];
      if (workspace.groups().length > 1) {
        removeGroup(group);
        return;
      }
      group.tabs.push({ kind: "empty" });
      group.activeTabIndex = 0;
      await renderActive(group);
    },

    async openToSide(path, options = {}) {
      // Before a side group opens for it, or a new group would be left empty.
      if (!hasKnownKind(path)) return deps.openElsewhere(path, options.from);
      const held = heldElsewhere(path, undefined, viewKind(path, options.view));
      if (held) {
        focusGroup(held.group.id);
        return switchToIndex(held.group, held.index);
      }
      const target = await sideGroupOf(workspace.focusedGroup());
      if (!alive(target)) return;
      focusGroup(target.id);
      await openEntryIn(target, path, activeTabOf(target).kind !== "empty", undefined, options);
    },

    // Never into `groupId` itself: replacing the document a toolkit run is
    // bound to there would stop the run, and taking focus would move the
    // Tools tab and the copilot off it.
    async openBeside(path, groupId) {
      const from = workspace.groupById(groupId);
      if (!from) return;
      if (!hasKnownKind(path)) return deps.openElsewhere(path);
      // A file only one group may show, shown by the run's own group, stays:
      // a Flow opening itself.
      const shown = activeTabOf(from);
      if (shown.kind !== "empty" && shown.path === path && inOneGroupOnly(shown)) return;
      const alone = workspace.groups().length === 1;
      const target = await sideGroupOf(from);
      if (!alive(target)) return;
      const held = heldElsewhere(path, target);
      try {
        if (held) await moveTab(held.group, held.group.tabs[held.index], undefined, false);
        else await openKnownIn(target, path, activeTabOf(target).kind !== "empty");
      } catch (error: unknown) {
        // A group opened for a file that never came is closed again.
        if (alone && alive(target) && target.tabs.every((tab) => tab.kind === "empty")) removeGroup(target);
        throw error;
      }
      if (alive(target)) for (const listener of besideListeners) listener(target);
    },

    async pushFindContext(dirPath, result) {
      const group = workspace.focusedGroup();
      await deps.flush();
      group.tabs.push({ kind: "find-context", path: dirPath, result });
      group.activeTabIndex = group.tabs.length - 1;
      await renderActive(group);
    },

    async reloadPath(path) {
      // Every tab on a document model follows the model's own reload.
      await deps.documents.get(path)?.reload();
      for (const group of workspace.groups()) {
        const tab = activeTabOf(group);
        if (tab.kind === "empty" || tab.kind === "document" || tab.path !== path) continue;
        // A cached editor state is the working copy being discarded; without
        // it the mount reads the file again, as every other kind's does.
        if (tab.kind === "applet-source") tab.state = undefined;
        await deps.mount(group, tab);
      }
    },

    openCopies() {
      const paths = new Set<string>();
      for (const group of workspace.groups()) {
        for (const tab of group.tabs) if (tab.kind === "document" && !tab.deferred) paths.add(tab.path);
        const active = activeTabOf(group);
        if (active.kind !== "empty" && (inOneGroupOnly(active) || active.kind === "applet")) paths.add(active.path);
      }
      return [...paths];
    },

    repath(from, to) {
      const rename = (path: string) => (under(path, from) ? to + path.slice(from.length) : undefined);
      let changed = false;
      for (const group of workspace.groups()) {
        // A tab keeps its identity across a move — the file is the same
        // file, so re-pointing it is what keeps a gallery, table, applet or
        // image open rather than closing and reopening it.
        group.tabs = group.tabs.map((tab) => {
          const path = tab.kind === "empty" ? undefined : rename(tab.path);
          if (tab.kind === "empty" || path === undefined) return tab;
          changed = true;
          return { ...tab, path };
        });
      }
      rewriteHistories((history) => repathed(history, rename));
      if (changed) listChanged();
      return changed;
    },

    async followMove(to) {
      for (const group of workspace.groups()) {
        const tab = activeTabOf(group);
        if (tab.kind === "empty" || tab.kind === "document" || tab.kind === "applet-source") continue;
        if (under(tab.path, to)) await renderActive(group);
      }
    },

    dropGone(paths) {
      if (paths.length === 0) return;
      const gone = new Set(paths);
      let anyAffected = false;
      for (const group of workspace.groups()) {
        const affected = emptyTabs(group, (tab) => gone.has(tab.path));
        if (affected.activeAffected) void renderActive(group);
        else anyAffected ||= affected.anyAffected;
      }
      rewriteHistories((history, tab) => pruned(history, tab, (place) => !gone.has(place.path)));
      if (anyAffected) listChanged();
    },

    // Every tab that pointed at a deleted entry, or at anything inside a
    // deleted folder. Unlike a move there is no new path to follow, so each
    // becomes "empty" and its model is released.
    //
    // A group's active one lands on the parent folder's gallery instead, so
    // the editor stays near where the user was.
    dropDeleted(path) {
      let anyAffected = false;
      const landing: EditorGroup[] = [];
      for (const group of workspace.groups()) {
        const affected = emptyTabs(group, (tab) => under(tab.path, path));
        if (affected.activeAffected) landing.push(group);
        else anyAffected ||= affected.anyAffected;
      }
      // Before the landing, so the folder's tab takes a history the deleted entry is already out of.
      rewriteHistories((history, tab) => pruned(history, tab, (place) => !under(place.path, path)));
      for (const group of landing) void openFolderIn(group, dirnameOf(path));
      if (anyAffected) listChanged();
    },

    openEntry: (filePath, options) => openEntry(filePath, options),
    openEntryBeside: openBeside,

    async openSpacePath(path, { beside = false, ...options } = {}) {
      const open = beside ? openBeside : openEntry;
      // A path ending in `/` names a folder, as a link writes one.
      if (path.endsWith("/")) return openFolder(path.slice(0, -1), beside);
      if (isForeignRootTab({ kind: "document", path })) return open(path, options);
      // A file of no kind is in no tree while every type isn't shown, and
      // goes where such a file goes rather than being called missing.
      if (!deps.revealInTree(path) && hasKnownKind(path)) {
        deps.notify(`File not found: ${path}`);
        return;
      }
      await open(path, options);
    },

    openFolder,
    async openFolderToSide(dirPath) {
      const target = await sideGroupOf(workspace.focusedGroup());
      if (!alive(target)) return;
      focusGroup(target.id);
      await openFolderIn(target, dirPath, true);
    },

    openAppletCode: (path) => openEntry(path, { view: "code" }),
    async runApplet(path) {
      const group = workspace.focusedGroup();
      const token = nextToken(group);
      const open = tabShowing(group, path);
      if (open === -1) return openEntry(path);
      await switchToIndex(group, open);
      await showApplet(group, "applet", token);
    },

    canGo(direction, groupId) {
      const group = groupId === undefined ? workspace.focusedGroup() : workspace.groupById(groupId);
      return group !== undefined && step(activeTabOf(group), direction) !== undefined;
    },
    go,
    onHistoryChange(listener) {
      historyListeners.add(listener);
      return () => historyListeners.delete(listener);
    },

    // A space with nothing persisted (a first load, or a save that never
    // landed) falls back to a single empty tab, the same "always keep at
    // least one" rule close follows. A group none of whose tabs restore is
    // dropped, as closing its last tab would have.
    async restore() {
      let persisted: { groups: LayoutGroup[]; focusedGroup: number };
      try {
        persisted = await deps.loadLayout();
      } catch {
        persisted = { groups: [], focusedGroup: 0 };
      }

      const restored: RestoredGroup[] = [];
      const saved = Array.isArray(persisted.groups) ? persisted.groups.slice(0, MAX_GROUPS) : [];
      for (const [groupIndex, entry] of saved.entries()) {
        const tabs: Tab[] = [];
        let activeTabIndex = 0;
        for (const [tabIndex, savedTab] of entry.tabs.entries()) {
          const tab = restoreOne(savedTab);
          if (!tab) continue;
          tabs.push(tab);
          if (tabIndex === entry.activeTabIndex) activeTabIndex = tabs.length - 1;
        }
        if (tabs.length > 0) {
          restored.push({
            tabs,
            activeTabIndex,
            readingView: entry.readingView === true,
            sourceMode: entry.sourceMode === true,
            focused: groupIndex === persisted.focusedGroup,
          });
        }
      }

      // A clean slate, not workspace.ts's own seed tab — activate's "no tabs
      // yet" branch only fires correctly when nothing has been pushed.
      const first = workspace.focusedGroup();
      first.tabs.length = 0;
      if (restored.length === 0) {
        activate(first, { kind: "empty" });
        return;
      }

      const groups = restored.map((entry, index) => {
        const group = index === 0 ? first : workspace.addGroup();
        group.tabs = entry.tabs;
        group.activeTabIndex = entry.activeTabIndex;
        group.readingView = entry.readingView;
        group.sourceMode = entry.sourceMode;
        return group;
      });
      const focused =
        groups[
          Math.max(
            0,
            restored.findIndex((entry) => entry.focused),
          )
        ];
      workspace.setFocusedGroup(focused.id);
      for (const group of groups) for (const tab of [...group.tabs].reverse()) remember(tab);
      // The focused group shows last, so what follows the focus settles on it.
      launched = [...groups.filter((group) => group !== focused), focused].map((group) => ({
        group,
        tab: activeTabOf(group),
      }));
    },

    async showRestored() {
      const shows = launched;
      launched = [];
      if (shows.length === 0) return;
      // Restored tabs skip the normal open path, so the library registry is
      // read once here instead of per tab.
      await ensureLibraryPermissions();
      listChanged();
      for (const { group, tab } of shows) {
        if (activeTabOf(group) !== tab) continue;
        // A file gone since the last session empties its tab with no dialog
        // at launch, which nothing the writer did asked for.
        if (tab.kind === "document" && tab.deferred) await showDeferred(group, tab, false);
        else await renderActive(group);
      }
    },
  };
}
