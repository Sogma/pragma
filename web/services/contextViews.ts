// Each context's guides and look on this install: read from the server the
// first time something seen in that context shows, and kept there on every
// change. Every surface seen in one context shares its pair, so a pick in
// one shows in all of them while another context's stay as they were. A
// context never picked for shows none.
import { fetchContextView, postContextView } from "../core/apiClient.ts";
import type { ContextView } from "../lib/contextView.ts";
import { Emitter } from "../lib/emitter.ts";
import { type Guides, NO_GUIDES, readGuides } from "../lib/videoGuides.ts";
import { type Look, NO_LOOK, readLook } from "../lib/videoLut.ts";
import { createLookChoice } from "./looks.ts";
import type { Setting } from "./settings.ts";

const views = new Map<string, ContextView>();

/** `context`'s guides and look, shared by every surface seen in it. */
export function contextView(context: string): ContextView {
  let view = views.get(context);
  if (view === undefined) {
    view = readView(context);
    views.set(context, view);
  }
  return view;
}

function readView(context: string): ContextView {
  const guides = keptOnServer<Guides>(NO_GUIDES, (value) => postContextView({ context, guides: value }));
  const look = keptOnServer<Look>(NO_LOOK, (value) => postContextView({ context, look: value }));
  void fetchContextView(context).then(
    (kept) => {
      guides.arrived(readGuides(kept.guides));
      look.arrived(readLook(kept.look));
    },
    () => undefined,
  );
  return { guides: guides.setting, look: createLookChoice(look.setting) };
}

// A setting the server keeps: a change shows at once and goes there in
// order, only the latest of a run of changes once one is on its way, so a
// dragged slider can't land an older value last. What the first read brings
// is passed over once something was picked, so a pick made while it loads
// stands. Best-effort: a failed send costs the pick at the next start.
function keptOnServer<T>(initial: T, send: (value: T) => Promise<void>) {
  const emitter = new Emitter<T>(initial);
  let picked = false;
  let next: { value: T } | undefined;
  let sending = false;
  const pump = async () => {
    sending = true;
    while (next) {
      const { value } = next;
      next = undefined;
      await send(value).catch(() => undefined);
    }
    sending = false;
  };
  const setting: Setting<T> = {
    get: () => emitter.get(),
    set(value) {
      picked = true;
      emitter.set(value);
      next = { value };
      if (!sending) void pump();
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
  return {
    setting,
    arrived(value: T) {
      if (!picked) emitter.set(value);
    },
  };
}
