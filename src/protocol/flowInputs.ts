// A Flow's run parameters: the exposed fields that hold a value of their own
// (docs/protocol.md, Flows → Execution). The same declaration App mode renders
// its form from, so a caller outside the canvas gets the signature a person
// sees there rather than a second notion of what a flow takes.
import {
  FLOW_NODE_REGISTRY,
  type FlowNodeConfigFieldType,
  isFieldOutput,
  nodePorts,
  nodesLeftOut,
} from "./flowNodes.ts";
import type { FlowGraph, FlowNodeInstance } from "./types.ts";

export type FlowRunInputType = "text" | "boolean" | "integer" | "path" | "model";

export interface FlowRunInput {
  /** `<nodeId>.<field>` — unique in the graph, and stable across renames. */
  name: string;
  nodeId: string;
  field: string;
  label: string;
  type: FlowRunInputType;
}

export interface FlowRunOutput {
  name: string;
  nodeId: string;
  port: string;
  label: string;
}

// A config field's input type; every field not listed takes text.
const FIELD_INPUT_TYPES: Partial<Record<FlowNodeConfigFieldType, FlowRunInputType>> = {
  checkbox: "boolean",
  integer: "integer",
};

// The pickers Expose covers that the registry does not declare as fields.
const PICKERS: Record<string, Record<string, string>> = {
  loadImage: { imagePath: "Image" },
  loadRow: { selectedValue: "Selected row" },
  loadFolderNote: { notePath: "Selected note" },
  loadFolderImage: { imagePath: "Selected image" },
  loadVideo: { videoPath: "Video" },
  generateImage: { outputFolderPath: "Results folder" },
  generateVideo: { outputFolderPath: "Results folder" },
};

/** A value supplied for a run that the flow does not take, or of the wrong
 * type — refused before any node runs. */
export class FlowInputError extends Error {}

export function nodeLabel(node: FlowNodeInstance): string {
  return node.label?.trim() || FLOW_NODE_REGISTRY[node.type]?.label || node.type;
}

function inputFor(node: FlowNodeInstance, id: string): FlowRunInput | undefined {
  const definition = FLOW_NODE_REGISTRY[node.type];
  if (!definition) return undefined;
  const entry = (label: string, type: FlowRunInputType): FlowRunInput => ({
    name: `${node.id}.${id}`,
    nodeId: node.id,
    field: id,
    label: `${nodeLabel(node)} · ${label}`,
    type,
  });

  const widget = definition.inputWidgets?.find((candidate) => candidate.portId === id);
  const port = definition.inputs.find((candidate) => candidate.id === id);
  if (widget && port) {
    const type =
      widget.type === "checkbox" ? "boolean" : widget.type === "text" || widget.type === "select" ? "text" : "model";
    return entry(port.label, type);
  }
  // A field output's value is config[id], so the input sets that key.
  const fieldOutput = isFieldOutput(node, id) ? definition.outputs.find((candidate) => candidate.id === id) : undefined;
  if (fieldOutput) return entry(fieldOutput.label, "text");
  const field = definition.configFields.find((candidate) => candidate.key === id);
  if (field) return entry(field.label, FIELD_INPUT_TYPES[field.type] ?? "text");
  const picker = PICKERS[node.type]?.[id];
  if (picker) return entry(picker, node.type === "loadRow" ? "text" : "path");
  return undefined;
}

// App mode's order: appModeOrder ascending, graph order otherwise. A node a
// run leaves out takes no input and gives no result.
function exposedNodes(graph: FlowGraph): FlowNodeInstance[] {
  const leftOut = nodesLeftOut(graph);
  return graph.nodes
    .filter((node) => (node.exposed ?? []).length > 0 && !leftOut.has(node.id))
    .sort((a, b) => (a.appModeOrder ?? Number.MAX_SAFE_INTEGER) - (b.appModeOrder ?? Number.MAX_SAFE_INTEGER));
}

export function flowRunInputs(graph: FlowGraph): FlowRunInput[] {
  return exposedNodes(graph).flatMap((node) => (node.exposed ?? []).flatMap((id) => inputFor(node, id) ?? []));
}

export function flowRunOutputs(graph: FlowGraph): FlowRunOutput[] {
  return exposedNodes(graph).flatMap((node) => {
    const outputs = nodePorts(node).outputs;
    return (node.exposed ?? []).flatMap((id) => {
      const port = isFieldOutput(node, id) ? undefined : outputs.find((candidate) => candidate.id === id);
      return port
        ? [{ name: `${node.id}.${id}`, nodeId: node.id, port: id, label: `${nodeLabel(node)} · ${port.label}` }]
        : [];
    });
  });
}

/** The graph with `values` applied over its exposed fields, for one run.
 * The graph passed in is left untouched, so nothing a caller supplies is ever
 * written back to the file. Every name must be an exposed run input; a
 * boolean input takes a boolean, an integer one a whole number, and every
 * other a string. */
export function applyRunInputs(graph: FlowGraph, values: Record<string, unknown>): FlowGraph {
  const inputs = new Map(flowRunInputs(graph).map((input) => [input.name, input]));
  const overrides = new Map<string, Record<string, string>>();
  for (const [name, value] of Object.entries(values)) {
    const input = inputs.get(name);
    if (!input) {
      const known = [...inputs.keys()];
      throw new FlowInputError(
        `This flow takes no input "${name}". ${known.length ? `It takes: ${known.join(", ")}.` : "It exposes no inputs."}`,
      );
    }
    let stored: string;
    if (input.type === "boolean") {
      if (typeof value !== "boolean") throw new FlowInputError(`Input "${name}" takes true or false.`);
      stored = String(value);
    } else if (input.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new FlowInputError(`Input "${name}" takes a whole number.`);
      }
      stored = String(value);
    } else {
      if (typeof value !== "string") throw new FlowInputError(`Input "${name}" takes a string.`);
      stored = value;
    }
    overrides.set(input.nodeId, { ...overrides.get(input.nodeId), [input.field]: stored });
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const override = overrides.get(node.id);
      return override ? { ...node, config: { ...node.config, ...override } } : node;
    }),
  };
}
