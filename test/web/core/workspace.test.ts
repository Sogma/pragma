import { describe, expect, it, vi } from "vitest";

// workspace is a module-level singleton (one space, one workspace) — each
// test gets a fresh module instance via vi.resetModules() so tests don't
// leak tab state into each other.
async function freshWorkspace() {
  vi.resetModules();
  return import("../../../web/core/workspace.ts");
}

describe("initial state", () => {
  it("starts with one focused group holding one empty tab, active", async () => {
    const workspace = await freshWorkspace();
    expect(workspace.groups()).toHaveLength(1);
    expect(workspace.focusedGroup().tabs).toEqual([{ kind: "empty" }]);
    expect(workspace.focusedGroup().activeTabIndex).toBe(0);
    expect(workspace.activeTab()).toEqual({ kind: "empty" });
  });
});

describe("activeTab", () => {
  it("reads the focused group's active index", async () => {
    const workspace = await freshWorkspace();
    const group = workspace.focusedGroup();
    group.tabs = [{ kind: "empty" }, { kind: "table", path: "t.table.html" }];
    group.activeTabIndex = 1;
    expect(workspace.activeTab()).toEqual({ kind: "table", path: "t.table.html" });
  });
});

describe("groups", () => {
  it("adds a group last, with one empty tab, without moving focus", async () => {
    const workspace = await freshWorkspace();
    const first = workspace.focusedGroup();
    const second = workspace.addGroup();
    expect(workspace.groups()).toEqual([first, second]);
    expect(second.id).not.toBe(first.id);
    expect(second.tabs).toEqual([{ kind: "empty" }]);
    expect(workspace.focusedGroup()).toBe(first);

    workspace.setFocusedGroup(second.id);
    expect(workspace.focusedGroup()).toBe(second);
    expect(workspace.groupById(first.id)).toBe(first);
  });

  it("hands focus to the neighbour of a removed group, and never removes the last", async () => {
    const workspace = await freshWorkspace();
    const first = workspace.focusedGroup();
    const second = workspace.addGroup();
    workspace.setFocusedGroup(second.id);

    workspace.removeGroup(second.id);
    expect(workspace.groups()).toEqual([first]);
    expect(workspace.focusedGroup()).toBe(first);

    workspace.removeGroup(first.id);
    expect(workspace.groups()).toEqual([first]);
  });

  it("refuses to focus a group it doesn't hold", async () => {
    const workspace = await freshWorkspace();
    expect(() => workspace.setFocusedGroup("nope")).toThrow();
  });
});
