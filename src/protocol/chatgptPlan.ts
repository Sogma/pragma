import { CHATGPT_USAGE_URL } from "./api.ts";
import {
  type AccessTokenOptions,
  CHATGPT_RESOURCE,
  ChatGptPlanError,
  chatGptAccessToken,
  chatGptSignInAgain,
} from "./chatgptAuth.ts";

/**
 * Model calls on a ChatGPT plan: OpenAI's public Responses endpoint, the
 * sign-in's access token, and the plan route's preview limits. The AI SDK's
 * OpenAI package builds each request; the fetch here reshapes it to what the
 * route accepts and hands the package back the answer it expects.
 */

const RESPONSES_URL = `${CHATGPT_RESOURCE}/responses`;

// Fields the plan route refuses, from OpenAI's Preview limitations page.
// HTTP keeps no conversation state either, so the history rides in `input`.
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A Responses request body as the plan route takes it: streamed, unstored,
 * without the fields it refuses. */
export function shapePlanRequest(body: Record<string, unknown>): Record<string, unknown> {
  const shaped: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const field of UNSUPPORTED_FIELDS) delete shaped[field];
  if (Array.isArray(shaped.input)) {
    // A system item is refused; a developer message carries the same weight.
    shaped.input = shaped.input.map((item) =>
      isObject(item) && item.role === "system" ? { ...item, role: "developer" } : item,
    );
  }
  if (Array.isArray(shaped.tools)) shaped.tools = namespacedTools(shaped.tools);
  return shaped;
}

// The route takes an app's own tools only inside a namespace. `functions` is
// the name Codex gives its group on the same route; the tool calls that come
// back name it, and the SDK sends it back with them.
function namespacedTools(tools: unknown[]): unknown[] {
  const own = tools.filter((tool) => isObject(tool) && (tool.type === "function" || tool.type === "custom"));
  if (own.length === 0) return tools;
  return [
    { type: "namespace", name: "functions", description: "Tools the app provides.", tools: own },
    ...tools.filter((tool) => !own.includes(tool)),
  ];
}

// Codes the plan route answers with, worded for the person. A code with
// `_v2` after `subscription_sharing` is an earlier spelling of the same one.
// Those in SIGN_IN_CODES add how to sign in again, which depends on the host.
const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_user_not_eligible: "This ChatGPT account or workspace can't use its plan in Pragma.",
  subscription_sharing_usage_limit_exceeded: `The ChatGPT plan's usage limit for Pragma is reached. Review it at ${CHATGPT_USAGE_URL}.`,
  subscription_sharing_usage_unavailable: "ChatGPT couldn't check the plan's usage. Try again shortly.",
  subscription_sharing_unsupported_capability: "ChatGPT plan usage doesn't support part of this request.",
  subscription_sharing_route_not_supported: "ChatGPT plan usage doesn't support this request.",
  subscription_sharing_invalid_user: "ChatGPT couldn't validate the signed-in account.",
  subscription_sharing_user_unavailable: "The ChatGPT account is unavailable at the moment. Try again shortly.",
  chatpass_v2_scope_not_authorized: "The ChatGPT sign-in doesn't allow this request.",
  chatpass_v2_invalid_authorization_context: "The ChatGPT sign-in doesn't allow this request.",
  model_not_found: "The signed-in ChatGPT plan doesn't offer this model. Pick another.",
};

const SIGN_IN_CODES = new Set([
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]);

function planErrorFor(detail: unknown, status?: number): ChatGptPlanError | undefined {
  let error: Record<string, unknown> = isObject(detail) ? detail : {};
  if (isObject(error.error)) error = error.error;
  const code =
    typeof error.code === "string" ? error.code.replace(/^subscription_sharing_v2_/, "subscription_sharing_") : "";
  const message = PLAN_ERRORS[code];
  if (!message) return undefined;
  const param = typeof error.param === "string" && /^[\w.[\]-]{1,80}$/.test(error.param) ? ` (${error.param})` : "";
  const worded = code === "subscription_sharing_unsupported_capability" ? message.replace(/\.$/, `${param}.`) : message;
  return new ChatGptPlanError(code, SIGN_IN_CODES.has(code) ? `${worded} ${chatGptSignInAgain()}` : worded, status);
}

// An answer that isn't a stream. A plan code or a refused sign-in is the
// person's to act on; anything else goes back to the SDK as it came.
async function refused(response: Response): Promise<Response> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const known = planErrorFor(body, response.status);
  if (known) throw known;
  const detail = isObject(body) && typeof body.detail === "string" ? ` ${body.detail.slice(0, 200)}` : "";
  if (response.status === 401) {
    throw new ChatGptPlanError("unauthorized", `ChatGPT didn't accept Pragma's sign-in. ${chatGptSignInAgain()}`, 401);
  }
  if (response.status === 403) {
    throw new ChatGptPlanError("forbidden", `ChatGPT refused the request.${detail}`, 403);
  }
  return response;
}

/** The server-sent events of `stream`, each `data` parsed as JSON. */
async function* events(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parse = (block: string): Record<string, unknown> | undefined => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    const event: unknown = JSON.parse(data);
    return isObject(event) ? event : undefined;
  };
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    for (let end = buffer.search(/\r?\n\r?\n/); end !== -1; end = buffer.search(/\r?\n\r?\n/)) {
      const event = parse(buffer.slice(0, end));
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      if (event) yield event;
    }
    if (done) {
      const last = parse(buffer);
      if (last) yield last;
      return;
    }
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// The terminal statuses an in-stream error code maps to, so the SDK retries
// what it would retry had the error come before the stream.
function statusFor(code: unknown): number {
  if (code === "rate_limit_exceeded") return 429;
  if (code === "server_error" || code === "internal_error") return 500;
  return 400;
}

/** The streamed answer as the one JSON response the SDK asked for. The plan
 * route only streams, and a request succeeded only once `response.completed`
 * arrived: a limit can still end it after text has begun. */
async function collected(response: Response): Promise<Response> {
  if (!response.body) throw new ChatGptPlanError("stream_interrupted", "ChatGPT sent no answer. Try again.");
  if (response.headers.get("content-type")?.includes("application/json")) return response;
  for await (const event of events(response.body)) {
    if (event.type === "response.completed" || event.type === "response.incomplete") return json(event.response);
    if (event.type === "response.failed" || event.type === "error") {
      const error = event.type === "error" ? event : isObject(event.response) ? event.response.error : undefined;
      const known = planErrorFor(error);
      if (known) throw known;
      const detail = isObject(error) ? error : {};
      return json({ error: { message: "ChatGPT couldn't finish the answer.", ...detail } }, statusFor(detail.code));
    }
  }
  throw new ChatGptPlanError("stream_interrupted", "ChatGPT's answer ended before it finished. Try again.");
}

function bearer(headers: RequestInit["headers"], token: string): Headers {
  const next = new Headers(headers);
  next.set("authorization", `Bearer ${token}`);
  next.set("accept", "text/event-stream");
  // A Platform organization or project would ask for another account's billing.
  next.delete("openai-organization");
  next.delete("openai-project");
  return next;
}

/** A fetch for the AI SDK's OpenAI package that sends its Responses calls on
 * the ChatGPT plan of the `chatgpt` provider `providerId`. A refused token is
 * renewed and the request sent once more. Any other route is refused. */
export function chatGptPlanFetch(providerId: string, options: AccessTokenOptions = {}): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== RESPONSES_URL || init?.method !== "POST" || typeof init.body !== "string") {
      throw new ChatGptPlanError("route_not_supported", "ChatGPT plan usage covers text generation only.");
    }
    const requested = JSON.parse(init.body) as Record<string, unknown>;
    const body = JSON.stringify(shapePlanRequest(requested));
    const send = async (token: string) =>
      fetch(RESPONSES_URL, { ...init, body, headers: bearer(init.headers, token), redirect: "error" });

    let response = await send(await chatGptAccessToken(providerId, options));
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(await chatGptAccessToken(providerId, { ...options, refresh: true }));
    }
    if (!response.ok) return refused(response);
    return requested.stream === true ? response : collected(response);
  };
}

/** The models the signed-in plan lists for display, by the slug a request
 * names. A catalog, not an entitlement: only a completed request proves one. */
export async function listChatGptModels(providerId: string, options: AccessTokenOptions = {}): Promise<string[]> {
  const send = async (token: string) =>
    fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  let response = await send(await chatGptAccessToken(providerId, options));
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    response = await send(await chatGptAccessToken(providerId, { ...options, refresh: true }));
  }
  if (!response.ok) {
    await refused(response);
    throw new ChatGptPlanError("catalog_failed", `ChatGPT didn't list its models (${response.status}).`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!isObject(body) || !Array.isArray(body.models)) {
    throw new ChatGptPlanError("catalog_failed", "ChatGPT's model list was unreadable.");
  }
  return body.models
    .filter((model) => isObject(model) && model.visibility === "list")
    .map((model) => (model as Record<string, unknown>).slug)
    .filter((slug): slug is string => typeof slug === "string" && slug.trim() !== "");
}
