import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway, GatewayAuthenticationError } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  defaultSettingsMiddleware,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import { credentialHint, providerKey } from "../config/credentials.ts";
import {
  environmentVariable,
  loadGlobalConfig,
  providerVendor,
  type ResolvedProvider,
  resolveProviders,
  signsIn,
  VENDOR_BASE_URLS,
} from "../config/loadConfig.ts";
import { type DiscoverModelsResponse, EFFORT_LEVELS, type EffortLevel } from "./api.ts";
import { CHATGPT_RESOURCE, needsSignIn } from "./chatgptAuth.ts";
import { chatGptPlanFetch, listChatGptModels } from "./chatgptPlan.ts";
import { type ProviderImageModel, withListedAspectRatios, withOptions } from "./imageGeneration.ts";
import { SetupError, type SetupNeed } from "./setupNeed.ts";
import type { RasterImageMediaType } from "./types.ts";
import type { ProviderVideoModel } from "./videoGeneration.ts";

/**
 * The provider seam for pragma's "provider call" — the prompt → provider →
 * reply step every applet, Flow, and Find in context generation routes through;
 * the copilot takes the resolved language model and runs its own tool loop.
 *
 * The packages: `@ai-sdk/anthropic`; `@ai-sdk/openai` for text on OpenAI's
 * own endpoint, `@ai-sdk/openai-compatible` for its images and for any
 * `baseURL` server; `@ai-sdk/google` for Gemini; and `@ai-sdk/gateway` for
 * Vercel's AI Gateway. See docs/architecture.md's "Model providers and
 * configuration" section.
 */

// A provider-neutral prompt content block. Mirrors the two block kinds the
// applet and Flow paths actually build — a labelled image followed by the
// text that references it, per Anthropic's own multi-image guidance (which
// every other provider worth adding follows too). The AI SDK translates
// this into each provider's wire shape.
export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: RasterImageMediaType; data: string };

// A plain string is the common case (a text-only prompt); the array form
// carries image blocks ahead of a trailing text block.
export type PromptContent = string | PromptContentBlock[];

export interface ModelCompletionRequest {
  // The wire model id for the resolved provider (e.g. "claude-sonnet-5",
  // "qwen/qwen3.5-35b-a3b"), already split off the "<providerId>/<model>"
  // ref. Named in error messages only: the model the provider actually calls
  // is bound when the provider is created.
  model: string;
  system: string;
  content: PromptContent;
  maxTokens: number;
  // Aborts the request in flight, so a caller's time limit also stops spend.
  signal?: AbortSignal;
  tools?: CompletionTools;
  // A level the model takes; none leaves its own default.
  effort?: EffortLevel;
}

/** Tools a completion may call to look around before it answers. One that
 * calls any comes back `looked`, its text set aside: the caller then asks for
 * the answer without tools, with what they found. */
export interface CompletionTools {
  set: ToolSet;
  /** Said after the system prompt while the tools are offered. */
  guidance: string;
  /** Asked after each step that called tools, with the steps taken so far:
   * true ends the looking. A tool with nothing to run ends it too. */
  mustStop: (steps: number) => boolean;
}

export interface ModelProvider {
  // Throws EmptyModelReplyError when the reply carries no text: tool-use or
  // refusal blocks alone for a plain prompt are a failure to surface, not an
  // empty string to paper over. Auth / rate-limit / network failures
  // propagate as the AI SDK's own error types (APICallError et al.); mapping
  // them to a user-facing message is the caller's job.
  complete(request: ModelCompletionRequest): Promise<{ text: string; looked?: true }>;
}

/**
 * A language model bound to a configured provider. Deliberately excludes the
 * SDK's bare-string form: `generateText({ model: "openai/gpt-5" })` would
 * resolve through Vercel's hosted AI Gateway, a third-party service with its
 * own key and billing, which pragma reaches only as a provider the person
 * adds. Every model call passes an instance built here, from a ResolvedProvider.
 */
export type ProviderLanguageModel = Exclude<LanguageModel, string>;

/** Thrown by a ModelProvider when a completion returns no usable text, its
 * message saying why where that is known. */
export class EmptyModelReplyError extends Error {
  constructor(message = "Model response contained no text block") {
    super(message);
    this.name = "EmptyModelReplyError";
  }
}

/** Thrown when a resolved provider needs an API key and none resolved from
 * the credential store or the kind's environment variable. Raised
 * before any request is made, so the message can name the provider instead
 * of surfacing as a bare 401 from its endpoint.
 *
 * A local OpenAI-compatible endpoint (an `openai` provider *with* a baseURL)
 * may serve without auth and is exempt — the same rule /api/providers applies
 * when it refuses to save a keyless husk. */
export class MissingProviderKeyError extends SetupError {
  readonly providerId: string;
  // `hint` says what adds a key on this host.
  constructor(providerId: string, hint = "") {
    super(`No API key is configured for provider "${providerId}".${hint}`, {
      kind: "providerKey",
      provider: providerId,
    });
    this.name = "MissingProviderKeyError";
    this.providerId = providerId;
  }
}

const missingKey = (provider: ResolvedProvider): MissingProviderKeyError =>
  new MissingProviderKeyError(provider.id, credentialHint("key", environmentVariable(provider)));

/** A provider endpoint answered discovery with a non-2xx status. Says whether
 * that was a refused key, so key verification can tell one apart from "the
 * endpoint has no /models route" (404) or "it's down". */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly keyRefused: boolean;
  constructor(providerId: string, status: number, keyRefused = status === 401 || status === 403) {
    super(`Provider "${providerId}" answered ${status}.`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.keyRefused = keyRefused;
  }
}

/** True when `error` is the provider rejecting our credentials — an HTTP 401
 * or 403 from the model endpoint — as opposed to any other failure. The
 * gateway's package throws its own error for a refused key. */
export function isAuthRejection(error: unknown): boolean {
  if (GatewayAuthenticationError.isInstance(error)) return true;
  return APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403);
}

/** A model call's failure as the setup error naming its provider, when the
 * provider refused the credentials: a key it rejects, or a ChatGPT sign-in
 * that lapsed. Undefined for any other failure. */
export function credentialRefusal(error: unknown, providerId: string, model: string): SetupError | undefined {
  const need: SetupNeed = { kind: "providerKey", provider: providerId };
  if (isAuthRejection(error)) {
    return new SetupError(`The provider rejected the API key configured for model "${model}".`, need);
  }
  if (needsSignIn(error)) return new SetupError((error as Error).message, need);
  return undefined;
}

// The Messages API version header every Anthropic request carries; the AI
// SDK's provider sends its own on model calls, this one is for the plain
// `/models` fetch below.
const ANTHROPIC_VERSION = "2023-06-01";

// Every request names its base URL outright: left out, a package reads one
// from the environment (OPENAI_BASE_URL, ANTHROPIC_BASE_URL) and would send
// the key there. A stored key is bound to this same address.
function baseURLOf(provider: ResolvedProvider): string {
  return provider.baseURL ?? VENDOR_BASE_URLS[provider.kind] ?? (VENDOR_BASE_URLS.openai as string);
}

function requiresKey(provider: ResolvedProvider): boolean {
  if (signsIn(provider.kind)) return false;
  return provider.kind !== "openai" || !provider.baseURL;
}

// The gateway serves models under its own path, and its model list and
// balance under the OpenAI-style one beside it.
function gatewayFor(provider: ResolvedProvider, apiKey: string | undefined) {
  return createGateway({ apiKey, baseURL: `${baseURLOf(provider).replace(/\/+$/, "")}/v4/ai` });
}

function openAICompatible(provider: ResolvedProvider, apiKey: string | undefined) {
  // `apiKey` undefined sends no Authorization header at all — what a
  // keyless LM Studio / Ollama expects.
  return createOpenAICompatible({ name: provider.id, baseURL: baseURLOf(provider), apiKey });
}

// OpenAI's own endpoint takes text on its Responses API: on Chat Completions
// a reasoning model may refuse function tools, which the copilot always sends.
//
// `store: false` keeps responses off OpenAI's servers; the model's reasoning
// still rides between tool steps, encrypted.
function openAIResponses(
  provider: ResolvedProvider,
  wireModel: string,
  apiKey: string | undefined,
): ProviderLanguageModel {
  const openai = createOpenAI({ apiKey, baseURL: baseURLOf(provider) });
  return wrapLanguageModel({
    model: openai.responses(wireModel),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
}

// A ChatGPT plan: the Responses package as for a key, with a fetch that
// sends each call on the sign-in's token. The SDK's `apiKey` is a
// placeholder that fetch replaces, never a credential.
function chatGptPlanModel(provider: ResolvedProvider, wireModel: string): ProviderLanguageModel {
  const openai = createOpenAI({
    apiKey: "chatgpt-sign-in",
    baseURL: CHATGPT_RESOURCE,
    fetch: chatGptPlanFetch(provider.id),
  });
  return wrapLanguageModel({
    model: openai.responses(wireModel),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
}

/**
 * Builds the AI SDK language model for a resolved provider, a wire model id
 * and the key read for this call. Never built without the key it needs, so
 * no package falls back to a key from the environment on its own.
 */
export function languageModelFor(
  provider: ResolvedProvider,
  wireModel: string,
  apiKey: string | undefined,
): ProviderLanguageModel {
  if (!apiKey && requiresKey(provider)) throw missingKey(provider);
  if (provider.kind === "chatgpt") return chatGptPlanModel(provider, wireModel);
  if (provider.kind === "openai") {
    return provider.baseURL
      ? openAICompatible(provider, apiKey).chatModel(wireModel)
      : openAIResponses(provider, wireModel, apiKey);
  }
  if (provider.kind === "google") {
    return createGoogleGenerativeAI({ apiKey, baseURL: baseURLOf(provider) }).languageModel(wireModel);
  }
  if (provider.kind === "vercel") return gatewayFor(provider, apiKey).languageModel(wireModel);
  return createAnthropic({ apiKey, baseURL: baseURLOf(provider) })(wireModel);
}

// gpt-image models take one of three pixel sizes, never a ratio.
const GPT_IMAGE_SIZES = {
  "1:1": { size: "1024x1024" },
  "3:2": { size: "1536x1024" },
  "2:3": { size: "1024x1536" },
} as const;

// The 2K sizes ByteDance's image API reference lists for each ratio, since
// Seedream takes a size, never a ratio. Each falls inside every Seedream
// model's pixel range, which differs by model.
const SEEDREAM_SIZES = {
  "1:1": { size: "2048x2048" },
  "4:3": { size: "2304x1728" },
  "3:4": { size: "1728x2304" },
  "16:9": { size: "2848x1600" },
  "9:16": { size: "1600x2848" },
  "3:2": { size: "2496x1664" },
  "2:3": { size: "1664x2496" },
  "21:9": { size: "3136x1344" },
} as const;

// The aspect ratios Gemini documents for its image models.
const GEMINI_IMAGE_RATIOS = Object.fromEntries(
  ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((ratio) => [
    ratio,
    { aspectRatio: ratio as `${number}:${number}` },
  ]),
);

/** Refuses a provider whose kind makes no images; a ChatGPT plan covers text
 * generation only. */
export function assertMakesImages(provider: ResolvedProvider): void {
  if (provider.kind === "anthropic" || provider.kind === "chatgpt") {
    throw new Error(`${provider.label} makes no images.`);
  }
}

/** Builds the AI SDK image model for a kind that makes images, with the key
 * read for this call, as a language model is. */
export function imageModelFor(
  provider: ResolvedProvider,
  wireModel: string,
  apiKey: string | undefined,
): ProviderImageModel {
  assertMakesImages(provider);
  if (!apiKey && requiresKey(provider)) throw missingKey(provider);
  if (provider.kind === "google") {
    const model = createGoogleGenerativeAI({ apiKey, baseURL: baseURLOf(provider) });
    return withListedAspectRatios(model.imageModel(wireModel), GEMINI_IMAGE_RATIOS);
  }
  if (provider.kind === "vercel") {
    // The gateway hands a model its maker's own parameters, and drops a ratio
    // for a model that takes a size, so that model is sent its size.
    const model = gatewayFor(provider, apiKey).imageModel(wireModel);
    if (/^openai\/gpt-image/.test(wireModel)) return withListedAspectRatios(model, GPT_IMAGE_SIZES);
    if (/^bytedance\/seedream/.test(wireModel)) return withListedAspectRatios(model, SEEDREAM_SIZES);
    return model;
  }
  // An images endpoint takes no seed and the SDK warns on one, so a seed goes
  // unsent and unsaid, as on Higgsfield.
  const model = withOptions(openAICompatible(provider, apiKey).imageModel(wireModel), (options) => ({
    ...options,
    seed: undefined,
  }));
  return /^gpt-image/.test(wireModel) ? withListedAspectRatios(model, GPT_IMAGE_SIZES) : model;
}

/** Whether a provider's kind makes videos Pragma can call. */
export function makesVideos(provider: Pick<ResolvedProvider, "kind">): boolean {
  return provider.kind === "vercel";
}

/** Refuses a provider whose kind makes no videos Pragma can call. */
export function assertMakesVideos(provider: ResolvedProvider): void {
  if (!makesVideos(provider)) throw new Error(`${provider.label} makes no videos Pragma can use.`);
}

/** Builds the AI SDK video model for a kind that makes videos, with the key
 * read for this call, as an image model is. */
export function videoModelFor(
  provider: ResolvedProvider,
  wireModel: string,
  apiKey: string | undefined,
): ProviderVideoModel {
  assertMakesVideos(provider);
  if (!apiKey && requiresKey(provider)) throw missingKey(provider);
  return gatewayFor(provider, apiKey).videoModel(wireModel);
}

type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

// An image goes tagged as inline data: a bare string that parses as a URL
// is fetched instead, by the provider or by the SDK on its behalf.
function toModelContent(content: PromptContent): UserContent {
  if (typeof content === "string") return content;
  return content.map((block) =>
    block.type === "image"
      ? { type: "file" as const, mediaType: block.mediaType, data: { type: "data" as const, data: block.data } }
      : { type: "text" as const, text: block.text },
  );
}

// A model can finish without emitting any answer text — most often a
// reasoning model that spent its whole token budget thinking (a unified
// finish reason of "length" with empty text). Say so, since the fix ("raise
// the limit or pick a non-reasoning model") isn't obvious from "no text".
function reasonNoText(model: string, maxTokens: number, hitTokenLimit: boolean): string {
  return hitTokenLimit
    ? `Model "${model}" hit the ${maxTokens}-token limit before returning any text. A reasoning model can spend the whole budget thinking. Raise the limit or pick a non-reasoning model.`
    : "Model response contained no text block";
}

/**
 * The one-completion ModelProvider over an AI SDK language model, exported so
 * the seam's contract — empty-reply detection, the token-budget floor,
 * content mapping — is testable against `ai/test`'s mock model.
 *
 * `maxTokensFloor` is the provider's own hand-set `maxTokens` (config.json,
 * for a verbose local reasoning model): it raises the caller's per-call
 * budget but never lowers it.
 */
export function createModelProvider(languageModel: ProviderLanguageModel, maxTokensFloor?: number): ModelProvider {
  return {
    async complete({ model, system, content, maxTokens, signal, tools, effort }) {
      maxTokens = Math.max(maxTokens, maxTokensFloor ?? 0);
      const result = await generateText({
        model: languageModel,
        reasoning: effort,
        system: tools ? `${system}\n\n${tools.guidance}` : system,
        messages: [{ role: "user", content: toModelContent(content) }],
        maxOutputTokens: maxTokens,
        abortSignal: signal,
        tools: tools?.set,
        stopWhen: tools && (({ steps }) => tools.mustStop(steps.length)),
      });
      if (result.steps.some((step) => step.toolCalls.length > 0)) return { text: "", looked: true };
      if (!result.text) {
        throw new EmptyModelReplyError(reasonNoText(model, maxTokens, result.finishReason === "length"));
      }
      return { text: result.text };
    },
  };
}

// Models from before reasoning, where the API refuses any level.
const PRE_REASONING_CLAUDE = /^claude-(instant|2|3-(?!7))/;
const PRE_REASONING_GEMINI = /^gemini-(1|2\.0)\b/;

// An OpenAI model's levels: low to high on a reasoning model, xhigh too from
// GPT-6 on (OpenAI's model pages). Its API refuses a level a model doesn't
// take, so one that may not take one gets none: GPT-4 and older, a "chat"
// model, which doesn't reason, a "pro" one, which reasons at one level only,
// a deep research one, and o1's early mini and preview.
const OPENAI_REASONING = /^(?:gpt-(\d+)(?:\.\d+)?|o[134](?:-mini)?)(?:-(.+))?$/;
const OPENAI_FIXED = /(?:^|-)(?:pro|chat|preview|deep-research)(?:-|$)/;

function openAiEffortLevels(model: string): EffortLevel[] {
  const match = OPENAI_REASONING.exec(model);
  if (!match || model === "o1-mini" || OPENAI_FIXED.test(match[2] ?? "")) return [];
  const major = match[1] === undefined ? undefined : Number(match[1]);
  if (major !== undefined && major < 5) return [];
  return major !== undefined && major >= 6 ? [...EFFORT_LEVELS] : ["low", "medium", "high"];
}

/**
 * The effort levels a model takes, least first. Only on a vendor's own
 * endpoint, where the id says what the model is: behind a baseURL the same
 * id may be a local server that ignores the level. Gemini's scale stops at
 * high, so it lists no "xhigh" that would run as high. A ChatGPT plan runs
 * OpenAI's models, by their own ids.
 */
export function effortLevels(provider: Pick<ResolvedProvider, "kind" | "baseURL">, model: string): EffortLevel[] {
  switch (providerVendor(provider)) {
    case "anthropic":
      return PRE_REASONING_CLAUDE.test(model) ? [] : [...EFFORT_LEVELS];
    case "google":
      return model.startsWith("gemini-") && !PRE_REASONING_GEMINI.test(model) ? ["low", "medium", "high"] : [];
    case "openai":
    case "chatgpt":
      return openAiEffortLevels(model);
    default:
      return [];
  }
}

/** Which model a ref names, from config alone: no key is read until it is
 * opened for a call. */
export interface ResolvedModel {
  connection: ResolvedProvider;
  providerId: string;
  wireModel: string;
  effortLevels: EffortLevel[];
  // Whether a tool's result can carry an image to the model. The OpenAI-
  // compatible package sends such a result as JSON text, so the model would
  // read the image's bytes as base64 rather than see it.
  imagesInToolResults: boolean;
}

export interface OpenedModel extends ResolvedModel {
  provider: ModelProvider;
  // The same model `provider.complete` runs on, for a caller that needs more
  // than one completion — the copilot's tool loop.
  languageModel: ProviderLanguageModel;
}

function resolved(provider: ResolvedProvider, wireModel: string): ResolvedModel {
  return {
    connection: provider,
    providerId: provider.id,
    wireModel,
    effortLevels: effortLevels(provider, wireModel),
    imagesInToolResults: provider.kind !== "openai" || !provider.baseURL,
  };
}

/** The key a provider's request carries: its stored key, or its vendor's
 * environment variable. A key saved but unusable here (another endpoint, a
 * keychain that can't open it) is refused by name, before any request. */
export async function providerApiKey(provider: ResolvedProvider): Promise<string | undefined> {
  if (signsIn(provider.kind)) return undefined;
  const found = await providerKey(provider);
  if (found.found) return found.key;
  if (found.problem) throw new SetupError(found.problem, { kind: "providerKey", provider: provider.id });
  return undefined;
}

/** Opens a resolved model for a call: reads its key, then builds the client
 * with it. */
export async function openModel(model: ResolvedModel): Promise<OpenedModel> {
  const languageModel = languageModelFor(model.connection, model.wireModel, await providerApiKey(model.connection));
  return { ...model, provider: createModelProvider(languageModel, model.connection.maxTokens), languageModel };
}

const NO_MODEL_MESSAGE = "No model selected. Pick one, or set a default text model in Settings.";

/** The refusal of a text generation that names no model, with no default
 * set. Chat and every generate path say the same thing, as wording kept
 * apart per caller drifts; one with no picker beside it passes `message`.
 * While no provider offers a text model there is nothing to pick, so it says
 * to add a provider, which is where its Settings link lands then. */
export function noTextModelError(message = NO_MODEL_MESSAGE): SetupError {
  const offered = resolveProviders(loadGlobalConfig()).some((provider) => provider.textModels.length > 0);
  return new SetupError(offered ? message : "No models yet. Add a provider in Settings.", {
    kind: "defaultModel",
    output: "text",
  });
}

/** The text model a call that names none runs on: config.json's
 * `defaultTextModel`, set from Settings → AI Models. Undefined is none, which the
 * caller refuses rather than guessing. */
export function defaultTextModel(): string | undefined {
  return loadGlobalConfig().defaultTextModel?.trim() || undefined;
}

/** No configured provider serves a model ref, or more than one lists a bare
 * id. The message names the fix; `need` is there when the fix is a setting. */
export class UnresolvedModelError extends Error {
  readonly need?: SetupNeed;
  constructor(message: string, need?: SetupNeed) {
    super(message);
    this.name = "UnresolvedModelError";
    this.need = need;
  }
}

/** Resolves a button/field `model` value to a provider + wire model id:
 *
 *   1. "<providerId>/<model>" — only the first segment names the provider,
 *      since model ids may themselves contain "/".
 *   2. a bare id exactly one provider lists in its `models`.
 *
 * Anything else is an UnresolvedModelError. */
export function resolveModel(ref: string): ResolvedModel {
  const providers = resolveProviders(loadGlobalConfig());

  const slash = ref.indexOf("/");
  if (slash > 0) {
    const match = providers.find((p) => p.id === ref.slice(0, slash));
    if (match) return resolved(match, ref.slice(slash + 1));
  }

  const bareMatches = providers.filter((p) => p.textModels.includes(ref));
  if (bareMatches.length === 1) return resolved(bareMatches[0], ref);
  if (bareMatches.length > 1) {
    throw new UnresolvedModelError(
      `Ambiguous model "${ref}": configured on ${bareMatches.map((p) => p.id).join(", ")}. ` +
        `Use "<providerId>/${ref}".`,
    );
  }
  throw new UnresolvedModelError(
    slash > 0
      ? `No provider "${ref.slice(0, slash)}" is configured for model "${ref}". Add it in Settings → AI Models.`
      : `No provider lists model "${ref}". Name it as "<providerId>/${ref}", or add it to a provider in Settings → AI Models.`,
    { kind: "provider", model: ref },
  );
}

// The ids each kind makes images with, by the vendor's naming: an image
// model is called through another interface than a text one. Gemini names
// some by the line's own name, `gemini-nano-banana-2.1`, with no "image".
const IMAGE_MODEL_IDS: Record<ResolvedProvider["kind"], RegExp | undefined> = {
  anthropic: undefined,
  openai: /^gpt-image/,
  google: /^gemini-(.*image|nano-banana)/,
  vercel: undefined,
  chatgpt: undefined,
};

/**
 * Lists the models a provider's endpoint reports, split into the ids its
 * kind makes images with and the rest — the rest unfiltered, for the caller
 * to choose from. A plain fetch, not an SDK call: the AI SDK has no
 * model-listing surface, and the vendor SDKs aren't worth carrying for one
 * GET each.
 */
export async function discoverModels(
  provider: ResolvedProvider,
  apiKey: string | undefined,
): Promise<DiscoverModelsResponse> {
  if (provider.kind === "chatgpt") {
    return { textModels: await listChatGptModels(provider.id), imageModels: [], videoModels: [] };
  }
  if (provider.kind === "vercel") return listGatewayModels(provider, apiKey);
  const ids =
    provider.kind === "google" ? await listGoogleModels(provider, apiKey) : await listModels(provider, apiKey);
  const images = IMAGE_MODEL_IDS[provider.kind];
  return {
    textModels: ids.filter((id) => !images?.test(id)),
    imageModels: images ? ids.filter((id) => images.test(id)) : [],
    videoModels: [],
  };
}

// The gateway lists every model it serves with its type, so each goes to its
// own list by that, and a type Pragma has no use for, such as embeddings, to none.
async function listGatewayModels(
  provider: ResolvedProvider,
  apiKey: string | undefined,
): Promise<DiscoverModelsResponse> {
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(`${baseURLOf(provider).replace(/\/+$/, "")}/v1/models`, { headers });
  if (!response.ok) throw new ProviderHttpError(provider.id, response.status);
  const body = (await response.json()) as { data?: Array<{ id?: unknown; type?: unknown }> };
  const ofType = (type: string) =>
    (body.data ?? [])
      .filter((model) => model.type === type)
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
  return { textModels: ofType("language"), imageModels: ofType("image"), videoModels: ofType("video") };
}

// `GET {baseURL}/models` on the anthropic and openai kinds, differing only in
// auth headers.
async function listModels(provider: ResolvedProvider, apiKey: string | undefined): Promise<string[]> {
  const isAnthropic = provider.kind === "anthropic";
  const baseURL = baseURLOf(provider).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (isAnthropic) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  // Anthropic pages its list (default 20); the largest page it allows covers
  // every model it serves. OpenAI-compatible servers ignore the parameter.
  const response = await fetch(`${baseURL}/models${isAnthropic ? "?limit=1000" : ""}`, { headers });
  if (!response.ok) throw new ProviderHttpError(provider.id, response.status);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
  return isAnthropic ? ids : ids.sort();
}

// Gemini lists models by resource name (`models/gemini-2.5-flash`), with the
// methods each serves; only a `generateContent` model is one Pragma can call.
//
// A bad key is a 400 naming API_KEY_INVALID, not a 401: read as anything
// else, Settings would keep the key as set.
async function listGoogleModels(provider: ResolvedProvider, apiKey: string | undefined): Promise<string[]> {
  const baseURL = baseURLOf(provider).replace(/\/+$/, "");
  const headers: Record<string, string> = apiKey ? { "x-goog-api-key": apiKey } : {};
  // The largest page Gemini allows covers every model it serves.
  const response = await fetch(`${baseURL}/models?pageSize=1000`, { headers });
  if (!response.ok) {
    const keyInvalid = response.status === 400 && (await response.text()).includes("API_KEY_INVALID");
    throw keyInvalid
      ? new ProviderHttpError(provider.id, response.status, true)
      : new ProviderHttpError(provider.id, response.status);
  }
  const body = (await response.json()) as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> };
  return (body.models ?? [])
    .filter(
      (model) =>
        Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"),
    )
    .map((model) => model.name)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/^models\//, ""))
    .sort();
}

/**
 * Probes a provider's endpoint with a key about to be saved, so Settings → AI
 * Models can refuse to record a rejected key as "set". Returns `false` only on
 * an unambiguous refusal of the key; a network error, a missing `/models`
 * route, or any other failure returns `true` ("can't disprove it"), so a
 * custom proxy that doesn't implement discovery still saves.
 */
export async function verifyProviderKey(provider: ResolvedProvider, apiKey: string): Promise<boolean> {
  try {
    if (provider.kind === "vercel") await checkGatewayKey(provider, apiKey);
    else await discoverModels(provider, apiKey);
    return true;
  } catch (error) {
    return !(error instanceof ProviderHttpError && error.keyRefused);
  }
}

// The gateway's model list answers anyone, so the key is tried on its
// balance instead, which only a key's owner may read.
async function checkGatewayKey(provider: ResolvedProvider, apiKey: string): Promise<void> {
  const response = await fetch(`${baseURLOf(provider).replace(/\/+$/, "")}/v1/credits`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new ProviderHttpError(provider.id, response.status);
}
