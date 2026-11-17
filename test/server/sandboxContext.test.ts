import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { generationEffort } from "../../src/protocol/dispatchAction.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { runGenerate, runGenerateOptions } from "../../src/server/actionHandler.ts";
import { LOOK_REACH } from "../../src/server/contextLook.ts";
import { grantCapability } from "../../src/server/grants.ts";
import {
  declaresCapability,
  performSandboxGenerate,
  performSandboxGenerateOptions,
  readSandboxDocument,
  SandboxRequestError,
} from "../../src/server/sandbox.ts";

// The model call itself is stubbed: what's checked is which files reach it,
// and that nothing does before the scope they come from is allowed.
vi.mock("../../src/server/actionHandler.ts", () => ({
  runGenerate: vi.fn(async () => ({ reply: "Shot 1", model: "m" })),
  runGenerateOptions: vi.fn(async () => ({ options: ["a"], model: "m" })),
}));
// The level a pick runs at depends on the model, which the stub stands in for.
vi.mock("../../src/protocol/dispatchAction.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/protocol/dispatchAction.ts")>()),
  generationEffort: vi.fn(() => undefined),
}));

const SCENE = "space:projects/story/screenplay/scene.fountain";
const at = { x: 0, y: 0 };

function flow(wired: boolean): string {
  const graph: FlowGraph = {
    nodes: [
      { id: "go", type: "button", position: at, config: {} },
      { id: "gen", type: "generateText", position: at, config: {} },
    ],
    edges: wired ? [{ id: "e1", source: "go", sourcePort: "path", target: "gen", targetPort: "context" }] : [],
  };
  return serializeFlowFile({ version: "1.0", graph });
}

let space: string;
let configDir: string;

function write(relative: string, content: string): void {
  const file = path.join(space, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SandboxRequestError ? error.status : undefined;
  }
}

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-sandbox-context-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-sandbox-context-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
  write("tools/wired.flow.html", flow(true));
  write("tools/unwired.flow.html", flow(false));
  write("projects/story/AGENTS.md", "---\npragma:\n  screenplay:\n    world: world/\n---\n\n# story\n");
  write("projects/story/README.md", "# Story\n");
  write("projects/story/world/Lina.md", "# Lina\n");
  write("projects/story/screenplay/scene.fountain", "LINA\nWhere?\n");
  vi.mocked(runGenerate).mockClear();
  vi.mocked(runGenerateOptions).mockClear();
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("a generation's effort", () => {
  it("sets how far the look reaches, by the level the generation runs at", async () => {
    vi.mocked(generationEffort).mockReturnValueOnce("low");
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");

    await performSandboxGenerate(space, doc, { instruction: "Go.", context: SCENE, model: "test/m", effort: "xhigh" });

    expect(generationEffort).toHaveBeenCalledWith("test/m", "xhigh");
    const look = vi.mocked(runGenerate).mock.calls[0][3];
    expect(look?.tools.mustStop(LOOK_REACH.low.rounds - 1)).toBe(false);
    expect(look?.tools.mustStop(LOOK_REACH.low.rounds)).toBe(true);
  });

  it("refuses an effort that names no level, before any model is asked", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/unwired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    const named = { instruction: "Go.", effort: "max" as never };
    expect(await statusOf(performSandboxGenerate(space, doc, named))).toBe(400);
    expect(await statusOf(performSandboxGenerateOptions(space, doc, { ...named, numOptions: 2 }))).toBe(400);
    expect(runGenerate).not.toHaveBeenCalled();
  });
});

describe("a generation's images", () => {
  it("refuses one that isn't a raster image as base64, before any model is asked", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/unwired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    for (const image of [
      { mediaType: "image/png", data: "https://img.example/t?d=secret" },
      { mediaType: "image/svg+xml", data: "PHN2Zz4=" },
    ]) {
      const body = { instruction: "Go.", images: { image_1: image } };
      expect(await statusOf(performSandboxGenerate(space, doc, body))).toBe(400);
      expect(await statusOf(performSandboxGenerateOptions(space, doc, { ...body, numOptions: 2 }))).toBe(400);
    }
    expect(runGenerate).not.toHaveBeenCalled();
    expect(runGenerateOptions).not.toHaveBeenCalled();
  });
});

describe("a generation's context", () => {
  it("may be asked for, per scope, only while the Flow wires its context pin", async () => {
    const wired = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    const unwired = await readSandboxDocument(space, "flow", "tools/unwired.flow.html");
    expect(declaresCapability(wired, "searchContext:space:projects/story")).toBe(true);
    expect(declaresCapability(unwired, "searchContext:space:projects/story")).toBe(false);
    expect(declaresCapability(wired, "searchContext:lib:footage/x")).toBe(false);
  });

  it("sends nothing until both the generation and the scope are allowed, then sends the scope's files", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    const body = { instruction: "List the shots.", context: SCENE };
    expect(await statusOf(performSandboxGenerate(space, doc, body))).toBe(403);
    await grantCapability(space, doc.subject, "generateText");
    expect(await statusOf(performSandboxGenerate(space, doc, body))).toBe(403);
    expect(runGenerate).not.toHaveBeenCalled();

    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    const result = await performSandboxGenerate(space, doc, body);

    const files = vi.mocked(runGenerate).mock.calls[0][2];
    expect(files?.map((file) => file.path)).toEqual([
      "/projects/story/AGENTS.md",
      "/projects/story/README.md",
      "/projects/story/world/Lina.md",
    ]);
    expect(result).toEqual({
      reply: "Shot 1",
      model: "m",
      context: {
        path: "/projects/story/screenplay/scene.fountain",
        files: ["/projects/story/AGENTS.md", "/projects/story/README.md", "/projects/story/world/Lina.md"],
        searches: [],
        messages: [],
      },
    });
  });

  it("goes with an options call too, on the same grants", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    const result = await performSandboxGenerateOptions(space, doc, {
      instruction: "Two.",
      numOptions: 2,
      context: SCENE,
    });
    expect(vi.mocked(runGenerateOptions).mock.calls[0][2]).toHaveLength(3);
    expect(result.context?.files).toHaveLength(3);
  });

  it("is refused for a Flow that wires no context, a path that names nothing, and a library's", async () => {
    const unwired = await readSandboxDocument(space, "flow", "tools/unwired.flow.html");
    await grantCapability(space, unwired.subject, "generateText");
    expect(await statusOf(performSandboxGenerate(space, unwired, { instruction: "Go.", context: SCENE }))).toBe(400);

    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    const missing = { instruction: "Go.", context: "space:projects/story/gone.md" };
    expect(await statusOf(performSandboxGenerate(space, doc, missing))).toBe(404);
    const library = { instruction: "Go.", context: "lib:footage/x.md" };
    expect(await statusOf(performSandboxGenerate(space, doc, library))).toBe(400);
    expect(runGenerate).not.toHaveBeenCalled();
  });

  it("lets the model look further in the scope, and reports what it searched for and read", async () => {
    write("projects/story/notes/arc.md", "Lina goes home.\n");
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    vi.mocked(runGenerate).mockImplementationOnce(async (_body, _signal, _files, look) => {
      const options = { toolCallId: "t", messages: [], context: {} } as never;
      await look?.tools.set.search_space_files.execute?.({ query: "goes home" }, options);
      await look?.tools.set.read_space_file.execute?.({ path: "/projects/story/notes/arc.md" }, options);
      return { reply: "Shot 1", model: "m" };
    });

    const result = await performSandboxGenerate(space, doc, { instruction: "List the shots.", context: SCENE });

    expect(vi.mocked(runGenerate).mock.calls[0][3]?.tools.guidance).toContain("/projects/story/");
    expect(result.context).toEqual({
      path: "/projects/story/screenplay/scene.fountain",
      files: [
        "/projects/story/AGENTS.md",
        "/projects/story/README.md",
        "/projects/story/world/Lina.md",
        "/projects/story/notes/arc.md",
      ],
      searches: ["goes home"],
      messages: [],
    });
  });

  it("answers from the starting files when the model can't use tools, and says so", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    vi.mocked(runGenerate).mockImplementationOnce(async () => {
      throw new APICallError({
        message: "registry.ollama.ai/library/gemma3 does not support tools",
        url: "http://localhost:11434/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
      });
    });

    const result = await performSandboxGenerate(space, doc, { instruction: "List the shots.", context: SCENE });

    const calls = vi.mocked(runGenerate).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2]).toHaveLength(3);
    expect(calls[1][3]).toBeUndefined();
    expect(result.reply).toBe("Shot 1");
    expect(result.context?.messages).toEqual([
      {
        level: "warn",
        text: "Didn't look further: the model can't use tools (registry.ollama.ai/library/gemma3 does not support tools).",
      },
    ]);
  });

  it("still fails a run whose model fails for any other reason", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/wired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    await grantCapability(space, doc.subject, "searchContext:space:projects/story");
    const limited = new APICallError({
      message: "Too many requests",
      url: "u",
      requestBodyValues: {},
      statusCode: 429,
    });
    vi.mocked(runGenerate).mockRejectedValueOnce(limited);

    await expect(performSandboxGenerate(space, doc, { instruction: "Go.", context: SCENE })).rejects.toBe(limited);
    expect(runGenerate).toHaveBeenCalledTimes(1);
  });

  it("leaves a request without one exactly as before", async () => {
    const doc = await readSandboxDocument(space, "flow", "tools/unwired.flow.html");
    await grantCapability(space, doc.subject, "generateText");
    const result = await performSandboxGenerate(space, doc, { instruction: "Go." });
    expect(vi.mocked(runGenerate).mock.calls[0][2]).toBeUndefined();
    expect(result).toEqual({ reply: "Shot 1", model: "m" });
  });
});
