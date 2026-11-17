// How the desktop app protects a credential: Electron's async safeStorage,
// handed in by the Electron host, so the engine never imports Electron and a
// test passes a fake.
//
// What decides protection is the tag each encrypted value starts with, never
// the backend name or the "available" answer: on Linux both say yes while the
// value is sealed with a fixed key from Chromium's source. A tag not listed
// for the platform is refused until it has been checked.

/** The slice of Electron's safeStorage this module uses. */
export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Uint8Array>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** One encrypted value as a record keeps it. */
export interface SealedPart {
  protection: string;
  tag: string;
  data: string;
}

export type SaveCheck =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "unprotected" | "timeout"; message: string };

export interface Protector {
  /** Whether a credential saved now would be protected; may ask the keychain. */
  canSave(): Promise<SaveCheck>;
  /** The last check's answer, if one ran; never asks the keychain. */
  lastCheck(): SaveCheck | undefined;
  seal(plainText: string): Promise<SealedPart>;
  /** `reseal` is the OS asking for the value to be encrypted again. */
  unseal(part: SealedPart): Promise<{ value: string; reseal: boolean }>;
}

export type ProtectionFailure = "unavailable" | "unprotected" | "timeout" | "unknown-protection" | "cannot-decrypt";

export class ProtectionError extends Error {
  readonly failure: ProtectionFailure;

  constructor(failure: ProtectionFailure, message: string) {
    super(message);
    this.name = "ProtectionError";
    this.failure = failure;
  }
}

export const SAFE_STORAGE_PROTECTION = "electron-safe-storage";

// Chromium's key providers: Linux `v10` is the fixed-key fallback, `v11` the
// Secret Service or KWallet, `v12` the Flatpak portal; macOS `v10` is the
// Keychain and Windows `v10` is DPAPI.
const PROTECTED_TAGS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: ["v11", "v12"],
  darwin: ["v10"],
  win32: ["v10"],
};

const PROBE_TEXT = "pragma-protection-probe";
const DEFAULT_TIMEOUT_MS = 60_000;

const NO_KEYRING =
  "No keyring answered, so a key saved here would not be protected. Start or unlock your keyring (GNOME Keyring or KWallet) and try again, or supply the key through its environment variable.";

export interface SafeStorageProtectorOptions {
  safeStorage: AsyncSafeStorage;
  platform?: NodeJS.Platform;
  // How long one keychain call may take before the caller stops waiting.
  timeoutMs?: number;
}

export function createSafeStorageProtector(options: SafeStorageProtectorOptions): Protector {
  const { safeStorage } = options;
  const allowed = PROTECTED_TAGS[options.platform ?? process.platform] ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let probed: Promise<SaveCheck> | undefined;
  let last: SaveCheck | undefined;

  const tagOf = (sealed: Uint8Array): string => Buffer.from(sealed.subarray(0, 3)).toString("latin1");

  async function probe(): Promise<SaveCheck> {
    try {
      if (!(await withTimeout(safeStorage.isAsyncEncryptionAvailable(), timeoutMs))) {
        return { ok: false, reason: "unavailable", message: NO_KEYRING };
      }
      const tag = tagOf(await withTimeout(safeStorage.encryptStringAsync(PROBE_TEXT), timeoutMs));
      if (!allowed.includes(tag)) return { ok: false, reason: "unprotected", message: NO_KEYRING };
      return { ok: true };
    } catch (error) {
      if (error instanceof ProtectionError && error.failure === "timeout") {
        return { ok: false, reason: "timeout", message: error.message };
      }
      return { ok: false, reason: "unavailable", message: NO_KEYRING };
    }
  }

  return {
    canSave() {
      // A passing probe holds for the process; a failing one runs again on the
      // next save, after the person has had a chance to fix it.
      probed ??= probe().then((check) => {
        last = check;
        if (!check.ok) probed = undefined;
        return check;
      });
      return probed;
    },

    lastCheck() {
      return last;
    },

    async seal(plainText) {
      const sealed = await withTimeout(safeStorage.encryptStringAsync(plainText), timeoutMs);
      const tag = tagOf(sealed);
      if (!allowed.includes(tag)) throw new ProtectionError("unprotected", NO_KEYRING);
      return { protection: SAFE_STORAGE_PROTECTION, tag, data: Buffer.from(sealed).toString("base64") };
    },

    async unseal(part) {
      if (part.protection !== SAFE_STORAGE_PROTECTION) {
        throw new ProtectionError("unknown-protection", "This credential was protected in a way Pragma doesn't know.");
      }
      let opened: { result: string; shouldReEncrypt: boolean };
      try {
        opened = await withTimeout(safeStorage.decryptStringAsync(Buffer.from(part.data, "base64")), timeoutMs);
      } catch (error) {
        if (error instanceof ProtectionError) throw error;
        throw new ProtectionError("cannot-decrypt", "This credential could not be decrypted here.");
      }
      return { value: opened.result, reseal: opened.shouldReEncrypt };
    },
  };
}

// The native call can't be cancelled; past the deadline its answer is simply
// never used, so a late result can't reach a record.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProtectionError("timeout", "The keychain didn't answer in time. Try again.")),
      ms,
    );
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
