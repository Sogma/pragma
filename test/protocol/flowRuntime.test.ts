import { describe, expect, it, vi } from "vitest";
import type { GenerateResponse } from "../../src/protocol/api.ts";
import type { NodeExecutionContext } from "../../src/protocol/flowExecutors.ts";
import { type Recall, runFlow } from "../../src/protocol/flowRuntime.ts";
import { SetupError } from "../../src/protocol/setupNeed.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";

function context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    flowPath: "t.flow.html",
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
    ...overrides,
  };
}

const noteThenShow: FlowGraph = {
  nodes: [
    { id: "load-1", type: "loadNote", position: { x: 0, y: 0 }, config: { notePath: "n.md" } },
    { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {} },
  ],
  edges: [{ id: "e1", source: "load-1", sourcePort: "raw", target: "show-1", targetPort: "text" }],
};

describe("a stopped run", () => {
  // The node in flight fails with the stop's reason, not whatever its
  // aborted call threw, and nothing downstream starts.
  it("fails the node in flight and every node after it with the reason", async () => {
    const stop = new AbortController();
    const read = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          stop.signal.addEventListener("abort", () => reject(new Error("socket closed")));
        }),
    );
    const running = runFlow(
      noteThenShow,
      context({
        sandbox: {
          read,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
        signal: stop.signal,
      }),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    stop.abort(new Error("the run passed its 5 min time limit"));

    const result = await running;
    expect(Object.fromEntries(result.errors)).toEqual({
      "load-1": "the run passed its 5 min time limit",
      "show-1": "the run passed its 5 min time limit",
    });
  });

  // Aborting the model call is what makes the limit bound spend, not just
  // the wait.
  it("hands the signal to a model call", async () => {
    const stop = new AbortController();
    const generate = vi.fn(async () => ({ reply: "ok", model: "m" }));
    const graph: FlowGraph = {
      nodes: [
        { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
        { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" }],
    };
    await runFlow(
      graph,
      context({
        sandbox: {
          read: vi.fn(),
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate,
          generateOptions: vi.fn(),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
        signal: stop.signal,
      }),
    );
    expect(generate).toHaveBeenCalledWith("flow", "t.flow.html", expect.any(Object), stop.signal);
  });
});

describe("a failure a setting fixes", () => {
  const promptThenGenerate: FlowGraph = {
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
      { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: {} },
      { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [
      { id: "e1", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" },
      { id: "e2", source: "gen-1", sourcePort: "text", target: "show-1", targetPort: "text" },
    ],
  };
  const failingWith = (error: Error) =>
    context({
      sandbox: {
        ...context().sandbox,
        generate: vi.fn(async () => {
          throw error;
        }),
      },
    });

  // Only the node that was refused: the one after it failed for its sake.
  it("keeps what the failed node needs beside its message", async () => {
    const need = { kind: "defaultModel", output: "text" } as const;
    const result = await runFlow(promptThenGenerate, failingWith(new SetupError("No model selected.", need)));
    expect(result.errors.get("gen-1")).toBe("No model selected.");
    expect([...result.needs]).toEqual([["gen-1", need]]);
  });

  it("names no need for any other failure", async () => {
    const result = await runFlow(promptThenGenerate, failingWith(new Error("rate limited")));
    expect(result.errors.get("gen-1")).toBe("rate limited");
    expect(result.needs.size).toBe(0);
  });
});

describe("known outputs", () => {
  // How Regenerate runs one node on its last inputs: what fed it is given,
  // not run again.
  it("takes a known node's outputs as given and runs only what's left", async () => {
    const read = vi.fn();
    const result = await runFlow(
      noteThenShow,
      context({
        sandbox: {
          read,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
      }),
      undefined,
      new Map([["load-1", { raw: { type: "text", value: "given" } }]]),
    );

    expect(read).not.toHaveBeenCalled();
    expect(result.outputs.get("show-1")).toEqual({ text: { type: "text", value: "given" } });
    expect(result.errors.size).toBe(0);
  });
});

describe("a wire naming a missing port", () => {
  const promptThenShow = (sourcePort: string, targetPort: string): FlowGraph => ({
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
      { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [{ id: "e1", source: "prompt-1", sourcePort, target: "show-1", targetPort }],
  });

  // As after a port is renamed: the saved edge still names the old id.
  it("fails the node it goes into, naming the port, rather than running it unwired", async () => {
    const into = await runFlow(promptThenShow("text", "txt"), context());
    expect(into.errors.get("show-1")).toBe('A wire goes into "txt", a port this node doesn\'t have. Disconnect it.');
    expect(into.outputs.has("show-1")).toBe(false);

    const from = await runFlow(promptThenShow("reply", "text"), context());
    expect(from.errors.get("show-1")).toBe(
      'A wire comes from "reply", a port node "prompt-1" doesn\'t have. Disconnect it.',
    );
  });
});

describe("the finish hook", () => {
  // What lets a Show Text display its value while the slower node it feeds
  // is still running.
  it("hands over a node's result while the run goes on", async () => {
    let release: (reply: GenerateResponse) => void = () => {};
    const generate = vi.fn(
      () =>
        new Promise<GenerateResponse>((resolve) => {
          release = resolve;
        }),
    );
    const graph: FlowGraph = {
      nodes: [
        { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
        { id: "show-1", type: "showText", position: { x: 0, y: 0 }, config: {} },
        { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: "e1", source: "prompt-1", sourcePort: "text", target: "show-1", targetPort: "text" },
        { id: "e2", source: "show-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" },
      ],
    };
    const finished = new Map<string, unknown>();
    const running = runFlow(
      graph,
      context({
        sandbox: {
          read: vi.fn(),
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate,
          generateOptions: vi.fn(),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
      }),
      { onNodeFinish: (id, progress) => finished.set(id, progress.outputs.get(id)) },
    );

    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    expect(finished.get("show-1")).toEqual({ text: { type: "text", value: "hi" } });
    expect(finished.has("gen-1")).toBe(false);

    release({ reply: "ok", model: "m" });
    await running;
    expect(finished.get("gen-1")).toEqual({ text: { type: "text", value: "ok" } });
  });
});

describe("holding a result", () => {
  // A Prompt feeding a Generate Text, as the canvas would run it.
  function promptToGenerate(text: string, reuse: string): FlowGraph {
    return {
      nodes: [
        { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text } },
        { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: { reuse } },
      ],
      edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "instruction" }],
    };
  }

  function generating(reply: string) {
    const generate = vi.fn(async (): Promise<GenerateResponse> => ({ reply, model: "m" }));
    const sandbox = {
      read: vi.fn(),
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate,
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    };
    return { generate, sandbox };
  }

  // What a host would remember of a first run, recalled by fingerprint.
  async function firstRun(text: string) {
    const { sandbox } = generating("first");
    const ran = await runFlow(
      promptToGenerate(text, "true"),
      context({ sandbox }),
      undefined,
      undefined,
      () => undefined,
    );
    const fingerprint = ran.fingerprints.get("gen-1");
    const outputs = ran.outputs.get("gen-1");
    return (nodeId: string, seen: string) => (nodeId === "gen-1" && seen === fingerprint ? outputs : undefined);
  }

  it("answers a held node from the host's memory when its fingerprint repeats, without running it", async () => {
    const recall = await firstRun("a");
    const { generate, sandbox } = generating("second");
    const report = vi.fn();
    const onNodeStart = vi.fn();
    const ran = await runFlow(
      promptToGenerate("a", "true"),
      context({ sandbox, report }),
      { onNodeStart },
      undefined,
      recall,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(ran.outputs.get("gen-1")).toEqual({ text: { type: "text", value: "first" } });
    expect(report).toHaveBeenCalledWith("gen-1", ["Held: its inputs and settings repeated."]);
    expect(onNodeStart).not.toHaveBeenCalledWith("gen-1");
  });

  // Config alone can't say: the Prompt's text reaches Generate Text on a wire.
  it("runs a held node again when what arrives on a wire changes", async () => {
    const recall = await firstRun("a");
    const { generate, sandbox } = generating("second");
    const ran = await runFlow(promptToGenerate("b", "true"), context({ sandbox }), undefined, undefined, recall);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(ran.outputs.get("gen-1")).toEqual({ text: { type: "text", value: "second" } });
  });

  it("runs a node with hold off, fingerprinting it all the same", async () => {
    const recall = await firstRun("a");
    const { generate, sandbox } = generating("second");
    const ran = await runFlow(promptToGenerate("a", "false"), context({ sandbox }), undefined, undefined, recall);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(ran.fingerprints.has("gen-1")).toBe(true);
  });

  // Turning Reuse result on repeat on must match the result already stored.
  it("leaves reuse out of the fingerprint", async () => {
    const fingerprintWith = async (reuse: string) =>
      (
        await runFlow(
          promptToGenerate("a", reuse),
          context({ sandbox: generating("r").sandbox }),
          undefined,
          undefined,
          () => undefined,
        )
      ).fingerprints.get("gen-1");

    expect(await fingerprintWith("true")).toBe(await fingerprintWith("false"));
  });

  // The files a context sends aren't inputs, so nothing the node receives
  // could say its reply would repeat.
  it("never holds or fingerprints a node while its context is wired", async () => {
    const graph = promptToGenerate("a", "true");
    graph.edges.push({ id: "e2", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "context" });
    const recall = vi.fn<Recall>(() => ({ text: { type: "text", value: "held" } }));
    const { generate, sandbox } = generating("fresh");

    const ran = await runFlow(graph, context({ sandbox }), undefined, undefined, recall);

    expect(recall).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ran.fingerprints.has("gen-1")).toBe(false);
    expect(ran.outputs.get("gen-1")).toEqual({ text: { type: "text", value: "fresh" } });
  });

  it("fingerprints nothing for a run with no memory, and asks only about nodes that reuse on request", async () => {
    const plain = await runFlow(promptToGenerate("a", "true"), context({ sandbox: generating("r").sandbox }));
    expect(plain.fingerprints.size).toBe(0);

    const recall = vi.fn<Recall>(() => undefined);
    await runFlow(
      promptToGenerate("a", "true"),
      context({ sandbox: generating("r").sandbox }),
      undefined,
      undefined,
      recall,
    );
    expect(recall.mock.calls.map(([nodeId]) => nodeId)).toEqual(["gen-1"]);
  });
});

describe("a disabled node", () => {
  const at = { x: 0, y: 0 };
  const wire = (source: string, sourcePort: string, target: string, targetPort: string) => ({
    id: `${source}>${target}`,
    source,
    sourcePort,
    target,
    targetPort,
  });
  const graph: FlowGraph = {
    nodes: [
      { id: "prompt-1", type: "prompt", position: at, config: { text: "hi" }, mode: "disabled" },
      { id: "show-1", type: "showText", position: at, config: {} },
      { id: "show-2", type: "showText", position: at, config: {} },
      { id: "prompt-2", type: "prompt", position: at, config: { text: "other" } },
      { id: "show-3", type: "showText", position: at, config: {} },
    ],
    edges: [
      wire("prompt-1", "text", "show-1", "text"),
      wire("show-1", "text", "show-2", "text"),
      wire("prompt-2", "text", "show-3", "text"),
    ],
  };

  it("never runs, and each node downstream of it is skipped naming it, while the rest runs", async () => {
    const started: string[] = [];
    const ran = await runFlow(graph, context(), { onNodeStart: (id) => started.push(id) });
    expect(started).toEqual(["prompt-2", "show-3"]);
    expect([...ran.outputs.keys()]).toEqual(["prompt-2", "show-3"]);
    expect(ran.errors.size).toBe(0);
    expect(ran.skipped).toEqual(
      new Map([
        ["show-1", "prompt-1"],
        ["show-2", "prompt-1"],
      ]),
    );
  });

  // A Regenerate run is given the last outputs; a node disabled since gives none.
  it("gives nothing, even when the outputs it gave last are known", async () => {
    const known = new Map([["prompt-1", { text: { type: "text" as const, value: "remembered" } }]]);
    const ran = await runFlow(graph, context(), undefined, known);
    expect(ran.outputs.has("prompt-1")).toBe(false);
    expect(ran.skipped.get("show-2")).toBe("prompt-1");
  });

  // Never run on a stand-in for the missing value, whatever the pin.
  it("skips a node it feeds on an optional pin, so nothing is paid for or written", async () => {
    const generateImage = vi.fn();
    const ran = await runFlow(
      {
        nodes: [
          { id: "prompt-1", type: "prompt", position: at, config: { text: "a fox" } },
          { id: "image-1", type: "loadImage", position: at, config: { imagePath: "fox.png" }, mode: "disabled" },
          { id: "generate-1", type: "generateImage", position: at, config: { outputFolderPath: "out" } },
        ],
        edges: [wire("prompt-1", "text", "generate-1", "prompt"), wire("image-1", "image", "generate-1", "image_1")],
      },
      context({
        sandbox: {
          read: vi.fn(),
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage,
          generateVideo: vi.fn(),
        },
      }),
    );
    expect(ran.skipped).toEqual(new Map([["generate-1", "image-1"]]));
    expect(generateImage).not.toHaveBeenCalled();
    expect(ran.outputs.has("prompt-1")).toBe(true);
  });
});
