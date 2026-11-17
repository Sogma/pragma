// The credential store this process uses, and how a connection finds its key:
// the store first, then, for a vendor's own endpoint only, the vendor's
// environment variable. A stored key that can't be used here blocks that
// variable rather than quietly giving way to it.
import { randomBytes } from "node:crypto";
import type { CredentialStoreDescription, ProviderKind } from "../protocol/api.ts";
import {
  type CheckedState,
  type Committed,
  type CredentialSlot,
  type CredentialStore,
  type CredentialWrite,
  canonicalEndpoint,
  createFileCredentialStore,
  type Metadata,
  type MetadataValue,
  type Refusal,
  type SlotState,
  type Taken,
  withEndpointNeeded,
} from "./credentialStore.ts";
import { environmentKey, globalConfigDir, signsIn, VENDOR_BASE_URLS, withConfigMutationLock } from "./loadConfig.ts";

let installed: CredentialStore | undefined;

/** Installs the store, once at startup: the desktop app's encrypted one. */
export function setCredentialStore(store: CredentialStore): void {
  installed = store;
}

/** The installed store; the plain one in the config folder by default. */
export function credentialStore(): CredentialStore {
  installed ??= createFileCredentialStore({ backing: "plain", root: globalConfigDir });
  return installed;
}

// ── This host ───────────────────────────────────────────────────────────
//
// Which host this process is, for the messages that say how to supply a
// credential: hosts started from a terminal keep their own keys and
// sign-ins, apart from the desktop app's, and a sign-in finishes only where
// its page returns to a browser on the same machine.

/** desktop: the app. local: `pragma dev`, or `pragma start` for this machine.
 * remote: `pragma start --external-url`. terminal: a command with no
 * Settings, such as `pragma run`. */
export type CredentialHost = "desktop" | "local" | "remote" | "terminal";

let host: CredentialHost = "terminal";

/** Says which host this process is, once at startup. */
export function setCredentialHost(next: CredentialHost): void {
  host = next;
}

/** What adds a missing key or token on this host, said after the message
 * naming what is missing: nothing on the desktop, whose message links to its
 * setting, and a vendor's variable where one is read. */
export function credentialHint(noun: "key" | "token", variable?: string): string {
  if (host === "desktop") return "";
  const apart = `${noun === "key" ? "Keys" : "Tokens"} saved in the desktop app aren't used here`;
  if (host !== "terminal") return ` ${apart}${variable ? `, but ${variable} is` : ""}.`;
  return variable
    ? ` ${apart}: set ${variable}, or add the ${noun} in Settings in \`pragma dev\`.`
    : ` ${apart}: add the ${noun} in Settings in \`pragma dev\`, or write its record as docs/deployment.md shows.`;
}

const ON_THIS_MACHINE = "`pragma dev` on the machine this host runs on, as the account it runs as";

/** How to sign in to `service` again on this host. */
export function signInAgain(service: string, page: string): string {
  switch (host) {
    case "desktop":
      return `Sign in to ${service} again in Settings → ${page}.`;
    case "local":
      return `Sign in to ${service} again in Settings → ${page}. Sign-ins made in the desktop app aren't used here.`;
    case "remote":
      return `Sign in to ${service} again from ${ON_THIS_MACHINE}.`;
    case "terminal":
      return `Sign in to ${service} again in Settings → ${page} in \`pragma dev\`. Sign-ins made in the desktop app aren't used here.`;
  }
}

/** Why a host whose sign-in page can't return to the person's browser
 * refuses to start a sign-in. */
export const SIGN_IN_ELSEWHERE = `Signing in needs ${ON_THIS_MACHINE}: the sign-in page returns there.`;

export type KeyLookup = { found: true; key: string; source: "stored" | "env" } | { found: false; problem?: string };

export interface KeyStatus {
  source: "stored" | "env" | "none" | "unreadable";
  problem?: string;
}

interface ProviderEntry {
  id: string;
  kind?: ProviderKind;
  baseURL?: string;
}

const providerSlot = (id: string): CredentialSlot => ({ kind: "provider-keys", id });
const publisherSlot = (id: string): CredentialSlot => ({ kind: "publisher-keys", id });
const mcpSlot = (id: string): CredentialSlot => ({ kind: "mcp-tokens", id });

/** The endpoint a provider's key is bound to: its base URL, or the vendor's
 * own. Undefined for a kind that signs in instead, or a malformed URL. */
export function providerEndpoint(entry: Pick<ProviderEntry, "kind" | "baseURL">): string | undefined {
  const url = entry.baseURL || (entry.kind ? VENDOR_BASE_URLS[entry.kind] : undefined);
  if (!url || signsIn(entry.kind)) return undefined;
  try {
    return canonicalEndpoint(url);
  } catch {
    return undefined;
  }
}

/** An endpoint URL as a credential binds it, or undefined when it is missing or
 * malformed. */
export function canonicalEndpointOrUndefined(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return canonicalEndpoint(url);
  } catch {
    return undefined;
  }
}

async function lookup(slot: CredentialSlot, endpoint: string | undefined, fallback?: string): Promise<KeyLookup> {
  if (!endpoint) return fallback ? { found: true, key: fallback, source: "env" } : { found: false };
  const selected = await credentialStore().select(slot, endpoint);
  if (selected.ok) {
    const key = selected.secrets.key;
    return key ? { found: true, key, source: "stored" } : { found: false };
  }
  const { state } = selected;
  if (state.state === "absent" || state.state === "cleared") {
    return fallback ? { found: true, key: fallback, source: "env" } : { found: false };
  }
  return { found: false, problem: "message" in state ? state.message : "The saved key can't be used here." };
}

/** A provider's key for a request to its endpoint. */
export function providerKey(entry: ProviderEntry): Promise<KeyLookup> {
  if (signsIn(entry.kind)) return Promise.resolve({ found: false });
  return lookup(providerSlot(entry.id), providerEndpoint(entry), environmentKey(entry));
}

/** A publisher's key for a request to its base URL. No publisher kind has an
 * environment variable. */
export function publisherKey(entry: { id: string; baseURL?: string }): Promise<KeyLookup> {
  return lookup(publisherSlot(entry.id), canonicalEndpointOrUndefined(entry.baseURL));
}

/** An MCP server's bearer token for a request to its URL. */
export function mcpToken(entry: { id: string; url?: string }): Promise<KeyLookup> {
  return lookup(mcpSlot(entry.id), canonicalEndpointOrUndefined(entry.url));
}

// What a failed read of a saved key or sign-in in this process means for it.
function checkProblem(checked: CheckedState, saved: "key" | "sign-in"): string | undefined {
  const fix = saved === "key" ? "Enter it again." : "Sign in again.";
  switch (checked) {
    case "unchecked":
    case "ok":
      return undefined;
    case "cannot-decrypt":
      return `The saved ${saved} can't be decrypted here. ${fix}`;
    case "unknown-protection":
      return `The saved ${saved} was protected in a way Pragma doesn't know. ${fix}`;
    case "timeout":
      return `The keychain didn't answer when the ${saved} was last read. Try again.`;
    case "unavailable":
      return "The keychain isn't available right now.";
    case "unprotected":
      return `The keychain isn't protecting ${saved}s right now.`;
    default:
      return `The saved ${saved} can't be used here. ${fix}`;
  }
}

// A saved credential that still opens, but couldn't be protected anew when
// the keychain asked.
const reprotectFailed = (saved: "key" | "sign-in"): string =>
  `The keychain asked to protect the saved ${saved} anew, and that failed. It still works; ${
    saved === "key" ? "enter it again" : "sign in again"
  } to protect it anew.`;

async function status(slot: CredentialSlot, endpoint: string | undefined, hasFallback: boolean): Promise<KeyStatus> {
  const state = withEndpointNeeded(await credentialStore().inspect(slot), endpoint);
  if (state.state === "unreadable") return { source: "unreadable", problem: state.message };
  if (state.state === "live") {
    if (endpoint === undefined || state.endpoint !== endpoint) {
      return { source: "unreadable", problem: "The saved key was entered for another endpoint. Enter it again." };
    }
    const problem = checkProblem(state.checked, "key");
    if (problem) return { source: "unreadable", problem };
    return state.reprotectFailed ? { source: "stored", problem: reprotectFailed("key") } : { source: "stored" };
  }
  return { source: hasFallback ? "env" : "none" };
}

/** Where a provider's key would come from, for Settings: from the record
 * alone, never asking the keychain. */
export function providerKeyStatus(entry: ProviderEntry): Promise<KeyStatus> {
  if (signsIn(entry.kind)) return Promise.resolve({ source: "none" });
  return status(providerSlot(entry.id), providerEndpoint(entry), Boolean(environmentKey(entry)));
}

export function publisherKeyStatus(entry: { id: string; baseURL?: string }): Promise<KeyStatus> {
  return status(publisherSlot(entry.id), canonicalEndpointOrUndefined(entry.baseURL), false);
}

export function mcpTokenStatus(entry: { id: string; url?: string }): Promise<KeyStatus> {
  return status(mcpSlot(entry.id), canonicalEndpointOrUndefined(entry.url), false);
}

/** How a store's protection reads in Settings: whether keys rest encrypted,
 * and whether saving is known to be impossible here. */
export function credentialStoreDescription(): CredentialStoreDescription {
  const store = credentialStore();
  const encrypted = store.backing === "encrypted";
  return { kind: encrypted ? "safe-storage" : "plain-files", encrypted, available: !store.savingKnownUnavailable() };
}

export type CredentialSaveResult = { ok: true } | { ok: false; status: 400 | 409 | 500; message: string };

export interface CredentialSave {
  kind: "provider-keys" | "publisher-keys" | "mcp-tokens";
  id: string;
  endpoint: string | undefined;
  secret: string;
  // The service's verdict on the key, asked only once protection is known to
  // work: a message when it refused the key, undefined otherwise.
  verify?: () => Promise<string | undefined>;
  // Writes the connection's own settings, from fresh config.
  publish: () => void;
}

/** Saves a key and its connection in the order that can't leave a half-saved
 * connection: protection is checked and the key verified before either file
 * changes, then the key is committed, then the connection. If the connection
 * can't be written, a key this save created is withdrawn again. */
export async function saveCredential(save: CredentialSave): Promise<CredentialSaveResult> {
  if (!save.endpoint) return { ok: false, status: 400, message: "This connection needs a valid http or https URL." };
  const store = credentialStore();
  const slot: CredentialSlot = { kind: save.kind, id: save.id };
  const seen = await store.inspect(slot);
  const possible = await store.canSave(slot);
  if (!possible.ok) return { ok: false, status: 400, message: possible.refused.message };
  const rejection = save.verify ? await save.verify() : undefined;
  if (rejection) return { ok: false, status: 400, message: rejection };
  return withConfigMutationLock(async () => {
    const committed = await store.set(slot, seen.observation, {
      endpoint: save.endpoint,
      secrets: { key: save.secret },
    });
    if (!committed.ok) {
      return "refused" in committed
        ? { ok: false, status: 400, message: committed.refused.message }
        : { ok: false, status: 409, message: "The key changed while this one was saved. Try again." };
    }
    try {
      save.publish();
      return { ok: true };
    } catch (error) {
      const created = seen.state === "absent" || seen.state === "cleared";
      if (created) await store.clear(slot, committed.observation);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: 500,
        message: created
          ? `The connection couldn't be saved, so the key wasn't kept: ${reason}`
          : `The new key was saved, but the connection's settings weren't: ${reason}. Save again.`,
      };
    }
  });
}

// ── Sign-ins ────────────────────────────────────────────────────────────
//
// A sign-in attempt claims its slot by writing a fresh attempt id into the
// record's details, and each later write of the attempt lands only while the
// record still carries that id. A sign-out, a removal or a newer attempt in
// any process drops the id and so ends the attempt. A renewal carries the
// id over, so renewing the sign-in an attempt will replace doesn't end it.

const ATTEMPT = "attempt";
const CONFLICT_RETRIES = 5;

/** The part a sign-in's tokens rest in. */
export const TOKENS_PART = "tokens";

export type LiveSignIn = Extract<SlotState, { state: "live" }>;

export type AttemptWrite = { ok: true } | { ok: false; cancelled: true } | { ok: false; refused: Refusal };

export interface SignInAttempt {
  /** The record while it still carries this attempt. */
  current(): Promise<LiveSignIn | undefined>;
  /** Writes what `build` makes of the record while it carries this attempt;
   * a `final` write ends the attempt's claim. */
  write(build: (current: LiveSignIn) => CredentialWrite, options?: { final?: boolean }): Promise<AttemptWrite>;
}

/** Details as a record keeps them: the values that are set. */
export function metadataOf(values: Record<string, MetadataValue | undefined>): Metadata {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, MetadataValue] => entry[1] !== undefined),
  );
}

function withoutAttempt(metadata: Metadata | undefined): Metadata {
  const { [ATTEMPT]: _attempt, ...rest } = metadata ?? {};
  return rest;
}

/** `next` with the attempt claim `previous` carried, for a renewal writing
 * over the record it read. */
export function carryingAttempt(previous: Metadata | undefined, next: Metadata): Metadata {
  const attempt = previous?.[ATTEMPT];
  return attempt === undefined ? withoutAttempt(next) : { ...withoutAttempt(next), [ATTEMPT]: attempt };
}

/** Starts an attempt on `slot` by writing what `build` makes of the record as
 * it stands, with a fresh attempt id; `details` is what that wrote. */
export async function claimSignIn(
  slot: CredentialSlot,
  endpoint: string,
  build: (current: SlotState) => CredentialWrite,
): Promise<{ ok: true; attempt: SignInAttempt; details: Metadata } | { ok: false; refused: Refusal }> {
  const store = credentialStore();
  const id = randomBytes(12).toString("base64url");
  for (let tries = 0; tries < CONFLICT_RETRIES; tries += 1) {
    const current = await store.inspect(slot);
    const write = build(current);
    const details = withoutAttempt(write.metadata);
    const committed = await store.set(slot, current.observation, {
      ...write,
      endpoint,
      metadata: { ...details, [ATTEMPT]: id },
    });
    if (committed.ok) return { ok: true, attempt: attemptOn(slot, endpoint, id), details };
    if ("refused" in committed) return { ok: false, refused: committed.refused };
  }
  throw new Error("The sign-in couldn't start: its saved state kept changing. Try again.");
}

function attemptOn(slot: CredentialSlot, endpoint: string, id: string): SignInAttempt {
  const store = credentialStore();
  const carries = (state: SlotState): state is LiveSignIn =>
    state.state === "live" && state.endpoint === endpoint && state.metadata?.[ATTEMPT] === id;
  return {
    async current() {
      const state = await store.inspect(slot);
      return carries(state) ? state : undefined;
    },
    async write(build, options = {}) {
      for (let tries = 0; tries < CONFLICT_RETRIES; tries += 1) {
        const state = await store.inspect(slot);
        if (!carries(state)) return { ok: false, cancelled: true };
        const write = build(state);
        const details = withoutAttempt(write.metadata);
        const committed = await store.set(slot, state.observation, {
          ...write,
          endpoint,
          metadata: options.final ? details : { ...details, [ATTEMPT]: id },
        });
        if (committed.ok) return { ok: true };
        if ("refused" in committed) return { ok: false, refused: committed.refused };
      }
      return { ok: false, cancelled: true };
    },
  };
}

export type EndedSignIn =
  | { unreadable: true }
  | { unreadable?: undefined; details: Metadata; endpoint?: string; taken?: Taken };

/** Takes a sign-in out of use ahead of any attempt or renewal: writes what
 * `build` makes of the record, bound where it was unless it says otherwise,
 * or a clear marker, and hands back the parts in `take` as they rested, for
 * revoking. Undefined when nothing was in use; an unreadable record is cleared. */
export async function endSignIn(
  slot: CredentialSlot,
  take: string[],
  build: (current: LiveSignIn) => CredentialWrite | "clear",
): Promise<EndedSignIn | undefined> {
  const store = credentialStore();
  for (let tries = 0; tries < CONFLICT_RETRIES; tries += 1) {
    const state = await store.inspect(slot);
    if (state.state === "absent" || state.state === "cleared") return undefined;
    let committed: Committed;
    if (state.state === "unreadable") {
      committed = await store.clear(slot, state.observation);
      if (committed.ok) return { unreadable: true };
    } else {
      const inUse = take.some((part) => state.parts.includes(part)) || state.metadata?.[ATTEMPT] !== undefined;
      if (!inUse) return undefined;
      const write = build(state);
      committed =
        write === "clear"
          ? await store.clear(slot, state.observation, take)
          : await store.set(slot, state.observation, {
              endpoint: state.endpoint,
              ...write,
              metadata: withoutAttempt(write.metadata),
              take,
            });
      if (committed.ok) {
        return {
          details: withoutAttempt(state.metadata),
          ...(state.endpoint ? { endpoint: state.endpoint } : {}),
          ...(committed.taken ? { taken: committed.taken } : {}),
        };
      }
    }
    if ("refused" in committed) throw new Error(committed.refused.message);
  }
  throw new Error("The sign-out couldn't be saved: the sign-in kept changing. Try again.");
}

/** Why a saved sign-in can't be used here, from its record alone. */
export function signInProblem(state: SlotState): string | undefined {
  if (state.state === "unreadable") return `The saved sign-in can't be used: ${state.message}`;
  return state.state === "live" ? checkProblem(state.checked, "sign-in") : undefined;
}

/** A warning about a saved sign-in that still works. */
export function signInWarning(state: SlotState): string | undefined {
  return state.state === "live" && state.reprotectFailed ? reprotectFailed("sign-in") : undefined;
}

// ── The remote-access passphrase ────────────────────────────────────────

/** The remote-access passphrase from its fixed slot in this process's store,
 * or why there is none to use. */
export async function remoteAccessPassphrase(): Promise<
  { ok: true; passphrase: string; cookieSecret: string } | { ok: false; problem: string }
> {
  const store = credentialStore();
  const slot: CredentialSlot = { kind: "remote-access-passphrase" };
  const selected = await store.select(slot);
  if (selected.ok && selected.secrets.passphrase) {
    const { passphrase, cookieSecret } = selected.secrets;
    if (cookieSecret) return { ok: true, passphrase, cookieSecret };
    return { ok: false, problem: `The record in ${store.where(slot)} has no cookie secret.` };
  }
  if (!selected.ok && selected.state.state === "unreadable") return { ok: false, problem: selected.state.message };
  return { ok: false, problem: `No passphrase is saved in ${store.where(slot)}.` };
}
