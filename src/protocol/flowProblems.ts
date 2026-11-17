// What a Flow's editor can't show as its file says. Each stays in the file
// and is reported as one of its problems (docs/architecture.md, Feedback and
// interaction), worded for the person fixing it.
import { FLOW_NODE_REGISTRY, type FlowNodeTypeDefinition, intValue, nodePorts } from "./flowNodes.ts";
import { type FlowEdgeInstance, type FlowGraph, type FlowNodeInstance, flowPortTypesCompatible } from "./types.ts";

/** The ids wires name on `node` that it has no port for, as after a port is
 * renamed: inputs for "target", outputs for "source". */
export function missingPortIds(
  node: FlowNodeInstance,
  edges: readonly FlowEdgeInstance[],
  type: "target" | "source",
): string[] {
  const ports = type === "target" ? nodePorts(node).inputs : nodePorts(node).outputs;
  const ids = new Set<string>();
  for (const edge of edges) {
    const [nodeId, portId] = type === "target" ? [edge.target, edge.targetPort] : [edge.source, edge.sourcePort];
    if (nodeId === node.id && !ports.some((port) => port.id === portId)) ids.add(portId);
  }
  return [...ids];
}

export function nodeName(node: FlowNodeInstance, definition: FlowNodeTypeDefinition): string {
  return `${node.label || definition.label} "${node.id}"`;
}

// A node of an unknown type has no ports to check its wires against: the
// node is the problem, and its wires aren't drawn with it.
export function flowProblems(graph: FlowGraph): string[] {
  const problems: string[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    const definition = FLOW_NODE_REGISTRY[node.type];
    if (!definition) {
      problems.push(`"${node.id}" is a ${node.type} node, a type this version of Pragma doesn't have.`);
      continue;
    }
    const name = nodeName(node, definition);
    for (const id of missingPortIds(node, graph.edges, "target")) {
      problems.push(`${name}: a wire goes into "${id}", a pin it doesn't have.`);
    }
    for (const id of missingPortIds(node, graph.edges, "source")) {
      problems.push(`${name}: a wire comes out of "${id}", a pin it doesn't have.`);
    }
  }
  for (const edge of graph.edges) {
    for (const id of [edge.source, edge.target]) {
      if (!nodeIds.has(id)) problems.push(`A wire names "${id}", a node this Flow doesn't have.`);
    }
  }
  return [...new Set(problems)];
}

/** What a Flow written as text, rather than drawn, can get wrong besides what
 * its editor reports. An editor never draws these, and a run reads each as
 * something other than was meant: it drops a wire joining two types, and
 * reads an unknown key, or a checkbox holding anything but text, as unset.
 *
 * A whole-number field holding anything but one written as text reads as
 * unset too, or fails its node. */
export function flowAuthoringProblems(graph: FlowGraph): string[] {
  const problems = flowProblems(graph);
  const nodes = new Map<string, FlowNodeInstance>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) problems.push(`Two nodes are "${node.id}"; a node's id names one node.`);
    nodes.set(node.id, node);
  }

  const wired = new Set<string>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    const targetDefinition = target && FLOW_NODE_REGISTRY[target.type];
    if (!source || !target || !targetDefinition) continue;
    const from = nodePorts(source).outputs.find((port) => port.id === edge.sourcePort);
    const into = nodePorts(target).inputs.find((port) => port.id === edge.targetPort);
    if (from && into && !flowPortTypesCompatible(from.type, into.type)) {
      problems.push(
        `${nodeName(target, targetDefinition)}: a wire brings ${from.type} into "${into.id}", which takes ${into.type}; a wire joins pins of one type.`,
      );
    }
    const input = `${edge.target}\0${edge.targetPort}`;
    if (wired.has(input)) {
      problems.push(
        `${nodeName(target, targetDefinition)}: two wires go into "${edge.targetPort}"; an input takes one.`,
      );
    }
    wired.add(input);
  }

  for (const node of graph.nodes) {
    const definition = FLOW_NODE_REGISTRY[node.type];
    if (!definition) continue;
    const name = nodeName(node, definition);
    const widgets = definition.inputWidgets ?? [];
    for (const key of Object.keys(node.config)) {
      if (!definition.configKeys.includes(key) && !widgets.some((widget) => widget.portId === key)) {
        problems.push(`${name}: its config has "${key}", which a ${definition.label} node doesn't.`);
      }
    }
    const checkboxes = [
      ...widgets.filter((widget) => widget.type === "checkbox").map((widget) => widget.portId),
      ...definition.configFields.filter((field) => field.type === "checkbox").map((field) => field.key),
    ];
    for (const key of checkboxes) {
      const value = node.config[key];
      if (value !== undefined && value !== "true" && value !== "false") {
        problems.push(`${name}: "${key}" holds ${JSON.stringify(value)}; a checkbox holds the text "true" or "false".`);
      }
    }
    for (const field of definition.configFields) {
      const value = node.config[field.key];
      if (field.type !== "integer" || value === undefined) continue;
      if (typeof value !== "string" || intValue(value) === undefined) {
        problems.push(
          `${name}: "${field.key}" holds ${JSON.stringify(value)}; it holds a whole number written as text, such as "42".`,
        );
      }
    }
  }
  return [...new Set(problems)];
}
