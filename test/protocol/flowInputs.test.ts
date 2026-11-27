import { describe, expect, it } from "vitest";
import { applyRunInputs, FlowInputError, flowRunInputs, flowRunOutputs } from "../../src/protocol/flowInputs.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";

const graph: FlowGraph = {
  nodes: [
    {
      id: "join-1",
      type: "joinText",
      label: "Greeting",
      position: { x: 0, y: 0 },
      config: { text_1: "hello", separator: ", " },
      exposed: ["text_1", "text", "text_2"],
      appModeOrder: 2,
    },
    {
      id: "toggle-1",
      type: "toggleText",
      position: { x: 0, y: 0 },
      config: { true: "false" },
      exposed: ["true"],
      appModeOrder: 1,
    },
    { id: "image-1", type: "loadImage", position: { x: 0, y: 0 }, config: {}, exposed: ["imagePath"] },
    { id: "video-1", type: "loadVideo", position: { x: 0, y: 0 }, config: {}, exposed: ["videoPath"] },
    { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: {}, exposed: ["model"] },
    // Connect-only sockets are never inputs, even if a hand-edited file says so.
    { id: "gen-2", type: "generateText", position: { x: 0, y: 0 }, config: {}, exposed: ["prompt"] },
  ],
  edges: [],
};

describe("a flow's run inputs", () => {
  it("are its exposed value-holding fields, typed, in App mode order", () => {
    expect(flowRunInputs(graph)).toEqual([
      { name: "toggle-1.true", nodeId: "toggle-1", field: "true", label: "Toggle · true", type: "boolean" },
      { name: "join-1.text_1", nodeId: "join-1", field: "text_1", label: "Greeting · text_1", type: "text" },
      { name: "join-1.text_2", nodeId: "join-1", field: "text_2", label: "Greeting · text_2", type: "text" },
      { name: "image-1.imagePath", nodeId: "image-1", field: "imagePath", label: "Load Image · Image", type: "path" },
      { name: "video-1.videoPath", nodeId: "video-1", field: "videoPath", label: "Load Video · Video", type: "path" },
      { name: "gen-1.model", nodeId: "gen-1", field: "model", label: "Generate Text (AI) · model", type: "model" },
    ]);
  });

  it("list exposed output ports as outputs, never as inputs", () => {
    expect(flowRunOutputs(graph)).toEqual([
      { name: "join-1.text", nodeId: "join-1", port: "text", label: "Greeting · text" },
    ]);
  });
});

describe("applyRunInputs", () => {
  it("overrides the named fields for the run and leaves the graph it was given alone", () => {
    const applied = applyRunInputs(graph, { "join-1.text_1": "hi", "toggle-1.true": true });
    expect(applied.nodes[0].config).toEqual({ text_1: "hi", separator: ", " });
    expect(applied.nodes[1].config).toEqual({ true: "true" });
    expect(graph.nodes[0].config.text_1).toBe("hello");
    expect(graph.nodes[1].config.true).toBe("false");
  });

  it("refuses a name the flow does not take, listing the ones it does", () => {
    expect(() => applyRunInputs(graph, { "join-1.separator": "; " })).toThrow(FlowInputError);
    expect(() => applyRunInputs(graph, { "gen-2.prompt": "x" })).toThrow(/takes no input.*It takes: toggle-1\.true/);
  });

  it("refuses a value of the wrong type", () => {
    expect(() => applyRunInputs(graph, { "toggle-1.true": "yes" })).toThrow(/takes true or false/);
    expect(() => applyRunInputs(graph, { "join-1.text_1": 3 })).toThrow(/takes a string/);
  });
});

// A Prompt's text and a Choice's pick are values a person sets, so exposing
// them makes a field: an input a caller can pass, never a result.
describe("a field output", () => {
  const fields: FlowGraph = {
    nodes: [
      { id: "prompt-1", type: "prompt", label: "Description", position: { x: 0, y: 0 }, config: {}, exposed: ["text"] },
      {
        id: "choice-1",
        type: "choice",
        position: { x: 0, y: 0 },
        config: { options: "Wide\nClose-up" },
        exposed: ["text"],
      },
    ],
    edges: [],
  };

  it("is a text input, and no output", () => {
    expect(flowRunInputs(fields)).toEqual([
      { name: "prompt-1.text", nodeId: "prompt-1", field: "text", label: "Description · text", type: "text" },
      { name: "choice-1.text", nodeId: "choice-1", field: "text", label: "Choice · text", type: "text" },
    ]);
    expect(flowRunOutputs(fields)).toEqual([]);
  });

  it("sets the node's own value for the run", () => {
    const applied = applyRunInputs(fields, { "prompt-1.text": "A racing driver", "choice-1.text": "Wide" });
    expect(applied.nodes[0].config).toEqual({ text: "A racing driver" });
    expect(applied.nodes[1].config).toEqual({ options: "Wide\nClose-up", text: "Wide" });
  });
});

describe("an Int's fields", () => {
  const ints: FlowGraph = {
    nodes: [
      {
        id: "int-1",
        type: "int",
        position: { x: 0, y: 0 },
        config: { value: "3", control: "increment" },
        exposed: ["value", "control", "int"],
      },
    ],
    edges: [],
  };

  // Its output passes on the value as the run found it, so it is a result:
  // the number the run used, once the card has moved on.
  it("make its value a whole-number input and its control a text one, its output a result", () => {
    expect(flowRunInputs(ints)).toEqual([
      { name: "int-1.value", nodeId: "int-1", field: "value", label: "Int · Value", type: "integer" },
      { name: "int-1.control", nodeId: "int-1", field: "control", label: "Int · Control after run", type: "text" },
    ]);
    expect(flowRunOutputs(ints)).toEqual([{ name: "int-1.int", nodeId: "int-1", port: "int", label: "Int · int" }]);
  });

  it("take a whole number for the value, written into the run's config as text", () => {
    expect(applyRunInputs(ints, { "int-1.value": -40 }).nodes[0].config).toEqual({
      value: "-40",
      control: "increment",
    });
    for (const value of ["40", 2.5, 2 ** 53, Number.NaN]) {
      expect(() => applyRunInputs(ints, { "int-1.value": value }), String(value)).toThrow(
        'Input "int-1.value" takes a whole number.',
      );
    }
  });
});

// A node a run leaves out takes nothing and gives nothing, so a caller is
// offered neither, and a value for it is refused like any field not taken.
describe("a node a run leaves out", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: {}, exposed: ["text"], mode: "disabled" },
      { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {}, exposed: ["text"] },
      { id: "prompt-2", type: "prompt", position: { x: 0, y: 0 }, config: {}, exposed: ["text"] },
    ],
    edges: [{ id: "e", source: "prompt-1", sourcePort: "text", target: "show-1", targetPort: "text" }],
  };

  it("is no run input or result, and its node's fed node isn't either", () => {
    expect(flowRunInputs(graph).map((input) => input.name)).toEqual(["prompt-2.text"]);
    expect(flowRunOutputs(graph)).toEqual([]);
    expect(() => applyRunInputs(graph, { "prompt-1.text": "x" })).toThrow(/takes no input "prompt-1\.text"/);
  });
});

describe("a For Each zone's outputs", () => {
  it("are no results: a For Each's and its zone's nodes' have a value per item, its End's lists do not", () => {
    const zone: FlowGraph = {
      nodes: [
        { id: "each-1", type: "forEach", position: { x: 0, y: 0 }, config: {}, exposed: ["index"] },
        { id: "field-2", type: "getField", position: { x: 0, y: 0 }, config: { field1Key: "a" }, exposed: ["field_1"] },
        {
          id: "end-3",
          type: "forEachEnd",
          position: { x: 0, y: 0 },
          config: { forEach: "each-1" },
          exposed: ["list_1"],
        },
      ],
      edges: [
        { id: "e1", source: "each-1", sourcePort: "item", target: "field-2", targetPort: "object" },
        { id: "e2", source: "field-2", sourcePort: "field_1", target: "end-3", targetPort: "value_1" },
      ],
    };
    expect(flowRunOutputs(zone).map((output) => output.name)).toEqual(["end-3.list_1"]);
  });
});
