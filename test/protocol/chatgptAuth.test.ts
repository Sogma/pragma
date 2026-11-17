import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import {
  type ChatGptSignIn,
  chatGptAccessToken,
  chatGptSignInSlot,
  grantFrom,
  needsSignIn,
  readChatGptSignIn,
  resetChatGptAuthCache,
  revokeChatGptSignIn,
  verifyChatGptIdToken,
} from "../../src/protocol/chatgptAuth.ts";
import { type ChatGptStandIn, createChatGptStandIn, saveSignIn } from "../support/chatgptStandIn.ts";
import { holdLockInAnotherProcess, releaseLockHolders } from "../support/lockHolder.ts";

// A `chatgpt` provider's tokens: when they are renewed, what a refused or
// rotated refresh leaves behind, and what an ID token must carry to count.

const PLAN = ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"];

let standIn: ChatGptStandIn;
let configDir: string;
let clock: number;
const now = () => clock;

function save(tokens: Partial<NonNullable<ChatGptSignIn["tokens"]>> = {}, extra: ChatGptSignIn = {}): Promise<void> {
  return saveSignIn("chatgpt", {
    clientId: "oaiapp_1",
    subject: "user-1",
    email: "writer@example.com",
    scopes: PLAN,
    tokens: { accessToken: "at-0", refreshToken: "rt-0", expiresAt: clock + 3600_000, ...tokens },
    ...extra,
  });
}

// Where the sign-in's record and its renewal lock rest in the terminal
// targets' plain store.
const signInFolder = () => path.join(configDir, "credentials", "plain", "provider-sign-ins");

beforeEach(async () => {
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-chatgpt-auth-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  resetChatGptAuthCache();
  standIn = await createChatGptStandIn();
  vi.stubGlobal("fetch", standIn.fetch);
  clock = Date.now();
});

afterEach(async () => {
  await releaseLockHolders();
  vi.unstubAllGlobals();
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("a ChatGPT access token", () => {
  it("is the stored one while it has more than a minute left", async () => {
    await save();
    expect(await chatGptAccessToken("chatgpt", { now })).toBe("at-0");
    expect(standIn.tokenRequests).toHaveLength(0);
  });

  it("is renewed once near its expiry, however many callers ask at the same time", async () => {
    await save({ expiresAt: clock + 30_000 });

    const tokens = await Promise.all([1, 2, 3].map(() => chatGptAccessToken("chatgpt", { now })));

    expect(tokens).toEqual(["at-1", "at-1", "at-1"]);
    expect(standIn.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(standIn.tokenRequests[0])).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_1",
      refresh_token: "rt-0",
      resource: "https://api.openai.com/v1",
    });
    expect((await readChatGptSignIn("chatgpt")).tokens).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
  });

  it("waits for the earliest renewal ChatGPT allows, while the old token still works", async () => {
    await save({ expiresAt: clock + 30_000, earliestRefreshAt: clock + 10_000 });
    expect(await chatGptAccessToken("chatgpt", { now })).toBe("at-0");

    await save({ expiresAt: clock - 1, earliestRefreshAt: clock + 10_000 });
    await expect(chatGptAccessToken("chatgpt", { now })).rejects.toThrow(/can't renew/);
    expect(standIn.tokenRequests).toHaveLength(0);
  });

  it("ends the sign-in when ChatGPT refuses the refresh token, keeping the registration", async () => {
    await save({ expiresAt: clock - 1 });
    standIn.tokenAnswer = () => Response.json({ error: "refresh_token_reused" }, { status: 400 });

    await expect(chatGptAccessToken("chatgpt", { now })).rejects.toThrow(/Sign in to ChatGPT again/);
    expect(await readChatGptSignIn("chatgpt")).toEqual({
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "writer@example.com",
    });
  });

  it("keeps the sign-in through a failure that says nothing about it", async () => {
    await save({ expiresAt: clock - 1 });
    standIn.tokenAnswer = () => new Response("unavailable", { status: 503 });

    await expect(chatGptAccessToken("chatgpt", { now })).rejects.toThrow();
    expect((await readChatGptSignIn("chatgpt")).tokens?.refreshToken).toBe("rt-0");
  });

  it("keeps the granted scopes when a refresh leaves them out", async () => {
    await save({ expiresAt: clock - 1 });
    standIn.tokenAnswer = () =>
      Response.json({ access_token: "at-9", refresh_token: "rt-9", token_type: "bearer", expires_in: 3600 });

    expect(await chatGptAccessToken("chatgpt", { now })).toBe("at-9");
    expect((await readChatGptSignIn("chatgpt")).scopes).toEqual(PLAN);
  });

  it("ends the sign-in when a refreshed identity is someone else", async () => {
    await save({ expiresAt: clock - 1 });
    const idToken = await standIn.idToken({ sub: "user-2", aud: "oaiapp_1" });
    standIn.tokenAnswer = () =>
      Response.json({
        access_token: "at-9",
        refresh_token: "rt-9",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
      });

    await expect(chatGptAccessToken("chatgpt", { now })).rejects.toThrow(/Sign in to ChatGPT again/);
    expect((await readChatGptSignIn("chatgpt")).tokens).toBeUndefined();
  });

  it("brings nothing back when the person signs out while a renewal is on its way", async () => {
    await save({ expiresAt: clock - 1 });
    let answer: (response: Response) => void = () => {};
    standIn.tokenAnswer = () => new Promise<Response>((resolve) => (answer = resolve));

    const renewing = chatGptAccessToken("chatgpt", { now });
    await vi.waitFor(() => expect(standIn.tokenRequests).toHaveLength(1));
    // Signed out from another window meanwhile.
    await saveSignIn("chatgpt", { clientId: "oaiapp_1", subject: "user-1" });
    answer(Response.json({ access_token: "at-9", refresh_token: "rt-9", token_type: "Bearer", expires_in: 3600 }));

    await expect(renewing).rejects.toThrow(/Sign in to ChatGPT again/);
    expect(await readChatGptSignIn("chatgpt")).toEqual({ clientId: "oaiapp_1", subject: "user-1" });
  });

  it("waits on another process's renewal and uses its token, rather than spending the refresh token again", async () => {
    await save({ expiresAt: clock - 1 });
    const holder = await holdLockInAnotherProcess(path.join(signInFolder(), "id-chatgpt.renewal.lock"));
    const waiting = chatGptAccessToken("chatgpt", { now, refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The other process renews and saves before it lets go.
    await save({ accessToken: "at-elsewhere", refreshToken: "rt-elsewhere", expiresAt: clock + 3600_000 });
    await holder.release();

    expect(await waiting).toBe("at-elsewhere");
    expect(standIn.tokenRequests).toHaveLength(0);
  });

  it("keeps the tokens out of the record's open details", async () => {
    await save();

    const record = await credentialStore().inspect(chatGptSignInSlot("chatgpt"));
    expect(record).toMatchObject({ state: "live", parts: ["tokens"] });
    expect(record.state === "live" && record.metadata).toMatchObject({ email: "writer@example.com", scopes: PLAN });
    expect(JSON.stringify(record)).not.toMatch(/at-0|rt-0/);
  });

  it("refuses a sign-in whose record can't be read, and sends the person to sign in again", async () => {
    mkdirSync(signInFolder(), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(signInFolder(), "id-chatgpt.json"), "{ not json", { mode: 0o600 });

    const refused = await chatGptAccessToken("chatgpt", { now }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/saved ChatGPT sign-in can't be used.*Sign in to ChatGPT again/);
    expect(needsSignIn(refused)).toBe(true);
  });

  it("never reads a sign-in left in config.json by an earlier version", async () => {
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        modelProviders: [
          {
            id: "chatgpt",
            kind: "chatgpt",
            signIn: JSON.stringify({ clientId: "oaiapp_1", scopes: PLAN, tokens: { accessToken: "at-old" } }),
          },
        ],
        modelProviderSignInsEncrypted: { chatgpt: "b2xk" },
      }),
    );

    await expect(chatGptAccessToken("chatgpt", { now })).rejects.toThrow(/Sign in to ChatGPT again/);
    expect(standIn.tokenRequests).toHaveLength(0);
  });
});

describe("a ChatGPT ID token", () => {
  it("counts when OpenAI signed it for this registration, with the nonce that was sent", async () => {
    const idToken = await standIn.idToken({ sub: "user-1", aud: "oaiapp_1", nonce: "n-1", email: "w@example.com" });
    expect(await verifyChatGptIdToken(idToken, "oaiapp_1", "n-1")).toEqual({
      subject: "user-1",
      email: "w@example.com",
    });
  });

  it("doesn't count for another registration, another nonce, or another issuer", async () => {
    const forOther = await standIn.idToken({ sub: "user-1", aud: "oaiapp_other", nonce: "n-1" });
    await expect(verifyChatGptIdToken(forOther, "oaiapp_1", "n-1")).rejects.toThrow(/couldn't be verified/);

    const replayed = await standIn.idToken({ sub: "user-1", aud: "oaiapp_1", nonce: "n-0" });
    await expect(verifyChatGptIdToken(replayed, "oaiapp_1", "n-1")).rejects.toThrow(/couldn't be verified/);

    const forged = await standIn.idToken({ sub: "user-1", aud: "oaiapp_1", nonce: "n-1", iss: "https://evil.test" });
    await expect(verifyChatGptIdToken(forged, "oaiapp_1", "n-1")).rejects.toThrow(/couldn't be verified/);
  });

  it("reads OpenAI's keys again when a token names a key it hasn't seen", async () => {
    const first = await standIn.idToken({ sub: "user-1", aud: "oaiapp_1" });
    await verifyChatGptIdToken(first, "oaiapp_1");
    await standIn.rotateKey();
    const second = await standIn.idToken({ sub: "user-1", aud: "oaiapp_1" });

    expect(await verifyChatGptIdToken(second, "oaiapp_1")).toEqual({ subject: "user-1" });
    expect(standIn.jwksReads).toBe(2);
  });
});

describe("a token response", () => {
  it("needs a refresh token whenever offline access was granted", () => {
    expect(() =>
      grantFrom({ access_token: "a", token_type: "Bearer", expires_in: 60, scope: "openid offline_access" }, 0),
    ).toThrow(/incomplete/);
  });

  it("reads the earliest renewal as epoch seconds", () => {
    const { tokens } = grantFrom(
      { access_token: "a", token_type: "Bearer", expires_in: 60, scope: "openid", earliest_refresh_at: 1_800_000_000 },
      1000,
    );
    expect(tokens).toEqual({ accessToken: "a", expiresAt: 61_000, earliestRefreshAt: 1_800_000_000_000 });
  });
});

describe("revoking a ChatGPT sign-in", () => {
  it("is refused without a refresh token to end", async () => {
    expect(await revokeChatGptSignIn({ clientId: "oaiapp_1" })).toBe(false);
    expect(standIn.revocations).toHaveLength(0);
  });

  it("tries once more after a server error, and no more after a refusal", async () => {
    const signIn: ChatGptSignIn = {
      clientId: "oaiapp_1",
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: 0 },
    };
    standIn.revocationStatus = 500;
    expect(await revokeChatGptSignIn(signIn)).toBe(false);
    expect(standIn.revocations).toHaveLength(2);

    standIn.revocations = [];
    standIn.revocationStatus = 400;
    expect(await revokeChatGptSignIn(signIn)).toBe(false);
    expect(standIn.revocations).toHaveLength(1);
  });
});
