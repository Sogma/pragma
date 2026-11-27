// A Table column's id, changed in the Flows that name it: the column a Make
// Object or Add Row holding that Table records, what was typed for it and
// the wires into its pin; a Load Random Row's weight column; and the keys a
// Get Field or Chart picks from the rows a loader of that Table hands it.
//
// A scan, as a move's rewrite is, and a save as the person's own change, so
// a Flow's grants carry over to a graph that only renamed a key.
import { readFile } from "node:fs/promises";
import { ADD_ROW_NODE_TYPE } from "../protocol/addRowNode.ts";
import { columnPinsConfig } from "../protocol/columnPins.ts";
import { parseFlowFile } from "../protocol/flowFile.ts";
import { serializeFlowFile } from "../protocol/flowHtml.ts";
import { MAKE_OBJECT_NODE_TYPE } from "../protocol/makeObjectNode.ts";
import { resolveDeclaredPath } from "../protocol/relativeReference.ts";
import { dirnameOf } from "../protocol/rootedPath.ts";
import { type FlowGraph, type FlowNodeInstance, isFlowFile } from "../protocol/types.ts";
import { saveDocument } from "./saveDocument.ts";
import { readRevision, resolveWithinSpace, revisionOf, withFileLock } from "./spaceFiles.ts";
import { listRootPaths } from "./tree.ts";

/** How many Flows are read at once, as for a move's rewrite. */
const READ_CONCURRENCY = 64;

const PINNED = new Set([MAKE_OBJECT_NODE_TYPE, ADD_ROW_NODE_TYPE]);

// A loader's output of the Table's rows, by type.
const ROWS_OUT: Record<string, string> = { loadRow: "row", loadRandomRow: "row", loadTableRows: "rows" };

// The nodes that hand on the rows they're given, by the port that comes in
// and goes out under one name.
const PASSES_ON: Record<string, string> = { showObject: "object", chart: "rows" };

// Where a node reading those rows keeps the keys it picks, by type and the
// input the rows come in on.
const PICKS: Record<string, { input: string; keys: (config: Record<string, unknown>) => string[] }> = {
  getField: { input: "object", keys: (config) => Object.keys(config).filter((key) => /^field\d+Key$/.test(key)) },
  chart: { input: "rows", keys: () => ["x", "y"] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A node holding the Table at `tablePath` in its config, as its Flow's
// folder reads the path there.
function holdsTable(node: FlowNodeInstance, flowPath: string, tablePath: string): boolean {
  const declared = node.config.tablePath;
  if (typeof declared !== "string" || !declared) return false;
  try {
    const rooted = resolveDeclaredPath(dirnameOf(flowPath), declared);
    return rooted.root === "space" && rooted.path === tablePath;
  } catch {
    return false;
  }
}

/** `graph` with column `from` of the Table renamed `to` wherever it names
 * it, or undefined when it names it nowhere. */
function renamed(
  graph: FlowGraph,
  flowPath: string,
  tablePath: string,
  from: string,
  to: string,
): FlowGraph | undefined {
  const holding = graph.nodes.filter((node) => holdsTable(node, flowPath, tablePath));
  const pinned = new Set(
    holding
      .filter((node) => PINNED.has(node.type) && columnPinsConfig(node.config).columns.some(({ id }) => id === from))
      .map((node) => node.id),
  );
  // Every output carrying the Table's rows: a loader's, then each that passes
  // them on.
  const carrying = new Set(
    holding.filter((node) => ROWS_OUT[node.type]).map((node) => `${node.id}:${ROWS_OUT[node.type]}`),
  );
  const typeOf = (id: string) => graph.nodes.find((node) => node.id === id)?.type ?? "";
  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of graph.edges) {
      const port = PASSES_ON[typeOf(edge.target)];
      const out = `${edge.target}:${port}`;
      if (port === edge.targetPort && carrying.has(`${edge.source}:${edge.sourcePort}`) && !carrying.has(out)) {
        carrying.add(out);
        grew = true;
      }
    }
  }
  const readers = new Set(
    graph.edges
      .filter(
        (edge) =>
          carrying.has(`${edge.source}:${edge.sourcePort}`) && PICKS[typeOf(edge.target)]?.input === edge.targetPort,
      )
      .map((edge) => edge.target),
  );
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const config = { ...node.config };
    if (pinned.has(node.id)) {
      if (Array.isArray(config.columns)) {
        config.columns = config.columns.map((raw) => (isRecord(raw) && raw.id === from ? { ...raw, id: to } : raw));
      }
      if (isRecord(config.values) && Object.hasOwn(config.values, from)) {
        const { [from]: typed, ...rest } = config.values;
        config.values = { ...rest, [to]: typed };
      }
    }
    if (node.type === "loadRandomRow" && config.weightColumn === from && holding.includes(node)) {
      config.weightColumn = to;
    }
    if (readers.has(node.id)) {
      for (const key of PICKS[node.type].keys(config)) if (config[key] === from) config[key] = to;
    }
    if (JSON.stringify(config) === JSON.stringify(node.config)) return node;
    changed = true;
    return { ...node, config };
  });
  const edges = graph.edges.map((edge) => {
    if (!pinned.has(edge.target) || edge.targetPort !== from) return edge;
    changed = true;
    return { ...edge, targetPort: to };
  });
  return changed ? { ...graph, nodes, edges } : undefined;
}

/** The space's Flows naming column `from` of the Table at `tablePath`, a
 * space path, each rewritten to name `to` when `apply` is set. A Flow saved
 * between its read and its write keeps the old id, and isn't listed. */
export async function changeColumnIdInFlows(
  spaceRoot: string,
  tablePath: string,
  from: string,
  to: string,
  apply: boolean,
): Promise<string[]> {
  async function changeIn(flowPath: string): Promise<boolean> {
    const filePath = resolveWithinSpace(spaceRoot, flowPath);
    try {
      const bytes = await readFile(filePath);
      const file = parseFlowFile(bytes.toString("utf8"));
      if (!file) return false;
      const graph = renamed(file.graph, flowPath, tablePath, from, to);
      if (!graph) return false;
      if (!apply) return true;
      const { version, name, metadata } = file;
      const content = serializeFlowFile({ version, name, metadata, graph });
      return await withFileLock(filePath, async () => {
        if ((await readRevision(filePath)) !== revisionOf(bytes)) return false;
        await saveDocument(spaceRoot, { filePath, relativePath: flowPath }, content);
        return true;
      });
    } catch {
      return false;
    }
  }

  const flows = (await listRootPaths(spaceRoot, "space")).files.filter(isFlowFile);
  const found: string[] = [];
  for (let i = 0; i < flows.length; i += READ_CONCURRENCY) {
    const batch = flows.slice(i, i + READ_CONCURRENCY);
    const changed = await Promise.all(batch.map(changeIn));
    found.push(...batch.filter((_, at) => changed[at]));
  }
  return found;
}
