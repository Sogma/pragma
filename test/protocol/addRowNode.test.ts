import { describe, expect, it } from "vitest";
import { ADD_ROW_NODE_TYPE, addRowColumns, cellText, cellTexts } from "../../src/protocol/addRowNode.ts";
import { recordColumns } from "../../src/protocol/columnPins.ts";
import { nodePorts } from "../../src/protocol/flowNodes.ts";
import type { FlowNodeInstance, TableColumn } from "../../src/protocol/types.ts";

function addRowNode(config: Record<string, unknown>): FlowNodeInstance {
  return { id: "addRow-1", type: ADD_ROW_NODE_TYPE, position: { x: 0, y: 0 }, config };
}

const PATH_PIN = { id: "path", label: "path", type: "text", required: false, description: expect.any(String) };
const ROW_PIN = { id: "row", label: "row", type: "object", required: false, description: expect.any(String) };
const PATH_OUTPUT = { id: "path", label: "path", type: "text", description: expect.any(String) };

describe("an Add Row node's ports", () => {
  it("are the path pin and the row alone until a Table has been read, and pass the Table on", () => {
    expect(nodePorts(addRowNode({ tablePath: "log.table.html" }))).toEqual({
      inputs: [PATH_PIN, ROW_PIN],
      outputs: [PATH_OUTPUT],
    });
  });

  // A column's id is the wire identifier, as on Make Object.
  it("then give a pin per column of the Table dragged in, each optional, typed by what its cell holds", () => {
    const columns: TableColumn[] = [
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "keep", label: "Keep", type: "checkbox" },
    ];
    expect(nodePorts(addRowNode({ tablePath: "log.table.html", columns: recordColumns(columns) }))).toEqual({
      inputs: [
        PATH_PIN,
        ROW_PIN,
        { id: "prompt", label: "Prompt", type: "text", required: false },
        { id: "keep", label: "Keep", type: "boolean", required: false },
      ],
      outputs: [PATH_OUTPUT],
    });
  });

  // Its wires would be read as the node's own input's, so `row` fills it.
  it("leave a column named for the path pin or the row without a pin of its own", () => {
    const columns = recordColumns([
      { id: "path", label: "Path", type: "path" },
      { id: "row", label: "Row", type: "text" },
      { id: "note", label: "Note", type: "text" },
    ]);
    expect(addRowColumns({ columns }).map((column) => column.id)).toEqual(["note"]);
    expect(nodePorts(addRowNode({ columns })).inputs.map((port) => port.id)).toEqual(["path", "row", "note"]);
  });
});

describe("a value as cell text", () => {
  it("is a wired text as it is, a boolean as a checkbox writes it, and a number in figures", () => {
    expect(cellText({ type: "text", value: "a red door" })).toBe("a red door");
    expect(cellText({ type: "boolean", value: true })).toBe("true");
    expect(cellText({ type: "boolean", value: false })).toBe("false");
    expect(cellText({ type: "number", value: 1024 })).toBe("1024");
    expect(() => cellText({ type: "object", value: {} })).toThrow("A Table cell can't hold an object");
  });

  it("is each field of a row the same way", () => {
    expect(cellTexts({ prompt: "a red door", keep: true, done: false, width: 1024 })).toEqual({
      prompt: "a red door",
      keep: "true",
      done: "false",
      width: "1024",
    });
  });

  // A field holding nothing gives its column what a new row gets.
  it("leaves out a field holding nothing", () => {
    expect(cellTexts({ prompt: null, note: "" })).toEqual({ note: "" });
  });

  it("refuses what no cell can hold, and a row that isn't a record", () => {
    expect(() => cellTexts({ tags: ["a", "b"] })).toThrow('Field "tags" is a list, not a single value');
    expect(() => cellTexts({ size: { w: 1 } })).toThrow('Field "size" is a group of fields, not a single value');
    for (const row of [[], "text", null]) {
      expect(() => cellTexts(row), JSON.stringify(row)).toThrow("Its row input isn't a record of fields");
    }
  });
});
