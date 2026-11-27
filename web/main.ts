import { dirnameOf, isLibraryPath } from "../src/protocol/rootedPath.ts";
import {
  fetchAppletInfo,
  fetchFile,
  fetchLayout,
  fetchLibraries,
  fetchPublishers,
  fetchSites,
  fetchSpaceList,
  fetchSpaceSearch,
  getFileDescription,
  postCreateEntry,
  postCreateSite,
  postSetFolderState,
  postSetGroups,
  postSpaceTrust,
  putFile,
  sandboxGrant,
  sandboxRevoke,
} from "./core/apiClient.ts";
import { chatScreen } from "./core/chatContext.ts";
import * as spaceTree from "./core/spaceTree.ts";
import { tagVocabulary } from "./core/tagVocabulary.ts";
import * as workspace from "./core/workspace.ts";
import { createEditorArea } from "./editorArea.ts";
import { codeLayout, wireCodeSettings } from "./formats/code/settings.ts";
import { markdownFormat } from "./formats/markdown/format.ts";
import { screenplayFormat } from "./formats/screenplay/format.ts";
import { createGraphTab } from "./graph/graphView.ts";
import { ignoreStrayFileDrops, must } from "./lib/dom.ts";
import { registerFlyoutEscape } from "./lib/flyout.ts";
import { createListItemMenuButton } from "./lib/listItemMenu.ts";
import { applyBrightSelection } from "./lib/selection.ts";
import { spellcheckFields } from "./lib/spellcheck.ts";
import { bindToggle } from "./lib/toggleRow.ts";
import { installTooltips } from "./lib/tooltip.ts";
import { startActivityFeed } from "./services/activityFeed.ts";
import { bookmarks } from "./services/bookmarks.ts";
import { createCollapsedFolders } from "./services/collapsedFolders.ts";
import { type CommandContext, createCommands } from "./services/commands.ts";
import { createDescriptions } from "./services/descriptions.ts";
import { createDialogService } from "./services/dialog.ts";
import { publishDocument } from "./services/documentPublish.ts";
import { createDocuments } from "./services/documents.ts";
import { createEditorPanes, registerPaneDismiss } from "./services/editorPanes.ts";
import { type EntryMoveDeps, moveSpaceEntries } from "./services/entryMove.ts";
import { createFileNotices } from "./services/fileNotices.ts";
import { createFormats } from "./services/formats.ts";
import { gitStatusStore } from "./services/gitStatus.ts";
import { inspectorTabs } from "./services/inspectorTabs.ts";
import { codeMirrorChords, createKeybindings, currentPlatform } from "./services/keybindings.ts";
import { takeLinkRequests } from "./services/linkRequests.ts";
import { createMenus } from "./services/menus.ts";
import { createModelConsole } from "./services/modelConsole.ts";
import { createModelLists } from "./services/modelLists.ts";
import { followOutsideEdits } from "./services/outsideEdits.ts";
import { createPublishers } from "./services/publishers.ts";
import { injectAppletRuntime } from "./services/sandboxHost.ts";
import { createSaveConflicts } from "./services/saveConflicts.ts";
import { createSaveQueue, guardUnload, type SaveQueueState } from "./services/saveQueue.ts";
import * as settings from "./services/settings.ts";
import { createSidebarViews } from "./services/sidebarViews.ts";
import { switchSpace } from "./services/spaceSwitch.ts";
import { createTabs, type OpenSource } from "./services/tabs.ts";
import { createToolkitTargets } from "./toolkitTargets.ts";
import { mountAnimatedMark } from "./view/animatedMark.ts";
import { wireApiPanel } from "./view/apiPanel.ts";
import { wireAssistantPanel } from "./view/assistantPanel.ts";
import { wireChat } from "./view/chat.ts";
import { wireConsoleMenu } from "./view/consoleMenu.ts";
import { wireConsoleResize } from "./view/consoleResize.ts";
import { createContextMenu } from "./view/contextMenu.ts";
import { createContextPanel } from "./view/contextPanel.ts";
import { createDefaultAppMenu, registerShowInFolder } from "./view/defaultAppMenu.ts";
import { createFilesSettings } from "./view/filesSettings.ts";
import { createTreeView } from "./view/fileTreeView.ts";
import { wireEditorFontSize, wireFonts } from "./view/fonts.ts";
import { bindFormatSwitches } from "./view/formatSwitches.ts";
import { wireFormatsPanel } from "./view/formatsPanel.ts";
import { createLinksList } from "./view/linksList.ts";
import { createSpaceManager } from "./view/manageSpaces.ts";
import { wireMcpServersPanel } from "./view/mcpServersPanel.ts";
import { wireMenuBar } from "./view/menuBar.ts";
import { createMetadataProperties } from "./view/metadataProperties.ts";
import { wireModelPickers } from "./view/modelSelect.ts";
import { appletPane } from "./view/panes/appletPane.ts";
import { classPane } from "./view/panes/classPane.ts";
import { appletSourcePane, DOCUMENT_KEYMAP, documentPane } from "./view/panes/documentPane.ts";
import { emptyPane } from "./view/panes/emptyPane.ts";
import { findContextPane } from "./view/panes/findContextPane.ts";
import { flowPane } from "./view/panes/flowPane.ts";
import { galleryPane } from "./view/panes/galleryPane.ts";
import { mediaPanes } from "./view/panes/mediaPane.ts";
import { pdfPane } from "./view/panes/pdfPane.ts";
import { tablePane } from "./view/panes/tablePane.ts";
import { createPropertyEditor } from "./view/propertyEditor.ts";
import { wireProvidersPanel } from "./view/providersPanel.ts";
import { wirePublishersPanel } from "./view/publishersPanel.ts";
import { createQuickOpen } from "./view/quickOpen.ts";
import { createSettingsPanel } from "./view/settingsPanel.ts";
import { wireSharingPanel } from "./view/sharingPanel.ts";
import { wireShortcutsPanel } from "./view/shortcutsPanel.ts";
import { createBookmarksView } from "./view/sidebar/bookmarks.ts";
import { createHistorySection } from "./view/sidebar/history.ts";
import { createLibrariesPanel } from "./view/sidebar/libraries.ts";
import { createSearchView, SEARCH_VIEW_ID } from "./view/sidebar/search.ts";
import { createSidebarShell, registerSidebarCommands } from "./view/sidebar/shell.ts";
import { createSourceControlView, wireSourceControlPanel } from "./view/sidebar/sourceControl.ts";
import { createSpaceView } from "./view/sidebar/space.ts";
import { createTagsSection } from "./view/sidebar/tags.ts";
import { createWebsitesView } from "./view/sidebar/websites.ts";
import { createSiteDialogs, siteSettingsApi } from "./view/sites.ts";
import { createSpaceSwitcher } from "./view/spaceSwitcher.ts";
import { createSpaceTrust } from "./view/spaceTrust.ts";
import { wireSpellcheckPanel } from "./view/spellcheckPanel.ts";
import { createAppIndicators } from "./view/statusbar.ts";
import { wireThemeControl } from "./view/theme.ts";
import { createToolkitPanel } from "./view/toolkitPanel.ts";
import { createToolkitRunner } from "./view/toolkitRunner.ts";
import { createActiveRowMarker } from "./view/treeRows.ts";
import { wireUpdateControl } from "./view/updateControl.ts";
import { wireWindowControls } from "./view/windowControls.ts";
import { wireWindowTitle } from "./view/windowTitle.ts";
import { wireZoom } from "./view/zoom.ts";

const APP_NAME = "Pragma";

async function main(): Promise<void> {
  const rail = must<HTMLElement>("#rail");
  const railSettingsButton = must<HTMLButtonElement>("#rail-settings");
  const settingsPanel = must<HTMLDivElement>("#settings-panel");
  const settingTheme = must<HTMLButtonElement>("#setting-theme");
  const settingLineNumbers = must<HTMLButtonElement>("#setting-line-numbers");
  const settingFoldMarkers = must<HTMLButtonElement>("#setting-fold-markers");
  const settingReadableLineLength = must<HTMLButtonElement>("#setting-readable-line-length");
  const settingConsole = must<HTMLButtonElement>("#setting-console");
  const settingsBody = must<HTMLElement>("#settings-body");
  const sidebar = must<HTMLDivElement>("#sidebar");
  const sidebarResizeHandle = must<HTMLDivElement>("#sidebar-resize-handle");
  const treeContainer = must<HTMLElement>("#tree");
  const treeSpaceName = must<HTMLButtonElement>("#tree-space-name");
  const treeSpaceNameLabel = must<HTMLSpanElement>("#tree-space-name-label");
  const treeNodes = must<HTMLDivElement>("#tree-nodes");
  const treeNewFileButton = must<HTMLButtonElement>("#tree-new-file");
  const treeNewFolderButton = must<HTMLButtonElement>("#tree-new-folder");
  const treeRefreshButton = must<HTMLButtonElement>("#tree-refresh");
  const sourceControlContainer = must<HTMLElement>("#source-control");
  const editorContainer = must<HTMLDivElement>("#editor");
  const editorGroups = must<HTMLDivElement>("#editor-groups");
  const workspaceScrim = must<HTMLDivElement>("#workspace-scrim");
  const consoleContainer = must<HTMLElement>("#console");
  const consoleResizeHandle = must<HTMLDivElement>("#console-resize-handle");
  const consoleEntries = must<HTMLDivElement>("#console-entries");
  const consoleClearButton = must<HTMLButtonElement>("#console-clear");
  const consoleCloseButton = must<HTMLButtonElement>("#console-close");
  const contextPanel = must<HTMLDivElement>("#context-panel");
  const buttonList = must<HTMLDivElement>("#button-list");
  const actionResults = must<HTMLDivElement>("#action-results");
  const headerSidebarToggle = must<HTMLButtonElement>("#header-sidebar-toggle");
  const headerSidebarSpacer = must<HTMLDivElement>("#header-sidebar-spacer");
  const headerTabs = must<HTMLDivElement>("#header-tabs");

  // Folders the user folded stay folded when the tree is rebuilt after a new
  // file or folder. Keyed by rooted path, so one store serves the space tree,
  // a site's accordion and a library's alike, and a library folder and a
  // space folder of one relative name are different keys.
  const collapsed = createCollapsedFolders({ load: fetchLayout, save: postSetFolderState });

  // Scoped to the whole sidebar, not one tree's container: every panel that
  // draws rows shares one highlight (view/treeRows.ts).
  const activeRow = createActiveRowMarker(sidebar);
  const createTree = (listPath: string | (() => string)) => createTreeView(listPath, { active: activeRow });

  // The save warning and model activity, which one group's status bar holds.
  const indicators = createAppIndicators({
    retrySaves: () => void saveQueue.flush(),
    reviewConflicts: () => saveConflicts.review(),
  });
  const modelConsole = createModelConsole({ consoleEntries, activityIndicator: indicators.activity });
  startActivityFeed({ modelConsole, showConsole: settings.showConsole });
  // What each open file has to say for itself, counted on its status bar.
  const fileNotices = createFileNotices({
    log: (level, kind, label, content, need) => modelConsole.logEntry(level, kind, label, content, need),
    showConsole: () => settings.showConsole.set(true),
  });

  // Publish/Update (docs/publishing.md). A publish outlives the tab it started
  // from, so the panel asks for the open document's properties by path.
  const contextPanelView = createContextPanel({
    element: contextPanel,
    findSiteRoot: spaceTree.findSiteRoot,
    publish: (filePath) => publishDocument(filePath, { queue: saveQueue, documents }),
    livePropertiesFor: (filePath) => (tabs.activePath() === filePath ? tabs.activeDocument()?.properties() : undefined),
    notices: fileNotices,
    onPublished: () => {
      void space.refresh();
      editorArea.focusedDocumentPane()?.refresh();
      inspector.refreshFacts(tabs.activePath() ?? "");
    },
    reveal: () => inspector.show("tools"),
  });

  ignoreStrayFileDrops();
  installTooltips();

  const publishers = createPublishers({ fetch: fetchPublishers });
  const files = createFilesSettings({ alert: (message) => window.alert(message), bindToggle, dialog: () => dialog });

  // Commands, keybindings, and menus (docs/architecture.md's Module boundaries
  // section): every menu below is a definition the context-menu view
  // draws, every item a command, and each command's `when` says where it
  // applies. A command runs against the focused group's active tab and
  // pane, read at the moment it runs.
  const commands = createCommands();
  const keybindings = createKeybindings(commands);
  settings.shortcuts.subscribe((chords) => keybindings.setUserChords(chords));
  const menus = createMenus(commands);
  const commandContext = (): CommandContext => ({ tab: workspace.activeTab(), pane: editorArea.focusedPane() });
  const contextMenu = createContextMenu({ commands, menus, keybindings, context: commandContext });
  keybindings.attach(document, commandContext);

  // Escape, once no dialog or menu claims it, dismisses the active pane's
  // own transient — a popover, a selection — and, before that, the color or
  // date picker, popovers several panes share.
  registerPaneDismiss(commands, keybindings);
  registerFlyoutEscape(commands, keybindings);

  // The space switcher menu behind the space name atop the tree
  // (view/spaceSwitcher.ts); the space manager below registers Manage Spaces….
  const spaceSwitcher = createSpaceSwitcher({
    commands,
    menus,
    contextMenu,
    anchor: treeSpaceName,
    fetchSpaceList,
    switchSpace,
  });

  // What follows a move, whichever tree asked for it: the pending save
  // flushed first, then every open tab and model re-pointed. Each tree adds
  // only the refresh of its own rows. A function, not an object: the
  // services it names are built further down, and a move happens long after.
  const entryMoveDeps = (): Omit<EntryMoveDeps, "refreshTree"> => ({
    documents,
    flushPendingSave,
    activePath: () => tabs.activePath(),
    // Fires before the tab is re-pointed, which announces no focus change, so
    // whatever follows the focused tab's path is moved here, from this argument.
    onActivePathMoved: (path) => {
      showTitle(path);
      activeRow.set(path);
    },
    tabs,
    notify: (message) => window.alert(message),
    modelConsole,
  });

  // The Space view (view/sidebar/space.ts): the tree and everything done to
  // it in place. What it hands back are paths; what the editor does with
  // them — open, re-point tabs on a move, drop tabs on a delete — is wired
  // here, so the tree never learns about tabs.
  const space = createSpaceView(
    {
      panel: treeContainer,
      spaceName: treeSpaceName,
      spaceNameLabel: treeSpaceNameLabel,
      nodes: treeNodes,
      newFile: treeNewFileButton,
      newFolder: treeNewFolderButton,
      refresh: treeRefreshButton,
    },
    {
      collapsed,
      active: activeRow,
      dialog: () => dialog,
      modelConsole,
      createTree,
      createHistorySection,
      tagsSection: createTagsSection({ tags: tagVocabulary, contextMenu }),
      settingWords: (kind) => formats.scopeSettings(kind),
      editProperties: (path, edit) => documents.editProperties(path, edit),
      open: (path, options) => tabs.openEntry(path, options),
      openBeside: (path) => tabs.openEntryBeside(path),
      openDirectory: (dir) => void tabs.openFolder(dir),
      move: (moves, refreshTree) => moveSpaceEntries(moves, { ...entryMoveDeps(), refreshTree }),
      onDeleted: (path) => tabs.dropDeleted(path),
      moveToTrash: files.moveToTrash,
      openFindContextResults: (dirPath, result) => tabs.pushFindContext(dirPath, result),
      commands,
      menus,
      contextMenu,
      // The New Site gate reads a cached publisher list; refresh it as the
      // menu opens rather than leaving it to whenever the list last loaded.
      beforeMenu: () => void publishers.refresh(),
      newSite: (parentPath) => siteDialogs.openNewSite(parentPath),
      hasPublishers: () => publishers.get().length > 0,
      keybindings,
      show: () => sidebarViews.activate("space"),
      // An open site's accordion draws the same rows, so it redraws with them.
      onRendered: () => websitesView.refreshExpanded(),
      // A gallery lists its folder again, and a screenplay's names and an
      // open folder's count in Info read the same core/spaceTree.ts tree the
      // view does, so all follow whatever just changed it; so do the
      // uncommitted count and the bookmarks, for a create, move or delete.
      onChanged: () => {
        editorArea.noteSpaceChanged();
        inspector.noteSpaceChanged();
        gitStatusStore.noteLocalChange();
        void bookmarks.read();
      },
    },
  );

  // Sidebar views are contributions (docs/architecture.md's Workspace and UI ownership section):
  // each module builds its panel and rail icon and registers here; the shell
  // renders both from the registry alone, no view by name. Space and Source
  // Control adopt their panels from index.html; the others build their own.
  const sidebarViews = createSidebarViews({ hidden: settings.sidebarHidden, active: settings.sidebarView });
  const websitesView = createWebsitesView({
    // The publisher gate on this list's own "Settings" item reads a cached
    // list (publishers.refresh), and the list is the only way to
    // reach that item — so it is refreshed alongside the sites themselves,
    // in parallel, rather than left to whenever the tree's menu last opened.
    fetchSites: async () => {
      const [sites] = await Promise.all([fetchSites(), publishers.refresh()]);
      return sites;
    },
    // The site's folder of the live space tree, with the main tree's own
    // editing context, so rename/create/drag inside a site's accordion
    // behave exactly as in the Space view.
    createTree,
    siteNodes: (sitePath) => spaceTree.findDirectoryNode(sitePath)?.children ?? [],
    renderContext: () => space.renderContext(),
    createMenuButton: (label, sitePath) =>
      createListItemMenuButton(contextMenu, label, { kind: "site", path: sitePath }),
  });
  const librariesView = createLibrariesPanel({
    commands,
    menus,
    dialog: () => dialog,
    bridge: window.pragmaElectron,
    fetchLibraries,
    forgetLibraryTree: spaceTree.forgetLibraryTree,
    // A gallery lists the library again, and a bookmark into it may have moved or gone.
    onChanged: () => {
      editorArea.refreshGalleries();
      void bookmarks.read();
    },
    createTree,
    showExtensions: () => settings.showExtensions.get(),
    contextMenu,
    tabs: () => tabs,
    treeActions: space.treeActions,
    show: () => sidebarViews.activate("library"),
    collapsed,
  });
  sidebarViews.register({ ...space.view, onContextMenu: spaceSwitcher.openAt });
  sidebarViews.register(
    createSearchView({
      commands,
      menus,
      keybindings,
      search: fetchSpaceSearch,
      show: () => sidebarViews.activate(SEARCH_VIEW_ID),
      // A getter: the tab session is built further down.
      tabs: () => tabs,
      activePane: () => editorArea.focusedPane(),
    }),
  );
  sidebarViews.register(createSourceControlView(sourceControlContainer, () => void gitStatusStore.refresh()));
  sidebarViews.register(websitesView.view);
  sidebarViews.register(
    createBookmarksView({
      commands,
      menus,
      contextMenu,
      active: activeRow,
      open: (path, from) => tabs.openEntry(path, { from }),
      revealFolder: (path) => (isLibraryPath(path) ? librariesView.revealFolder(path) : space.revealFolder(path)),
    }),
  );
  sidebarViews.register(librariesView.view);
  createSidebarShell(
    {
      rail,
      railTail: railSettingsButton,
      sidebar,
      resizeHandle: sidebarResizeHandle,
      headerToggle: headerSidebarToggle,
      headerSpacer: headerSidebarSpacer,
    },
    sidebarViews,
    settings.sidebarWidth,
  );
  registerSidebarCommands(sidebarViews, { commands, keybindings, menus });

  wireWindowControls(window.pragmaElectron, settings.zoom);

  inspectorTabs.register(createGraphTab({ open: (path) => void tabs.openSpacePath(path), contextMenu }));
  // The assistant column and the inspector over its chat (view/assistantPanel.ts). After the
  // sidebar, whose restored width it gives way to, and the window controls, which raise its floor.
  const inspector = wireAssistantPanel(settings, { commands, keybindings, menus });

  wireThemeControl(settingTheme, settings.theme, contextMenu, window.pragmaElectron);
  wireZoom({ zoom: settings.zoom, bridge: window.pragmaElectron, commands, keybindings, menus, contextMenu });

  const modelLists = createModelLists({ modelConsole });
  const chatPick = wireModelPickers({
    settingsModels: must<HTMLElement>('.settings-category[data-settings-category="models"]'),
    chatComposer: must<HTMLFormElement>("#chat-form"),
    settings,
    contextMenu,
    modelLists,
  });

  // The Editor page's layout, for notes and screenplays. Only the switches
  // are bound here: each pane lays itself out from the settings it was
  // given, so an applet's Source mode can follow its own page instead.
  bindToggle(settingLineNumbers, settings.showLineNumbers);

  // Fold markers are the only way to expand a folded block, so hiding them
  // would otherwise strand any already-folded regions with no way back.
  bindToggle(settingFoldMarkers, settings.showFoldMarkers, {
    onChange: (show) => {
      if (!show) editorArea.unfoldAll("document");
    },
  });

  bindToggle(settingReadableLineLength, settings.readableLineLength);

  // Extensions show in two places at once: the tree redraws here, and a
  // gallery hears the setting itself.
  files.bind(settingsBody, {
    showExtensions: settings.showExtensions,
    onNamesChanged: () => space.render(),
    onListingChanged: () => void space.refresh().then(() => editorArea.refreshGalleries()),
  });
  bindFormatSwitches();
  bindToggle(must<HTMLButtonElement>("#setting-spellcheck"), settings.spellcheck, { apply: spellcheckFields });
  bindToggle(must<HTMLElement>("#setting-bright-selection"), settings.brightSelection, { apply: applyBrightSelection });

  bindToggle(must<HTMLButtonElement>("#setting-stats"), settings.showStats);
  bindToggle(settingConsole, settings.showConsole, {
    apply: (show) => {
      consoleContainer.hidden = !show;
      consoleResizeHandle.hidden = !show;
    },
  });

  consoleCloseButton.addEventListener("click", () => settings.showConsole.set(false));

  consoleClearButton.addEventListener("click", () => modelConsole.clear());
  wireConsoleMenu({ consoleEntries, contextMenu, modelConsole });

  const versionRow = wireUpdateControl(settingsBody, { alert: window.alert, bindToggle, commands, modelConsole });
  mountAnimatedMark(must<HTMLImageElement>(".settings-logo"));

  wireConsoleResize({ panel: consoleContainer, handle: consoleResizeHandle, editor: editorContainer });

  wireEditorFontSize(settings.editorFontSize);
  wireFonts({ interfaceFont: settings.interfaceFont, editorFont: settings.editorFont, contextMenu });

  const formats = createFormats();
  formats.register("note", markdownFormat({ links: spaceTree, loadFile: fetchFile, tags: tagVocabulary }));
  formats.register("screenplay", screenplayFormat({ worldNames: spaceTree.worldNameResolver, contextMenu }));
  const code = wireCodeSettings({ contextMenu, onFoldMarkersHidden: () => editorArea.unfoldAll("applet-source") });
  wireFormatsPanel(settingsBody, { formats, pages: [code], openSettingsSubpage: (id) => settingsView.openSubpage(id) });
  wireSpellcheckPanel(settingsBody, { openSettingsSubpage: (id) => settingsView.openSubpage(id), contextMenu });

  // Settings' server-side lists. An MCP server on for Flows lists image models, so it refetches them too.
  const subpages = {
    openSettingsSubpage: (id: string) => settingsView.openSubpage(id),
    closeSettingsSubpage: () => settingsView.closeSubpage(),
    dialog: () => dialog,
  };
  const refreshProvidersPanel = wireProvidersPanel(settingsBody, {
    ...subpages,
    onProvidersChanged: () => void modelLists.refresh(),
    contextMenu,
  });
  const refreshPublishersPanel = wirePublishersPanel(settingsBody, { ...subpages, contextMenu });
  const refreshSharingPanel = wireSharingPanel(settingsBody, subpages);
  const refreshMcpServersPanel = wireMcpServersPanel(settingsBody, {
    ...subpages,
    onServersChanged: () => void modelLists.refresh(),
  });

  const refreshShortcutsPanel = wireShortcutsPanel(settingsBody, {
    menus,
    keybindings,
    context: commandContext,
    shortcuts: settings.shortcuts,
    platform: currentPlatform(),
    editorChords: codeMirrorChords(DOCUMENT_KEYMAP, currentPlatform()),
  });

  const settingsView = createSettingsPanel(
    { panel: settingsPanel, railButton: railSettingsButton },
    {
      dialog: () => dialog,
      commands,
      keybindings,
      menus,
      modelLists,
      onShowCategory: {
        files: () => Promise.all([files.refresh(), refreshSharingPanel()]).then(() => {}),
        shortcuts: () => refreshShortcutsPanel(),
        models: () => refreshProvidersPanel(),
        publishing: () => refreshPublishersPanel(),
        "mcp-servers": () => refreshMcpServersPanel(),
        api: () => refreshApiPanel(),
      },
    },
  );

  // The Source Control panel owns its rendering and actions, each bracketing
  // the working tree it shares with the editor (view/sidebar/sourceControl.ts);
  // these are the editor-side hooks it needs.
  wireSourceControlPanel({
    flushPendingSave,
    reloadPaths: (paths) => documents.reloadPaths(paths),
    dropTabsForGonePaths: (paths) => tabs.dropGone(paths),
    refreshTree: () => space.refresh(),
    setWorkspaceLocked: (locked) => {
      // The scrim swallows pointer events; the blur is the keyboard half —
      // a focused CodeMirror keeps taking keys an overlay never sees.
      workspaceScrim.hidden = !locked;
      if (locked && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    },
    trustSpace: (parentRepo) => spaceTrust.askForOpenSpace(parentRepo),
  });

  // The Tools tab's toolkits (view/toolkitPanel.ts). A button runs its Flow on
  // the focused group's document or Table; its Allow/Deny prompt is a host dialog.
  const toolkitTargets = createToolkitTargets({
    focusedPane: () => editorArea.focusedPane(),
    tabs: () => tabs,
    show: (toolkits, path) => toolkitPanel.setToolkits(toolkits, path),
  });
  const toolkitPanel = createToolkitPanel(
    { buttons: buttonList, results: actionResults },
    {
      target: toolkitTargets.target,
      activePath: toolkitTargets.activePath,
      tabs: () => tabs,
      confirm: (options) => dialog.confirm(options),
      reveal: () => inspector.show("tools"),
      start: (invocation, actionId, row) => toolkitRunner.start(invocation, actionId, row),
      contextMenu,
      modelLists,
    },
  );

  // One debounced write queue for every autosave path (services/saveQueue.ts),
  // and the shared document models that schedule saves through it.
  const saveQueue = createSaveQueue({
    putFile,
    onSaved: (path, content) => {
      console.log(`pragma: saved ${path}`);
      gitStatusStore.noteLocalChange();
      space.noteSaved(path, content);
      editorArea.noteSaved(path);
      inspector.refreshFacts(path);
    },
  });
  const documents = createDocuments({ queue: saveQueue, fetchFile });
  const descriptions = createDescriptions({ documents, fetchDescription: getFileDescription });
  saveQueue.subscribe(indicators.renderSave);
  guardUnload(saveQueue);

  // Resolves to the queue's state when something is still unwritten, else
  // undefined. Navigation (switching tabs, opening a file) carries on either
  // way: the content is safe in the queue and the status bar says so. A move
  // and the git actions refuse, and name the file.
  async function flushPendingSave(): Promise<SaveQueueState | undefined> {
    return (await saveQueue.flush()) ? undefined : saveQueue.state();
  }

  // Every modal — a confirmation, a prompt, a pick, or a module's own
  // content — opens through this one service (web/services/dialog.ts).
  const dialog = createDialogService(document.body, { commands, keybindings });
  const spaceTrust = createSpaceTrust({ dialog, fetchSpaceList, postSpaceTrust, store: gitStatusStore });
  const refreshApiPanel = wireApiPanel(settingsBody, {
    dialog,
    openSettingsSubpage: (id) => settingsView.openSubpage(id),
    closeSettingsSubpage: () => settingsView.closeSubpage(),
  });

  // Owns the Manage Spaces dialog and its row actions, including the
  // "Manage Spaces…" command the space switcher lists.
  createSpaceManager({
    commands,
    menus,
    dialog,
    fetchSpaceList,
    switchSpace,
    createMenuButton: (label, target) => createListItemMenuButton(contextMenu, label, target),
    bridge: window.pragmaElectron,
    onRenamed: () => void space.loadName(),
    onClosed: () => menuBar?.refreshSpaces(),
    trust: spaceTrust,
  });
  const toolkitRunner = createToolkitRunner({
    dialog,
    contextMenu,
    loadFile: fetchFile,
    modelConsole,
    notices: fileNotices,
    grant: sandboxGrant,
    revoke: sandboxRevoke,
  });

  // The site dialogs (view/sites.ts): New Site, called from `tree.newSite`,
  // and Site Settings, which registers its own command and menu item. The
  // tree refresh and reveal stay here, since they reach into state it owns.
  const siteDialogs = createSiteDialogs({
    commands,
    menus,
    dialog,
    settings: siteSettingsApi,
    onSiteFileChanged: () => void Promise.all([space.refresh(), websitesView.refresh()]),
    siteImages: spaceTree.imagesUnder,
    createSite: postCreateSite,
    publishers: () => publishers.get(),
    onSiteCreated: async (sitePath) => {
      // The new site folder renders as a child of its parent's list, so a
      // collapsed parent needs expanding first or the reveal-open below finds
      // it hidden.
      collapsed.expand(dirnameOf(sitePath));
      await space.refresh();
      const indexPath = `${sitePath}/index.md`;
      if (space.hasRow(indexPath)) void tabs.openEntry(indexPath);
    },
  });

  // Editor panes are contributions (docs/architecture.md's Workspace and UI ownership section): one
  // module per tab kind registers how to build a pane, and each editor group
  // mounts one at a time into its host. Every tab kind goes through a group,
  // the empty tab included; each pane declares the chrome it needs and its
  // group's chrome applies it.
  const editorPanes = createEditorPanes();
  const paneDeps = { dialog, contextMenu, loadFile: fetchFile, formats };
  const documentPaneDeps = {
    ...paneDeps,
    documents,
    saveQueue,
    treeOrder: spaceTree.inTreeOrder,
    describe: descriptions.read,
    openPath: (path: string, from?: OpenSource) => tabs.openSpacePath(path, { from }),
    openBeside: (path: string) => void tabs.openEntryBeside(path),
    createPropertyEditor,
    tags: tagVocabulary,
    createLinksList,
    revealProperties: () => inspector.show("properties"),
    onSpaceChanged: () => void space.refresh(),
    notify: (message: string) => window.alert(message),
    reportProblems: fileNotices.reportProblems,
    runCommand: (id: string, arg?: unknown) => void commands.run(id, commandContext(), arg),
    shortcutFor: (id: string) => keybindings.labelFor(id),
  };
  editorPanes.register(documentPane({ ...documentPaneDeps, layout: settings.editorLayout }));
  editorPanes.register(appletSourcePane({ ...documentPaneDeps, layout: codeLayout }));
  // Table and Class share a field vocabulary and its editing, so share wiring too.
  const dataPaneDeps = {
    ...paneDeps,
    noteRevision: saveQueue.noteRevision,
    scheduleSave: saveQueue.schedule,
    tabs: () => tabs,
    metadataProperties: () =>
      createMetadataProperties({ createPropertyEditor, contextMenu, dialog, tags: tagVocabulary }),
  };
  editorPanes.register(tablePane({ ...dataPaneDeps, toolkitsRead: toolkitTargets.follow }));
  editorPanes.register(classPane({ ...dataPaneDeps, menus, editProperties: documents.editProperties }));
  editorPanes.register(
    flowPane({
      dialog,
      contextMenu,
      modelLists,
      loadFile: fetchFile,
      formats,
      noteRevision: saveQueue.noteRevision,
      scheduleSave: saveQueue.schedule,
      saveNow: saveQueue.saveNow,
      documentWritten: (path) => void tabs.reloadPath(path),
      modelConsole,
      logEntry: (level, kind, label, content) => modelConsole.logEntry(level, kind, label, content),
      reportProblems: fileNotices.reportProblems,
      metadataProperties: dataPaneDeps.metadataProperties,
      tabs: dataPaneDeps.tabs,
    }),
  );
  for (const media of [...mediaPanes(contextMenu), pdfPane(commands, menus)]) editorPanes.register(media);
  editorPanes.register(findContextPane({ openPath: (path) => void tabs.openSpacePath(path) }));
  editorPanes.register(galleryPane({ commands, menus, contextMenu, tabs: () => tabs, dialog: () => dialog, formats }));
  editorPanes.register(emptyPane({ menus, commands }));
  editorPanes.register(appletPane({ loadFile: fetchFile, injectRuntime: injectAppletRuntime, saveQueue }));
  // The tab session (services/tabs.ts): each group's list and active index,
  // which group has focus, opening a path into a tab, persistence and
  // restore. It reaches the groups and the tree only through these functions.
  const tabs = createTabs({
    documents,
    loadFile: fetchFile,
    loadLayout: fetchLayout,
    saveGroups: postSetGroups,
    flush: flushPendingSave,
    mount: (group, tab, prefetched) => editorArea.mount(group, tab, prefetched),
    renderStrip: (group) => editorArea.renderStrip(group),
    revealInTree: (path) => space.reveal(path),
    notify: (message) => window.alert(message),
    openElsewhere: createDefaultAppMenu({ bridge: window.pragmaElectron, contextMenu, tree: treeNodes }),
    scrollPartner: (group) => editorArea.scrollPartner(group),
  });
  // The editor groups, each with its own chrome and title bar (editorArea.ts).
  const editorArea = createEditorArea({
    ...paneDeps,
    root: editorGroups,
    stripHost: headerTabs,
    panes: editorPanes,
    commands,
    menus,
    keybindings,
    dialog: () => dialog,
    indicators,
    notices: fileNotices,
    inspector,
    tabs,
    split: settings.editorSplit,
    showExtensions: settings.showExtensions,
    moveToTrash: files.moveToTrash,
  });
  createQuickOpen({
    commands,
    menus,
    keybindings,
    contextMenu,
    context: commandContext,
    files: spaceTree.offeredFiles,
    recentPaths: () => tabs.recentPaths(),
    openPath: (path) => void tabs.openSpacePath(path),
  });
  registerShowInFolder(window.pragmaElectron, { commands, menus });
  const menuBar = wireMenuBar({ commands, menus, keybindings, context: commandContext, tabs, files });
  const saveConflicts = createSaveConflicts({
    queue: saveQueue,
    dialog,
    createFile: (dir, name, content) => postCreateEntry(dir, name, "file", content),
    reloadPath: (path) => tabs.reloadPath(path),
    onCopySaved: () => void space.refresh(),
    notify: (message) => window.alert(message),
  });
  followOutsideEdits({ queue: saveQueue, tabs });
  const showTitle = wireWindowTitle(APP_NAME, tabs);

  // Everything outside the groups that follows the focused tab: the
  // copilot's and toolkits' notion of the open document, the inspector, the tree
  // highlight. Nothing here knows a kind beyond whether the tab names a text
  // document or a directory.
  tabs.onFocus((tab) => {
    contextMenu.close();

    toolkitTargets.follow();
    inspector.setTab(tab);
    // Publish/Update only ever applies to a note (Markdown) — Sogma's
    // `content_format` is markdown or html, with no fountain/table/applet counterpart.
    // Nor to one whose frontmatter doesn't parse: it's kept private until fixed.
    const active = tabs.activeDocument();
    contextPanelView.render(
      tab.kind === "document" && tab.documentType === "note" && active?.frontmatterError() === undefined
        ? tab.path
        : undefined,
      active?.properties(),
    );

    // The tree's highlighted row follows the active tab however the switch
    // happened. Only file rows are ever highlighted, so a tab showing no file
    // (blank, a folder's gallery, a Find in context answer) clears it.
    const showsFile = tab.kind !== "empty" && tab.kind !== "gallery" && tab.kind !== "find-context";
    activeRow.set(showsFile ? tab.path : undefined);
  });

  const chat = wireChat({
    chatPick,
    screen: () => chatScreen(workspace, tabs.activePath, editorArea.focusedSelection()),
    flushPendingSave,
    proposeEdit: (edit, onSettled, apply) => editorArea.propose(edit, onSettled, apply),
    revealCreatedEntry: space.revealCreated,
    tabs,
    ...paneDeps,
    trashEntry: space.trash,
  });
  for (const on of [tabs.onActivate, tabs.onFocus, tabs.onGroupClosed]) on(chat.follow);

  // The welcome banner is rendered whether or not the Console is shown, and
  // awaited before tabs are restored: a reopened file writes its problems to
  // the Console, and a banner landing after them would sit below.
  async function loadVersion(): Promise<void> {
    let version = "";
    try {
      const info = await fetchAppletInfo();
      versionRow.show(info);
      version = info.version;
    } catch {
      // Best-effort — the settings row stays blank and the banner omits the version.
    }
    const welcome = document.createElement("div");
    welcome.className = "console-welcome";
    welcome.textContent = version ? `Welcome to ${APP_NAME} v${version}` : `Welcome to ${APP_NAME}`;
    consoleEntries.appendChild(welcome);
  }

  // Both before space.refresh(): its first render reflects the saved folds,
  // and an open from the tree lands among the restored tabs.
  await Promise.all([collapsed.load(), tabs.restore()]);
  sidebarViews.restore();
  await Promise.all([space.loadName(), space.refresh(), loadVersion()]);
  await tabs.showRestored();
  takeLinkRequests(window.pragmaElectron, { tabs, notify: (message) => window.alert(message) });
  editorArea.focusDocumentIfIdle();
  void publishers.refresh();
  files.refresh();
  // Fire-and-forget — /api/git/status runs a `git fetch`, so it must not
  // block first paint; the badge and panel just populate when it lands.
  void gitStatusStore.refresh();
}

void main();
