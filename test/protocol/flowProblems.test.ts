import { describe, expect, it } from "vitest";
import { flowAuthoringProblems, flowProblems, missingPortIds } from "../../src/protocol/flowProblems.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";

const at = { x: 0, y: 0 };

const graph: FlowGraph = {
  nodes: [
    { id: "load-1", type: "loadImage", position: at, config: {} },
    { id: "gen-1", type: "generateText", position: at, config: {}, label: "Writer" },
    { id: "show-1", type: "showText", position: at, config: {} },
    { id: "old-1", type: "kit", position: at, config: {} },
  ],
  edges: [
    { id: "a", source: "load-1", sourcePort: "image", target: "gen-1", targetPort: "image1" },
    { id: "b", source: "load-1", sourcePort: "image", target: "gen-1", targetPort: "image_2" },
    { id: "c", source: "gen-1", sourcePort: "reply", target: "show-1", targetPort: "text" },
    { id: "d", source: "old-1", sourcePort: "out", target: "gen-1", targetPort: "model" },
    { id: "e", source: "gone-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" },
  ],
};

describe("flowProblems", () => {
  it("names each wire into or out of a missing pin, each unknown node, and each wire to no node", () => {
    expect(flowProblems(graph)).toEqual([
      'Writer "gen-1": a wire goes into "image1", a pin it doesn\'t have.',
      'Writer "gen-1": a wire comes out of "reply", a pin it doesn\'t have.',
      '"old-1" is a kit node, a type this version of Pragma doesn\'t have.',
      'A wire names "gone-1", a node this Flow doesn\'t have.',
    ]);
  });

  it("finds nothing wrong with a graph whose every wire has its pins", () => {
    expect(flowProblems({ nodes: graph.nodes.slice(0, 3), edges: graph.edges.slice(1, 2) })).toEqual([]);
  });

  it("lists a missing pin once, however many wires name it", () => {
    const [gen] = graph.nodes.slice(1, 2);
    const fanned = [
      ...graph.edges,
      { id: "f", source: "gen-1", sourcePort: "reply", target: "load-1", targetPort: "x" },
    ];
    expect(missingPortIds(gen, fanned, "source")).toEqual(["reply"]);
    expect(missingPortIds(gen, fanned, "target")).toEqual(["image1"]);
  });
});

describe("flowAuthoringProblems", () => {
  const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id,
    type,
    position: at,
    config,
  });
  const wire = (source: string, sourcePort: string, target: string, targetPort: string): FlowEdgeInstance => ({
    id: `${source}:${sourcePort}>${target}:${targetPort}`,
    source,
    sourcePort,
    target,
    targetPort,
  });

  it("finds nothing wrong with a Flow an editor could have drawn", () => {
    expect(
      flowAuthoringProblems({
        nodes: [node("p", "prompt", { text: "hi" }), node("g", "generateText", { model: "m" }), node("s", "showText")],
        edges: [wire("p", "text", "g", "instruction"), wire("g", "text", "s", "text")],
      }),
    ).toEqual([]);
  });

  it("keeps every problem the editor reports", () => {
    expect(flowAuthoringProblems({ nodes: [node("k", "kit")], edges: [] })).toEqual([
      '"k" is a kit node, a type this version of Pragma doesn\'t have.',
    ]);
  });

  it("names a wire joining two types, and two wires into one input", () => {
    expect(
      flowAuthoringProblems({
        nodes: [node("n", "loadNote"), node("p", "prompt"), node("s", "showText")],
        edges: [wire("n", "properties", "s", "text"), wire("p", "text", "s", "text")],
      }),
    ).toEqual([
      'Show Text "s": a wire brings object into "text", which takes text; a wire joins pins of one type.',
      'Show Text "s": two wires go into "text"; an input takes one.',
    ]);
  });

  it("names a repeated node id", () => {
    expect(flowAuthoringProblems({ nodes: [node("a", "prompt"), node("a", "showText")], edges: [] })).toEqual([
      'Two nodes are "a"; a node\'s id names one node.',
    ]);
  });

  // A run reads only the keys a type declares, and a widget's fallback under
  // its port id.
  it("names a config key the type doesn't have, but not a widget's fallback", () => {
    expect(
      flowAuthoringProblems({
        nodes: [node("j", "joinText", { text_1: "x", separator: " " }), node("t", "loadRow", { table: "x" })],
        edges: [],
      }),
    ).toEqual(['Load Row "t": its config has "table", which a Load Row node doesn\'t.']);
  });

  it("names a checkbox holding anything but the text true or false", () => {
    expect(
      flowAuthoringProblems({
        nodes: [node("t", "toggleText", { true: true }), node("i", "loadImage", { optional: "true" })],
        edges: [],
      }),
    ).toEqual(['Toggle "t": "true" holds true; a checkbox holds the text "true" or "false".']);
  });

  // A number a run would read as blank, and text it would fail on.
  it("names a whole-number field holding anything but one written as text", () => {
    expect(
      flowAuthoringProblems({
        nodes: [node("a", "int", { value: 5 }), node("b", "int", { value: "1.5" }), node("c", "int", { value: "-8" })],
        edges: [],
      }),
    ).toEqual([
      'Int "a": "value" holds 5; it holds a whole number written as text, such as "42".',
      'Int "b": "value" holds "1.5"; it holds a whole number written as text, such as "42".',
    ]);
  });
});
