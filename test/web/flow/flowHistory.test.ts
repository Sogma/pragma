// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { createFlowHistory, planRestore } from "../../../web/flow/flowHistory.ts";

const PATH = "flows/a.flow.html";

function node(id: string, config: Record<string, unknown> = {}, x = 0): FlowNodeInstance {
  return { id, type: "joinText", position: { x, y: 0 }, config };
}

function wire(source: string, target: string, targetPort = "text_1"): FlowEdgeInstance {
  return { id: `e-${source}-${target}-${targetPort}`, source, sourcePort: "text", target, targetPort };
}

// The live graph is edited in place, as the canvas edits it.
function setup(graph: FlowGraph) {
  const root = document.createElement("div");
  const history = createFlowHistory(root);
  history.opened(PATH, graph);
  const press = () => root.dispatchEvent(new Event("pointerdown"));
  const type = (target: FlowNodeInstance, key: string, value: string) => {
    root.dispatchEvent(new Event("keydown"));
    target.config[key] = value;
    history.changed(graph);
  };
  return { history, press, type };
}

describe("flowHistory steps", () => {
  it("makes a drag's many changes one step", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    press();
    for (const x of [10, 20, 30]) {
      graph.nodes[0].position = { x, y: 0 };
      history.changed(graph);
    }
    expect(history.undo()?.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(history.canUndo()).toBe(false);
    expect(history.redo()?.nodes[0].position).toEqual({ x: 30, y: 0 });
  });

  it("keeps typing in one field one step until a pointer press or another field", () => {
    const [a, b] = [node("a", { text_1: "" }), node("b", { text_1: "" })];
    const graph: FlowGraph = { nodes: [a, b], edges: [] };
    const { history, press, type } = setup(graph);
    type(a, "text_1", "h");
    type(a, "text_1", "hi");
    press();
    type(a, "text_1", "hi!");
    type(b, "text_1", "x");
    expect(history.undo()?.nodes.map((n) => n.config.text_1)).toEqual(["hi!", ""]);
    expect(history.undo()?.nodes.map((n) => n.config.text_1)).toEqual(["hi", ""]);
    expect(history.undo()?.nodes.map((n) => n.config.text_1)).toEqual(["", ""]);
    expect(history.canUndo()).toBe(false);
  });

  // A card fills in the pick of a Table dropped on it once the Table loads.
  it("folds a change no action began into the step before it", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    graph.nodes[0].config.selectedValue = "filled in as it opened";
    history.changed(graph);
    expect(history.canUndo()).toBe(false);

    press();
    graph.nodes[0].config.tablePath = "t.table.html";
    history.changed(graph);
    graph.nodes[0].config.selectedValue = "first row";
    history.changed(graph);
    expect(history.undo()?.nodes[0].config).toEqual({ selectedValue: "filled in as it opened" });
    expect(history.canUndo()).toBe(false);
  });

  it("records no step for where the canvas looks or which mode it shows", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.viewport = { x: 40, y: 40, zoom: 2 };
    graph.appModeActive = true;
    history.changed(graph);
    expect(history.canUndo()).toBe(false);
  });

  it("drops a step its own later changes took back", () => {
    const a = node("a", { text_1: "" });
    const graph: FlowGraph = { nodes: [a], edges: [] };
    const { history, type } = setup(graph);
    type(a, "text_1", "x");
    type(a, "text_1", "");
    expect(history.canUndo()).toBe(false);
    type(a, "text_1", "y");
    expect(history.undo()?.nodes[0].config.text_1).toBe("");
  });

  // Blank and absent show alike, unless the field has a default.
  it("drops a step that typed into an empty field and emptied it, unless the field has a default", () => {
    const a = node("a");
    const graph: FlowGraph = { nodes: [a], edges: [] };
    const { history, type } = setup(graph);
    type(a, "text_1", "x");
    type(a, "text_1", "");
    expect(history.canUndo()).toBe(false);

    type(a, "separator", "x");
    type(a, "separator", "");
    expect(history.undo()?.nodes[0].config).toEqual({ text_1: "" });
  });

  it("drops what Redo had once a new step opens", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.nodes[0].label = "First";
    history.changed(graph);
    history.undo();
    expect(history.canRedo()).toBe(true);
    press();
    graph.nodes[0].label = "Second";
    history.changed(graph);
    expect(history.canRedo()).toBe(false);
  });

  it("keeps a run's settled change through an Undo of the step after it", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    graph.nodes[0].config.seed = "7";
    history.settled(graph);
    press();
    graph.nodes[0].label = "Renamed";
    history.changed(graph);
    expect(history.undo()?.nodes[0]).toEqual(node("a", { seed: "7" }));
    expect(history.canUndo()).toBe(false);
  });

  it("keeps the last hundred steps", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    for (let x = 1; x <= 101; x++) {
      press();
      graph.nodes[0].position = { x, y: 0 };
      history.changed(graph);
    }
    let undone = 0;
    while (history.undo()) undone++;
    expect(undone).toBe(100);
  });
});

describe("flowHistory and an Applet's frame", () => {
  const applet = (appletPath: string, state: unknown): FlowNodeInstance => ({
    id: "applet-1",
    type: "applet",
    position: { x: 0, y: 0 },
    config: { appletPath, state },
  });

  it("records no step for what a frame writes, and never takes it back", () => {
    const graph: FlowGraph = { nodes: [node("a"), applet("a.applet.html", { n: 1 })], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.nodes[0].position = { x: 50, y: 0 };
    history.changed(graph);
    press();
    graph.nodes[1].config.state = { n: 2 };
    history.changed(graph);
    const undone = history.undo();
    expect(undone?.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(undone?.nodes[1].config.state).toEqual({ n: 2 });
    expect(history.canUndo()).toBe(false);
  });

  it("brings an Applet node's frame values back with the node", () => {
    const graph: FlowGraph = { nodes: [applet("a.applet.html", { n: 1 })], edges: [] };
    const { history, press } = setup(graph);
    graph.nodes[0].config.state = { n: 2 };
    history.changed(graph);
    press();
    graph.nodes = [];
    history.changed(graph);
    expect(history.undo()?.nodes[0].config.state).toEqual({ n: 2 });
  });

  it("gives an Applet back its own frame values when a drop of another is undone", () => {
    const graph: FlowGraph = { nodes: [applet("first.applet.html", { first: true })], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.nodes[0].config = { appletPath: "second.applet.html" };
    history.changed(graph);
    graph.nodes[0].config.state = { second: true };
    history.changed(graph);
    expect(history.undo()?.nodes[0].config).toEqual({ appletPath: "first.applet.html", state: { first: true } });
  });
});

describe("flowHistory across opens", () => {
  // A Flow read back from its file lists its keys in another order.
  it("carries on when the Flow reopens as it last recorded it, and starts over when it doesn't", () => {
    const graph: FlowGraph = { nodes: [node("a", { text_1: "x", text_2: "y" })], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.nodes[0].label = "Renamed";
    history.changed(graph);

    history.opened("flows/other.flow.html", { nodes: [], edges: [] });
    expect(history.canUndo()).toBe(false);
    const reread: FlowGraph = {
      edges: [],
      nodes: [
        { config: { text_2: "y", text_1: "x" }, label: "Renamed", position: { y: 0, x: 0 }, type: "joinText", id: "a" },
      ],
    };
    history.opened(PATH, reread);
    expect(history.canUndo()).toBe(true);

    history.opened(PATH, { nodes: [node("a", { text_1: "edited elsewhere" })], edges: [] });
    expect(history.canUndo()).toBe(false);
  });

  it("forgets the least recently opened Flow past ten", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    press();
    graph.nodes[0].label = "Renamed";
    history.changed(graph);
    for (let i = 0; i < 10; i++) history.opened(`flows/other-${i}.flow.html`, { nodes: [], edges: [] });
    history.opened(PATH, graph);
    expect(history.canUndo()).toBe(false);
  });

  it("records nothing once closed", () => {
    const graph: FlowGraph = { nodes: [node("a")], edges: [] };
    const { history, press } = setup(graph);
    history.closed();
    press();
    graph.nodes[0].label = "Renamed";
    history.changed(graph);
    expect(history.canUndo()).toBe(false);
  });
});

describe("planRestore", () => {
  it("keeps a node that only moved, rebuilds a changed or new one, and lists the rest", () => {
    const live: FlowGraph = {
      nodes: [node("moved"), node("changed", { text_1: "now" }), node("gone"), node("rewired")],
      edges: [wire("gone", "rewired")],
    };
    const target = {
      nodes: [node("moved", {}, 50), node("changed", { text_1: "before" }), node("rewired"), node("new")],
      edges: [wire("moved", "rewired", "text_2")],
    };
    const plan = planRestore(live, target);
    expect(plan.nodes.map((n) => n.id)).toEqual(["moved", "changed", "rewired", "new"]);
    expect(plan.nodes[0]).toBe(live.nodes[0]);
    expect(plan.nodes[2]).toBe(live.nodes[3]);
    expect(plan.nodes[1]).toBe(target.nodes[1]);
    expect(plan.moved).toEqual([{ id: "moved", position: { x: 50, y: 0 } }]);
    expect(plan.rebuilt).toEqual(["changed", "new"]);
    expect(plan.removed).toEqual(["gone"]);
    expect(plan.rewired).toEqual(["moved", "rewired"]);
  });

  it("keeps an Applet node whose frame values alone differ", () => {
    const live: FlowGraph = {
      nodes: [{ id: "applet-1", type: "applet", position: { x: 0, y: 0 }, config: { appletPath: "a", state: 2 } }],
      edges: [],
    };
    const target = {
      nodes: [{ id: "applet-1", type: "applet", position: { x: 0, y: 0 }, config: { appletPath: "a", state: 1 } }],
      edges: [],
    };
    const plan = planRestore(live, target);
    expect(plan.nodes[0]).toBe(live.nodes[0]);
    expect(plan.rebuilt).toEqual([]);
  });

  // A card draws the pin for a wire its node lacks only as it is built.
  it("rebuilds a kept node a wire into a pin it lacks comes back to", () => {
    const live: FlowGraph = { nodes: [node("a"), node("b")], edges: [] };
    const target = { nodes: [node("a"), node("b")], edges: [wire("a", "b", "no_such_pin")] };
    const plan = planRestore(live, target);
    expect(plan.rebuilt).toEqual(["b"]);
    expect(plan.rewired).toEqual(["a"]);
  });
});
