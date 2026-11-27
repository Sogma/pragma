// Topological execution over a FlowGraph — repeated-scan Kahn's algorithm:
// O(n^2) worst case, simple, and fine at the size of a hand-built graph.

import { shortDigest } from "./canonical.ts";
import {
  forEachItems,
  NODE_EXECUTORS,
  type NodeExecutionContext,
  type NodeExecutor,
  type PortValue,
} from "./flowExecutors.ts";
import {
  FLOW_NODE_REGISTRY,
  forEachEndListPort,
  nodePorts,
  nodesLeftOut,
  pathColumns,
  resolveFlowCapability,
  wiredOutputs,
} from "./flowNodes.ts";
import { type FlowZone, flowZones, zoneProblems } from "./flowZones.ts";
import { type SetupNeed, setupNeedOf } from "./setupNeed.ts";
import type {
  FlowCapabilityDeclaration,
  FlowEdgeInstance,
  FlowGraph,
  FlowNodeInstance,
  FlowPortType,
} from "./types.ts";

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

/** One item of a For Each zone: what each of the zone's nodes gave or failed
 * with for it, the fingerprints a host keeps to recall them, and whether
 * every node has settled for it. */
export interface ItemRun {
  outputs: Map<string, Record<string, PortValue>>;
  errors: Map<string, string>;
  fingerprints: Map<string, string>;
  done: boolean;
}

/** A For Each zone's run: its items in list order, one that never started
 * absent, and whether the person stopped it at the ask after the first
 * generation. */
export interface ZoneRun {
  items: (ItemRun | undefined)[];
  stopped: boolean;
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
  // Each For Each zone's items, by the For Each's id. A zone's nodes also
  // hold, in the maps above, the latest item's outputs and their first
  // failure, named by its row.
  zones?: Map<string, ZoneRun>;
}

/** A host's memory of a node that reuses on request: the outputs it gave
 * for exactly this fingerprint, if the host still holds them. */
export type Recall = (nodeId: string, fingerprint: string) => Record<string, PortValue> | undefined;

export interface RunHooks {
  // Fired immediately before/after a node's executor is awaited — lets the
  // view highlight whichever node is currently running. Not fired for a
  // node that's skipped without ever reaching the executor (unknown type,
  // failed upstream, cyclic dependency): there's nothing "active" about
  // those. A zone's node fires once per item, with the item's place from 0.
  onNodeStart?: (nodeId: string, item?: number) => void;
  // `progress` is the run so far, this node's output or error included, so
  // a view can show a result while slower nodes are still running. Also
  // fired for a node answered from a host's memory, with no start before it.
  onNodeFinish?: (nodeId: string, progress: RunResult, item?: number) => void;
}

const HELD = "Held: its inputs and settings repeated.";

// How many items of a zone run side by side: they don't depend on each
// other, and a clip each takes minutes. A cap, so a long list doesn't start
// every generation at once.
const ITEMS_AT_ONCE = 4;

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

// A stored type may name no executor, or a key every object inherits.
function executorOf(type: string): NodeExecutor | undefined {
  return Object.hasOwn(NODE_EXECUTORS, type) ? NODE_EXECUTORS[type] : undefined;
}

// Why a stopped run stopped, as a node's error. The signal's reason when it
// carries one, since that names the limit that tripped.
function stoppedReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "the run was stopped";
}

// A node's inputs from the values its wires bring, or the edge whose value
// has the wrong type.
function gatherInputs(
  node: FlowNodeInstance,
  edges: FlowEdgeInstance[],
  brought: (edge: FlowEdgeInstance) => PortValue | undefined,
): { inputs: Record<string, PortValue>; mismatch?: string } {
  const inputs: Record<string, PortValue> = {};
  for (const edge of edges) {
    const value = brought(edge);
    if (!value) continue;
    const targetType = nodePorts(node).inputs.find((p) => p.id === edge.targetPort)?.type;
    if (portTypeMismatch(value, targetType)) {
      return {
        inputs,
        mismatch: `${edge.source}.${edge.sourcePort} (${value.type}) is wired to ${edge.targetPort} (${targetType})`,
      };
    }
    inputs[edge.targetPort] = value;
  }
  return { inputs };
}

// "12 rows; rows 4 and 7 failed", as a zone's End reports its items.
function itemsLine(word: string, total: number, failed: readonly number[]): string {
  const noun = (count: number) => `${word}${count === 1 ? "" : "s"}`;
  if (total === 0) return `No ${noun(0)}`;
  if (failed.length === 0) return `${total} ${noun(total)}`;
  const places = failed.map((index) => String(index + 1));
  const list = places.length === 1 ? places[0] : `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`;
  return `${total - failed.length} of ${total} ${noun(total)}; ${noun(failed.length)} ${list} failed`;
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
  const zoneRuns = new Map<string, ZoneRun>();
  const progress = (): RunResult => ({
    outputs,
    errors,
    needs,
    fingerprints,
    skipped,
    ...(zoneRuns.size > 0 ? { zones: zoneRuns } : {}),
  });
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

  // A zone runs as one step of the scan: its For Each waits on everything
  // its nodes take from outside the zone, then the zone settles each node it
  // owns. A For Each the run was given loops nothing, so its nodes run once
  // on the item it was given.
  const zones = new Map([...flowZones(graph)].filter(([id]) => !known?.has(id)));
  const problems = zoneProblems(graph, zones);
  const ownedBy = new Map<string, string>();
  const waitsOn = new Map<string, Set<string>>();
  for (const zone of zones.values()) {
    const owned = [...zone.members, ...(zone.end ? [zone.end] : [])];
    const outside = new Set(upstreamOf.get(zone.forEach) ?? []);
    for (const id of owned) {
      ownedBy.set(id, zone.forEach);
      for (const dep of upstreamOf.get(id) ?? []) {
        if (dep !== zone.forEach && !zone.members.has(dep) && dep !== zone.end) outside.add(dep);
      }
    }
    waitsOn.set(zone.forEach, outside);
  }
  // Each node a Table column hands its path to, asking for the column's
  // grant in place of each file's.
  const columns = new Map<string, FlowCapabilityDeclaration>();
  for (const [id, capability] of pathColumns(graph)) {
    try {
      columns.set(id, resolveFlowCapability(capability, context.flowPath));
    } catch {
      // A Table path that names nothing grants nothing; the Load Table fails.
    }
  }
  const contextFor = (id: string): NodeExecutionContext => {
    const column = columns.get(id);
    return column?.type === "readColumn" || column?.type === "writeColumn"
      ? { ...context, pathColumn: column }
      : context;
  };

  // Each node the zone owns, settled with what stopped the zone, a zone held
  // inside it included: the scan never reaches a node a zone owns.
  function settleOwned(zone: FlowZone, reason: string, seen = new Set<string>()): void {
    seen.add(zone.forEach);
    for (const id of [...zone.members, ...(zone.end ? [zone.end] : [])]) {
      if (!done.has(id)) {
        errors.set(id, reason);
        done.add(id);
      }
      const inner = zones.get(id);
      if (inner && !seen.has(id)) settleOwned(inner, reason, seen);
    }
  }

  // Every node `from` feeds, however far, left out for `cause` as a disabled
  // node's are: never run on a missing value, and not failed.
  function skipDownstream(from: string, cause: string): void {
    const pending = [from];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      for (const edge of graph.edges) {
        if (edge.source !== id || done.has(edge.target)) continue;
        skipped.set(edge.target, cause);
        done.add(edge.target);
        pending.push(edge.target);
      }
    }
  }

  async function runZone(zone: FlowZone): Promise<void> {
    const forEachId = zone.forEach;
    const forEachNode = nodesById.get(forEachId) as FlowNodeInstance;
    const fail = (reason: string) => {
      errors.set(forEachId, reason);
      done.add(forEachId);
      settleOwned(zone, `upstream node "${forEachId}" failed`);
      hooks?.onNodeFinish?.(forEachId, progress());
    };
    const problem = problems.get(forEachId) ?? missingPort(forEachNode, incoming.get(forEachId) ?? [], nodesById);
    if (problem) {
      fail(problem);
      return;
    }
    const listEdge = (incoming.get(forEachId) ?? []).find((edge) => edge.targetPort === "list");
    let items: unknown[];
    try {
      items = forEachItems(listEdge && outputs.get(listEdge.source)?.[listEdge.sourcePort]);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }

    // The zone's nodes in an order each item can run them in; one left in a
    // loop among them never becomes runnable.
    const order: string[] = [];
    const placed = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of zone.members) {
        if (placed.has(id) || done.has(id)) continue;
        if (
          [...(upstreamOf.get(id) ?? [])].some((dep) => zone.members.has(dep) && !done.has(dep) && !placed.has(dep))
        ) {
          continue;
        }
        order.push(id);
        placed.add(id);
        grew = true;
      }
    }
    const listSource = listEdge && nodesById.get(listEdge.source);
    const word: "Row" | "Item" = listSource?.type === "loadTableRows" ? "Row" : "Item";
    const run: ZoneRun = { items: Array.from({ length: items.length }, () => undefined), stopped: false };
    zoneRuns.set(forEachId, run);
    hooks?.onNodeStart?.(forEachId);

    const valueIn = (item: ItemRun, edge: FlowEdgeInstance) =>
      (zone.members.has(edge.source) || edge.source === forEachId ? item.outputs.get(edge.source) : undefined)?.[
        edge.sourcePort
      ] ?? outputs.get(edge.source)?.[edge.sourcePort];

    // One item through the zone's nodes. True when a Generate node ran for
    // it rather than being answered from memory.
    async function runItem(index: number): Promise<boolean> {
      const item: ItemRun = { outputs: new Map(), errors: new Map(), fingerprints: new Map(), done: false };
      run.items[index] = item;
      item.outputs.set(forEachId, {
        item: { type: "object", value: items[index] },
        index: { type: "number", value: index + 1 },
      });
      // A node's own failure shows on it, named by its row; one that only
      // follows a failure upstream drops the item without saying so twice.
      const failed = (id: string, reason: string, shown: boolean) => {
        item.errors.set(id, reason);
        if (shown && !errors.has(id)) errors.set(id, `${word} ${index + 1}: ${reason}`);
      };
      let generated = false;
      for (const id of order) {
        const node = nodesById.get(id) as FlowNodeInstance;
        if (context.signal?.aborted) {
          failed(id, stoppedReason(context.signal), false);
          continue;
        }
        const failedUpstream = [...(upstreamOf.get(id) ?? [])].find((dep) => item.errors.has(dep));
        if (failedUpstream) {
          failed(id, `upstream node "${failedUpstream}" failed`, false);
          continue;
        }
        const executor = executorOf(node.type);
        const edges = incoming.get(id) ?? [];
        const unrunnable = executor ? missingPort(node, edges, nodesById) : `unknown node type "${node.type}"`;
        const gathered = unrunnable ? undefined : gatherInputs(node, edges, (edge) => valueIn(item, edge));
        if (!executor || !gathered || gathered.mismatch) {
          failed(id, unrunnable ?? `edge type mismatch: ${gathered?.mismatch}`, true);
          hooks?.onNodeFinish?.(id, progress(), index);
          continue;
        }
        const { inputs } = gathered;
        const definition = FLOW_NODE_REGISTRY[node.type];
        const readsContext = definition?.contextPort !== undefined && inputs[definition.contextPort] !== undefined;
        const fingerprint =
          recall && definition?.reuse === "optional" && !readsContext ? fingerprintOf(node, inputs) : undefined;
        const held = fingerprint && node.config.reuse === "true" ? recall?.(id, fingerprint) : undefined;
        if (held && fingerprint) {
          item.outputs.set(id, held);
          item.fingerprints.set(id, fingerprint);
          outputs.set(id, held);
          fingerprints.set(id, fingerprint);
          context.report?.(id, [HELD]);
          hooks?.onNodeFinish?.(id, progress(), index);
          continue;
        }
        hooks?.onNodeStart?.(id, index);
        try {
          const result = await executor(node, inputs, contextFor(id), wired.get(id) ?? new Set());
          item.outputs.set(id, result);
          outputs.set(id, result);
          if (fingerprint) {
            item.fingerprints.set(id, fingerprint);
            fingerprints.set(id, fingerprint);
          }
          if (definition?.category === "AI") generated = true;
        } catch (error) {
          if (context.signal?.aborted) failed(id, stoppedReason(context.signal), false);
          else {
            failed(id, error instanceof Error ? error.message : String(error), true);
            const need = setupNeedOf(error);
            if (need && !needs.has(id)) needs.set(id, need);
          }
        } finally {
          hooks?.onNodeFinish?.(id, progress(), index);
        }
      }
      item.done = true;
      return generated;
    }

    // Rows go one at a time until one generates, then the person sees it
    // before the rest start; without a Generate node they go side by side
    // from the first. With no one to ask, the rest go on.
    let next = 0;
    const generates = order.some((id) => FLOW_NODE_REGISTRY[nodesById.get(id)?.type ?? ""]?.category === "AI");
    if (generates) {
      let generated = false;
      while (!generated && next < items.length && !context.signal?.aborted) generated = await runItem(next++);
      if (generated && next < items.length && !context.signal?.aborted && context.confirmRest) {
        const ask = { forEach: forEachId, done: next, rest: items.length - next, word };
        run.stopped = !(await context.confirmRest(ask));
      }
    }
    if (!run.stopped) {
      const worker = async () => {
        while (next < items.length && !context.signal?.aborted) await runItem(next++);
      };
      await Promise.all(Array.from({ length: Math.min(ITEMS_AT_ONCE, items.length - next) }, worker));
    }

    // The zone's nodes and its For Each show the last item that ran, which
    // is also what a Regenerate of one of them is given.
    const last = run.items.findLast((item) => item !== undefined);
    for (const id of order) {
      const shown = last?.outputs.get(id);
      if (shown) outputs.set(id, shown);
      const fingerprint = last?.fingerprints.get(id);
      if (fingerprint) fingerprints.set(id, fingerprint);
      if (context.signal?.aborted && !outputs.has(id) && !errors.has(id)) errors.set(id, stoppedReason(context.signal));
      done.add(id);
    }
    for (const id of zone.members) {
      if (!done.has(id)) errors.set(id, "cyclic dependency: never became runnable");
      done.add(id);
    }
    const forEachOutputs = last?.outputs.get(forEachId);
    if (forEachOutputs) outputs.set(forEachId, forEachOutputs);
    done.add(forEachId);
    if (run.stopped) context.report?.(forEachId, [`Stopped after ${word.toLowerCase()} ${next}`]);
    hooks?.onNodeFinish?.(forEachId, progress());
    settleEnd(zone, run, items.length, word);
  }

  // The End collects each finished item's values into lists, in item order.
  // A failed item gives nothing to any list, so the lists stay aligned; with
  // nothing finished it gives nothing, and what it feeds is skipped.
  function settleEnd(zone: FlowZone, run: ZoneRun, total: number, word: string): void {
    const end = zone.end;
    if (end === undefined || done.has(end)) return;
    done.add(end);
    if (context.signal?.aborted) {
      errors.set(end, stoppedReason(context.signal));
      return;
    }
    if (run.stopped) {
      skipped.set(end, zone.forEach);
      skipDownstream(end, zone.forEach);
      return;
    }
    const endNode = nodesById.get(end) as FlowNodeInstance;
    const edges = incoming.get(end) ?? [];
    const finishEnd = (reason?: string) => {
      if (reason) errors.set(end, reason);
      hooks?.onNodeFinish?.(end, progress());
    };
    const unrunnable = problems.get(end) ?? missingPort(endNode, edges, nodesById);
    if (unrunnable) {
      finishEnd(unrunnable);
      return;
    }
    const finished: number[] = [];
    const failed: number[] = [];
    run.items.forEach((item, index) => {
      if (item && item.errors.size === 0) finished.push(index);
      else if (item) failed.push(index);
    });
    const lists: Record<string, PortValue> = {};
    for (const edge of edges) {
      const slot = /^value_(\d+)$/.exec(edge.targetPort)?.[1];
      if (!slot) continue;
      const values: string[] = [];
      for (const index of finished) {
        const item = run.items[index] as ItemRun;
        const owned = zone.members.has(edge.source) || edge.source === zone.forEach;
        const value = (owned ? item.outputs.get(edge.source) : outputs.get(edge.source))?.[edge.sourcePort];
        if (value && value.type !== "text") {
          finishEnd(
            `edge type mismatch: ${edge.source}.${edge.sourcePort} (${value.type}) is wired to ${edge.targetPort} (text)`,
          );
          return;
        }
        values.push(value?.type === "text" ? value.value : "");
      }
      lists[forEachEndListPort(Number(slot))] = { type: "object", value: values };
    }
    context.report?.(end, [itemsLine(word.toLowerCase(), total, failed)]);
    if (finished.length === 0) {
      skipDownstream(end, end);
      finishEnd();
      return;
    }
    outputs.set(end, lists);
    finishEnd();
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    // A failed lead ends the run with nothing else started, so no node is
    // reported failed for a node it doesn't take a wire from.
    if (leads !== undefined && errors.has(leads)) break;
    for (const node of graph.nodes) {
      if (done.has(node.id) || ownedBy.has(node.id)) continue;
      const waits = leads !== undefined && node.id !== leads && !feedsLead.has(node.id);
      if (waits && (!done.has(leads) || errors.has(leads))) continue;
      const zone = zones.get(node.id);
      const deps = zone ? (waitsOn.get(node.id) ?? new Set<string>()) : (upstreamOf.get(node.id) ?? new Set<string>());
      if ([...deps].some((depId) => !done.has(depId))) continue; // still waiting on an upstream node

      progressed = true;
      // A stopped run starts nothing further. Each remaining node fails with
      // the reason rather than reading as "upstream failed", which would
      // point at a node that never went wrong.
      if (context.signal?.aborted) {
        errors.set(node.id, stoppedReason(context.signal));
        done.add(node.id);
        if (zone) settleOwned(zone, stoppedReason(context.signal));
        continue;
      }
      const failedUpstream = [...deps].find((depId) => errors.has(depId));
      if (failedUpstream) {
        errors.set(node.id, `upstream node "${failedUpstream}" failed`);
        done.add(node.id);
        if (zone) settleOwned(zone, `upstream node "${node.id}" failed`);
        continue;
      }
      if (zone) {
        await runZone(zone);
        continue;
      }

      const problem = problems.get(node.id);
      const executor = executorOf(node.type);
      if (problem || !executor) {
        errors.set(node.id, problem ?? `unknown node type "${node.type}"`);
        done.add(node.id);
        continue;
      }

      const missing = missingPort(node, incoming.get(node.id) ?? [], nodesById);
      if (missing) {
        errors.set(node.id, missing);
        done.add(node.id);
        continue;
      }

      const { inputs, mismatch } = gatherInputs(
        node,
        incoming.get(node.id) ?? [],
        (edge) => outputs.get(edge.source)?.[edge.sourcePort],
      );
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
        hooks?.onNodeFinish?.(node.id, progress());
        done.add(node.id);
        continue;
      }

      hooks?.onNodeStart?.(node.id);
      try {
        outputs.set(node.id, await executor(node, inputs, contextFor(node.id), wired.get(node.id) ?? new Set()));
        if (fingerprint) fingerprints.set(node.id, fingerprint);
      } catch (error) {
        if (context.signal?.aborted) errors.set(node.id, stoppedReason(context.signal));
        else {
          errors.set(node.id, error instanceof Error ? error.message : String(error));
          const need = setupNeedOf(error);
          if (need) needs.set(node.id, need);
        }
      } finally {
        hooks?.onNodeFinish?.(node.id, progress());
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

  return { outputs, errors, needs, fingerprints, skipped, ...(zoneRuns.size > 0 ? { zones: zoneRuns } : {}) };
}
