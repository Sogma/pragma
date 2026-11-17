import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SlotState } from "../config/credentialStore.ts";
import {
  type AttemptWrite,
  claimSignIn,
  credentialStore,
  endSignIn,
  type SignInAttempt,
  signInProblem,
  signInWarning,
  TOKENS_PART,
} from "../config/credentials.ts";
import { chatGptHostId } from "../config/loadConfig.ts";
import type { ProviderSignInStatus } from "../protocol/api.ts";
import {
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_SIGN_IN_ENDPOINT,
  ChatGptPlanError,
  type ChatGptSignIn,
  chatGptDetails,
  chatGptDiscovery,
  chatGptSignInOf,
  chatGptSignInSlot,
  chatGptSignInWrite,
  chatGptTokenRequest,
  grantFrom,
  PLAN_SCOPE,
  revokeChatGptSignIn,
  verifyChatGptIdToken,
  withoutTokens,
} from "../protocol/chatgptAuth.ts";

/**
 * Signing a `chatgpt` provider in with the person's ChatGPT account. They
 * approve in their own browser, whose redirect returns to a loopback listener
 * open only while a sign-in is pending. The first sign-in registers Pragma
 * with that account; later ones reuse the registration. The contract is
 * OpenAI's "Registration and sign-in" page under developers.openai.com/siwc.
 */

/** A provider that signs in: its id, and its name in messages. */
export interface ChatGptSignInTarget {
  id: string;
  label: string;
}

export interface ChatGptSignIns {
  /** Starts a sign-in and returns the page to approve it on, dropping any
   * still pending for the same target. `planUsage` asks for the plan
   * permission again, after the person declined it. */
  start(target: ChatGptSignInTarget, options?: { planUsage?: boolean }): Promise<string>;
  /** From the record alone: never asks the keychain. */
  status(target: ChatGptSignInTarget): Promise<ProviderSignInStatus>;
  /** Forgets the tokens and ends the session at ChatGPT; `revoked` is false
   * when ChatGPT didn't confirm. The registration stays, for the next one. */
  signOut(target: ChatGptSignInTarget): Promise<{ revoked: boolean }>;
  close(): Promise<void>;
}

export interface ChatGptSignInOptions {
  // 0, the default, takes any free port: only the port of the registered
  // redirect may change between sign-ins.
  port?: number;
  now?: () => number;
  hostId?: () => string;
}

const CALLBACK_PATH = "/auth/callback";
const PENDING_TIMEOUT_MS = 10 * 60_000;
// The name a first registration proposes, the same on every installation.
const AGENT_NAME = "Pragma";
const DYNAMIC_CLIENT = "dynamic_agent_client";

interface Pending {
  target: ChatGptSignInTarget;
  attempt: SignInAttempt;
  nonce: string;
  verifier: string;
  redirectUri: string;
  // The registration a returning sign-in reuses; a callback naming another
  // is refused rather than replacing it.
  clientId?: string;
  // The account the provider already uses: a sign-in as another is refused.
  subject?: string;
  email?: string;
  timer: NodeJS.Timeout;
}

const random = (): string => randomBytes(32).toString("base64url");

// What an attempt keeps of the record it claims, tokens included, so a
// provider stays signed in until the new sign-in replaces it.
function keptByClaim(current: SlotState) {
  return current.state === "live" && current.endpoint === CHATGPT_SIGN_IN_ENDPOINT
    ? { metadata: current.metadata, secrets: {}, keep: current.parts }
    : { secrets: {} };
}

function attemptFailure(result: Exclude<AttemptWrite, { ok: true }>): ChatGptPlanError {
  return "refused" in result
    ? new ChatGptPlanError("sign_in_unsaved", `The sign-in couldn't be saved: ${result.refused.message}`)
    : new ChatGptPlanError("cancelled", "The sign-in was cancelled.");
}

export function createChatGptSignIns(options: ChatGptSignInOptions = {}): ChatGptSignIns {
  const now = options.now ?? Date.now;
  const hostId = options.hostId ?? chatGptHostId;
  const pending = new Map<string, Pending>();
  const failures = new Map<string, string>();
  let listening: Promise<{ server: Server; port: number }> | undefined;
  let starting = 0;

  const sameTarget = (a: ChatGptSignInTarget, b: ChatGptSignInTarget): boolean => a.id === b.id;

  function openListener(): Promise<{ server: Server; port: number }> {
    listening ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void onCallback(req, res));
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve({ server, port: (server.address() as AddressInfo).port });
      });
    });
    return listening.catch((error: unknown) => {
      listening = undefined;
      throw error;
    });
  }

  function closeListenerIfIdle(): void {
    if (pending.size > 0 || starting > 0 || !listening) return;
    const closing = listening;
    listening = undefined;
    void closing.then(({ server }) => server.close()).catch(() => {});
  }

  function finish(state: string, failure?: string): void {
    const entry = pending.get(state);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(state);
    if (failure) failures.set(entry.target.id, failure);
    closeListenerIfIdle();
  }

  function dropPending(target: ChatGptSignInTarget): void {
    for (const [state, entry] of pending) {
      if (!sameTarget(entry.target, target)) continue;
      clearTimeout(entry.timer);
      pending.delete(state);
    }
  }

  // The browser's return, with the code and, on a first registration, the
  // client id ChatGPT issued for Pragma on this account.
  async function complete(entry: Pending, url: URL, stillPending: () => boolean): Promise<string> {
    const codes = url.searchParams.getAll("code");
    const returned = url.searchParams.getAll("client_id");
    const clientId = returned[0] ?? entry.clientId;
    if (
      codes.length !== 1 ||
      returned.length > 1 ||
      !clientId ||
      clientId === DYNAMIC_CLIENT ||
      !/^[\w-]{1,200}$/.test(clientId) ||
      (entry.clientId !== undefined && returned.length === 1 && returned[0] !== entry.clientId)
    ) {
      throw new ChatGptPlanError("registration_incomplete", "ChatGPT didn't finish registering Pragma. Start again.");
    }
    // Kept before the exchange: a code can fail after the registration
    // succeeded, and the next attempt must reuse it, not register again.
    if (!entry.clientId) {
      const kept = await entry.attempt.write((current) => ({
        metadata: { ...current.metadata, clientId },
        secrets: {},
        keep: current.parts,
      }));
      if (!kept.ok) throw attemptFailure(kept);
    }

    const body = await chatGptTokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: codes[0],
        code_verifier: entry.verifier,
        redirect_uri: entry.redirectUri,
        resource: CHATGPT_RESOURCE,
      }),
    );
    if (typeof body.id_token !== "string") {
      throw new ChatGptPlanError("invalid_id_token", "ChatGPT didn't say which account signed in. Start again.");
    }
    const identity = await verifyChatGptIdToken(body.id_token, clientId, entry.nonce);
    if (entry.subject && entry.subject !== identity.subject) {
      const who = entry.email ? ` (${entry.email})` : "";
      throw new ChatGptPlanError(
        "account_mismatch",
        `That's a different ChatGPT account from the one this provider uses${who}. Sign in with it, or remove the provider and add it again.`,
      );
    }
    const grant = grantFrom(body, now());
    // A sign-out or a removal while the code was exchanged wins, here or in
    // another process: writing now would bring back what the person ended.
    if (!stillPending()) throw new ChatGptPlanError("cancelled", "The sign-in was cancelled.");
    const signIn: ChatGptSignIn = {
      clientId,
      subject: identity.subject,
      email: identity.email ?? entry.email,
      ...grant,
    };
    const saved = await entry.attempt.write(() => chatGptSignInWrite(signIn), { final: true });
    if (!saved.ok) throw attemptFailure(saved);
    return grant.scopes.includes(PLAN_SCOPE)
      ? "Signed in to ChatGPT. You can close this tab and go back to Pragma."
      : "Signed in to ChatGPT, without permission to use your plan. Go back to Pragma to allow it.";
  }

  async function onCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = req.socket.localPort;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    // Only this exact origin: a rebound DNS name reaches 127.0.0.1 too.
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}`) {
      return void res.writeHead(404).end();
    }
    const states = url.searchParams.getAll("state");
    const entry = states.length === 1 ? pending.get(states[0]) : undefined;
    if (!entry) {
      return page(res, 400, "This sign-in link has expired or was already used. Start signing in again from Pragma.");
    }
    const state = states[0];
    const error = url.searchParams.get("error");
    if (error) {
      const reason =
        error === "access_denied" ? "The ChatGPT sign-in was declined." : `ChatGPT refused the sign-in: ${error}.`;
      finish(state, reason);
      return page(res, 400, reason);
    }
    try {
      const done = await complete(entry, url, () => pending.get(state) === entry);
      finish(state);
      page(res, 200, done);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish(state, message);
      page(res, 502, message);
    }
  }

  return {
    async start(target, startOptions = {}) {
      dropPending(target);
      failures.delete(target.id);
      starting += 1;
      try {
        const slot = chatGptSignInSlot(target.id);
        // Checked before the browser opens: tokens that can't be saved would
        // be lost after the person approved.
        const possible = await credentialStore().canSave(slot);
        if (!possible.ok) throw new ChatGptPlanError("sign_in_unsaved", possible.refused.message);
        const claimed = await claimSignIn(slot, CHATGPT_SIGN_IN_ENDPOINT, keptByClaim);
        if (!claimed.ok) throw new ChatGptPlanError("sign_in_unsaved", claimed.refused.message);
        const saved = chatGptDetails(claimed.details);
        const { authorization_endpoint } = await chatGptDiscovery();
        const { port } = await openListener();
        const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const state = random();
        const nonce = random();
        const verifier = random();
        const url = new URL(authorization_endpoint);
        url.search = new URLSearchParams({
          client_id: saved.clientId ?? DYNAMIC_CLIENT,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: CHATGPT_SCOPES,
          resource: CHATGPT_RESOURCE,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          ext_agent_host_id: hostId(),
          ...(saved.clientId ? {} : { agent_name_hint: AGENT_NAME }),
          // The email, never the retained ID token: a browser URL ends up in
          // process arguments and history.
          ...(saved.email ? { login_hint: saved.email } : {}),
          ...(startOptions.planUsage ? { prompt: "consent" } : {}),
        }).toString();
        // A sign-out or a newer attempt while ChatGPT's settings were read wins.
        if (!(await claimed.attempt.current())) throw new ChatGptPlanError("cancelled", "The sign-in was cancelled.");
        const timer = setTimeout(() => finish(state, "The sign-in timed out. Start it again."), PENDING_TIMEOUT_MS);
        timer.unref();
        pending.set(state, {
          target,
          attempt: claimed.attempt,
          nonce,
          verifier,
          redirectUri,
          clientId: saved.clientId,
          subject: saved.subject,
          email: saved.email,
          timer,
        });
        return url.href;
      } finally {
        starting -= 1;
        closeListenerIfIdle();
      }
    },

    async status(target) {
      if ([...pending.values()].some((entry) => sameTarget(entry.target, target))) return { state: "pending" };
      const record = await credentialStore().inspect(chatGptSignInSlot(target.id));
      const problem = signInProblem(record);
      if (problem) return { state: "signed-out", message: problem };
      const message = failures.get(target.id);
      const extra = message ? { message } : {};
      if (record.state !== "live" || !record.parts.includes(TOKENS_PART)) return { state: "signed-out", ...extra };
      const saved = chatGptDetails(record.metadata);
      const note = message ?? signInWarning(record);
      return {
        state: "signed-in",
        ...(saved.email ? { email: saved.email } : {}),
        planUsage: saved.scopes?.includes(PLAN_SCOPE) === true,
        ...(note ? { message: note } : {}),
      };
    },

    async signOut(target) {
      dropPending(target);
      closeListenerIfIdle();
      failures.delete(target.id);
      // Taken out of use first, so no request starts on a session being
      // ended; the tokens come back still protected, to revoke them.
      const ended = await endSignIn(chatGptSignInSlot(target.id), [TOKENS_PART], (current) =>
        chatGptSignInWrite(withoutTokens(chatGptDetails(current.metadata))),
      );
      if (!ended) return { revoked: true };
      if (ended.unreadable) return { revoked: false };
      if (!ended.taken) return { revoked: true };
      let signIn: ChatGptSignIn;
      try {
        signIn = chatGptSignInOf(ended.details, await credentialStore().open(ended.taken));
      } catch {
        return { revoked: false };
      }
      return { revoked: await revokeChatGptSignIn(signIn) };
    },

    async close() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      const closing = listening;
      listening = undefined;
      if (!closing) return;
      const { server } = await closing;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function page(res: ServerResponse, status: number, text: string): void {
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Pragma</title>` +
      `<body style="font: 16px/1.5 system-ui, sans-serif; margin: 3rem"><p>${escaped}</p></body>`,
  );
}

/** The sign-in target for a `chatgpt` provider entry. */
export function chatGptSignInTarget(entry: { id: string; label?: string }): ChatGptSignInTarget {
  return { id: entry.id, label: entry.label ?? entry.id };
}

export const chatGptSignIns = createChatGptSignIns();
