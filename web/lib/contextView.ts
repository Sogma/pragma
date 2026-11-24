// The guides and look one context's media show, and a surface's hold on
// them. A pane or a preview binds to the context of the tab it shows in and
// hands the bound pair to every player, still and badge it draws, so moving
// to a tab in another context moves them all at once.
import type { Guides, GuidesChoice } from "./videoGuides.ts";
import type { Look, LutChoice } from "./videoLut.ts";

/** A look a menu can try on the picture before it is picked. */
export interface LookChoice extends LutChoice {
  tryLook(lut: string | null): void;
}

/** One context's guides and look, shared by everything seen in it. */
export interface ContextView {
  guides: GuidesChoice;
  look: LookChoice;
}

/** A surface's guides and look, held for whichever context it is bound to. */
export interface ViewBinding extends ContextView {
  context(): string;
  bind(context: string): void;
}

interface Choice<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

// Listeners of the choice `current` names, told as it changes, and told
// again when `current` names another. A listener hears the value as it
// subscribes, as an Emitter's does. The relay listens only while it has
// listeners, so a surface dropped leaves nothing behind.
function relay<T>(current: () => Choice<T>) {
  const listeners = new Set<(value: T) => void>();
  let off: (() => void) | undefined;
  const tell = (value: T) => {
    for (const listener of [...listeners]) listener(value);
  };
  const attach = () => {
    let attaching = true;
    off = current().subscribe((value) => {
      if (!attaching) tell(value);
    });
    attaching = false;
  };
  return {
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      if (!off) attach();
      listener(current().get());
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        off?.();
        off = undefined;
      };
    },
    moved(): void {
      if (!off) return;
      off();
      attach();
      tell(current().get());
    },
  };
}

/** Guides and a look standing for the context last bound, "" until then. */
export function createViewBinding(views: (context: string) => ContextView): ViewBinding {
  let context = "";
  const view = () => views(context);
  const guides = relay<Guides>(() => view().guides);
  const look = relay<Look>(() => view().look);
  return {
    context: () => context,
    bind(next) {
      if (next === context) return;
      context = next;
      guides.moved();
      look.moved();
    },
    guides: {
      get: () => view().guides.get(),
      set: (value) => view().guides.set(value),
      subscribe: guides.subscribe,
    },
    look: {
      get: () => view().look.get(),
      set: (value) => view().look.set(value),
      subscribe: look.subscribe,
      cube: (lut) => view().look.cube(lut),
      kept: () => view().look.kept?.() ?? view().look.get(),
      trying: () => view().look.trying?.() ?? false,
      missing: () => view().look.missing?.() ?? false,
      tryLook: (lut) => view().look.tryLook(lut),
    },
  };
}
