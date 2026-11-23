import { generateText, isStepCount, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { credentialStore } from "../../src/config/credentials.ts";
import type { ResolvedProvider } from "../../src/config/loadConfig.ts";
import {
  ChatGptPlanError,
  type ChatGptSignIn,
  chatGptSignInSlot,
  readChatGptSignIn,
  resetChatGptAuthCache,
} from "../../src/protocol/chatgptAuth.ts";
import { shapePlanRequest } from "../../src/protocol/chatgptPlan.ts";
import { discoverModels, imageModelFor, isAuthRejection, languageModelFor } from "../../src/protocol/modelProvider.ts";
import {
  type ChatGptStandIn,
  completed,
  createChatGptStandIn,
  saveSignIn,
  sse,
  textMessage,
} from "../support/chatgptStandIn.ts";
import { isolateConfig } from "../support/isolation.ts";

// A `chatgpt` provider's model calls through the real AI SDK, against a
// stand-in for OpenAI: what the plan route is sent, and how its answers,
// streamed or refused, come back to a caller.

const ALL_SCOPES = ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"];

const provider: ResolvedProvider = {
  id: "chatgpt",
  label: "ChatGPT plan",
  kind: "chatgpt",
  textModels: [],
  imageModels: [],
  videoModels: [],
};

let standIn: ChatGptStandIn;

function signIn(overrides: ChatGptSignIn = {}): Promise<void> {
  return saveSignIn("chatgpt", {
    clientId: "oaiapp_1",
    subject: "user-1",
    email: "writer@example.com",
    scopes: ALL_SCOPES,
    tokens: { accessToken: "at-0", refreshToken: "rt-0", expiresAt: Date.now() + 3600_000 },
    ...overrides,
  });
}

beforeEach(async () => {
  // The sign-in and its renewal lock rest under the config folder.
  isolateConfig();
  resetChatGptAuthCache();
  standIn = await createChatGptStandIn();
  vi.stubGlobal("fetch", standIn.fetch);
  await signIn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a ChatGPT plan request", () => {
  it("is sent streamed and unstored on the sign-in's token, without the fields the route refuses", async () => {
    const result = await generateText({
      model: languageModelFor(provider, "gpt-6.1-sol", undefined),
      system: "Be brief.",
      prompt: "Hi",
      maxOutputTokens: 500,
    });

    expect(result.text).toBe("Hello");
    const [request] = standIn.responsesRequests;
    expect(request.headers.get("authorization")).toBe("Bearer at-0");
    expect(request.body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
    expect(request.body).not.toHaveProperty("max_output_tokens");
    expect((request.body.input as Array<{ role?: string }>)[0].role).toBe("developer");
  });

  it("groups the app's tools in a namespace and carries a tool call back with it", async () => {
    standIn.responsesAnswer = () =>
      standIn.responsesRequests.length === 1
        ? sse(
            completed([
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "lookup",
                namespace: "functions",
                arguments: '{"q":"x"}',
                status: "completed",
              },
            ]),
          )
        : sse(completed([textMessage("Found it")], "resp_2"));

    const result = await generateText({
      model: languageModelFor(provider, "gpt-6.1-sol", undefined),
      prompt: "Find x",
      tools: {
        lookup: tool({
          description: "Looks a thing up.",
          inputSchema: z.object({ q: z.string() }),
          execute: async ({ q }) => `result for ${q}`,
        }),
      },
      stopWhen: isStepCount(3),
    });

    expect(result.text).toBe("Found it");
    const [first, second] = standIn.responsesRequests;
    expect(first.body.tools).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "functions",
        tools: [expect.objectContaining({ type: "function", name: "lookup" })],
      }),
    ]);
    expect(second.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_1", name: "lookup", namespace: "functions" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
      ]),
    );
  });

  it("stops at a usage limit, naming where to review it, and isn't retried", async () => {
    standIn.responsesAnswer = () =>
      sse([
        { type: "response.output_text.delta", delta: "Hel" },
        {
          type: "response.failed",
          response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } },
        },
      ]);

    const call = generateText({ model: languageModelFor(provider, "gpt-6.1-sol", undefined), prompt: "Hi" });

    await expect(call).rejects.toThrow(/chatgpt\.com\/settings\/usage/);
    expect(standIn.responsesRequests).toHaveLength(1);
  });

  it("treats an answer that ends before it completes as a failure, not a reply", async () => {
    standIn.responsesAnswer = () => sse([{ type: "response.output_text.delta", delta: "Hel" }]);

    await expect(
      generateText({ model: languageModelFor(provider, "gpt-6.1-sol", undefined), prompt: "Hi" }),
    ).rejects.toThrow(/ended before it finished/);
  });

  it("renews a refused token once and sends the request again", async () => {
    standIn.responsesAnswer = () =>
      standIn.responsesRequests.length === 1
        ? new Response("{}", { status: 401 })
        : sse(completed([textMessage("Hello")]));

    const result = await generateText({ model: languageModelFor(provider, "gpt-6.1-sol", undefined), prompt: "Hi" });

    expect(result.text).toBe("Hello");
    expect(standIn.responsesRequests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer at-0",
      "Bearer at-1",
    ]);
    expect(standIn.tokenRequests[0].get("grant_type")).toBe("refresh_token");
    expect((await readChatGptSignIn("chatgpt")).tokens?.refreshToken).toBe("rt-1");
  });

  it("words a plan refusal for the person, never as a rejected API key", async () => {
    standIn.responsesAnswer = () =>
      new Response(JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible", message: "no" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });

    const error = await generateText({
      model: languageModelFor(provider, "gpt-6.1-sol", undefined),
      prompt: "Hi",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ChatGptPlanError);
    expect((error as Error).message).toMatch(/can't use its plan/);
    expect(isAuthRejection(error)).toBe(false);
  });

  it("sends nothing without a sign-in, or without the plan permission", async () => {
    await credentialStore().clear(chatGptSignInSlot("chatgpt"));
    await expect(
      generateText({ model: languageModelFor(provider, "gpt-6.1-sol", undefined), prompt: "Hi" }),
    ).rejects.toThrow(/Sign in to ChatGPT/);

    await signIn({ scopes: ["openid", "profile", "email", "offline_access"] });
    await expect(
      generateText({ model: languageModelFor(provider, "gpt-6.1-sol", undefined), prompt: "Hi" }),
    ).rejects.toThrow(/isn't allowed to use your ChatGPT plan/);
    expect(standIn.responsesRequests).toHaveLength(0);
  });
});

describe("shaping a request for the plan route", () => {
  it("turns system items into developer messages and leaves hosted tools where they were", () => {
    const shaped = shapePlanRequest({
      model: "gpt-6.1-sol",
      input: [
        { role: "system", content: "Rules." },
        { role: "user", content: "Hi" },
      ],
      tools: [{ type: "web_search" }, { type: "function", name: "a", parameters: {} }, { type: "custom", name: "b" }],
      store: true,
      temperature: 0.2,
      top_p: 1,
      user: "u",
      metadata: {},
      previous_response_id: "resp_0",
    });

    expect(shaped).toEqual({
      model: "gpt-6.1-sol",
      input: [
        { role: "developer", content: "Rules." },
        { role: "user", content: "Hi" },
      ],
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: expect.any(String),
          tools: [
            { type: "function", name: "a", parameters: {} },
            { type: "custom", name: "b" },
          ],
        },
        { type: "web_search" },
      ],
      store: false,
      stream: true,
    });
  });
});

describe("a ChatGPT plan's models", () => {
  it("are the ones the plan lists for display, as text models only", async () => {
    expect(await discoverModels(provider, undefined)).toEqual({
      textModels: ["gpt-6.1-sol", "gpt-6-mini"],
      imageModels: [],
      videoModels: [],
    });
    expect(standIn.modelRequests[0].get("authorization")).toBe("Bearer at-0");
  });

  it("make no images", () => {
    expect(() => imageModelFor(provider, "gpt-image-2", undefined)).toThrow(/makes no images/);
  });
});
