import { randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CredentialSlot, CredentialWrite, Metadata, Observation } from "../config/credentialStore.ts";
import {
  canonicalEndpointOrUndefined,
  carryingAttempt,
  claimSignIn,
  credentialStore,
  endSignIn,
  type LiveSignIn,
  metadataOf,
  type SignInAttempt,
  signInAgain,
  signInProblem,
  signInWarning,
  TOKENS_PART,
} from "../config/credentials.ts";
import type { McpSignInStatus } from "../protocol/api.ts";
import { type CallbackOutcome, createLoopbackCallbacks } from "./loopbackCallback.ts";

/**
 * OAuth sign-in for an HTTP MCP connection. The person approves in their own
 * browser, the redirect lands on a loopback listener that is open only while
 * a sign-in is pending, and the result rests in the credential store. The
 * SDK does the protocol: discovery, dynamic registration, PKCE and the code
 * exchange.
 */

/** A connection that can sign in: its id, its URL, and its name in messages. */
export interface SignInTarget {
  id: string;
  label: string;
  url: string;
}

export class SignInRequiredError extends Error {
  constructor(label: string, reason?: string) {
    super(`${reason ? `${reason} ` : ""}${signInAgain(label, "MCP Servers")}`);
    this.name = "SignInRequiredError";
  }
}

export interface McpSignIns {
  /** Starts a sign-in and returns the page to approve it on, dropping any
   * sign-in still pending for the same target. */
  start(target: SignInTarget): Promise<string>;
  /** From the record alone: never asks the keychain. */
  status(target: SignInTarget): Promise<McpSignInStatus>;
  /** A usable access token, refreshed near expiry or when `refresh` asks;
   * undefined when the target never signed in. Throws SignInRequiredError when
   * the refresh is refused or the saved sign-in can't be used. */
  accessToken(target: SignInTarget, options?: { refresh?: boolean }): Promise<string | undefined>;
  /** Forgets the tokens and revokes the refresh token where the server can.
   * The registration stays, for the next sign-in. */
  signOut(target: SignInTarget): Promise<void>;
  close(): Promise<void>;
}

export interface McpSignInOptions {
  // 0 takes any free port.
  port?: number;
  now?: () => number;
}

interface Session {
  provider: OAuthClientProvider;
  authorizationUrl?: URL;
}

interface Pending {
  target: SignInTarget;
  session: Session;
}

// What a sign-in keeps in the open: enough to show it, refresh it and revoke
// it. Never a token or a client secret, and never a whole SDK object, whose
// fields a server chooses.
type Details = {
  // The authorization server the sign-in went through, as the SDK names it.
  issuer?: string;
  clientId?: string;
  redirectUris?: string[];
  authMethod?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  authMethods?: string[];
  resource?: string;
  expiresAt?: number;
};

// The registration's secret, apart from the tokens, so a sign-out keeps it
// without asking the keychain.
const REGISTRATION = "registration";

// Fixed, because a registration names its redirect: a new port means a new
// registration, and some servers keep every registration forever. When it is
// taken, any free port still works, at the cost of one more registration.
const CALLBACK_PORT = 47913;
// Early enough that a token can't lapse between the check and its request.
const REFRESH_MARGIN_MS = 60_000;

const slotOf = (target: SignInTarget): CredentialSlot => ({ kind: "mcp-sign-ins", id: target.id });
const endpointOf = (target: SignInTarget): string | undefined => canonicalEndpointOrUndefined(target.url);

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const texts = (value: unknown): string[] | undefined => (Array.isArray(value) ? value : undefined);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function detailsOf(metadata: Metadata | undefined): Details {
  const m = metadata ?? {};
  return {
    issuer: text(m.issuer),
    clientId: text(m.clientId),
    redirectUris: texts(m.redirectUris),
    authMethod: text(m.authMethod),
    authorizationEndpoint: text(m.authorizationEndpoint),
    tokenEndpoint: text(m.tokenEndpoint),
    revocationEndpoint: text(m.revocationEndpoint),
    authMethods: texts(m.authMethods),
    resource: text(m.resource),
    expiresAt: typeof m.expiresAt === "number" ? m.expiresAt : undefined,
  };
}

function registrationDetails(client: OAuthClientInformationMixed): Details {
  return {
    issuer: client.issuer,
    clientId: client.client_id,
    redirectUris: "redirect_uris" in client ? client.redirect_uris : undefined,
    authMethod: "token_endpoint_auth_method" in client ? client.token_endpoint_auth_method : undefined,
  };
}

function discoveryDetails(discovery: OAuthDiscoveryState): Details {
  const server = discovery.authorizationServerMetadata;
  return {
    issuer: discovery.authorizationServerUrl,
    authorizationEndpoint: server?.authorization_endpoint,
    tokenEndpoint: server?.token_endpoint,
    revocationEndpoint: server && "revocation_endpoint" in server ? text(server.revocation_endpoint) : undefined,
    authMethods: server?.token_endpoint_auth_methods_supported,
    resource: discovery.resourceMetadata?.resource,
  };
}

const withoutRegistration = (details: Details, tokensToo: boolean): Details => ({
  ...details,
  clientId: undefined,
  redirectUris: undefined,
  authMethod: undefined,
  ...(tokensToo ? { expiresAt: undefined } : {}),
});

function clientOf(details: Details, secret: string | undefined): OAuthClientInformationMixed | undefined {
  if (!details.clientId) return undefined;
  return {
    client_id: details.clientId,
    redirect_uris: details.redirectUris ?? [],
    ...(details.authMethod ? { token_endpoint_auth_method: details.authMethod } : {}),
    ...(details.issuer ? { issuer: details.issuer } : {}),
    ...(secret ? { client_secret: secret } : {}),
  };
}

// The authorization server as a refresh needs it, from what the sign-in kept.
function serverOf(details: Details): AuthorizationServerMetadata | undefined {
  if (!details.issuer || !details.authorizationEndpoint || !details.tokenEndpoint) return undefined;
  return {
    issuer: details.issuer,
    authorization_endpoint: details.authorizationEndpoint,
    token_endpoint: details.tokenEndpoint,
    response_types_supported: ["code"],
    ...(details.authMethods ? { token_endpoint_auth_methods_supported: details.authMethods } : {}),
  };
}

const registrationPart = (client: OAuthClientInformationMixed): Record<string, string> =>
  client.client_secret ? { [REGISTRATION]: JSON.stringify({ client_secret: client.client_secret }) } : {};

function secretOf(part: string | undefined): string | undefined {
  if (part === undefined) return undefined;
  const parsed: unknown = JSON.parse(part);
  return isObject(parsed) ? text(parsed.client_secret) : undefined;
}

// The token response as the SDK hands it over, but for the authorization
// server it stamps on, which the details keep.
const tokensPart = ({ issuer: _issuer, ...tokens }: OAuthTokens): Record<string, string> => ({
  [TOKENS_PART]: JSON.stringify(tokens),
});

function tokensOf(part: string | undefined): OAuthTokens | undefined {
  if (part === undefined) return undefined;
  const parsed: unknown = JSON.parse(part);
  if (!isObject(parsed) || typeof parsed.access_token !== "string") throw new Error("Its tokens are malformed.");
  return parsed as OAuthTokens;
}

type Opened =
  | {
      ok: true;
      details: Details;
      metadata?: Metadata;
      tokens: OAuthTokens;
      secret?: string;
      observation: Observation;
    }
  | { ok: false; missing: true }
  | { ok: false; missing?: undefined; message: string };

// The sign-in with its tokens, for a request to the target's URL. One made
// for another URL reads as missing, so an entry whose URL was edited by hand
// never hands its token to the new address.
async function openSignIn(target: SignInTarget): Promise<Opened> {
  const endpoint = endpointOf(target);
  if (!endpoint) return { ok: false, missing: true };
  const selected = await credentialStore().select(slotOf(target), endpoint);
  if (!selected.ok) {
    const { state } = selected;
    if (state.state === "unreadable" && state.reason !== "endpoint-changed")
      return { ok: false, message: state.message };
    return { ok: false, missing: true };
  }
  try {
    const tokens = tokensOf(selected.secrets[TOKENS_PART]);
    if (!tokens) return { ok: false, missing: true };
    return {
      ok: true,
      details: detailsOf(selected.metadata),
      ...(selected.metadata ? { metadata: selected.metadata } : {}),
      tokens,
      secret: secretOf(selected.secrets[REGISTRATION]),
      observation: selected.observation,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// The registration a sign-in may reuse, read once per attempt. A secret that
// can't be read here leaves none, and the attempt registers again.
async function storedClient(target: SignInTarget, endpoint: string): Promise<OAuthClientInformationMixed | undefined> {
  const store = credentialStore();
  const state = await store.inspect(slotOf(target));
  if (state.state !== "live" || state.endpoint !== endpoint) return undefined;
  const details = detailsOf(state.metadata);
  if (!state.parts.includes(REGISTRATION)) return clientOf(details, undefined);
  const selected = await store.select(slotOf(target), endpoint);
  if (!selected.ok) return undefined;
  try {
    return clientOf(details, secretOf(selected.secrets[REGISTRATION]));
  } catch {
    return undefined;
  }
}

/** Saves a sign-in as a finished one leaves it, over whatever the slot holds.
 * For tests. */
export async function saveMcpSignIn(
  target: SignInTarget,
  signIn: {
    client: OAuthClientInformationMixed;
    discovery: OAuthDiscoveryState;
    tokens: OAuthTokens;
    expiresAt?: number;
  },
): Promise<void> {
  const store = credentialStore();
  const current = await store.inspect(slotOf(target));
  const details = { ...registrationDetails(signIn.client), ...discoveryDetails(signIn.discovery) };
  const committed = await store.set(slotOf(target), current.observation, {
    endpoint: target.url,
    metadata: metadataOf({ ...details, expiresAt: signIn.expiresAt }),
    secrets: { ...tokensPart(signIn.tokens), ...registrationPart(signIn.client) },
  });
  if (!committed.ok) throw new Error(`The sign-in for ${target.label} couldn't be saved.`);
}

export function createMcpSignIns(options: McpSignInOptions = {}): McpSignIns {
  const now = options.now ?? Date.now;
  const refreshes = new Map<string, Promise<string>>();
  const callbacks = createLoopbackCallbacks<Pending>({
    port: options.port ?? CALLBACK_PORT,
    anyPortIfTaken: true,
    path: "/callback",
    answer,
  });

  const expiryOf = (tokens: OAuthTokens): number | undefined =>
    tokens.expires_in === undefined ? undefined : now() + tokens.expires_in * 1000;

  function sessionFor(
    target: SignInTarget,
    endpoint: string,
    attempt: SignInAttempt,
    redirectUrl: string,
    state: string,
  ) {
    let verifier: string | undefined;
    let discovery: OAuthDiscoveryState | undefined;
    let client: OAuthClientInformationMixed | undefined;
    let clientRead = false;

    // Every write belongs to the attempt: one a sign-out, a removal or a
    // newer attempt has ended fails rather than bringing it back.
    const save = async (build: (current: LiveSignIn) => CredentialWrite, final = false): Promise<void> => {
      const written = await attempt.write(build, { final });
      if (written.ok) return;
      throw new Error(
        "refused" in written
          ? `The sign-in couldn't be saved: ${written.refused.message}`
          : "The sign-in was cancelled.",
      );
    };

    const session: Session = {
      provider: {
        get redirectUrl() {
          return redirectUrl;
        },
        get clientMetadata() {
          return {
            client_name: "Pragma",
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          };
        },
        state: () => state,
        clientInformation: async () => {
          if (!clientRead) {
            client = await storedClient(target, endpoint);
            clientRead = true;
          }
          // A registration made for another redirect can't finish this sign-in.
          if (client && "redirect_uris" in client && !client.redirect_uris.includes(redirectUrl)) return undefined;
          return client;
        },
        saveClientInformation: async (info) => {
          client = info;
          clientRead = true;
          await save((current) => ({
            metadata: metadataOf({ ...detailsOf(current.metadata), ...registrationDetails(info) }),
            secrets: registrationPart(info),
            keep: current.parts.filter((part) => part !== REGISTRATION),
          }));
        },
        // Never the stored tokens: given a refresh token, the SDK would refresh
        // it rather than start the sign-in the person asked for.
        tokens: () => undefined,
        saveTokens: async (tokens) => {
          await save(
            (current) => ({
              metadata: metadataOf({
                ...detailsOf(current.metadata),
                ...(discovery ? discoveryDetails(discovery) : {}),
                expiresAt: expiryOf(tokens),
              }),
              secrets: tokensPart(tokens),
              keep: [REGISTRATION],
            }),
            true,
          );
        },
        redirectToAuthorization: (url) => {
          session.authorizationUrl = url;
        },
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => {
          if (!verifier) throw new Error("No sign-in is pending.");
          return verifier;
        },
        invalidateCredentials: async (scope) => {
          if (scope === "verifier") verifier = undefined;
          // This session never read the stored tokens, so a refused code says
          // nothing about them.
          if (scope === "verifier" || scope === "tokens") return;
          if (scope === "discovery") {
            discovery = undefined;
            return;
          }
          // The registration is refused; with "all", the tokens it issued go too.
          client = undefined;
          clientRead = true;
          await save((current) => ({
            metadata: metadataOf(withoutRegistration(detailsOf(current.metadata), scope === "all")),
            secrets: {},
            keep: scope === "all" ? [] : [TOKENS_PART],
          }));
        },
        saveDiscoveryState: (value) => {
          discovery = value;
        },
        discoveryState: () => discovery,
      },
    };
    return session;
  }

  async function answer({ target, session }: Pending, url: URL): Promise<CallbackOutcome> {
    const code = url.searchParams.get("code");
    if (!code) {
      const reason = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code came back";
      return {
        status: 400,
        page: `Signing in to ${target.label} failed: ${reason}`,
        failure: `${target.label} refused the sign-in: ${reason}`,
      };
    }
    try {
      await auth(session.provider, { serverUrl: target.url, authorizationCode: code });
    } catch (error) {
      const message = `Signing in to ${target.label} failed: ${error instanceof Error ? error.message : String(error)}`;
      return { status: 502, page: message, failure: message };
    }
    return { status: 200, page: `Signed in to ${target.label}. You can close this tab and go back to Pragma.` };
  }

  // Ends a sign-in whose refresh token was refused, keeping its registration.
  // Only over the record the refresh began from: a newer sign-in wins.
  async function expire(target: SignInTarget, opened: Extract<Opened, { ok: true }>): Promise<never> {
    await credentialStore().set(slotOf(target), opened.observation, {
      endpoint: target.url,
      metadata: carryingAttempt(opened.metadata, metadataOf({ ...opened.details, expiresAt: undefined })),
      secrets: {},
      keep: [REGISTRATION],
    });
    callbacks.fail(target, "The sign-in expired.");
    throw new SignInRequiredError(target.label);
  }

  async function refresh(target: SignInTarget, seen: string, forced: boolean): Promise<string> {
    // The renewal lock covers other processes on this config folder: refresh
    // tokens rotate, and one spent twice can end the sign-in.
    return credentialStore().withRenewalLock(slotOf(target), async () => {
      const opened = await openSignIn(target);
      if (!opened.ok) {
        throw new SignInRequiredError(
          target.label,
          opened.missing ? undefined : `The saved sign-in can't be used: ${opened.message}`,
        );
      }
      const { details, tokens } = opened;
      const fresh = details.expiresAt === undefined || details.expiresAt - now() > REFRESH_MARGIN_MS;
      // Another process renewed it while this one waited.
      if (tokens.access_token !== seen && fresh) return tokens.access_token;
      if (!forced && fresh) return tokens.access_token;
      const refreshToken = tokens.refresh_token;
      const clientInformation = clientOf(details, opened.secret);
      if (!refreshToken || !clientInformation || !details.issuer) return expire(target, opened);
      let renewed: OAuthTokens;
      try {
        renewed = await refreshAuthorization(details.issuer, {
          metadata: serverOf(details),
          clientInformation,
          refreshToken,
          resource: details.resource,
        });
      } catch (error) {
        // A refused refresh token ends the sign-in. A network failure or a
        // server error leaves it in place for the next try.
        if (error instanceof OAuthError && !(error instanceof ServerError)) return expire(target, opened);
        throw error;
      }
      // Saved before anything else can fail: the old refresh token is spent.
      const saved = await credentialStore().set(slotOf(target), opened.observation, {
        endpoint: target.url,
        metadata: carryingAttempt(opened.metadata, metadataOf({ ...details, expiresAt: expiryOf(renewed) })),
        secrets: tokensPart(renewed),
        keep: [REGISTRATION],
      });
      if (saved.ok) return renewed.access_token;
      if ("refused" in saved) {
        throw new SignInRequiredError(
          target.label,
          `${target.label} renewed the sign-in, but it couldn't be saved: ${saved.refused.message}`,
        );
      }
      // A sign-out, a removal or a new sign-in meanwhile wins.
      const latest = await openSignIn(target);
      if (latest.ok) return latest.tokens.access_token;
      throw new SignInRequiredError(target.label);
    });
  }

  // Best effort, and only to the endpoint the sign-in's own discovery named:
  // the sign-in is already gone from this machine.
  async function revoke(details: Details, tokens: OAuthTokens): Promise<void> {
    const token = tokens.refresh_token ?? tokens.access_token;
    if (!details.revocationEndpoint || !token || !details.clientId) return;
    await fetch(details.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: tokens.refresh_token ? "refresh_token" : "access_token",
        client_id: details.clientId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  return {
    start(target) {
      return callbacks.starting(target, async () => {
        const endpoint = endpointOf(target);
        if (!endpoint) throw new Error(`${target.label} needs an http or https URL.`);
        const slot = slotOf(target);
        // Checked before the browser opens: tokens that can't be saved would
        // be lost after the person approved.
        const possible = await credentialStore().canSave(slot);
        if (!possible.ok) throw new Error(possible.refused.message);
        // The claim keeps what the record holds, so a server stays signed in
        // until the new sign-in replaces it.
        const claimed = await claimSignIn(slot, endpoint, (current) =>
          current.state === "live" && current.endpoint === endpoint
            ? { metadata: current.metadata, secrets: {}, keep: current.parts }
            : { secrets: {} },
        );
        if (!claimed.ok) throw new Error(claimed.refused.message);
        const redirectUrl = await callbacks.redirectUri();
        const state = randomBytes(16).toString("base64url");
        const session = sessionFor(target, endpoint, claimed.attempt, redirectUrl, state);
        await auth(session.provider, { serverUrl: target.url });
        if (!session.authorizationUrl) throw new Error(`${target.label} didn't ask for a browser sign-in.`);
        // A sign-out or a newer attempt during discovery wins.
        if (!(await claimed.attempt.current())) throw new Error("The sign-in was cancelled.");
        callbacks.add(state, { target, session });
        return session.authorizationUrl.href;
      });
    },

    async status(target) {
      if (callbacks.isPending(target)) return { state: "pending" };
      const record = await credentialStore().inspect(slotOf(target));
      const problem = signInProblem(record);
      if (problem) return { state: "signed-out", message: problem };
      const signedIn =
        record.state === "live" && record.endpoint === endpointOf(target) && record.parts.includes(TOKENS_PART);
      const message = callbacks.failure(target) ?? (signedIn ? signInWarning(record) : undefined);
      return { state: signedIn ? "signed-in" : "signed-out", ...(message ? { message } : {}) };
    },

    async accessToken(target, options = {}) {
      const endpoint = endpointOf(target);
      if (!endpoint) return undefined;
      // The record first, so a server never signed in costs no keychain read.
      const record = await credentialStore().inspect(slotOf(target));
      if (record.state === "unreadable") {
        throw new SignInRequiredError(target.label, `The saved sign-in can't be used: ${record.message}`);
      }
      if (record.state !== "live" || record.endpoint !== endpoint || !record.parts.includes(TOKENS_PART)) {
        return undefined;
      }
      const opened = await openSignIn(target);
      if (!opened.ok) {
        if (opened.missing) return undefined;
        throw new SignInRequiredError(target.label, `The saved sign-in can't be used: ${opened.message}`);
      }
      const { expiresAt } = opened.details;
      const fresh = expiresAt === undefined || expiresAt - now() > REFRESH_MARGIN_MS;
      if (fresh && !options.refresh) return opened.tokens.access_token;
      // One refresh in flight per sign-in in this process; the renewal lock
      // covers the others.
      let flight = refreshes.get(target.id);
      if (!flight) {
        flight = refresh(target, opened.tokens.access_token, options.refresh === true).finally(() =>
          refreshes.delete(target.id),
        );
        refreshes.set(target.id, flight);
      }
      return flight;
    },

    async signOut(target) {
      callbacks.forget(target);
      const endpoint = endpointOf(target);
      // Taken out of use first, so no request starts on a session being
      // ended. Matching URL or not: revocation goes to the server that issued
      // the token, wherever the entry points now.
      const ended = await endSignIn(slotOf(target), [TOKENS_PART], (current) =>
        current.endpoint === endpoint
          ? {
              endpoint: target.url,
              metadata: metadataOf({ ...detailsOf(current.metadata), expiresAt: undefined }),
              secrets: {},
              keep: [REGISTRATION],
            }
          : "clear",
      );
      if (!ended || ended.unreadable || !ended.taken) return;
      let tokens: OAuthTokens | undefined;
      try {
        tokens = tokensOf((await credentialStore().open(ended.taken))[TOKENS_PART]);
      } catch {
        return;
      }
      if (tokens) await revoke(detailsOf(ended.details), tokens);
    },

    close() {
      return callbacks.close();
    },
  };
}

export const mcpSignIns = createMcpSignIns();
