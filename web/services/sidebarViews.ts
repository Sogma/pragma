// The sidebar view registry (docs/architecture.md's Workspace and UI ownership section). A
// module builds its panel and rail button and registers here; the shell
// renders rail and sidebar from this registry alone, so neither it nor
// main.ts knows which views exist. This module owns the active view and
// collapsed state and never touches the DOM: the shell mounts `panel`.
import type { Disposable } from "../lib/disposable.ts";
import { Emitter } from "../lib/emitter.ts";
import type { Setting } from "./settings.ts";

/** What a view's rail button shows besides its glyph. */
export interface RailStatus {
  // At the glyph's corner: a count, or a mark that something needs attention.
  badge?: { text: string; tone: "count" | "warning" };
  // A line under the label in the button's title, and in its accessible name.
  detail?: string;
}

export interface SidebarView {
  id: string;
  // Rail button title and accessible name.
  label: string;
  // Inline SVG markup for the rail button — monochrome line-art that
  // inherits `currentColor` (docs/architecture.md's Visual system). Static
  // markup owned by the view module, never user content.
  icon: string;
  panel: HTMLElement;
  // Runs every time the view is activated, including re-activation of the
  // already-active view — the same "refresh on show" the panels did when
  // main.ts switched them by hand.
  onShow?: () => void;
  // A right-click on the rail button, at the pointer: the view opens its own
  // menu there. A view without one leaves the right-click to the page.
  onContextMenu?: (at: { x: number; y: number }) => void;
  // Kept current by the view; the shell draws it on the rail button.
  status?: { subscribe(listener: (status: RailStatus) => void): () => void };
}

export interface SidebarState {
  views: readonly SidebarView[];
  activeId: string | undefined;
  hidden: boolean;
}

export interface SidebarViewsService {
  // Registration order is rail order. The first registered view is the
  // initial active one, unless the remembered view registers — then that
  // one is, silently: nothing is shown until restore(). Registering an id
  // twice throws — two contributions fighting over one rail slot is a bug,
  // not a merge.
  register(view: SidebarView): Disposable;
  // Shows whatever view is active once the bootstrap has loaded what the
  // panels draw from (collapsed folders, most of all). The one activation
  // that registration deliberately does not perform, because a panel shown
  // before that state arrives paints it wrong and stays wrong.
  restore(): void;
  get(): SidebarState;
  subscribe(listener: (state: SidebarState) => void): () => void;
  // Shows `id` (un-collapsing the sidebar if needed) and fires its onShow.
  activate(id: string): void;
  // Rail-click semantics: clicking the active
  // view's icon while the sidebar is showing collapses it; any other click
  // activates that view.
  toggle(id: string): void;
  setHidden(hidden: boolean): void;
  // The header toggle's: hides a showing sidebar, shows a hidden one.
  toggleHidden(): void;
}

export function createSidebarViews(options: {
  hidden: Setting<boolean>;
  active?: Setting<string>;
}): SidebarViewsService {
  const views: SidebarView[] = [];
  const state = new Emitter<SidebarState>({ views: [], activeId: undefined, hidden: options.hidden.get() });
  // Read once, up front. Registration must never write the setting: the
  // first view registers before the remembered one has a chance to, and a
  // write then would overwrite the memory with the default it is meant to
  // override. Only a real activation remembers.
  const remembered = options.active?.get() || undefined;

  function publish(patch: Partial<Omit<SidebarState, "views">>): void {
    const next = { ...state.get(), ...patch, views: [...views] };
    if (next.hidden !== state.get().hidden) options.hidden.set(next.hidden);
    state.set(next);
  }

  function find(id: string): SidebarView {
    const view = views.find((candidate) => candidate.id === id);
    if (!view) throw new Error(`no sidebar view registered with id "${id}"`);
    return view;
  }

  return {
    register(view) {
      if (views.some((existing) => existing.id === view.id)) {
        throw new Error(`sidebar view "${view.id}" is already registered`);
      }
      views.push(view);
      publish({ activeId: view.id === remembered ? view.id : (state.get().activeId ?? view.id) });
      return {
        dispose: () => {
          const index = views.indexOf(view);
          if (index === -1) return;
          views.splice(index, 1);
          const { activeId } = state.get();
          publish({ activeId: activeId === view.id ? views[0]?.id : activeId });
        },
      };
    },
    get: () => state.get(),
    subscribe: (listener) => state.subscribe(listener),
    restore() {
      const { activeId } = state.get();
      if (activeId !== undefined) find(activeId).onShow?.();
    },
    activate(id) {
      const view = find(id);
      publish({ activeId: id, hidden: false });
      options.active?.set(id);
      view.onShow?.();
    },
    toggle(id) {
      const { activeId, hidden } = state.get();
      if (activeId === id && !hidden) publish({ hidden: true });
      else this.activate(id);
    },
    setHidden(hidden) {
      publish({ hidden });
    },
    toggleHidden() {
      publish({ hidden: !state.get().hidden });
    },
  };
}
