// The inspector's contributed tabs (docs/architecture.md's Workspace and UI ownership
// section). A module builds a panel and a tab glyph and registers here; the
// inspector draws each before Info, its last tab, in registration order, and
// knows none by name. This module owns the list and never touches the DOM.
import type { Tab } from "../core/apiClient.ts";
import type { Disposable } from "../lib/disposable.ts";
import { Emitter } from "../lib/emitter.ts";

export interface InspectorTab {
  id: string;
  // The tab's tooltip and accessible name.
  label: string;
  // Inline SVG for the tab: line-art at stroke 1.5 inheriting `currentColor`,
  // as the inspector's own tabs are drawn. Static markup owned by the module.
  icon: string;
  panel: HTMLElement;
  // The focused group's active tab, each time it changes.
  setTab?(tab: Tab): void;
  // The tab was selected, or another was: a panel that draws continuously
  // stops while it can't be seen.
  onShow?(): void;
  onHide?(): void;
}

export interface InspectorTabsService {
  // Registering an id twice throws: two contributions in one slot is a bug.
  register(tab: InspectorTab): Disposable;
  // Fires at once with the tabs registered so far, then on every change.
  subscribe(listener: (tabs: readonly InspectorTab[]) => void): () => void;
}

export function createInspectorTabs(): InspectorTabsService {
  const tabs = new Emitter<readonly InspectorTab[]>([]);
  return {
    register(tab) {
      if (tabs.get().some((each) => each.id === tab.id))
        throw new Error(`inspector tab "${tab.id}" is already registered`);
      tabs.set([...tabs.get(), tab]);
      return { dispose: () => tabs.set(tabs.get().filter((each) => each !== tab)) };
    },
    subscribe: (listener) => tabs.subscribe(listener),
  };
}

export const inspectorTabs = createInspectorTabs();
