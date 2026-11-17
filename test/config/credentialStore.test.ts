import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Protector, SealedPart } from "../../src/config/credentialProtector.ts";
import {
  type CredentialSlot,
  canonicalEndpoint,
  createFileCredentialStore,
  encodeCredentialId,
} from "../../src/config/credentialStore.ts";

let root: string;
const anthropic: CredentialSlot = { kind: "provider-keys", id: "anthropic" };
const endpoint = "https://api.anthropic.com/v1";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pragma-credentials-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const plainStore = () => createFileCredentialStore({ backing: "plain", root: () => root });
const recordFile = (backing: string, slot: { kind: string; id: string }) =>
  path.join(root, "credentials", backing, slot.kind, `${encodeCredentialId(slot.id)}.json`);

// Seals by prefixing "sealed:", and counts what it was asked to do.
function fakeProtector(options: { saveCheck?: Awaited<ReturnType<Protector["canSave"]>>; reseal?: boolean } = {}) {
  const fake = {
    seals: 0,
    unseals: 0,
    hold: undefined as Promise<void> | undefined,
    failUnseal: false,
    async canSave() {
      return options.saveCheck ?? ({ ok: true } as const);
    },
    lastCheck() {
      return undefined;
    },
    async seal(plainText: string): Promise<SealedPart> {
      fake.seals += 1;
      return { protection: "fake", tag: "v11", data: `sealed:${plainText}` };
    },
    async unseal(part: SealedPart) {
      fake.unseals += 1;
      if (fake.hold) await fake.hold;
      if (fake.failUnseal) throw new Error("no key");
      return { value: part.data.replace(/^sealed:/, ""), reseal: options.reseal === true };
    },
  };
  return fake;
}

describe("credential ids and endpoints", () => {
  it("encodes ids as one safe file name that case can't merge", () => {
    expect(encodeCredentialId("anthropic")).toBe("id-anthropic");
    expect(encodeCredentialId("OpenAI")).not.toBe(encodeCredentialId("openai"));
    expect(encodeCredentialId("OpenAI").toLowerCase()).not.toBe(encodeCredentialId("openai").toLowerCase());
    expect(encodeCredentialId("..")).toBe("id-%2E%2E");
    expect(encodeCredentialId("con")).toBe("id-con");
    expect(encodeCredentialId("a/b")).toBe("id-a%2Fb");
    expect(() => encodeCredentialId("")).toThrow();
  });

  it("binds to the endpoint's scheme, host, port, path and query", () => {
    expect(canonicalEndpoint("https://API.Anthropic.com:443/v1/")).toBe("https://api.anthropic.com/v1");
    expect(canonicalEndpoint("https://gateway.example/team-a")).not.toBe(
      canonicalEndpoint("https://gateway.example/team-b"),
    );
    expect(canonicalEndpoint("http://localhost:1234/v1?tenant=x")).toBe("http://localhost:1234/v1?tenant=x");
    expect(() => canonicalEndpoint("https://user:pw@example.com")).toThrow();
    expect(() => canonicalEndpoint("ftp://example.com")).toThrow();
  });
});

describe("plain credential store", () => {
  it("saves a key owner-only and gives it back for its endpoint", async () => {
    const store = plainStore();
    const saved = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk-ant" } });
    expect(saved.ok).toBe(true);
    await expect(store.select(anthropic, `${endpoint}/`)).resolves.toMatchObject({
      ok: true,
      secrets: { key: "sk-ant" },
    });

    const file = recordFile("plain", anthropic);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: "1.0",
      kind: "provider-keys",
      id: "anthropic",
      state: "live",
      endpoint,
    });
  });

  it("won't hand a key to another endpoint, and keeps the record", async () => {
    const store = plainStore();
    await store.set(
      anthropic,
      { absent: true },
      { endpoint: "https://gateway.example/team-a", secrets: { key: "sk" } },
    );
    const other = await store.select(anthropic, "https://gateway.example/team-b");
    expect(other).toMatchObject({ ok: false, state: { state: "unreadable", reason: "endpoint-changed" } });
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "live" });
  });

  it("lands a change only on the state its caller saw", async () => {
    const store = plainStore();
    const first = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "one" } });
    if (!first.ok) throw new Error("first save failed");
    const stale = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "two" } });
    expect(stale).toMatchObject({ ok: false, conflict: first.observation });
    const next = await store.set(anthropic, first.observation, { endpoint, secrets: { key: "three" } });
    expect(next.ok).toBe(true);
    await expect(store.select(anthropic, endpoint)).resolves.toMatchObject({ secrets: { key: "three" } });
  });

  it("leaves a marker on clear, so a stale first save can't bring the slot back", async () => {
    const store = plainStore();
    const cleared = await store.clear(anthropic);
    expect(cleared.ok).toBe(true);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "cleared" });
    const stale = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "late" } });
    expect(stale).toMatchObject({ ok: false });
    await expect(store.select(anthropic, endpoint)).resolves.toMatchObject({ ok: false, state: { state: "cleared" } });
  });

  it("carries named parts over without rewriting them", async () => {
    const store = plainStore();
    const slot: CredentialSlot = { kind: "mcp-sign-ins", id: "higgsfield" };
    const mcp = "https://mcp.higgsfield.ai/mcp";
    const first = await store.set(
      slot,
      { absent: true },
      { endpoint: mcp, secrets: { tokens: "t", registration: "r" } },
    );
    if (!first.ok) throw new Error("save failed");
    await store.set(slot, first.observation, {
      endpoint: mcp,
      secrets: {},
      keep: ["registration"],
      metadata: { email: "a@b" },
    });
    await expect(store.select(slot, mcp)).resolves.toMatchObject({
      ok: true,
      secrets: { registration: "r" },
      metadata: { email: "a@b" },
    });
  });

  it("reads a damaged, newer or misplaced record as unreadable, never as absent", async () => {
    const store = plainStore();
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    const file = recordFile("plain", anthropic);
    const good = JSON.parse(readFileSync(file, "utf8"));
    const cases: Array<[unknown, string]> = [
      ["{not json", "malformed"],
      [{ ...good, version: "2.0" }, "newer-format"],
      [{ ...good, id: "openai" }, "identity-mismatch"],
      [{ ...good, endpoint: "https://API.anthropic.com/v1/" }, "invalid-binding"],
      [{ ...good, secrets: undefined, sealed: { key: { protection: "x", tag: "v11", data: "" } } }, "wrong-store"],
    ];
    for (const [content, reason] of cases) {
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
      await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "unreadable", reason });
    }
    writeFileSync(file, JSON.stringify({ ...good, version: "1.4" }), { mode: 0o600 });
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "live" });
    writeFileSync(file, JSON.stringify({ ...good, version: undefined }), { mode: 0o600 });
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "live" });
  });

  it("replaces an unreadable record only for a caller that saw those bytes", async () => {
    const store = plainStore();
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    writeFileSync(recordFile("plain", anthropic), "{broken", { mode: 0o600 });
    const seen = await store.inspect(anthropic);
    expect(seen).toMatchObject({ state: "unreadable", observation: { bytes: expect.any(String) } });
    await expect(store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "new" } })).resolves.toMatchObject({
      ok: false,
    });
    await expect(store.set(anthropic, seen.observation, { endpoint, secrets: { key: "new" } })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses a file or folder others can read, and says how to fix it", async () => {
    const store = plainStore();
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    const file = recordFile("plain", anthropic);
    chmodSync(file, 0o644);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({
      state: "unreadable",
      reason: "unsafe-permissions",
      message: expect.stringContaining("chmod 600"),
    });
    chmodSync(file, 0o600);
    chmodSync(path.dirname(file), 0o755);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ reason: "unsafe-permissions" });
    const save = await store.set(
      { kind: "provider-keys", id: "openai" },
      { absent: true },
      { endpoint, secrets: { key: "x" } },
    );
    expect(save).toMatchObject({ ok: false, refused: { reason: "unsafe-permissions" } });
  });

  it("won't follow a record that is a link", async () => {
    const store = plainStore();
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    const file = recordFile("plain", anthropic);
    const elsewhere = path.join(root, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ reason: "unsafe-permissions" });
  });

  it("says which endpoint a record written by hand must name", async () => {
    const file = recordFile("plain", anthropic);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const handWritten = { version: "1.0", kind: "provider-keys", id: "anthropic", revision: "r-1", state: "live" };
    writeFileSync(file, JSON.stringify({ ...handWritten, secrets: { key: "sk" } }), { mode: 0o600 });

    const selected = await plainStore().select(anthropic, "https://API.anthropic.com/v1/");

    expect(selected).toMatchObject({ ok: false, state: { state: "unreadable", reason: "invalid-binding" } });
    expect(!selected.ok && selected.state.state === "unreadable" && selected.state.message).toBe(
      `${file} doesn't name its endpoint the way Pragma writes it. For this connection it is "${endpoint}".`,
    );
  });

  it("keeps the remote-access passphrase unbound to any endpoint", async () => {
    const store = plainStore();
    const slot: CredentialSlot = { kind: "remote-access-passphrase" };
    await expect(store.set(slot, { absent: true }, { endpoint, secrets: { passphrase: "p" } })).resolves.toMatchObject({
      ok: false,
      refused: { reason: "invalid-binding" },
    });
    await store.set(slot, { absent: true }, { secrets: { passphrase: "p" } });
    await expect(store.select(slot)).resolves.toMatchObject({ ok: true, secrets: { passphrase: "p" } });
  });

  it("on Windows keeps the plain store inside the user's profile", async () => {
    const outside = createFileCredentialStore({
      backing: "plain",
      root: () => root,
      platform: "win32",
      home: () => path.join(root, "profile"),
    });
    await expect(outside.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } })).resolves.toMatchObject(
      {
        ok: false,
        refused: { reason: "unsafe-permissions" },
      },
    );
    const inside = createFileCredentialStore({
      backing: "plain",
      root: () => root,
      platform: "win32",
      home: () => root,
    });
    await expect(inside.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("sign-in records", () => {
  const signIn: CredentialSlot = { kind: "mcp-sign-ins", id: "linear" };
  const url = "https://mcp.linear.app/mcp";

  it("rest with their details alone between sign-ins, while a key never rests without its value", async () => {
    const store = plainStore();
    const saved = await store.set(
      signIn,
      { absent: true },
      { endpoint: url, metadata: { clientId: "c-1" }, secrets: {} },
    );
    expect(saved.ok).toBe(true);
    await expect(store.inspect(signIn)).resolves.toMatchObject({
      state: "live",
      parts: [],
      metadata: { clientId: "c-1" },
    });

    await expect(store.set(anthropic, { absent: true }, { endpoint, secrets: {} })).rejects.toThrow(/needs a value/);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "absent" });
  });

  it("hand back the parts a change took out of use, to open for revoking", async () => {
    const store = plainStore();
    const first = await store.set(
      signIn,
      { absent: true },
      { endpoint: url, secrets: { tokens: "t-1", registration: "r-1" } },
    );
    if (!first.ok) throw new Error("save failed");

    const signedOut = await store.set(signIn, first.observation, {
      endpoint: url,
      secrets: {},
      keep: ["registration"],
      take: ["tokens"],
    });
    if (!signedOut.ok || !signedOut.taken) throw new Error("nothing taken");
    await expect(store.open(signedOut.taken)).resolves.toEqual({ tokens: "t-1" });
    await expect(store.inspect(signIn)).resolves.toMatchObject({ state: "live", parts: ["registration"] });

    const cleared = await store.clear(signIn, undefined, ["registration"]);
    if (!cleared.ok || !cleared.taken) throw new Error("nothing taken");
    await expect(store.open(cleared.taken)).resolves.toEqual({ registration: "r-1" });
    await expect(store.inspect(signIn)).resolves.toMatchObject({ state: "cleared" });
  });
});

describe("encrypted credential store", () => {
  const encryptedStore = (protector: Protector) =>
    createFileCredentialStore({ backing: "encrypted", root: () => root, protector });

  it("refuses before writing anything when protection isn't genuine", async () => {
    const protector = fakeProtector({
      saveCheck: { ok: false, reason: "unprotected", message: "No keyring answered." },
    });
    const store = encryptedStore(protector);
    await expect(store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } })).resolves.toMatchObject({
      ok: false,
      refused: { reason: "unprotected" },
    });
    expect(protector.seals).toBe(0);
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "absent" });
  });

  it("seals each part, opens it for use, and lists it without the keychain", async () => {
    const protector = fakeProtector();
    const store = encryptedStore(protector);
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk-ant" } });
    expect(readFileSync(recordFile("encrypted", anthropic), "utf8")).not.toContain('"sk-ant"');
    await expect(store.inspect(anthropic)).resolves.toMatchObject({
      state: "live",
      checked: "unchecked",
      parts: ["key"],
    });
    expect(protector.unseals).toBe(0);
    await expect(store.select(anthropic, endpoint)).resolves.toMatchObject({ ok: true, secrets: { key: "sk-ant" } });
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ checked: "ok" });
  });

  it("keeps a protected part across a change without opening it", async () => {
    const protector = fakeProtector();
    const store = encryptedStore(protector);
    const slot: CredentialSlot = { kind: "provider-sign-ins", id: "chatgpt" };
    const first = await store.set(
      slot,
      { absent: true },
      { endpoint: "https://api.openai.com/v1", secrets: { tokens: "t", registration: "r" } },
    );
    if (!first.ok) throw new Error("save failed");
    await store.set(slot, first.observation, {
      endpoint: "https://api.openai.com/v1",
      secrets: {},
      keep: ["registration"],
    });
    expect(protector.unseals).toBe(0);
    await expect(store.inspect(slot)).resolves.toMatchObject({ parts: ["registration"] });
  });

  it("keeps a record it can't open and says so", async () => {
    const protector = fakeProtector();
    const store = encryptedStore(protector);
    await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    protector.failUnseal = true;
    await expect(store.select(anthropic, endpoint)).resolves.toMatchObject({
      ok: false,
      state: { state: "unreadable", reason: "cannot-decrypt" },
    });
    await expect(store.inspect(anthropic)).resolves.toMatchObject({ state: "live", checked: "cannot-decrypt" });
  });

  it("re-protects a value the OS asks for, as a change on the revision it read", async () => {
    const store = encryptedStore(fakeProtector({ reseal: true }));
    const saved = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "sk" } });
    if (!saved.ok) throw new Error("save failed");
    await store.select(anthropic, endpoint);
    let state = await store.inspect(anthropic);
    for (
      let tries = 0;
      tries < 50 && JSON.stringify(state.observation) === JSON.stringify(saved.observation);
      tries += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await store.inspect(anthropic);
    }
    expect(state.observation).not.toEqual(saved.observation);
    await expect(store.select(anthropic, endpoint)).resolves.toMatchObject({ ok: true, secrets: { key: "sk" } });
  });

  it("signs out without the keychain, handing the tokens back sealed to open later", async () => {
    const slot: CredentialSlot = { kind: "provider-sign-ins", id: "chatgpt" };
    const url = "https://api.openai.com/v1";
    const earlier = await encryptedStore(fakeProtector()).set(
      slot,
      { absent: true },
      { endpoint: url, metadata: { email: "w@example.com" }, secrets: { tokens: "t-1" } },
    );
    if (!earlier.ok) throw new Error("save failed");
    // The keychain no longer answers saves.
    const protector = fakeProtector({ saveCheck: { ok: false, reason: "timeout", message: "No answer." } });
    const store = encryptedStore(protector);

    const signedOut = await store.set(slot, earlier.observation, {
      endpoint: url,
      metadata: { email: "w@example.com" },
      secrets: {},
      take: ["tokens"],
    });

    if (!signedOut.ok || !signedOut.taken) throw new Error("sign-out refused");
    expect(protector.unseals).toBe(0);
    expect(signedOut.taken).toEqual({ sealed: { tokens: expect.objectContaining({ data: "sealed:t-1" }) } });
    await expect(store.inspect(slot)).resolves.toMatchObject({ state: "live", parts: [] });
    await expect(store.open(signedOut.taken)).resolves.toEqual({ tokens: "t-1" });
  });

  it("never returns a value replaced while the keychain was answering", async () => {
    const protector = fakeProtector();
    const store = encryptedStore(protector);
    const first = await store.set(anthropic, { absent: true }, { endpoint, secrets: { key: "old" } });
    if (!first.ok) throw new Error("save failed");
    let release!: () => void;
    protector.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = store.select(anthropic, endpoint);
    await new Promise((resolve) => setTimeout(resolve, 20));
    protector.hold = undefined;
    await store.set(anthropic, first.observation, { endpoint, secrets: { key: "new" } });
    release();
    await expect(reading).resolves.toMatchObject({ ok: true, secrets: { key: "new" } });
  });
});
