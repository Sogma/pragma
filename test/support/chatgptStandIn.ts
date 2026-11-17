import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { credentialStore } from "../../src/config/credentials.ts";
import { type ChatGptSignIn, chatGptSignInSlot, chatGptSignInWrite } from "../../src/protocol/chatgptAuth.ts";

// OpenAI's side of a ChatGPT sign-in, as a fetch to stub in for the global
// one: discovery, signing keys, the token and revocation endpoints, the model
// catalog and the Responses endpoint. A loopback URL goes to the real fetch,
// so a test can play the browser against the sign-in's own listener.

const ISSUER = "https://auth.openai.com";
const API = "https://api.openai.com/v1";

export interface CapturedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

export interface ChatGptStandIn {
  fetch: typeof fetch;
  tokenRequests: URLSearchParams[];
  revocations: URLSearchParams[];
  responsesRequests: CapturedRequest[];
  modelRequests: Headers[];
  jwksReads: number;
  /** Answers the token endpoint; the default issues a fresh token pair. */
  tokenAnswer: (form: URLSearchParams) => Promise<Response> | Response;
  /** Answers the Responses endpoint; the default streams "Hello". */
  responsesAnswer: (request: CapturedRequest) => Promise<Response> | Response;
  revocationStatus: number;
  modelsAnswer: () => Response;
  /** An ID token signed with the stand-in's key. */
  idToken(claims: Record<string, unknown>): Promise<string>;
  /** Signs future ID tokens with a new key, as OpenAI rotating its keys would. */
  rotateKey(): Promise<void>;
  tokensIssued: number;
}

/** Saves `signIn` for the `chatgpt` provider `id` over whatever its slot
 * holds, as an earlier session, or another process, would have left it. */
export async function saveSignIn(id: string, signIn: ChatGptSignIn): Promise<void> {
  const store = credentialStore();
  const { observation } = await store.inspect(chatGptSignInSlot(id));
  const saved = await store.set(chatGptSignInSlot(id), observation, chatGptSignInWrite(signIn));
  if (!saved.ok) throw new Error(`The sign-in for "${id}" couldn't be saved.`);
}

/** A Responses stream of `events`, as the plan route sends it. */
export function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A completed Responses answer carrying `output`. */
export function completed(output: Array<Record<string, unknown>>, id = "resp_1"): Array<Record<string, unknown>> {
  const response = {
    id,
    object: "response",
    created_at: 1_790_000_000,
    model: "gpt-6.1-sol",
    status: "completed",
    output,
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };
  return [
    { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
    { type: "response.completed", sequence_number: 1, response },
  ];
}

export function textMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg_1",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function createChatGptStandIn(): Promise<ChatGptStandIn> {
  const realFetch = globalThis.fetch;
  let keys = await generateKeyPair("RS256");
  let kid = "key-1";

  const standIn: ChatGptStandIn = {
    tokenRequests: [],
    revocations: [],
    responsesRequests: [],
    modelRequests: [],
    jwksReads: 0,
    tokensIssued: 0,
    revocationStatus: 200,
    tokenAnswer: () => {
      standIn.tokensIssued += 1;
      const n = standIn.tokensIssued;
      return json({
        access_token: `at-${n}`,
        refresh_token: `rt-${n}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      });
    },
    responsesAnswer: () => sse(completed([textMessage("Hello")])),
    modelsAnswer: () =>
      json({
        models: [
          { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
          { slug: "gpt-6.1-internal", display_name: "Internal", visibility: "hide" },
          { slug: "gpt-6-mini", display_name: "GPT-6 mini", visibility: "list" },
        ],
      }),
    async idToken(claims) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iss: ISSUER, iat: now, exp: now + 3600, ...claims })
        .setProtectedHeader({ alg: "RS256", kid })
        .sign(keys.privateKey);
    },
    async rotateKey() {
      keys = await generateKeyPair("RS256");
      kid = `key-${Date.now()}`;
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "127.0.0.1") return realFetch(input, init);
      const href = `${url.origin}${url.pathname}`;
      if (href === `${ISSUER}/.well-known/openid-configuration`) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
          token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
          revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        });
      }
      if (href === `${ISSUER}/.well-known/jwks.json`) {
        standIn.jwksReads += 1;
        return json({ keys: [{ ...(await exportJWK(keys.publicKey)), kid, alg: "RS256", use: "sig" }] });
      }
      if (href === `${ISSUER}/api/accounts/oauth/token`) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        standIn.tokenRequests.push(form);
        return standIn.tokenAnswer(form);
      }
      if (href === `${ISSUER}/api/accounts/oauth/revoke`) {
        standIn.revocations.push(new URLSearchParams(String(init?.body ?? "")));
        return new Response(null, { status: standIn.revocationStatus });
      }
      if (href === `${API}/models`) {
        standIn.modelRequests.push(new Headers(init?.headers));
        return standIn.modelsAnswer();
      }
      if (href === `${API}/responses`) {
        const request = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) };
        standIn.responsesRequests.push(request);
        return standIn.responsesAnswer(request);
      }
      return new Response("not found", { status: 404 });
    },
  };
  return standIn;
}
