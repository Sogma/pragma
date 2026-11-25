// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSetupNeed } from "../../../src/protocol/setupNeed.ts";
import { createFlowContext } from "../../../web/flow/browserEnvironment.ts";

const unrecorded = { log: () => {}, warned: () => {} };

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("the browser's flow environment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The route answers once the job is recorded; the run waits on the job
  // through the window's jobs feed, holding no request for the clip.
  it("starts a clip, then waits on its job through the jobs feed", async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/sandbox/generate-video")) return json({ job: "j1", resumed: false });
      if (url.startsWith("/api/jobs/shown")) return new Response(null, { status: 204 });
      polls++;
      const base = { id: "j1", model: "test/m", summary: "s", folder: "clips", startedAt: 1 };
      return json({
        jobs: [
          polls < 2
            ? { ...base, stage: "running" }
            : {
                ...base,
                stage: "saved",
                result: "clips/video-a.mp4",
                warnings: ["duration: asked for 7, used 8"],
                quote: { amount: 2, unit: "credits" },
              },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const { sandbox } = createFlowContext({
        flowPath: "f.flow.html",
        pickedImages: new Map(),
        ensureCapability: async () => true,
        beginLlmActivity: () => {},
        endLlmActivity: () => {},
        generations: unrecorded,
      });
      const result = sandbox.generateVideo("flow", "f.flow.html", { folder: "clips", prompt: "a cup" });
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(result).resolves.toEqual({
        path: "clips/video-a.mp4",
        model: "test/m",
        reused: false,
        resumed: false,
        warnings: ["duration: asked for 7, used 8"],
        quote: { amount: 2, unit: "credits" },
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/jobs?path=f.flow.html&waiting=j1");
      // With no run to tell, the start goes without an id.
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("startId");
    } finally {
      vi.useRealTimers();
    }
  });

  // An image a provider makes as a job is waited on as a clip is, then read
  // from where the host saved it, since the node hands on its bytes.
  it("starts an image job, waits on it through the jobs feed, and reads the saved image", async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/sandbox/generate-image")) return json({ job: "i1", resumed: false });
      if (url.startsWith("/api/file/raw")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.startsWith("/api/jobs/shown")) return new Response(null, { status: 204 });
      polls++;
      const base = { id: "i1", kind: "image", model: "test/m", summary: "s", folder: "art", startedAt: 1 };
      return json({
        jobs: [
          polls < 2
            ? { ...base, stage: "running" }
            : {
                ...base,
                stage: "saved",
                file: "art/image-a.png",
                result: "art/image-a.png",
                quote: { amount: 2, unit: "credits" },
              },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const { sandbox } = createFlowContext({
        flowPath: "f.flow.html",
        pickedImages: new Map(),
        ensureCapability: async () => true,
        beginLlmActivity: () => {},
        endLlmActivity: () => {},
        generations: unrecorded,
      });
      const result = sandbox.generateImage("flow", "f.flow.html", { folder: "art", prompt: "a cup", references: [] });
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(result).resolves.toEqual({
        image: { mediaType: "image/png", data: "AQID" },
        path: "art/image-a.png",
        model: "test/m",
        reused: false,
        warnings: [],
        cost: { amount: 2, unit: "credits" },
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/file/raw?path=art%2Fimage-a.png");
    } finally {
      vi.useRealTimers();
    }
  });

  // The start is never aborted with the run: its job may be paid for by the
  // time the host answers, and its id is what lets a cancelled run cancel it.
  it("tells a run of the job it starts, as it starts and once recorded, and never aborts the start", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      url.startsWith("/api/sandbox/generate-video")
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const heard: (string | undefined)[] = [];
    const jobStarting = vi.fn((_startId: string) => (job?: string) => void heard.push(job));
    const run = new AbortController();
    const { sandbox } = createFlowContext({
      flowPath: "f.flow.html",
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      generations: unrecorded,
      signal: run.signal,
      jobStarting,
    });
    const result = sandbox.generateVideo("flow", "f.flow.html", { folder: "clips", prompt: "a cup" }, run.signal);
    expect(jobStarting).toHaveBeenCalledTimes(1);
    const [startId] = jobStarting.mock.calls[0];
    expect(startId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ startId });
    expect(heard).toEqual([]);
    run.abort(new Error("The run was cancelled"));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
    answer(new Response(JSON.stringify({ job: "j1", resumed: false }), { status: 200 }));
    await expect(result).rejects.toThrow("Stopped waiting for the clip: The run was cancelled.");
    expect(heard).toEqual(["j1"]);
  });

  // Every Flow run, from the canvas or a toolkit button, generates through
  // this port. A blank model runs on the default, which the server holds, so
  // nothing is added on the way.
  it("sends a generation as the node built it", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ reply: "ok", model: "m" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { sandbox } = createFlowContext({
      flowPath: "f.flow.html",
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      generations: unrecorded,
    });

    await sandbox.generate("flow", "f.flow.html", { instruction: "hi", values: {}, images: {} });
    await sandbox.generateOptions("flow", "f.flow.html", {
      instruction: "hi",
      numOptions: 3,
      values: {},
      images: {},
      model: "openai/gpt-5",
    });

    const [unset, options] = sentBodies(fetchMock);
    expect(unset).toEqual({ kind: "flow", path: "f.flow.html", instruction: "hi", values: {}, images: {} });
    expect(options).toMatchObject({ model: "openai/gpt-5", numOptions: 3 });
  });

  // A run's files are in the space before its listing hears of them, so
  // nothing drawn in between may call a generated picture gone.
  it("notes each write, so the space's listing isn't believed until read again", async () => {
    vi.resetModules();
    const spaceTree = await import("../../../web/core/spaceTree.ts");
    const environment = await import("../../../web/flow/browserEnvironment.ts");
    const empty = { files: [], folders: [], scopes: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(String(url).startsWith("/api/space/paths") ? empty : [])),
    );
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("stills/new.png")).toBe(true);
    const { sandbox } = environment.createFlowContext({
      flowPath: "f.flow.html",
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      generations: unrecorded,
    });
    await sandbox.write("flow", "f.flow.html", "stills/notes.md", "text");
    expect(spaceTree.listedAsGone("stills/new.png")).toBe(false);
  });

  // The views listing a written file's folder are told at once, each file
  // rooted: a written document from the Flow's own folder, a result as its
  // node's folder names it, in a library too.
  it("tells the views each file a run wrote, rooted", async () => {
    vi.resetModules();
    const spaceTree = await import("../../../web/core/spaceTree.ts");
    const environment = await import("../../../web/flow/browserEnvironment.ts");
    const told: string[][] = [];
    spaceTree.onWritten((paths) => told.push([...paths]));
    const image = { image: { mediaType: "image/png", data: "" }, model: "m", take: 1, reused: false, warnings: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { folder?: string };
        if (String(url).includes("generate-image")) return Response.json({ ...image, path: `${body.folder}/a.png` });
        return Response.json({});
      }),
    );
    const { sandbox } = environment.createFlowContext({
      flowPath: "shots/f.flow.html",
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      generations: unrecorded,
    });
    await sandbox.write("flow", "shots/f.flow.html", "notes.md", "text");
    const body = { prompt: "p", references: [] };
    await sandbox.generateImage("flow", "shots/f.flow.html", { ...body, folder: "../stills" });
    await sandbox.generateImage("flow", "shots/f.flow.html", { ...body, folder: "lib:refs/Tests" });
    await vi.waitFor(() => expect(told.flat()).toHaveLength(3));
    expect(told.flat()).toEqual(["shots/notes.md", "stills/a.png", "lib:refs/Tests/a.png"]);
  });
});

// Every browser run records a text generation through the one context, so
// the Console reads the same whichever surface started the run.
describe("a run's record of its text generations", () => {
  function recorded() {
    const generations = { log: vi.fn(), warned: vi.fn() };
    const context = createFlowContext({
      flowPath: "f.flow.html",
      pickedImages: new Map(),
      ensureCapability: async () => true,
      beginLlmActivity: () => {},
      endLlmActivity: () => {},
      generations,
    });
    return { generations, generated: context.generated };
  }

  const sent = {
    path: "/scene.md",
    files: ["/AGENTS.md"],
    searches: [],
    messages: [
      { level: "info" as const, text: "Cut /AGENTS.md to its first 8,000 characters." },
      { level: "warn" as const, text: "Left out /secret.md: it's private." },
    ],
  };

  it("logs a reply with what went as context, and hands its warnings to the run's surface", () => {
    const { generations, generated } = recorded();
    generated?.("gen-1", { failed: false, result: { reply: " Shot 1", model: "m", context: sent } });
    expect(generations.log).toHaveBeenCalledWith("gen-1", {
      failed: false,
      model: "m",
      options: [" Shot 1"],
      context: [
        "Sent as context:",
        "/AGENTS.md",
        "Cut /AGENTS.md to its first 8,000 characters.",
        "Left out /secret.md: it's private.",
      ],
      warn: true,
    });
    expect(generations.warned).toHaveBeenCalledWith("gen-1", ["Left out /secret.md: it's private."]);
  });

  it("marks no entry as a warning for what was only cut", () => {
    const { generations, generated } = recorded();
    const cut = { ...sent, messages: sent.messages.filter((message) => message.level === "info") };
    generated?.("gen-1", { failed: false, result: { reply: "ok", model: "m", context: cut } });
    expect(generations.log).toHaveBeenCalledWith("gen-1", expect.not.objectContaining({ warn: true }));
    expect(generations.warned).not.toHaveBeenCalled();
  });

  it("logs the level a generation ran at", () => {
    const { generations, generated } = recorded();
    generated?.("gen-1", { failed: false, result: { reply: "ok", model: "m", effort: "high" } });
    expect(generations.log).toHaveBeenCalledWith("gen-1", {
      failed: false,
      model: "m",
      effort: "high",
      options: ["ok"],
    });
  });

  it("logs options as they came, and warns of nothing when nothing went as context", () => {
    const { generations, generated } = recorded();
    generated?.("opts-1", { failed: false, result: { options: ["a", "b"], model: "m" } });
    expect(generations.log).toHaveBeenCalledWith("opts-1", { failed: false, model: "m", options: ["a", "b"] });
    expect(generations.warned).not.toHaveBeenCalled();
  });

  it("logs a failure's message and the setting it needs", () => {
    const { generations, generated } = recorded();
    const need = { kind: "defaultModel", output: "text" } as const;
    generated?.("gen-1", { failed: true, error: withSetupNeed(new Error("No model selected."), need) });
    expect(generations.log).toHaveBeenCalledWith("gen-1", { failed: true, message: "No model selected.", need });
  });
});
