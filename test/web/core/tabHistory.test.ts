import { describe, expect, it } from "vitest";
import type { Place, Tab } from "../../../web/core/apiClient.ts";
import { historyAfter, pruned, samePlace, step } from "../../../web/core/tabHistory.ts";

const doc = (path: string): Place => ({ kind: "document", path, documentType: "note" });

describe("samePlace", () => {
  it("is one entry whatever view shows it, but never a Find Context answer and its folder", () => {
    expect(samePlace({ kind: "applet", path: "a.applet.html" }, { kind: "applet-source", path: "a.applet.html" })).toBe(
      true,
    );
    expect(samePlace({ kind: "gallery", path: "notes" }, { kind: "find-context", path: "notes" } as Place)).toBe(false);
  });
});

describe("historyAfter", () => {
  it("pushes the replaced tab itself, so a scroll written to it later is kept", () => {
    const a = doc("a.md");
    const history = historyAfter(a, doc("b.md"));
    expect(history?.back[0]).toBe(a);
    expect(history?.forward).toEqual([]);
  });

  it("hands a blank's history on without the place the blank's replacement now shows", () => {
    const blank: Tab = {
      kind: "empty",
      history: { back: [doc("a.md"), { kind: "gallery", path: "notes" }], forward: [] },
    };
    expect(historyAfter(blank, { kind: "gallery", path: "notes" })?.back).toEqual([doc("a.md")]);
    expect(historyAfter({ kind: "empty" }, doc("b.md"))).toBeUndefined();
  });
});

describe("step", () => {
  it("leaves a blank out of the history it steps away from", () => {
    const blank: Tab = { kind: "empty", history: { back: [doc("a.md")], forward: [] } };
    expect(step(blank, "back")).toEqual({ to: doc("a.md"), history: { back: [], forward: [] } });
    expect(step(blank, "forward")).toBeUndefined();
  });
});

describe("pruned", () => {
  it("folds a twin left beside its own, and a place next to where the tab already is", () => {
    const history = { back: [doc("a.md"), doc("gone.md"), doc("a.md"), doc("c.md")], forward: [doc("c.md")] };
    const kept = pruned(history, doc("c.md"), (place) => place.path !== "gone.md");
    expect(kept).toEqual({ back: [doc("a.md")], forward: [] });
  });
});
