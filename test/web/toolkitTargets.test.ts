// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextToolkitInfo } from "../../src/protocol/api.ts";
import type { Tab } from "../../web/core/apiClient.ts";
import * as workspace from "../../web/core/workspace.ts";
import type { TableAtClick } from "../../web/flow/toolkitAction.ts";
import type { EditorPane } from "../../web/services/editorPanes.ts";
import { createToolkitTargets } from "../../web/toolkitTargets.ts";
import type { TablePane } from "../../web/view/panes/tablePane.ts";

// What the Tools tab's buttons act on: the focused group's text document or
// the Table its pane shows, and the toolkits it lists as focus moves.

const make: TextToolkitInfo = {
  classPath: "shots.table.html",
  path: "tools/make.flow.html",
  name: "Make",
  actions: [],
};
const rewrite: TextToolkitInfo = {
  classPath: "drafts.class.html",
  path: "tools/rewrite.flow.html",
  name: "Rewrite",
  actions: [],
};

const at: TableAtClick = {
  content: "<table></table>",
  columns: [{ id: "title", label: "Title", type: "text" }],
  rows: [{ values: { title: "A" } }],
  private: false,
};

// A Table's pane showing `path`, or nothing while it loads.
function tablePane(path: string | undefined): TablePane {
  return {
    kind: "table",
    element: document.createElement("div"),
    setInput: async () => {},
    shownTable: () => (path ? { path, toolkits: [make] } : undefined),
    atClick: () => (path ? { ...at, path } : undefined),
  } as unknown as TablePane;
}

function focus(tab: Tab): void {
  const group = workspace.focusedGroup();
  group.tabs = [tab];
  group.activeTabIndex = 0;
}

afterEach(() => focus({ kind: "empty" }));

function setup(pane: EditorPane | undefined) {
  const show = vi.fn<(toolkits: readonly TextToolkitInfo[], document: string | undefined) => void>();
  const tabs = {
    activePath: vi.fn((_group?: string) => "draft.md" as string | undefined),
    activeDocument: vi.fn(() => ({ toolkits: [rewrite] }) as never),
  };
  let focused = pane;
  const targets = createToolkitTargets({ focusedPane: () => focused, tabs: () => tabs, show });
  return { targets, show, tabs, mount: (next: EditorPane) => (focused = next) };
}

describe("createToolkitTargets", () => {
  it("lists a text document's toolkits as focus reaches it", () => {
    focus({ kind: "document", path: "draft.md", documentType: "note" } as Tab);
    const { targets, show } = setup(undefined);
    targets.follow();
    expect(show).toHaveBeenCalledWith([rewrite], "draft.md");
  });

  it("lists a Table's toolkits only once its pane shows it, and only from the focused pane", () => {
    focus({ kind: "table", path: "shots.table.html" });
    // Focus moves before the pane mounts: the group still shows another Table.
    const { targets, show, mount } = setup(tablePane("other.table.html"));
    targets.follow();
    expect(show).toHaveBeenLastCalledWith([], "shots.table.html");

    const shown = tablePane("shots.table.html");
    targets.follow(shown);
    expect(show).toHaveBeenCalledTimes(1);
    mount(shown);
    targets.follow(shown);
    expect(show).toHaveBeenLastCalledWith([make], "shots.table.html");
  });

  it("acts on the Table the focused pane shows, as it stood at the click", () => {
    const { targets } = setup(tablePane("shots.table.html"));
    expect(targets.target()).toEqual({
      path: "shots.table.html",
      source: { kind: "table", at: { ...at, path: "shots.table.html" } },
      group: workspace.focusedGroup().id,
    });
    expect(setup(tablePane(undefined)).targets.target()).toBeUndefined();
  });

  it("acts on nothing in a pane that is neither a text document nor a Table", () => {
    const { targets } = setup({ kind: "flow" } as unknown as EditorPane);
    expect(targets.target()).toBeUndefined();
  });

  it("knows a Table's tab by its path, where the tab session knows text documents only", () => {
    focus({ kind: "table", path: "shots.table.html" });
    const { targets, tabs } = setup(undefined);
    expect(targets.activePath(workspace.focusedGroup().id)).toBe("shots.table.html");
    focus({ kind: "document", path: "draft.md", documentType: "note" } as Tab);
    expect(targets.activePath(workspace.focusedGroup().id)).toBe("draft.md");
    expect(tabs.activePath).toHaveBeenCalledWith(workspace.focusedGroup().id);
  });
});
