// The assistant column: its width drag, its header toggle, and the inspector
// (Tools, Links, Properties, the tabs modules contribute, then Info, tabbed
// in the app header) over the copilot chat. A plain visibility toggle, unlike
// the sidebar's: no rail views compete for it.
//
// Following the active tab never changes the inspector's view — a switch the
// user did not ask for moves the ground under them. Only an explicit reveal
// does: Add property, or a toolkit run showing its result.
import { type FileInfoResponse, getFileInfo, getFileSha256, type Tab } from "../core/apiClient.ts";
import { isForeignRootTab } from "../core/paths.ts";
import { folderTotalsAt } from "../core/spaceTree.ts";
import { dateTimeLabel } from "../lib/dateText.ts";
import { appendCodeRow, appendMetaRow, createInspectorSection, formatFileSize, iconButton, must } from "../lib/dom.ts";
import { pixelToken, wirePanelResize } from "../lib/panelResize.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { EditorPane } from "../services/editorPanes.ts";
import { type InspectorTab, type InspectorTabsService, inspectorTabs } from "../services/inspectorTabs.ts";
import { currentPlatform, type KeybindingRegistry } from "../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../services/menus.ts";
import type { Setting } from "../services/settings.ts";

export type InspectorView = "info" | "links" | "properties" | "tools";

// In the strip's order: the tabs' bar steps along it by index.
const VIEWS: readonly InspectorView[] = ["tools", "links", "properties", "info"];

export interface InspectorDeps {
  fileInfo(path: string): Promise<FileInfoResponse>;
  // The server's streamed digest of the whole file, as lowercase hex.
  fileSha256(path: string): Promise<string>;
  // What a folder holds, all the way down, in its tree row's words:
  // undefined where the tree counts nothing.
  folderTotals(path: string): string | undefined;
  view: Setting<string>;
  collapsed: Setting<boolean>;
  // Where the inspector/chat split was left, as the inspector's height.
  height: Setting<number | undefined>;
  // Un-hides the whole assistant column, for a reveal.
  showAssistant(): void;
  // The tabs modules contribute, drawn after the inspector's own.
  contributed: InspectorTabsService;
}

export interface Inspector {
  // The active tab changed: redraw the facts for it.
  setTab(tab: Tab): void;
  // The editor group mounted a different pane, or none.
  setPane(pane: EditorPane | undefined): void;
  // `path` changed on disk — a save, a publish. Re-reads its facts if it is
  // the one showing.
  refreshFacts(path: string): void;
  // The space's files changed: an open folder's count is taken again.
  noteSpaceChanged(): void;
  // Shows the assistant, unfolds the inspector and selects `view`.
  show(view: InspectorView): void;
}

// A path on disk, a span per folder (web/styles/assistant.css), so a wrapped
// path breaks between folders, never at a hyphen inside a name that fits.
function pathPieces(path: string): HTMLElement[] {
  return path.split(/(?<=[/\\])/).map((piece) => {
    const span = document.createElement("span");
    span.textContent = piece;
    return span;
  });
}

export function createInspector(deps: InspectorDeps): Inspector {
  const container = must<HTMLElement>("#assistant-inspector");
  // Every tab in the strip's order, the contributed ones before Info.
  const order: string[] = [...VIEWS];
  const tabs: Record<string, HTMLButtonElement> = {
    info: must("#inspector-tab-info"),
    links: must("#inspector-tab-links"),
    properties: must("#inspector-tab-properties"),
    tools: must("#inspector-tab-tools"),
  };
  const panels: Record<string, HTMLElement> = {
    info: must("#inspector-info", container),
    links: must("#inspector-links", container),
    properties: must("#inspector-properties", container),
    tools: must("#inspector-tools", container),
  };
  // Where the mounted pane's own section goes, after the file facts.
  const paneSlot = must<HTMLElement>("#inspector-pane-slot", container);
  // Where the mounted pane's links go.
  const linksSlot = must<HTMLElement>("#inspector-links-slot", container);
  // Where the mounted pane's properties go.
  const propertiesSlot = must<HTMLElement>("#inspector-properties-slot", container);
  // Where the mounted pane's jobs go, in the Tools tab.
  const toolsSlot = must<HTMLElement>("#inspector-tools-slot", container);
  // The drag strip between the inspector and the chat.
  const resizeHandle = must<HTMLElement>("#assistant-split-handle");

  const strip = must<HTMLElement>("#inspector-tabs");
  const contributed = new Map<string, InspectorTab>();
  const remembered = deps.view.get();
  let view: string = VIEWS.find((each) => each === remembered) ?? "info";
  let collapsed = deps.collapsed.get();
  // A contributed tab left selected last time can register after the
  // inspector is built; it takes the selection back when it arrives, unless
  // a tab was picked meanwhile.
  let awaited = VIEWS.some((each) => each === remembered) ? undefined : remembered || undefined;

  // One bar for all the tabs, stepped onto the selected one so a switch
  // slides it there, as the rail's does. .animated waits for the first pick,
  // or launching would slide it onto the restored tab. Folded, no tab is
  // selected and the bar hides, so unfolding shows it in place.
  const bar = document.createElement("div");
  bar.className = "rail-indicator";
  bar.setAttribute("aria-hidden", "true");
  must<HTMLElement>("#inspector-tabs").prepend(bar);

  function apply(): void {
    for (const each of order) {
      const selected = each === view && !collapsed;
      tabs[each].setAttribute("aria-selected", String(selected));
      tabs[each].classList.toggle("active", selected); // .rail-icon's selected look
      const shown = !panels[each].hidden;
      panels[each].hidden = !selected;
      const tab = contributed.get(each);
      if (tab && shown !== selected) (selected ? tab.onShow : tab.onHide)?.();
    }
    bar.hidden = collapsed;
    bar.style.transform = `translateX(${order.indexOf(view) * 100}%)`;
    container.classList.toggle("collapsed", collapsed);
    resizeHandle.hidden = collapsed;
  }

  function select(next: string, fold: boolean): void {
    view = next;
    collapsed = fold;
    awaited = undefined;
    deps.view.set(view);
    deps.collapsed.set(collapsed);
    bar.classList.add("animated");
    apply();
  }

  for (const each of VIEWS) {
    tabs[each].addEventListener("click", () => select(each, each === view && !collapsed));
  }

  // ---- Contributed tabs ----

  // Marked up as the inspector's own tabs are, so the strip's bar and
  // styles treat them alike. Each goes before Info, which stays last.
  function mount(tab: InspectorTab): void {
    const button = iconButton("rail-icon", tab.label);
    button.id = `inspector-tab-${tab.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `inspector-${tab.id}`);
    button.innerHTML = tab.icon;
    button.addEventListener("click", () => select(tab.id, tab.id === view && !collapsed));
    tab.panel.id = `inspector-${tab.id}`;
    tab.panel.classList.add("inspector-panel");
    tab.panel.setAttribute("role", "tabpanel");
    tab.panel.setAttribute("aria-labelledby", button.id);
    tab.panel.hidden = true;
    strip.insertBefore(button, tabs.info);
    container.append(tab.panel);
    order.splice(order.indexOf("info"), 0, tab.id);
    tabs[tab.id] = button;
    panels[tab.id] = tab.panel;
    contributed.set(tab.id, tab);
    if (tab.id === awaited) {
      view = tab.id;
      awaited = undefined;
    }
  }

  function unmount(id: string): void {
    tabs[id].remove();
    panels[id].remove();
    order.splice(order.indexOf(id), 1);
    delete tabs[id];
    delete panels[id];
    if (view === id) {
      contributed.get(id)?.onHide?.();
      view = "info";
    }
    contributed.delete(id);
  }

  // ---- File facts ----

  // Untitled, ahead of the titled sections a pane adds.
  const facts = createInspectorSection();
  facts.section.classList.add("inspector-facts");
  facts.body.className = "meta-rows";
  panels.info.prepend(facts.section);
  const empty = document.createElement("p");
  empty.className = "inspector-empty";
  empty.textContent = "No file open.";
  panels.info.prepend(empty);

  let factsPath: string | undefined;
  let factsToken = 0;
  let entryName: HTMLElement | undefined;
  let systemFolder: HTMLElement | undefined;
  let size: HTMLElement | undefined;
  let contains: HTMLElement | undefined;
  let modified: HTMLElement | undefined;
  let sha256: HTMLElement | undefined;

  // Counted from the tree the app holds, not read with the other facts, so
  // it never disagrees with the folder's tree row; hidden while that counts
  // nothing.
  function countContents(): void {
    const row = contains?.parentElement;
    if (!contains || !row || factsPath === undefined) return;
    const totals = deps.folderTotals(factsPath);
    row.hidden = totals === undefined;
    contains.textContent = totals ?? "";
  }

  // Leaves the rows as they are while the lookups run, so a refresh after a
  // save changes a value in place instead of blinking it back to "…". The
  // hash is never awaited with the stat: a large take takes seconds to hash,
  // and Size and Modified must not wait on it.
  function fillFacts(path: string): void {
    const token = ++factsToken;
    const current = () => token === factsToken;
    deps.fileInfo(path).then(
      (info) => {
        if (!current()) return;
        if (entryName) entryName.textContent = info.name;
        if (systemFolder && info.systemFolder !== undefined) {
          systemFolder.replaceChildren(...pathPieces(info.systemFolder));
        } else {
          systemFolder?.parentElement?.remove();
        }
        if (size) size.textContent = formatFileSize(info.size);
        if (modified) modified.textContent = dateTimeLabel(info.modified);
      },
      () => {
        if (!current()) return;
        if (entryName) entryName.textContent = "Unknown";
        if (systemFolder) systemFolder.textContent = "Unknown";
        if (size) size.textContent = "Unknown";
        if (modified) modified.textContent = "Unknown";
      },
    );
    if (!sha256) return;
    deps.fileSha256(path).then(
      (digest) => {
        if (current() && sha256) sha256.textContent = digest;
      },
      () => {
        if (current() && sha256) sha256.textContent = "Unknown";
      },
    );
  }

  // ---- Links ----

  // Said by the inspector only when the pane lists no links of its own; a
  // pane that does says when its document links nowhere.
  const linksEmpty = document.createElement("p");
  linksEmpty.className = "inspector-empty";
  panels.links.prepend(linksEmpty);
  let paneLinks: HTMLElement | undefined;

  function applyLinksEmpty(): void {
    linksEmpty.hidden = paneLinks !== undefined;
    linksEmpty.textContent = factsPath === undefined ? "No file open." : "Links are listed for notes and screenplays.";
  }
  applyLinksEmpty();

  // ---- Properties ----

  // Shown until the mounted pane shows properties, which the stylesheet
  // decides: the pane hides its own element for a document that can keep none.
  const propertiesEmpty = document.createElement("p");
  propertiesEmpty.className = "inspector-empty";
  panels.properties.prepend(propertiesEmpty);
  let paneProperties: HTMLElement | undefined;

  function applyPropertiesEmpty(): void {
    propertiesEmpty.textContent =
      factsPath === undefined ? "No file open." : "Properties are kept for notes, Tables, Flows and Classes.";
  }
  applyPropertiesEmpty();

  // ---- Empty tabs ----

  // A tab dims while its panel has nothing to show, and stays clickable. Each
  // part says so on its own element — `hidden`, or `data-empty` — and only
  // the mounted pane's parts are watched, so a pane in an unfocused group
  // never reaches the tabs. Info always has the file's facts.
  const toolsParts = [must<HTMLElement>("#context-panel", container), must<HTMLElement>("#button-list", container)];
  let paneTools: HTMLElement | undefined;
  const shows = (part: HTMLElement | undefined) =>
    part !== undefined && !part.hidden && !part.hasAttribute("data-empty");

  function applyEmptyTabs(): void {
    const open = factsPath !== undefined;
    const shown: Record<InspectorView, boolean> = {
      tools: open && (toolsParts.some(shows) || shows(paneTools)),
      links: open && shows(paneLinks),
      properties: open && shows(paneProperties),
      info: open,
    };
    for (const each of VIEWS) tabs[each].classList.toggle("empty", !shown[each]);
  }

  // How many runs the Tools tab's parts say are going, a Flow's or a note's
  // toolkit's, on the tab as a rail view's count is: the badge is hidden from
  // assistive tech, and the count joins the tab's name instead.
  function applyToolsBadge(): void {
    const running = [paneTools, ...toolsParts].reduce(
      (sum, part) => sum + Number(part?.getAttribute("data-running") ?? 0),
      0,
    );
    const tab = tabs.tools;
    const detail = running > 0 ? `${running} running` : "";
    if (detail) tab.dataset.tooltip = `Tools\n${detail}`;
    else delete tab.dataset.tooltip;
    tab.setAttribute("aria-label", detail ? `Tools: ${detail}` : "Tools");
    let badge = tab.querySelector<HTMLElement>(".rail-badge");
    if (!detail) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "count-badge rail-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.append(document.createElement("span"));
      tab.append(badge);
    }
    (badge.firstElementChild as HTMLElement).textContent = String(running);
  }

  function applyParts(): void {
    applyEmptyTabs();
    applyToolsBadge();
  }

  const partWatcher = new MutationObserver(applyParts);
  function watchParts(): void {
    partWatcher.disconnect();
    for (const part of [...toolsParts, paneTools, paneLinks, paneProperties]) {
      if (part) {
        partWatcher.observe(part, { attributes: true, attributeFilter: ["hidden", "data-empty", "data-running"] });
      }
    }
    applyParts();
  }
  watchParts();

  function setTab(tab: Tab): void {
    for (const each of contributed.values()) each.setTab?.(tab);
    // The bar takes the colour of the tab's stripe, from the same test, so
    // the two never disagree about where the file lives.
    bar.classList.toggle("foreign-root", isForeignRootTab(tab));
    factsToken++;
    facts.body.replaceChildren();
    entryName = systemFolder = size = contains = modified = sha256 = undefined;
    factsPath = tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version" ? undefined : tab.path;
    facts.section.hidden = factsPath === undefined;
    empty.hidden = factsPath !== undefined;
    applyLinksEmpty();
    applyPropertiesEmpty();
    applyEmptyTabs();
    if (factsPath === undefined) return;

    // Name is the whole name, extension included, which the tab and the tree
    // hide unless Show extensions is on; Path is the folder holding it on
    // disk. A folder's byte count is its directory entry's, not its
    // contents', and it has no bytes of its own to hash: in Size's place it
    // says what it holds.
    const isFolder = tab.kind === "gallery";
    entryName = appendMetaRow(facts.body, "Name", "…");
    entryName.classList.add("meta-name");
    systemFolder = appendMetaRow(facts.body, "Path", "…");
    systemFolder.classList.add("meta-path");
    if (isFolder) contains = appendMetaRow(facts.body, "Contains", "");
    else size = appendMetaRow(facts.body, "Size", "…");
    modified = appendMetaRow(facts.body, "Modified", "…");
    if (!isFolder) sha256 = appendCodeRow(facts.body, "SHA-256", "…");
    countContents();
    fillFacts(factsPath);
  }

  // ---- The inspector/chat split ----

  const minHeight = pixelToken("--inspector-min-height");
  const chatMinHeight = pixelToken("--assistant-chat-min-height");
  const setHeight = (px: number) => container.style.setProperty("--inspector-height", `${px}px`);
  // Restored without a cap: in a shorter window the stylesheet shrinks the
  // inspector, and the chat keeps its floor.
  const savedHeight = deps.height.get();
  if (savedHeight !== undefined) setHeight(Math.max(minHeight, savedHeight));
  wirePanelResize({
    handle: resizeHandle,
    axis: "ns",
    minSize: minHeight,
    beginDrag: () => {
      const top = container.getBoundingClientRect().top;
      const bottom = container.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight;
      const max = bottom - top - chatMinHeight;
      return (moveEvent) => Math.min(max, moveEvent.clientY - top);
    },
    apply: setHeight,
    commit: (px) => deps.height.set(px),
  });

  // Last, so the tabs registered before the inspector mount into a strip
  // whose own state is already set up.
  deps.contributed.subscribe((list) => {
    for (const id of [...contributed.keys()]) if (!list.some((tab) => tab.id === id)) unmount(id);
    for (const tab of list) if (!contributed.has(tab.id)) mount(tab);
    apply();
  });

  return {
    setTab,
    setPane(pane) {
      paneSlot.replaceChildren(...(pane?.inspector ? [pane.inspector] : []));
      linksSlot.replaceChildren(...(pane?.links ? [pane.links] : []));
      propertiesSlot.replaceChildren(...(pane?.properties ? [pane.properties] : []));
      toolsSlot.replaceChildren(...(pane?.tools ? [pane.tools] : []));
      paneLinks = pane?.links;
      paneProperties = pane?.properties;
      paneTools = pane?.tools;
      applyLinksEmpty();
      watchParts();
    },
    refreshFacts(path) {
      if (path === factsPath) fillFacts(path);
    },
    noteSpaceChanged: countContents,
    show(next) {
      deps.showAssistant();
      select(next, false);
    },
  };
}

// Named as the settings module names them: main.ts hands in the module itself.
export interface AssistantPanelSettings {
  assistantHidden: Setting<boolean>;
  assistantWidth: Setting<number | undefined>;
  inspectorView: Setting<string>;
  inspectorCollapsed: Setting<boolean>;
  inspectorHeight: Setting<number | undefined>;
}

export function wireAssistantPanel(
  settings: AssistantPanelSettings,
  deps: { commands: CommandRegistry; keybindings: KeybindingRegistry; menus: MenuRegistry },
): Inspector {
  const container = must<HTMLElement>("#assistant");
  const resizeHandle = must<HTMLDivElement>("#assistant-resize-handle");
  const headerToggle = must<HTMLButtonElement>("#header-assistant-toggle");
  // The header's share of the column: the inspector's tabs, over it.
  const headerRegion = must<HTMLElement>("#header-assistant");

  // Built before the floor is read, so its contributed tabs are in the strip
  // whose width the floor follows.
  const inspector = createInspector({
    fileInfo: getFileInfo,
    fileSha256: getFileSha256,
    folderTotals: folderTotalsAt,
    view: settings.inspectorView,
    collapsed: settings.inspectorCollapsed,
    height: settings.inspectorHeight,
    showAssistant: () => setHidden(false),
    contributed: inspectorTabs,
  });

  // The floor is --assistant-min-width (web/styles/scale.css), a fixed token,
  // not the panel's own current width — measuring that would stop the panel
  // ever shrinking below its CSS default. The width goes to --assistant-width,
  // not the column's own style, so the header region follows it.
  //
  // It rises to the width the header region needs, its min-width: a column
  // narrower than that leaves the header's line off the column's edge. Read
  // with the region at no width, so its min-width is what lays out, and before
  // the saved state can fold it: folded, its tabs don't count.
  headerRegion.style.width = "0";
  const floor = Math.max(pixelToken("--assistant-min-width"), headerRegion.getBoundingClientRect().width);
  headerRegion.style.removeProperty("width");
  const setWidth = (px: number) => document.documentElement.style.setProperty("--assistant-width", `${px}px`);
  // Restored after the sidebar, so the editor's left edge already sits where
  // the sidebar's restored width put it. A width saved in a wider window gives
  // way to both until the editor keeps its minimum. The stylesheet's default
  // gives way to the floor.
  const saved = settings.assistantWidth.get();
  if (saved !== undefined) {
    const editorLeft = must<HTMLElement>("#editor").getBoundingClientRect().left;
    const room = window.innerWidth - editorLeft - pixelToken("--editor-group-min-width");
    setWidth(Math.max(floor, Math.min(saved, room)));
  } else if (pixelToken("--assistant-width") < floor) {
    setWidth(floor);
  }
  // A width the drag hands back while the column is hidden, put on as it
  // next opens: put on at once, it would jump the slide-out still under way.
  let reopenWidth: number | undefined;
  wirePanelResize({
    handle: resizeHandle,
    axis: "ew",
    minSize: floor,
    beginDrag: () => (moveEvent) => window.innerWidth - moveEvent.clientX,
    apply: (px) => {
      if (container.hidden) reopenWidth = px;
      else setWidth(px);
    },
    commit: (px) => settings.assistantWidth.set(px),
    hide: {
      isHidden: () => Boolean(container.hidden),
      setHidden,
      size: () => pixelToken("--assistant-width"),
    },
  });

  // .animated carries the open/close slide's transitions, and only a toggle
  // adds it: on the state restored at startup it would slide the column into
  // place on every launch.
  function setHidden(hidden: boolean, animate = true): void {
    if (animate) {
      container.classList.add("animated");
      headerRegion.classList.add("animated");
    }
    if (!hidden && reopenWidth !== undefined) {
      setWidth(reopenWidth);
      reopenWidth = undefined;
    }
    container.hidden = hidden;
    resizeHandle.hidden = hidden;
    headerRegion.classList.toggle("collapsed", hidden);
    headerToggle.setAttribute("aria-pressed", String(!hidden));
    settings.assistantHidden.set(hidden);
  }
  headerToggle.addEventListener("click", () => setHidden(!container.hidden));
  setHidden(settings.assistantHidden.get(), false);

  // The header toggle as a command, for the palette, a key and the menu bar.
  deps.commands.register({
    id: "assistant.toggle",
    label: "Toggle Assistant",
    run: () => setHidden(!container.hidden),
  });
  deps.menus.register(COMMAND_PALETTE, [{ command: "assistant.toggle" }]);
  if (currentPlatform() === "mac") deps.keybindings.register({ key: "Alt+Meta+B", command: "assistant.toggle" });

  return inspector;
}
