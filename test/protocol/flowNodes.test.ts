import { describe, expect, it } from "vitest";
import {
  affixModeOf,
  blankAsDefault,
  closesLoop,
  computeFlowCapabilities,
  FLOW_NODE_REGISTRY,
  intValue,
  modelSettingValues,
  moveOnAfterRun,
  nodesLeftOut,
  stepInt,
  TEMPLATE_VARIABLES_MAX,
  wiredPathAccess,
  writeTake,
} from "../../src/protocol/flowNodes.ts";
import type { FlowGraph, FlowNodeInstance, FlowPortType } from "../../src/protocol/types.ts";
import { flowCapabilityKey, flowPortTypesCompatible } from "../../src/protocol/types.ts";

function node(overrides: Partial<FlowNodeInstance> & Pick<FlowNodeInstance, "id" | "type">): FlowNodeInstance {
  return { position: { x: 0, y: 0 }, config: {}, ...overrides };
}

// Structural checks on the registry itself — cheap to run, and they catch
// exactly the kind of drift that's easy to introduce by hand: a port added
// to `inputs` without updating `inputWidgets`, or two ports on one type
// accidentally sharing an id.
describe("FLOW_NODE_REGISTRY structural integrity", () => {
  for (const [key, definition] of Object.entries(FLOW_NODE_REGISTRY)) {
    describe(key, () => {
      it("declares its own registry key as its type", () => {
        expect(definition.type).toBe(key);
      });

      it("has non-empty label, category, and version", () => {
        expect(definition.label).toBeTruthy();
        expect(definition.category).toBeTruthy();
        expect(definition.version).toBeTruthy();
      });

      it("has unique input port ids", () => {
        const ids = definition.inputs.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("has unique output port ids", () => {
        const ids = definition.outputs.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("only declares input widgets for ports that actually exist on this type", () => {
        const inputIds = new Set(definition.inputs.map((p) => p.id));
        for (const widget of definition.inputWidgets ?? []) {
          expect(inputIds.has(widget.portId)).toBe(true);
        }
      });

      // Off its options, a new node's value would open every new node on a
      // stray unlisted entry.
      it("gives a select widget options that hold a new node's value", () => {
        for (const widget of definition.inputWidgets ?? []) {
          if (widget.type === "select") expect(widget.options).toContain(widget.defaultValue ?? "");
          else expect(widget.options).toBeUndefined();
        }
      });

      // A widget's fallback sits under its port id, so it is no config key.
      it("declares each config key once, its config fields among them, and no widget fallback", () => {
        expect(new Set(definition.configKeys).size).toBe(definition.configKeys.length);
        for (const field of definition.configFields) expect(definition.configKeys).toContain(field.key);
        for (const widget of definition.inputWidgets ?? []) expect(definition.configKeys).not.toContain(widget.portId);
      });

      // A blank select field shows its first option, so it needs one.
      it("gives a select field options, and no other field any", () => {
        for (const field of definition.configFields) {
          if (field.type === "select") expect(field.options?.length).toBeGreaterThan(0);
          else expect(field.options).toBeUndefined();
        }
      });

      it("moves on after a run only a key its config declares", () => {
        if (definition.afterRun) expect(definition.configKeys).toContain(definition.afterRun.key);
      });
    });
  }

  it("gives templateVariables exactly TEMPLATE_VARIABLES_MAX numbered variable ports plus source", () => {
    const ids = FLOW_NODE_REGISTRY.templateVariables?.inputs.map((p) => p.id) ?? [];
    expect(ids[0]).toBe("source");
    expect(ids.slice(1)).toEqual(Array.from({ length: TEMPLATE_VARIABLES_MAX }, (_, i) => `var_${i + 1}`));
  });

  // One name per pin: what the card shows is what a wire stores.
  it("names every built-in port in snake_case, and labels it by its id", () => {
    for (const definition of Object.values(FLOW_NODE_REGISTRY)) {
      for (const port of [...definition.inputs, ...definition.outputs]) {
        expect(port.id, `${definition.type}.${port.id}`).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
        expect(port.label).toBe(port.id);
      }
    }
  });

  // A type gains reuse deliberately: a reused node skips its run, so a
  // node that reads a file or has an effect must never carry the flag.
  it("lets only the AI nodes hand back their earlier results", () => {
    const reusing = Object.values(FLOW_NODE_REGISTRY)
      .filter((definition) => definition.reuse)
      .map((definition) => [definition.type, definition.reuse])
      .sort();
    expect(reusing).toEqual([
      ["generateImage", "always"],
      ["generateOptions", "optional"],
      ["generateText", "optional"],
      ["generateVideo", "always"],
    ]);
  });

  // A type that finds its own results is asked for another as a new take,
  // which it keeps in its config.
  it("gives every type that finds its own results a take Regenerate writes, and no other", () => {
    for (const definition of Object.values(FLOW_NODE_REGISTRY)) {
      expect(definition.regenerate !== undefined, definition.type).toBe(definition.reuse === "always");
      if (definition.regenerate) expect(definition.configKeys).toContain(definition.regenerate.key);
    }
  });
});

describe("modelSettingValues", () => {
  it("keeps named strings, numbers and switches, and drops anything else", () => {
    expect(modelSettingValues({ mode: "edit", cfg_scale: 0.5, generate_audio: true })).toEqual({
      mode: "edit",
      cfg_scale: 0.5,
      generate_audio: true,
    });
    expect(modelSettingValues({ deep: { a: 1 }, list: [1], "bad name": "x", nan: Number.NaN, none: null })).toEqual({});
    expect(modelSettingValues("mode")).toEqual({});
    expect(modelSettingValues(["edit"])).toEqual({});
  });
});

describe("blankAsDefault", () => {
  it("reads a blank as the preset of a select offering no blank, and leaves every other value alone", () => {
    expect(blankAsDefault("generateVideo", "duration", "")).toBe("3");
    expect(blankAsDefault("generateVideo", "resolution", "")).toBe("480p");
    expect(blankAsDefault("generateImage", "aspect_ratio", "")).toBe("1:1");
    expect(blankAsDefault("generateVideo", "duration", "7")).toBe("7");
    // A text widget's blank is a value of its own, though it has a preset.
    expect(blankAsDefault("joinText", "separator", "")).toBe("");
    expect(blankAsDefault("generateVideo", "prefix", "")).toBe("");
    expect(blankAsDefault("noSuchType", "duration", "")).toBe("");
  });
});

describe("writeTake", () => {
  const node = (type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    config,
  });

  it("writes the take a Regenerate made into a video or an image, leaving the seed", () => {
    const video = node("generateVideo");
    expect(writeTake(video, 4)).toBe(true);
    expect(video.config.take).toBe("4");
    const image = node("generateImage", { seed: "7", take: "2" });
    expect(writeTake(image, 3)).toBe(true);
    expect(image.config).toEqual({ seed: "7", take: "3" });
  });

  it("writes take 1 blank, and says when the node holds the take already", () => {
    const video = node("generateVideo", { take: "3" });
    expect(writeTake(video, 1)).toBe(true);
    expect(video.config).toEqual({});
    expect(writeTake(video, 1)).toBe(false);
    expect(writeTake(node("generateVideo", { take: "5" }), 5)).toBe(false);
  });

  it("changes nothing on a node that holds its result instead", () => {
    const held = node("generateText", { reuse: "true" });
    expect(writeTake(held, 2)).toBe(false);
    expect(held.config).toEqual({ reuse: "true" });
  });
});

describe("intValue", () => {
  it("reads a whole number written as text, and blank as 0", () => {
    expect(["", "42", "-7", "007", "-0"].map(intValue)).toEqual([0, 42, -7, 7, -0]);
    expect(intValue(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(intValue(String(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  // Rounding would hand a run a number nobody wrote.
  it("reads nothing from a fraction, other text, or a number past the safe range", () => {
    for (const text of ["1.5", "abc", "+3", " 4", "4 ", "1e3", "-", "9007199254740992", "-9007199254740992"]) {
      expect(intValue(text), text).toBeUndefined();
    }
  });

  it("steps within the safe range, held at its ends", () => {
    expect(stepInt(5, 1)).toBe(6);
    expect(stepInt(0, -1)).toBe(-1);
    expect(stepInt(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(stepInt(Number.MIN_SAFE_INTEGER, -1)).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe("moveOnAfterRun", () => {
  const int = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "int-1",
    type: "int",
    position: { x: 0, y: 0 },
    config,
  });

  it("adds 1 on increment and subtracts 1 on decrement, a blank value counting as 0", () => {
    const up = int({ value: "5", control: "increment" });
    expect(moveOnAfterRun(up)).toBe(true);
    expect(up.config.value).toBe("6");
    const down = int({ control: "decrement" });
    expect(moveOnAfterRun(down)).toBe(true);
    expect(down.config.value).toBe("-1");
  });

  it("picks a whole number from 1 to 2147483646 on randomize", () => {
    for (let i = 0; i < 20; i++) {
      const node = int({ value: "0", control: "randomize" });
      expect(moveOnAfterRun(node)).toBe(true);
      const value = Number(node.config.value);
      expect(Number.isInteger(value) && value >= 1 && value <= 2_147_483_646).toBe(true);
    }
  });

  it("leaves the value on fixed, a blank or unknown control, an unreadable value, and the safe range's end", () => {
    for (const config of [
      { value: "5", control: "fixed" },
      { value: "5" },
      { value: "5", control: "sideways" },
      { value: "1.5", control: "increment" },
      { value: String(Number.MAX_SAFE_INTEGER), control: "increment" },
    ]) {
      const node = int(config);
      expect(moveOnAfterRun(node), JSON.stringify(config)).toBe(false);
      expect(node.config).toEqual(config);
    }
  });

  it("moves nothing on a type that has no value to move", () => {
    const prompt: FlowNodeInstance = { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: {} };
    expect(moveOnAfterRun(prompt)).toBe(false);
  });
});

function graphOf(nodes: FlowNodeInstance[]): FlowGraph {
  return { nodes, edges: [] };
}

describe("computeFlowCapabilities", () => {
  // A Flow at the space root, so a bare path reads as one there.
  const capabilitiesOf = (graph: FlowGraph) => computeFlowCapabilities(graph, "story.flow.html");

  it("returns nothing for an empty graph", () => {
    expect(capabilitiesOf(graphOf([]))).toEqual([]);
  });

  it("derives a readFile capability from a loadRow node's configured tablePath", () => {
    const caps = capabilitiesOf(
      graphOf([node({ id: "n1", type: "loadRow", config: { tablePath: "writing-prompts.table.html" } })]),
    );
    expect(caps).toEqual([{ type: "readFile", path: "space:writing-prompts.table.html" }]);
  });

  it("contributes nothing for a loadRow node with no tablePath configured", () => {
    const caps = capabilitiesOf(graphOf([node({ id: "n1", type: "loadRow", config: {} })]));
    expect(caps).toEqual([]);
  });

  it("derives a readFile capability from a loadRandomRow node's configured tablePath", () => {
    const caps = capabilitiesOf(
      graphOf([node({ id: "n1", type: "loadRandomRow", config: { tablePath: "writing-prompts.table.html" } })]),
    );
    expect(caps).toEqual([{ type: "readFile", path: "space:writing-prompts.table.html" }]);
  });

  it("derives a readFile capability from a loadImage node's configured imagePath", () => {
    const caps = capabilitiesOf(
      graphOf([node({ id: "n1", type: "loadImage", config: { imagePath: "portrait.png" } })]),
    );
    expect(caps).toEqual([{ type: "readFile", path: "space:portrait.png" }]);
  });

  it("derives a readFile capability from a loadVideo node's configured videoPath, a library's included", () => {
    const caps = capabilitiesOf(
      graphOf([
        node({ id: "n1", type: "loadVideo", config: { videoPath: "shots/take.mp4" } }),
        node({ id: "n2", type: "loadVideo", config: { videoPath: "lib:footage/take.mov" } }),
        node({ id: "n3", type: "loadVideo", config: {} }),
      ]),
    );
    expect(caps.map(flowCapabilityKey)).toEqual(["readFile:space:shots/take.mp4", "readFile:lib:footage/take.mov"]);
  });

  it("derives a writeDocument capability from a writeNote node's configured notePath, and nothing without one", () => {
    expect(
      capabilitiesOf(graphOf([node({ id: "n1", type: "writeNote", config: { notePath: "notes/log.md" } })])),
    ).toEqual([{ type: "writeDocument", path: "space:notes/log.md" }]);
    expect(capabilitiesOf(graphOf([node({ id: "n1", type: "writeNote", config: {} })]))).toEqual([]);
  });

  it("derives a writeDocument capability from an addToNote node's configured notePath, and nothing without one", () => {
    expect(
      capabilitiesOf(graphOf([node({ id: "n1", type: "addToNote", config: { notePath: "notes/log.md" } })])),
    ).toEqual([{ type: "writeDocument", path: "space:notes/log.md" }]);
    expect(capabilitiesOf(graphOf([node({ id: "n1", type: "addToNote", config: {} })]))).toEqual([]);
  });

  it("derives a writeDocument capability from an addRow node's configured tablePath, and nothing without one", () => {
    expect(
      capabilitiesOf(graphOf([node({ id: "n1", type: "addRow", config: { tablePath: "log.table.html" } })])),
    ).toEqual([{ type: "writeDocument", path: "space:log.table.html" }]);
    expect(capabilitiesOf(graphOf([node({ id: "n1", type: "addRow", config: {} })]))).toEqual([]);
  });

  it("derives a readFile of the library's address when a loadImage node's imagePath names a library", () => {
    const caps = capabilitiesOf(
      graphOf([node({ id: "n1", type: "loadImage", config: { imagePath: "lib:footage/sunset.jpg" } })]),
    );
    expect(caps).toEqual([{ type: "readFile", path: "lib:footage/sunset.jpg" }]);
  });

  it("keeps a library read and a space read of the same filename on separate keys", () => {
    const caps = capabilitiesOf(
      graphOf([
        node({ id: "n1", type: "loadImage", config: { imagePath: "sunset.jpg" } }),
        node({ id: "n2", type: "loadImage", config: { imagePath: "lib:footage/sunset.jpg" } }),
      ]),
    );
    expect(caps.map(flowCapabilityKey)).toEqual(["readFile:space:sunset.jpg", "readFile:lib:footage/sunset.jpg"]);
  });

  it("derives an unconditional generate capability from a generate node, regardless of config", () => {
    const caps = capabilitiesOf(graphOf([node({ id: "n1", type: "generateText", config: {} })]));
    expect(caps).toEqual([{ type: "generateText" }]);
  });

  it("skips a node type that isn't in the registry (e.g. a stale saved type) without throwing", () => {
    expect(() =>
      capabilitiesOf(graphOf([node({ id: "n1", type: "someRemovedNodeType", config: { path: "x" } })])),
    ).not.toThrow();
    expect(capabilitiesOf(graphOf([node({ id: "n1", type: "someRemovedNodeType", config: {} })]))).toEqual([]);
  });

  it("dedupes two nodes granting the identical capability key", () => {
    const caps = capabilitiesOf(
      graphOf([
        node({ id: "n1", type: "loadRow", config: { tablePath: "a.table.html" } }),
        node({ id: "n2", type: "loadRow", config: { tablePath: "a.table.html" } }),
      ]),
    );
    expect(caps).toEqual([{ type: "readFile", path: "space:a.table.html" }]);
  });

  it("keeps distinct capabilities separate across different node types and paths", () => {
    const caps = capabilitiesOf(
      graphOf([
        node({ id: "n1", type: "loadRow", config: { tablePath: "a.table.html" } }),
        node({ id: "n2", type: "loadRow", config: { tablePath: "b.table.html" } }),
        node({ id: "n3", type: "generateText", config: {} }),
      ]),
    );
    expect(caps).toHaveLength(3);
    expect(caps).toEqual(
      expect.arrayContaining([
        { type: "readFile", path: "space:a.table.html" },
        { type: "readFile", path: "space:b.table.html" },
        { type: "generateText" },
      ]),
    );
  });

  it("resolves each path from the Flow's folder, so every spelling of one file is one key", () => {
    const caps = computeFlowCapabilities(
      graphOf([
        node({ id: "n1", type: "loadRow", config: { tablePath: "a.table.html" } }),
        node({ id: "n2", type: "loadRow", config: { tablePath: "/flows/a.table.html" } }),
        node({ id: "n3", type: "loadRow", config: { tablePath: "space:flows/a.table.html" } }),
        node({ id: "n4", type: "writeNote", config: { notePath: "../notes/my%20log.md" } }),
      ]),
      "flows/story.flow.html",
    );
    expect(caps).toEqual([
      { type: "readFile", path: "space:flows/a.table.html" },
      { type: "writeDocument", path: "space:notes/my log.md" },
    ]);
  });

  it("asks for nothing on a path that names nothing", () => {
    const caps = computeFlowCapabilities(
      graphOf([
        node({ id: "n1", type: "loadNote", config: { notePath: "../outside.md" } }),
        node({ id: "n2", type: "loadNote", config: { notePath: ".hidden/x.md" } }),
      ]),
      "story.flow.html",
    );
    expect(caps).toEqual([]);
  });
});

describe("flowPortTypesCompatible", () => {
  const types: FlowPortType[] = ["text", "image", "boolean", "object", "number"];

  it("allows every exact type-to-itself match", () => {
    for (const type of types) {
      expect(flowPortTypesCompatible(type, type)).toBe(true);
    }
  });

  // Not auto-stringified: an object reaches a text input only through an
  // explicit adapter node — see FlowPortType's doc comment.
  it("no longer allows object into a text input", () => {
    expect(flowPortTypesCompatible("object", "text")).toBe(false);
  });

  it("does not allow the reverse either: text source into an object input", () => {
    expect(flowPortTypesCompatible("text", "object")).toBe(false);
  });

  it("rejects every mismatched pairing, with no exceptions", () => {
    for (const source of types) {
      for (const target of types) {
        if (source === target) continue;
        expect(flowPortTypesCompatible(source, target)).toBe(false);
      }
    }
  });
});

describe("nodesLeftOut", () => {
  const at = { x: 0, y: 0 };
  const wire = (source: string, target: string) => ({
    id: `${source}>${target}`,
    source,
    sourcePort: "text",
    target,
    targetPort: "text",
  });
  const show = (id: string, mode?: "disabled"): FlowNodeInstance => ({
    id,
    type: "showText",
    position: at,
    config: {},
    ...(mode ? { mode } : {}),
  });

  it("is each disabled node, and every node downstream of one however far, by the disabled node", () => {
    const graph: FlowGraph = {
      nodes: [show("a", "disabled"), show("b"), show("c"), show("d"), show("e", "disabled"), show("f")],
      edges: [wire("a", "b"), wire("b", "c"), wire("d", "c"), wire("e", "f"), wire("a", "ghost")],
    };
    expect(nodesLeftOut(graph)).toEqual(
      new Map([
        ["a", "a"],
        ["e", "e"],
        ["b", "a"],
        ["f", "e"],
        ["c", "a"],
      ]),
    );
    expect(nodesLeftOut({ nodes: [show("a"), show("b")], edges: [wire("a", "b")] }).size).toBe(0);
  });

  // A node that will not run asks for nothing, wired path or not.
  it("asks for no capability and no wired path", () => {
    const write: FlowNodeInstance = { id: "w", type: "writeNote", position: at, config: { notePath: "n.md" } };
    const source: FlowNodeInstance = { id: "p", type: "prompt", position: at, config: {}, mode: "disabled" };
    const graph: FlowGraph = {
      nodes: [source, write],
      edges: [{ id: "e", source: "p", sourcePort: "text", target: "w", targetPort: "path" }],
    };
    expect(computeFlowCapabilities(graph, "f.flow.html")).toEqual([]);
    expect(wiredPathAccess(graph).size).toBe(0);
    delete source.mode;
    expect(computeFlowCapabilities(graph, "f.flow.html")).toEqual([{ type: "writeDocument", path: "space:n.md" }]);
    expect([...wiredPathAccess(graph)]).toEqual(["write"]);
  });
});

describe("closesLoop", () => {
  const wire = (source: string, target: string) => ({
    id: `${source}>${target}`,
    source,
    sourcePort: "text",
    target,
    targetPort: "text",
  });
  // a → b → c, and a → d: a chain with a branch off its start.
  const graph: FlowGraph = { nodes: [], edges: [wire("a", "b"), wire("b", "c"), wire("a", "d")] };

  it("is a wire back into a node that feeds its source, however far", () => {
    expect(closesLoop(graph, "b", "a")).toBe(true);
    expect(closesLoop(graph, "c", "a")).toBe(true);
    expect(closesLoop(graph, "c", "b")).toBe(true);
  });

  it("is a wire from a node into itself", () => {
    expect(closesLoop(graph, "b", "b")).toBe(true);
    expect(closesLoop({ nodes: [], edges: [] }, "a", "a")).toBe(true);
  });

  // Reaching one node by two routes is no loop: a run still finds an order.
  it("is no other wire", () => {
    expect(closesLoop(graph, "a", "c")).toBe(false);
    expect(closesLoop(graph, "d", "c")).toBe(false);
    expect(closesLoop(graph, "c", "d")).toBe(false);
    expect(closesLoop(graph, "c", "e")).toBe(false);
  });
});

// The run and the card read one rule, so a blank or hand-edited affixMode
// shows on the card as what the run will do.
describe("affixModeOf", () => {
  it("is the stored mode, else the type's fallback: Toggle prepends, Add to Note appends", () => {
    expect(affixModeOf(node({ id: "t", type: "toggleText" }))).toBe("prepend");
    expect(affixModeOf(node({ id: "a", type: "addToNote" }))).toBe("append");
    expect(affixModeOf(node({ id: "a", type: "addToNote", config: { affixMode: "prepend" } }))).toBe("prepend");
    expect(affixModeOf(node({ id: "t", type: "toggleText", config: { affixMode: "append" } }))).toBe("append");
    expect(affixModeOf(node({ id: "a", type: "addToNote", config: { affixMode: "suffix" } }))).toBe("append");
  });

  it("names an input each type with a menu really has", () => {
    for (const definition of Object.values(FLOW_NODE_REGISTRY)) {
      if (!definition.affix) continue;
      expect(definition.inputs.map((port) => port.id)).toContain(definition.affix.portId);
      expect(definition.configKeys).toContain("affixMode");
    }
  });
});
