import { describe, expect, it, vi } from "vitest";
import type { SandboxReadResult } from "../../src/protocol/api.ts";
import { columnAddresses, type NodeExecutionContext } from "../../src/protocol/flowExecutors.ts";
import {
  columnCapabilityOfKey,
  pathColumns,
  refusesWire,
  rowColumnUses,
  runCapabilities,
} from "../../src/protocol/flowNodes.ts";
import { runFlow } from "../../src/protocol/flowRuntime.ts";
import { flowZones, zonePartners, zoneProblems } from "../../src/protocol/flowZones.ts";
import {
  type FlowCapabilityDeclaration,
  type FlowEdgeInstance,
  type FlowGraph,
  type FlowNodeInstance,
  flowCapabilityKey,
  type TableColumn,
} from "../../src/protocol/types.ts";

type Read = NodeExecutionContext["sandbox"]["read"];

function context(read: Read, overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    flowPath: "t.flow.html",
    sandbox: {
      read,
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(async () => ({ reply: "made", model: "m" })),
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
    clock: { year: 2026, month: 11, day: 27, hour: 9, minute: 0, second: 0, offset: 0 },
    ...overrides,
  };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
  id,
  type,
  position: { x: 0, y: 0 },
  config,
});

const wire = (source: string, sourcePort: string, target: string, targetPort: string): FlowEdgeInstance => ({
  id: `${source}.${sourcePort}>${target}.${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});

const COLUMNS: TableColumn[] = [
  { id: "title", type: "text", label: "Title" },
  { id: "note", type: "path", label: "Note" },
];

function shots(titles: string[]): SandboxReadResult {
  return {
    kind: "table",
    columns: COLUMNS,
    rows: titles.map((title) => ({ values: { title, note: `notes/${title.toLowerCase()}.md` } })),
  };
}

// A note per row, read from the path its Note column holds.
function reads(titles: string[], missing?: string): Read {
  return vi.fn(async (_kind: string, _flow: string, target: string): Promise<SandboxReadResult> => {
    if (target.endsWith("shots.table.html")) return shots(titles);
    if (missing && target.endsWith(`${missing}.md`)) throw new Error("no such note");
    return { kind: "text", content: `# ${target.split("/").pop()}` };
  }) as Read;
}

// Load Table → For Each → a Get Field of `field1Key` → For Each End → Join Text.
function zone(
  field: string,
  between: { nodes: FlowNodeInstance[]; edges: FlowEdgeInstance[] } = { nodes: [], edges: [] },
) {
  const last = between.nodes.at(-1);
  return {
    nodes: [
      node("rows", "loadTableRows", { tablePath: "shots.table.html" }),
      node("each", "forEach"),
      node("field", "getField", { field1Key: field }),
      ...between.nodes,
      node("end", "forEachEnd", { forEach: "each" }),
      node("join", "joinText", { separator: ", " }),
    ],
    edges: [
      wire("rows", "rows", "each", "list"),
      wire("each", "item", "field", "object"),
      ...between.edges,
      ...(last ? [] : [wire("field", "field_1", "end", "value_1")]),
      wire("end", "list_1", "join", "list"),
    ],
  } satisfies FlowGraph;
}

const loadNote = {
  nodes: [node("load", "loadNote")],
  edges: [wire("field", "field_1", "load", "path"), wire("load", "raw", "end", "value_1")],
};

describe("a For Each zone", () => {
  it("runs the nodes between For Each and its End once per item, collecting in item order", async () => {
    const result = await runFlow(zone("title"), context(reads(["Opening", "Kite", "Walk"])));

    expect(result.errors.size).toBe(0);
    expect(result.outputs.get("end")?.list_1).toEqual({ type: "object", value: ["Opening", "Kite", "Walk"] });
    expect(result.outputs.get("join")?.text).toEqual({ type: "text", value: "Opening, Kite, Walk" });
    expect(result.zones?.get("each")?.items).toHaveLength(3);
  });

  it("numbers each item from 1", async () => {
    const graph = zone("title");
    graph.nodes.push(node("number", "numberToText"));
    graph.edges.push(wire("each", "index", "number", "number"), wire("number", "text", "end", "value_2"));
    const result = await runFlow(graph, context(reads(["A", "B", "C"])));
    expect(result.outputs.get("end")?.list_2).toEqual({ type: "object", value: ["1", "2", "3"] });
  });

  it("finds its nodes from the wires, stopping at its End", () => {
    const graph = zone("note", loadNote);
    expect([...(flowZones(graph).get("each")?.members ?? [])].sort()).toEqual(["field", "load"]);
    expect(flowZones(graph).get("each")?.end).toBe("end");
  });

  it("drops a failed item from every list and runs the rest, naming the failed row on the node", async () => {
    const report = vi.fn();
    const result = await runFlow(zone("note", loadNote), context(reads(["A", "B", "C"], "b"), { report }));

    expect(result.outputs.get("end")?.list_1).toEqual({ type: "object", value: ["# a.md", "# c.md"] });
    expect(result.errors.get("load")).toBe("Row 2: no such note");
    expect(result.errors.has("end")).toBe(false);
    expect(result.errors.has("field")).toBe(false);
    expect(report).toHaveBeenCalledWith("end", ["2 of 3 rows; row 2 failed"]);
  });

  it("gives nothing for an empty list, and skips what its End feeds", async () => {
    const report = vi.fn();
    const result = await runFlow(zone("title"), context(reads([]), { report }));

    expect(result.outputs.has("end")).toBe(false);
    expect(result.errors.has("end")).toBe(false);
    expect(result.skipped.get("join")).toBe("end");
    expect(report).toHaveBeenCalledWith("end", ["No rows"]);
  });

  it("runs at most four items side by side", async () => {
    let going = 0;
    let most = 0;
    const read = vi.fn(async (_kind: string, _flow: string, target: string): Promise<SandboxReadResult> => {
      if (target.endsWith("shots.table.html")) return shots(["A", "B", "C", "D", "E", "F"]);
      going++;
      most = Math.max(most, going);
      await new Promise((resolve) => setTimeout(resolve, 5));
      going--;
      return { kind: "text", content: "# x" };
    }) as Read;
    const result = await runFlow(zone("note", loadNote), context(read));

    expect(most).toBe(4);
    expect(result.outputs.get("end")?.list_1).toEqual({ type: "object", value: Array(6).fill("# x") });
  });

  it("fails For Each without a list, and every node it owns with it", async () => {
    const graph = zone("title");
    graph.edges = graph.edges.filter((edge) => edge.target !== "each");
    const result = await runFlow(graph, context(reads(["A"])));
    expect(result.errors.get("each")).toBe("For Each needs a list. Wire one into it, such as Load Table's rows.");
    expect(result.errors.get("field")).toBe('upstream node "each" failed');
    expect(result.errors.get("end")).toBe('upstream node "each" failed');
    expect(result.errors.get("join")).toBe('upstream node "end" failed');
  });
});

describe("a zone with a Generate node", () => {
  const generating = {
    nodes: [node("gen", "generateText")],
    edges: [wire("field", "field_1", "gen", "prompt"), wire("gen", "text", "end", "value_1")],
  };

  it("runs one row, then asks before the rest; Stop ends the run with nothing after the zone", async () => {
    const confirmRest = vi.fn(async () => false);
    const ctx = context(reads(["A", "B", "C"]), { confirmRest });
    const result = await runFlow(zone("title", generating), ctx);

    expect(ctx.sandbox.generate).toHaveBeenCalledTimes(1);
    expect(confirmRest).toHaveBeenCalledWith({ forEach: "each", done: 1, rest: 2, word: "Row", files: [] });
    expect(result.zones?.get("each")?.stopped).toBe(true);
    expect(result.zones?.get("each")?.items.filter(Boolean)).toHaveLength(1);
    expect(result.skipped.get("end")).toBe("each");
    expect(result.skipped.get("join")).toBe("each");
    expect(result.errors.size).toBe(0);
  });

  it("runs the rest once the person goes on", async () => {
    const confirmRest = vi.fn(async () => true);
    const ctx = context(reads(["A", "B", "C"]), { confirmRest });
    const result = await runFlow(zone("title", generating), ctx);

    expect(confirmRest).toHaveBeenCalledTimes(1);
    expect(ctx.sandbox.generate).toHaveBeenCalledTimes(3);
    expect(result.outputs.get("join")?.text).toEqual({ type: "text", value: "made, made, made" });
  });

  it("asks nobody when no one is present, and runs every row", async () => {
    const ctx = context(reads(["A", "B", "C"]));
    await runFlow(zone("title", generating), ctx);
    expect(ctx.sandbox.generate).toHaveBeenCalledTimes(3);
  });

  it("counts a row answered from memory as no generation", async () => {
    const graph = zone("title", generating);
    (graph.nodes.find((each) => each.id === "gen") as FlowNodeInstance).config.reuse = "true";
    let first: string | undefined;
    const recall = (_id: string, fingerprint: string) => {
      first ??= fingerprint;
      return fingerprint === first ? { text: { type: "text" as const, value: "held" } } : undefined;
    };
    const confirmRest = vi.fn(async () => true);
    await runFlow(graph, context(reads(["A", "B", "C"]), { confirmRest }), undefined, undefined, recall);
    expect(confirmRest).toHaveBeenCalledWith({ forEach: "each", done: 2, rest: 1, word: "Row", files: [] });
  });

  it("asks with the files the row's Generate nodes made", async () => {
    const graph = zone("title", {
      nodes: [node("gen", "generateImage", { outputFolderPath: "renders" })],
      edges: [wire("field", "field_1", "gen", "prompt"), wire("gen", "path", "end", "value_1")],
    });
    const generateImage = vi.fn(async () => ({
      path: "renders/A.png",
      image: { mediaType: "image/png" as const, data: "" },
      model: "m",
      take: "1",
      warnings: [],
    }));
    const confirmRest = vi.fn(async () => false);
    const ctx = context(reads(["A", "B"]), { confirmRest });
    ctx.sandbox.generateImage = generateImage as never;
    await runFlow(graph, ctx);
    expect(confirmRest).toHaveBeenCalledWith(expect.objectContaining({ done: 1, rest: 1, files: ["/renders/A.png"] }));
  });
});

describe("a zone a run can't run", () => {
  it("fails a For Each whose zone holds another", async () => {
    const graph = zone("title");
    graph.nodes.push(node("inner", "forEach"), node("innerEnd", "forEachEnd", { forEach: "inner" }));
    graph.edges.push(wire("field", "field_1", "inner", "list"));
    const zones = flowZones(graph);
    expect(zoneProblems(graph, zones).get("each")).toBe(
      `Its zone holds "inner", and one For Each can't run inside another.`,
    );
    const result = await runFlow(graph, context(reads(["A"])));
    expect(result.errors.get("each")).toBe(`Its zone holds "inner", and one For Each can't run inside another.`);
    expect(result.errors.get("end")).toBe('upstream node "each" failed');
  });

  it("fails an End naming no For Each", async () => {
    const graph: FlowGraph = { nodes: [node("end", "forEachEnd", { forEach: "gone" })], edges: [] };
    const result = await runFlow(graph, context(reads([])));
    expect(result.errors.get("end")).toBe("Its For Each is gone. Add For Each again, which brings its own End.");
  });
});

describe("a column grant", () => {
  const imageZone = (rowsConfig: Record<string, unknown>, field: string, target = "loadImage") => ({
    nodes: [
      node("rows", "loadTableRows", rowsConfig),
      node("each", "forEach"),
      node("field", "getField", { field1Key: field }),
      node("use", target),
    ],
    edges: [
      wire("rows", "rows", "each", "list"),
      wire("each", "item", "field", "object"),
      wire("field", "field_1", "use", "path"),
    ],
  });

  it("is asked for up front for a path a column hands straight to a node, keyed by Table and column", () => {
    const needs = runCapabilities(imageZone({ tablePath: "shots.table.html" }, "image"), "t.flow.html");
    expect(needs).toEqual([
      { nodeId: "rows", capability: { type: "readFile", path: "space:shots.table.html" } },
      { nodeId: "use", capability: { type: "readColumn", path: "space:shots.table.html", column: "image" } },
    ]);
    expect(flowCapabilityKey(needs[1].capability)).toBe("readColumn:space:shots.table.html#image");
  });

  it("covers writes the same way, but not a folder written into", () => {
    expect(pathColumns(imageZone({ tablePath: "s.table.html" }, "out", "writeNote")).get("use")).toEqual({
      type: "writeColumn",
      path: "s.table.html",
      column: "out",
    });
    expect(pathColumns(imageZone({ tablePath: "s.table.html" }, "out", "writeFolderNote")).size).toBe(0);
  });

  it("names no column for a Table the graph doesn't name, or a key that isn't a column id", () => {
    const wiredTable = imageZone({}, "image");
    wiredTable.nodes.push(node("src", "prompt", { text: "s.table.html" }));
    wiredTable.edges.push(wire("src", "text", "rows", "path"));
    expect(pathColumns(wiredTable).size).toBe(0);
    expect(pathColumns(imageZone({ tablePath: "s.table.html" }, "Image")).size).toBe(0);
  });

  it("is what the node asks for in place of each file's", async () => {
    const graph = zone("note", loadNote);
    const ensureCapability = vi.fn(async (_capability: FlowCapabilityDeclaration) => true);
    await runFlow(graph, context(reads(["A", "B"]), { ensureCapability }));
    const asked = ensureCapability.mock.calls.map(([capability]) => flowCapabilityKey(capability));
    expect(asked).toEqual([
      "readFile:shots.table.html",
      "readColumn:space:shots.table.html#note",
      "readColumn:space:shots.table.html#note",
    ]);
  });

  it("reaches the files the column names, read as a run hands them on", () => {
    const file = {
      columns: [
        { id: "image", type: "media" as const, label: "Image" },
        { id: "title", type: "text" as const, label: "Title" },
      ],
      rows: [{ values: { image: "a.png", title: "x.md" } }, { values: { image: "", title: "" } }],
    };
    expect([...columnAddresses("flows/t.flow.html", "space:shots/s.table.html", file, "image")]).toEqual([
      "space:shots/a.png",
    ]);
    expect([...columnAddresses("flows/t.flow.html", "space:shots/s.table.html", file, "title")]).toEqual([
      "space:flows/x.md",
    ]);
    expect(columnAddresses("t.flow.html", "space:s.table.html", file, "gone").size).toBe(0);
  });
});

describe("Join Text's list", () => {
  it("joins a wired list's texts in place of the three", async () => {
    const graph = zone("title");
    (graph.nodes.find((each) => each.id === "join") as FlowNodeInstance).config.text_1 = "not joined";
    const result = await runFlow(graph, context(reads(["A", "B"])));
    expect(result.outputs.get("join")?.text).toEqual({ type: "text", value: "A, B" });
  });

  it("fails on a list holding anything but texts", async () => {
    const graph = zone("title");
    graph.edges = graph.edges.map((edge) => (edge.target === "join" ? wire("rows", "rows", "join", "list") : edge));
    const result = await runFlow(graph, context(reads(["A"])));
    expect(result.errors.get("join")).toBe("Join Text joins texts, and item 1 of its list isn't one.");
  });
});

describe("the wires an editor refuses around a zone", () => {
  const graph = () => zone("title");

  it("refuses a wire from inside a zone into a node after its End", () => {
    expect(refusesWire(graph(), "field", "join")).toBe(true);
  });

  it("refuses a wire that puts another For Each inside the zone", () => {
    const nested = graph();
    nested.nodes.push(node("inner", "forEach"));
    expect(refusesWire(nested, "field", "inner")).toBe(true);
  });

  it("takes a wire that brings a free node into the zone, and still refuses a loop", () => {
    const free = graph();
    free.nodes.push(node("show", "showText"));
    expect(refusesWire(free, "field", "show")).toBe(false);
    expect(refusesWire(free, "end", "field")).toBe(true);
  });

  it("pairs a For Each with its End, from either one", () => {
    expect(zonePartners(graph(), "each")).toEqual(["end"]);
    expect(zonePartners(graph(), "end")).toEqual(["each"]);
    expect(zonePartners(graph(), "field")).toEqual([]);
  });
});

describe("a column grant from a toolkit's Table", () => {
  const buttonZone = () => ({
    nodes: [
      node("click", "button"),
      node("each", "forEach"),
      node("field", "getField", { field1Key: "image" }),
      node("use", "loadImage"),
    ],
    edges: [
      wire("click", "rows", "each", "list"),
      wire("each", "item", "field", "object"),
      wire("field", "field_1", "use", "path"),
    ],
  });

  it("is asked for the Table the toolkit runs in, and names none without one", () => {
    expect(pathColumns(buttonZone()).size).toBe(0);
    expect(runCapabilities(buttonZone(), "t.flow.html", undefined, "space:shots.table.html")).toEqual([
      { nodeId: "click", capability: { type: "readCurrentDocument" } },
      { nodeId: "use", capability: { type: "readColumn", path: "space:shots.table.html", column: "image" } },
    ]);
  });

  it("names the column and its access a host accepts, whichever Table it is", () => {
    expect(rowColumnUses(buttonZone())).toEqual([{ access: "read", column: "image" }]);
    expect(rowColumnUses(zone("note", loadNote))).toEqual([]);
  });

  it("reads a column key back, refusing one that isn't a column id or spelled otherwise", () => {
    expect(columnCapabilityOfKey("readColumn:space:a#b.table.html#image")).toEqual({
      type: "readColumn",
      path: "space:a#b.table.html",
      column: "image",
    });
    for (const key of ["readColumn:space:s.table.html#Image", "readFile:space:s.table.html#image", "readColumn:x"]) {
      expect(columnCapabilityOfKey(key), key).toBeUndefined();
    }
  });
});
