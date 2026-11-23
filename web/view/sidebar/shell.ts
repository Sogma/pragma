// The rail and the sidebar container, rendered from the sidebar view
// registry (web/services/sidebarViews.ts) and nothing else; it knows no view
// by name. It owns all sidebar chrome that isn't a view: the rail buttons and
// bar, the showing panel, the collapsed state and its three mirrors (resize
// handle, header spacer, header toggle's aria-pressed), and the resize drag.
import { DisposableStore, listen, toDisposable } from "../../lib/disposable.ts";
import { iconButton } from "../../lib/dom.ts";
import { pixelToken, wirePanelResize } from "../../lib/panelResize.ts";
import type { CommandRegistry } from "../../services/commands.ts";
import { currentPlatform, type KeybindingRegistry } from "../../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../../services/menus.ts";
import type { Setting } from "../../services/settings.ts";
import type { RailStatus, SidebarState, SidebarView, SidebarViewsService } from "../../services/sidebarViews.ts";

export interface SidebarShellElements {
  rail: HTMLElement;
  // View buttons are inserted before this element, in registration order.
  // Settings sits below them and is not a view.
  railTail: HTMLElement;
  sidebar: HTMLElement;
  resizeHandle: HTMLElement;
  headerToggle: HTMLButtonElement;
  // Reserves the sidebar's width in the app header so the editor groups'
  // tab strips line up with the groups; collapses with the sidebar. Both
  // read the shared --sidebar-width token, which is why the drag below
  // writes that token rather than an element width.
  headerSpacer: HTMLElement;
}

function createRailButton(view: SidebarView): HTMLButtonElement {
  const button = iconButton("rail-icon", view.label);
  button.dataset.tooltipSide = "right";
  button.dataset.view = view.id;
  button.innerHTML = view.icon;
  return button;
}

// The badge is hidden from assistive tech: the detail, which says what it
// counts, joins the accessible name instead. Its text sits in an inner span
// because that is the box the stylesheet trims to the digits.
function renderRailStatus(button: HTMLButtonElement, view: SidebarView, status: RailStatus): void {
  if (status.detail) button.dataset.tooltip = `${view.label}\n${status.detail}`;
  else delete button.dataset.tooltip;
  button.setAttribute("aria-label", status.detail ? `${view.label}: ${status.detail}` : view.label);
  let badge = button.querySelector<HTMLElement>(".rail-badge");
  if (!status.badge) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "count-badge rail-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.append(document.createElement("span"));
    button.append(badge);
  }
  badge.classList.toggle("warning", status.badge.tone === "warning");
  (badge.firstElementChild as HTMLElement).textContent = status.badge.text;
}

export function createSidebarShell(
  elements: SidebarShellElements,
  sidebarViews: SidebarViewsService,
  width: Setting<number | undefined>,
): DisposableStore {
  const store = new DisposableStore();
  const buttons = new Map<string, HTMLButtonElement>();
  const statusSubscriptions = new Map<string, () => void>();
  // One bar for every view, moved onto the active button so a switch slides
  // it there. .animated waits for the first move: the first placement is the
  // restored view, and sliding to it from the rail's top would play on every
  // launch.
  const indicator = document.createElement("div");
  indicator.className = "rail-indicator";
  elements.rail.append(indicator);
  let placed: HTMLButtonElement | undefined;

  function placeIndicator(button: HTMLButtonElement | undefined): void {
    indicator.hidden = !button;
    if (!button) return;
    if (placed && placed !== button) indicator.classList.add("animated");
    placed = button;
    indicator.dataset.view = button.dataset.view;
    indicator.style.height = `${button.offsetHeight}px`;
    indicator.style.transform = `translateY(${button.offsetTop}px)`;
  }

  // Reconciles the rail against the registry: a button per view in
  // registration order, panels parented under the sidebar. Re-inserting an
  // existing button before the tail is what keeps order correct when a view
  // registers late.
  function syncViews(views: readonly SidebarView[]): void {
    for (const [id, button] of buttons) {
      if (!views.some((view) => view.id === id)) {
        button.remove();
        buttons.delete(id);
        statusSubscriptions.get(id)?.();
        statusSubscriptions.delete(id);
      }
    }
    for (const view of views) {
      let button = buttons.get(view.id);
      if (!button) {
        const created = createRailButton(view);
        button = created;
        buttons.set(view.id, button);
        store.add(listen(button, "click", () => sidebarViews.toggle(view.id)));
        const { onContextMenu } = view;
        if (onContextMenu) {
          store.add(
            listen(button, "contextmenu", (event) => {
              if (!(event instanceof MouseEvent)) return;
              event.preventDefault();
              onContextMenu({ x: event.clientX, y: event.clientY });
            }),
          );
        }
        const unsubscribe = view.status?.subscribe((status) => renderRailStatus(created, view, status));
        if (unsubscribe) statusSubscriptions.set(view.id, unsubscribe);
      }
      elements.rail.insertBefore(button, elements.railTail);
      if (view.panel.parentElement !== elements.sidebar) elements.sidebar.append(view.panel);
    }
  }

  // .animated carries the open/close slide's transitions, and only a render
  // that changes the collapsed state adds it: the first render restores the
  // saved state, and with it there the sidebar would slide in on every launch.
  let shownHidden: boolean | undefined;
  // A width the drag hands back while the sidebar is hidden, put on as it
  // next opens: put on at once, it would jump the slide-out still under way.
  let reopenWidth: number | undefined;

  function render(state: SidebarState): void {
    syncViews(state.views);
    for (const view of state.views) {
      const active = view.id === state.activeId;
      buttons.get(view.id)?.classList.toggle("active", active);
      view.panel.hidden = !active;
    }
    placeIndicator(state.activeId === undefined ? undefined : buttons.get(state.activeId));
    if (shownHidden !== undefined && shownHidden !== state.hidden) {
      elements.sidebar.classList.add("animated");
      elements.headerSpacer.classList.add("animated");
    }
    shownHidden = state.hidden;
    if (!state.hidden && reopenWidth !== undefined) {
      setWidth(reopenWidth);
      reopenWidth = undefined;
    }
    elements.sidebar.hidden = state.hidden;
    elements.resizeHandle.hidden = state.hidden;
    elements.headerSpacer.classList.toggle("collapsed", state.hidden);
    elements.headerToggle.setAttribute("aria-pressed", String(!state.hidden));
  }

  store.add(sidebarViews.subscribe(render));
  store.add(
    toDisposable(() => {
      for (const unsubscribe of statusSubscriptions.values()) unsubscribe();
    }),
  );
  store.add(listen(elements.headerToggle, "click", () => sidebarViews.toggleHidden()));

  // Drag-to-resize on the sidebar's trailing edge. Writes --sidebar-width
  // itself so the header spacer follows for free, clamped to the fixed
  // --sidebar-min-width token (not to the current width, which is this
  // drag's own output).
  const floor = pixelToken("--sidebar-min-width");
  const setWidth = (px: number) => document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
  // A width saved in a wider window is capped so the editor beside it keeps
  // its minimum. The cap leaves the assistant out on purpose: restored after
  // the sidebar, it is the panel that gives way when the two leave too little.
  const saved = width.get();
  if (saved !== undefined) {
    const room = window.innerWidth - pixelToken("--rail-width") - pixelToken("--editor-group-min-width");
    setWidth(Math.max(floor, Math.min(saved, room)));
  }
  store.add(
    wirePanelResize({
      handle: elements.resizeHandle,
      axis: "ew",
      minSize: floor,
      // The sidebar's own left edge is where its width is measured from, and
      // a width drag can't move it, so it is read once per drag rather than
      // per mousemove.
      beginDrag: () => {
        const left = elements.sidebar.getBoundingClientRect().left;
        return (moveEvent) => moveEvent.clientX - left;
      },
      apply: (px) => {
        if (sidebarViews.get().hidden) reopenWidth = px;
        else setWidth(px);
      },
      commit: (px) => width.set(px),
      hide: {
        isHidden: () => sidebarViews.get().hidden,
        setHidden: (hidden) => sidebarViews.setHidden(hidden),
        size: () => pixelToken("--sidebar-width"),
      },
    }),
  );

  return store;
}

/** The header toggle as a command, for the palette, a key and the menu bar. */
export function registerSidebarCommands(
  sidebarViews: SidebarViewsService,
  deps: { commands: CommandRegistry; keybindings: KeybindingRegistry; menus: MenuRegistry },
): void {
  deps.commands.register({ id: "sidebar.toggle", label: "Toggle Sidebar", run: () => sidebarViews.toggleHidden() });
  deps.menus.register(COMMAND_PALETTE, [{ command: "sidebar.toggle" }]);
  // macOS's own key for a sidebar.
  if (currentPlatform() === "mac") deps.keybindings.register({ key: "Ctrl+Meta+S", command: "sidebar.toggle" });
}
