// Topological execution over a FlowGraph — repeated-scan Kahn's algorithm:
// O(n^2) worst case, simple, and fine at the size of a hand-built graph.

import { shortDigest } from "./canonical.ts";
import { NODE_EXECUTORS, type NodeExecutionContext, type PortValue } from "./flowExecutors.ts";
import { FLOW_NODE_REGISTRY, nodePorts, nodesLeftOut, wiredOutputs } from "./flowNodes.ts";
import { type SetupNeed, setupNeedOf } from "./setupNeed.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance, FlowPortType } from "./types.ts";

// The editor only lets matching pins connect (see types.ts), so a type
// mismatch here means the graph on disk breaks the editor's rules. The node
// is failed rather than run: a wrongly-typed value nobody is watching for (a
// headless run) is worse than a run that stops and names the bad edge. See
// docs/architecture.md's Compatibility section.
function portTypeMismatch(value: PortValue, targetType: FlowPortType | undefined): boolean {
  return targetType !== undefined && value.type !== targetType;
}

// A saved wire naming a port its node lacks, as after a port is renamed. Run
// as unwired, the node would quietly work on less than the graph says.
function missingPort(
  node: FlowNodeInstance,
  edges: FlowEdgeInstance[],
  nodesById: Map<string, FlowNodeInstance>,
): string | undefined {
  for (const edge of edges) {
    if (!nodePorts(node).inputs.some((port) => port.id === edge.targetPort)) {
      return `A wire goes into "${edge.targetPort}", a port this node doesn't have. Disconnect it.`;
    }
    const source = nodesById.get(edge.source);
    if (source && !nodePorts(source).outputs.some((port) => port.id === edge.sourcePort)) {
      return `A wire comes from "${edge.sourcePort}", a port node "${edge.source}" doesn't have. Disconnect it.`;
    }
  }
  return undefined;
}

export interface RunResult {
  outputs: Map<string, Record<string, PortValue>>;
  errors: Map<string, string>;
  // Each failed node a setting would fix, mapped to what it needs.
  needs: Map<string, SetupNeed>;
  // The fingerprint behind each output of a node that reuses on request,
  // taken only when the run was given a recall: what a host keeps beside
  // the outputs to recall them on a later run.
  fingerprints: Map<string, string>;
  // Each node left out for a disabled node it is fed by, mapped to that
  // node. A disabled node itself is in no map: it was never meant to run.
  skipped: Map<string, string>;
}

/** A host's memory of a node that reuses on request: the outputs it gave
 * for exactly this fingerprint, if the host still holds them. */
export type Recall = (nodeId: string, fingerprint: string) => Record<string, PortValue> | undefined;

export interface RunHooks {
  // Fired immediately before/after a node's executor is awaited — lets the
  // view highlight whichever node is currently running. Not fired for a
  // node that's skipped without ever reaching the executor (unknown type,
  // failed upstream, cyclic dependency): there's nothing "active" about
  // those.
  onNodeStart?: (nodeId: string) => void;
  // `progress` is the run so far, this node's output or error included, so
  // a view can show a result while slower nodes are still running. Also
  // fired for a node answered from a host's memory, with no start before it.
  onNodeFinish?: (nodeId: string, progress: RunResult) => void;
}

const HELD = "Held: its inputs and settings repeated.";

// What a node that reuses on request is compared by: its type, its config
// but `reuse`, and the values on its inputs. Never config alone, since an
// edited note upstream changes an input with no config touched; and `reuse`
// stays out, so switching it on matches the result already stored.
function fingerprintOf(node: FlowNodeInstance, inputs: Record<string, PortValue>): string {
  const config = Object.fromEntries(Object.entries(node.config).filter(([key]) => key !== "reuse"));
  return shortDigest({ type: node.type, config, inputs });
}

function incomingEdgesByTarget(graph: FlowGraph): Map<string, FlowEdgeInstance[]> {
  const map = new Map<string, FlowEdgeInstance[]>();
  for (const edge of graph.edges) {
    const list = map.get(edge.target) ?? [];
    list.push(edge);
    map.set(edge.target, list);
  }
  return map;
}

// Why a stopped run stopped, as a node's error. The signal's reason when it
// carries one, since that names the limit that tripped.
function stoppedReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "the run was stopped";
}

/** Runs the graph. A node in `known` is not executed again: its outputs are
 * taken as given, which is how one node runs alone on the inputs its last
 * run had, without paying again for what fed it. With `recall`, a node that
 * reuses on request is fingerprinted, and one whose `reuse` is on is answered
 * from the host's memory when its fingerprint repeats.
 *
 * With `first`, that node runs before any other starts, and if it fails,
 * nothing else does. */
export async function runFlow(
  graph: FlowGraph,
  context: NodeExecutionContext,
  hooks?: RunHooks,
  known?: Map<string, Record<string, PortValue>>,
  recall?: Recall,
  first?: string,
): Promise<RunResult> {
  const incoming = incomingEdgesByTarget(graph);
  const wired = wiredOutputs(graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const leads = first !== undefined && nodesById.has(first) ? first : undefined;
  const outputs = new Map<string, Record<string, PortValue>>();
  const errors = new Map<string, string>();
  const needs = new Map<string, SetupNeed>();
  const fingerprints = new Map<string, string>();
  const skipped = new Map<string, string>();
  const done = new Set<string>();
  // Before anything is given: a node disabled since the last run gives
  // nothing, even to a Regenerate that would otherwise take its outputs.
  for (const [id, disabled] of nodesLeftOut(graph)) {
    done.add(id);
    if (id !== disabled) skipped.set(id, disabled);
  }
  for (const node of graph.nodes) {
    if (done.has(node.id)) continue;
    const given = known?.get(node.id);
    if (!given) continue;
    outputs.set(node.id, given);
    done.add(node.id);
  }

  const upstreamOf = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    upstreamOf.set(node.id, new Set((incoming.get(node.id) ?? []).map((edge) => edge.source)));
  }
  // What feeds the lead runs ahead of it, or a lead with a wire into it, as
  // an old Button had, would wait on nodes waiting on it.
  const feedsLead = new Set<string>();
  for (const pending = leads === undefined ? [] : [...(upstreamOf.get(leads) ?? [])]; pending.length > 0; ) {
    const id = pending.pop() as string;
    if (feedsLead.has(id)) continue;
    feedsLead.add(id);
    pending.push(...(upstreamOf.get(id) ?? []));
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    // A failed lead ends the run with nothing else started, so no node is
    // reported failed for a node it doesn't take a wire from.
    if (leads !== undefined && errors.has(leads)) break;
    for (const node of graph.nodes) {
      if (done.has(node.id)) continue;
      const waits = leads !== undefined && node.id !== leads && !feedsLead.has(node.id);
      if (waits && (!done.has(leads) || errors.has(leads))) continue;
      const deps = upstreamOf.get(node.id) ?? new Set<string>();
      if ([...deps].some((depId) => !done.has(depId))) continue; // still waiting on an upstream node

      progressed = true;
      // A stopped run starts nothing further. Each remaining node fails with
      // the reason rather than reading as "upstream failed", which would
      // point at a node that never went wrong.
      if (context.signal?.aborted) {
        errors.set(node.id, stoppedReason(context.signal));
        done.add(node.id);
        continue;
      }
      const failedUpstream = [...deps].find((depId) => errors.has(depId));
      if (failedUpstream) {
        errors.set(node.id, `upstream node "${failedUpstream}" failed`);
        done.add(node.id);
        continue;
      }

      const executor = NODE_EXECUTORS[node.type];
      if (!executor) {
        errors.set(node.id, `unknown node type "${node.type}"`);
        done.add(node.id);
        continue;
      }

      const missing = missingPort(node, incoming.get(node.id) ?? [], nodesById);
      if (missing) {
        errors.set(node.id, missing);
        done.add(node.id);
        continue;
      }

      const inputs: Record<string, PortValue> = {};
      let mismatch: string | undefined;
      for (const edge of incoming.get(node.id) ?? []) {
        const value = outputs.get(edge.source)?.[edge.sourcePort];
        if (!value) continue;
        const targetType = nodePorts(node).inputs.find((p) => p.id === edge.targetPort)?.type;
        if (portTypeMismatch(value, targetType)) {
          mismatch = `${edge.source}.${edge.sourcePort} (${value.type}) is wired to ${edge.targetPort} (${targetType})`;
          break;
        }
        inputs[edge.targetPort] = value;
      }

      if (mismatch) {
        errors.set(node.id, `edge type mismatch: ${mismatch}`);
        done.add(node.id);
        continue;
      }

      // Fingerprinted only when a host can recall: a run with no memory pays
      // nothing for it. Nor while a context is wired: it sends files the node
      // never receives, so no fingerprint of its inputs says its reply repeats.
      const definition = FLOW_NODE_REGISTRY[node.type];
      const readsContext = definition?.contextPort !== undefined && inputs[definition.contextPort] !== undefined;
      const fingerprint =
        recall && definition?.reuse === "optional" && !readsContext ? fingerprintOf(node, inputs) : undefined;
      const held = fingerprint && node.config.reuse === "true" ? recall?.(node.id, fingerprint) : undefined;
      if (held && fingerprint) {
        outputs.set(node.id, held);
        fingerprints.set(node.id, fingerprint);
        context.report?.(node.id, [HELD]);
        hooks?.onNodeFinish?.(node.id, { outputs, errors, needs, fingerprints, skipped });
        done.add(node.id);
        continue;
      }

      hooks?.onNodeStart?.(node.id);
      try {
        outputs.set(node.id, await executor(node, inputs, context, wired.get(node.id) ?? new Set()));
        if (fingerprint) fingerprints.set(node.id, fingerprint);
      } catch (error) {
        if (context.signal?.aborted) errors.set(node.id, stoppedReason(context.signal));
        else {
          errors.set(node.id, error instanceof Error ? error.message : String(error));
          const need = setupNeedOf(error);
          if (need) needs.set(node.id, need);
        }
      } finally {
        hooks?.onNodeFinish?.(node.id, { outputs, errors, needs, fingerprints, skipped });
      }
      done.add(node.id);
    }
  }

  // Anything still not done after the scan stopped making progress is part
  // of a cycle (or depends on one) — mark it rather than silently skipping.
  if (leads === undefined || !errors.has(leads)) {
    for (const node of graph.nodes) {
      if (!done.has(node.id)) errors.set(node.id, "cyclic dependency: never became runnable");
    }
  }

  return { outputs, errors, needs, fingerprints, skipped };
}
