// Undo and Redo for the Flow canvas: each Flow's recorded graphs, and how
// the live graph becomes one of them.
//
// A step is what one user action changed. A pointer press, a key or a drop
// on the Flow begins an action; its first change opens a step and every
// change after it joins that step until the next action begins. So a drag's
// many saves are one step, and so is the pick a card fills in once the Table
// dropped on it has loaded.
//
// Keys typed into one field stay one step until a pointer press or another
// field takes over: the field's own Undo takes typing back in finer steps.

import { APPLET_NODE_TYPE } from "../../src/protocol/appletNode.ts";
import { canonicalize } from "../../src/protocol/canonical.ts";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import { missingPortIds } from "../../src/protocol/flowProblems.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";

// What a step covers: the graph but where the canvas looks and which mode it
// shows. An Undo never pans the canvas or leaves App mode.
export type RecordedGraph = Omit<FlowGraph, "viewport" | "appModeActive">;

// A graph as written, to restore it key for key, and canonical, to compare
// it: a Flow read back from its file lists its keys in another order.
interface Recorded {
  json: string;
  key: string;
}

// What an Applet node's frame writes into its config is the Applet's own:
// never a step, and never taken back by an Undo. It stays out of every
// recording, since each value may run to 2 MB; the last one seen per node
// and Applet comes back with the node, so undoing a drop of another Applet
// returns the first one's.
interface Frame {
  state?: unknown;
  outputs?: unknown;
}

interface Track {
  undo: Recorded[];
  redo: Recorded[];
  current: Recorded;
  frames: Map<string, Frame>;
  // An action has begun since the last change, so the next change opens a step.
  fresh: boolean;
  // The field the open step typed into, while more typing there joins it.
  typing?: string;
}

const STEP_LIMIT = 100;
// One view shows every Flow its group opens; the least recently opened
// beyond this many lose their history.
const FLOW_LIMIT = 10;

const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));
const frameKey = (node: FlowNodeInstance): string => JSON.stringify([node.id, node.config.appletPath]);

function withoutFrame(node: FlowNodeInstance): FlowNodeInstance {
  if (node.type !== APPLET_NODE_TYPE) return node;
  const { state, outputs, ...config } = node.config;
  return { ...node, config };
}

function record(graph: FlowGraph, frames: Map<string, Frame>): Recorded {
  const { viewport, appModeActive, ...rest } = graph;
  for (const node of rest.nodes) {
    if (node.type === APPLET_NODE_TYPE)
      frames.set(frameKey(node), { state: node.config.state, outputs: node.config.outputs });
  }
  const recorded = { ...rest, nodes: rest.nodes.map(withoutFrame) };
  return { json: JSON.stringify(recorded), key: canonical(recorded) };
}

function restored(recorded: Recorded, frames: Map<string, Frame>): RecordedGraph {
  const graph = JSON.parse(recorded.json) as RecordedGraph;
  for (const node of graph.nodes) {
    const frame = node.type === APPLET_NODE_TYPE ? frames.get(frameKey(node)) : undefined;
    if (frame?.state !== undefined) node.config.state = frame.state;
    if (frame?.outputs !== undefined) node.config.outputs = frame.outputs;
  }
  return graph;
}

// One config value a change typed into: the node as it was, and the value
// the key took.
interface Typed {
  field: string;
  node: FlowNodeInstance;
  key: string;
  to: unknown;
}

// The one config value `after` changed, or undefined when it changed more.
function typedChange(before: Recorded, after: Recorded): Typed | undefined {
  const from = JSON.parse(before.json) as RecordedGraph;
  const to = JSON.parse(after.json) as RecordedGraph;
  if (from.nodes.length !== to.nodes.length || canonical({ ...from, nodes: [] }) !== canonical({ ...to, nodes: [] })) {
    return undefined;
  }
  let typed: Typed | undefined;
  for (const [index, node] of from.nodes.entries()) {
    const next = to.nodes[index];
    if (canonical(node) === canonical(next)) continue;
    if (typed !== undefined || canonical({ ...node, config: {} }) !== canonical({ ...next, config: {} })) {
      return undefined;
    }
    const keys = new Set([...Object.keys(node.config), ...Object.keys(next.config)]);
    const [key, ...more] = [...keys].filter((name) => canonical(node.config[name]) !== canonical(next.config[name]));
    if (key === undefined || more.length > 0) return undefined;
    typed = { field: JSON.stringify([node.id, key]), node, key, to: next.config[key] };
  }
  return typed;
}

// Whether the open step left the graph as it found it. A field typed into
// and emptied again did, if it held nothing before: blank and absent show
// alike unless the field has a default, as Join Text's separator does.
function backWhereItBegan(before: Recorded | undefined, now: Recorded, typing: string | undefined): boolean {
  if (!before) return false;
  if (before.key === now.key) return true;
  const typed = typing === undefined ? undefined : typedChange(before, now);
  if (!typed || typed.field !== typing || typed.to !== "" || typed.node.config[typed.key] !== undefined) return false;
  const widget = FLOW_NODE_REGISTRY[typed.node.type]?.inputWidgets?.find((input) => input.portId === typed.key);
  return widget?.defaultValue === undefined;
}

export interface FlowHistory {
  // A Flow was rendered. Its history carries on when the graph is the one it
  // last recorded, as after a tab switch, and starts over otherwise.
  opened(path: string, graph: FlowGraph): void;
  closed(): void;
  // After every change to the live graph.
  changed(graph: FlowGraph): void;
  // A change no step takes back, such as a run's new seed.
  settled(graph: FlowGraph): void;
  canUndo(): boolean;
  canRedo(): boolean;
  // The graph to restore, or undefined when there is no step to take.
  undo(): RecordedGraph | undefined;
  redo(): RecordedGraph | undefined;
}

// `root` is the Flow's element, whose input begins each action.
export function createFlowHistory(root: HTMLElement): FlowHistory {
  // Least recently opened first.
  const tracks = new Map<string, Track>();
  let track: Track | undefined;

  // Capture, since a card's controls stop some of these from bubbling.
  for (const type of ["pointerdown", "keydown", "drop"]) {
    root.addEventListener(
      type,
      () => {
        if (!track) return;
        track.fresh = true;
        if (type !== "keydown") track.typing = undefined;
      },
      true,
    );
  }

  function take(from: "undo" | "redo"): RecordedGraph | undefined {
    const target = track?.[from].pop();
    if (!track || !target) return undefined;
    track[from === "undo" ? "redo" : "undo"].push(track.current);
    track.current = target;
    track.fresh = false;
    track.typing = undefined;
    return restored(target, track.frames);
  }

  return {
    opened(path, graph) {
      const kept = tracks.get(path);
      const frames = kept?.frames ?? new Map<string, Frame>();
      const now = record(graph, frames);
      tracks.delete(path);
      track =
        kept?.current.key === now.key
          ? { ...kept, current: now, fresh: false, typing: undefined }
          : { undo: [], redo: [], current: now, frames, fresh: false };
      tracks.set(path, track);
      if (tracks.size > FLOW_LIMIT) tracks.delete(tracks.keys().next().value as string);
    },
    closed() {
      track = undefined;
    },
    changed(graph) {
      if (!track) return;
      const now = record(graph, track.frames);
      if (now.key === track.current.key) return;
      const field = track.fresh ? typedChange(track.current, now)?.field : undefined;
      if (track.fresh && (field === undefined || field !== track.typing)) {
        track.undo.push(track.current);
        if (track.undo.length > STEP_LIMIT) track.undo.shift();
        track.redo = [];
        track.typing = field;
      } else if (backWhereItBegan(track.undo.at(-1), now, track.typing)) {
        track.undo.pop();
        track.typing = undefined;
      }
      track.current = now;
      track.fresh = false;
    },
    settled(graph) {
      if (!track) return;
      track.current = record(graph, track.frames);
      track.fresh = false;
    },
    canUndo: () => (track?.undo.length ?? 0) > 0,
    canRedo: () => (track?.redo.length ?? 0) > 0,
    undo: () => take("undo"),
    redo: () => take("redo"),
  };
}

/** How the live graph becomes a recorded one. A node that differs only in
 * where it sits, or in what its Applet's frame wrote, keeps its card, and
 * with it the card's run results and the frame itself; any other difference
 * builds the card again. */
export interface Restore {
  // The restored graph's nodes in recorded order, the live node where kept.
  nodes: FlowNodeInstance[];
  removed: string[];
  // New or changed, so built again.
  rebuilt: string[];
  moved: { id: string; position: { x: number; y: number } }[];
  // Kept nodes a changed wire touches: their pins and fields follow their wires.
  rewired: string[];
}

export function planRestore(live: FlowGraph, target: RecordedGraph): Restore {
  const wires = (edges: readonly FlowEdgeInstance[]) => new Map(edges.map((edge) => [canonical(edge), edge]));
  const before = wires(live.edges);
  const after = wires(target.edges);
  const touched = new Set<string>();
  for (const [from, to] of [
    [before, after],
    [after, before],
  ]) {
    for (const [key, edge] of from) if (!to.has(key)) touched.add(edge.source).add(edge.target);
  }
  // A card draws the pin for a wire its node lacks only as it is built.
  const gainsMissingPin = (kept: FlowNodeInstance, node: FlowNodeInstance) =>
    (["target", "source"] as const).some((type) => {
      const drawn = new Set(missingPortIds(kept, live.edges, type));
      return missingPortIds(node, target.edges, type).some((portId) => !drawn.has(portId));
    });
  const unplaced = (node: FlowNodeInstance) => canonical({ ...withoutFrame(node), position: undefined });

  const liveById = new Map(live.nodes.map((node) => [node.id, node]));
  const plan: Restore = { nodes: [], removed: [], rebuilt: [], moved: [], rewired: [] };
  for (const node of target.nodes) {
    const kept = liveById.get(node.id);
    liveById.delete(node.id);
    if (!kept || unplaced(kept) !== unplaced(node) || (touched.has(node.id) && gainsMissingPin(kept, node))) {
      plan.nodes.push(node);
      plan.rebuilt.push(node.id);
      continue;
    }
    plan.nodes.push(kept);
    if (kept.position.x !== node.position.x || kept.position.y !== node.position.y) {
      plan.moved.push({ id: node.id, position: node.position });
    }
    if (touched.has(node.id)) plan.rewired.push(node.id);
  }
  plan.removed = [...liveById.keys()];
  return plan;
}
