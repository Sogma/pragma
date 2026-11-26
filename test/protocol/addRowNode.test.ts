import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADD_ROW_NODE_TYPE, addRowColumns, addRowNodeConfig, cellText } from "../../src/protocol/addRowNode.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { nodePorts } from "../../src/protocol/flowNodes.ts";
import { parseTableFile } from "../../src/protocol/tableFile.ts";
import { type FlowNodeInstance, fieldPortType, type TableColumn } from "../../src/protocol/types.ts";

const COLUMNS: TableColumn[] = [
  { id: "prompt", label: "Prompt", type: "text" },
  { id: "image", label: "Image", type: "media", mediaFolder: "renders" },
  { id: "keep", label: "Keep", type: "checkbox" },
  { id: "width", label: "Width", type: "integer" },
  { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
  { id: "added", label: "Added", type: "timestamp", default: "now" },
];

function addRowNode(config: Record<string, unknown>): FlowNodeInstance {
  return { id: "addRow-1", type: "addRow", position: { x: 0, y: 0 }, config };
}

// A column's id is the wire identifier: what a saved edge names, so a renamed
// column keeps its wires and only its pin's label changes.
describe("an Add Row node's ports", () => {
  it("are the path pin, then the Table's columns, each optional, typed by what its cell holds", () => {
    expect(nodePorts(addRowNode({ columns: addRowColumns(COLUMNS) }))).toEqual({
      inputs: [
        { id: "table_path", label: "table_path", type: "text", required: false, description: expect.any(String) },
        { id: "prompt", label: "Prompt", type: "text", required: false },
        { id: "image", label: "Image", type: "text", required: false },
        { id: "keep", label: "Keep", type: "boolean", required: false },
        { id: "width", label: "Width", type: "number", required: false },
        { id: "status", label: "Status", type: "text", required: false },
        { id: "added", label: "Added", type: "text", required: false },
      ],
      outputs: [{ id: "path", label: "path", type: "text", description: expect.any(String) }],
    });
  });

  it("are the path pin alone until a Table has been read, and still pass the Table on", () => {
    expect(nodePorts(addRowNode({ tablePath: "log.table.html" }))).toEqual({
      inputs: [
        { id: "table_path", label: "table_path", type: "text", required: false, description: expect.any(String) },
      ],
      outputs: [{ id: "path", label: "path", type: "text", description: expect.any(String) }],
    });
  });

  // An output never shares a name with an input, so the `path` output takes
  // nothing from a column of that name, as the `table_path` input would.
  it("keep a column named path beside the path output", () => {
    const columns = addRowColumns([{ id: "path", label: "Path", type: "text" }]);
    expect(nodePorts(addRowNode({ columns })).inputs.map((port) => port.id)).toEqual(["table_path", "path"]);
  });

  it("leave a column named for the path pin without a pin of its own", () => {
    const columns = addRowColumns([
      { id: "table_path", label: "Where", type: "text" },
      { id: "note", label: "Note", type: "text" },
    ]);
    expect(columns.map((column) => column.id)).toEqual(["note"]);
  });

  it("maps a column type to its port type", () => {
    expect(fieldPortType("checkbox")).toBe("boolean");
    expect(fieldPortType("integer")).toBe("number");
    expect(fieldPortType("score")).toBe("number");
    for (const type of ["text", "select", "color", "media", "timestamp"] as const)
      expect(fieldPortType(type)).toBe("text");
  });
});

describe("what an Add Row node keeps of a Table's columns", () => {
  it("keeps what types a port and draws its control, and no more", () => {
    expect(addRowColumns(COLUMNS)).toEqual([
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "image", label: "Image", type: "media" },
      { id: "keep", label: "Keep", type: "checkbox" },
      { id: "width", label: "Width", type: "integer" },
      { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
      { id: "added", label: "Added", type: "timestamp", default: "now" },
    ]);
  });

  // Two pins can't share one wire identifier, and a column with no id has
  // none to give.
  it("drops a column without an id and a repeated id, and labels an unlabelled one by its id", () => {
    expect(
      addRowColumns([
        { id: "", label: "Nameless", type: "text" },
        { id: "a", label: "", type: "text" },
        { id: "a", label: "Again", type: "checkbox" },
      ]),
    ).toEqual([{ id: "a", label: "a", type: "text" }]);
  });

  it("re-checks what a saved graph holds, as from a hand edit", () => {
    const config = addRowNodeConfig({
      tablePath: 7,
      columns: [{ id: "a", label: "A", type: "bogus" }, "junk", { label: "No id" }],
      values: { a: "kept", b: 3 },
    });
    expect(config).toEqual({ tablePath: "", columns: [{ id: "a", label: "A", type: "text" }], values: { a: "kept" } });
  });

  it("keeps a score's scale and reject mark, which draw its control", () => {
    const scores: TableColumn[] = [
      { id: "rating", label: "Rating", type: "score", max: 10, reject: true },
      { id: "wild", label: "Wild", type: "score", max: 40 },
      { id: "n", label: "N", type: "integer", max: 10, reject: true },
    ];
    expect(addRowColumns(scores)).toEqual([
      { id: "rating", label: "Rating", type: "score", max: 10, reject: true },
      { id: "wild", label: "Wild", type: "score" },
      { id: "n", label: "N", type: "integer" },
    ]);
    expect(addRowNodeConfig({ columns: addRowColumns(scores) }).columns[0]).toEqual(scores[0]);
  });

  // An editor that reads the Table rewrites columns that differ, taking the
  // wires of any column gone, so a shipped node out of step changes the
  // Flow the first time someone opens it.
  it("keeps the template query sheet's columns in the template's Query client node", async () => {
    const project = path.resolve(import.meta.dirname, "../../templates/space/projects/translation");
    const table = parseTableFile(await readFile(path.join(project, "queries.table.html"), "utf8"));
    const flow = parseFlowFile(await readFile(path.join(project, "tools/review.flow.html"), "utf8"));
    const node = flow?.graph.nodes.find((each) => each.type === ADD_ROW_NODE_TYPE);

    expect(node?.config.tablePath).toBe("../queries.table.html");
    expect(node && addRowNodeConfig(node.config).columns).toEqual(addRowColumns(table?.columns ?? []));
  });
});

describe("a wired value as cell text", () => {
  it("is text as it is, a boolean as a checkbox writes it, and a number in figures", () => {
    expect(cellText({ type: "text", value: "a red door" })).toBe("a red door");
    expect(cellText({ type: "boolean", value: true })).toBe("true");
    expect(cellText({ type: "boolean", value: false })).toBe("false");
    expect(cellText({ type: "number", value: 1024 })).toBe("1024");
  });

  it("refuses what no cell can hold", () => {
    expect(() => cellText({ type: "object", value: {} })).toThrow("can't hold an object");
  });
});
