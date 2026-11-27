// A Flow's Make Object node: its pins, a Table's columns (columnPins.ts),
// and the object they make.
import { columnInputs, columnPinsConfig } from "./columnPins.ts";
import type { FlowPort } from "./types.ts";

export const MAKE_OBJECT_NODE_TYPE = "makeObject";

/** A pin per column, each optional: a field given nothing is left out of the
 * object. The one output can share a name with a column, since outputs and
 * inputs never share a namespace. */
export function makeObjectPorts(config: Record<string, unknown>): { inputs: FlowPort[]; outputs: FlowPort[] } {
  return {
    inputs: columnInputs(columnPinsConfig(config).columns),
    outputs: [{ id: "object", type: "object", label: "object", description: "The fields, keyed by column id." }],
  };
}
