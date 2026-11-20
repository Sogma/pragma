// One editor group: its tab strip, a host element, and the one mounted pane.
// Panes come from the registry, one instance per kind per group, kept for
// the group's life so switching back to a kind reuses its DOM.
//
// The group only draws the tab list it is handed and reports clicks; the tab
// session (web/services/tabs.ts) owns the model. A drag along or between the
// strips is tabDrag.ts's, which moves pills about and hands them between
// views (detach, attach).
//
// Nothing here may be a singleton — a group is instantiable any number of
// times, and a second group brings its own strip up into the app header's
// tab area.
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import type { FileResponse, Tab } from "../core/apiClient.ts";
import { type EntryIcon, folderTitle, isForeignRootTab, pageKind, stripExtension } from "../core/paths.ts";
import { entryIconAt } from "../core/spaceTree.ts";
import { dateTimeLabel, versionWhen } from "../lib/dateText.ts";
import { must, setEntryIcon } from "../lib/dom.ts";
import type { EditorPane, EditorPaneRegistry, PaneGroup, PaneTabKind } from "../services/editorPanes.ts";

export interface EditorGroupTabCallbacks {
  onSwitch(index: number): void;
  onClose(index: number): void;
  onNew(): void;
  // A right-click on a pill: the tab's own menu.
  onMenu(index: number, event: MouseEvent): void;
}

export interface EditorGroupView {
  // The group's tab strip, rendered into the header's tab area.
  readonly strip: HTMLElement;
  handles(kind: PaneTabKind): boolean;
  // Mounts the pane for `tab.kind` (creating it on first use), unmounting
  // whatever was showing, and hands it the tab. A later open or close while
  // this one is still loading wins: the pane's context reports it is no
  // longer current, and it renders nothing.
  open(tab: Tab, prefetched?: FileResponse): Promise<void>;
  // Unmounts and clears the active pane, if any.
  close(): void;
  activePane(): EditorPane | undefined;
  // Brings the strip in line with the tab list: one pill per tab, in order,
  // the active one marked. A tab already in the strip keeps its pill.
  renderTabs(tabs: readonly Tab[], activeIndex: number): void;
  // Whether the strip shows exactly these tabs, in this order.
  showing(tabs: readonly Tab[]): boolean;
  // The pills in the strip, in order; one a drag has carried out is not.
  pills(): HTMLButtonElement[];
  indexOf(pill: HTMLButtonElement): number;
  // Finishes any motion midway, a width hold or a pill growing or
  // shrinking, so a layout read next is the one that stays.
  settle(): void;
  // Marks the active tab as one of a file's two views that scroll as one
  // (scrollSync.ts), or takes the mark away. It also goes when another tab
  // becomes the active one.
  setScrollSynced(on: boolean): void;
  // Tints the marked tab and its pane while the pointer is on the other
  // side's mark.
  lightScrollPartner(on: boolean): void;
  // A tab a drag has moved to another strip leaves this view's list, pill
  // and all, and joins the other's at `at`: so neither view redraws it.
  detach(index: number): { tab: Tab; pill: HTMLButtonElement };
  attach(tab: Tab, pill: HTMLButtonElement, at: number): void;
  dispose(): void;
}

export interface EditorGroupOptions {
  // Where the group's tab strip is rendered — the app header's tab area.
  stripHost: HTMLElement;
  // Where the group mounts its active pane.
  host: HTMLElement;
  panes: EditorPaneRegistry;
  // Handed to every pane the group creates: the group's own chrome.
  paneGroup: PaneGroup;
  tabs: EditorGroupTabCallbacks;
  // Fires whenever a different pane is mounted, or none is: what shows the
  // pane's own sections in the assistant's inspector follows the pane, not
  // the tab, since two tabs of one kind share one pane.
  onPaneMounted?(pane: EditorPane | undefined): void;
  // The pointer came onto the strip's scroll sync mark, or left it.
  onScrollMarkHover?(over: boolean): void;
}

// A tab's own label is just its filename, extension stripped — the full
// path lives in the pill's title and the status bar, so the pill stays lean.
// A folder's is the title its view shows, so a root a gallery shows, whose
// path has no name of its own, reads as the space or the library's name.
export function tabLabel(tab: Tab): string {
  if (tab.kind === "empty") return "New tab";
  if (tab.kind === "find-context") return "Find in context";
  if (tab.kind === "gallery") return folderTitle(tab.path);
  if (tab.kind === "version") return `${stripExtension(basenameOf(tab.path))} (${versionWhen(tab.version.time)})`;
  return stripExtension(basenameOf(tab.path));
}

function tabTitle(tab: Tab): string {
  if (tab.kind === "empty") return "New tab";
  if (tab.kind === "find-context") return `Find in context: ${tab.path || "(space root)"}`;
  if (tab.kind === "version") return `${tab.path}, kept ${dateTimeLabel(tab.version.time)}`;
  return tab.path;
}

// A tab not shown whose file a page draws previews it while the pointer rests
// on its pill (tabPreview.ts). The pill carries the path for that, as a link
// does, and the preview shows the path in place of the tooltip, which would
// open over it. Only a document's or a Table's tab: a version's shows another
// text.
function previewedPath(tab: Tab, shown: boolean): string | undefined {
  if (shown || (tab.kind !== "document" && tab.kind !== "table")) return undefined;
  return pageKind(tab.path) ? tab.path : undefined;
}

// Writes a data attribute only where it changes, and takes it away for none.
function setData(element: HTMLElement, key: string, value: string | undefined): void {
  if (value === undefined) delete element.dataset[key];
  else if (element.dataset[key] !== value) element.dataset[key] = value;
}

// A file's tab shows the icon its tree row does, and only then: a plain file
// has none, and neither does a folder view, whose path is a folder's.
function tabIcon(tab: Tab): EntryIcon {
  if (tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "gallery") {
    return {};
  }
  return entryIconAt(tab.path, "file");
}

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';
const NEW_TAB_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>';

// A pill arriving or leaving resizes over this. The other pills take their
// widths from the same layout, so only the one moving animates.
const RESIZE: KeyframeAnimationOptions = { duration: 120, easing: "cubic-bezier(0.33, 1, 0.68, 1)" };

// The scroll sync mark pops in when its pair forms. WAAPI, not a keyframe
// rule: a CSS animation restarts each time its pill is moved in the strip.
const POP: KeyframeAnimationOptions = { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1.3)" };
const isSyncMark = (target: EventTarget | null) =>
  target instanceof Element && target.classList.contains("editor-tab-sync");

function buildStrip(callbacks: EditorGroupTabCallbacks): { strip: HTMLDivElement; newTab: HTMLButtonElement } {
  const strip = document.createElement("div");
  strip.className = "editor-group-tabs";
  strip.setAttribute("role", "tablist");
  const newTab = document.createElement("button");
  newTab.type = "button";
  newTab.className = "icon-button editor-group-new-tab";
  newTab.setAttribute("aria-label", "New tab");
  newTab.innerHTML = NEW_TAB_ICON;
  newTab.addEventListener("click", () => callbacks.onNew());
  strip.append(newTab);
  return { strip, newTab };
}

// A pill at no width: no share of the strip, no clamps, no padding, no
// separator.
function collapsed(): Keyframe {
  return {
    flexGrow: 0,
    minWidth: "0px",
    maxWidth: "0px",
    paddingInlineStart: "0px",
    paddingInlineEnd: "0px",
    borderInlineEndWidth: "0px",
  };
}

const px = (value: string): number => Number.parseFloat(value) || 0;

// The room a pill or button takes along the strip: its box and its margins.
function outerWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return el.getBoundingClientRect().width + px(style.marginLeft) + px(style.marginRight);
}

// The pill before this one, past any still shrinking away.
function liveBefore(pill: HTMLElement): Element | null {
  let node = pill.previousElementSibling;
  while (node?.classList.contains("leaving")) node = node.previousElementSibling;
  return node;
}

interface Matched {
  // Aligned with the new tabs: the pill each keeps, or none for one arriving.
  pills: (HTMLButtonElement | undefined)[];
  leaving: HTMLButtonElement[];
  keptCount: number;
}

// A tab still in the strip keeps its pill. A tab in another's place, such as a
// file opened in the current tab or the blank a close leaves, takes over a
// pill from the same run between kept tabs. The rest arrive or leave.
function match(drawnTabs: readonly Tab[], drawnPills: readonly HTMLButtonElement[], tabs: readonly Tab[]): Matched {
  const own = new Map<Tab, HTMLButtonElement>();
  for (const [i, tab] of drawnTabs.entries()) own.set(tab, drawnPills[i]);
  const kept = new Set(tabs.filter((tab) => own.has(tab)));
  // Pills whose tab is gone, keyed by the kept tab before them; null is the front.
  const spare = new Map<Tab | null, HTMLButtonElement[]>();
  let run: Tab | null = null;
  drawnTabs.forEach((tab, i) => {
    if (kept.has(tab)) {
      run = tab;
      return;
    }
    const list = spare.get(run) ?? [];
    list.push(drawnPills[i]);
    spare.set(run, list);
  });
  run = null;
  const pills = tabs.map((tab) => {
    if (kept.has(tab)) {
      run = tab;
      return own.get(tab);
    }
    return spare.get(run)?.shift();
  });
  return { pills, leaving: [...spare.values()].flat(), keptCount: kept.size };
}

interface PillOwner {
  callbacks: EditorGroupTabCallbacks;
  // The pill's place among the tabs, or -1 once its tab is gone.
  indexOf(pill: HTMLButtonElement): number;
  // A press on the pill's ×: the cue for the width hold.
  closing(pill: HTMLButtonElement): void;
}

// Each strip's view, by strip. A pill asks for the strip it is in when a
// listener fires, never the view that built it: a drag can move it to the
// other group's strip, and a pill in the drag's layer answers to no one.
const owners = new WeakMap<Element, PillOwner>();
const ownerOf = (pill: HTMLButtonElement) => (pill.parentElement ? owners.get(pill.parentElement) : undefined);

// Built once per tab. Its listeners look its place up when they fire, since
// the pill moves with its tab from render to render.
function buildPill(): HTMLButtonElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "editor-tab";
  pill.setAttribute("role", "tab");
  pill.tabIndex = -1;

  const label = document.createElement("span");
  label.className = "editor-tab-label";

  // Out of the tab order: Delete on the focused tab closes it.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button editor-tab-close";
  close.setAttribute("aria-label", "Close");
  close.tabIndex = -1;
  close.innerHTML = CLOSE_ICON;
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    const owner = ownerOf(pill);
    const index = owner?.indexOf(pill) ?? -1;
    if (!owner || index === -1) return;
    owner.closing(pill);
    owner.callbacks.onClose(index);
  });

  pill.append(label, close);
  pill.addEventListener("click", () => {
    const owner = ownerOf(pill);
    const index = owner?.indexOf(pill) ?? -1;
    if (owner && index !== -1) owner.callbacks.onSwitch(index);
  });
  pill.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const owner = ownerOf(pill);
    const index = owner?.indexOf(pill) ?? -1;
    if (owner && index !== -1) owner.callbacks.onMenu(index, event);
  });
  return pill;
}

// One tab stop per strip, the active tab's, with the arrow keys moving along
// the row from there: the tablist pattern.
function setSelected(pill: HTMLButtonElement, on: boolean): void {
  pill.classList.toggle("active", on);
  pill.setAttribute("aria-selected", String(on));
  pill.tabIndex = on ? 0 : -1;
}

// Brings a pill in line with its tab, once its selection is set. A kept pill
// is drawn again on every render, so nothing is written that already matches.
function drawPill(pill: HTMLButtonElement, tab: Tab, panelId: string): void {
  // A file outside the space says so on its tab — the stripe's colour is
  // about which root it lives in, not whether it can be edited.
  pill.classList.toggle("foreign-root", isForeignRootTab(tab));
  const previewed = previewedPath(tab, pill.classList.contains("active"));
  setData(pill, "spacePath", previewed);
  setData(pill, "tooltip", previewed === undefined ? tabTitle(tab) : undefined);
  if (panelId && pill.getAttribute("aria-controls") !== panelId) pill.setAttribute("aria-controls", panelId);

  const icon = tabIcon(tab);
  let glyph = pill.querySelector<HTMLElement>(":scope > .editor-tab-icon");
  if (!icon.glyph) {
    glyph?.remove();
  } else {
    if (!glyph) {
      glyph = document.createElement("span");
      glyph.className = "editor-tab-icon";
      glyph.setAttribute("aria-hidden", "true");
      pill.prepend(glyph);
    }
    if (glyph.dataset.entryIcon !== icon.glyph || glyph.hasAttribute("data-scope") !== (icon.scope === true)) {
      setEntryIcon(glyph, icon);
    }
  }

  const label = must<HTMLElement>(":scope > .editor-tab-label", pill);
  const text = tabLabel(tab);
  if (label.textContent !== text) label.textContent = text;
}

export function createEditorGroupView(options: EditorGroupOptions): EditorGroupView {
  const { stripHost, host, panes } = options;
  const instances = new Map<PaneTabKind, EditorPane>();
  let active: EditorPane | undefined;
  let openToken = 0;

  const { strip, newTab } = buildStrip(options.tabs);
  stripHost.append(strip);
  // What the strip last drew, pill for tab. A Tab compares as an object: a
  // file opened in the current tab replaces its Tab, so only switching to a
  // tab that was already here makes the active pill rise (editor-tabs.css).
  let drawnTabs: readonly Tab[] = [];
  let drawnPills: HTMLButtonElement[] = [];
  let drawnActive: Tab | undefined;
  // Pills still growing in, so one closed on the way leaves from where it got to.
  const arrivals = new Map<HTMLButtonElement, Animation>();

  // WAAPI sits outside the stylesheet's reduced-motion override, so the
  // preference is read here.
  const canAnimate = () =>
    typeof strip.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // The width hold: after a press on a ×, the pills keep their width while
  // the pointer stays on the strip, so the next × lands under it. `cap` is
  // every pill's max width, one value on the strip; a strip scrolled to its
  // end holds with a spacer, so its scroll can't clamp.
  let cap: number | undefined;
  let fullCap: number | undefined;
  let letGo: Animation | undefined;
  let spacer: HTMLElement | undefined;
  let spacerWidth = 0;
  const pressed = new Set<HTMLButtonElement>();
  const holding = () => cap !== undefined || spacer !== undefined;

  owners.set(strip, {
    callbacks: options.tabs,
    indexOf: (pill) => drawnPills.indexOf(pill),
    closing: (pill) => pressed.add(pill),
  });

  // The arrow keys select as they move, as an editor's tab bar does.
  strip.addEventListener("keydown", (event) => {
    const pill = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".editor-tab") : null;
    const index = pill ? drawnPills.indexOf(pill) : -1;
    if (index === -1) return;
    const last = drawnPills.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = index > 0 ? index - 1 : last;
        break;
      case "ArrowRight":
        next = index < last ? index + 1 : 0;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Delete":
        event.preventDefault();
        (drawnPills[index + 1] ?? drawnPills[index - 1])?.focus();
        options.tabs.onClose(index);
        return;
      default:
        return;
    }
    event.preventDefault();
    options.tabs.onSwitch(next);
    drawnPills[next].focus();
  });

  // Firefox's rules: the pills keep the width they have; closing the last
  // one widens the rest just enough to keep the strip's width; a strip
  // scrolled to its end grows a spacer by the closed pill. Reads only.
  function planHold(closing: HTMLButtonElement): { cap: number } | { spacer: number } | undefined {
    const at = drawnPills.indexOf(closing);
    if (at === -1 || closing.getBoundingClientRect().width === 0) return undefined;
    const last = at === drawnPills.length - 1;
    if (strip.scrollWidth > strip.clientWidth + 1) {
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
      return last || !atEnd ? undefined : { spacer: outerWidth(closing) };
    }
    if (last && !holding()) return undefined;
    if (fullCap === undefined) {
      const full = Number.parseFloat(getComputedStyle(strip).getPropertyValue("--tab-cap"));
      fullCap = Number.isFinite(full) ? full : Number.POSITIVE_INFINITY;
    }
    const sample = drawnPills.find((pill) => pill !== closing && !arrivals.has(pill)) ?? closing;
    const width = outerWidth(sample);
    const rest = drawnPills.length - 1;
    return { cap: last ? Math.min((width * (rest + 1)) / rest, fullCap) : width };
  }

  function applyHold(plan: { cap: number } | { spacer: number }, animated: boolean): void {
    letGo?.cancel();
    letGo = undefined;
    if ("cap" in plan) {
      cap = plan.cap;
      strip.style.setProperty("--tab-cap", `${cap}px`);
      return;
    }
    const from = spacerWidth;
    spacerWidth += plan.spacer;
    if (!spacer) {
      spacer = document.createElement("span");
      spacer.className = "editor-group-closing-spacer";
      strip.insertBefore(spacer, newTab);
    }
    spacer.style.width = `${spacerWidth}px`;
    // It grows as the closed pill shrinks, so the strip's width never dips.
    if (animated) spacer.animate([{ width: `${from}px` }, { width: `${spacerWidth}px` }], RESIZE);
  }

  // Where `count` pills settle with nothing holding them, worked out from the
  // strip's width rather than laid out to find out.
  function settledWidth(count: number): number {
    const style = getComputedStyle(strip);
    const room =
      strip.getBoundingClientRect().width - px(style.borderLeftWidth) - px(style.borderRightWidth) - outerWidth(newTab);
    const sample = drawnPills.find((pill) => !pill.classList.contains("active")) ?? drawnPills[0];
    let floor = 0;
    if (sample) {
      const pillStyle = getComputedStyle(sample);
      floor = px(pillStyle.minWidth) + px(pillStyle.marginLeft) + px(pillStyle.marginRight);
    }
    return Math.min(fullCap ?? Number.POSITIVE_INFINITY, Math.max(floor, room / Math.max(1, count)));
  }

  // Lets go of the hold, easing the pills to where `count` of them settle.
  function release(count: number, animated: boolean): void {
    if (cap !== undefined) {
      const from = cap;
      const to = animated ? settledWidth(count) : from;
      cap = undefined;
      strip.style.removeProperty("--tab-cap");
      if (animated) {
        const anim = strip.animate([{ "--tab-cap": `${from}px` }, { "--tab-cap": `${to}px` }], {
          ...RESIZE,
          fill: "forwards",
        });
        letGo = anim;
        // Dropped once done: the width it ends on is the one the strip's
        // layout gives with no cap at all.
        const done = () => {
          anim.cancel();
          if (letGo === anim) letGo = undefined;
        };
        anim.finished.then(done, () => {});
      }
    }
    if (spacer) {
      const element = spacer;
      const width = spacerWidth;
      spacer = undefined;
      spacerWidth = 0;
      if (!animated) {
        element.remove();
        return;
      }
      element.style.width = "0px";
      const gone = () => element.remove();
      element.animate([{ width: `${width}px` }, { width: "0px" }], RESIZE).finished.then(gone, gone);
    }
  }

  strip.addEventListener("pointerleave", () => {
    pressed.clear();
    if (holding()) release(drawnPills.length, canAnimate());
  });

  // The tab the scroll sync paired, marked only while it is the active one:
  // a switch takes the mark away at once, before the sync works the pair out
  // again a frame later.
  let syncedTab: Tab | undefined;
  let partnerLit = false;
  let markHovered = false;

  function hoverMark(over: boolean): void {
    if (markHovered === over) return;
    markHovered = over;
    options.onScrollMarkHover?.(over);
  }
  strip.addEventListener("pointerover", (event) => {
    if (isSyncMark(event.target)) hoverMark(true);
  });
  strip.addEventListener("pointerout", (event) => {
    if (isSyncMark(event.target)) hoverMark(false);
  });

  // `formed` pops a mark that arrives; a redraw puts one back without it.
  function drawSyncMarks(formed: boolean): void {
    let marked = false;
    drawnPills.forEach((pill, index) => {
      const on = syncedTab !== undefined && syncedTab === drawnActive && drawnTabs[index] === syncedTab;
      let mark = pill.querySelector<HTMLElement>(":scope > .editor-tab-sync");
      if (on && !mark) {
        mark = document.createElement("span");
        mark.className = "editor-tab-sync";
        mark.dataset.tooltip = "Scrolls with the other side";
        mark.setAttribute("aria-hidden", "true");
        pill.insertBefore(mark, must(":scope > .editor-tab-close", pill));
        if (formed && canAnimate()) mark.animate([{ offset: 0, opacity: 0, scale: "0.4" }], POP);
      } else if (!on && mark) {
        mark.remove();
      }
      pill.classList.toggle("sync-partner", on && partnerLit);
      marked ||= on;
    });
    host.classList.toggle("sync-partner", marked && partnerLit);
    // A mark taken away under the pointer hears no pointerout.
    if (!marked) hoverMark(false);
  }

  function arrive(pill: HTMLButtonElement): void {
    pill.classList.add("resizing");
    const anim = pill.animate([{ offset: 0, ...collapsed() }], RESIZE);
    arrivals.set(pill, anim);
    const settle = () => {
      if (arrivals.get(pill) !== anim) return;
      arrivals.delete(pill);
      pill.classList.remove("resizing");
    };
    anim.finished.then(settle, settle);
  }

  // A closed tab's pill stays a moment to shrink away, inert and out of the
  // strip's list.
  function collapse(pill: HTMLButtonElement): void {
    const arrival = arrivals.get(pill);
    if (arrival) {
      arrivals.delete(pill);
      try {
        arrival.commitStyles();
      } catch {
        // Not rendered: it leaves from its full width instead.
      }
      arrival.cancel();
    }
    pill.classList.remove("active", "rising", "after-slot");
    pill.classList.add("leaving", "resizing");
    pill.inert = true;
    const gone = () => pill.remove();
    pill.animate([collapsed()], { ...RESIZE, fill: "forwards" }).finished.then(gone, gone);
  }

  function instanceFor(kind: PaneTabKind): EditorPane {
    let pane = instances.get(kind);
    if (!pane) {
      const descriptor = panes.get(kind);
      if (!descriptor) throw new Error(`no editor pane registered for "${kind}"`);
      pane = descriptor.create(options.paneGroup);
      instances.set(kind, pane);
    }
    return pane;
  }

  function unmount(): void {
    if (active) {
      active.clearInput();
      active.element.remove();
      active = undefined;
      options.onPaneMounted?.(undefined);
    }
    host.hidden = true;
  }

  return {
    strip,
    handles: (kind) => panes.has(kind),
    async open(tab, prefetched) {
      const token = ++openToken;
      const pane = instanceFor(tab.kind);
      if (active !== pane) {
        if (active) {
          active.clearInput();
          active.element.remove();
        }
        active = pane;
        host.append(pane.element);
        options.onPaneMounted?.(pane);
      }
      host.hidden = false;
      await pane.setInput(tab, { isCurrent: () => openToken === token }, prefetched);
    },
    close() {
      openToken++;
      unmount();
    },
    activePane: () => active,
    renderTabs(tabs, activeIndex) {
      const activeTab = tabs[activeIndex];
      const rises = activeTab !== drawnActive && drawnTabs.includes(activeTab);
      const { pills: kept, leaving, keptCount } = match(drawnTabs, drawnPills, tabs);
      // Nothing moves when no tab stays: a first render, another space, a
      // restored layout.
      const animated = keptCount > 0 && canAnimate();

      // Reads come first, so the hold measures the strip as it was drawn.
      const closedByMouse = leaving.find((pill) => pressed.has(pill));
      const plan = closedByMouse ? planHold(closedByMouse) : undefined;
      for (const pill of leaving) pressed.delete(pill);
      // The hold goes on before any pill leaves. Taking away the pill whose ×
      // has focus can lay the strip out on the spot, and a strip short of its
      // spacer then clamps its scroll for good.
      if (plan) applyHold(plan, animated);
      else if (holding() && (leaving.length > 0 || kept.includes(undefined))) release(tabs.length, animated);
      // Out of the strip's order before the rest is placed: a pill not yet
      // marked would count as live, and every pill after it would be moved in
      // front of it, losing its hover and restarting its rise.
      for (const pill of leaving) {
        if (animated) collapse(pill);
        else pill.remove();
      }

      const next: HTMLButtonElement[] = [];
      const fresh: HTMLButtonElement[] = [];
      // A pill a drag has carried out of the strip is placed by the drag
      // (tabDrag.ts): its gap holds its place in the row until it closes.
      const gap = strip.querySelector<HTMLElement>(":scope > .editor-tab-gap");
      let previous: Element | undefined;
      tabs.forEach((tab, index) => {
        let pill = kept[index];
        if (!pill) {
          pill = buildPill();
          fresh.push(pill);
        }
        setSelected(pill, index === activeIndex);
        pill.classList.toggle("rising", rises && index === activeIndex);
        drawPill(pill, tab, host.id);
        next.push(pill);
        const node = pill.isConnected && !strip.contains(pill) ? gap : pill;
        if (!node) return;
        // Where it is unless it arrived: right after the pill before it, in
        // front of the "+".
        if (!node.isConnected || liveBefore(node) !== (previous ?? null)) {
          if (previous) previous.after(node);
          else strip.prepend(node);
        }
        previous = node;
      });
      if (animated) for (const pill of fresh) arrive(pill);
      drawnTabs = [...tabs];
      drawnPills = next;
      drawnActive = activeTab;
      drawSyncMarks(false);
    },
    showing: (tabs) => tabs.length === drawnTabs.length && tabs.every((tab, index) => tab === drawnTabs[index]),
    pills: () => drawnPills.filter((pill) => pill.parentElement === strip),
    indexOf: (pill) => drawnPills.indexOf(pill),
    settle() {
      if (holding()) release(drawnPills.length, false);
      letGo?.cancel();
      letGo = undefined;
      for (const [pill, anim] of arrivals) {
        anim.cancel();
        pill.classList.remove("resizing");
      }
      arrivals.clear();
      for (const pill of strip.querySelectorAll(".editor-tab.leaving")) pill.remove();
    },
    setScrollSynced(on) {
      const tab = on ? drawnActive : undefined;
      if (tab === syncedTab) return;
      syncedTab = tab;
      if (!tab) partnerLit = false;
      drawSyncMarks(true);
    },
    lightScrollPartner(on) {
      partnerLit = on;
      drawSyncMarks(false);
    },
    detach(index) {
      const tab = drawnTabs[index];
      const pill = drawnPills[index];
      drawnTabs = drawnTabs.filter((_, i) => i !== index);
      drawnPills.splice(index, 1);
      pressed.delete(pill);
      return { tab, pill };
    },
    // The pill arrives active, as it was carried, and the active pill here
    // steps down: what the model draws next matches, so nothing rises.
    attach(tab, pill, at) {
      const was = drawnActive === undefined ? -1 : drawnTabs.indexOf(drawnActive);
      if (was !== -1) {
        setSelected(drawnPills[was], false);
        drawPill(drawnPills[was], drawnTabs[was], host.id);
      }
      const list = [...drawnTabs];
      list.splice(at, 0, tab);
      drawnTabs = list;
      drawnPills.splice(at, 0, pill);
      drawnActive = tab;
      setSelected(pill, true);
      pill.classList.remove("rising");
      drawPill(pill, tab, host.id);
      drawSyncMarks(false);
    },
    dispose() {
      openToken++;
      unmount();
      for (const pane of instances.values()) pane.dispose();
      instances.clear();
      owners.delete(strip);
      strip.remove();
    },
  };
}
