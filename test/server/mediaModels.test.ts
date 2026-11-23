import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PragmaGlobalConfig } from "../../src/config/loadConfig.ts";
import { MissingProviderKeyError } from "../../src/protocol/modelProvider.ts";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";
import {
  listImageModels,
  listVideoModels,
  offersFlows,
  resolveImageModel,
  resolveVideoModel,
} from "../../src/server/mediaModels.ts";
import { isolateConfig } from "../support/isolation.ts";

// Which image or video model a ref names, and why one doesn't resolve.

beforeEach(() => {
  // Resolving a server reads its stored token, which rests in the global
  // config, so it points at a throwaway directory.
  isolateConfig();
});

const higgsfield = { id: "higgsfield", label: "Higgsfield", url: "https://mcp.higgsfield.ai/mcp", flows: true };

function config(fields: PragmaGlobalConfig = {}): PragmaGlobalConfig {
  return { mcpServers: [higgsfield], ...fields };
}

// What `run` throws, for a test that reads more than its message.
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("resolveImageModel", () => {
  it("resolves a ref to the server's adapter", () => {
    const resolved = resolveImageModel("higgsfield/soul_2", config());
    expect(resolved).toMatchObject({ providerId: "higgsfield", modelId: "soul_2" });
    expect(resolved.model).toMatchObject({ provider: "higgsfield-mcp", modelId: "soul_2", maxImagesPerCall: 1 });
  });

  it("falls back to the default image model for a blank ref", () => {
    expect(resolveImageModel("", config({ defaultImageModel: "higgsfield/gpt_image_2_5" })).modelId).toBe(
      "gpt_image_2_5",
    );
    expect(() => resolveImageModel(undefined, config())).toThrow(
      "No image model. Pick one on the node, or set a default image model in Settings.",
    );
    expect(setupNeedOf(thrown(() => resolveImageModel(undefined, config())))).toEqual({
      kind: "defaultModel",
      output: "image",
    });
  });

  it("says what to add while nothing offers an image model, as there is nothing to pick", () => {
    const textOnly = { modelProviders: [{ id: "anthropic", kind: "anthropic" as const, textModels: ["claude"] }] };
    const refused = thrown(() => resolveImageModel(undefined, textOnly));
    expect((refused as Error).message).toBe(
      "No image models yet. Add a provider in Settings, or an MCP server that makes images.",
    );
    expect(setupNeedOf(refused)).toEqual({ kind: "defaultModel", output: "image" });
  });

  it("resolves a provider's image model without reading its key", () => {
    const providers = config({
      modelProviders: [
        { id: "openai", kind: "openai", imageModels: ["gpt-image-1"] },
        { id: "gemini", kind: "google" },
      ],
    });
    expect(resolveImageModel("openai/gpt-image-1", providers)).toMatchObject({
      providerId: "openai",
      modelId: "gpt-image-1",
      model: { provider: "openai", modelId: "gpt-image-1" },
    });
    // A ref names a provider; its list is what the picker offers, not a gate.
    expect(resolveImageModel("gemini/gemini-2.5-flash-image", providers).model).toMatchObject({
      provider: "gemini",
      modelId: "gemini-2.5-flash-image",
    });
  });

  it("refuses a provider that makes no images as it resolves, and one with no key when called", async () => {
    expect(() =>
      resolveImageModel("anthropic/claude-sonnet-5", {
        modelProviders: [{ id: "anthropic", kind: "anthropic", label: "Anthropic" }],
      }),
    ).toThrow("Anthropic makes no images.");
    vi.stubEnv("OPENAI_API_KEY", "");
    try {
      const { model } = resolveImageModel("openai/gpt-image-1", { modelProviders: [{ id: "openai", kind: "openai" }] });
      const call = {
        prompt: "a fox",
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        providerOptions: {},
      };
      await expect(model.doGenerate(call as Parameters<typeof model.doGenerate>[0])).rejects.toBeInstanceOf(
        MissingProviderKeyError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an id a provider and an MCP server both hold", () => {
    expect(() =>
      resolveImageModel("higgsfield/soul_2", config({ modelProviders: [{ id: "higgsfield", kind: "openai" }] })),
    ).toThrow(/names both a model provider and an MCP server/);
  });

  it("says why a ref doesn't resolve", () => {
    expect(() => resolveImageModel("soul_2", config())).toThrow(/needs its provider/);
    expect(() => resolveImageModel("elsewhere/soul_2", config())).toThrow(/No provider "elsewhere"/);
    expect(() =>
      resolveImageModel("linear/x", { mcpServers: [{ id: "linear", url: "https://mcp.linear.app/mcp", flows: true }] }),
    ).toThrow(/offers no image models/);
    expect(() => resolveImageModel("higgsfield/soul_2", { mcpServers: [{ ...higgsfield, flows: false }] })).toThrow(
      /isn't switched on for Flows/,
    );
  });
});

describe("listImageModels", () => {
  it("offers each provider's image models as refs under it, and no text model", async () => {
    const listing = await listImageModels({
      modelProviders: [
        { id: "openai", kind: "openai", label: "OpenAI", textModels: ["gpt-5"], imageModels: ["gpt-image-1"] },
        { id: "gemini", kind: "google", label: "Gemini", imageModels: ["gemini-2.5-flash-image"] },
        {
          id: "lmstudio",
          kind: "openai",
          label: "LM Studio",
          baseURL: "http://localhost:1234/v1",
          textModels: ["qwen"],
        },
      ],
    });
    expect(listing).toEqual({
      models: [
        // Each with what the model support file says it takes.
        {
          id: "openai/gpt-image-1",
          label: "gpt-image-1 (OpenAI)",
          provider: "openai",
          model: "gpt-image-1",
          references: { image: 16 },
        },
        {
          id: "gemini/gemini-2.5-flash-image",
          label: "gemini-2.5-flash-image (Gemini)",
          provider: "gemini",
          model: "gemini-2.5-flash-image",
          references: { image: 3 },
        },
      ],
      // A provider with no image models heads nothing here.
      providers: [
        { id: "openai", label: "OpenAI", vendor: "openai" },
        { id: "gemini", label: "Gemini", vendor: "google" },
      ],
      failures: [],
    });
  });
});

describe("resolveVideoModel", () => {
  it("resolves a ref to the server's video adapter, or the default for a blank one", () => {
    const resolved = resolveVideoModel("higgsfield/seedance1_5", config());
    expect(resolved).toMatchObject({ providerId: "higgsfield", modelId: "seedance1_5" });
    expect(resolved.model).toMatchObject({ provider: "higgsfield-mcp", modelId: "seedance1_5", maxVideosPerCall: 1 });
    expect(resolveVideoModel("", config({ defaultVideoModel: "higgsfield/kling3_0" })).modelId).toBe("kling3_0");
    expect(() => resolveVideoModel(undefined, config())).toThrow(/No video model/);
    expect(setupNeedOf(thrown(() => resolveVideoModel(undefined, config())))).toEqual({
      kind: "defaultModel",
      output: "video",
    });
  });

  it("says why a ref doesn't resolve", () => {
    expect(() => resolveVideoModel("seedance1_5", config())).toThrow('Video model "seedance1_5" needs its provider');
    expect(() =>
      resolveVideoModel("openai/sora", config({ modelProviders: [{ id: "openai", kind: "openai", label: "OpenAI" }] })),
    ).toThrow("OpenAI makes no videos Pragma can use.");
    expect(() => resolveVideoModel("elsewhere/x", config())).toThrow(/No provider "elsewhere" is configured for video/);
    expect(() =>
      resolveVideoModel("linear/x", { mcpServers: [{ id: "linear", url: "https://mcp.linear.app/mcp", flows: true }] }),
    ).toThrow(/offers no video models/);
    expect(() => resolveVideoModel("higgsfield/x", { mcpServers: [{ ...higgsfield, flows: false }] })).toThrow(
      /isn't switched on for Flows/,
    );
  });

  it("resolves a gateway provider's video model, which reads its key only when a job starts", () => {
    const resolved = resolveVideoModel("vercel/maker/clip-2", {
      modelProviders: [{ id: "vercel", kind: "vercel", label: "Vercel AI Gateway", videoModels: ["maker/clip-2"] }],
    });
    expect(resolved).toMatchObject({ providerId: "vercel", modelId: "maker/clip-2", host: "vercel" });
    expect(resolved.model).toMatchObject({ provider: "vercel", modelId: "maker/clip-2", maxVideosPerCall: 1 });
    expect(resolved.inputs).toBeTypeOf("function");
  });
});

describe("listVideoModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists no provider that lists no video models, or whose kind makes none", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const listing = await listVideoModels({
      modelProviders: [
        { id: "gemini", kind: "google", label: "Gemini", imageModels: ["gemini-2.5-flash-image"] },
        { id: "openai", kind: "openai", label: "OpenAI", videoModels: ["sora-2"] },
      ],
    });
    expect(listing).toEqual({ models: [], providers: [], failures: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists a gateway's video models by name, with what its own list says each takes", async () => {
    const entry = {
      id: "maker/clip-2",
      type: "video",
      name: "Clip 2",
      video_capabilities: {
        supported_operations: ["first-last-frame", "reference-to-video"],
        supported_resolutions: ["720p", "1080p"],
        input_limits: { image: { max_count: 4 } },
        generate_audio: true,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [entry] })),
    );
    const listing = await listVideoModels({
      modelProviders: [
        {
          id: "vercel",
          kind: "vercel",
          label: "Vercel AI Gateway",
          baseURL: "https://list.example.test",
          videoModels: ["maker/clip-2", "maker/gone"],
        },
      ],
    });
    expect(listing).toEqual({
      models: [
        {
          id: "vercel/maker/clip-2",
          label: "Clip 2 (Vercel AI Gateway)",
          provider: "vercel",
          model: "Clip 2",
          references: { video: 0, audio: 0 },
          frames: ["start", "end"],
          resolutions: ["720p", "1080p"],
          settings: [{ name: "generate_audio", kind: "switch" }],
        },
        { id: "vercel/maker/gone", label: "maker/gone (Vercel AI Gateway)", provider: "vercel", model: "maker/gone" },
      ],
      providers: [{ id: "vercel", label: "Vercel AI Gateway" }],
      failures: [],
    });
  });

  it("still lists a gateway's models bare when its list can't be read, saying why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const listing = await listVideoModels({
      modelProviders: [
        { id: "vercel", kind: "vercel", label: "Gateway", baseURL: "https://down.example.test", videoModels: ["m"] },
      ],
    });
    expect(listing.models).toEqual([{ id: "vercel/m", label: "m (Gateway)", provider: "vercel", model: "m" }]);
    expect(listing.failures).toEqual([{ server: "vercel", message: "Gateway's model list answered 503." }]);
  });
});

describe("offersFlows", () => {
  it("recognizes a server by the host its adapter serves", () => {
    expect(offersFlows("https://mcp.higgsfield.ai/mcp")).toBe(true);
    expect(offersFlows("https://mcp.linear.app/mcp")).toBe(false);
    expect(offersFlows("not a url")).toBe(false);
  });
});
