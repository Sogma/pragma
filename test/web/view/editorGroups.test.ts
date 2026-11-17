// @vitest-environment jsdom
// Two editor groups side by side in jsdom (docs/architecture.md's Files and views
// section): a different kind open in each, then the same document in both —
// one model, two view states.
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { FileResponse, Tab, TextFileResponse } from "../../../web/core/apiClient.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createDocuments } from "../../../web/services/documents.ts";
import { createEditorPanes, type EditorPane } from "../../../web/services/editorPanes.ts";
import type { SaveQueue } from "../../../web/services/saveQueue.ts";
import { createEditorGroupView } from "../../../web/view/editorGroup.ts";
import { createLinksList } from "../../../web/view/linksList.ts";
import { documentPane, isDocumentPane } from "../../../web/view/panes/documentPane.ts";
import { createPropertyEditor } from "../../../web/view/propertyEditor.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";
import { testLayout } from "../support/editorLayout.ts";
import { testFormats } from "../support/formats.ts";
import { fakePaneGroup } from "../support/paneGroup.ts";

polyfillRangeRects();
// jsdom lays nothing out, so there is no resize to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const song: TextFileResponse = {
  kind: "text",
  path: "notes/song.md",
  revision: "rev-1",
  documentType: "note",
  content: "# Song\n\nfirst line\n",
  toolkits: [],
  classLinks: [],
};

// The other kind: a stand-in table pane, enough to prove a group can hold
// something that isn't a document while its neighbour holds one.
function tablePane(): EditorPane {
  const element = document.createElement("div");
  element.className = "editor-table";
  return {
    kind: "table",
    element,
    setInput: vi.fn(async () => undefined),
    clearInput: vi.fn(),
    title: () => "Table",
    titleHost: () => element,
    dispose: vi.fn(),
  };
}

// Every group a test opens, disposed after it as closing one in the app
// does: an open pane keeps its Links redraw timer, which can fire after the
// file's DOM is torn down and fail the run with an unhandled error.
const built: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const view of built.splice(0)) view.dispose();
});

function setup() {
  const queue: SaveQueue & { schedule: Mock<SaveQueue["schedule"]> } = {
    schedule: vi.fn<SaveQueue["schedule"]>(),
    flush: vi.fn(async () => true),
    pendingContent: () => undefined,
    state: () => ({ failedPaths: [], conflictPaths: [] }),
    subscribe: () => () => {},
    noteRevision: vi.fn(),
    settledRevision: () => undefined,
    resolveConflict: vi.fn(),
    move: vi.fn(),
    pause: () => () => {},
    rebase: vi.fn(async () => {}),
    saveNow: vi.fn(async () => true),
    hasPending: () => false,
  };
  const loadFile = vi.fn(async (_path: string): Promise<FileResponse> => song);
  const documents = createDocuments({ queue, fetchFile: loadFile });
  const panes = createEditorPanes();
  panes.register({
    kind: "table",
    chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
    create: tablePane,
  });
  panes.register(
    documentPane({
      documents,
      saveQueue: queue,
      layout: testLayout(),
      loadFile,
      formats: testFormats(),
      treeOrder: (paths: readonly string[]) => [...paths],
      describe: async () => undefined,
      contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
      dialog: createDialogService(),
      openPath: vi.fn(),
      openBeside: vi.fn(),
      createPropertyEditor,
      tags: { known: () => [], read: async () => [] },
      createLinksList,
      revealProperties: vi.fn(),
      onSpaceChanged: vi.fn(),
      notify: vi.fn(),
      reportProblems: vi.fn(),
      runCommand: vi.fn(),
      shortcutFor: () => undefined,
    }),
  );
  const tabs = {
    onSwitch: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onMenu: vi.fn(),
  };
  function group() {
    const stripHost = document.createElement("div");
    const host = document.createElement("div");
    host.hidden = true;
    document.body.append(stripHost, host);
    const view = createEditorGroupView({ stripHost, host, panes, tabs, paneGroup: fakePaneGroup() });
    built.push(view);
    return { view, host };
  }
  return { documents, queue, left: group(), right: group() };
}

function documentPaneOf(group: ReturnType<typeof createEditorGroupView>) {
  const pane = group.activePane();
  if (!pane || !isDocumentPane(pane)) throw new Error("no document pane is active");
  return pane;
}

const tableTab: Tab = { kind: "table", path: "a.table.html" };
const songTab = (): Tab => ({ kind: "document", path: "notes/song.md", documentType: "note" });

describe("two editor groups", () => {
  it("hold a different kind each, then the same document: one model, two view states", async () => {
    const { documents, queue, left, right } = setup();
    documents.adopt(song);
    documents.adopt(song);

    await left.view.open(tableTab);
    await right.view.open(songTab());
    expect(left.view.activePane()?.kind).toBe("table");
    expect(left.host.querySelector(".editor-table")).not.toBeNull();
    expect(documentPaneOf(right.view).view.state.doc.toString()).toBe("first line\n");

    await left.view.open(songTab());
    const a = documentPaneOf(left.view);
    const b = documentPaneOf(right.view);
    expect(a).not.toBe(b);
    expect(a.element).not.toBe(b.element);
    expect(left.host.querySelector(".editor-table")).toBeNull(); // the table pane was unmounted
    expect(left.host.contains(a.element)).toBe(true);
    expect(right.host.contains(b.element)).toBe(true);

    // One model behind both.
    b.view.dispatch({ selection: { anchor: b.view.state.doc.length } });
    a.view.dispatch({ changes: { from: 0, insert: "0 " }, selection: { anchor: 2 } });
    expect(b.view.state.doc.toString()).toBe("0 first line\n");
    expect(documents.get("notes/song.md")?.body()).toBe("0 first line\n");
    expect(queue.schedule).toHaveBeenCalledTimes(1);
    expect(queue.schedule.mock.calls[0][1]).toBe("# Song\n\n0 first line\n");

    // Two view states: each pane's selection is its own, mapped through the
    // other's edit rather than reset by it.
    expect(a.view.state.selection.main.head).toBe(2);
    expect(b.view.state.selection.main.head).toBe("0 first line\n".length);

    b.view.dispatch({ changes: { from: b.view.state.doc.length, insert: "end\n" } });
    expect(a.view.state.doc.toString()).toBe("0 first line\nend\n");
    expect(a.view.state.selection.main.head).toBe(2);

    // Closing one group's tab leaves the other editing the same model.
    left.view.close();
    expect(left.host.hidden).toBe(true);
    b.view.dispatch({ changes: { from: 0, insert: "> " } });
    expect(documents.get("notes/song.md")?.body()).toBe("> 0 first line\nend\n");
    expect(a.view.state.doc.toString()).toBe(""); // the cleared pane holds nothing
  });
});
