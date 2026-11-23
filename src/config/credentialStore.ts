// Where credentials rest: one JSON record per credential under
// `<config dir>/credentials/<backing>/`, never in config.json. The desktop app
// uses the `encrypted` backing and the terminal targets the `plain` one, and a
// process only ever opens its own, so a terminal run never mistakes the
// desktop's records for its own.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ProtectionError,
  type ProtectionFailure,
  type Protector,
  type SaveCheck,
  type SealedPart,
} from "./credentialProtector.ts";
import { withFileLock } from "./fileLock.ts";

export const CREDENTIAL_KINDS = [
  "provider-keys",
  "provider-sign-ins",
  "publisher-keys",
  "mcp-tokens",
  "mcp-sign-ins",
  "sharing-keys",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type CredentialSlot = { kind: CredentialKind; id: string } | { kind: "remote-access-passphrase" };
export type Backing = "plain" | "encrypted";

export type MetadataValue = string | number | boolean | null | string[];
export type Metadata = Record<string, MetadataValue>;

/** What a caller saw of a slot. A change hands it back and lands only if the
 * slot still looks that way, so a stale write can't undo a newer one. */
export type Observation = { revision: string } | { absent: true } | { bytes: string };

export type UnreadableReason =
  | "malformed"
  | "newer-format"
  | "identity-mismatch"
  | "invalid-binding"
  | "wrong-store"
  | "unsafe-permissions"
  | "endpoint-changed"
  | ProtectionFailure;

export type CheckedState = "unchecked" | "ok" | UnreadableReason;

export type SlotState =
  | { state: "absent"; observation: Observation }
  | { state: "cleared"; observation: Observation }
  | {
      state: "live";
      observation: Observation;
      endpoint?: string;
      metadata?: Metadata;
      parts: string[];
      checked: CheckedState;
      reprotectFailed?: true;
    }
  | { state: "unreadable"; observation: Observation; reason: UnreadableReason; message: string };

export type Selected =
  | { ok: true; secrets: Record<string, string>; metadata?: Metadata; observation: Observation }
  | { ok: false; state: SlotState };

export type Refusal = {
  reason: "unavailable" | "unprotected" | "timeout" | "unsafe-permissions" | "invalid-binding";
  message: string;
};

/** Parts a change took out of the record, as they rested: opened only to
 * revoke them, never to make a request. */
export type Taken = { plain: Record<string, string> } | { sealed: Record<string, SealedPart> };

export type Committed =
  | { ok: true; observation: Observation; taken?: Taken }
  | { ok: false; conflict: Observation }
  | { ok: false; refused: Refusal };

export interface CredentialWrite {
  endpoint?: string;
  metadata?: Metadata;
  // Parts written now, in plain text; the encrypted backing seals each. A
  // sign-in may write none and keep only its details between sign-ins.
  secrets: Record<string, string>;
  // Parts carried over from the current record without opening them, so a
  // sign-out can drop tokens and keep a protected registration.
  keep?: string[];
  // Parts of the replaced record handed back in `taken`, so a sign-out ends
  // local use at once and asks the keychain only afterwards, to revoke them.
  take?: string[];
}

export interface CredentialStore {
  readonly backing: Backing;
  /** Whether saving now is possible, checked before anything changes: the
   * folders' safety and, for the encrypted backing, genuine protection. */
  canSave(slot: CredentialSlot): Promise<{ ok: true } | { ok: false; refused: Refusal }>;
  /** Whether keys can be saved here, as far as known without asking the
   * keychain: false only once a check has failed in this process. */
  savingKnownUnavailable(): boolean;
  /** The slot's state from its record alone: never asks the keychain. */
  inspect(slot: CredentialSlot): Promise<SlotState>;
  /** The slot's secrets, for a request to `endpoint`; absent for the passphrase. */
  select(slot: CredentialSlot, endpoint?: string): Promise<Selected>;
  set(slot: CredentialSlot, expected: Observation, write: CredentialWrite): Promise<Committed>;
  /** Leaves a marker with a fresh revision, so no stale change brings the
   * credential back. Without `expected` it always lands. */
  clear(slot: CredentialSlot, expected?: Observation, take?: string[]): Promise<Committed>;
  /** Opens parts a change took, for revoking them. */
  open(taken: Taken): Promise<Record<string, string>>;
  /** Where the slot's record rests, for a message that names it. */
  where(slot: CredentialSlot): string;
  /** Runs `run` holding the slot's renewal lock across processes. */
  withRenewalLock<T>(slot: CredentialSlot, run: () => Promise<T>): Promise<T>;
}

export type FileCredentialStoreOptions =
  | { backing: "plain"; root: () => string; platform?: NodeJS.Platform; home?: () => string }
  | { backing: "encrypted"; root: () => string; protector: Protector; platform?: NodeJS.Platform };

const FORMAT_VERSION = "1.0";
const SUPPORTED_MAJOR = 1;
const READ_ATTEMPTS = 3;
const RENEWAL_WAIT_MS = 120_000;

interface RecordJson {
  version?: unknown;
  kind?: unknown;
  id?: unknown;
  revision?: unknown;
  updatedAt?: unknown;
  state?: unknown;
  endpoint?: unknown;
  metadata?: unknown;
  secrets?: unknown;
  sealed?: unknown;
}

interface ParsedRecord {
  revision: string;
  state: "live" | "cleared";
  endpoint?: string;
  metadata?: Metadata;
  secrets: Record<string, string>;
  sealed: Record<string, SealedPart>;
}

type ReadResult =
  | { kind: "absent" }
  | { kind: "record"; record: ParsedRecord }
  | { kind: "unreadable"; digest?: string; reason: UnreadableReason; message: string };

class UnsafeStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStorageError";
  }
}

/** A credential id as one file name: lowercase letters, digits, `-` and `_`
 * stay, every other byte is percent-encoded with uppercase hex, behind an
 * `id-` prefix. No name is `.`, `..` or a Windows device name, and no two ids
 * differ only in case, which a case-insensitive disk would merge. */
export function encodeCredentialId(id: string): string {
  if (!id) throw new Error("A credential id can't be empty.");
  let encoded = "id-";
  for (const byte of Buffer.from(id, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /[a-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (encoded.length > 200) throw new Error(`The credential id "${id}" is too long.`);
  return encoded;
}

/** The endpoint a credential is bound to, compared as text: scheme, host,
 * port, path and query, with the default port and a trailing slash dropped.
 * A URL carrying a user name or password is refused. */
export function canonicalEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid endpoint URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`"${url}" must be an http or https URL.`);
  }
  if (parsed.username || parsed.password) throw new Error("An endpoint URL can't carry a user name or password.");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

export function createFileCredentialStore(options: FileCredentialStoreOptions): CredentialStore {
  const { backing } = options;
  const platform = options.platform ?? process.platform;
  const protector = options.backing === "encrypted" ? options.protector : undefined;
  // What this process last read of each slot, by revision, for "stored, last
  // read succeeded" in Settings without asking the keychain again.
  const checks = new Map<string, { revision: string; checked: CheckedState; reprotectFailed?: true }>();

  const credentialsDir = () => path.join(options.root(), "credentials");
  const backingDir = () => path.join(credentialsDir(), backing);
  const slotKey = (slot: CredentialSlot) =>
    slot.kind === "remote-access-passphrase" ? slot.kind : `${slot.kind}/${slot.id}`;
  const slotFile = (slot: CredentialSlot) =>
    slot.kind === "remote-access-passphrase"
      ? path.join(backingDir(), "remote-access-passphrase.json")
      : path.join(backingDir(), slot.kind, `${encodeCredentialId(slot.id)}.json`);
  const commitLock = () => path.join(backingDir(), ".commit.lock");

  // Windows has no mode bits, so its plain backing stays inside the user's
  // profile, which Windows already keeps to that account.
  function checkLocation(): void {
    if (platform !== "win32" || backing !== "plain") return;
    const home = options.backing === "plain" && options.home ? options.home() : homedir();
    const relative = path.relative(path.resolve(home), path.resolve(options.root()));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new UnsafeStorageError(
        `Keep Pragma's config folder inside your user profile (${home}) to save credentials.`,
      );
    }
  }

  // Owner-only folders all the way down, created that way or refused.
  function ensureFolders(slot: CredentialSlot, create: boolean): boolean {
    checkLocation();
    const folders = [credentialsDir(), backingDir()];
    if (slot.kind !== "remote-access-passphrase") folders.push(path.join(backingDir(), slot.kind));
    for (const folder of folders) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return false;
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new UnsafeStorageError(`${folder} must be a folder, not a link.`);
      if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new UnsafeStorageError(`${folder} is readable by other accounts. Run: chmod 700 "${folder}"`);
      }
    }
    return true;
  }

  function read(slot: CredentialSlot): ReadResult {
    try {
      if (!ensureFolders(slot, false)) return { kind: "absent" };
    } catch (error) {
      if (error instanceof UnsafeStorageError)
        return { kind: "unreadable", reason: "unsafe-permissions", message: error.message };
      throw error;
    }
    const file = slotFile(slot);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: "unreadable", reason: "unsafe-permissions", message: `${file} must be a file, not a link.` };
    }
    const raw = readFileSync(file);
    const digest = createHash("sha256").update(raw).digest("hex");
    if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return {
        kind: "unreadable",
        digest,
        reason: "unsafe-permissions",
        message: `${file} is readable by other accounts, so its credential may have been copied. Run: chmod 600 "${file}"`,
      };
    }
    const parsed = parseRecord(raw.toString("utf8"), slot, backing);
    return "reason" in parsed
      ? { kind: "unreadable", digest, reason: parsed.reason, message: `${file} ${parsed.message}` }
      : { kind: "record", record: parsed };
  }

  const observationOf = (result: ReadResult): Observation =>
    result.kind === "absent"
      ? { absent: true }
      : result.kind === "record"
        ? { revision: result.record.revision }
        : { bytes: result.digest ?? "unreadable" };

  function stateOf(slot: CredentialSlot, result: ReadResult): SlotState {
    const observation = observationOf(result);
    if (result.kind === "absent") return { state: "absent", observation };
    if (result.kind === "unreadable")
      return { state: "unreadable", observation, reason: result.reason, message: result.message };
    const { record } = result;
    if (record.state === "cleared") return { state: "cleared", observation };
    const check = checks.get(slotKey(slot));
    const current = check?.revision === record.revision ? check : undefined;
    return {
      state: "live",
      observation,
      ...(record.endpoint ? { endpoint: record.endpoint } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      parts: Object.keys(backing === "plain" ? record.secrets : record.sealed),
      checked: current?.checked ?? "unchecked",
      ...(current?.reprotectFailed ? { reprotectFailed: true as const } : {}),
    };
  }

  function writeRecord(slot: CredentialSlot, record: RecordJson): void {
    ensureFolders(slot, true);
    const file = slotFile(slot);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
    // Created owner-only and exclusive before a byte of the secret goes in.
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  const freshRecord = (
    slot: CredentialSlot,
    fields: Omit<RecordJson, "version" | "kind" | "id" | "revision" | "updatedAt">,
  ): RecordJson => ({
    version: FORMAT_VERSION,
    kind: slot.kind,
    ...(slot.kind === "remote-access-passphrase" ? {} : { id: slot.id }),
    revision: randomBytes(16).toString("base64url"),
    updatedAt: new Date().toISOString(),
    ...fields,
  });

  // The short commit: re-read, compare with what the caller saw, write. Slow
  // work (sealing, a network call) happens before it, never inside. Folders
  // others can read refuse every write, whatever the caller saw.
  async function commit(
    slot: CredentialSlot,
    expected: Observation | undefined,
    build: (current: ReadResult) => RecordJson,
    take: string[] = [],
  ): Promise<Committed> {
    try {
      checkLocation();
      return await withFileLock(commitLock(), async () => {
        ensureFolders(slot, true);
        const current = read(slot);
        const seen = observationOf(current);
        if (expected && !sameObservation(seen, expected)) return { ok: false, conflict: seen };
        const record = build(current);
        writeRecord(slot, record);
        const taken = takenFrom(current, take);
        return { ok: true, observation: { revision: record.revision as string }, ...(taken ? { taken } : {}) };
      });
    } catch (error) {
      if (error instanceof UnsafeStorageError)
        return { ok: false, refused: { reason: "unsafe-permissions", message: error.message } };
      throw error;
    }
  }

  function takenFrom(current: ReadResult, take: string[]): Taken | undefined {
    if (take.length === 0 || current.kind !== "record" || current.record.state !== "live") return undefined;
    if (backing === "plain") {
      const plain = pick(current.record.secrets, take);
      return Object.keys(plain).length > 0 ? { plain } : undefined;
    }
    const sealed = pick(current.record.sealed, take);
    return Object.keys(sealed).length > 0 ? { sealed } : undefined;
  }

  function noteCheck(slot: CredentialSlot, revision: string, checked: CheckedState, reprotectFailed?: true): void {
    checks.set(slotKey(slot), { revision, checked, ...(reprotectFailed ? { reprotectFailed } : {}) });
  }

  async function reseal(slot: CredentialSlot, revision: string, secrets: Record<string, string>): Promise<void> {
    if (!protector) return;
    try {
      const sealed: Record<string, SealedPart> = {};
      for (const [part, value] of Object.entries(secrets)) sealed[part] = await protector.seal(value);
      await commit(slot, { revision }, (current) => {
        const record = current.kind === "record" ? current.record : undefined;
        return freshRecord(slot, {
          state: "live",
          ...(record?.endpoint ? { endpoint: record.endpoint } : {}),
          ...(record?.metadata ? { metadata: record.metadata } : {}),
          sealed,
        });
      });
    } catch {
      // The old value still opens; Settings says it couldn't be re-protected.
      noteCheck(slot, revision, "ok", true);
    }
  }

  return {
    backing,

    async canSave(slot) {
      try {
        checkLocation();
        ensureFolders(slot, false);
      } catch (error) {
        if (error instanceof UnsafeStorageError)
          return { ok: false, refused: { reason: "unsafe-permissions", message: error.message } };
        throw error;
      }
      if (!protector) return { ok: true };
      const check = await protector.canSave();
      return check.ok ? { ok: true } : { ok: false, refused: { reason: check.reason, message: check.message } };
    },

    savingKnownUnavailable() {
      return protector?.lastCheck()?.ok === false;
    },

    where: slotFile,

    async inspect(slot) {
      return stateOf(slot, read(slot));
    },

    async select(slot, endpoint) {
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const before = read(slot);
        const state = stateOf(slot, before);
        if (before.kind !== "record" || before.record.state !== "live") {
          return { ok: false, state: withEndpointNeeded(state, endpoint) };
        }
        const { record } = before;
        if (slot.kind !== "remote-access-passphrase") {
          let bound: string | undefined;
          try {
            bound = endpoint === undefined ? undefined : canonicalEndpoint(endpoint);
          } catch {
            bound = undefined;
          }
          if (bound === undefined || bound !== record.endpoint) {
            return {
              ok: false,
              state: {
                state: "unreadable",
                observation: state.observation,
                reason: "endpoint-changed",
                message: "This credential was saved for another endpoint. Enter it again for this one.",
              },
            };
          }
        }
        let secrets: Record<string, string>;
        let resealWanted = false;
        if (backing === "plain") {
          secrets = record.secrets;
        } else {
          secrets = {};
          try {
            for (const [part, sealed] of Object.entries(record.sealed)) {
              const opened = await (protector as Protector).unseal(sealed);
              secrets[part] = opened.value;
              resealWanted ||= opened.reseal;
            }
          } catch (error) {
            const reason: UnreadableReason = error instanceof ProtectionError ? error.failure : "cannot-decrypt";
            noteCheck(slot, record.revision, reason);
            const message = error instanceof Error ? error.message : "This credential could not be decrypted here.";
            return { ok: false, state: { state: "unreadable", observation: state.observation, reason, message } };
          }
        }
        // A clear or replacement while the keychain answered wins: read again.
        if (!sameObservation(observationOf(read(slot)), state.observation)) continue;
        noteCheck(slot, record.revision, "ok");
        if (resealWanted) void reseal(slot, record.revision, secrets);
        return {
          ok: true,
          secrets,
          ...(record.metadata ? { metadata: record.metadata } : {}),
          observation: state.observation,
        };
      }
      return { ok: false, state: stateOf(slot, read(slot)) };
    },

    async set(slot, expected, write) {
      let endpoint: string | undefined;
      if (slot.kind === "remote-access-passphrase") {
        if (write.endpoint !== undefined)
          return refused("invalid-binding", "The remote-access passphrase isn't bound to an endpoint.");
      } else {
        try {
          endpoint = canonicalEndpoint(write.endpoint ?? "");
        } catch (error) {
          return refused("invalid-binding", (error as Error).message);
        }
      }
      const writing = Object.keys(write.secrets).length > 0;
      if (!writing && !holdsDetailsAlone(slot)) throw new Error("A credential needs a value to save.");
      const sealed: Record<string, SealedPart> = {};
      // Nothing to seal asks nothing of the keychain, so a sign-out still
      // lands while it is locked or slow to answer.
      if (protector && writing) {
        const check: SaveCheck = await protector.canSave();
        if (!check.ok) return refused(check.reason, check.message);
        try {
          for (const [part, value] of Object.entries(write.secrets)) sealed[part] = await protector.seal(value);
        } catch (error) {
          if (error instanceof ProtectionError && (error.failure === "unprotected" || error.failure === "timeout")) {
            return refused(error.failure, error.message);
          }
          throw error;
        }
      }
      return commit(
        slot,
        expected,
        (current) => {
          const previous = current.kind === "record" && current.record.state === "live" ? current.record : undefined;
          const keep = write.keep ?? [];
          return freshRecord(slot, {
            state: "live",
            ...(endpoint ? { endpoint } : {}),
            ...(write.metadata ? { metadata: write.metadata } : {}),
            ...(protector
              ? { sealed: { ...pick(previous?.sealed ?? {}, keep), ...sealed } }
              : { secrets: { ...pick(previous?.secrets ?? {}, keep), ...write.secrets } }),
          });
        },
        write.take,
      );
    },

    async clear(slot, expected, take) {
      return commit(slot, expected, () => freshRecord(slot, { state: "cleared" }), take);
    },

    async open(taken) {
      if ("plain" in taken) return { ...taken.plain };
      if (!protector) throw new Error("Protected parts open only through the encrypted store.");
      const opened: Record<string, string> = {};
      for (const [part, sealed] of Object.entries(taken.sealed)) opened[part] = (await protector.unseal(sealed)).value;
      return opened;
    },

    async withRenewalLock(slot, run) {
      const lock =
        slot.kind === "remote-access-passphrase"
          ? path.join(backingDir(), "remote-access-passphrase.renewal.lock")
          : path.join(backingDir(), slot.kind, `${encodeCredentialId(slot.id)}.renewal.lock`);
      return withFileLock(lock, run, { waitMs: RENEWAL_WAIT_MS });
    },
  };
}

/** `state` with the endpoint its record must name, when it is a record
 * written by hand without a valid one. */
export function withEndpointNeeded(state: SlotState, endpoint: string | undefined): SlotState {
  if (state.state !== "unreadable" || state.reason !== "invalid-binding" || endpoint === undefined) return state;
  try {
    return { ...state, message: `${state.message} For this connection it is "${canonicalEndpoint(endpoint)}".` };
  } catch {
    return state;
  }
}

function refused(reason: Refusal["reason"], message: string): Committed {
  return { ok: false, refused: { reason, message } };
}

// Between sign-ins a sign-in record may keep only its account details and
// registration; a key's record always holds its key.
function holdsDetailsAlone(slot: CredentialSlot): boolean {
  return slot.kind === "provider-sign-ins" || slot.kind === "mcp-sign-ins";
}

function pick<T>(parts: Record<string, T>, names: string[]): Record<string, T> {
  return Object.fromEntries(names.flatMap((name) => (name in parts ? [[name, parts[name]]] : [])));
}

function sameObservation(a: Observation, b: Observation): boolean {
  if ("absent" in a || "absent" in b) return "absent" in a && "absent" in b;
  if ("revision" in a && "revision" in b) return a.revision === b.revision;
  if ("bytes" in a && "bytes" in b) return a.bytes === b.bytes;
  return false;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMetadataValue = (value: unknown): boolean =>
  value === null ||
  ["string", "number", "boolean"].includes(typeof value) ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const unreadable = (reason: UnreadableReason, message: string) => ({ reason, message });

function parseRecord(
  text: string,
  slot: CredentialSlot,
  backing: Backing,
): ParsedRecord | { reason: UnreadableReason; message: string } {
  let json: RecordJson;
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) return unreadable("malformed", "isn't a JSON object.");
    json = value;
  } catch {
    return unreadable("malformed", "isn't valid JSON.");
  }
  // A missing version reads as 1.0; a newer major may change where or how the
  // credential may be used, so it is unreadable rather than guessed at.
  const version = json.version === undefined ? FORMAT_VERSION : json.version;
  const major = typeof version === "string" && /^\d+\.\d+$/.test(version) ? Number(version.split(".")[0]) : Number.NaN;
  if (major !== SUPPORTED_MAJOR) {
    return unreadable("newer-format", "has a format this version of Pragma doesn't read.");
  }
  const id = slot.kind === "remote-access-passphrase" ? undefined : slot.id;
  if (json.kind !== slot.kind || json.id !== id) {
    return unreadable("identity-mismatch", "names a different credential than its file name does.");
  }
  if (typeof json.revision !== "string" || !json.revision || json.revision.length > 200) {
    return unreadable("malformed", "has no valid revision.");
  }
  if (json.state !== "live" && json.state !== "cleared") return unreadable("malformed", "has no valid state.");
  if (
    json.metadata !== undefined &&
    !(isObject(json.metadata) && Object.values(json.metadata).every(isMetadataValue))
  ) {
    return unreadable("malformed", "has details that aren't plain values.");
  }
  const secrets = json.secrets ?? {};
  const sealed = json.sealed ?? {};
  if (!isObject(secrets) || !Object.values(secrets).every((value) => typeof value === "string")) {
    return unreadable("malformed", "has values that aren't text.");
  }
  if (
    !isObject(sealed) ||
    !Object.values(sealed).every(
      (part) =>
        isObject(part) &&
        typeof part.protection === "string" &&
        typeof part.tag === "string" &&
        typeof part.data === "string",
    )
  ) {
    return unreadable("malformed", "has malformed protected values.");
  }
  const hasSecrets = Object.keys(secrets).length > 0;
  const hasSealed = Object.keys(sealed).length > 0;
  if ((backing === "plain" && hasSealed) || (backing === "encrypted" && hasSecrets)) {
    return unreadable(
      "wrong-store",
      backing === "plain"
        ? "holds encrypted values, which only the desktop app opens."
        : "holds plain values, which the desktop app doesn't read.",
    );
  }
  if (json.state === "live") {
    if (!hasSecrets && !hasSealed && !holdsDetailsAlone(slot)) {
      return unreadable("malformed", "holds no value.");
    }
    if (slot.kind !== "remote-access-passphrase") {
      let canonical: string | undefined;
      try {
        canonical = typeof json.endpoint === "string" ? canonicalEndpoint(json.endpoint) : undefined;
      } catch {
        canonical = undefined;
      }
      if (canonical === undefined || canonical !== json.endpoint) {
        return unreadable("invalid-binding", "doesn't name its endpoint the way Pragma writes it.");
      }
    }
  }
  return {
    revision: json.revision,
    state: json.state,
    ...(typeof json.endpoint === "string" ? { endpoint: json.endpoint } : {}),
    ...(json.metadata !== undefined ? { metadata: json.metadata as Metadata } : {}),
    secrets: secrets as Record<string, string>,
    sealed: sealed as Record<string, SealedPart>,
  };
}
