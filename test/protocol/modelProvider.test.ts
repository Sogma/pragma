import { APICallError, generateText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setCredentialHost } from "../../src/config/credentials.ts";
import type { ResolvedProvider } from "../../src/config/loadConfig.ts";
import { ChatGptPlanError, chatGptSignInAgain } from "../../src/protocol/chatgptAuth.ts";
import { callImageModel } from "../../src/protocol/imageGeneration.ts";
import {
  createModelProvider,
  credentialRefusal,
  discoverModels,
  EmptyModelReplyError,
  effortLevels,
  imageModelFor,
  isAuthRejection,
  languageModelFor,
  MissingProviderKeyError,
  verifyProviderKey,
} from "../../src/protocol/modelProvider.ts";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";

// The seam's contract (docs/architecture.md's Model providers and configuration section),
// exercised against the AI SDK's mock model — no network, no config file; a
// *real* provider is the SDK's to test. Pinned: the text comes back, the
// budget floor only ever raises, images map to image parts, and an empty
// reply is an error with a useful message.

type DoGenerate = ConstructorParameters<typeof MockLanguageModelV4>[0] extends { doGenerate?: infer T } | undefined
  ? T
  : never;

function replying(text: string, finish: "stop" | "length" = "stop"): DoGenerate {
  return async () => ({
    content: text ? [{ type: "text" as const, text }] : [],
    finishReason: { unified: finish, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  });
}

describe("createModelProvider", () => {
  it("returns the reply text and forwards system, prompt, and token budget", async () => {
    const model = new MockLanguageModelV4({ doGenerate: replying("hello") });
    const provider = createModelProvider(model);

    const result = await provider.complete({ model: "m", system: "be brief", content: "hi", maxTokens: 500 });

    expect(result).toEqual({ text: "hello" });
    const call = model.doGenerateCalls[0];
    expect(call.maxOutputTokens).toBe(500);
    expect(call.prompt).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("asks the model to reason at the level given, and leaves its own default otherwise", async () => {
    const model = new MockLanguageModelV4({ doGenerate: replying("ok") });
    const provider = createModelProvider(model);

    await provider.complete({ model: "m", system: "", content: "a", maxTokens: 500, effort: "high" });
    await provider.complete({ model: "m", system: "", content: "b", maxTokens: 500 });

    expect(model.doGenerateCalls.map((call) => call.reasoning)).toEqual(["high", undefined]);
  });

  it("applies the provider's maxTokens as a floor, never a ceiling", async () => {
    const model = new MockLanguageModelV4({ doGenerate: replying("ok") });
    const provider = createModelProvider(model, 8192);

    await provider.complete({ model: "m", system: "", content: "a", maxTokens: 500 });
    await provider.complete({ model: "m", system: "", content: "b", maxTokens: 20000 });

    expect(model.doGenerateCalls.map((call) => call.maxOutputTokens)).toEqual([8192, 20000]);
  });

  it("maps image blocks to image parts ahead of their text", async () => {
    const model = new MockLanguageModelV4({ doGenerate: replying("seen") });
    const provider = createModelProvider(model);

    await provider.complete({
      model: "m",
      system: "",
      content: [
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: "Describe @image_1" },
      ],
      maxTokens: 100,
    });

    const [, user] = model.doGenerateCalls[0].prompt;
    expect(user.role).toBe("user");
    const parts = user.content as Array<{ type: string; mediaType?: string; data?: unknown; text?: string }>;
    expect(parts[0].type).toBe("file");
    expect(parts[0].mediaType).toBe("image/png");
    expect(parts[1]).toEqual({ type: "text", text: "Describe @image_1" });
  });

  it("never hands a model an image whose data reads as a URL", async () => {
    // A model that takes URLs, so a URL would reach it as one, unfetched.
    const model = new MockLanguageModelV4({ doGenerate: replying("seen"), supportedUrls: { "image/*": [/.*/] } });
    const provider = createModelProvider(model);

    const complete = provider.complete({
      model: "m",
      system: "",
      content: [
        { type: "image", mediaType: "image/png", data: "https://img.example/t?d=secret" },
        { type: "text", text: "Describe @image_1" },
      ],
      maxTokens: 100,
    });

    // Read as inline data, it isn't base64, so the call stops there.
    await expect(complete).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  // Each step a model takes: a call to a tool by its name, or a reply.
  function stepping(steps: string[]): DoGenerate {
    let index = 0;
    return async () => {
      const step = steps[index++] ?? "";
      const called = step === "probe" || step === "done";
      return {
        content: called
          ? [{ type: "tool-call" as const, toolCallId: `call_${index}`, toolName: step, input: "{}" }]
          : [{ type: "text" as const, text: step }],
        finishReason: { unified: called ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    };
  }

  const probe = tool({ description: "Probe.", inputSchema: z.object({}), execute: async () => "probed" });

  it("answers in its text when the model calls no tool, the guidance said after the system prompt", async () => {
    const model = new MockLanguageModelV4({ doGenerate: stepping(["Found it."]) });
    const provider = createModelProvider(model);

    const tools = { set: { probe }, guidance: "You may probe.", mustStop: () => false };
    const result = await provider.complete({ model: "m", system: "Be brief.", content: "Go.", maxTokens: 100, tools });

    expect(result).toEqual({ text: "Found it." });
    expect(model.doGenerateCalls[0].prompt[0]).toEqual({ role: "system", content: "Be brief.\n\nYou may probe." });
    expect(model.doGenerateCalls[0].tools?.map((offered) => offered.name)).toEqual(["probe"]);
  });

  it("comes back looked, its text set aside, once the model has called a tool", async () => {
    const model = new MockLanguageModelV4({ doGenerate: stepping(["probe", "Here is what I found: it."]) });
    const provider = createModelProvider(model);

    const tools = { set: { probe }, guidance: "", mustStop: () => false };
    const result = await provider.complete({ model: "m", system: "", content: "Go.", maxTokens: 100, tools });

    expect(result).toEqual({ text: "", looked: true });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("ends the looking when told to, and at a tool with nothing to run", async () => {
    const looping = new MockLanguageModelV4({ doGenerate: stepping(["probe", "probe", "probe"]) });
    const told = { set: { probe }, guidance: "", mustStop: (steps: number) => steps >= 2 };
    await createModelProvider(looping).complete({
      model: "m",
      system: "",
      content: "Go.",
      maxTokens: 100,
      tools: told,
    });
    expect(looping.doGenerateCalls).toHaveLength(2);

    const done = tool({ description: "Done.", inputSchema: z.object({}) });
    const ending = new MockLanguageModelV4({ doGenerate: stepping(["done", "probe"]) });
    const ready = { set: { probe, done }, guidance: "", mustStop: () => false };
    const result = await createModelProvider(ending).complete({
      model: "m",
      system: "",
      content: "Go.",
      maxTokens: 100,
      tools: ready,
    });
    expect(result).toEqual({ text: "", looked: true });
    expect(ending.doGenerateCalls).toHaveLength(1);
  });

  it("throws EmptyModelReplyError when the reply carries no text", async () => {
    const provider = createModelProvider(new MockLanguageModelV4({ doGenerate: replying("") }));
    await expect(provider.complete({ model: "m", system: "", content: "x", maxTokens: 10 })).rejects.toBeInstanceOf(
      EmptyModelReplyError,
    );
  });

  it("names the token budget when an empty reply stopped on length", async () => {
    const provider = createModelProvider(new MockLanguageModelV4({ doGenerate: replying("", "length") }));
    await expect(provider.complete({ model: "qwen", system: "", content: "x", maxTokens: 64 })).rejects.toThrow(
      /"qwen" hit the 64-token limit/,
    );
  });

  it("lets provider errors propagate as the SDK's own types", async () => {
    const rejection = new APICallError({
      message: "unauthorized",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 401,
    });
    const provider = createModelProvider(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw rejection;
        },
      }),
    );
    // maxRetries is the SDK's default; a 401 is not retryable, so it
    // surfaces on the first attempt.
    await expect(provider.complete({ model: "m", system: "", content: "x", maxTokens: 10 })).rejects.toBe(rejection);
    expect(isAuthRejection(rejection)).toBe(true);
    expect(isAuthRejection(new Error("network"))).toBe(false);
  });

  it("names the provider whose key or sign-in was refused, and nothing else", () => {
    const rejection = new APICallError({
      message: "bad key",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 403,
    });
    const refused = credentialRefusal(rejection, "anthropic", "anthropic/claude");
    expect(refused?.message).toBe('The provider rejected the API key configured for model "anthropic/claude".');
    expect(setupNeedOf(refused)).toEqual({ kind: "providerKey", provider: "anthropic" });

    const lapsed = credentialRefusal(
      new ChatGptPlanError("sign_in_required", chatGptSignInAgain()),
      "chatgpt",
      "chatgpt/m",
    );
    expect(lapsed?.message).toBe(chatGptSignInAgain());
    expect(setupNeedOf(lapsed)).toEqual({ kind: "providerKey", provider: "chatgpt" });

    const limited = new APICallError({ message: "slow", url: "https://x", requestBodyValues: {}, statusCode: 429 });
    expect(credentialRefusal(limited, "anthropic", "m")).toBeUndefined();
  });
});

function provider(overrides: Partial<ResolvedProvider>): ResolvedProvider {
  return { id: "p", label: "P", kind: "openai", textModels: [], imageModels: [], ...overrides };
}

describe("languageModelFor", () => {
  it("refuses a keyless anthropic provider before any request, naming it as what needs a key", () => {
    expect(() => languageModelFor(provider({ id: "anthropic", kind: "anthropic" }), "claude-x", undefined)).toThrow(
      MissingProviderKeyError,
    );
    expect(setupNeedOf(new MissingProviderKeyError("anthropic"))).toEqual({
      kind: "providerKey",
      provider: "anthropic",
    });
  });

  // A host started from a terminal keeps its own keys, so its refusal says
  // the desktop app's aren't used, and names the vendor's variable only for
  // a vendor's own endpoint.
  it("says what adds a key on the host it runs on", () => {
    const refusal = (overrides: Partial<ResolvedProvider>) => {
      try {
        languageModelFor(provider(overrides), "m", undefined);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("no refusal");
    };
    try {
      setCredentialHost("desktop");
      expect(refusal({ id: "anthropic", kind: "anthropic" })).toBe(
        'No API key is configured for provider "anthropic".',
      );
      setCredentialHost("local");
      expect(refusal({ id: "anthropic", kind: "anthropic" })).toBe(
        'No API key is configured for provider "anthropic". Keys saved in the desktop app aren\'t used here, but ANTHROPIC_API_KEY is.',
      );
      setCredentialHost("terminal");
      expect(refusal({ id: "openai", kind: "openai" })).toMatch(
        /: set OPENAI_API_KEY, or add the key in Settings in `pragma dev`\.$/,
      );
      expect(refusal({ id: "gateway", kind: "anthropic", baseURL: "https://gateway.example/v1" })).toMatch(
        /add the key in Settings in `pragma dev`, or write its record as docs\/deployment\.md shows\.$/,
      );
    } finally {
      setCredentialHost("terminal");
    }
  });

  it("refuses a keyless openai provider with no baseURL (OpenAI proper)", () => {
    expect(() => languageModelFor(provider({ kind: "openai" }), "gpt-x", undefined)).toThrow(MissingProviderKeyError);
  });

  it("allows a keyless local OpenAI-compatible endpoint", () => {
    const model = languageModelFor(
      provider({ kind: "openai", baseURL: "http://localhost:1234/v1" }),
      "qwen/q",
      undefined,
    );
    expect(model.modelId).toBe("qwen/q");
  });

  it("builds a bound instance, never a bare model string", () => {
    const model = languageModelFor(provider({ id: "anthropic", kind: "anthropic" }), "claude-x", "k");
    expect(typeof model).toBe("object");
    expect(model.modelId).toBe("claude-x");
  });

  it("refuses a keyless google provider, and builds one with a key", () => {
    expect(() => languageModelFor(provider({ kind: "google" }), "gemini-2.5-flash", undefined)).toThrow(
      MissingProviderKeyError,
    );
    expect(languageModelFor(provider({ kind: "google" }), "gemini-2.5-flash", "g").modelId).toBe("gemini-2.5-flash");
  });
});

// Text against a stubbed fetch: which API each OpenAI-shaped endpoint gets,
// and what reaches it.
describe("the OpenAI text endpoints", () => {
  const RESPONSES_REPLY = {
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const openai = provider({ kind: "openai" });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const sent = (): { url: string; body: Record<string, unknown> } => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) };
  };

  it("sends OpenAI's own endpoint to its Responses API, stored nowhere", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://elsewhere.test/v1");
    fetchMock.mockResolvedValue(Response.json(RESPONSES_REPLY));
    const seam = createModelProvider(languageModelFor(openai, "gpt-6.1-sol", "k"));

    const reply = await seam.complete({ model: "gpt-6.1-sol", system: "", content: "hi", maxTokens: 300 });

    expect(reply).toEqual({ text: "ok" });
    const { url, body } = sent();
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      max_output_tokens: 300,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("hands OpenAI's own endpoint a tool's image as an image", async () => {
    fetchMock.mockResolvedValue(Response.json(RESPONSES_REPLY));
    await generateText({
      model: languageModelFor(openai, "gpt-6.1-sol", "k"),
      messages: [
        { role: "user", content: "what is it?" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "look_at_image", input: { path: "a.png" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "look_at_image",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "The image `a.png`:" },
                  { type: "file", data: { type: "data", data: "AAAA" }, mediaType: "image/png" },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(sent().body.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "The image `a.png`:" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    });
  });

  it("sends an endpoint behind a baseURL to Chat Completions, with max_tokens", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
    );
    const local = provider({ kind: "openai", baseURL: "http://localhost:1234/v1" });
    const seam = createModelProvider(languageModelFor(local, "qwen/q", undefined));

    await seam.complete({ model: "qwen/q", system: "", content: "hi", maxTokens: 300 });

    const { url, body } = sent();
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(body).toMatchObject({ model: "qwen/q", max_tokens: 300 });
  });
});

describe("effortLevels", () => {
  const anthropic = { kind: "anthropic" as const };
  const google = { kind: "google" as const };

  it("offers Claude every level, and Gemini every level up to high", () => {
    for (const model of ["claude-opus-5-5", "claude-haiku-4-5", "claude-3-7-sonnet-latest"]) {
      expect(effortLevels(anthropic, model)).toEqual(["low", "medium", "high", "xhigh"]);
    }
    for (const model of ["gemini-pro-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"]) {
      expect(effortLevels(google, model)).toEqual(["low", "medium", "high"]);
    }
  });

  it("offers none for a model from before reasoning, or one that isn't Gemini", () => {
    for (const model of ["claude-3-5-haiku-latest", "claude-3-opus-20240229", "claude-2.1"]) {
      expect(effortLevels(anthropic, model)).toEqual([]);
    }
    for (const model of ["gemini-2.0-flash", "gemini-1.5-pro", "antigravity-preview-latest", "gemma-3-27b-it"]) {
      expect(effortLevels(google, model)).toEqual([]);
    }
  });

  // Behind a baseURL the id can't say what serves it.
  it("offers none on any endpoint but the vendor's own", () => {
    expect(effortLevels({ kind: "anthropic", baseURL: "https://proxy.test/v1" }, "claude-opus-5-5")).toEqual([]);
    expect(effortLevels({ kind: "openai", baseURL: "http://localhost:1234/v1" }, "qwen/qwen3.5-35b-a3b")).toEqual([]);
    expect(effortLevels({ kind: "openai", baseURL: "http://localhost:1234/v1" }, "gpt-5")).toEqual([]);
  });

  // OpenAI's API refuses a level a model doesn't take, so only a model its
  // pages give levels for gets any, by key or through a ChatGPT plan alike.
  it("offers an OpenAI reasoning model low to high, and xhigh from GPT-6 on", () => {
    for (const provider of [{ kind: "openai" as const }, { kind: "chatgpt" as const }]) {
      for (const model of ["gpt-5", "gpt-5.1", "gpt-5-mini", "gpt-5.1-codex", "gpt-5-2025-08-07", "o3", "o4-mini"]) {
        expect(effortLevels(provider, model)).toEqual(["low", "medium", "high"]);
      }
      for (const model of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-mini"]) {
        expect(effortLevels(provider, model)).toEqual(["low", "medium", "high", "xhigh"]);
      }
    }
  });

  it("offers none for an OpenAI model that may not take a level", () => {
    const models = [
      "gpt-4o",
      "gpt-4.1-mini",
      "gpt-3.5-turbo",
      "gpt-5-chat-latest",
      "gpt-5.1-chat-latest",
      "gpt-5-pro",
      "o3-pro",
      "o3-deep-research",
      "o1-mini",
      "o1-preview",
      "chatgpt-4o-latest",
    ];
    for (const model of models) expect(effortLevels({ kind: "openai" }, model)).toEqual([]);
  });
});

// The vendors' image models, run through the one image call against a
// stubbed fetch: what reaches each endpoint, and what comes back said.
describe("imageModelFor", () => {
  // The 8-byte PNG signature, base64.
  const PNG_BASE64 = "iVBORw0KGgo=";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sent = (): { url: string; body: Record<string, unknown> } => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) };
  };

  it("refuses a kind that makes no images, and a keyless one, before any request", () => {
    expect(() => imageModelFor(provider({ kind: "anthropic", label: "Anthropic" }), "x", "k")).toThrow(
      "Anthropic makes no images.",
    );
    expect(() => imageModelFor(provider({ kind: "openai" }), "gpt-image-1", undefined)).toThrow(
      MissingProviderKeyError,
    );
    expect(() => imageModelFor(provider({ kind: "google" }), "gemini-2.5-flash-image", undefined)).toThrow(
      MissingProviderKeyError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks gpt-image for the size nearest the ratio, says so, and sends no seed", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: PNG_BASE64 }] }));
    const model = imageModelFor(provider({ kind: "openai" }), "gpt-image-1", "k");
    const result = await callImageModel(model, { prompt: "a city", references: [], aspectRatio: "16:9", seed: 7 });

    const { url, body } = sent();
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(body).toMatchObject({ model: "gpt-image-1", prompt: "a city", size: "1536x1024" });
    expect(body).not.toHaveProperty("seed");
    expect(result.mediaType).toBe("image/png");
    expect(result.warnings).toEqual(["aspect_ratio: asked for 16:9, used 3:2 (the nearest gpt-image-1 makes)"]);
  });

  it("asks a gpt-image ratio it makes without a word", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: PNG_BASE64 }] }));
    const model = imageModelFor(provider({ kind: "openai" }), "gpt-image-1", "k");
    const result = await callImageModel(model, { prompt: "a city", references: [], aspectRatio: "2:3" });
    expect(sent().body).toMatchObject({ size: "1024x1536" });
    expect(result.warnings).toEqual([]);
  });

  it("asks Gemini for its nearest listed ratio through generateContent", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: PNG_BASE64 } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1290, totalTokenCount: 1294 },
      }),
    );
    const model = imageModelFor(provider({ kind: "google" }), "gemini-2.5-flash-image", "g");
    const result = await callImageModel(model, { prompt: "a city", references: [], aspectRatio: "16:10" });

    const { url, body } = sent();
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect(body.generationConfig).toMatchObject({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } });
    expect(result.mediaType).toBe("image/png");
    expect(result.warnings).toEqual([
      "aspect_ratio: asked for 16:10, used 3:2 (the nearest gemini-2.5-flash-image makes)",
    ]);
  });
});

describe("discoverModels / verifyProviderKey", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists an anthropic provider's models with its own auth headers", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "claude-b" }, { id: "claude-a" }] }));
    const found = await discoverModels(provider({ id: "anthropic", kind: "anthropic" }), "sk");
    expect(found).toEqual({ textModels: ["claude-b", "claude-a"], imageModels: [] }); // endpoint order, unsorted
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(init.headers).toEqual({ "anthropic-version": "2023-06-01", "x-api-key": "sk" });
  });

  it("lists an openai-compatible provider's models, sorted, from its baseURL", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "b" }, { id: "a" }] }));
    const found = await discoverModels(provider({ kind: "openai", baseURL: "http://localhost:1234/v1/" }), "t");
    expect(found).toEqual({ textModels: ["a", "b"], imageModels: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:1234/v1/models");
    expect(init.headers).toEqual({ authorization: "Bearer t" });
  });

  it("splits OpenAI's image models from the rest", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [{ id: "gpt-image-1" }, { id: "gpt-5" }, { id: "dall-e-3" }, { id: "gpt-image-1-mini" }] }),
    );
    expect(await discoverModels(provider({ kind: "openai" }), "t")).toEqual({
      textModels: ["dall-e-3", "gpt-5"],
      imageModels: ["gpt-image-1", "gpt-image-1-mini"],
    });
  });

  it("lists Gemini's generateContent models by id, its image models apart", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-nano-banana-2.1", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          { name: "models/imagen-4.0-generate-001", supportedGenerationMethods: ["predict"] },
          { name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
        ],
      }),
    );
    expect(await discoverModels(provider({ kind: "google" }), "g")).toEqual({
      textModels: ["gemini-2.5-flash", "gemma-3-27b-it"],
      imageModels: ["gemini-2.5-flash-image", "gemini-nano-banana-2.1"],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect(init.headers).toEqual({ "x-goog-api-key": "g" });
  });

  it("sends no auth header for a keyless local endpoint", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    await discoverModels(provider({ kind: "openai", baseURL: "http://localhost:11434/v1" }), undefined);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it("verifyProviderKey is false only on an auth rejection", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    expect(await verifyProviderKey(provider({ kind: "openai" }), "bad")).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response("no such route", { status: 404 }));
    expect(await verifyProviderKey(provider({ kind: "openai", baseURL: "http://proxy/v1" }), "k")).toBe(true);

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await verifyProviderKey(provider({ kind: "openai", baseURL: "http://down/v1" }), "k")).toBe(true);
  });

  it("verifyProviderKey reads Gemini's 400 for a bad key as a refusal, and only that 400", async () => {
    const invalid = { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } };
    fetchMock.mockResolvedValueOnce(Response.json(invalid, { status: 400 }));
    expect(await verifyProviderKey(provider({ kind: "google" }), "bad")).toBe(false);

    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 }),
    );
    expect(await verifyProviderKey(provider({ kind: "google" }), "k")).toBe(true);
  });
});
