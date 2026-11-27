// For Each zones (docs/protocol.md, For Each zones): the nodes a For Each
// runs once per item, found from the wires alone, so a Flow file stores no
// membership that could disagree with them.
import type { FlowGraph } from "./types.ts";

export const FOR_EACH_TYPE = "forEach";
export const FOR_EACH_END_TYPE = "forEachEnd";

/** The For Each End's config key naming its For Each by node id. */
export const FOR_EACH_PAIR_KEY = "forEach";

export interface FlowZone {
  // The For Each's node id.
  forEach: string;
  // Its End's node id, absent while the graph has none.
  end?: string;
  // Every node the For Each feeds, however far, short of its End.
  members: Set<string>;
}

function endsByForEach(graph: FlowGraph): Map<string, string> {
  const ends = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type !== FOR_EACH_END_TYPE) continue;
    const pair = node.config[FOR_EACH_PAIR_KEY];
    if (typeof pair === "string" && !ends.has(pair)) ends.set(pair, node.id);
  }
  return ends;
}

/** Each For Each's zone, by its node id. */
export function flowZones(graph: FlowGraph): Map<string, FlowZone> {
  const ends = endsByForEach(graph);
  const zones = new Map<string, FlowZone>();
  for (const node of graph.nodes) {
    if (node.type !== FOR_EACH_TYPE) continue;
    const end = ends.get(node.id);
    const members = new Set<string>();
    const pending = [node.id];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      for (const edge of graph.edges) {
        if (edge.source !== id || edge.target === end || edge.target === node.id || members.has(edge.target)) continue;
        members.add(edge.target);
        pending.push(edge.target);
      }
    }
    zones.set(node.id, { forEach: node.id, ...(end ? { end } : {}), members });
  }
  return zones;
}

/** What stops a zone or an End from running, by the node that fails: a For
 * Each whose zone holds another, shares a node with another or wires its End
 * back into itself, and an End naming no For Each or one another End took.
 * An editor refuses each of these; a graph on disk may still hold one. */
export function zoneProblems(graph: FlowGraph, zones: ReadonlyMap<string, FlowZone>): Map<string, string> {
  const problems = new Map<string, string>();
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const owner = new Map<string, string>();
  for (const zone of zones.values()) {
    for (const id of zone.members) {
      const type = nodesById.get(id)?.type;
      if (type === FOR_EACH_TYPE || type === FOR_EACH_END_TYPE) {
        problems.set(zone.forEach, `Its zone holds "${id}", and one For Each can't run inside another.`);
      }
      const other = owner.get(id);
      if (other !== undefined) {
        const shared = `"${id}" takes values from two For Each zones. Give each zone its own nodes.`;
        problems.set(zone.forEach, shared);
        problems.set(other, shared);
      } else owner.set(id, zone.forEach);
      if (zone.end && graph.edges.some((edge) => edge.target === id && feeds(graph, zone.end as string, edge.source))) {
        problems.set(zone.forEach, `"${id}" runs once per item but takes a wire from after For Each End.`);
      }
    }
  }
  const ends = endsByForEach(graph);
  for (const node of graph.nodes) {
    if (node.type !== FOR_EACH_END_TYPE) continue;
    const pair = node.config[FOR_EACH_PAIR_KEY];
    if (typeof pair !== "string" || nodesById.get(pair)?.type !== FOR_EACH_TYPE) {
      problems.set(node.id, "Its For Each is gone. Add For Each again, which brings its own End.");
    } else if (ends.get(pair) !== node.id) {
      problems.set(node.id, `"${pair}" already has a For Each End.`);
    }
  }
  return problems;
}

// Whether `from` feeds `to`, however far, or is it.
function feeds(graph: FlowGraph, from: string, to: string): boolean {
  const reached = new Set([from]);
  const pending = [from];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === to) return true;
    for (const edge of graph.edges) {
      if (edge.source !== id || reached.has(edge.target)) continue;
      reached.add(edge.target);
      pending.push(edge.target);
    }
  }
  return false;
}
