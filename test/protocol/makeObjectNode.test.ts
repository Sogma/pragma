import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { columnPinsConfig, recordColumns } from "../../src/protocol/columnPins.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { nodePorts } from "../../src/protocol/flowNodes.ts";
import { MAKE_OBJECT_NODE_TYPE } from "../../src/protocol/makeObjectNode.ts";
import { parseTableFile } from "../../src/protocol/tableFile.ts";
import type { FlowNodeInstance, TableColumn } from "../../src/protocol/types.ts";

const COLUMNS: TableColumn[] = [
  { id: "prompt", label: "Prompt", type: "text" },
  { id: "image", label: "Image", type: "media", mediaFolder: "renders" },
  { id: "keep", label: "Keep", type: "checkbox" },
  { id: "width", label: "Width", type: "integer" },
  { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
  { id: "added", label: "Added", type: "timestamp", default: "now" },
];

function makeObjectNode(config: Record<string, unknown>): FlowNodeInstance {
  return { id: "makeObject-1", type: MAKE_OBJECT_NODE_TYPE, position: { x: 0, y: 0 }, config };
}

const OBJECT_OUTPUT = { id: "object", label: "object", type: "object", description: expect.any(String) };

// A column's id is the wire identifier: what a saved edge names, so a renamed
// column keeps its wires and only its pin's label changes.
describe("a Make Object node's ports", () => {
  it("are the Table's columns, each optional, typed by what its cell holds, and one object out", () => {
    expect(nodePorts(makeObjectNode({ columns: recordColumns(COLUMNS) }))).toEqual({
      inputs: [
        { id: "prompt", label: "Prompt", type: "text", required: false },
        { id: "image", label: "Image", type: "text", required: false },
        { id: "keep", label: "Keep", type: "boolean", required: false },
        { id: "width", label: "Width", type: "number", required: false },
        { id: "status", label: "Status", type: "text", required: false },
        { id: "added", label: "Added", type: "text", required: false },
      ],
      outputs: [OBJECT_OUTPUT],
    });
  });

  it("are the object alone until a Table has been read", () => {
    expect(nodePorts(makeObjectNode({ tablePath: "log.table.html" }))).toEqual({
      inputs: [],
      outputs: [OBJECT_OUTPUT],
    });
  });

  // An output never shares a name with an input.
  it("keep a column named object beside the object output", () => {
    const columns = recordColumns([{ id: "object", label: "Object", type: "text" }]);
    expect(nodePorts(makeObjectNode({ columns })).inputs.map((port) => port.id)).toEqual(["object"]);
  });
});

describe("the template's Make Object", () => {
  // An editor that reads the Table rewrites columns that differ, taking the
  // wires of any column gone, so a shipped node out of step changes the
  // Flow the first time someone opens it.
  it("keeps the template query sheet's columns in the template's Query row node", async () => {
    const project = path.resolve(import.meta.dirname, "../../templates/space/projects/translation");
    const table = parseTableFile(await readFile(path.join(project, "queries.table.html"), "utf8"));
    const flow = parseFlowFile(await readFile(path.join(project, "tools/review.flow.html"), "utf8"));
    const node = flow?.graph.nodes.find((each) => each.type === MAKE_OBJECT_NODE_TYPE);

    expect(node?.config.tablePath).toBe("../queries.table.html");
    expect(node && columnPinsConfig(node.config).columns).toEqual(recordColumns(table?.columns ?? []));
  });
});
