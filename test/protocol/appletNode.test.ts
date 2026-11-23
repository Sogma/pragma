import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAppletFile } from "../../src/protocol/appletFile.ts";
import {
  appletCodeChanged,
  appletNodeProblem,
  appletOutputsFrom,
  appletStateFrom,
} from "../../src/protocol/appletNode.ts";
import { NODE_EXECUTORS, type NodeExecutionContext } from "../../src/protocol/flowExecutors.ts";
import { nodePorts } from "../../src/protocol/flowNodes.ts";
import { runFlow } from "../../src/protocol/flowRuntime.ts";
import type { AppletManifest, AppletPorts, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";
import { tempDir } from "../support/isolation.ts";

const ports: AppletPorts = {
  inputs: [],
  outputs: [
    { id: "description", type: "text", label: "description" },
    { id: "frame", type: "image", label: "frame" },
    { id: "count", type: "number", label: "count" },
  ],
};

const manifest = (overrides: Partial<AppletManifest> = {}): AppletManifest => ({
  version: "1.0",
  ...overrides,
});

function appletNode(config: Record<string, unknown>, id = "applet-1"): FlowNodeInstance {
  return { id, type: "applet", position: { x: 0, y: 0 }, config };
}

function context(): NodeExecutionContext {
  return {
    flowPath: "shot.flow.html",
    sandbox: {
      read: vi.fn(),
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    },
    decodeImageDimensions: async () => ({ width: 1, height: 1 }),
    pickedImages: new Map(),
    ensureCapability: vi.fn(async () => true),
    beginLlmActivity: vi.fn(),
    endLlmActivity: vi.fn(),
    scopes: async () => new Set<string>(),
    clock: { year: 2026, month: 11, day: 9, hour: 14, minute: 30, second: 5, offset: 60 },
  };
}

describe("appletOutputsFrom", () => {
  it("turns each reported value into its port's value, an image from a data URL or the value itself", () => {
    expect(
      appletOutputsFrom(ports, {
        description: "Wide shot",
        frame: "data:image/png;base64,iVBORw0KGgo=",
        count: 3,
      }),
    ).toEqual({
      outputs: {
        description: { type: "text", value: "Wide shot" },
        frame: { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
        count: { type: "number", value: 3 },
      },
    });
    expect(appletOutputsFrom(ports, { frame: { mediaType: "image/webp", data: "UklG" } })).toEqual({
      outputs: { frame: { type: "image", mediaType: "image/webp", data: "UklG" } },
    });
  });

  it("refuses the whole report on a port it doesn't declare or a value of the wrong type", () => {
    expect(appletOutputsFrom(ports, { description: "ok", shot: "x" })).toEqual({
      error: 'No output port "shot" (it has description, frame, count)',
    });
    expect(appletOutputsFrom(ports, { description: 4 })).toEqual({ error: '"description" takes text' });
    expect(appletOutputsFrom(ports, { count: Number.NaN })).toEqual({ error: '"count" takes a number' });
    expect(appletOutputsFrom(ports, { frame: "https://example.com/x.png" })).toEqual({
      error: '"frame" takes an image as a base64 data URL',
    });
    expect(appletOutputsFrom(ports, { frame: { mediaType: "image/png", data: "https://img.example/x" } })).toEqual({
      error: '"frame" takes an image as a base64 data URL',
    });
    expect(appletOutputsFrom(ports, { frame: "data:image/svg+xml;base64,PHN2Zz4=" })).toEqual({
      error: '"frame" takes JPEG, PNG, GIF or WebP, not image/svg+xml',
    });
    expect(appletOutputsFrom(ports, ["x"])).toEqual({ error: "Outputs must be an object keyed by output port" });
  });

  it("refuses outputs too large for the Flow file", () => {
    expect(appletOutputsFrom(ports, { description: "x".repeat(2_000_001) })).toEqual({
      error: "Outputs are too large to save",
    });
  });
});

describe("appletStateFrom", () => {
  it("keeps plain data, as a copy", () => {
    const raw = { camera: [0, 1.5, 3], lens: 50 };
    const result = appletStateFrom(raw);
    expect(result).toEqual({ state: raw });
    expect("state" in result && result.state).not.toBe(raw);
  });

  it("refuses what isn't plain data, or is too large", () => {
    expect(appletStateFrom(() => 1)).toEqual({ error: "State must be plain data" });
    expect(appletStateFrom({ n: 1n })).toEqual({ error: "State must be plain data" });
    expect(appletStateFrom("x".repeat(2_000_001))).toEqual({ error: "State is too large to save" });
  });
});

describe("appletNodeProblem", () => {
  it("allows a capability-free Applet that takes inputs or gives outputs", () => {
    expect(appletNodeProblem(manifest({ ports }))).toBeUndefined();
    expect(appletNodeProblem(manifest())).toBeUndefined();
  });

  it("refuses an Applet that declares capabilities, or one that takes inputs and gives outputs", () => {
    expect(appletNodeProblem(manifest({ declaresCapabilities: true }))).toMatch(
      /declares capabilities.*Rebuild it as a Flow/,
    );
    expect(
      appletNodeProblem(
        manifest({ ports: { inputs: [{ id: "a", type: "text", label: "a" }], outputs: ports.outputs } }),
      ),
    ).toBe("An Applet node takes inputs or gives outputs, not both.");
  });
});

describe("appletCodeChanged", () => {
  const graph = (...nodes: FlowNodeInstance[]): FlowGraph => ({ nodes, edges: [] });

  it("is true only when an Applet node in both graphs records a different hash", () => {
    const before = graph(appletNode({ appletPath: "a.applet.html", appletHash: "h1" }));
    expect(appletCodeChanged(before, graph(appletNode({ appletPath: "a.applet.html", appletHash: "h2" })))).toBe(true);
    expect(
      appletCodeChanged(before, graph(appletNode({ appletPath: "a.applet.html", appletHash: "h1", state: { x: 1 } }))),
    ).toBe(false);
  });

  it("is false for a node first added, or one that had no hash yet", () => {
    expect(appletCodeChanged(graph(), graph(appletNode({ appletHash: "h1" })))).toBe(false);
    expect(
      appletCodeChanged(graph(appletNode({ appletPath: "a.applet.html" })), graph(appletNode({ appletHash: "h1" }))),
    ).toBe(false);
  });
});

describe("an Applet node in a run", () => {
  it("gives what it last reported, by its own ports", async () => {
    const node = appletNode({
      appletPath: "a.applet.html",
      ports,
      outputs: {
        description: { type: "text", value: "Close-up" },
        frame: { type: "text", value: "not an image" },
      },
    });
    expect(nodePorts(node)).toEqual(ports);
    expect(await NODE_EXECUTORS.applet(node, {}, context())).toEqual({
      description: { type: "text", value: "Close-up" },
    });
  });

  it("gives a saved image only when it is a raster image as base64, never a URL", async () => {
    const saved = (data: string) =>
      appletNode({
        appletPath: "a.applet.html",
        ports,
        outputs: { frame: { type: "image", mediaType: "image/png", data } },
      });
    expect(await NODE_EXECUTORS.applet(saved("iVBORw0KGgo="), {}, context())).toEqual({
      frame: { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
    });
    await expect(NODE_EXECUTORS.applet(saved("https://img.example/t?d=secret"), {}, context())).rejects.toThrow(
      "hasn't reported its outputs yet",
    );
  });

  it("fails without an Applet, or before it has reported any output", async () => {
    await expect(NODE_EXECUTORS.applet(appletNode({}), {}, context())).rejects.toThrow("Drag an Applet");
    await expect(
      NODE_EXECUTORS.applet(appletNode({ appletPath: "a.applet.html", ports }), {}, context()),
    ).rejects.toThrow("hasn't reported its outputs yet");
    expect(await NODE_EXECUTORS.applet(appletNode({ appletPath: "a.applet.html" }), {}, context())).toEqual({});
  });

  it("types its inputs by its own ports, so a value of the wrong type is refused", async () => {
    const view = appletNode({
      appletPath: "v.applet.html",
      ports: { inputs: [{ id: "caption", type: "text", label: "Caption", required: false }], outputs: [] },
    });
    const prompt: FlowNodeInstance = {
      id: "prompt-1",
      type: "prompt",
      position: { x: 0, y: 0 },
      config: { text: "hi" },
    };
    const wired = (sourcePort: string): FlowGraph => ({
      nodes: [prompt, view],
      edges: [{ id: "e", source: "prompt-1", sourcePort, target: "applet-1", targetPort: "caption" }],
    });
    expect((await runFlow(wired("text"), context())).errors.size).toBe(0);
    const stage = appletNode(
      { appletPath: "s.applet.html", ports, outputs: { count: { type: "number", value: 2 } } },
      "stage-1",
    );
    const mismatched: FlowGraph = {
      nodes: [stage, view],
      edges: [{ id: "e", source: "stage-1", sourcePort: "count", target: "applet-1", targetPort: "caption" }],
    };
    expect((await runFlow(mismatched, context())).errors.get("applet-1")).toContain("edge type mismatch");
  });
});

describe("an Applet manifest's ports", () => {
  it("are read with ids unique, types known, every input optional and each named by its id", async () => {
    const dir = tempDir("pragma-applet-ports-");
    const file = path.join(dir, "stage.applet.html");
    writeFileSync(
      file,
      `<script type="application/json" data-role="manifest">${JSON.stringify({
        ports: {
          inputs: [{ id: "caption", type: "text" }],
          outputs: [
            { id: "frame", type: "image", label: "Frame" },
            { id: "frame", type: "text" },
            { id: "", type: "text" },
            { id: "mesh", type: "geometry" },
          ],
        },
      })}</script>`,
    );
    expect((await readAppletFile(file)).manifest.ports).toEqual({
      inputs: [{ id: "caption", type: "text", label: "caption", required: false }],
      outputs: [{ id: "frame", type: "image", label: "frame" }],
    });
  });

  it("keep a port's description trimmed, and none that is blank or isn't text", async () => {
    const dir = tempDir("pragma-applet-ports-");
    const file = path.join(dir, "stage.applet.html");
    writeFileSync(
      file,
      `<script type="application/json" data-role="manifest">${JSON.stringify({
        ports: {
          inputs: [],
          outputs: [
            { id: "frame", type: "image", description: "  The camera's view. " },
            { id: "blank", type: "text", description: "  " },
            { id: "count", type: "number", description: 7 },
          ],
        },
      })}</script>`,
    );
    expect((await readAppletFile(file)).manifest.ports?.outputs).toEqual([
      { id: "frame", type: "image", label: "frame", description: "The camera's view." },
      { id: "blank", type: "text", label: "blank" },
      { id: "count", type: "number", label: "count" },
    ]);
  });

  it("draw a saved port's description, and none that isn't text", () => {
    const saved = appletNode({
      ports: {
        inputs: [],
        outputs: [
          { id: "frame", type: "image", label: "Frame", description: "The camera's view." },
          { id: "count", type: "number", label: "count", description: 7 },
        ],
      },
    });
    expect(nodePorts(saved).outputs).toEqual([
      { id: "frame", type: "image", label: "frame", description: "The camera's view." },
      { id: "count", type: "number", label: "count" },
    ]);
  });
});
