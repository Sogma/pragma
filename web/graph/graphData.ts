// What the Graph tab draws: the open entry's own graph out of the server's
// graph of the space, narrowed by the Show switches, with every scope's AGENTS.md
// shown brought in beside its folder.
import type { GraphEdgeKind, GraphNodeKind, GraphScope, SpaceGraphResponse } from "../../src/protocol/api.ts";

export const EDGE_GROUPS: { key: string; label: string; kinds: readonly GraphEdgeKind[] }[] = [
  { key: "link", label: "Links", kinds: ["link"] },
  { key: "embed", label: "Embeds", kinds: ["embed"] },
  { key: "member", label: "Class members", kinds: ["member"] },
  { key: "classLink", label: "Class links", kinds: ["classLink"] },
  { key: "tablePath", label: "Table paths", kinds: ["tablePath"] },
  { key: "flow", label: "Flow paths", kinds: ["flowRead", "flowWrite", "flowApplet"] },
  { key: "appletImport", label: "Applet imports", kinds: ["appletImport"] },
  { key: "tag", label: "Tags", kinds: ["tag"] },
  { key: "contains", label: "Folders", kinds: ["contains"] },
];

const GROUP_OF = new Map<GraphEdgeKind, string>(
  EDGE_GROUPS.flatMap((group) => group.kinds.map((kind) => [kind, group.key] as const)),
);

export interface ShowOptions {
  // EDGE_GROUPS keys.
  edges: readonly string[];
  missing: boolean;
  presets: boolean;
  libraries: boolean;
}

export interface ShownNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  scope: GraphScope | null;
  // 1 for a scope's AGENTS.md, 2 for the folder it opens the scope over.
  mark: 0 | 1 | 2;
  library: boolean;
  color?: string;
}

export interface ShownGraph {
  nodes: ShownNode[];
  links: { source: number; target: number; kind: GraphEdgeKind }[];
}

// The entry `focus` names, everything one link from it and the links among
// them, the entry itself whatever the switches say. A folder's links are what
// it holds, Folders on or off. The AGENTS.md opening the entry's scope comes too,
// so the scope shows when the entry doesn't link to it. Empty when the entry
// isn't in the graph.
export function localGraph(graph: SpaceGraphResponse, options: ShowOptions, focus: string): ShownGraph {
  const centre = graph.nodes.findIndex((node) => node.id === focus);
  if (centre === -1) return { nodes: [], links: [] };
  const scopes = new Map(graph.scopes.map((scope) => [scope.id, scope]));
  const groups = new Set(options.edges);
  const allowed = graph.nodes.map(
    (node, at) =>
      at === centre ||
      ((options.missing || node.kind !== "missing") &&
        (options.presets || !node.preset) &&
        (options.libraries || !node.library)),
  );
  const folder = graph.nodes[centre].kind === "folder";
  const kept = graph.edges.filter((edge) => {
    if (!allowed[edge.from] || !allowed[edge.to]) return false;
    if (folder && edge.kind === "contains" && edge.from === centre) return true;
    return groups.has(GROUP_OF.get(edge.kind) ?? "");
  });
  const reached = new Set([centre]);
  for (const edge of kept) {
    if (edge.from === centre) reached.add(edge.to);
    if (edge.to === centre) reached.add(edge.from);
  }
  const scope = graph.nodes[centre].scope;
  const opener = graph.nodes.findIndex((node) => node.opensScope === true && node.scope === scope);
  if (opener !== -1 && allowed[opener]) reached.add(opener);

  const nodes: ShownNode[] = [];
  const place = new Map<number, number>();
  for (const at of [...reached].sort((a, b) => a - b)) {
    const node = graph.nodes[at];
    place.set(at, nodes.length);
    nodes.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      scope: node.scope === null ? null : (scopes.get(node.scope) ?? null),
      mark: node.opensScope ? 1 : 0,
      library: node.library === true,
      ...(node.color ? { color: node.color } : {}),
    });
  }
  const links: ShownGraph["links"] = kept.flatMap((edge) => {
    const source = place.get(edge.from);
    const target = place.get(edge.to);
    return source === undefined || target === undefined ? [] : [{ source, target, kind: edge.kind }];
  });

  // A scope's AGENTS.md brings in its folder, even with Folders off, tied to it
  // so the pair reads as one.
  const byId = new Map(nodes.map((node, at) => [node.id, at]));
  for (const [at, node] of [...nodes.entries()]) {
    if (node.mark !== 1 || !node.scope) continue;
    const id = `${node.scope.id}/`;
    let pair = byId.get(id);
    if (pair === undefined) {
      pair = nodes.length;
      byId.set(id, pair);
      nodes.push({ id, kind: "folder", label: `${node.scope.name}/`, scope: node.scope, mark: 2, library: false });
    } else {
      nodes[pair].mark = 2;
    }
    const tied = links.some(
      (link) => (link.source === pair && link.target === at) || (link.source === at && link.target === pair),
    );
    if (!tied) links.push({ source: pair, target: at, kind: "contains" });
  }
  return { nodes, links };
}
