// A Flow's Add Row node: its pins, the cell text each value becomes, and
// which of its values a column takes.
import { columnInputs, columnPinsConfig } from "./columnPins.ts";
import type { PortValue } from "./flowExecutors.ts";
import type { FlowPort, TableColumn } from "./types.ts";

export const ADD_ROW_NODE_TYPE = "addRow";

/** The input a wired path arrives on, as on every node that takes one. */
export const ADD_ROW_PATH_INPUT = "path";

/** The input the row arrives on, an object keyed by column id. */
export const ADD_ROW_INPUT = "row";

/** The Table's columns the node gives pins, as its config keeps them. A
 * column named for one of the node's own inputs has no pin, since its wires
 * would be read as that input's; `row` can still fill it. */
export function addRowColumns(config: Record<string, unknown>): TableColumn[] {
  return columnPinsConfig(config).columns.filter(({ id }) => id !== ADD_ROW_PATH_INPUT && id !== ADD_ROW_INPUT);
}

/** The path pin and the row, then a pin per column of the Table dragged in,
 * each optional. The one output is the Table written to, `path` as for
 * every writer, since outputs never share a name with an input. */
export function addRowPorts(config: Record<string, unknown>): { inputs: FlowPort[]; outputs: FlowPort[] } {
  return {
    inputs: [
      {
        id: ADD_ROW_PATH_INPUT,
        type: "text",
        label: ADD_ROW_PATH_INPUT,
        required: false,
        description: "The Table's path in the space.",
      },
      {
        id: ADD_ROW_INPUT,
        type: "object",
        label: ADD_ROW_INPUT,
        required: false,
        description: "The row's values, keyed by column id, such as Make Object's.",
      },
      ...columnInputs(addRowColumns(config)),
    ],
    outputs: [{ id: "path", type: "text", label: "path", description: "A node wired from it runs after the write." }],
  };
}

/** A wired value as the text a Table cell stores, a checkbox's as
 * "true"/"false". */
export function cellText(value: PortValue): string {
  switch (value.type) {
    case "text":
      return value.value;
    case "boolean":
      return value.value ? "true" : "false";
    case "number":
      return String(value.value);
    default:
      throw new Error(`A Table cell can't hold ${value.type === "video" ? "a" : "an"} ${value.type}`);
  }
}

/** An object's fields as the text Table cells store, by column id: text as
 * it is, a number in figures, a boolean as a checkbox writes it. A field
 * holding nothing is left out, so its column takes what a new row gets. A
 * list or a group of fields fails rather than being written out as JSON. */
export function cellTexts(record: unknown): Record<string, string> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("Its row input isn't a record of fields");
  }
  const cells: Record<string, string> = {};
  for (const [id, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) throw new Error(`Field "${id}" is a list, not a single value`);
    if (typeof value === "object") throw new Error(`Field "${id}" is a group of fields, not a single value`);
    cells[id] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  return cells;
}
