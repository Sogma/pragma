import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../../web/core/apiClient.ts";
import { chatScopeFor, chatScreen, chatViewContext, switchScopeFor } from "../../../web/core/chatContext.ts";
import * as spaceTree from "../../../web/core/spaceTree.ts";
import type { EditorGroup } from "../../../web/core/workspace.ts";

// A media tab is named from the tab, never from the active path: falling
// through to the document branch would offer the copilot's edit tool a
// file's binary bytes.
describe("chatViewContext", () => {
  it("names a PDF tab as a PDF view, whatever path was active before", () => {
    expect(chatViewContext({ kind: "pdf", path: "refs/paper.pdf" }, "notes/a.md", undefined)).toEqual({
      view: "pdf",
      path: "refs/paper.pdf",
    });
  });

  it("names a Flow or Table tab from the tab", () => {
    expect(chatViewContext({ kind: "flow", path: "a.flow.html" }, undefined, undefined)).toEqual({
      view: "flow",
      path: "a.flow.html",
    });
    expect(chatViewContext({ kind: "table", path: "b.table.html" }, undefined, undefined)).toEqual({
      view: "table",
      path: "b.table.html",
    });
  });

  // Undefined would leave the chat swallowing the message without a word.
  // The copilot's tools read the space, so a library's folder is out of reach.
  it("names a space folder's gallery as that folder, and a library's as no file open", () => {
    expect(chatViewContext({ kind: "gallery", path: "photos" }, undefined, undefined)).toEqual({
      view: "folder",
      path: "photos",
    });
    expect(chatViewContext({ kind: "gallery", path: "" }, undefined, undefined)).toEqual({ view: "folder", path: "" });
    expect(chatViewContext({ kind: "gallery", path: "lib:footage/day 1" }, undefined, undefined)).toEqual({
      view: "none",
    });
  });

  // The focused pane reports one selection; a view carries only its own kind.
  it("carries a Flow's selected node and a document's range, each to its own view only", () => {
    const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
    expect(chatViewContext({ kind: "flow", path: "a.flow.html" }, undefined, { node: "prompt-1" })).toEqual({
      view: "flow",
      path: "a.flow.html",
      node: "prompt-1",
    });
    expect(chatViewContext(note("n.md"), "n.md", { range, node: "prompt-1" })).toEqual({
      view: "document",
      path: "n.md",
      selection: range,
    });
    expect(chatViewContext({ kind: "table", path: "b.table.html" }, undefined, { range, node: "prompt-1" })).toEqual({
      view: "table",
      path: "b.table.html",
    });
  });

  it("names a tab with no file of its own as no file open", () => {
    expect(chatViewContext({ kind: "empty" }, undefined, undefined)).toEqual({ view: "none" });
  });

  // A library's file reaches the copilot only as an image to look at.
  it("names a library's image as an image, and its other files as no file open", () => {
    expect(chatViewContext({ kind: "image", path: "lib:footage/still.png" }, undefined, undefined)).toEqual({
      view: "image",
      path: "lib:footage/still.png",
    });
    const others: Tab[] = [
      { kind: "video", path: "lib:footage/clip.mp4" },
      { kind: "pdf", path: "lib:footage/script.pdf" },
      { kind: "table", path: "lib:footage/shots.table.html" },
      { kind: "document", path: "lib:footage/notes.md", documentType: "note" },
    ];
    for (const tab of others) {
      const activePath = tab.kind === "document" ? tab.path : undefined;
      expect(chatViewContext(tab, activePath, undefined)).toEqual({ view: "none" });
    }
  });
});

const note = (path: string): Tab => ({ kind: "document", path, documentType: "note" });

// The screen as the workspace holds it, the first group focused, and each
// group's open text document as the tab session reports it.
function screenOf(...tabs: Tab[]) {
  const groups: EditorGroup[] = tabs.map((tab, index) => ({
    id: `group-${index}`,
    tabs: [tab],
    activeTabIndex: 0,
    readingView: false,
    sourceMode: false,
  }));
  const activePath = (groupId: string) => {
    const tab = groups.find((group) => group.id === groupId)?.tabs[0];
    return tab?.kind === "document" ? tab.path : undefined;
  };
  return [{ groups: () => groups, focusedGroup: () => groups[0] }, activePath] as const;
}

describe("chatScreen", () => {
  beforeAll(async () => {
    const listing = {
      files: ["projects/a/x.md", "projects/b/z.md", "root.md"],
      folders: ["projects", "projects/a", "projects/b"],
      scopes: ["projects/a"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(String(url).startsWith("/api/space/paths") ? listing : [])),
    );
    await spaceTree.refresh();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("names the other group's file beside the focused one, without a selection of its own", () => {
    const selection = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
    const [screen, activePath] = screenOf(note("projects/a/x.md"), { kind: "flow", path: "projects/b/p.flow.html" });
    expect(chatScreen(screen, activePath, { range: selection })).toMatchObject({
      focused: { view: "document", path: "projects/a/x.md", selection },
      beside: { view: "flow", path: "projects/b/p.flow.html" },
    });
  });

  it("keeps the focused Flow's selected node off the Flow beside", () => {
    const [screen, activePath] = screenOf(
      { kind: "flow", path: "projects/a/p.flow.html" },
      { kind: "flow", path: "projects/b/q.flow.html" },
    );
    const { focused, beside } = chatScreen(screen, activePath, { node: "prompt-1" });
    expect(focused).toEqual({ view: "flow", path: "projects/a/p.flow.html", node: "prompt-1" });
    expect(beside).toEqual({ view: "flow", path: "projects/b/q.flow.html" });
  });

  // The copilot's tools read only the space, and one file is named once.
  it("names nothing beside for one group, a blank tab, the focused file again, or a library's document", () => {
    const others: Tab[][] = [[], [{ kind: "empty" }], [note("projects/a/x.md")], [note("lib:footage/notes.md")]];
    for (const other of others) {
      const [screen, activePath] = screenOf(note("projects/a/x.md"), ...other);
      expect(chatScreen(screen, activePath, undefined).beside).toBeUndefined();
    }
  });

  it("names a library's image beside, for the copilot to look at", () => {
    const [screen, activePath] = screenOf(note("projects/a/x.md"), { kind: "image", path: "lib:footage/still.png" });
    expect(chatScreen(screen, activePath, undefined).beside).toEqual({ view: "image", path: "lib:footage/still.png" });
  });

  it("reads each tab's closest scope, and none for a tab with no space file", () => {
    const scopesOf = (...tabs: Tab[]) => chatScreen(...screenOf(...tabs), undefined).scopes;
    expect(scopesOf(note("projects/a/x.md"), note("projects/b/z.md"))).toEqual({
      focused: "projects/a",
      shown: ["projects/a", ""],
    });
    expect(scopesOf({ kind: "empty" }, { kind: "gallery", path: "projects/a" })).toEqual({
      focused: undefined,
      shown: ["projects/a"],
    });
    expect(scopesOf(note("lib:footage/notes.md"))).toEqual({ focused: undefined, shown: [] });
  });
});

describe("chatScopeFor", () => {
  it("keeps the chat showing while its scope is on screen, whichever group has focus", () => {
    expect(chatScopeFor("a", { focused: "b", shown: ["a", "b"] })).toBe("a");
  });

  it("follows the focused tab once the chat's scope has left the screen", () => {
    expect(chatScopeFor("a", { focused: "b", shown: ["b"] })).toBe("b");
  });

  it("keeps the chat showing while the focused tab sits in no scope", () => {
    expect(chatScopeFor("a", { focused: undefined, shown: [] })).toBe("a");
  });
});

describe("switchScopeFor", () => {
  it("offers the focused tab's scope while it is not the chat's", () => {
    expect(switchScopeFor("a", { focused: "b", shown: ["a", "b"] })).toBe("b");
  });

  it("offers the other group's scope while the focused tab is in the chat's", () => {
    expect(switchScopeFor("a", { focused: "a", shown: ["a", "b"] })).toBe("b");
  });

  it("offers the space's own chat beside a folder's", () => {
    expect(switchScopeFor("a", { focused: "a", shown: ["a", ""] })).toBe("");
  });

  it("offers nothing while every tab on screen is in the chat's scope", () => {
    expect(switchScopeFor("a", { focused: "a", shown: ["a"] })).toBeUndefined();
    expect(switchScopeFor("a", { focused: "a", shown: ["a", "a"] })).toBeUndefined();
    expect(switchScopeFor("a", { focused: undefined, shown: [] })).toBeUndefined();
  });
});
