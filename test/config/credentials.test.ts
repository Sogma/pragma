import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Protector, SaveCheck } from "../../src/config/credentialProtector.ts";
import { createFileCredentialStore, encodeCredentialId } from "../../src/config/credentialStore.ts";
import {
  type CredentialSave,
  carryingAttempt,
  claimSignIn,
  credentialHint,
  credentialStore,
  credentialStoreDescription,
  endSignIn,
  providerKey,
  providerKeyStatus,
  remoteAccessPassphrase,
  saveCredential,
  setCredentialHost,
  setCredentialStore,
  signInAgain,
  TOKENS_PART,
} from "../../src/config/credentials.ts";
import { globalConfigDir } from "../../src/config/loadConfig.ts";

// The order a key and its connection are saved in: nothing changes until
// protection works and the service accepts the key, the key lands before the
// connection, and a connection that can't be written takes a new key with it.

let configDir: string;
const slot = { kind: "provider-keys", id: "gateway" } as const;
const endpoint = "https://gateway.example/v1";
const recordFile = () => path.join(configDir, "credentials", "plain", slot.kind, `${encodeCredentialId(slot.id)}.json`);

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-credential-save-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
});

afterEach(() => {
  setCredentialStore(createFileCredentialStore({ backing: "plain", root: globalConfigDir }));
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

const save = (overrides: Partial<CredentialSave> = {}) =>
  saveCredential({ kind: "provider-keys", id: "gateway", endpoint, secret: "sk-new", publish: () => {}, ...overrides });

const diskFull = () => {
  throw new Error("disk full");
};

function refusingProtector(check: Extract<SaveCheck, { ok: false }>): Protector {
  return {
    canSave: async () => check,
    lastCheck: () => check,
    seal: async () => {
      throw new Error("never sealed");
    },
    unseal: async () => {
      throw new Error("never unsealed");
    },
  };
}

describe("saving a key with its connection", () => {
  it("commits the key before writing the connection", async () => {
    let keyOnDisk = false;
    const result = await save({
      publish: () => {
        keyOnDisk = existsSync(recordFile());
      },
    });
    expect(result).toEqual({ ok: true });
    expect(keyOnDisk).toBe(true);
    await expect(credentialStore().select(slot, endpoint)).resolves.toMatchObject({
      ok: true,
      secrets: { key: "sk-new" },
    });
  });

  it("asks the service nothing and writes nothing when keys can't be protected here", async () => {
    const check = { ok: false, reason: "unprotected", message: "The keychain isn't protecting keys." } as const;
    setCredentialStore(
      createFileCredentialStore({ backing: "encrypted", root: globalConfigDir, protector: refusingProtector(check) }),
    );
    const verify = vi.fn(async () => undefined);
    const publish = vi.fn();
    await expect(save({ verify, publish })).resolves.toEqual({ ok: false, status: 400, message: check.message });
    expect(verify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect((await credentialStore().inspect(slot)).state).toBe("absent");
    expect(credentialStoreDescription()).toEqual({ kind: "safe-storage", encrypted: true, available: false });
  });

  it("writes nothing when the service refuses the key", async () => {
    const publish = vi.fn();
    await expect(save({ verify: async () => "The key was rejected.", publish })).resolves.toEqual({
      ok: false,
      status: 400,
      message: "The key was rejected.",
    });
    expect(publish).not.toHaveBeenCalled();
    expect((await credentialStore().inspect(slot)).state).toBe("absent");
  });

  it("withdraws a key it created when the connection can't be written", async () => {
    await expect(save({ publish: diskFull })).resolves.toEqual({
      ok: false,
      status: 500,
      message: "The connection couldn't be saved, so the key wasn't kept: disk full",
    });
    expect((await credentialStore().inspect(slot)).state).toBe("cleared");
  });

  it("keeps a replacing key when the connection can't be written, and says to save again", async () => {
    await save({ secret: "sk-old" });
    await expect(save({ publish: diskFull })).resolves.toEqual({
      ok: false,
      status: 500,
      message: "The new key was saved, but the connection's settings weren't: disk full. Save again.",
    });
    await expect(credentialStore().select(slot, endpoint)).resolves.toMatchObject({ secrets: { key: "sk-new" } });
  });

  it("refuses to overwrite a key another window saved meanwhile", async () => {
    const result = await save({
      verify: async () => {
        const store = credentialStore();
        await store.set(slot, (await store.inspect(slot)).observation, { endpoint, secrets: { key: "sk-other" } });
        return undefined;
      },
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    await expect(credentialStore().select(slot, endpoint)).resolves.toMatchObject({ secrets: { key: "sk-other" } });
  });

  it("refuses a connection without a usable URL before touching the store", async () => {
    await expect(save({ endpoint: undefined })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(existsSync(path.join(configDir, "credentials"))).toBe(false);
  });
});

describe("a sign-in attempt", () => {
  const signIn = { kind: "provider-sign-ins", id: "chatgpt" } as const;
  const url = "https://api.openai.com/v1";

  async function claim(write: Parameters<typeof claimSignIn>[2] = () => ({ secrets: {} })) {
    const claimed = await claimSignIn(signIn, url, write);
    if (!claimed.ok) throw new Error(claimed.refused.message);
    return claimed.attempt;
  }

  it("writes while the record carries it, and is ended by a sign-out from anywhere", async () => {
    const attempt = await claim();
    await expect(attempt.write(() => ({ metadata: { clientId: "c-1" }, secrets: {} }))).resolves.toEqual({ ok: true });

    await endSignIn(signIn, [TOKENS_PART], (current) => ({ metadata: current.metadata, secrets: {} }));

    await expect(attempt.write(() => ({ secrets: { tokens: "t" } }), { final: true })).resolves.toEqual({
      ok: false,
      cancelled: true,
    });
    await expect(credentialStore().inspect(signIn)).resolves.toMatchObject({
      state: "live",
      parts: [],
      metadata: { clientId: "c-1" },
    });
  });

  it("gives way to a newer attempt, but not to a renewal of the sign-in it will replace", async () => {
    const first = await claim(() => ({ secrets: { tokens: "old" } }));
    const read = await credentialStore().inspect(signIn);
    if (read.state !== "live") throw new Error("not claimed");
    await credentialStore().set(signIn, read.observation, {
      endpoint: url,
      metadata: carryingAttempt(read.metadata, { email: "w@example.com" }),
      secrets: { tokens: "renewed" },
    });
    expect(await first.current()).toBeDefined();

    const second = await claim((current) => ({
      metadata: current.state === "live" ? current.metadata : {},
      secrets: {},
      keep: ["tokens"],
    }));

    await expect(first.write(() => ({ secrets: {} }))).resolves.toEqual({ ok: false, cancelled: true });
    await expect(
      second.write((current) => ({ metadata: current.metadata, secrets: { tokens: "new" } }), { final: true }),
    ).resolves.toEqual({ ok: true });
    const done = await credentialStore().inspect(signIn);
    expect(done.state === "live" && done.metadata).toEqual({ email: "w@example.com" });
  });
});

describe("ending a sign-in", () => {
  const signIn = { kind: "mcp-sign-ins", id: "linear" } as const;
  const url = "https://mcp.linear.app/mcp";

  it("has nothing to end for a slot never signed in", async () => {
    await expect(endSignIn(signIn, [TOKENS_PART], () => "clear")).resolves.toBeUndefined();
    await expect(credentialStore().inspect(signIn)).resolves.toMatchObject({ state: "absent" });
  });

  it("takes the tokens out of use and hands them back for revoking", async () => {
    await credentialStore().set(
      signIn,
      { absent: true },
      { endpoint: url, metadata: { clientId: "c-1" }, secrets: { tokens: "t-1" } },
    );

    const ended = await endSignIn(signIn, [TOKENS_PART], (current) => ({ metadata: current.metadata, secrets: {} }));

    if (!ended || ended.unreadable || !ended.taken) throw new Error("nothing ended");
    expect(ended.details).toEqual({ clientId: "c-1" });
    await expect(credentialStore().open(ended.taken)).resolves.toEqual({ tokens: "t-1" });
    await expect(credentialStore().inspect(signIn)).resolves.toMatchObject({ state: "live", parts: [] });
  });

  it("clears a record it can't read", async () => {
    await credentialStore().set(signIn, { absent: true }, { endpoint: url, secrets: { tokens: "t-1" } });
    const file = path.join(configDir, "credentials", "plain", signIn.kind, `${encodeCredentialId(signIn.id)}.json`);
    writeFileSync(file, "{ not json", { mode: 0o600 });

    await expect(endSignIn(signIn, [TOKENS_PART], () => "clear")).resolves.toEqual({ unreadable: true });
    await expect(credentialStore().inspect(signIn)).resolves.toMatchObject({ state: "cleared" });
  });
});

describe("how a host says to supply a credential", () => {
  afterEach(() => setCredentialHost("terminal"));

  it("signs in again where the host's sign-in page can return", () => {
    const again = () => signInAgain("ChatGPT", "AI Models");
    setCredentialHost("desktop");
    expect(again()).toBe("Sign in to ChatGPT again in Settings → AI Models.");
    setCredentialHost("local");
    expect(again()).toBe(
      "Sign in to ChatGPT again in Settings → AI Models. Sign-ins made in the desktop app aren't used here.",
    );
    setCredentialHost("remote");
    expect(again()).toBe(
      "Sign in to ChatGPT again from `pragma dev` on the machine this host runs on, as the account it runs as.",
    );
    setCredentialHost("terminal");
    expect(again()).toBe(
      "Sign in to ChatGPT again in Settings → AI Models in `pragma dev`. Sign-ins made in the desktop app aren't used here.",
    );
  });

  it("adds nothing on the desktop, whose message links to its setting", () => {
    setCredentialHost("desktop");
    expect(credentialHint("token")).toBe("");
    setCredentialHost("remote");
    expect(credentialHint("token")).toBe(" Tokens saved in the desktop app aren't used here.");
  });
});

describe("the remote-access passphrase", () => {
  const slot = { kind: "remote-access-passphrase" } as const;
  const file = () => path.join(configDir, "credentials", "plain", "remote-access-passphrase.json");

  it("comes from its own record, never from config.json", async () => {
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ hostPassphrase: "from-config" }));
    await expect(remoteAccessPassphrase()).resolves.toEqual({
      ok: false,
      problem: `No passphrase is saved in ${file()}.`,
    });

    await credentialStore().set(
      slot,
      { absent: true },
      { secrets: { passphrase: "correct horse", cookieSecret: "s3cret" } },
    );
    await expect(remoteAccessPassphrase()).resolves.toEqual({
      ok: true,
      passphrase: "correct horse",
      cookieSecret: "s3cret",
    });
  });

  it("is refused when its record has no cookie secret", async () => {
    await credentialStore().set(slot, { absent: true }, { secrets: { passphrase: "correct horse" } });
    await expect(remoteAccessPassphrase()).resolves.toEqual({
      ok: false,
      problem: `The record in ${file()} has no cookie secret.`,
    });
  });

  it("is refused, naming its file, when the record can't be read", async () => {
    await credentialStore().set(slot, { absent: true }, { secrets: { passphrase: "correct horse" } });
    writeFileSync(file(), "{ not json", { mode: 0o600 });

    await expect(remoteAccessPassphrase()).resolves.toEqual({ ok: false, problem: `${file()} isn't valid JSON.` });
  });
});

describe("a saved key the keychain couldn't protect anew", () => {
  it("still works, and Settings says to enter it again", async () => {
    let sealing = true;
    const protector: Protector = {
      canSave: async () => ({ ok: true }),
      lastCheck: () => ({ ok: true }),
      seal: async (value: string) => {
        if (!sealing) throw new Error("The keychain is locked.");
        return { protection: "fake", tag: "v11", data: `sealed:${value}` };
      },
      // The OS asks for every value it opens to be sealed again.
      unseal: async (part) => ({ value: part.data.replace(/^sealed:/, ""), reseal: true }),
    };
    setCredentialStore(createFileCredentialStore({ backing: "encrypted", root: globalConfigDir, protector }));
    const entry = { id: "gateway", kind: "openai" as const, baseURL: endpoint };
    await expect(save()).resolves.toEqual({ ok: true });
    sealing = false;

    await expect(providerKey(entry)).resolves.toMatchObject({ found: true, key: "sk-new" });

    await vi.waitFor(async () =>
      expect(await providerKeyStatus(entry)).toEqual({
        source: "stored",
        problem:
          "The keychain asked to protect the saved key anew, and that failed. It still works; enter it again to protect it anew.",
      }),
    );
  });
});
