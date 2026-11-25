// Running a Flow without the canvas. The scheduler and the node executors
// are protocol code shared with the editor (src/protocol/flowRuntime.ts,
// flowExecutors.ts); this supplies the half of a run context the browser
// otherwise fills in (docs/protocol.md, Flows → Execution).
//
// Nothing here relaxes a permission. The capability calls go through the
// same sandbox.ts checks the /api/sandbox/* routes use, so a headless run is
// checked by the same code a canvas run is.
import path from "node:path";
import { readClock } from "../protocol/datePlaceholders.ts";
import {
  describeCost,
  type GenerationSpend,
  type NodeExecutionContext,
  type PortValue,
} from "../protocol/flowExecutors.ts";
import { readFlowFile } from "../protocol/flowFile.ts";
import { applyRunInputs, flowRunOutputs } from "../protocol/flowInputs.ts";
import { resolveFlowCapability } from "../protocol/flowNodes.ts";
import { type RunResult, runFlow } from "../protocol/flowRuntime.ts";
import { type FlowGraph, flowCapabilityKey } from "../protocol/types.ts";
import { recordActivity } from "./activityLog.ts";
import { isCapabilityGranted, unattendedStanding } from "./grants.ts";
import { bytesReader } from "./headerReader.ts";
import { readImageDimensions } from "./imageHeader.ts";
import {
  performSandboxAddRow,
  performSandboxAddToNote,
  performSandboxGenerate,
  performSandboxGenerateImage,
  performSandboxGenerateOptions,
  performSandboxGenerateVideo,
  performSandboxRead,
  performSandboxWrite,
  readSandboxDocument,
} from "./sandbox.ts";
import { resolveWithinSpace } from "./spaceFiles.ts";
import { scopesOnDisk } from "./tree.ts";

export interface FlowRunOutcome {
  /** Every node that produced a value, in graph order. */
  outputs: { nodeId: string; nodeType: string; values: Record<string, PortValue> }[];
  /** Nodes whose run failed, by id. Empty on a clean run. */
  errors: { nodeId: string; message: string }[];
  /** What the flow produced: the output ports a human marked with right-click
   * → Expose, in App mode's own order. **Empty when the flow exposes none** —
   * a flow that declares no outputs produces none, rather than having some
   * guessed for it from the graph's shape. */
  results: { nodeId: string; nodeType: string; port: string; value: PortValue }[];
}

/** How long a headless run may take before it is stopped. Nobody is watching
 * to give up on a hung model call, and every minute of one may be billed. */
export const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;

export interface FlowRunOptions {
  timeoutMs?: number;
  /** Values for the flow's exposed inputs, by `<nodeId>.<field>`, for this
   * run only. */
  inputs?: Record<string, unknown>;
  /** Set by a caller that is not the space's owner at a terminal — the agent
   * API. Such a run needs the flow's unattended grant on top of its
   * capability grants, and is refused before any node runs without it. */
  unattended?: boolean;
  /** The caller's own lifetime. When it aborts — the client disconnected or
   * gave up — the run stops as it would at the time limit, rather than
   * spending on a result nobody will receive. */
  signal?: AbortSignal;
}

/** A run refused because the flow is not allowed to run unattended: never
 * allowed, or allowed until a day that has passed. */
export class UnattendedRunRefusedError extends Error {}

/** An unattended run refused because the same flow is already running one. */
export class FlowAlreadyRunningError extends Error {}

// Unattended runs in flight, by absolute file path. One at a time per flow:
// the unattended grant says a caller may start a run, not how many, and a
// client stuck retrying would otherwise stack them, each allowed the full
// time limit. By path rather than flow id, since a copied flow keeps its id.
const unattendedRuns = new Set<string>();

function describeLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;
}

/** Runs the flow at `relativePath` (space-relative) and reports what each
 * node produced.
 *
 * Grants are consulted, never requested: there is no one to prompt, so a
 * capability not already granted is refused and the executor that needed it
 * fails naming it. Approvals are created only by a human at the canvas,
 * which keeps a headless runner unable to widen what a flow may do. */
export async function runFlowHeadless(
  spaceRoot: string,
  relativePath: string,
  options: FlowRunOptions = {},
): Promise<FlowRunOutcome> {
  // Throws if the path escapes the space, before anything reads it.
  resolveWithinSpace(spaceRoot, relativePath);
  const flow = await readFlowFile(path.join(spaceRoot, relativePath));
  const doc = await readSandboxDocument(spaceRoot, "flow", relativePath);
  if (options.unattended) {
    const standing = await unattendedStanding(spaceRoot, doc.subject);
    if (!standing.allowed) {
      throw new UnattendedRunRefusedError(
        standing.until === undefined
          ? `${relativePath} is not allowed to run unattended. Allow it in the flow's Permissions.`
          : `${relativePath} was allowed to run unattended until ${standing.until}. Allow it again in the flow's Permissions.`,
      );
    }
  }

  // Before the clock starts, so a bad input is refused rather than run.
  const graph = applyRunInputs(flow.graph, options.inputs ?? {});

  const runKey = path.resolve(spaceRoot, relativePath);
  if (options.unattended) {
    if (unattendedRuns.has(runKey)) {
      throw new FlowAlreadyRunningError(`${relativePath} is already running. Wait for that run to finish.`);
    }
    unattendedRuns.add(runKey);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const stop = new AbortController();
  const timer = setTimeout(
    () => stop.abort(new Error(`the run passed its ${describeLimit(timeoutMs)} time limit`)),
    timeoutMs,
  );
  const callerGone = () => stop.abort(new Error("the caller stopped waiting for the run"));
  if (options.signal?.aborted) callerGone();
  options.signal?.addEventListener("abort", callerGone, { once: true });

  const spends: GenerationSpend[] = [];
  const context: NodeExecutionContext = {
    flowPath: relativePath,
    sandbox: {
      read: (_kind, _path, targetPath) => performSandboxRead(spaceRoot, doc, targetPath),
      write: (_kind, _path, targetPath, content) => performSandboxWrite(spaceRoot, doc, targetPath, content),
      addRow: (_kind, _path, targetPath, values) => performSandboxAddRow(spaceRoot, doc, targetPath, values),
      addToNote: (_kind, _path, targetPath, text, mode) =>
        performSandboxAddToNote(spaceRoot, doc, targetPath, text, mode),
      generate: (_kind, _path, body, signal) => performSandboxGenerate(spaceRoot, doc, body, signal),
      generateOptions: (_kind, _path, body, signal) => performSandboxGenerateOptions(spaceRoot, doc, body, signal),
      generateImage: (_kind, _path, body, signal) => performSandboxGenerateImage(spaceRoot, doc, body, signal),
      generateVideo: (_kind, _path, body, signal) => performSandboxGenerateVideo(spaceRoot, doc, body, signal),
    },
    // Read from the image's own header rather than an <img>, by its signature
    // as an <img> reads it, so a loadImage node with a persisted path runs
    // here exactly as it does on the canvas.
    decodeImageDimensions: async (_mediaType, data) => readImageDimensions(bytesReader(Buffer.from(data, "base64"))),
    // A picker's ephemeral bytes never exist here. A loadImage node with a
    // persisted `imagePath` runs unchanged; one without it fails naming the
    // node, which is the executor's own behaviour and the right one — a
    // silent different-result is worse than a stop.
    pickedImages: new Map(),
    ensureCapability: async (capability) =>
      isCapabilityGranted(spaceRoot, doc.subject, flowCapabilityKey(resolveFlowCapability(capability, relativePath))),
    beginLlmActivity: () => undefined,
    endLlmActivity: () => undefined,
    spent: (_nodeId, spend) => spends.push(spend),
    signal: stop.signal,
    scopes: async () => scopesOnDisk(spaceRoot),
    // The host's own clock: an outside caller's run has no writer's to send.
    clock: readClock(new Date()),
  };

  let result: RunResult;
  try {
    result = await runFlow(graph, context);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", callerGone);
    if (options.unattended) unattendedRuns.delete(runKey);
  }
  const outcome = summarize(graph, result);
  // Nothing watches a headless run: there is no canvas lighting up nodes and
  // no status bar counting the model calls it made. Recorded here rather than
  // at each caller so a new one cannot forget to.
  recordActivity(
    outcome.errors.length > 0 ? "warn" : "info",
    "FLOW",
    `Ran ${relativePath}`,
    [
      outcome.errors.length > 0
        ? outcome.errors.map((error) => `${error.nodeId}: ${error.message}`).join("\n")
        : `${outcome.outputs.length} node(s) produced a value`,
      ...describeSpends(spends),
    ].join("\n"),
  );
  return outcome;
}

// Per kind of media, one line per unit spent and one for what was reused:
// the run's paid image and video calls, or nothing when it made none. A
// video's price is the quote asked before its job, so it says so.
export function describeSpends(spends: GenerationSpend[]): string[] {
  return (["image", "video"] as const).flatMap((media) => {
    const ofMedia = spends.filter((spend) => spend.media === media);
    const totals = new Map<string, { amount: number; count: number }>();
    let unpriced = 0;
    for (const spend of ofMedia) {
      if (spend.reused) continue;
      if (!spend.cost) {
        unpriced += 1;
        continue;
      }
      const total = totals.get(spend.cost.unit) ?? { amount: 0, count: 0 };
      total.amount += spend.cost.amount;
      total.count += 1;
      totals.set(spend.cost.unit, total);
    }
    const reused = ofMedia.filter((spend) => spend.reused).length;
    const counted = (n: number) => `${n} ${media}${n === 1 ? "" : "s"}`;
    const price = (unit: string, total: { amount: number; count: number }) =>
      media === "video"
        ? `Quoted ${describeCost({ amount: total.amount, unit })} for ${counted(total.count)}`
        : `Spent ${describeCost({ amount: total.amount, unit })} on ${counted(total.count)}`;
    return [
      ...[...totals].map(([unit, total]) => price(unit, total)),
      ...(unpriced ? [`${counted(unpriced)} generated at a price the provider didn't name`] : []),
      ...(reused ? [`${counted(reused)} reused, nothing spent`] : []),
    ];
  });
}

function summarize(graph: FlowGraph, result: RunResult): FlowRunOutcome {
  const outputs = graph.nodes
    .filter((node) => result.outputs.has(node.id))
    .map((node) => ({ nodeId: node.id, nodeType: node.type, values: result.outputs.get(node.id) ?? {} }));

  // What a flow returns is what a human marked with Expose — the same
  // declaration App mode renders its published view from, rather than a
  // second notion of "the output" that could disagree with it.
  const types = new Map(graph.nodes.map((node) => [node.id, node.type]));
  const results = flowRunOutputs(graph)
    .map(({ nodeId, port }) => ({
      nodeId,
      nodeType: types.get(nodeId) ?? "",
      port,
      value: result.outputs.get(nodeId)?.[port],
    }))
    .filter((entry): entry is FlowRunOutcome["results"][number] => entry.value !== undefined);

  // No fallback when nothing is exposed. Inferring results from the graph's
  // shape — everything nothing consumes — promotes canvas debris to an
  // answer, and a caller can't tell the guess from the real thing. Say so
  // rather than invent, as architecture.md's Compatibility section rules.
  // `--all` is how you see every node's value.
  return { outputs, errors: errorList(result), results };
}

function errorList(result: RunResult): { nodeId: string; message: string }[] {
  return [...result.errors].map(([nodeId, message]) => ({ nodeId, message }));
}
