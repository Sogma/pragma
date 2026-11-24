import { describe, expect, it } from "vitest";
import { type ContextView, createViewBinding } from "../../../web/lib/contextView.ts";
import { type Guides, NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { NO_LOOK } from "../../../web/lib/videoLut.ts";
import { memoryViews } from "../support/editorLayout.ts";

describe("a surface's guides and look", () => {
  it("stand for the context last bound, the space's until then", () => {
    const held = memoryViews();
    const view = createViewBinding(held.views);
    expect(view.context()).toBe("");
    view.guides.set({ ...NO_GUIDES, title: true });
    expect(held.of("").guides.get().title).toBe(true);

    view.bind("projects/film");
    expect([view.context(), view.guides.get()]).toEqual(["projects/film", NO_GUIDES]);
    view.look.set({ lut: "panchromatic", on: true });
    expect(held.of("projects/film").look.get()).toEqual({ lut: "panchromatic", on: true });
    expect(held.of("").look.get()).toEqual(NO_LOOK);
    view.look.tryLook("orthochromatic");
    expect(held.of("projects/film").look.tryLook).toHaveBeenCalledWith("orthochromatic");
  });

  it("tell a listener as it subscribes, as the bound context's change, and as another is bound", () => {
    const held = memoryViews();
    held.of("b").guides.set({ ...NO_GUIDES, frames: ["2.39"] });
    const view = createViewBinding(held.views);
    const heard: string[][] = [];
    const stop = view.guides.subscribe((guides) => heard.push([...guides.frames]));
    held.of("").guides.set({ ...NO_GUIDES, frames: ["9:16"] });
    view.bind("b");
    // The context left behind is heard no more.
    held.of("").guides.set({ ...NO_GUIDES, frames: ["1:1"] });
    expect(heard).toEqual([[], ["9:16"], ["2.39"]]);

    stop();
    held.of("b").guides.set(NO_GUIDES);
    expect(heard).toHaveLength(3);
  });

  // A pane or preview dropped leaves nothing listening in a context's pair.
  it("listen to the context only while someone listens to them", () => {
    let listening = 0;
    const guides = {
      get: () => NO_GUIDES,
      set: (_: Guides) => undefined,
      subscribe: () => {
        listening++;
        return () => void listening--;
      },
    };
    const views = (): ContextView => ({ ...memoryViews().of(""), guides });
    const view = createViewBinding(views);
    const stops = [view.guides.subscribe(() => undefined), view.guides.subscribe(() => undefined)];
    expect(listening).toBe(1);
    view.bind("b");
    expect(listening).toBe(1);
    for (const stop of stops) stop();
    expect(listening).toBe(0);
  });
});
