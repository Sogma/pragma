import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { actionGraph, flowActions, runAction, upstreamGraph } from "../../src/protocol/flowActions.ts";
import type { NodeExecutionContext } from "../../src/protocol/flowExecutors.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { computeFlowCapabilities } from "../../src/protocol/flowNodes.ts";
import type { FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";

function node(id: string, type: string, x: number, y: number, label?: string): FlowNodeInstance {
  return { id, type, position: { x, y }, config: {}, ...(label ? { label } : {}) };
}

function edge(source: string, target: string, sourcePort = "text", targetPort = "text") {
  return { id: `${source}-${target}`, source, sourcePort, target, targetPort };
}

// Two buttons, each with its own Generate, sharing a style guide read beside
// the document through a plain Current Document.
const graph: FlowGraph = {
  nodes: [
    node("tighten", "button", 0, 0, "Tighten"),
    node("expand", "button", 0, 200, "Expand"),
    node("doc", "currentDocument", 0, 100),
    node("guide", "loadNote", 150, 100),
    node("ask-a", "templateVariables", 300, 0),
    node("ask-b", "templateVariables", 300, 200),
    node("gen-a", "generateText", 450, 0),
    node("gen-b", "generateText", 450, 200),
    node("put-a", "replaceSelection", 600, 0),
    node("put-b", "replaceSelection", 600, 200),
    node("stray", "showText", 900, 400),
  ],
  edges: [
    edge("doc", "guide", "path", "path"),
    edge("tighten", "ask-a", "selection", "var_2"),
    edge("guide", "ask-a", "body", "var_1"),
    edge("expand", "ask-b", "selection", "var_2"),
    edge("guide", "ask-b", "body", "var_1"),
    edge("ask-a", "gen-a", "text", "instruction"),
    edge("ask-b", "gen-b", "text", "instruction"),
    edge("gen-a", "put-a"),
    edge("gen-b", "put-b"),
    edge("doc", "stray", "title", "text"),
  ],
};

const ids = (part: FlowGraph) => part.nodes.map((n) => n.id).sort();

describe("flowActions", () => {
  it("makes each Button a button, top to bottom on the canvas", () => {
    expect(flowActions(graph)).toEqual([
      { nodeId: "tighten", label: "Tighten", nodeType: "replaceSelection" },
      { nodeId: "expand", label: "Expand", nodeType: "replaceSelection" },
    ]);
  });

  it("gives no button for a Button a run leaves out, and none for an ending", () => {
    const disabled: FlowGraph = {
      ...graph,
      nodes: graph.nodes.map((each) => (each.id === "tighten" ? { ...each, mode: "disabled" as const } : each)),
    };
    expect(flowActions(disabled).map((action) => action.nodeId)).toEqual(["expand"]);
    const endings: FlowGraph = {
      nodes: [node("r", "replaceSelection", 0, 0), node("s", "showResult", 0, 50)],
      edges: [],
    };
    expect(flowActions(endings)).toEqual([]);
  });

  it("carries a Button's color and comment, and none for one without", () => {
    const decorated: FlowGraph = {
      nodes: [
        { ...node("red", "button", 0, 0, "Red"), color: "#f0353b", comment: "Cuts what the line doesn't need." },
        node("plain", "button", 0, 50),
      ],
      edges: [],
    };
    expect(flowActions(decorated)).toStrictEqual([
      {
        nodeId: "red",
        label: "Red",
        comment: "Cuts what the line doesn't need.",
        nodeType: "button",
        color: "#f0353b",
      },
      { nodeId: "plain", label: "Button", nodeType: "button" },
    ]);
  });

  it("numbers a repeated label from its second use, and falls back to the type's label", () => {
    const unnamed: FlowGraph = {
      nodes: [node("a", "button", 0, 0), node("b", "button", 0, 50), node("c", "button", 0, 99)],
      edges: [],
    };
    expect(flowActions(unnamed).map((action) => action.label)).toEqual(["Button", "Button (2)", "Button (3)"]);
  });

  // The glyph says what the click does: a proposal over the selection, work
  // elsewhere (a write, even with a receipt after it), a file opened beside
  // the document, then an answer.
  it("wears the glyph of what its click does", () => {
    const glyph = (...after: [string, string][]): string => {
      const nodes = [
        node("go", "button", 0, 0),
        ...after.map(([id, type], index) => node(id, type, 300 * (index + 1), 0)),
      ];
      const edges = after.map(([id], index) =>
        edge(index === 0 ? "go" : after[index - 1][0], id, index === 0 ? "selection" : "text"),
      );
      return flowActions({ nodes, edges })[0].nodeType;
    };
    expect(glyph(["put", "replaceSelection"])).toBe("replaceSelection");
    expect(glyph(["save", "writeNote"], ["say", "showResult"])).toBe("button");
    expect(glyph(["open", "openToSide"])).toBe("openToSide");
    expect(glyph(["say", "showResult"])).toBe("showResult");
    expect(glyph(["show", "showText"])).toBe("button");
  });
});

describe("actionGraph", () => {
  it("keeps the Button, what its wires reach and what those need, and nothing on another button's branch", () => {
    expect(ids(actionGraph(graph, "tighten"))).toEqual(["ask-a", "doc", "gen-a", "guide", "put-a", "tighten"]);
    expect(actionGraph(graph, "tighten").edges.map((e) => e.id)).not.toContain("expand-ask-b");
  });

  it("leaves out a node no wire from the Button reaches, even one a shared node feeds", () => {
    expect(ids(actionGraph(graph, "expand"))).not.toContain("stray");
  });

  it("keeps every ending a click reaches", () => {
    const fanned: FlowGraph = {
      nodes: [
        node("go", "button", 0, 0),
        node("save", "writeNote", 300, 0),
        node("open", "openToSide", 600, 0),
        node("say", "showResult", 600, 100),
      ],
      edges: [edge("go", "save", "raw"), edge("save", "open", "path", "path"), edge("save", "say", "path")],
    };
    expect(ids(actionGraph(fanned, "go"))).toEqual(["go", "open", "save", "say"]);
  });
});

describe("upstreamGraph", () => {
  it("keeps a node and what it depends on, and nothing after it", () => {
    expect(ids(upstreamGraph(graph, "gen-a"))).toEqual(["ask-a", "doc", "gen-a", "guide", "tighten"]);
  });
});

describe("runAction", () => {
  const context = (hasSelection: boolean): NodeExecutionContext => ({
    flowPath: "toolkit.flow.html",
    sandbox: {
      read: vi.fn(),
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    },
    decodeImageDimensions: async () => ({ width: 1, height: 1 }),
    pickedImages: new Map(),
    ensureCapability: vi.fn(async () => true),
    beginLlmActivity: vi.fn(),
    endLlmActivity: vi.fn(),
    scopes: async () => new Set<string>(),
    clock: { year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0, offset: 0 },
    document: {
      path: "brochure.md",
      hasSelection,
      read: () => ({ content: "Spring at the lake.\n", selection: hasSelection ? "Spring" : "" }),
      replaceSelection: vi.fn(),
      showResult: vi.fn(),
    },
  });
  // A prompt beside the Button's chain, which nothing about the click feeds.
  const prompted: FlowGraph = {
    nodes: [
      { ...node("go", "button", 0, 0), config: { requireSelection: "true" } },
      { ...node("say", "prompt", 0, 100), config: { text: "Translate:" } },
      { ...node("join", "joinText", 300, 0), config: { separator: "" } },
      node("show", "showResult", 600, 0),
    ],
    edges: [edge("say", "join", "text", "text_1"), edge("go", "join", "selection", "text_2"), edge("join", "show")],
  };

  it("runs the Button before anything else, then its part", async () => {
    const result = await runAction(actionGraph(prompted, "go"), "go", context(true));
    expect(result.errors.size).toBe(0);
    expect(result.outputs.get("show")?.text).toEqual({ type: "text", value: "Translate:Spring" });
  });

  it("starts nothing else when the Button fails, and reports only the Button", async () => {
    const run = context(false);
    const result = await runAction(actionGraph(prompted, "go"), "go", run);
    expect([...result.errors.keys()]).toEqual(["go"]);
    expect(result.errors.get("go")).toBe("Select some text first");
    expect(result.outputs.has("say")).toBe(false);
    expect(run.ensureCapability).not.toHaveBeenCalled();
  });

  it.each(["projects/translation", "clients/Another client"])(
    "adds the template's client query beside the document in %s",
    async (folder) => {
      const flowPath = "projects/translation/tools/review.flow.html";
      const file = new URL(`../../templates/space/${flowPath}`, import.meta.url);
      const flow = parseFlowFile(await readFile(file, "utf8"));
      expect(flow).toBeDefined();
      if (!flow) return;
      const button = flowActions(flow.graph).find((action) => action.label === "Query client");
      expect(button).toBeDefined();
      if (!button) return;

      const run = context(true);
      run.flowPath = flowPath;
      const question = "Which months does spring cover here?";
      const tablePath = `${folder}/queries.table.html`;
      const addRow = vi.fn(async () => ({ path: tablePath }));
      const generate = vi.fn(async () => ({ reply: question, model: "test-model" }));
      run.sandbox = { ...run.sandbox, addRow, generate };
      run.document = {
        path: `${folder}/brochure.md`,
        hasSelection: true,
        read: () => ({ content: "Spring at the lake.\n", selection: "Spring" }),
        replaceSelection: vi.fn(),
        showResult: vi.fn(),
      };

      const result = await runAction(actionGraph(flow.graph, button.nodeId), button.nodeId, run);

      expect([...result.errors]).toEqual([]);
      expect(addRow).toHaveBeenCalledExactlyOnceWith("flow", flowPath, `space:${tablePath}`, {
        passage: "Spring",
        question,
        document: `/${folder}/brochure.md`,
      });
      expect(run.ensureCapability).toHaveBeenCalledWith({
        type: "writeDocument",
        path: `space:${tablePath}`,
        wired: true,
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(run.sandbox.read).not.toHaveBeenCalled();
      expect(run.document.showResult).toHaveBeenCalledWith([`Added the query to /${tablePath}`]);
    },
  );
});

describe("runAction on an old toolkit", () => {
  // A Button from before buttons came first took a text wire. Its run fails
  // at that Button, naming the pin, rather than waiting on what feeds it.
  it("fails an old Button at its missing pin, not as a cycle", async () => {
    const old: FlowGraph = {
      nodes: [{ ...node("say", "prompt", 0, 0), config: { text: "Saved." } }, node("go", "button", 300, 0)],
      edges: [edge("say", "go")],
    };
    const result = await runAction(old, "go", {
      flowPath: "toolkit.flow.html",
      sandbox: {} as NodeExecutionContext["sandbox"],
      decodeImageDimensions: async () => ({ width: 1, height: 1 }),
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      scopes: async () => new Set<string>(),
      clock: { year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0, offset: 0 },
    });
    expect([...result.errors.keys()]).toEqual(["go"]);
    expect(result.errors.get("go")).toMatch(/text/);
    expect(result.errors.get("go")).not.toMatch(/cyclic/);
  });
});

describe("the document nodes' capabilities", () => {
  it("Current Document declares readCurrentDocument; Replace Selection and Open to the Side declare nothing", () => {
    expect(computeFlowCapabilities(graph, "toolkit.flow.html")).toContainEqual({ type: "readCurrentDocument" });
    expect(
      computeFlowCapabilities(
        { nodes: [node("r", "replaceSelection", 0, 0), node("o", "openToSide", 0, 50)], edges: [] },
        "toolkit.flow.html",
      ),
    ).toEqual([]);
  });

  it("a Button declares readCurrentDocument only while its selection or raw is wired", () => {
    const wiredFrom = (port: string): FlowGraph => ({
      nodes: [node("go", "button", 0, 0), node("where", "resolvePath", 300, 0)],
      edges: [edge("go", "where", port, "base")],
    });
    expect(computeFlowCapabilities(wiredFrom("path"), "toolkit.flow.html")).toEqual([]);
    expect(computeFlowCapabilities(wiredFrom("raw"), "toolkit.flow.html")).toEqual([{ type: "readCurrentDocument" }]);
    expect(computeFlowCapabilities(wiredFrom("selection"), "toolkit.flow.html")).toEqual([
      { type: "readCurrentDocument" },
    ]);
  });
});
