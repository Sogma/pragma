// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { FlowFileResponse } from "../../../src/protocol/api.ts";
import { setupNeedOf } from "../../../src/protocol/setupNeed.ts";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { acceptAll, editProposal, pendingChanges } from "../../../web/editProposal.ts";
import { runToolkitAction, type TableAtClick, type ToolkitAsk } from "../../../web/flow/toolkitAction.ts";
import type { BrokerCapability, CapabilityBroker } from "../../../web/services/capabilityBroker.ts";
import { createDocumentAccess } from "../../../web/services/documentAccess.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

function node(id: string, type: string, y: number, extra: Partial<FlowNodeInstance> = {}): FlowNodeInstance {
  return { id, type, position: { x: 0, y }, config: {}, ...extra };
}

function edge(source: string, sourcePort: string, target: string, targetPort: string) {
  return { id: `${source}-${target}`, source, sourcePort, target, targetPort };
}

// Two buttons, each prefixing the selection its own way, and one with
// nothing wired from it. Each Join Text is exposed, so what ran shows in the
// results.
const graph: FlowGraph = {
  nodes: [
    node("btn-a", "button", 0, { label: "Prefix A" }),
    node("btn-b", "button", 200, { label: "Prefix B" }),
    node("join-a", "joinText", 0, { config: { text_1: "A: ", separator: "" }, exposed: ["text"] }),
    node("join-b", "joinText", 200, { config: { text_1: "B: ", separator: "" }, exposed: ["text"] }),
    node("put-a", "replaceSelection", 0),
    node("put-b", "replaceSelection", 200),
    node("loose", "button", 400, { label: "Loose" }),
  ],
  edges: [
    edge("btn-a", "selection", "join-a", "text_2"),
    edge("btn-b", "selection", "join-b", "text_2"),
    edge("join-a", "text", "put-a", "text"),
    edge("join-b", "text", "put-b", "text"),
  ],
};

function setup(options: { granted?: boolean; refused?: boolean; isPrivate?: boolean; reading?: boolean } = {}) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "one two three",
      selection: { anchor: 4, head: 7 },
      // Reading view makes the editor read-only.
      extensions: [editProposal({ barHost: document.body }), EditorState.readOnly.of(options.reading ?? false)],
    }),
    parent: document.body,
  });
  const access = createDocumentAccess({
    getView: () => view,
    getActivePath: () => "draft.md",
    getActiveDocument: () => ({ isPrivate: () => options.isPrivate ?? false, frontmatterError: () => undefined }),
    getContent: () => "# Draft\n\none two three",
  });
  const file: FlowFileResponse = {
    kind: "flow",
    path: "tools/prefix.flow.html",
    revision: "r1",
    version: "1.0",
    name: "Prefix",
    graph,
    capabilities: [{ type: "readCurrentDocument" }],
    grantedCapabilities: [],
    runsUnattended: false,
  };
  const broker = {
    mount: vi.fn(),
    unmount: vi.fn(),
    ensure: vi.fn(async () => options.granted ?? true),
    // A run's ask up front; a node's own ask during the run is `ensure`.
    ensureAll: vi.fn(async (needs: readonly BrokerCapability[]) => ({
      allowed: !options.refused,
      asked: needs.map((need) => need.key),
    })),
  } as unknown as CapabilityBroker;
  const deps = {
    broker,
    loadFile: vi.fn(async () => file),
    modelConsole: { logLlmCall: vi.fn(), beginLlmActivity: vi.fn(), endLlmActivity: vi.fn() },
    notices: { begin: vi.fn(), add: vi.fn() },
  };
  const invocation = {
    flow: { path: file.path, name: "Prefix" },
    path: "draft.md",
    source: { kind: "text" as const, access },
    openToSide: vi.fn(async () => {}),
  };
  const run = (actionId: string) => runToolkitAction(invocation, actionId, deps, new AbortController().signal);
  return { view, deps, broker, file, run, invocation };
}

// The host's one answer to every generate call in the test.
function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

// A button whose selection a Generate Text answers, its reply proposed in
// the selection's place.
const asking: FlowGraph = {
  nodes: [
    node("ask", "button", 0, { label: "Ask" }),
    node("gen", "generateText", 0, { label: "Answer", config: { model: "anthropic/claude-haiku-4-5" } }),
    node("put", "replaceSelection", 0),
  ],
  edges: [edge("ask", "selection", "gen", "prompt"), edge("gen", "text", "put", "text")],
};

describe("runToolkitAction", () => {
  it("runs only the clicked button's part and proposes its result over the selection", async () => {
    const { view, run } = setup();

    const rows = await run("btn-a");

    expect(rows).toEqual({ lines: ["Join Text · text: A: two"], warnings: [] });
    expect(view.state.doc.toString()).toBe("one two three");
    expect(pendingChanges(view.state).length).toBeGreaterThan(0);
    acceptAll(view);
    expect(view.state.doc.toString()).toBe("one A: two three");
  });

  it("asks for readCurrentDocument through the broker, as this flow", async () => {
    const { broker, run } = setup();
    await run("btn-b");
    expect(broker.ensure).toHaveBeenCalledWith(
      { key: "readCurrentDocument", type: "readCurrentDocument" },
      expect.objectContaining({ kind: "flow", path: "tools/prefix.flow.html" }),
    );
    expect(broker.unmount).toHaveBeenCalled();
  });

  it("acts on the selection as it was at the click, wherever it moves during the run", async () => {
    const { view, deps, file, run } = setup();
    deps.loadFile.mockImplementationOnce(async () => {
      view.dispatch({ selection: { anchor: 0 } });
      return file;
    });

    await run("btn-a");
    acceptAll(view);
    expect(view.state.doc.toString()).toBe("one A: two three");
  });

  it("asks for the click's grants together, before the Button runs", async () => {
    const { broker, run } = setup();
    await run("btn-b");
    expect(broker.ensureAll).toHaveBeenCalledWith(
      [{ key: "readCurrentDocument", type: "readCurrentDocument" }],
      expect.objectContaining({ kind: "flow", path: "tools/prefix.flow.html" }),
    );
    expect(vi.mocked(broker.ensureAll).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broker.ensure).mock.invocationCallOrder[0],
    );
  });

  it("runs nothing when the click's grants are refused", async () => {
    const { view, broker, run } = setup({ refused: true });
    await expect(run("btn-a")).rejects.toThrow("Permission denied, so nothing ran.");
    expect(broker.ensure).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("one two three");
    expect(broker.unmount).toHaveBeenCalled();
  });

  it("names the node that failed, not everything downstream of it", async () => {
    const { run } = setup({ granted: false });
    await expect(run("btn-a")).rejects.toThrow(/^Prefix A: Permission denied/);
  });

  it("refuses a button with nothing wired from it, and one the flow no longer has", async () => {
    const { run } = setup();
    await expect(run("loose")).rejects.toThrow("Loose: Nothing is wired from it, so a click would run nothing");
    await expect(run("gone")).rejects.toThrow("no longer has that button");
  });

  it("refuses, in reading view, a button whose click proposes an edit, before anything runs or asks", async () => {
    const { view, broker, run } = setup({ reading: true });
    await expect(run("btn-a")).rejects.toThrow(
      "Replace Selection requires editing. Switch the document to editing mode.",
    );
    expect(broker.ensure).not.toHaveBeenCalled();
    expect(broker.mount).not.toHaveBeenCalled();
    expect(pendingChanges(view.state)).toEqual([]);
  });

  it("runs a Show Result button in reading view, which proposes nothing", async () => {
    const { deps, file, run } = setup({ reading: true });
    deps.loadFile.mockResolvedValueOnce({
      ...file,
      graph: {
        nodes: [node("go", "button", 0, { label: "Show" }), node("show", "showResult", 0)],
        edges: [edge("go", "selection", "show", "text")],
      },
    });
    expect(await run("go")).toEqual({ lines: ["two"], warnings: [] });
  });

  // A Button that hands on just its path reads nothing, and opening a file
  // only shows it: the click asks for no grant at all.
  it("opens a file beside the document's group, asking for nothing", async () => {
    const { deps, broker, file, run, invocation } = setup();
    deps.loadFile.mockResolvedValueOnce({
      ...file,
      graph: {
        nodes: [
          node("open", "button", 0, { label: "Open guide" }),
          node("beside", "resolvePath", 0, { config: { path: "style-guide.md" } }),
          node("show", "openToSide", 0),
        ],
        edges: [edge("open", "path", "beside", "base"), edge("beside", "path", "show", "path")],
      },
    });

    await run("open");
    expect(invocation.openToSide).toHaveBeenCalledWith("style-guide.md");
    expect(broker.ensure).not.toHaveBeenCalled();
  });

  it("never reads a private document", async () => {
    const { view, run } = setup({ isPrivate: true });
    await expect(run("btn-a")).rejects.toThrow("visibility: private");
    expect(pendingChanges(view.state)).toEqual([]);
  });

  it("logs each generation to the Console under the flow, the node and the document", async () => {
    answer(200, { reply: "2", model: "m" });
    try {
      const { view, deps, file, run } = setup();
      deps.loadFile.mockResolvedValueOnce({ ...file, graph: asking });

      await run("ask");

      expect(deps.modelConsole.logLlmCall).toHaveBeenCalledWith("Prefix · Answer on draft.md", {
        failed: false,
        model: "m",
        options: ["2"],
      });
      expect(deps.modelConsole.beginLlmActivity).toHaveBeenCalledWith("anthropic/claude-haiku-4-5");
      expect(deps.modelConsole.endLlmActivity).toHaveBeenCalledWith("anthropic/claude-haiku-4-5");
      acceptAll(view);
      expect(view.state.doc.toString()).toBe("one 2 three");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logs what a generation sent as context to the Console, and hands back only its warnings", async () => {
    const sent = {
      path: "/draft.md",
      files: ["/AGENTS.md"],
      searches: [],
      messages: [
        { level: "info", text: "Cut /AGENTS.md to its first 8,000 characters." },
        { level: "warn", text: "Left out /secret.md: it's private." },
      ],
    };
    answer(200, { reply: "Shot 1", model: "m", context: sent });
    try {
      const { deps, file, run } = setup();
      deps.loadFile.mockResolvedValueOnce({
        ...file,
        graph: {
          nodes: [
            node("ask", "button", 0, { label: "Ask" }),
            node("gen", "generateText", 0),
            node("show", "showResult", 0),
          ],
          edges: [
            edge("ask", "selection", "gen", "prompt"),
            edge("ask", "path", "gen", "context"),
            edge("gen", "text", "show", "text"),
          ],
        },
      });

      expect(await run("ask")).toEqual({ lines: ["Shot 1"], warnings: ["Left out /secret.md: it's private."] });
      expect(deps.modelConsole.logLlmCall).toHaveBeenCalledWith("Prefix · Generate Text (AI) on draft.md", {
        failed: false,
        model: "m",
        options: ["Shot 1"],
        context: [
          "Sent as context:",
          "/AGENTS.md",
          "Cut /AGENTS.md to its first 8,000 characters.",
          "Left out /secret.md: it's private.",
        ],
        warn: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts a failed model call as an error on the document, until a button runs on it again", async () => {
    answer(500, { message: "The model refused." });
    try {
      const { deps, file, run } = setup();
      deps.loadFile.mockResolvedValueOnce({ ...file, graph: asking });

      await expect(run("ask")).rejects.toThrow("The model refused.");
      expect(deps.notices.begin).toHaveBeenCalledWith("draft.md", "toolkit");
      expect(deps.notices.add).toHaveBeenCalledWith("draft.md", "toolkit", {
        level: "error",
        count: 1,
        kind: "LLM",
        label: "Prefix · Answer on draft.md",
        content: "The model refused.",
        need: undefined,
      });
      expect(deps.modelConsole.logLlmCall).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the setting a refused model call needs, on its error and on the document's notice", async () => {
    const need = { kind: "defaultModel", output: "text" } as const;
    answer(500, { message: "No model selected.", need });
    try {
      const { deps, file, run } = setup();
      deps.loadFile.mockResolvedValueOnce({ ...file, graph: asking });

      const refused = await run("ask").catch((error: unknown) => error);
      expect((refused as Error).message).toMatch(/: No model selected\.$/);
      expect(setupNeedOf(refused)).toEqual(need);
      expect(deps.notices.add).toHaveBeenCalledWith("draft.md", "toolkit", expect.objectContaining({ need }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records nothing of a generation the run stopped", async () => {
    const stop = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        stop.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    try {
      const { deps, file, invocation } = setup();
      deps.loadFile.mockResolvedValueOnce({ ...file, graph: asking });

      await expect(runToolkitAction(invocation, "ask", deps, stop.signal)).rejects.toThrow();
      expect(deps.modelConsole.logLlmCall).not.toHaveBeenCalled();
      expect(deps.notices.add).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs the Lyrics shape: options from the model, stepped through in the proposal", async () => {
    answer(200, { options: ["deux", "zwei"], model: "m" });
    try {
      const { view, deps, file, run } = setup();
      deps.loadFile.mockResolvedValueOnce({
        ...file,
        graph: {
          nodes: [
            node("rhyme", "button", 0, { label: "Rhyme match", config: { requireSelection: "true" } }),
            node("opts", "generateOptions", 0, { config: { count: "2" } }),
            node("put", "replaceSelection", 0),
          ],
          edges: [edge("rhyme", "selection", "opts", "prompt"), edge("opts", "options", "put", "options")],
        },
      });

      await run("rhyme");

      expect(deps.modelConsole.logLlmCall).toHaveBeenCalledWith("Prefix · Generate Options (AI) on draft.md", {
        failed: false,
        model: "m",
        options: ["deux", "zwei"],
      });
      expect(view.dom.querySelector(".cm-proposal-position")?.textContent).toBe("1/2");
      view.dom.querySelector<HTMLButtonElement>(".cm-proposal-next")?.click();
      acceptAll(view);
      expect(view.state.doc.toString()).toBe("one zwei three");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A side input with a grant of its own, the style guide a Load Note reads,
  // never runs either: the Button runs before anything else.
  it("with Require a selection on the Button, a click with nothing selected runs and asks nothing", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { view, deps, broker, file, run } = setup();
      view.dispatch({ selection: { anchor: 0 } });
      deps.loadFile.mockResolvedValueOnce({
        ...file,
        graph: {
          nodes: [
            node("rhyme", "button", 0, { label: "Rhyme match", config: { requireSelection: "true" } }),
            node("guide", "loadNote", 0, { config: { notePath: "space:style-guide.md" } }),
            node("ask", "joinText", 0, { config: { separator: "" } }),
            node("opts", "generateOptions", 0),
            node("put", "replaceSelection", 0),
          ],
          edges: [
            edge("guide", "body", "ask", "text_1"),
            edge("rhyme", "selection", "ask", "text_2"),
            edge("ask", "text", "opts", "prompt"),
            edge("opts", "options", "put", "options"),
          ],
        },
      });

      await expect(run("rhyme")).rejects.toThrow("Rhyme match: Select some text first");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(broker.ensure).not.toHaveBeenCalled();
      expect(broker.ensureAll).not.toHaveBeenCalled();
      expect(pendingChanges(view.state)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runToolkitAction in a Table", () => {
  // The rows a click hands on, through a zone, into one exposed line.
  const perRow: FlowGraph = {
    nodes: [
      node("go", "button", 0, { label: "Titles" }),
      node("each", "forEach", 0),
      node("field", "getField", 0, { config: { field1Key: "title" } }),
      node("end", "forEachEnd", 0, { config: { forEach: "each" } }),
      node("join", "joinText", 0, { config: { separator: ", " }, exposed: ["text"] }),
    ],
    edges: [
      edge("go", "rows", "each", "list"),
      edge("each", "item", "field", "object"),
      edge("field", "field_1", "end", "value_1"),
      edge("end", "list_1", "join", "list"),
    ],
  };

  function inTable(graph: FlowGraph, at: Partial<TableAtClick> = {}) {
    const ran = setup();
    ran.deps.loadFile.mockResolvedValueOnce({ ...ran.file, graph });
    const invocation = {
      flow: { path: ran.file.path, name: "Prefix" },
      path: "shots.table.html",
      source: {
        kind: "table" as const,
        at: {
          content: "<table></table>",
          columns: [{ id: "title", label: "Title", type: "text" as const }],
          rows: [{ values: { title: "Dawn" } }, { values: { title: "Dusk" } }],
          private: false,
          ...at,
        },
      },
      openToSide: vi.fn(async () => {}),
    };
    const row = { ask: vi.fn(async (_ask: ToolkitAsk, _signal: AbortSignal) => false) };
    const run = (id: string) => runToolkitAction(invocation, id, ran.deps, new AbortController().signal, row);
    return { ...ran, run, row };
  }

  it("hands the Button the rows ticked at the click, keyed by column id", async () => {
    const { run } = inTable(perRow);
    expect(await run("go")).toEqual({ lines: ["Join Text · text: Dawn, Dusk"], warnings: [] });
  });

  it("stops a click with no row ticked before asking anything", async () => {
    const { run, broker } = inTable(perRow, { rows: [] });
    await expect(run("go")).rejects.toThrow("Titles: Tick some rows first");
    expect(broker.ensureAll).not.toHaveBeenCalled();
  });

  it("never reads a private Table's rows", async () => {
    const { run } = inTable(perRow, { private: true });
    await expect(run("go")).rejects.toThrow("visibility: private");
  });

  it("refuses a button that proposes text, before anything runs or asks", async () => {
    const { run, broker } = inTable(graph);
    await expect(run("btn-a")).rejects.toThrow(
      "Replace Selection needs a text document, and this button is a Table's.",
    );
    expect(broker.ensureAll).not.toHaveBeenCalled();
  });

  it("asks once for a column whose paths a zone reads, on the Table clicked in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      const { run, broker } = inTable(
        {
          nodes: [
            node("go", "button", 0, { label: "Notes" }),
            node("each", "forEach", 0),
            node("field", "getField", 0, { config: { field1Key: "script" } }),
            node("load", "loadNote", 0),
            node("end", "forEachEnd", 0, { config: { forEach: "each" } }),
          ],
          edges: [
            edge("go", "rows", "each", "list"),
            edge("each", "item", "field", "object"),
            edge("field", "field_1", "load", "path"),
            edge("load", "raw", "end", "value_1"),
          ],
        },
        { columns: [{ id: "script", label: "Script", type: "path" }], rows: [{ values: { script: "a.md" } }] },
      );
      await run("go").catch(() => undefined);
      const [asked] = vi.mocked(broker.ensureAll).mock.calls[0];
      expect(asked.map((capability) => capability.key)).toContain("readColumn:space:shots.table.html#script");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks in the run's row once the first row generated, and runs no other on Stop", async () => {
    answer(200, { reply: "made", model: "m" });
    try {
      const { run, row } = inTable({
        nodes: [
          node("go", "button", 0, { label: "Write" }),
          node("each", "forEach", 0),
          node("field", "getField", 0, { config: { field1Key: "title" } }),
          node("gen", "generateText", 0, { config: { model: "anthropic/claude-haiku-4-5" } }),
          node("end", "forEachEnd", 0, { config: { forEach: "each" } }),
        ],
        edges: [
          edge("go", "rows", "each", "list"),
          edge("each", "item", "field", "object"),
          edge("field", "field_1", "gen", "prompt"),
          edge("gen", "text", "end", "value_1"),
        ],
      });
      await run("go");
      expect(row.ask).toHaveBeenCalledTimes(1);
      expect(row.ask.mock.calls[0][0]).toEqual({ title: "Row 1 done", files: [], rest: 1 });
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("generate"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
