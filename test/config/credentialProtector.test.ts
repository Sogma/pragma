import { describe, expect, it } from "vitest";
import {
  type AsyncSafeStorage,
  createSafeStorageProtector,
  ProtectionError,
  SAFE_STORAGE_PROTECTION,
} from "../../src/config/credentialProtector.ts";

interface FakeSafeStorage extends AsyncSafeStorage {
  tag: string;
  available: boolean;
  encryptCalls: number;
  reEncrypt: boolean;
  hang: boolean;
}

// A stand-in for Electron's safeStorage: its "ciphertext" is the tag followed
// by the text, which is all this module reads of it.
function fakeSafeStorage(initialTag: string): FakeSafeStorage {
  const fake: FakeSafeStorage = {
    tag: initialTag,
    available: true,
    encryptCalls: 0,
    reEncrypt: false,
    hang: false,
    async isAsyncEncryptionAvailable() {
      return fake.available;
    },
    async encryptStringAsync(plainText: string) {
      fake.encryptCalls += 1;
      if (fake.hang) return new Promise<Uint8Array>(() => {});
      return Buffer.from(`${fake.tag}${plainText}`, "latin1");
    },
    async decryptStringAsync(encrypted: Buffer) {
      const text = encrypted.toString("latin1");
      if (!text.startsWith("v1")) throw new Error("bad ciphertext");
      return { result: text.slice(3), shouldReEncrypt: fake.reEncrypt };
    },
  };
  return fake;
}

describe("safeStorage protector", () => {
  it("allows a save on Linux only when the probe comes back keyring-protected", async () => {
    const keyring = fakeSafeStorage("v11");
    await expect(createSafeStorageProtector({ safeStorage: keyring, platform: "linux" }).canSave()).resolves.toEqual({
      ok: true,
    });

    const fixedKey = fakeSafeStorage("v10");
    const check = await createSafeStorageProtector({ safeStorage: fixedKey, platform: "linux" }).canSave();
    expect(check).toMatchObject({ ok: false, reason: "unprotected" });
  });

  it("refuses when the async encryptor reports itself unavailable", async () => {
    const storage = fakeSafeStorage("v11");
    storage.available = false;
    const check = await createSafeStorageProtector({ safeStorage: storage, platform: "linux" }).canSave();
    expect(check).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("keeps a passing probe for the process and runs a failing one again", async () => {
    const storage = fakeSafeStorage("v10");
    const protector = createSafeStorageProtector({ safeStorage: storage, platform: "linux" });
    await protector.canSave();
    storage.tag = "v11";
    await expect(protector.canSave()).resolves.toEqual({ ok: true });
    const calls = storage.encryptCalls;
    await protector.canSave();
    expect(storage.encryptCalls).toBe(calls);
  });

  it("checks every seal's tag, not only the probe's", async () => {
    const storage = fakeSafeStorage("v11");
    const protector = createSafeStorageProtector({ safeStorage: storage, platform: "linux" });
    await expect(protector.seal("sk-one")).resolves.toMatchObject({ protection: SAFE_STORAGE_PROTECTION, tag: "v11" });
    storage.tag = "v10";
    await expect(protector.seal("sk-two")).rejects.toMatchObject({ failure: "unprotected" });
  });

  it("accepts v10 on macOS and Windows, and refuses a tag it doesn't know", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const protector = createSafeStorageProtector({ safeStorage: fakeSafeStorage("v10"), platform });
      await expect(protector.seal("sk")).resolves.toMatchObject({ tag: "v10" });
    }
    const newer = createSafeStorageProtector({ safeStorage: fakeSafeStorage("v20"), platform: "win32" });
    await expect(newer.seal("sk")).rejects.toBeInstanceOf(ProtectionError);
  });

  it("opens a seal and passes on the OS asking for re-encryption", async () => {
    const storage = fakeSafeStorage("v11");
    const protector = createSafeStorageProtector({ safeStorage: storage, platform: "linux" });
    const sealed = await protector.seal("sk-ant");
    storage.reEncrypt = true;
    await expect(protector.unseal(sealed)).resolves.toEqual({ value: "sk-ant", reseal: true });
  });

  it("names what failed when a value can't be opened", async () => {
    const protector = createSafeStorageProtector({ safeStorage: fakeSafeStorage("v11"), platform: "linux" });
    await expect(protector.unseal({ protection: "other", tag: "v11", data: "" })).rejects.toMatchObject({
      failure: "unknown-protection",
    });
    const garbage = { protection: SAFE_STORAGE_PROTECTION, tag: "v11", data: Buffer.from("zz").toString("base64") };
    await expect(protector.unseal(garbage)).rejects.toMatchObject({ failure: "cannot-decrypt" });
  });

  it("stops waiting on a keychain that doesn't answer", async () => {
    const storage = fakeSafeStorage("v11");
    storage.hang = true;
    const protector = createSafeStorageProtector({ safeStorage: storage, platform: "linux", timeoutMs: 20 });
    await expect(protector.seal("sk")).rejects.toMatchObject({ failure: "timeout" });
    await expect(protector.canSave()).resolves.toMatchObject({ ok: false, reason: "timeout" });
  });
});
