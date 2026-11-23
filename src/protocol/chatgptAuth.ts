import { setTimeout as delay } from "node:timers/promises";
import { createLocalJWKSet, type JSONWebKeySet, errors as joseErrors, jwtVerify } from "jose";
import {
  type Committed,
  type CredentialSlot,
  type CredentialWrite,
  canonicalEndpoint,
  type Metadata,
  type Observation,
} from "../config/credentialStore.ts";
import { carryingAttempt, credentialStore, metadataOf, signInAgain, TOKENS_PART } from "../config/credentials.ts";

/**
 * The OAuth side of a `chatgpt` provider: OpenAI's Sign in with ChatGPT for
 * open-source apps, whose tokens let Responses requests run on the person's
 * ChatGPT plan. The browser sign-in lives with the server; what any caller
 * needs, a usable access token, lives here. The contract is OpenAI's
 * "ChatGPT plan usage" docs under developers.openai.com/siwc.
 */

const CHATGPT_ISSUER = "https://auth.openai.com";
// The token's audience, and the only base URL its requests may go to.
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

/** What a `chatgpt` provider's sign-in holds. The registration (`clientId`)
 * and the account outlive a sign-out, so signing in again reuses them; only
 * `tokens` and `scopes` go. Its record keeps all but the two tokens in the
 * open, so Settings reads it without asking the keychain. */
export interface ChatGptSignIn {
  clientId?: string;
  subject?: string;
  email?: string;
  scopes?: string[];
  tokens?: ChatGptTokens;
}

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  // OpenAI refuses a refresh before this, in epoch ms.
  earliestRefreshAt?: number;
}

/** A ChatGPT sign-in or plan failure, worded for the person. Not an
 * APICallError, so no caller reads it as a rejected API key, and the AI SDK
 * never retries it. */
export class ChatGptPlanError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "ChatGptPlanError";
    this.code = code;
    this.status = status;
  }
}

/** How to sign in to ChatGPT again on this host. */
export const chatGptSignInAgain = (): string => signInAgain("ChatGPT", "AI Models");

/** Whether the fix for `error` is the ChatGPT provider in Settings → AI Models:
 * signing in again, or allowing plan use. */
export function needsSignIn(error: unknown): boolean {
  return (
    error instanceof ChatGptPlanError &&
    ["sign_in_required", "sign_in_unreadable", "plan_usage_disabled", "unauthorized", "invalid_client"].includes(
      error.code,
    )
  );
}
const PLAN_USAGE_OFF =
  "Pragma isn't allowed to use your ChatGPT plan. Allow it from the ChatGPT provider in Settings → AI Models.";

const signInRequired = (): ChatGptPlanError => new ChatGptPlanError("sign_in_required", chatGptSignInAgain());

// A refresh token ChatGPT will never accept again: the sign-in is over.
const SPENT_GRANT_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One call to an auth endpoint. Redirects are refused: one would carry a
 * code or a token to wherever it pointed. */
async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ChatGptPlanError("network_error", "Couldn't reach ChatGPT. Check the connection and try again.");
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

let discovery: Promise<Discovery> | undefined;

/** OpenAI's OpenID configuration, held for the process. Each endpoint must
 * sit on the issuer's own origin, so a tampered answer can't send a code or
 * a token elsewhere. */
export function chatGptDiscovery(): Promise<Discovery> {
  discovery ??= (async () => {
    const response = await authFetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`);
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
    const sameOrigin = (value: unknown) => typeof value === "string" && new URL(value).origin === CHATGPT_ISSUER;
    if (
      !isObject(body) ||
      body.issuer !== CHATGPT_ISSUER ||
      !["authorization_endpoint", "token_endpoint", "jwks_uri"].every((key) => sameOrigin(body[key])) ||
      (body.revocation_endpoint !== undefined && !sameOrigin(body.revocation_endpoint))
    ) {
      throw new ChatGptPlanError("discovery_failed", "ChatGPT's sign-in settings couldn't be checked. Try again.");
    }
    return body as unknown as Discovery;
  })().catch((error: unknown) => {
    discovery = undefined;
    throw error;
  });
  return discovery;
}

let keySet: Promise<ReturnType<typeof createLocalJWKSet>> | undefined;

async function signingKeys(refetch: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
  if (refetch) keySet = undefined;
  keySet ??= (async () => {
    const { jwks_uri } = await chatGptDiscovery();
    const response = await authFetch(jwks_uri);
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (!isObject(body) || !Array.isArray(body.keys)) {
      throw new ChatGptPlanError("identity_unavailable", "ChatGPT's signing keys couldn't be read. Try again.");
    }
    return createLocalJWKSet(body as unknown as JSONWebKeySet);
  })().catch((error: unknown) => {
    keySet = undefined;
    throw error;
  });
  return keySet;
}

/** The verified account behind an ID token: signed by OpenAI, issued for
 * `clientId`, unexpired, and carrying `nonce` when one was sent. Throws
 * `identity_unavailable` when the keys can't be read, which says nothing
 * about the token, and `invalid_id_token` when the token fails. */
export async function verifyChatGptIdToken(
  idToken: string,
  clientId: string,
  nonce?: string,
): Promise<{ subject: string; email?: string }> {
  const verify = async (refetch: boolean) =>
    jwtVerify(idToken, await signingKeys(refetch), {
      issuer: CHATGPT_ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: 5,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
    });
  let payload: Awaited<ReturnType<typeof verify>>["payload"];
  try {
    try {
      ({ payload } = await verify(false));
    } catch (error) {
      // OpenAI rotated its keys since they were read.
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      ({ payload } = await verify(true));
    }
  } catch (error) {
    if (error instanceof ChatGptPlanError) throw error;
    throw new ChatGptPlanError("invalid_id_token", "ChatGPT's answer couldn't be verified. Sign in again.");
  }
  const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    (nonce !== undefined && payload.nonce !== nonce) ||
    ((payload.azp !== undefined || multipleAudiences) && payload.azp !== clientId)
  ) {
    throw new ChatGptPlanError("invalid_id_token", "ChatGPT's answer couldn't be verified. Sign in again.");
  }
  return { subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
}

const TOKEN_ERRORS: Record<string, string> = {
  access_denied: "The ChatGPT sign-in was declined.",
  invalid_client: "ChatGPT no longer recognizes Pragma's registration. Sign in again.",
  invalid_grant: "ChatGPT didn't accept that sign-in. Start it again.",
};

/** A form POST to the token endpoint, answering its JSON. An OAuth error
 * becomes a ChatGptPlanError carrying its code. */
export async function chatGptTokenRequest(form: URLSearchParams): Promise<Record<string, unknown>> {
  const { token_endpoint } = await chatGptDiscovery();
  const response = await authFetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isObject(body) && typeof body.error === "string" ? body.error : "token_request_failed";
    const message =
      SPENT_GRANT_CODES.has(code) && form.get("grant_type") === "refresh_token" ? chatGptSignInAgain() : undefined;
    throw new ChatGptPlanError(
      code,
      message ?? TOKEN_ERRORS[code] ?? `ChatGPT refused the sign-in (${response.status}).`,
      response.status,
    );
  }
  if (!isObject(body)) throw new ChatGptPlanError("invalid_token_response", "ChatGPT's answer was unreadable.");
  return body;
}

/** The scopes and tokens a token response grants, checked as OpenAI's token
 * reference describes them. A refresh may leave `scope` out when nothing
 * changed, so `previousScopes` stands in. */
export function grantFrom(
  body: Record<string, unknown>,
  now: number,
  previousScopes?: string[],
): { scopes: string[]; tokens: ChatGptTokens } {
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : previousScopes;
  const incomplete = () => new ChatGptPlanError("invalid_token_response", "ChatGPT's answer was incomplete.");
  if (!scopes) throw incomplete();
  const { access_token, refresh_token, token_type, expires_in, earliest_refresh_at } = body;
  if (
    typeof access_token !== "string" ||
    !access_token ||
    typeof token_type !== "string" ||
    token_type.toLowerCase() !== "bearer" ||
    typeof expires_in !== "number" ||
    !(expires_in > 0) ||
    (scopes.includes("offline_access") && (typeof refresh_token !== "string" || !refresh_token))
  ) {
    throw incomplete();
  }
  // Seconds when a number, as `expires_in` is; a date when a string.
  const earliest =
    typeof earliest_refresh_at === "number"
      ? earliest_refresh_at * 1000
      : typeof earliest_refresh_at === "string"
        ? Date.parse(earliest_refresh_at)
        : Number.NaN;
  return {
    scopes,
    tokens: {
      accessToken: access_token,
      ...(typeof refresh_token === "string" && refresh_token ? { refreshToken: refresh_token } : {}),
      expiresAt: now + expires_in * 1000,
      ...(Number.isFinite(earliest) ? { earliestRefreshAt: earliest } : {}),
    },
  };
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const time = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The slot a `chatgpt` provider's sign-in rests in. */
export function chatGptSignInSlot(id: string): CredentialSlot {
  return { kind: "provider-sign-ins", id };
}

/** The one endpoint a ChatGPT sign-in serves. */
export const CHATGPT_SIGN_IN_ENDPOINT = canonicalEndpoint(CHATGPT_RESOURCE);

/** A sign-in's account and registration, from the open part of its record. */
export function chatGptDetails(metadata: Metadata | undefined): Omit<ChatGptSignIn, "tokens"> {
  const { clientId, subject, email, scopes } = metadata ?? {};
  return metadataOf({
    clientId: text(clientId),
    subject: text(subject),
    email: text(email),
    scopes: Array.isArray(scopes) ? scopes : undefined,
  }) as Omit<ChatGptSignIn, "tokens">;
}

/** A sign-in from its record: its details, and its tokens once opened. */
export function chatGptSignInOf(metadata: Metadata | undefined, secrets: Record<string, string> = {}): ChatGptSignIn {
  const details = chatGptDetails(metadata);
  const part = secrets[TOKENS_PART];
  if (part === undefined) return details;
  const opened: unknown = JSON.parse(part);
  if (!isObject(opened) || typeof opened.accessToken !== "string") {
    throw new Error("The saved ChatGPT tokens are malformed.");
  }
  const refreshToken = text(opened.refreshToken);
  const earliestRefreshAt = time(metadata?.earliestRefreshAt);
  return {
    ...details,
    tokens: {
      accessToken: opened.accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: time(metadata?.expiresAt) ?? 0,
      ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    },
  };
}

/** How a sign-in is written: its two tokens protected, the rest in the open. */
export function chatGptSignInWrite({ tokens, ...details }: ChatGptSignIn): CredentialWrite {
  return {
    endpoint: CHATGPT_SIGN_IN_ENDPOINT,
    metadata: metadataOf({ ...details, expiresAt: tokens?.expiresAt, earliestRefreshAt: tokens?.earliestRefreshAt }),
    secrets: tokens
      ? { [TOKENS_PART]: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }) }
      : {},
  };
}

export type OpenedChatGptSignIn =
  | { state: "none" }
  | { state: "saved"; signIn: ChatGptSignIn; metadata?: Metadata; observation: Observation }
  | { state: "unreadable"; message: string };

/** The sign-in with its tokens, opened from where they rest. */
async function openChatGptSignIn(id: string): Promise<OpenedChatGptSignIn> {
  const selected = await credentialStore().select(chatGptSignInSlot(id), CHATGPT_SIGN_IN_ENDPOINT);
  if (!selected.ok) {
    const { state } = selected;
    if (state.state === "absent" || state.state === "cleared") return { state: "none" };
    return {
      state: "unreadable",
      message: state.state === "unreadable" ? state.message : "The saved sign-in kept changing while it was read.",
    };
  }
  try {
    return {
      state: "saved",
      signIn: chatGptSignInOf(selected.metadata, selected.secrets),
      ...(selected.metadata ? { metadata: selected.metadata } : {}),
      observation: selected.observation,
    };
  } catch (error) {
    return { state: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The sign-in as saved, tokens included; empty when there is none to read. */
export async function readChatGptSignIn(id: string): Promise<ChatGptSignIn> {
  const opened = await openChatGptSignIn(id);
  return opened.state === "saved" ? opened.signIn : {};
}

/** The sign-in with its tokens gone and its registration kept, as a sign-out
 * and a spent refresh token both leave it. */
export function withoutTokens({ clientId, subject, email }: ChatGptSignIn): ChatGptSignIn {
  return { clientId, subject, email };
}

// Early enough that a token can't lapse between the check and its request.
const REFRESH_MARGIN_MS = 60_000;

const flights = new Map<string, Promise<string>>();

export interface AccessTokenOptions {
  // Renew even a token that looks fresh: the endpoint just refused it.
  refresh?: boolean;
  now?: () => number;
}

const unreadableSignIn = (message: string): ChatGptPlanError =>
  new ChatGptPlanError(
    "sign_in_unreadable",
    `The saved ChatGPT sign-in can't be used: ${message} ${chatGptSignInAgain()}`,
  );

/** A usable access token for the `chatgpt` provider `id`, renewed near its
 * expiry. Throws a ChatGptPlanError when there is none to give: never signed
 * in, plan use not allowed, or a sign-in ChatGPT has ended. */
export async function chatGptAccessToken(id: string, options: AccessTokenOptions = {}): Promise<string> {
  const now = options.now ?? Date.now;
  const opened = await openChatGptSignIn(id);
  if (opened.state === "unreadable") throw unreadableSignIn(opened.message);
  const signIn = opened.state === "saved" ? opened.signIn : {};
  if (!signIn.tokens) throw signInRequired();
  if (!signIn.scopes?.includes(PLAN_SCOPE)) throw new ChatGptPlanError("plan_usage_disabled", PLAN_USAGE_OFF);
  if (!options.refresh && signIn.tokens.expiresAt - now() > REFRESH_MARGIN_MS) return signIn.tokens.accessToken;
  // Refresh tokens rotate: two refreshes at once would leave one holding a
  // token ChatGPT already replaced, and reusing it ends the sign-in.
  let flight = flights.get(id);
  if (!flight) {
    const seen = signIn.tokens.accessToken;
    flight = refresh(id, seen, options.refresh === true, now).finally(() => flights.delete(id));
    flights.set(id, flight);
  }
  return flight;
}

async function refresh(id: string, seen: string, forced: boolean, now: () => number): Promise<string> {
  // The renewal lock covers other processes on this config folder, such as
  // `pragma run` beside the app.
  return credentialStore().withRenewalLock(chatGptSignInSlot(id), async () => {
    const opened = await openChatGptSignIn(id);
    if (opened.state === "unreadable") throw unreadableSignIn(opened.message);
    if (opened.state === "none" || !opened.signIn.tokens) throw signInRequired();
    const { signIn: current, metadata, observation } = opened;
    const tokens = opened.signIn.tokens;
    const fresh = tokens.expiresAt - now() > REFRESH_MARGIN_MS;
    // Another process renewed it while this one waited.
    if (tokens.accessToken !== seen && fresh) return tokens.accessToken;
    if (!forced && fresh) return tokens.accessToken;
    if (tokens.earliestRefreshAt !== undefined && tokens.earliestRefreshAt > now()) {
      if (tokens.expiresAt > now()) return tokens.accessToken;
      throw new ChatGptPlanError("refresh_not_ready", "ChatGPT can't renew Pragma's sign-in yet. Try again shortly.");
    }
    // Every write below lands only over the sign-in this refresh began from:
    // a sign-out, a removal or a new sign-in meanwhile wins, and nothing is
    // brought back.
    const replace = (next: ChatGptSignIn, over: Observation = observation): Promise<Committed> => {
      const write = chatGptSignInWrite(next);
      return credentialStore().set(chatGptSignInSlot(id), over, {
        ...write,
        metadata: carryingAttempt(metadata, write.metadata ?? {}),
      });
    };
    if (!tokens.refreshToken || !current.clientId) {
      await replace(withoutTokens(current));
      throw signInRequired();
    }
    let body: Record<string, unknown>;
    try {
      body = await chatGptTokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: current.clientId,
          refresh_token: tokens.refreshToken,
          resource: CHATGPT_RESOURCE,
        }),
      );
    } catch (error) {
      // A refused grant ends the sign-in; a refused client ends the
      // registration too. A network or server failure leaves both for the
      // next try.
      if (error instanceof ChatGptPlanError && SPENT_GRANT_CODES.has(error.code)) {
        await replace(withoutTokens(current));
      } else if (error instanceof ChatGptPlanError && error.code === "invalid_client") {
        await replace({ email: current.email });
      }
      throw error;
    }
    const grant = grantFrom(body, now(), current.scopes);
    // Saved before anything else can fail: the old refresh token is spent.
    const saved = await replace({ ...current, ...grant });
    if (!saved.ok) {
      if ("refused" in saved) {
        throw new ChatGptPlanError(
          "sign_in_unsaved",
          `ChatGPT renewed Pragma's sign-in, but it couldn't be saved: ${saved.refused.message} ${chatGptSignInAgain()}`,
        );
      }
      const latest = await openChatGptSignIn(id);
      if (latest.state === "saved" && latest.signIn.tokens) return latest.signIn.tokens.accessToken;
      throw signInRequired();
    }
    if (typeof body.id_token === "string" && current.subject) {
      const identity = await verifyChatGptIdToken(body.id_token, current.clientId).catch((error: unknown) => {
        // Unreadable keys say nothing against tokens fresh from the endpoint.
        if (error instanceof ChatGptPlanError && error.code === "identity_unavailable") return undefined;
        throw error;
      });
      if (identity && identity.subject !== current.subject) {
        await replace(withoutTokens(current), saved.observation);
        throw signInRequired();
      }
    }
    return grant.tokens.accessToken;
  });
}

/** Ends the renewable session at ChatGPT. False when ChatGPT didn't confirm
 * it, so the person can disconnect Pragma from ChatGPT's settings instead. */
export async function revokeChatGptSignIn(signIn: ChatGptSignIn): Promise<boolean> {
  const token = signIn.tokens?.refreshToken;
  if (!token || !signIn.clientId) return false;
  let endpoint: string | undefined;
  try {
    endpoint = (await chatGptDiscovery()).revocation_endpoint;
  } catch {
    return false;
  }
  if (!endpoint) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await delay(300);
    let status = 0;
    try {
      const response = await authFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: signIn.clientId }),
      });
      await response.body?.cancel().catch(() => undefined);
      status = response.status;
    } catch {
      // A network failure is worth one more try.
    }
    if (status === 200) return true;
    if (status !== 0 && status < 500) return false;
  }
  return false;
}

/** Forgets the process's cached discovery and keys. For tests. */
export function resetChatGptAuthCache(): void {
  discovery = undefined;
  keySet = undefined;
  flights.clear();
}
