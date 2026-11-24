// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ContextViewRequestBody, ContextViewResponse } from "../../../src/protocol/api.ts";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { NO_LOOK } from "../../../web/lib/videoLut.ts";
import { contextView } from "../../../web/services/contextViews.ts";

// The server's side, answered by hand: each context's read, and each change
// sent, which lands when released.
const api = vi.hoisted(() => ({
  reads: [] as string[],
  answer: new Map<string, (kept: ContextViewResponse) => void>(),
  sent: [] as ContextViewRequestBody[],
  release: [] as (() => void)[],
}));

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/core/apiClient.ts")>()),
  fetchContextView: (context: string) => {
    api.reads.push(context);
    return new Promise<ContextViewResponse>((resolve) => api.answer.set(context, resolve));
  },
  postContextView: (change: ContextViewRequestBody) => {
    api.sent.push(change);
    return new Promise<void>((resolve) => api.release.push(resolve));
  },
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Each test asks for contexts of its own: the pairs live for the session.
describe("each context's guides and look", () => {
  it("are read from the server once, shared by every surface seen in the context, none until then", async () => {
    const view = contextView("reads");
    expect(contextView("reads")).toBe(view);
    expect(api.reads.filter((context) => context === "reads")).toHaveLength(1);
    expect([view.guides.get(), view.look.get()]).toEqual([NO_GUIDES, NO_LOOK]);

    api.answer.get("reads")?.({
      guides: { frames: ["2.39"], protection: 0.07 },
      look: { lut: "panchromatic", on: true },
    });
    await settle();
    expect(view.guides.get()).toEqual({ ...NO_GUIDES, frames: ["2.39"], protection: 0.07 });
    expect(view.look.get()).toEqual({ lut: "panchromatic", on: true });
  });

  it("read as none where the server keeps none or what it keeps is unknown", async () => {
    const view = contextView("unknown");
    api.answer.get("unknown")?.({ guides: null, look: { lut: "sepia", on: true } });
    await settle();
    expect([view.guides.get(), view.look.get()]).toEqual([NO_GUIDES, NO_LOOK]);
  });

  it("keep a pick made while the read loads, and send each pick for its own context", async () => {
    const view = contextView("picked");
    view.guides.set({ ...NO_GUIDES, title: true });
    api.answer.get("picked")?.({ guides: { frames: ["9:16"] }, look: { lut: "panchromatic", on: true } });
    await settle();
    expect(view.guides.get()).toEqual({ ...NO_GUIDES, title: true });
    // The look wasn't picked, so the read brings it.
    expect(view.look.get()).toEqual({ lut: "panchromatic", on: true });
    expect(api.sent.at(-1)).toEqual({ context: "picked", guides: { ...NO_GUIDES, title: true } });
    // Another context's are their own.
    expect(contextView("elsewhere").guides.get()).toEqual(NO_GUIDES);
  });

  it("send a run of picks in order, only the latest once one is on its way", async () => {
    const view = contextView("run");
    api.sent.length = 0;
    api.release.length = 0;
    for (const protection of [0.01, 0.02, 0.03]) view.guides.set({ ...NO_GUIDES, protection });
    expect(api.sent.map((change) => (change.guides as { protection: number }).protection)).toEqual([0.01]);
    api.release[0]();
    await settle();
    expect(api.sent.map((change) => (change.guides as { protection: number }).protection)).toEqual([0.01, 0.03]);
    expect(view.guides.get().protection).toBe(0.03);
  });

  it("try a look in one context without touching another's, and drop the try with a pick", () => {
    const tried = contextView("tried").look;
    const other = contextView("untried").look;
    tried.tryLook("orthochromatic");
    expect([tried.get(), tried.trying?.()]).toEqual([{ lut: "orthochromatic", on: true }, true]);
    expect([other.get(), other.trying?.()]).toEqual([NO_LOOK, false]);

    tried.set({ lut: "panchromatic", on: true });
    expect([tried.get(), tried.trying?.(), tried.kept?.()]).toEqual([
      { lut: "panchromatic", on: true },
      false,
      { lut: "panchromatic", on: true },
    ]);
  });
});
