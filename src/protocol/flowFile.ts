import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "node-html-parser";
import { canonicalize } from "./canonical.ts";
import { readMetadataBlock } from "./tableFile.ts";
import type { AppModeSize, FlowEdgeInstance, FlowFile, FlowGraph, FlowNodeInstance } from "./types.ts";
import { normalizeHexColor } from "./types.ts";

function emptyGraph(): FlowGraph {
  return { nodes: [], edges: [] };
}

export function emptyFlowFile(html: string): FlowFile {
  return { version: "1.0", graph: emptyGraph(), html };
}

function readPosition(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== "object") return { x: 0, y: 0 };
  const candidate = value as Partial<{ x: unknown; y: unknown }>;
  return {
    x: typeof candidate.x === "number" ? candidate.x : 0,
    y: typeof candidate.y === "number" ? candidate.y : 0,
  };
}

function readSize(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<{ width: unknown; height: unknown }>;
  if (typeof candidate.width !== "number" || typeof candidate.height !== "number") return undefined;
  return { width: candidate.width, height: candidate.height };
}

function readColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeHexColor(value);
  return normalized || undefined;
}

function readExposed(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function readAppModeOrder(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isCellCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Whole, positive counts or no size at all — never rounded or clamped here.
// Fitting a size to the columns it has is each host's call, at display, so
// a stored size outlives a narrow pane.
function readAppModeSize(value: unknown): AppModeSize | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<{ columns: unknown; rows: unknown }>;
  if (!isCellCount(candidate.columns) || !isCellCount(candidate.rows)) return undefined;
  return { columns: candidate.columns, rows: candidate.rows };
}

function readNodes(value: unknown): FlowNodeInstance[] {
  if (!Array.isArray(value)) return [];
  const nodes: FlowNodeInstance[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<FlowNodeInstance>;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    if (typeof candidate.type !== "string" || !candidate.type) continue;
    nodes.push({
      id: candidate.id,
      type: candidate.type,
      typeVersion: typeof candidate.typeVersion === "string" ? candidate.typeVersion : undefined,
      position: readPosition(candidate.position),
      config:
        candidate.config && typeof candidate.config === "object" ? (candidate.config as Record<string, unknown>) : {},
      size: readSize(candidate.size),
      label: typeof candidate.label === "string" && candidate.label ? candidate.label : undefined,
      comment: typeof candidate.comment === "string" && candidate.comment.trim() ? candidate.comment : undefined,
      color: readColor(candidate.color),
      collapsed: typeof candidate.collapsed === "boolean" ? candidate.collapsed : undefined,
      mode: candidate.mode === "disabled" ? "disabled" : undefined,
      exposed: readExposed(candidate.exposed),
      appModeOrder: readAppModeOrder(candidate.appModeOrder),
      appModeSize: readAppModeSize(candidate.appModeSize),
    });
  }
  return nodes;
}

function readEdges(value: unknown): FlowEdgeInstance[] {
  if (!Array.isArray(value)) return [];
  const edges: FlowEdgeInstance[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<FlowEdgeInstance>;
    if (
      typeof candidate.id === "string" &&
      candidate.id &&
      typeof candidate.source === "string" &&
      candidate.source &&
      typeof candidate.sourcePort === "string" &&
      candidate.sourcePort &&
      typeof candidate.target === "string" &&
      candidate.target &&
      typeof candidate.targetPort === "string" &&
      candidate.targetPort
    ) {
      edges.push({
        id: candidate.id,
        source: candidate.source,
        sourcePort: candidate.sourcePort,
        target: candidate.target,
        targetPort: candidate.targetPort,
      });
    }
  }
  return edges;
}

function readViewport(value: unknown): { x: number; y: number; zoom: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<{ x: unknown; y: unknown; zoom: unknown }>;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number" || typeof candidate.zoom !== "number") {
    return undefined;
  }
  return { x: candidate.x, y: candidate.y, zoom: candidate.zoom };
}

function readGraph(value: unknown): FlowGraph {
  if (!value || typeof value !== "object") return emptyGraph();
  const candidate = value as Partial<FlowGraph>;
  return {
    nodes: readNodes(candidate.nodes),
    edges: readEdges(candidate.edges),
    viewport: readViewport(candidate.viewport),
    runAppModeOrder: readAppModeOrder(candidate.runAppModeOrder),
    runAppModeSize: readAppModeSize(candidate.runAppModeSize),
    appModeActive: typeof candidate.appModeActive === "boolean" ? candidate.appModeActive : undefined,
  };
}

/** Graceful-fallback reader: a missing, empty, or malformed `.flow.html` file
 * — or one missing its graph block — never throws, it just reads as an empty
 * graph.
 *
 * For callers that never save what they read. One that saves parses the
 * text itself, below, which tells blank from unreadable. */
export async function readFlowFile(filePath: string): Promise<FlowFile> {
  let html: string;
  try {
    html = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyFlowFile("");
    throw error;
  }
  return parseFlowFile(html) ?? emptyFlowFile(html);
}

/** Blank text, or a blank graph block, is a new, empty graph; non-blank text
 * that isn't a flow, or whose graph block isn't JSON, is `undefined`. Saving
 * that empty graph back would erase the file (docs/protocol.md's
 * "Reading and write protection").
 *
 * Read purely as data, never run in an iframe: `.flow.html` carries no
 * executable script of its own (see FlowPortType's doc comment in types.ts). */
export function parseFlowFile(html: string): FlowFile | undefined {
  if (!html.trim()) return emptyFlowFile(html);
  try {
    const root = parse(html);
    const htmlElement = root.querySelector("html");
    if (htmlElement?.getAttribute("data-format") !== "flow") return undefined;

    const graphText = root.querySelector('script[data-role="graph"]')?.textContent.trim();
    const graph = graphText ? readGraph(JSON.parse(graphText)) : emptyGraph();

    return {
      version: htmlElement.getAttribute("data-format-version") || "1.0",
      name: root.querySelector("head > title")?.textContent.trim() || undefined,
      metadata: readMetadataBlock(root),
      graph,
      html,
    };
  } catch {
    return undefined;
  }
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A flow's grant-pinning hash: SHA-256 over only the part of a graph that
 * decides what a run can do — nodes, wiring, and every config value a node
 * reads. Not the whole file, as an applet pins: dragging a node or resizing a
 * card rewrites the file, and a grant has to survive that.
 *
 * The excluded keys are named and everything else is kept, so a field added
 * later lands in the digest by default — misclassifying one then costs an
 * extra consent prompt, never a capability-relevant change left unhashed. */
export function capabilityDigest(graph: FlowGraph): string {
  const nodes = graph.nodes
    .map(({ position, size, label, comment, color, collapsed, appModeOrder, appModeSize, ...rest }) => rest)
    .sort(byId);
  const { viewport, runAppModeOrder, runAppModeSize, appModeActive, ...rest } = graph;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ ...rest, nodes, edges: [...graph.edges].sort(byId) })))
    .digest("hex");
}
