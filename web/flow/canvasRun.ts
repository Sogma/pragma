// The canvas's Run, started from the toolbar, App mode's Run item or a
// node's Regenerate. Runs go side by side, each on a snapshot of the Flow
// saved as it starts: it shows each node's result as that node finishes,
// unless a newer run has reached the node, and moves on a node's value once
// the node has run (docs/protocol.md, Execution).
//
// A cancelled run shows nothing more, and cancels the paid jobs it started.
import { upstreamGraph } from "../../src/protocol/flowActions.ts";
import { FLOW_NODE_REGISTRY, moveOnAfterRun, moveOnForRegenerate, nodesLeftOut } from "../../src/protocol/flowNodes.ts";
import { type RunHooks, runFlow } from "../../src/protocol/flowRuntime.ts";
import type { FlowCapabilityDeclaration, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";
import { cancelJob, type FlowFileResponse } from "../core/apiClient.ts";
import { formatVersionPhrase } from "../lib/dom.ts";
import type { AppMode } from "./appMode.ts";
import { createFlowContext } from "./browserEnvironment.ts";
import type { FlowHistory } from "./flowHistory.ts";
import type { FlowSaves } from "./flowSaves.ts";
import type { NodeCards } from "./nodeCard.ts";
import { createRunMemory } from "./runMemory.ts";
import type { FlowViewDeps } from "./xyflowAdapter.ts";

/** One run going, as the Tools tab lists it. */
export interface CanvasRunInfo {
  id: number;
  // Counted per Flow from 1 since the window opened.
  number: number;
  flowPath: string;
  startedAt: number;
  // The paid jobs it started, the id each of its starts went with, whether
  // one is starting, and the nodes running in it now, by label.
  jobs: readonly string[];
  starts: readonly string[];
  startingJob: boolean;
  nodes: readonly string[];
  cancel(): void;
}

export interface CanvasRunDeps
  extends Pick<FlowViewDeps, "modelLists" | "saveNow" | "modelConsole" | "spent" | "documentWritten" | "onRunsChange"> {
  // The open Flow, compared by identity once a run ends: node ids repeat
  // across Flows, so a run that ended after the view moved to another moves
  // nothing there.
  flow(): { file: FlowFileResponse } | undefined;
  locked(): boolean;
  graph(): FlowGraph;
  node(nodeId: string): FlowNodeInstance | undefined;
  nodeEls: ReadonlyMap<string, HTMLElement>;
  cards: Pick<NodeCards, "clearRunState" | "showRunResult">;
  appMode: Pick<AppMode, "clearResults" | "showResults" | "showConfig">;
  saves: Pick<FlowSaves, "compose" | "persist">;
  history: Pick<FlowHistory, "settled">;
  remountNodes(nodeIds: readonly string[]): void;
  pickedImages: Map<string, { mediaType: string; data: string; name: string }>;
  ensureCapability(capability: FlowCapabilityDeclaration): Promise<boolean>;
  // A file a run opens to the side, in the group beside the Flow's.
  openToSide(path: string): Promise<void>;
}

/** What a canvas run takes from the group the Flow is open in. */
export type CanvasRunHost = Pick<CanvasRunDeps, "openToSide">;

export interface CanvasRun {
  // With `regenerate`, that node runs alone and never from memory, moved on
  // if its type finds its own results: what feeds it comes from the last
  // run where it can, so a Generate Text upstream doesn't pay again. A node
  // no run has reached yet runs too, as the node's branch.
  run(regenerate?: string): Promise<void>;
  // A card drawn afresh glows again while a run is in its node.
  restyle(nodeId: string): void;
}

interface RunState {
  id: number;
  number: number;
  flowPath: string;
  startedAt: number;
  jobs: string[];
  starts: string[];
  starting: number;
  // How many of this run's nodes are running, by node id.
  running: Map<string, number>;
  labels: Map<string, string>;
  // The nodes it has reached, by their key in the claims.
  claimed: string[];
  controller: AbortController;
  cancelled: boolean;
}

export function createCanvasRun(deps: CanvasRunDeps): CanvasRun {
  // Each Flow's runs, for Regenerate and Reuse result on repeat. Not reset
  // when the graph clears: every tab switch renders the Flow afresh, and
  // Regenerate after a glance at another tab still needs them.
  const runMemory = createRunMemory(() => deps.modelLists.defaultOf("text"));
  const active = new Set<RunState>();
  let nextId = 1;
  const counted = new Map<string, number>();
  // By Flow and node, the runs that reached the node and may still show their
  // result there, oldest first: its card shows the last one's. A run that
  // ends drops the older ones, and a cancelled run drops itself, so an older
  // run never replaces a newer run's result. By Flow, the newest run whose
  // outputs Regenerate is given.
  const claims = new Map<string, number[]>();
  const newestRecorded = new Map<string, number>();
  const nodeKey = (flowPath: string, id: string) => `${flowPath}\n${id}`;
  const showing = (flowPath: string) => deps.flow()?.file.path === flowPath;
  const going = () => [...active].filter((run) => !run.cancelled);

  function report(): void {
    deps.onRunsChange(
      going().map((run) => ({
        id: run.id,
        number: run.number,
        flowPath: run.flowPath,
        startedAt: run.startedAt,
        jobs: [...run.jobs],
        starts: [...run.starts],
        startingJob: run.starting > 0,
        nodes: [...run.running.keys()].map((id) => run.labels.get(id) ?? id),
        cancel: () => cancel(run),
      })),
    );
  }

  // A node glows while any run of the open Flow is in it.
  function glow(id: string): void {
    const path = deps.flow()?.file.path;
    const lit = going().some((run) => run.flowPath === path && (run.running.get(id) ?? 0) > 0);
    deps.nodeEls.get(id)?.classList.toggle("running", lit);
  }

  function release(run: RunState, keep: (id: number) => boolean): void {
    for (const key of run.claimed) claims.set(key, (claims.get(key) ?? []).filter(keep));
  }

  // A job it has yet to hear of is cancelled as it hears of it.
  function cancel(run: RunState): void {
    if (run.cancelled) return;
    run.cancelled = true;
    run.controller.abort(new Error("The run was cancelled"));
    for (const job of run.jobs) void cancelJob(job).catch(() => undefined);
    release(run, (id) => id !== run.id);
    for (const id of run.running.keys()) glow(id);
    report();
  }

  // Settled, as Regenerate's seed is: Undo takes back a person's edits, not
  // what a run moved.
  function moveOnAfter(id: string): void {
    const node = deps.node(id);
    if (!node || !moveOnAfterRun(node)) return;
    deps.history.settled(deps.graph());
    deps.saves.persist();
    deps.remountNodes([id]);
    deps.appMode.showConfig([id]);
  }

  async function run(regenerate?: string): Promise<void> {
    const flow = deps.flow();
    if (!flow) return;
    // A locked flow can't run, because running writes: the pre-flight save
    // below calls deps.saveNow directly, skipping the immediate-save
    // helper's lock check, so this is that path's guard, not a duplicate.
    // Running without the save would execute what's on disk instead of
    // what App mode's inputs show.
    if (deps.locked()) {
      window.alert(`This Flow uses ${formatVersionPhrase(flow.file.version)}, so it can't be run here.`);
      return;
    }
    // Before Regenerate moves anything on: a node a run leaves out runs
    // nothing, so its seed stays as the person last saw it.
    if (regenerate && nodesLeftOut(deps.graph()).has(regenerate)) return;

    const number = (counted.get(flow.file.path) ?? 0) + 1;
    counted.set(flow.file.path, number);
    const state: RunState = {
      id: nextId++,
      number,
      flowPath: flow.file.path,
      startedAt: Date.now(),
      jobs: [],
      starts: [],
      starting: 0,
      running: new Map(),
      labels: new Map(),
      claimed: [],
      controller: new AbortController(),
      cancelled: false,
    };
    active.add(state);
    report();
    try {
      const regenerated = regenerate ? deps.node(regenerate) : undefined;
      if (regenerated && moveOnForRegenerate(regenerated)) {
        deps.history.settled(deps.graph());
        deps.remountNodes([regenerated.id]);
        deps.appMode.showConfig([regenerated.id]);
      }
      const rerun = regenerated ? [regenerated.id] : undefined;
      deps.cards.clearRunState(rerun);
      deps.appMode.clearResults(rerun);

      // Pre-flight save, awaited rather than debounced: the run has to fail
      // loudly right here if the write didn't land, rather than let the
      // server check grants against stale on-disk content while the queue
      // quietly retries.
      const content = deps.saves.compose(flow.file);
      // What was saved, so an edit made while the run goes never reaches it.
      const graph = structuredClone(deps.graph());
      const where = content === undefined ? "The notice on the canvas" : "The status bar";
      if (content === undefined || !(await deps.saveNow(flow.file.path, content))) {
        window.alert(`Couldn't save before running. ${where} says why.`);
        return;
      }
      if (state.cancelled) return;
      for (const node of graph.nodes) {
        state.labels.set(node.id, node.label || FLOW_NODE_REGISTRY[node.type]?.label || node.type);
      }

      const reports = new Map<string, string[]>();
      const name = flow.file.name || flow.file.path;
      const context = createFlowContext({
        flowPath: flow.file.path,
        pickedImages: new Map(deps.pickedImages),
        ensureCapability: deps.ensureCapability,
        beginLlmActivity: (model) => deps.modelConsole.beginLlmActivity(model),
        endLlmActivity: (model) => deps.modelConsole.endLlmActivity(model),
        report: (id, lines) => reports.set(id, lines),
        generations: {
          log: (id, outcome) => deps.modelConsole.logLlmCall(`${name} · ${state.labels.get(id) ?? id}`, outcome),
          warned: (id, warnings) => reports.set(id, [...warnings]),
        },
        spent: (_id, spend) => deps.spent(flow.file.path, spend),
        wrote: deps.documentWritten,
        openToSide: deps.openToSide,
        signal: state.controller.signal,
        jobStarting: (startId) => {
          state.starting++;
          state.starts.push(startId);
          report();
          return (job) => {
            state.starting--;
            if (job !== undefined) state.jobs.push(job);
            if (job !== undefined && state.cancelled) void cancelJob(job).catch(() => undefined);
            report();
          };
        },
      });
      const target = regenerated ? upstreamGraph(graph, regenerated.id) : graph;
      const memory = runMemory(flow.file.path, regenerated?.id);
      const known = regenerated ? memory.known() : undefined;
      // Success gets no display of its own: a node's inline fields, a
      // showText/showObject textbox, or a downstream node is the way to
      // inspect a value. A card's result box only surfaces failures.
      //
      // A node shows its result as it finishes; the run's end shows only the
      // rest, so an Applet isn't handed its inputs twice.
      const shown = new Set<string>();
      const newest = (id: string) =>
        !state.cancelled && showing(state.flowPath) && claims.get(nodeKey(state.flowPath, id))?.at(-1) === state.id;
      for (const node of target.nodes) {
        const key = nodeKey(state.flowPath, node.id);
        claims.set(key, [...(claims.get(key) ?? []), state.id]);
        state.claimed.push(key);
      }
      const hooks: RunHooks = {
        onNodeStart: (id) => {
          state.running.set(id, (state.running.get(id) ?? 0) + 1);
          glow(id);
          report();
        },
        onNodeFinish: (id, progress) => {
          const left = (state.running.get(id) ?? 1) - 1;
          if (left > 0) state.running.set(id, left);
          else state.running.delete(id);
          glow(id);
          report();
          shown.add(id);
          if (newest(id)) {
            deps.cards.showRunResult({ ...progress, reports }, [id]);
            deps.appMode.showResults(progress, [id]);
          }
          // At once, not at the run's end, so the next Run gets the next value.
          if (deps.flow() === flow && progress.outputs.has(id)) moveOnAfter(id);
        },
      };
      const ran = await runFlow(target, context, hooks, known, memory.recall);
      if (state.cancelled) return;
      if (state.id > (newestRecorded.get(state.flowPath) ?? 0)) {
        newestRecorded.set(state.flowPath, state.id);
        memory.record(ran, known);
      }
      const rest = target.nodes.map((node) => node.id).filter((id) => !shown.has(id) && newest(id));
      deps.cards.showRunResult({ ...ran, reports }, rest);
      deps.appMode.showResults(ran, rest);
      release(state, (id) => id >= state.id);
    } finally {
      active.delete(state);
      for (const id of state.running.keys()) glow(id);
      report();
    }
  }

  return { run, restyle: glow };
}
