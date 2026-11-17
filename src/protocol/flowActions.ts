// A Flow as a toolkit (docs/protocol.md, Flows → Actions): its buttons are
// its Button nodes, and a click runs the Button before anything else, then
// what its wires reach and what those need.
import type { NodeExecutionContext } from "./flowExecutors.ts";
import { nodeLabel } from "./flowInputs.ts";
import { FLOW_NODE_REGISTRY, nodesLeftOut } from "./flowNodes.ts";
import { type RunResult, runFlow } from "./flowRuntime.ts";
import type { FlowGraph, FlowNodeInstance } from "./types.ts";

/** `nodeType` and `color` are display hints of pragma's own, for the
 * button's glyph and fill; docs/protocol.md leaves drawing to each host, so
 * they stay out of the spec. `nodeType` names the type whose glyph says what
 * the click does. */
export interface FlowAction {
  nodeId: string;
  label: string;
  /** The node's comment, absent when it has none. */
  comment?: string;
  nodeType: string;
  /** The node's color as the canvas shows it: its own, else its type's
   * default. */
  color?: string;
}

// Whether a node changes or makes a file: a write through its path, or a
// generation saved into a folder.
function writes(node: FlowNodeInstance): boolean {
  const definition = FLOW_NODE_REGISTRY[node.type];
  if (definition?.pathInput?.access === "write") return true;
  const capability = definition?.capabilityFor?.(node.config);
  return (
    capability?.type === "writeDocument" || capability?.type === "generateImage" || capability?.type === "generateVideo"
  );
}

// The glyph says what a click does, by the most telling node it runs: an
// edit proposed in the document, then work elsewhere, then a file opened
// beside it, then an answer. A receipt shown after a write keeps the
// Button's own glyph, as the work is the point.
function glyphOf(part: FlowGraph): string {
  const runs = (type: string) => part.nodes.some((node) => node.type === type);
  if (runs("replaceSelection")) return "replaceSelection";
  if (part.nodes.some(writes)) return "button";
  if (runs("openToSide")) return "openToSide";
  if (runs("showResult")) return "showResult";
  return "button";
}

/** One button per Button node, top to bottom as the nodes sit on the canvas,
 * then left to right. A label the canvas repeats gets a number from its
 * second use on, so no two buttons read the same. A node a run leaves out
 * gives none: its click could run nothing. */
export function flowActions(graph: FlowGraph): FlowAction[] {
  const seen = new Map<string, number>();
  const leftOut = nodesLeftOut(graph);
  return graph.nodes
    .filter((node) => FLOW_NODE_REGISTRY[node.type]?.action && !leftOut.has(node.id))
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((node) => {
      const label = nodeLabel(node);
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      const color = node.color ?? FLOW_NODE_REGISTRY[node.type]?.defaultColor;
      return {
        nodeId: node.id,
        label: count === 1 ? label : `${label} (${count})`,
        ...(node.comment ? { comment: node.comment } : {}),
        nodeType: glyphOf(actionGraph(graph, node.id)),
        ...(color ? { color } : {}),
      };
    });
}

// The nodes `from` holds and everything their inputs reach, transitively.
function withUpstream(graph: FlowGraph, from: Iterable<string>): FlowGraph {
  const keep = new Set<string>();
  const pending = [...from];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (keep.has(id)) continue;
    keep.add(id);
    for (const edge of graph.edges) if (edge.target === id) pending.push(edge.source);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.target)),
  };
}

/** The part of `graph` one button's click runs: the Button, every node a
 * wire reaches from it, and whatever those nodes need, transitively. Nothing
 * outside it runs, so a click pays only for its own work. */
export function actionGraph(graph: FlowGraph, buttonId: string): FlowGraph {
  const ahead = new Set<string>();
  const pending = [buttonId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (ahead.has(id)) continue;
    ahead.add(id);
    for (const edge of graph.edges) if (edge.source === id) pending.push(edge.target);
  }
  return withUpstream(graph, ahead);
}

/** The part of `graph` one node needs: the node and everything its inputs
 * reach, and nothing after it, so running it alone redoes no later work. */
export function upstreamGraph(graph: FlowGraph, nodeId: string): FlowGraph {
  return withUpstream(graph, [nodeId]);
}

/** Runs a click's part, the Button before any other node: a Button that
 * fails, as with nothing selected, starts nothing else and asks for
 * nothing. */
export function runAction(part: FlowGraph, buttonId: string, context: NodeExecutionContext): Promise<RunResult> {
  return runFlow(part, context, undefined, undefined, undefined, buttonId);
}
