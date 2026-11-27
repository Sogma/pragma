import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { capabilityDigest, parseFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { changeColumnIdInFlows } from "../../src/server/columnIds.ts";
import { grantCapability, grantPath, isCapabilityGranted } from "../../src/server/grants.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

let space: string;

beforeEach(() => {
  isolateConfig();
  space = tempSpace("pragma-column-ids-");
  mkdirSync(path.join(space, "shoot", "tools"), { recursive: true });
});

const COLUMNS = [
  { id: "take", label: "Take", type: "text" },
  { id: "note", label: "Note", type: "text" },
];

// A Make Object and an Add Row holding a Table, both with `take` wired.
function logGraph(tablePath: string, columns: unknown[] = COLUMNS): FlowGraph {
  return {
    nodes: [
      { id: "p", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" } },
      {
        id: "fields",
        type: "makeObject",
        position: { x: 200, y: 0 },
        config: { tablePath, columns, values: { take: "kept", note: "typed" } },
      },
      {
        id: "add",
        type: "addRow",
        position: { x: 400, y: 0 },
        config: { tablePath, columns, values: { take: "typed" } },
      },
    ],
    edges: [
      { id: "e1", source: "p", sourcePort: "text", target: "fields", targetPort: "take" },
      { id: "e2", source: "fields", sourcePort: "object", target: "add", targetPort: "row" },
      { id: "e3", source: "p", sourcePort: "text", target: "add", targetPort: "take" },
    ],
  };
}

const flowFile = (relative: string) => path.join(space, relative);
const write = (relative: string, graph: FlowGraph) =>
  writeFileSync(flowFile(relative), serializeFlowFile({ version: "1.0", name: "Log", graph }));
const graphOf = (relative: string) => parseFlowFile(readFileSync(flowFile(relative), "utf8"))?.graph as FlowGraph;

describe("a column's id changed in the Flows naming it", () => {
  // A Make Object names the column when it holds that Table, read from its
  // Flow's folder, and has recorded the column.
  it("lists each Flow with a Make Object holding the Table and the column, writing nothing", async () => {
    write("shoot/tools/log.flow.html", logGraph("../shots.table.html"));
    write("shoot/beside.flow.html", logGraph("shots.table.html"));
    write("shoot/other.flow.html", logGraph("elsewhere.table.html"));
    write("shoot/stale.flow.html", logGraph("shots.table.html", [COLUMNS[1]]));
    const before = readFileSync(flowFile("shoot/tools/log.flow.html"), "utf8");

    const listed = await changeColumnIdInFlows(space, "shoot/shots.table.html", "take", "shot", false);
    expect(listed.sort()).toEqual(["shoot/beside.flow.html", "shoot/tools/log.flow.html"]);
    expect(readFileSync(flowFile("shoot/tools/log.flow.html"), "utf8")).toBe(before);
  });

  // The person changed the id and confirmed the Flows, so the change is
  // theirs, and a Flow's grants carry to the graph that only renamed a pin.
  it("renames the column, what was typed for it and the wires into its pin, in each node, keeping the grants", async () => {
    write("shoot/tools/log.flow.html", logGraph("../shots.table.html"));
    write("shoot/other.flow.html", logGraph("elsewhere.table.html"));
    const subject = (graph: FlowGraph) => ({
      path: grantPath(space, flowFile("shoot/tools/log.flow.html")),
      contentHash: capabilityDigest(graph),
    });
    const key = "writeDocument:space:shoot/shots.table.html";
    await grantCapability(space, subject(graphOf("shoot/tools/log.flow.html")), key);
    const untouched = readFileSync(flowFile("shoot/other.flow.html"), "utf8");

    expect(await changeColumnIdInFlows(space, "shoot/shots.table.html", "take", "shot", true)).toEqual([
      "shoot/tools/log.flow.html",
    ]);
    const after = graphOf("shoot/tools/log.flow.html");
    const fields = after.nodes.find((node) => node.id === "fields");
    expect(fields?.config.columns).toEqual([{ ...COLUMNS[0], id: "shot" }, COLUMNS[1]]);
    expect(fields?.config.values).toEqual({ note: "typed", shot: "kept" });
    const add = after.nodes.find((node) => node.id === "add");
    expect(add?.config.columns).toEqual([{ ...COLUMNS[0], id: "shot" }, COLUMNS[1]]);
    expect(add?.config.values).toEqual({ shot: "typed" });
    expect(after.edges.map((edge) => [edge.target, edge.targetPort])).toEqual([
      ["fields", "shot"],
      ["add", "row"],
      ["add", "shot"],
    ]);
    expect(await isCapabilityGranted(space, subject(after), key)).toBe(true);
    expect(readFileSync(flowFile("shoot/other.flow.html"), "utf8")).toBe(untouched);
  });

  // A loader of the Table hands its rows on keyed by column id, so the keys
  // read from them follow, as does a weight column the loader names; rows
  // from another Table keep theirs.
  it("renames a Load Random Row's weight column, and the keys picked from a loader's rows, passed on or not", async () => {
    const node = (id: string, type: string, config: Record<string, unknown>) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      config,
    });
    write("shoot/readers.flow.html", {
      nodes: [
        node("one", "loadRow", { tablePath: "shots.table.html", selectedValue: "BR2-001" }),
        node("some", "loadRandomRow", { tablePath: "shots.table.html", weightColumn: "take" }),
        node("all", "loadTableRows", { tablePath: "shots.table.html" }),
        node("other", "loadRow", { tablePath: "elsewhere.table.html" }),
        node("field", "getField", { field1Key: "note", field2Key: "take" }),
        node("random", "getField", { field1Key: "take" }),
        node("bars", "chart", { chartType: "bar", x: "take", y: "note" }),
        node("lines", "chart", { chartType: "line", x: "take", y: "note" }),
        node("shown", "showObject", {}),
        node("passed", "getField", { field1Key: "take" }),
        node("theirs", "getField", { field1Key: "take" }),
      ],
      edges: [
        { id: "e1", source: "one", sourcePort: "row", target: "field", targetPort: "object" },
        { id: "e2", source: "some", sourcePort: "row", target: "random", targetPort: "object" },
        { id: "e3", source: "all", sourcePort: "rows", target: "bars", targetPort: "rows" },
        { id: "e5", source: "bars", sourcePort: "rows", target: "lines", targetPort: "rows" },
        { id: "e6", source: "one", sourcePort: "row", target: "shown", targetPort: "object" },
        { id: "e7", source: "shown", sourcePort: "object", target: "passed", targetPort: "object" },
        { id: "e4", source: "other", sourcePort: "row", target: "theirs", targetPort: "object" },
      ],
    });

    expect(await changeColumnIdInFlows(space, "shoot/shots.table.html", "take", "shot", true)).toEqual([
      "shoot/readers.flow.html",
    ]);
    const config = (id: string) => graphOf("shoot/readers.flow.html").nodes.find((each) => each.id === id)?.config;
    expect(config("some")?.weightColumn).toBe("shot");
    expect(config("field")).toEqual({ field1Key: "note", field2Key: "shot" });
    expect(config("random")).toEqual({ field1Key: "shot" });
    expect(config("bars")).toEqual({ chartType: "bar", x: "shot", y: "note" });
    expect(config("lines")).toEqual({ chartType: "line", x: "shot", y: "note" });
    expect(config("passed")).toEqual({ field1Key: "shot" });
    expect(config("theirs")).toEqual({ field1Key: "take" });
  });
});
