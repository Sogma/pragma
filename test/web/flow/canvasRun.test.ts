// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import {
  cancelJob,
  type FlowFileResponse,
  sandboxGenerate,
  sandboxGenerateVideo,
} from "../../../web/core/apiClient.ts";
import { type CanvasRunDeps, type CanvasRunInfo, createCanvasRun } from "../../../web/flow/canvasRun.ts";
import { sweep } from "../../../web/lib/sweep.ts";
import type { RunAsk } from "../../../web/services/capabilityBroker.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

// Runs side by side on the canvas: each on the Flow as it was saved when it
// started, a card showing the newest run's result, a node glowing while any
// run is in it, and an Int moving on as soon as a run has used it.

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sandboxGenerate: vi.fn(),
  sandboxGenerateVideo: vi.fn(),
  cancelJob: vi.fn(async () => undefined),
  fetchJobs: vi.fn(async () => ({ jobs: [] })),
  markJobsShown: vi.fn(async () => undefined),
}));

vi.mock("../../../web/lib/sweep.ts", () => ({ sweep: vi.fn() }));

// Each model call waits for its reply, given by the test in any order.
function heldReplies() {
  const replies: ((reply: string) => void)[] = [];
  vi.mocked(sandboxGenerate).mockReset();
  vi.mocked(sandboxGenerate).mockImplementation(
    () =>
      new Promise((resolve) => {
        replies.push((reply) => resolve({ reply, model: "test/text" }));
      }),
  );
  const instructions = () => vi.mocked(sandboxGenerate).mock.calls.map((call) => call[2].instruction);
  return { replies, instructions };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
  id,
  type,
  typeVersion: "1.0",
  position: { x: 0, y: 0 },
  config,
});

function promptToText(prompt: string): FlowGraph {
  return {
    nodes: [node("prompt-1", "prompt", { text: prompt }), node("generate-2", "generateText")],
    edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "generate-2", targetPort: "prompt" }],
  };
}

function promptToVideo(): FlowGraph {
  return {
    nodes: [
      node("prompt-1", "prompt", { text: "a kite" }),
      node("video-2", "generateVideo", { outputFolderPath: "clips" }),
    ],
    edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "video-2", targetPort: "prompt" }],
  };
}

// Each video start answers once the test says so, with the job it names.
function heldStarts() {
  const answers: ((job: string) => void)[] = [];
  vi.mocked(sandboxGenerateVideo).mockReset();
  vi.mocked(sandboxGenerateVideo).mockImplementation(
    () =>
      new Promise((resolve) => {
        answers.push((job) => resolve({ job, take: 1, resumed: false }));
      }),
  );
  vi.mocked(cancelJob).mockClear();
  return answers;
}

const flowOf = (path: string, graph: FlowGraph): { file: FlowFileResponse } => ({
  file: {
    kind: "flow",
    path,
    revision: "rev-1",
    version: "1.0",
    graph,
    capabilities: [],
    grantedCapabilities: [],
    runsUnattended: false,
  },
});

function setUp(graph: FlowGraph, path = "flows/a.flow.html") {
  let flow = flowOf(path, graph);
  let shown = graph;
  const nodeEls = new Map<string, HTMLElement>();
  const draw = () => {
    nodeEls.clear();
    for (const each of shown.nodes) nodeEls.set(each.id, document.createElement("div"));
  };
  draw();
  const onRunsChange = vi.fn<(runs: readonly CanvasRunInfo[]) => void>();
  const deps = {
    modelLists: emptyModelLists(),
    saveNow: vi.fn(async () => true),
    modelConsole: { beginLlmActivity: vi.fn(), endLlmActivity: vi.fn(), logLlmCall: vi.fn() },
    spent: vi.fn(),
    documentWritten: vi.fn(),
    onRunsChange,
    flow: () => flow,
    locked: () => false,
    graph: () => shown,
    node: (id: string) => shown.nodes.find((each) => each.id === id),
    nodeEls,
    cards: { clearRunState: vi.fn(), showRunResult: vi.fn() },
    appMode: { clearResults: vi.fn(), showResults: vi.fn(), showConfig: vi.fn() },
    saves: { compose: () => "<html></html>", persist: vi.fn() },
    history: { settled: vi.fn() },
    remountNodes: vi.fn(),
    pickedImages: new Map(),
    ensureCapability: vi.fn(async () => true),
    ensureCapabilities: vi.fn(async (): Promise<RunAsk> => ({ allowed: true, asked: [] })),
    openToSide: vi.fn(async () => {}),
  } satisfies CanvasRunDeps;
  const canvasRun = createCanvasRun(deps);
  return {
    canvasRun,
    deps,
    nodeEls,
    lastRuns: () => onRunsChange.mock.calls.at(-1)?.[0] ?? [],
    // The view moving to another Flow, whose cards are drawn afresh.
    open(next: FlowGraph, nextPath: string) {
      shown = next;
      flow = flowOf(nextPath, next);
      draw();
      for (const id of nodeEls.keys()) canvasRun.restyle(id);
    },
  };
}

// What each card was shown of a node's text output, in order.
function shownReplies(showRunResult: ReturnType<typeof vi.fn>, id: string): unknown[] {
  return showRunResult.mock.calls
    .filter(([, ids]) => (ids as string[]).includes(id))
    .map(([progress]) => (progress as { outputs: Map<string, Record<string, { value: unknown }>> }).outputs.get(id))
    .filter((output) => output !== undefined)
    .map((output) => output.text?.value);
}

describe("canvasRun side by side", () => {
  it("starts a run per click while others go, each on the Flow as saved when it started", async () => {
    const { replies, instructions } = heldReplies();
    const graph = promptToText("a kite at dawn");
    const { canvasRun, lastRuns } = setUp(graph);

    const first = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    graph.nodes[0].config.text = "a kite at dusk";
    const second = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));

    expect(instructions()).toEqual(["a kite at dawn", "a kite at dusk"]);
    expect(lastRuns().map((run) => [run.number, run.flowPath, run.nodes])).toEqual([
      [1, "flows/a.flow.html", ["Generate Text (AI)"]],
      [2, "flows/a.flow.html", ["Generate Text (AI)"]],
    ]);
    replies[1]("dusk");
    replies[0]("dawn");
    await Promise.all([first, second]);
    expect(lastRuns()).toEqual([]);
  });

  it("shows a card the newest run's result, which an older run finishing later never replaces", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps } = setUp(promptToText("a kite"));
    const first = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    const second = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));

    replies[1]("newest");
    await second;
    replies[0]("oldest");
    await first;
    expect(shownReplies(deps.cards.showRunResult, "generate-2")).toEqual(["newest"]);
    expect(deps.appMode.showResults.mock.calls.some(([, ids]) => (ids as string[]).includes("generate-2"))).toBe(true);
  });

  it("keeps a node glowing while any run is in it", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, nodeEls } = setUp(promptToText("a kite"));
    const glowing = () => nodeEls.get("generate-2")?.classList.contains("running");
    const first = canvasRun.run();
    const second = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));
    expect(glowing()).toBe(true);

    replies[0]("one");
    await first;
    expect(glowing()).toBe(true);
    replies[1]("two");
    await second;
    expect(glowing()).toBe(false);
  });

  it("sweeps a Generate node as its fresh result lands, after its card shows it", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps, nodeEls } = setUp(promptToText("a kite"));
    vi.mocked(sweep).mockClear();
    const running = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    expect(sweep).not.toHaveBeenCalled();

    replies[0]("a red kite");
    await running;
    expect(vi.mocked(sweep).mock.calls).toEqual([[nodeEls.get("generate-2")]]);
    const shown = deps.cards.showRunResult.mock.calls.findIndex(([, ids]) => (ids as string[]).includes("generate-2"));
    expect(deps.cards.showRunResult.mock.invocationCallOrder[shown]).toBeLessThan(
      vi.mocked(sweep).mock.invocationCallOrder[0],
    );
  });

  it("sweeps no error, and no older run's result the card doesn't show", async () => {
    vi.mocked(sandboxGenerate).mockReset();
    vi.mocked(sandboxGenerate).mockRejectedValue(new Error("The model is busy"));
    const failing = setUp(promptToText("a kite"));
    vi.mocked(sweep).mockClear();
    await failing.canvasRun.run();
    expect(sweep).not.toHaveBeenCalled();

    const { replies, instructions } = heldReplies();
    const { canvasRun } = setUp(promptToText("a kite"));
    const older = canvasRun.run();
    const newer = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));
    replies[1]("newer");
    await newer;
    replies[0]("older");
    await older;
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("sweeps no cancelled run", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, lastRuns } = setUp(promptToText("a kite"));
    vi.mocked(sweep).mockClear();
    const running = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    lastRuns()[0].cancel();
    replies[0]("too late");
    await running;
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps no result held from the last run, nor a clip found on disk", async () => {
    const { replies, instructions } = heldReplies();
    const held = promptToText("a kite");
    held.nodes[1].config.reuse = "true";
    const repeat = setUp(held);
    vi.mocked(sweep).mockClear();
    const first = repeat.canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    replies[0]("a red kite");
    await first;
    await repeat.canvasRun.run();
    expect(instructions()).toHaveLength(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    const clip = { path: "clips/kite.mp4", model: "test/video", take: 1, resumed: false, warnings: [] };
    vi.mocked(sandboxGenerateVideo).mockReset();
    vi.mocked(sandboxGenerateVideo).mockResolvedValueOnce({ ...clip, reused: true });
    vi.mocked(sandboxGenerateVideo).mockResolvedValueOnce({ ...clip, reused: false });
    const video = setUp(promptToVideo());
    vi.mocked(sweep).mockClear();
    await video.canvasRun.run();
    expect(sweep).not.toHaveBeenCalled();
    await video.canvasRun.run();
    expect(vi.mocked(sweep).mock.calls).toEqual([[video.nodeEls.get("video-2")]]);
  });

  it("moves an Int on as soon as a run has used it, so the next run gets the next value", async () => {
    const { replies, instructions } = heldReplies();
    const graph = promptToText("a kite");
    // First, so it has run by the time the run waits on the model.
    const int = node("int-3", "int", { value: "1", control: "increment" });
    graph.nodes.unshift(int);
    const { canvasRun, deps } = setUp(graph);
    const ints = () =>
      deps.cards.showRunResult.mock.calls
        .filter(([, ids]) => (ids as string[]).includes("int-3"))
        .map(([progress]) => (progress as { outputs: Map<string, Record<string, { value: unknown }>> }).outputs)
        .map((outputs) => outputs.get("int-3")?.int?.value);

    const first = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    expect(int.config.value).toBe("2");
    const second = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));
    expect(ints()).toEqual([1, 2]);
    expect(int.config.value).toBe("3");

    replies[0]("one");
    replies[1]("two");
    await Promise.all([first, second]);
  });

  it("leaves the cards of a Flow opened meanwhile alone, and shows its run on that Flow's again", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps, nodeEls, lastRuns, open } = setUp(promptToText("a kite"));
    const first = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    // Node ids repeat across Flows: every Flow's first Prompt is prompt-1.
    open(promptToText("another Flow"), "flows/b.flow.html");
    expect(nodeEls.get("generate-2")?.classList.contains("running")).toBe(false);
    expect(lastRuns().map((run) => run.flowPath)).toEqual(["flows/a.flow.html"]);

    replies[0]("for a");
    await first;
    expect(shownReplies(deps.cards.showRunResult, "generate-2")).toEqual([]);
    expect(lastRuns()).toEqual([]);
  });
});

describe("canvasRun generations", () => {
  it("writes each to the Console under the Flow and the node, and gives the card only its warnings", async () => {
    const context = {
      path: "/flows/scene.md",
      files: ["/flows/AGENTS.md"],
      searches: ["kite"],
      messages: [{ level: "warn" as const, text: "Left out /flows/secret.md: it's private." }],
    };
    vi.mocked(sandboxGenerate).mockReset();
    vi.mocked(sandboxGenerate).mockResolvedValue({ reply: "a kite", model: "test/text", context });
    const { canvasRun, deps } = setUp(promptToText("a kite"));

    await canvasRun.run();

    expect(deps.modelConsole.logLlmCall).toHaveBeenCalledWith("flows/a.flow.html · Generate Text (AI)", {
      failed: false,
      model: "test/text",
      options: ["a kite"],
      context: [
        "Sent as context:",
        "/flows/AGENTS.md",
        'Searched for "kite".',
        "Left out /flows/secret.md: it's private.",
      ],
      warn: true,
    });
    const [outcome] = deps.cards.showRunResult.mock.calls.at(-1) ?? [];
    expect((outcome as { reports: Map<string, string[]> }).reports.get("generate-2")).toEqual([
      "Left out /flows/secret.md: it's private.",
    ]);
  });

  it("writes a failed one's error alone", async () => {
    vi.mocked(sandboxGenerate).mockReset();
    vi.mocked(sandboxGenerate).mockRejectedValue(new Error("The model refused."));
    const { canvasRun, deps } = setUp(promptToText("a kite"));

    await canvasRun.run();

    expect(deps.modelConsole.logLlmCall).toHaveBeenCalledWith("flows/a.flow.html · Generate Text (AI)", {
      failed: true,
      message: "The model refused.",
      need: undefined,
    });
  });
});

describe("canvasRun Cancel", () => {
  it("ends a run at once: it leaves the list, stops glowing, and shows nothing more", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps, nodeEls, lastRuns } = setUp(promptToText("a kite"));
    const first = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    lastRuns()[0].cancel();
    expect(lastRuns()).toEqual([]);
    expect(nodeEls.get("generate-2")?.classList.contains("running")).toBe(false);

    replies[0]("too late");
    await first;
    expect(shownReplies(deps.cards.showRunResult, "generate-2")).toEqual([]);
  });

  it("gives a node back to the run before a cancelled one", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps, lastRuns } = setUp(promptToText("a kite"));
    const older = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    const newer = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(2));
    lastRuns()[1].cancel();
    replies[1]("cancelled");
    await newer;
    replies[0]("older");
    await older;
    expect(shownReplies(deps.cards.showRunResult, "generate-2")).toEqual(["older"]);
  });

  it("leaves the nodes to an older run when cancelled before it reached them", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps, lastRuns } = setUp(promptToText("a kite"));
    const older = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));
    let saved: (ok: boolean) => void = () => {};
    deps.saveNow.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
    const newer = canvasRun.run();
    lastRuns()[1].cancel();
    saved(true);
    await newer;
    replies[0]("older");
    await older;
    expect(instructions()).toHaveLength(1);
    expect(shownReplies(deps.cards.showRunResult, "generate-2")).toEqual(["older"]);
  });

  it("tells the Tools tab the id each of its starts went with, as the start's request carries it", async () => {
    const answers = heldStarts();
    const { canvasRun, lastRuns } = setUp(promptToVideo());
    const running = canvasRun.run();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const { startId } = vi.mocked(sandboxGenerateVideo).mock.calls[0][2];
    expect(startId).toMatch(/^[0-9a-f]{32}$/);
    expect(lastRuns()[0]).toMatchObject({ starts: [startId], startingJob: true, jobs: [] });
    answers[0]("job-1");
    await vi.waitFor(() => expect(lastRuns()[0]).toMatchObject({ starts: [startId], jobs: ["job-1"] }));
    lastRuns()[0].cancel();
    await running;
  });

  it("cancels the job a cancelled run started, and one it hears of only afterwards", async () => {
    const answers = heldStarts();
    const { canvasRun, lastRuns } = setUp(promptToVideo());
    const known = canvasRun.run();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(lastRuns()[0].startingJob).toBe(true);
    answers[0]("job-1");
    await vi.waitFor(() => expect(lastRuns()[0].jobs).toEqual(["job-1"]));
    expect(lastRuns()[0].startingJob).toBe(false);
    lastRuns()[0].cancel();
    expect(cancelJob).toHaveBeenCalledWith("job-1");
    await known;

    const late = canvasRun.run();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    lastRuns()[0].cancel();
    expect(cancelJob).not.toHaveBeenCalledWith("job-2");
    answers[1]("job-2");
    await late;
    expect(cancelJob).toHaveBeenCalledWith("job-2");
  });
});

describe("canvasRun permissions", () => {
  it("asks for every grant the run will use together, before any node starts", async () => {
    const { replies, instructions } = heldReplies();
    const { canvasRun, deps } = setUp(promptToText("a kite"));

    const running = canvasRun.run();
    await vi.waitFor(() => expect(instructions()).toHaveLength(1));

    expect(deps.ensureCapabilities).toHaveBeenCalledTimes(1);
    expect(deps.ensureCapabilities).toHaveBeenCalledWith([{ type: "generateText" }]);
    expect(deps.ensureCapabilities.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandboxGenerate).mock.invocationCallOrder[0],
    );
    replies[0]("a kite, flying");
    await running;
  });

  it("runs nothing when they're refused, and marks each node whose grant was refused", async () => {
    heldReplies();
    const { canvasRun, deps } = setUp(promptToText("a kite"));
    deps.ensureCapabilities.mockResolvedValueOnce({ allowed: false, asked: ["generateText"] });

    await canvasRun.run();

    expect(sandboxGenerate).not.toHaveBeenCalled();
    const [outcome, ids] = deps.cards.showRunResult.mock.calls.at(-1) ?? [];
    expect(ids).toEqual(["generate-2"]);
    expect((outcome as { errors: Map<string, string> }).errors).toEqual(
      new Map([["generate-2", "Permission denied, so nothing ran."]]),
    );
  });
});
