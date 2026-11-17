import { describe, expect, it, vi } from "vitest";
import { createCollapsedFolders } from "../../../web/services/collapsedFolders.ts";

function setup(collapsedFolders: string[] = [], expandedFolders: string[] = [], loadFails = false) {
  const save = vi.fn(async (_collapsed: string[], _expanded: string[]) => undefined);
  const load = vi.fn(async () => {
    if (loadFails) throw new Error("offline");
    return { groups: [], focusedGroup: 0, collapsedFolders, expandedFolders };
  });
  const collapsed = createCollapsedFolders({ load, save });
  return { collapsed, save, load };
}

describe("defaults", () => {
  it("starts a space folder open and a library folder collapsed", () => {
    const { collapsed } = setup();
    expect(collapsed.isCollapsed("projects")).toBe(false);
    expect(collapsed.isCollapsed("lib:footage/projects")).toBe(true);
  });

  it("reads a space folder whose name looks like a scheme as a space folder", () => {
    const { collapsed } = setup();
    expect(collapsed.isCollapsed("Act 1: Setup")).toBe(false);
  });
});

describe("load", () => {
  it("adopts both persisted lists", async () => {
    const { collapsed } = setup(["a", "a/b"], ["lib:footage/stills"]);
    await collapsed.load();
    expect(collapsed.isCollapsed("a/b")).toBe(true);
    expect(collapsed.isCollapsed("lib:footage/stills")).toBe(false);
    expect(collapsed.isCollapsed("lib:footage/takes")).toBe(true);
  });

  it("drops a key filed under the other root's list, so the next save writes both clean", async () => {
    const { collapsed, save } = setup(["a", "lib:footage/stills"], ["b", "lib:footage/takes"]);
    await collapsed.load();
    expect(collapsed.isCollapsed("b")).toBe(false);
    collapsed.setCollapsed("c", true);
    expect(save).toHaveBeenCalledWith(["a", "c"], ["lib:footage/takes"]);
  });

  it("starts every root at its default, without throwing, when the load fails", async () => {
    const { collapsed } = setup(["a"], ["lib:footage/stills"], true);
    await expect(collapsed.load()).resolves.toBeUndefined();
    expect(collapsed.isCollapsed("a")).toBe(false);
    expect(collapsed.isCollapsed("lib:footage/stills")).toBe(true);
  });
});

describe("setCollapsed", () => {
  it("records a space folder only while it is folded", async () => {
    const { collapsed, save } = setup();
    collapsed.setCollapsed("a", true);
    expect(save).toHaveBeenLastCalledWith(["a"], []);
    collapsed.setCollapsed("a", false);
    expect(save).toHaveBeenLastCalledWith([], []);
  });

  it("records a library folder only while it is open", async () => {
    const { collapsed, save } = setup();
    collapsed.setCollapsed("lib:footage/stills", false);
    expect(collapsed.isCollapsed("lib:footage/stills")).toBe(false);
    expect(save).toHaveBeenLastCalledWith([], ["lib:footage/stills"]);
    collapsed.setCollapsed("lib:footage/stills", true);
    expect(save).toHaveBeenLastCalledWith([], []);
  });
});

describe("expand", () => {
  it("opens a folder in either root and persists both lists", async () => {
    const { collapsed, save } = setup(["a", "b"]);
    await collapsed.load();
    collapsed.expand("a");
    collapsed.expand("lib:footage/stills");
    expect(collapsed.isCollapsed("a")).toBe(false);
    expect(collapsed.isCollapsed("lib:footage/stills")).toBe(false);
    expect(save).toHaveBeenLastCalledWith(["b"], ["lib:footage/stills"]);
  });

  it("treats a root as a no-op — neither has a row to collapse", async () => {
    const { collapsed, save } = setup(["a"]);
    await collapsed.load();
    collapsed.expand("");
    collapsed.expand("lib:footage");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("reveal", () => {
  it("expands every ancestor of the path, never the path itself, with one save", async () => {
    const { collapsed, save } = setup(["a", "a/b", "a/b/c.md", "other"]);
    await collapsed.load();
    collapsed.reveal("a/b/c.md");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(["a/b/c.md", "other"], []);
  });

  it("opens a library file's ancestors without recording the library's root", async () => {
    const { collapsed, save } = setup();
    collapsed.reveal("lib:footage/a/b/c.png");
    expect(save).toHaveBeenCalledWith([], ["lib:footage/a", "lib:footage/a/b"]);
  });

  it("says whether it opened anything, and saves nothing when every ancestor was open", async () => {
    const { collapsed, save } = setup(["a"]);
    await collapsed.load();
    expect(collapsed.reveal("a/b/c.md")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(collapsed.reveal("a/b/d.md")).toBe(false);
    expect(collapsed.reveal("top.md")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("foldAll", () => {
  it("folds every folder it is given, in either root, with one save", () => {
    const { collapsed, save } = setup();
    collapsed.foldAll(["a", "a/b", "lib:footage/stills"]);
    expect(collapsed.isCollapsed("a")).toBe(true);
    expect(collapsed.isCollapsed("a/b")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(["a", "a/b"], []);
  });
});

describe("persist", () => {
  it("swallows a failed save so the click that caused it is not interrupted", async () => {
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const collapsed = createCollapsedFolders({
      load: async () => ({ groups: [], focusedGroup: 0, collapsedFolders: [], expandedFolders: [] }),
      save,
    });
    expect(() => collapsed.setCollapsed("a", true)).not.toThrow();
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith(["a"], []);
  });
});
