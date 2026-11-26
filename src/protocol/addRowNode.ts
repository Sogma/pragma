// A Flow's Add Row node: what its config holds, the ports a Table's columns
// give it, and the cell text a wired value becomes.
import type { PortValue } from "./flowExecutors.ts";
import { type FlowPort, fieldPortType, isScoreMax, parseFieldValueType, type TableColumn } from "./types.ts";

export const ADD_ROW_NODE_TYPE = "addRow";

/** The input a wired path arrives on. A Table column with this id has no pin
 * of its own, since its wires would be read as the path. */
export const ADD_ROW_PATH_PORT = "table_path";

/** An Add Row node's config. `columns` are the Table's as the editor last
 * read them, kept so a run and the canvas type edges without reading it.
 * `values` are what the card's own controls hold, by column id: apart from
 * the node's own keys, since a column's id is whatever the Table says. */
export interface AddRowNodeConfig {
  tablePath: string;
  columns: TableColumn[];
  values: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the node keeps of a Table's columns: enough to type a port and draw
 * its control. A column without an id has no port to give, and a repeated
 * id would give two pins one wire identifier, so both are dropped, as is
 * one named for the path pin. */
export function addRowColumns(columns: readonly TableColumn[]): TableColumn[] {
  const seen = new Set<string>([ADD_ROW_PATH_PORT]);
  const kept: TableColumn[] = [];
  for (const { id, type, label, options, default: fill, max, reject } of columns) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    kept.push({
      id,
      type,
      label: label || id,
      ...(type === "select" && options?.length ? { options } : {}),
      ...(type === "timestamp" && fill ? { default: fill } : {}),
      ...(type === "score" && max !== undefined && isScoreMax(max) ? { max } : {}),
      ...(type === "score" && reject ? { reject } : {}),
    });
  }
  return kept;
}

// The saved columns, re-checked: a hand-edited graph is trusted here no more
// than anywhere else.
function readSavedColumns(value: unknown): TableColumn[] {
  if (!Array.isArray(value)) return [];
  return addRowColumns(
    value.filter(isRecord).map((raw) => ({
      id: typeof raw.id === "string" ? raw.id : "",
      type: parseFieldValueType(typeof raw.type === "string" ? raw.type : undefined),
      label: typeof raw.label === "string" ? raw.label : "",
      ...(Array.isArray(raw.options)
        ? { options: raw.options.filter((option): option is string => typeof option === "string") }
        : {}),
      ...(raw.default === "now" ? { default: "now" as const } : {}),
      ...(typeof raw.max === "number" ? { max: raw.max } : {}),
      ...(raw.reject === true ? { reject: true as const } : {}),
    })),
  );
}

export function addRowNodeConfig(config: Record<string, unknown>): AddRowNodeConfig {
  const values: Record<string, string> = {};
  if (isRecord(config.values)) {
    for (const [id, value] of Object.entries(config.values)) if (typeof value === "string") values[id] = value;
  }
  return {
    tablePath: typeof config.tablePath === "string" ? config.tablePath : "",
    columns: readSavedColumns(config.columns),
    values,
  };
}

/** The path pin, then an input per column, each optional: a column given
 * nothing takes what a new row gets. The one output is the Table written to,
 * named `path` because outputs never share a name with a column. */
export function addRowPorts(config: Record<string, unknown>): { inputs: FlowPort[]; outputs: FlowPort[] } {
  return {
    inputs: [
      {
        id: ADD_ROW_PATH_PORT,
        type: "text",
        label: ADD_ROW_PATH_PORT,
        required: false,
        description: "Another Table with the same column ids.",
      },
      ...addRowNodeConfig(config).columns.map((column) => ({
        id: column.id,
        type: fieldPortType(column.type),
        label: column.label,
        required: false,
      })),
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
      throw new Error(`A Table cell can't hold ${value.type === "image" ? "an image" : "an object"}`);
  }
}
