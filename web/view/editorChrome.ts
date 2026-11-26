// The chrome around an editor group's host: the floating toolbar, its
// reading-view toggle, Run button and run count, the overflow menu, and
// where the group's title bar sits. One per group, applying what each pane
// declares on every activation and keeping the live state a declaration
// can't carry: "Add property", and the group's reading view on the toggle.
//
// The toolbar's commands register once and act on the focused group's
// chrome; a press on a toolbar focuses its group before its click runs.

import type { Tab } from "../core/apiClient.ts";
import { activeTitleFor } from "../core/documentContent.ts";
import { isReadOnlyTab } from "../core/paths.ts";
import type { FlowView } from "../flow/xyflowAdapter.ts";
import { buildRunCount, el, iconButton, setRunCount } from "../lib/dom.ts";
import { ROW_CARD_MENU } from "../rowCard.ts";
import type { CommandContext, CommandRegistry } from "../services/commands.ts";
import type { DialogService } from "../services/dialog.ts";
import { type EditorPane, type EditorPaneRegistry, NO_CHROME, type PaneAction } from "../services/editorPanes.ts";
import type { FormatAction, FormatRegistry } from "../services/formats.ts";
import { currentPlatform, type KeybindingRegistry } from "../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuItem, type MenuRegistry } from "../services/menus.ts";
import type { Setting } from "../services/settings.ts";
import type { ContextMenu } from "./contextMenu.ts";
import type { EditorTitleBar } from "./editorTitleBar.ts";
import type { DocumentPane } from "./panes/documentPane.ts";

export type EditorMode = "read" | "edit" | "design";

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><path d="M8.3 5.76Q7 5 7 6.5L7 17.5Q7 19 8.3 18.24L17.7 12.76Q19 12 17.7 11.24Z" /></svg>';
const MENU_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="12" cy="19" r="1.75" /></svg>';

function buildToolbar() {
  // The row the group floats over its host: the mounted pane's aside, then
  // the toolbar's own box with the pane's overlay under it.
  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  const aside = document.createElement("div");
  aside.className = "editor-toolbar-aside";
  const end = document.createElement("div");
  end.className = "editor-toolbar-end";
  const box = document.createElement("div");
  box.className = "floating-toolbar editor-toolbar-box";
  const below = document.createElement("div");
  below.className = "editor-toolbar-below";

  const readingToggle = iconButton("editor-toolbar-reading-toggle", "Switch to reading view");
  readingToggle.setAttribute("aria-pressed", "false");
  const toggleIcon = document.createElement("span");
  toggleIcon.className = "editor-toolbar-toggle-icon";
  readingToggle.append(toggleIcon);

  // Run is Flow's primary action: a labelled
  // solid pill rather than an icon square.
  const flowRun = el("button", "toolbar-action primary-fill flow-run-button");
  flowRun.type = "button";
  flowRun.dataset.tooltip = "Run";
  flowRun.setAttribute("aria-label", "Run");
  flowRun.hidden = true;
  flowRun.innerHTML = `${PLAY_ICON}<span>Run</span>`;

  // A Flow's main view switch, where a note's reading toggle sits, and like
  // it: the icon names where a click goes, the tiles from the graph and the
  // graph's glyph from App mode, and aria-pressed marks App mode.
  const appModeToggle = iconButton("editor-toolbar-app-toggle", "Switch to App mode");
  appModeToggle.setAttribute("aria-pressed", "false");
  appModeToggle.hidden = true;
  const appModeIcon = document.createElement("span");
  appModeIcon.className = "editor-toolbar-toggle-icon editor-toolbar-app-icon";
  appModeToggle.append(appModeIcon);

  const menuButton = iconButton("", "More options");
  menuButton.setAttribute("aria-haspopup", "true");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.innerHTML = MENU_ICON;

  // Where the mounted pane's own controls go.
  const paneControls = document.createElement("div");
  paneControls.className = "editor-toolbar-pane";

  box.append(paneControls, readingToggle, flowRun, appModeToggle, menuButton);
  end.append(box, below);
  toolbar.append(aside, end);
  return { toolbar, aside, box, below, paneControls, readingToggle, flowRun, appModeToggle, menuButton };
}

export interface EditorChromeDeps {
  panes: EditorPaneRegistry;
  contextMenu: ContextMenu;
  titleBar: EditorTitleBar;
  // The group's own active tab and mounted pane, and the flow view behind
  // that pane when it is one; the guard that tells is a view export, so the
  // reader is handed in.
  activeTab(): Tab;
  activePane(): EditorPane | undefined;
  activeFlowView(): FlowView | undefined;
  // The group's reading view, a mode that holds across the files it shows.
  // The group owns it, so its saved layout restores it.
  readingView(): boolean;
  setReadingView(on: boolean): void;
  // Its Source mode, held and restored the same way.
  sourceMode(): boolean;
  setSourceMode(on: boolean): void;
  // What the run count shows: the open Flow's runs, in the inspector.
  showRuns(): void;
  // The group's status bar announcement (Statusbar.announce).
  announce(text: string): () => void;
}

export interface EditorChrome {
  /** The floating toolbar's row, for the group to mount over its host. */
  readonly toolbar: HTMLElement;
  /** Applies `tab`'s pane chrome. Detaches the title bar first: a pane that
   * wants it re-mounts it once its content is in hand (onRendered), and a
   * stale bar must not linger in a now-unmounted pane. */
  activate(tab: Tab): void;
  /** Mounts the group's newly mounted pane's own toolbar controls and its
   * overlays beside and under the box, taking down the last pane's. */
  mountPane(pane: EditorPane | undefined): void;
  /** The sticky mode, or a tab that is read-only regardless of it. */
  isReadingView(): boolean;
  addPropertyAvailable(): boolean;
  setAddPropertyAvailable(available: boolean): void;
  /** Places and fills the title bar for the group's tab: a table's or a
   * folder's name or an applet's manifest name, inside whichever pane's
   * scroll region is showing. An image, empty tab or Find in context has no
   * title; the document pane draws its own editable heading. */
  refreshTitle(): void;
  /** Run becomes an item inside the form while App mode is active, so the
   * toolbar's own copy hides rather than offering two ways to run, and the
   * run count with it. */
  refreshFlowRun(): void;
  /** Switches the mounted Flow between the graph and App mode: the
   * toolbar's toggle and the palette's command alike. */
  toggleAppMode(): void;
  setFlowRuns(count: number): void;
  currentMode(): EditorMode;
  setMode(mode: EditorMode): void;
  toggleReadingView(): void;
  isSourceMode(): boolean;
  toggleSourceMode(): void;
  /** Makes the mounted pane's view its default, and says so in the group's
   * status bar until the view changes from it (viewChanged). */
  setDefaultView(): void;
  /** The mounted pane's view changed: the status bar's "saved" is taken back
   * once the view is no longer the default. */
  viewChanged(): void;
}

export function createEditorChrome(deps: EditorChromeDeps): EditorChrome {
  const { panes, contextMenu } = deps;
  const elements = buildToolbar();
  const runCount = buildRunCount(deps.showRuns);
  elements.flowRun.after(runCount);
  let runs = 0;
  // Takes back the status bar's line that the view shown is the default.
  let takeBackSaved: (() => void) | undefined;

  let addPropertyAvailable = false;

  function isReadingView(): boolean {
    return deps.readingView() || isReadOnlyTab(deps.activeTab());
  }

  function refreshTitle(): void {
    const tab = deps.activeTab();
    const pane = deps.activePane();
    if (tab.kind === "empty" || !pane?.titleHost) {
      deps.titleBar.hide();
      return;
    }
    deps.titleBar.show(activeTitleFor(pane.title(), tab.path), pane.titleHost());
  }

  function refreshFlowRun(): void {
    const flow = deps.activeFlowView();
    elements.flowRun.hidden = !flow || flow.isAppModeActive();
    drawAppModeToggle();
    drawRunCount();
  }

  function drawAppModeToggle(): void {
    const on = deps.activeFlowView()?.isAppModeActive() ?? false;
    elements.appModeToggle.setAttribute("aria-pressed", String(on));
    elements.appModeToggle.setAttribute("aria-label", on ? "Switch to Graph mode" : "Switch to App mode");
  }

  function toggleAppMode(): void {
    deps.activeFlowView()?.toggleAppMode();
    refreshFlowRun();
    // The title bar moves between the canvas (a fixed banner over it) and
    // the App mode pane (scrolls with the form).
    refreshTitle();
  }

  function drawRunCount(): void {
    setRunCount(runCount, elements.flowRun.hidden ? 0 : runs);
  }

  // Reconciles the toggle with the mode, then lets the pane reconcile
  // itself: the document pane swaps its surfaces; table and card re-render
  // in place and re-mount the title bar through onRendered; the
  // rest have no reading view and no refresh.
  function refreshReadingView(): void {
    drawReadingToggle();
    deps.activePane()?.refresh?.();
  }

  // Also drawn on activation: a group restored in reading view never ran
  // setMode, and its toggle would show editing.
  function drawReadingToggle(): void {
    const reading = deps.readingView();
    elements.readingToggle.setAttribute("aria-pressed", String(reading));
    const label = reading ? "Switch to editing" : "Switch to reading view";
    elements.readingToggle.setAttribute("aria-label", label);
  }

  function currentMode(): EditorMode {
    if (isReadingView()) return "read";
    return deps.activePane()?.design?.isActive() ? "design" : "edit";
  }

  // Read, Edit and Design exclude each other, so a mode is set whole, never
  // as two flags that could be left disagreeing by a toggle that only knew
  // about one.
  function setMode(mode: EditorMode): void {
    deps.setReadingView(mode === "read");
    const design = deps.activePane()?.design;
    if (design && design.isActive() !== (mode === "design")) design.toggle();
    refreshReadingView();
    refreshTitle();
  }

  function toggleReadingView(): void {
    setMode(currentMode() === "read" ? "edit" : "read");
  }

  elements.menuButton.addEventListener("click", () => {
    if (contextMenu.isOpen(elements.menuButton)) contextMenu.close();
    else {
      contextMenu.open({
        menu: "editor.toolbar",
        anchor: elements.menuButton,
        align: "end",
        ariaLabel: "More options",
      });
    }
  });
  elements.readingToggle.addEventListener("click", toggleReadingView);
  elements.flowRun.addEventListener("click", () => void deps.activeFlowView()?.run());
  elements.appModeToggle.addEventListener("click", toggleAppMode);

  return {
    toolbar: elements.toolbar,
    activate(tab) {
      deps.titleBar.hide();
      const chrome = panes.get(tab.kind)?.chrome ?? NO_CHROME;
      elements.box.hidden = !chrome.toolbar;
      elements.readingToggle.hidden = !chrome.readingView || isReadOnlyTab(tab);
      drawReadingToggle();
      // Run alone is live state, not static per kind (App mode hides it), so
      // the pane that declares it shows it on render; the chrome only ever
      // clears it.
      if (!chrome.actions.includes("flow-run")) elements.flowRun.hidden = true;
      elements.appModeToggle.hidden = !chrome.actions.includes("flow-app-mode");
      drawAppModeToggle();
      drawRunCount();
    },
    mountPane(pane) {
      if (pane?.toolbar) elements.paneControls.replaceChildren(pane.toolbar);
      else elements.paneControls.replaceChildren();
      if (pane?.toolbarAside) elements.aside.replaceChildren(pane.toolbarAside);
      else elements.aside.replaceChildren();
      if (pane?.toolbarBelow) elements.below.replaceChildren(pane.toolbarBelow);
      else elements.below.replaceChildren();
    },
    isReadingView,
    addPropertyAvailable: () => addPropertyAvailable,
    setAddPropertyAvailable(available) {
      addPropertyAvailable = available;
    },
    refreshTitle,
    refreshFlowRun,
    toggleAppMode,
    setFlowRuns(count) {
      runs = count;
      drawRunCount();
    },
    currentMode,
    setMode,
    toggleReadingView,
    isSourceMode: () => deps.sourceMode(),
    // Apart from Read, Edit and Design: it changes how editing looks, and
    // reading view leaves it as it was.
    toggleSourceMode() {
      deps.setSourceMode(!deps.sourceMode());
      deps.activePane()?.refresh?.();
    },
    setDefaultView() {
      const defaultView = deps.activePane()?.defaultView;
      void defaultView?.set().then((written) => {
        if (written) takeBackSaved = deps.announce("Saved as default view for everyone");
      });
    },
    viewChanged() {
      if (!takeBackSaved || !deps.activePane()?.defaultView?.differs()) return;
      takeBackSaved();
      takeBackSaved = undefined;
    },
  };
}

export interface EditorChromeCommandDeps {
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
  menus: MenuRegistry;
  panes: EditorPaneRegistry;
  dialog(): DialogService;
  // The focused group's chrome, and the typed views behind its pane when it
  // is one of these kinds; the guards that tell are view exports, so the
  // readers are handed in.
  focused(): EditorChrome;
  activeFlowView(): FlowView | undefined;
  activeDocumentPane(): DocumentPane | undefined;
  openAppletCode(path: string): Promise<void>;
  runApplet(path: string): Promise<void>;
  // Each format's actions, which become commands.
  formats: FormatRegistry;
  // Whether a note being edited shows its Format column.
  formatColumn: Setting<boolean>;
}

export function registerEditorChromeCommands(deps: EditorChromeCommandDeps): void {
  const { commands, menus, panes } = deps;

  // Edits the open flow's own displayed name — its `<title>`, the text the
  // title bar and the canvas heading show — not the space path, which is
  // the tree's Rename. A prompt rather than an inline input: there is no
  // tree row here to swap one into.
  //
  // An empty title is allowed: it removes the `<title>`, and the title bar
  // shows the filename again, grey.
  function openFlowRename(context: CommandContext): void {
    const tab = context.tab;
    if (tab.kind !== "flow") return;
    const chrome = deps.focused();
    const flowView = deps.activeFlowView();
    const current = activeTitleFor(flowView?.getFileName(), tab.path);
    void deps.dialog().prompt({
      title: "Title",
      icon: { glyph: "flow" },
      value: current.text,
      placeholder: current.placeholder,
      submitLabel: "Save",
      busyLabel: "Saving…",
      submit: async (value) => {
        const newName = value.trim();
        if (newName === current.text) return;
        const saved = (await flowView?.setDisplayName(newName)) ?? false;
        if (!saved) return "Failed to save the title.";
        chrome.refreshTitle();
      },
    });
  }

  // Each item is a command whose `when` reads the active pane's chrome
  // declaration, or live state only the open menu needs: which side of Edit
  // code the tab is on.
  const chromeAllows = (action: PaneAction) => (context: CommandContext) =>
    panes.get(context.tab.kind)?.chrome.actions.includes(action) ?? false;
  commands.register({
    id: "editor.toggleReadingView",
    label: "Reading view",
    when: (context) => (panes.get(context.tab.kind)?.chrome.readingView ?? false) && !isReadOnlyTab(context.tab),
    run: () => deps.focused().toggleReadingView(),
  });
  // A note's text as written, its formatting off, for the group. Offered
  // only where it changes something: a format that formats, its editor showing.
  commands.register({
    id: "editor.toggleSourceMode",
    label: "Source mode",
    when: () => deps.activeDocumentPane()?.hasSourceMode() ?? false,
    run: () => deps.focused().toggleSourceMode(),
  });
  // The Format column, offered where a document's editor can change. One
  // setting for every group, where Source mode is each group's own.
  commands.register({
    id: "editor.toggleFormat",
    label: "Format",
    when: () => deps.activeDocumentPane()?.formatActions() !== undefined,
    run: () => deps.formatColumn.set(!deps.formatColumn.get()),
  });
  // Every format's actions as commands, for the palette and the keys, each
  // run on the focused document where it applies. A format sharing an id
  // shares its command.
  const formatActions = new Map<string, FormatAction>();
  for (const { format } of deps.formats.list()) {
    for (const action of [...(format.actions?.lines ?? []), ...(format.actions?.marks ?? [])]) {
      if (!formatActions.has(action.id)) formatActions.set(action.id, action);
    }
  }
  for (const [id, action] of formatActions) {
    const command = `format.${id}`;
    commands.register({
      id: command,
      label: action.label,
      when: () => deps.activeDocumentPane()?.formatApplies(id) ?? false,
      run: () => deps.activeDocumentPane()?.applyFormat(id),
    });
    if (action.key) deps.keybindings.register({ key: action.key, command });
  }
  commands.register({
    id: "document.addProperty",
    label: "Add property…",
    when: (context) => chromeAllows("add-property")(context) && deps.focused().addPropertyAvailable(),
    run: () => deps.activeDocumentPane()?.addProperty(),
  });
  // Find's card, as Ctrl+F and Ctrl+H open it: hidden where the pane can't
  // search what it shows, and Replace where the text can't change.
  commands.register({
    id: "document.find",
    label: "Find…",
    when: (context) => context.pane?.findable?.() !== undefined,
    run: (context) => context.pane?.openFind?.(false),
  });
  commands.register({
    id: "document.replace",
    label: "Replace…",
    when: (context) => context.pane?.findable?.() === "replace",
    run: (context) => context.pane?.openFind?.(true),
  });
  // Design is a per-pane mode picked from the menu rather than a toolbar
  // button: the rare, deliberate action stays off the toolbar. Refused on a
  // read-only tab, whose shape is as locked as its values, and offered only
  // where the view shown has a shape to design: never on a Flow's graph.
  function designable(context: CommandContext): boolean {
    return chromeAllows("data-design")(context) && context.pane?.design?.available?.() !== false;
  }
  function toggleDesign(): void {
    const chrome = deps.focused();
    chrome.setMode(chrome.currentMode() === "design" ? "edit" : "design");
  }
  commands.register({
    id: "data.design",
    label: "Design mode",
    when: (context) => designable(context) && !isReadOnlyTab(context.tab),
    run: toggleDesign,
  });
  commands.register({
    id: "flow.appMode",
    label: "App mode",
    when: chromeAllows("flow-app-mode"),
    run: () => deps.focused().toggleAppMode(),
  });
  commands.register({ id: "flow.rename", label: "Title…", when: chromeAllows("flow-rename"), run: openFlowRename });
  commands.register({
    id: "flow.permissions",
    label: "Permissions…",
    when: chromeAllows("flow-permissions"),
    run: () => deps.activeFlowView()?.showPermissionsPanel(),
  });
  commands.register({
    id: "applet.toggleCode",
    label: "Source mode",
    when: (context) => context.tab.kind === "applet" || context.tab.kind === "applet-source",
    run: (context) => {
      if (context.tab.kind === "applet") void deps.openAppletCode(context.tab.path);
      else if (context.tab.kind === "applet-source") void deps.runApplet(context.tab.path);
    },
  });
  // A pane that draws its rows more than one way lists the ways under one
  // heading, each checked while current. A second-level entry rather than
  // a toggle so a third layout is one more line, not a new control. Absent
  // while designing, where the pane's own Layout switches them, and while
  // reading only the switch itself is offered, since nothing about it writes.
  function layoutSubmenu(context: CommandContext): MenuItem[] {
    const layout = context.pane?.layout;
    if (!layout || context.pane?.design?.isActive()) return [];
    return [
      {
        label: "Layout",
        submenu: layout.available().map(({ id, label, group }) => ({
          label,
          group,
          checked: () => layout.current() === id,
          run: () => {
            layout.set(id);
            deps.focused().refreshTitle();
          },
        })),
      },
    ];
  }

  // One row for every kind that keeps a view (EditorPane.defaultView), the
  // label the chrome's and the hover text the pane's. Built as the menu
  // opens, so it shows only while the view shown differs from the default.
  //
  // Setting it leaves the screen as it was, so the group's chrome says in its
  // status bar that it was saved, for as long as that holds.
  function defaultViewItem(context: CommandContext): MenuItem[] {
    const defaultView = context.pane?.defaultView;
    if (!defaultView || isReadOnlyTab(context.tab) || !defaultView.differs()) return [];
    return [{ label: "Set as default view", tooltip: defaultView.tooltip, run: () => deps.focused().setDefaultView() }];
  }

  // Design is the one mode the menu holds: Read and Edit are the toolbar
  // toggle's, and the menu never repeats a toolbar control. Offered while
  // reading too; picking it leaves reading view.
  //
  // A local item, not the command's: a command item hides wherever its
  // `when` fails, and a read-only tab shows Design disabled, saying why the
  // shape is fixed.
  const designItem: MenuItem = {
    label: "Design mode",
    when: designable,
    checked: () => deps.focused().currentMode() === "design",
    disabled: (context) => isReadOnlyTab(context.tab),
    run: toggleDesign,
  };

  // A row's card lies over the pane, its backdrop over this menu's ⋮, so the
  // card's own ⋮ holds the same item.
  menus.register(ROW_CARD_MENU, [designItem]);

  // The occasional modes are checkboxes named for the mode, checked while in
  // it: Source mode, Design mode. A label naming the other view instead would
  // give one command two names across the menu, the palette and Shortcuts.
  // A file's main view switch is the toggle left of ⋮ instead: reading view,
  // or a Flow's App mode, never repeated here.
  menus.register("editor.toolbar", (context) => [
    { command: "editor.toggleFormat", checked: () => deps.formatColumn.get() },
    { command: "editor.toggleSourceMode", checked: () => deps.focused().isSourceMode() },
    ...(deps.activeDocumentPane()?.formatMenu() ?? []),
    designItem,
    ...layoutSubmenu(context),
    { command: "document.addProperty" },
    { command: "flow.rename" },
    { command: "flow.permissions" },
    ...defaultViewItem(context),
    { command: "applet.toggleCode", checked: (context) => context.tab.kind === "applet-source" },
  ]);

  // The toolbar menu's commands, named for a list that has no toolbar
  // beside it to say which document they act on.
  menus.register(COMMAND_PALETTE, [
    { command: "editor.toggleReadingView", label: "Toggle reading view" },
    { command: "editor.toggleSourceMode", label: "Toggle Source mode" },
    { command: "editor.toggleFormat", label: "Toggle Format" },
    ...[...formatActions.values()].map((action) => ({
      command: `format.${action.id}`,
      label: `Format: ${action.label}`,
    })),
    { command: "document.addProperty" },
    { command: "document.find", label: "Find in document…" },
    { command: "document.replace", label: "Replace in document…" },
    { command: "data.design", label: "Toggle Design mode" },
    { command: "applet.toggleCode", label: "Applet: Toggle Source mode" },
    { command: "flow.appMode", label: "Flow: Toggle App mode" },
    { command: "flow.rename", label: "Flow: Title…" },
    { command: "flow.permissions", label: "Flow: Permissions…" },
  ]);
  deps.keybindings.register({ key: "Mod+E", command: "editor.toggleReadingView" });
  // Ctrl+F where no editor takes it first: a rendered page, a Table, a Class.
  // Replace too, on the editor's own key for it (findPanel.ts): Mod+H is
  // macOS's Hide.
  deps.keybindings.register({ key: "Mod+F", command: "document.find" });
  deps.keybindings.register({ key: currentPlatform() === "mac" ? "Mod+Alt+F" : "Mod+H", command: "document.replace" });
}
