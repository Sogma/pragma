// What's wrong with the open Flow, reported to its pane (docs/architecture.md,
// Feedback and interaction): what its graph can't show as written (flowProblems.ts),
// and each file a node names that its card found gone, which the run would
// fail on. The canvas feeds both: its saves after every change, its cards as
// they check their files.
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import { flowProblems, nodeName } from "../../src/protocol/flowProblems.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";

export interface FlowProblemReport {
  // A Flow opened or reloaded. Its cards are built afresh and check again, so
  // a missing file found before is forgotten until one says so.
  opened(path: string, graph: FlowGraph): void;
  // The live graph after every change, locked or not.
  onGraphChange(path: string, graph: FlowGraph): void;
  // A node's file its card found gone, in the run's words, or found again.
  fileMissing(nodeId: string, message: string | undefined): void;
}

export function createFlowProblemReport(
  report: (path: string, problems: readonly string[]) => void,
): FlowProblemReport {
  let path: string | undefined;
  let graph: FlowGraph = { nodes: [], edges: [] };
  const missing = new Map<string, string>();

  // Each missing file under its node's name, as a wire's problem is, in the
  // graph's node order so the list holds still while the checks come in.
  function send(): void {
    if (path === undefined) return;
    const problems = flowProblems(graph);
    for (const node of graph.nodes) {
      const message = missing.get(node.id);
      const definition = FLOW_NODE_REGISTRY[node.type];
      if (message !== undefined && definition) problems.push(`${nodeName(node, definition)}: ${message}`);
    }
    report(path, problems);
  }

  return {
    opened(next, nextGraph) {
      path = next;
      graph = nextGraph;
      missing.clear();
      send();
    },
    onGraphChange(next, nextGraph) {
      path = next;
      graph = nextGraph;
      // A removed node's file goes with it: a node made later under its id
      // has a card of its own to check.
      const ids = new Set(graph.nodes.map((node) => node.id));
      for (const id of missing.keys()) if (!ids.has(id)) missing.delete(id);
      send();
    },
    fileMissing(nodeId, message) {
      if (message === undefined) missing.delete(nodeId);
      else missing.set(nodeId, message);
      send();
    },
  };
}
