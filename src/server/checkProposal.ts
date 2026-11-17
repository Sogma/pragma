// A Flow, Table, Class or Applet the copilot proposes, checked before the
// writer sees it: a problem goes back to the model, which can fix it within
// the turn, so what reaches the writer opens as it says. What the host
// derives from the space, it fills in as a Flow's editor would on opening the
// file. Anything else passes as written.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type HTMLElement, parse } from "node-html-parser";
import { ADD_ROW_NODE_TYPE, addRowColumns, addRowNodeConfig } from "../protocol/addRowNode.ts";
import { contentHashFor, parseAppletFile, readAppletFile } from "../protocol/appletFile.ts";
import { APPLET_NODE_TYPE, appletNodeConfig, appletNodeProblem } from "../protocol/appletNode.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { parseFlowFile } from "../protocol/flowFile.ts";
import { serializeFlowFile } from "../protocol/flowHtml.ts";
import { FLOW_NODE_REGISTRY, GET_FIELD_SLOTS, type SlotSpec, TEMPLATE_VARIABLE_SLOTS } from "../protocol/flowNodes.ts";
import { flowAuthoringProblems, nodeName } from "../protocol/flowProblems.ts";
import { resolveDeclaredPath } from "../protocol/relativeReference.ts";
import { dirnameOf, formatRootedPath } from "../protocol/rootedPath.ts";
import { parseTableFile } from "../protocol/tableFile.ts";
import {
  FIELD_VALUE_TYPES,
  type FlowGraph,
  type FlowNodeInstance,
  isAppletFile,
  isClassFile,
  isFlowFile,
  isTableFile,
} from "../protocol/types.ts";
import { readAppletImports } from "./appletImports.ts";
import { type Access, isSpaceTarget, type ResolvedRootedPath, resolveHeldPath } from "./rootedFiles.ts";
import { isPrivateFile } from "./tree.ts";

export interface CheckedProposal {
  /** The file as the writer will see it. */
  content: string;
  /** Why it can't be proposed; empty when it can. */
  problems: string[];
}

/** `before` is the file a proposal replaces, when it replaces one. An edit
 * answers only for the problems it adds: what the file already had is the
 * writer's to fix, and no reason to refuse the change they asked for. */
export async function checkProposal(
  spaceRoot: string,
  relativePath: string,
  content: string,
  before?: string,
): Promise<CheckedProposal> {
  const checked = await checkKind(spaceRoot, relativePath, content);
  if (before === undefined || checked.problems.length === 0) return checked;
  const had = new Set((await checkKind(spaceRoot, relativePath, before)).problems);
  return { ...checked, problems: checked.problems.filter((problem) => !had.has(problem)) };
}

// A blank file is a new, empty document of any kind, and passes.
async function checkKind(spaceRoot: string, relativePath: string, content: string): Promise<CheckedProposal> {
  if (!content.trim()) return { content, problems: [] };
  if (isFlowFile(relativePath)) return checkFlow(spaceRoot, relativePath, content);
  if (isTableFile(relativePath)) return { content, problems: tableProblems(content) };
  if (isClassFile(relativePath)) return { content, problems: classProblems(content) };
  if (isAppletFile(relativePath)) return { content, problems: await appletProblems(spaceRoot, relativePath, content) };
  return { content, problems: [] };
}

// A Flow the host fills in is written as its editor writes one. One it fills
// nothing into is shown as the model wrote it, since writing it again would
// only reorder its keys and put that noise in an edit's diff.
async function checkFlow(spaceRoot: string, relativePath: string, content: string): Promise<CheckedProposal> {
  const file = parseFlowFile(content);
  if (!file) {
    return {
      content,
      problems: ['It isn\'t a Flow Pragma can read: it needs <html data-format="flow">, and a graph block of JSON.'],
    };
  }
  const flowDir = dirnameOf(relativePath);
  const graph = structuredClone(file.graph);
  const problems: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === APPLET_NODE_TYPE) problems.push(...(await fillAppletNode(spaceRoot, flowDir, node)));
    if (node.type === ADD_ROW_NODE_TYPE) problems.push(...(await fillAddRowNode(spaceRoot, flowDir, node)));
    fillSlots(node, graph);
  }
  problems.push(...(await pathProblems(spaceRoot, flowDir, graph)), ...flowAuthoringProblems(graph));

  const filled = JSON.stringify(graph) !== JSON.stringify(file.graph);
  const { version, name, metadata } = file;
  return {
    content: filled ? serializeFlowFile({ version, name, metadata, graph }) : content,
    problems: [...new Set(problems)],
  };
}

interface FoundEntry extends ResolvedRootedPath {
  isDirectory: boolean;
}

// Where a path a Flow names leads, resolved from the Flow's folder as a run
// resolves it, or why it leads nowhere. A private document reads as absent,
// as in every listing the copilot gets, so a check never tells the model one
// is there; no path names a hidden entry. `folderOnly` is for a file a run
// may create.
async function findEntry(
  spaceRoot: string,
  flowDir: string,
  declared: string,
  access: Access,
  folderOnly = false,
): Promise<FoundEntry | string> {
  let resolved: ResolvedRootedPath;
  try {
    resolved = resolveHeldPath(spaceRoot, formatRootedPath(resolveDeclaredPath(flowDir, declared)), access);
  } catch (error) {
    return `"${declared}" can't be used: ${error instanceof Error ? error.message : String(error)}`;
  }
  const absent = folderOnly ? `"${declared}" is in a folder that isn't there.` : `"${declared}" isn't there.`;
  const target = folderOnly ? path.dirname(resolved.filePath) : resolved.filePath;
  if (!folderOnly && (await isPrivateFile(target))) return absent;
  try {
    const entry = await stat(target);
    if (folderOnly && !entry.isDirectory()) return absent;
    return { ...resolved, isDirectory: entry.isDirectory() };
  } catch {
    return absent;
  }
}

// What an Applet node records of its Applet: its hash and ports, and its name
// for an untitled node.
async function fillAppletNode(spaceRoot: string, flowDir: string, node: FlowNodeInstance): Promise<string[]> {
  const name = nodeName(node, FLOW_NODE_REGISTRY[APPLET_NODE_TYPE]);
  const { appletPath } = appletNodeConfig(node.config);
  if (!appletPath) return [`${name}: it names no Applet; "appletPath" is the Applet it shows.`];
  const found = await findEntry(spaceRoot, flowDir, appletPath, "read");
  if (typeof found === "string") return [`${name}: ${found}`];
  if (found.isDirectory || !isAppletFile(found.filePath)) return [`${name}: "${appletPath}" isn't an Applet.`];
  const { manifest, html } = await readAppletFile(found.filePath);
  const appletDir = dirnameOf(isSpaceTarget(found) ? found.rooted.path : appletPath);
  const { imports, error } = await readAppletImports(spaceRoot, appletDir, manifest);
  node.config.appletHash = contentHashFor(
    html,
    imports.map((entry) => entry.source),
  );
  node.config.ports = manifest.ports ?? { inputs: [], outputs: [] };
  const title = manifest.meta?.name?.trim();
  if (!node.label && title) node.label = title;
  return [error, appletNodeProblem(manifest)].filter((problem) => problem !== undefined).map((p) => `${name}: ${p}`);
}

// An Add Row node's columns, from its Table as it is.
async function fillAddRowNode(spaceRoot: string, flowDir: string, node: FlowNodeInstance): Promise<string[]> {
  const name = nodeName(node, FLOW_NODE_REGISTRY[ADD_ROW_NODE_TYPE]);
  const { tablePath } = addRowNodeConfig(node.config);
  if (!tablePath) return [`${name}: it names no Table; "tablePath" is the Table it adds to.`];
  const found = await findEntry(spaceRoot, flowDir, tablePath, "write");
  if (typeof found === "string") return [`${name}: ${found}`];
  const table =
    !found.isDirectory && isTableFile(found.filePath)
      ? parseTableFile(await readFile(found.filePath, "utf8"))
      : undefined;
  if (!table) return [`${name}: "${tablePath}" isn't a Table Pragma can read.`];
  node.config.columns = addRowColumns(table.columns);
  return [];
}

const SLOTTED: Record<string, SlotSpec> = {
  templateVariables: TEMPLATE_VARIABLE_SLOTS,
  getField: GET_FIELD_SLOTS,
};

// The slots past the floor an editor shows: every one named, keyed or wired,
// and any the Flow already lists. A run reads every slot either way.
function fillSlots(node: FlowNodeInstance, graph: FlowGraph): void {
  const spec = SLOTTED[node.type] ?? FLOW_NODE_REGISTRY[node.type]?.referenceSlots;
  if (!spec) return;
  const first = (spec.floor ?? 1) + 1;
  const listed = node.config[spec.slotsKey];
  const slots = new Set(
    (Array.isArray(listed) ? listed : []).filter(
      (slot): slot is number => Number.isInteger(slot) && slot >= first && slot <= spec.max,
    ),
  );
  for (let slot = first; slot <= spec.max; slot++) {
    const value = spec.configKey ? node.config[spec.configKey(slot)] : undefined;
    const port = spec.portId(slot);
    const wired = graph.edges.some(
      (edge) =>
        (edge.target === node.id && edge.targetPort === port) || (edge.source === node.id && edge.sourcePort === port),
    );
    if ((typeof value === "string" && value.trim()) || wired) slots.add(slot);
  }
  if (slots.size > 0) node.config[spec.slotsKey] = [...slots].sort((a, b) => a - b);
}

// A path a node's capability names has to lead somewhere when it first runs.
// A file a node writes may be new, but not the folder it goes in.
async function pathProblems(spaceRoot: string, flowDir: string, graph: FlowGraph): Promise<string[]> {
  const problems: string[] = [];
  for (const node of graph.nodes) {
    const definition = FLOW_NODE_REGISTRY[node.type];
    const capability = definition?.capabilityFor?.(node.config);
    // An Add Row node's Table was read to fill the node in.
    if (!capability || !("path" in capability) || node.type === ADD_ROW_NODE_TYPE) continue;
    const generates = capability.type === "generateImage" || capability.type === "generateVideo";
    const writes = capability.type === "writeDocument" || generates;
    const found = await findEntry(
      spaceRoot,
      flowDir,
      capability.path,
      writes ? "write" : "read",
      capability.type === "writeDocument",
    );
    if (typeof found === "string") problems.push(`${nodeName(node, definition)}: ${found}`);
    else if (generates && !found.isDirectory) {
      problems.push(`${nodeName(node, definition)}: "${capability.path}" isn't a folder.`);
    }
  }
  return problems;
}

function tableProblems(content: string): string[] {
  if (!parseTableFile(content)) return ['It isn\'t a Table Pragma can read: it needs <html data-format="table">.'];
  return fieldProblems("column", [parse(content).querySelectorAll("table[data-role=data] thead th")]);
}

// A view lists the fields it shows by key, comma-separated.
function classProblems(content: string): string[] {
  if (!parseClassFile(content)) {
    return ['It isn\'t a Class Pragma can read: it needs <html data-format="class">.'];
  }
  const fields = parse(content).querySelectorAll("table[data-role=fields] thead th");
  const commas = fields
    .map((field) => field.getAttribute("data-field") ?? "")
    .filter((key) => key.includes(","))
    .map((key) => `The field "${key}" has a comma in its key, which a view's data-fields can't list.`);
  return [...fieldProblems("field", [fields]), ...commas];
}

// A column or field the reader would type as text whatever it says, or that
// a Flow couldn't name.
function fieldProblems(noun: "column" | "field", groups: HTMLElement[][]): string[] {
  const types: readonly string[] = FIELD_VALUE_TYPES;
  const problems: string[] = [];
  for (const elements of groups) {
    const ids = new Set<string>();
    for (const element of elements) {
      const id = element.getAttribute("data-field") ?? "";
      const type = element.getAttribute("data-type");
      const label = element.textContent.trim();
      if (!id) problems.push(`The ${noun} "${label}" has no data-field id.`);
      else if (ids.has(id)) problems.push(`Two ${noun}s are "${id}"; an id names one ${noun}.`);
      ids.add(id);
      if (type !== undefined && !types.includes(type)) {
        problems.push(`The ${noun} "${id || label}" is a "${type}", a type Pragma doesn't have: ${types.join(", ")}.`);
      }
    }
  }
  return problems;
}

// What an Applet's reader would quietly drop, and what a Flow would refuse.
async function appletProblems(spaceRoot: string, relativePath: string, content: string): Promise<string[]> {
  const script = parse(content).querySelector('script[data-role="manifest"]');
  if (!script) return [];
  let declared: { ports?: Record<string, unknown> };
  try {
    declared = JSON.parse(script.textContent) ?? {};
  } catch {
    return ["Its manifest isn't JSON, so the Applet would open with none."];
  }
  const { manifest } = parseAppletFile(content);
  const problems: string[] = [];
  for (const direction of ["inputs", "outputs"] as const) {
    const listed = declared.ports?.[direction];
    const dropped = (Array.isArray(listed) ? listed.length : 0) - (manifest.ports?.[direction].length ?? 0);
    if (dropped > 0) {
      problems.push(
        `${dropped} of its ${direction} would be dropped: a port needs an id of its own and a Flow port type.`,
      );
    }
  }
  const nodeProblem = appletNodeProblem(manifest);
  if (nodeProblem) problems.push(nodeProblem);
  const { error } = await readAppletImports(spaceRoot, dirnameOf(relativePath), manifest);
  if (error) problems.push(error);
  return problems;
}
