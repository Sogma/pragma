// @vitest-environment jsdom
// jsdom because the module also wires the window's own change feed, which
// listens on `window` from the moment it is imported.
import { describe, expect, it, vi } from "vitest";
import { createOutsideEdits } from "../../../web/services/outsideEdits.ts";

// `settled` is each path's revision while nothing of the writer's is on its
// way to disk; a path missing from it has an edit waiting.
function setup(open: string[], settled: Record<string, string>) {
  const revisions = new Map(Object.entries(settled));
  const tabs = {
    openCopies: () => open,
    reloadPath: vi.fn(async (_path: string) => {}),
    dropGone: vi.fn(),
  };
  const follower = createOutsideEdits({ queue: { settledRevision: (path) => revisions.get(path) }, tabs });
  return { follower, tabs, revisions };
}

const answer = (entries: [string, string | null][]) => new Map(entries);

describe("outsideEdits", () => {
  it("asks only about copies with nothing on their way to disk", () => {
    const { follower } = setup(["a.md", "b.md"], { "a.md": "r1" });
    expect(follower.paths()).toEqual(["a.md"]);
  });

  it("reads a file in again once it moved on disk, and leaves an unchanged one be", () => {
    const { follower, tabs } = setup(["a.md", "b.md"], { "a.md": "r1", "b.md": "r1" });
    follower.paths();
    follower.onRevisions(
      answer([
        ["a.md", "r2"],
        ["b.md", "r1"],
      ]),
    );
    expect(tabs.reloadPath).toHaveBeenCalledTimes(1);
    expect(tabs.reloadPath).toHaveBeenCalledWith("a.md");
  });

  it("leaves a copy alone when the writer's own save landed during the ask, or an edit started", () => {
    const { follower, tabs, revisions } = setup(["a.md", "b.md"], { "a.md": "r1", "b.md": "r1" });
    follower.paths();
    revisions.set("a.md", "r2"); // the writer's save landed
    revisions.delete("b.md"); // the writer started typing
    follower.onRevisions(
      answer([
        ["a.md", "r1"],
        ["b.md", "r5"],
      ]),
    );
    expect(tabs.reloadPath).not.toHaveBeenCalled();
    expect(tabs.dropGone).not.toHaveBeenCalled();
  });

  it("empties the tabs on files gone from disk, all at once", () => {
    const { follower, tabs } = setup(["a.md", "b.md"], { "a.md": "r1", "b.md": "r1" });
    follower.paths();
    follower.onRevisions(
      answer([
        ["a.md", null],
        ["b.md", null],
      ]),
    );
    expect(tabs.dropGone).toHaveBeenCalledWith(["a.md", "b.md"]);
    expect(tabs.reloadPath).not.toHaveBeenCalled();
  });

  it("reads a file once at a time, and again on a later ask if the read failed", async () => {
    const { follower, tabs } = setup(["a.md"], { "a.md": "r1" });
    let fail: (error: Error) => void = () => {};
    tabs.reloadPath.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));

    follower.paths();
    follower.onRevisions(answer([["a.md", "r2"]]));
    follower.paths();
    follower.onRevisions(answer([["a.md", "r2"]]));
    expect(tabs.reloadPath).toHaveBeenCalledTimes(1);

    fail(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    follower.paths();
    follower.onRevisions(answer([["a.md", "r2"]]));
    expect(tabs.reloadPath).toHaveBeenCalledTimes(2);
  });
});
