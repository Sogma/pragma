import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Protector, SealedPart } from "../../src/config/credentialProtector.ts";
import { createFileCredentialStore } from "../../src/config/credentialStore.ts";
import { credentialStore, setCredentialStore } from "../../src/config/credentials.ts";
import { globalConfigDir } from "../../src/config/loadConfig.ts";
import {
  chatGptAccessToken,
  chatGptSignInSlot,
  readChatGptSignIn,
  resetChatGptAuthCache,
} from "../../src/protocol/chatgptAuth.ts";
import { type ChatGptSignIns, type ChatGptSignInTarget, createChatGptSignIns } from "../../src/server/chatgptSignIn.ts";
import { type ChatGptStandIn, createChatGptStandIn, saveSignIn } from "../support/chatgptStandIn.ts";
import { isolateConfig } from "../support/isolation.ts";

// Signing a `chatgpt` provider in against a stand-in for OpenAI. The test
// plays the browser: it reads the authorization URL Pragma would open, then
// requests the loopback callback as OpenAI's redirect would.

const HOST_ID = "urn:uuid:7f1c2b8e-0d55-4f0e-9a3c-2b1f5e6d7c8a";

let standIn: ChatGptStandIn;
let signIns: ChatGptSignIns;
let target: ChatGptSignInTarget;

beforeEach(async () => {
  isolateConfig();
  resetChatGptAuthCache();
  standIn = await createChatGptStandIn();
  vi.stubGlobal("fetch", standIn.fetch);
  signIns = createChatGptSignIns({ hostId: () => HOST_ID });
  target = { id: "chatgpt", label: "ChatGPT plan" };
});

afterEach(async () => {
  await signIns.close();
  setCredentialStore(createFileCredentialStore({ backing: "plain", root: globalConfigDir }));
  vi.unstubAllGlobals();
});

// The token endpoint's answer to a code: tokens, the scopes granted, and an
// ID token for `subject`, carrying the nonce the authorization asked for.
function answerCodes(authorize: URL, { subject = "user-1", scope = undefined as string | undefined } = {}): void {
  standIn.tokenAnswer = async (form) => {
    const idToken = await standIn.idToken({
      sub: subject,
      aud: form.get("client_id"),
      nonce: authorize.searchParams.get("nonce"),
      email: "writer@example.com",
    });
    return Response.json({
      access_token: "at-1",
      refresh_token: "rt-1",
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: scope ?? "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
    });
  };
}

// OpenAI's redirect back to Pragma's listener.
async function returnToPragma(authorize: URL, params: Record<string, string>): Promise<Response> {
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams({ state: authorize.searchParams.get("state") ?? "", ...params }).toString();
  return fetch(callback);
}

describe("ChatGPT sign-in", () => {
  it("registers Pragma on the first sign-in, then signs in with what was granted", async () => {
    const authorize = new URL(await signIns.start(target));
    expect(await signIns.status(target)).toEqual({ state: "pending" });

    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://auth.openai.com/api/accounts/authorize");
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Pragma",
      ext_agent_host_id: HOST_ID,
      response_type: "code",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(params).not.toHaveProperty("login_hint");
    expect(params).not.toHaveProperty("prompt");

    answerCodes(authorize);
    const page = await returnToPragma(authorize, { code: "code-1", client_id: "oaiapp_1" });
    expect(page.status).toBe(200);

    const [exchange] = standIn.tokenRequests;
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code",
      client_id: "oaiapp_1",
      code: "code-1",
      code_verifier: expect.any(String),
      redirect_uri: params.redirect_uri,
      resource: "https://api.openai.com/v1",
    });
    const verifier = exchange.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(params.code_challenge);

    expect(await signIns.status(target)).toEqual({ state: "signed-in", email: "writer@example.com", planUsage: true });
    expect(await readChatGptSignIn("chatgpt")).toMatchObject({
      clientId: "oaiapp_1",
      subject: "user-1",
      tokens: { accessToken: "at-1", refreshToken: "rt-1" },
    });
  });

  it("reuses the registration on a later sign-in, hinting the account instead of naming the app", async () => {
    await saveSignIn("chatgpt", { clientId: "oaiapp_1", subject: "user-1", email: "writer@example.com" });

    const authorize = new URL(await signIns.start(target));

    expect(authorize.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(authorize.searchParams.get("login_hint")).toBe("writer@example.com");
    expect(authorize.searchParams.has("agent_name_hint")).toBe(false);
    expect(authorize.searchParams.get("ext_agent_host_id")).toBe(HOST_ID);

    answerCodes(authorize);
    await returnToPragma(authorize, { code: "code-2" });
    expect(standIn.tokenRequests[0].get("client_id")).toBe("oaiapp_1");
    expect((await signIns.status(target)).state).toBe("signed-in");
  });

  it("refuses a returning sign-in that names another registration, or comes back as another account", async () => {
    await saveSignIn("chatgpt", { clientId: "oaiapp_1", subject: "user-1", email: "writer@example.com" });

    const swapped = new URL(await signIns.start(target));
    await returnToPragma(swapped, { code: "code-3", client_id: "oaiapp_other" });
    expect(standIn.tokenRequests).toHaveLength(0);
    expect(await signIns.status(target)).toMatchObject({
      state: "signed-out",
      message: expect.stringMatching(/registering/),
    });

    const other = new URL(await signIns.start(target));
    answerCodes(other, { subject: "user-2" });
    await returnToPragma(other, { code: "code-4" });
    expect(await signIns.status(target)).toMatchObject({
      state: "signed-out",
      message: expect.stringMatching(/different ChatGPT account.*writer@example\.com/),
    });
    expect((await readChatGptSignIn("chatgpt")).tokens).toBeUndefined();
  });

  it("keeps the registration when the code exchange fails, so the next attempt reuses it", async () => {
    const authorize = new URL(await signIns.start(target));
    standIn.tokenAnswer = () => Response.json({ error: "invalid_grant" }, { status: 400 });

    const page = await returnToPragma(authorize, { code: "stale", client_id: "oaiapp_1" });

    expect(page.status).toBe(502);
    expect(await readChatGptSignIn("chatgpt")).toEqual({ clientId: "oaiapp_1" });
    const again = new URL(await signIns.start(target));
    expect(again.searchParams.get("client_id")).toBe("oaiapp_1");
  });

  it("says so when the person declines, and exchanges nothing", async () => {
    const authorize = new URL(await signIns.start(target));

    const page = await returnToPragma(authorize, { error: "access_denied" });

    expect(page.status).toBe(400);
    expect(standIn.tokenRequests).toHaveLength(0);
    expect(await signIns.status(target)).toEqual({ state: "signed-out", message: "The ChatGPT sign-in was declined." });
  });

  it("signs in without plan use when the person granted only their identity", async () => {
    const authorize = new URL(await signIns.start(target));
    answerCodes(authorize, { scope: "email openid profile" });
    standIn.tokenAnswer = (() => {
      const answer = standIn.tokenAnswer;
      return async (form: URLSearchParams) => {
        const response = await answer(form);
        const body = await response.json();
        delete body.refresh_token;
        return Response.json(body);
      };
    })();

    await returnToPragma(authorize, { code: "code-5", client_id: "oaiapp_1" });

    expect(await signIns.status(target)).toEqual({ state: "signed-in", email: "writer@example.com", planUsage: false });
  });

  it("asks for the plan permission again when the person turns it on later", async () => {
    await saveSignIn("chatgpt", { clientId: "oaiapp_1", subject: "user-1" });

    const authorize = new URL(await signIns.start(target, { planUsage: true }));

    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
  });

  it("ignores a callback whose state no sign-in is waiting for, and one sent under another host name", async () => {
    const authorize = new URL(await signIns.start(target));
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");

    const unknown = await fetch(`${callback.href}?state=forged&code=x&client_id=oaiapp_1`);
    expect(unknown.status).toBe(400);

    const rebound = await new Promise<number>((resolve, reject) => {
      const sent = request(
        {
          host: "127.0.0.1",
          port: callback.port,
          path: `${callback.pathname}?state=x`,
          headers: { host: "evil.test" },
        },
        (response) => resolve(response.statusCode ?? 0),
      );
      sent.on("error", reject);
      sent.end();
    });
    expect(rebound).toBe(404);
    expect(await signIns.status(target)).toEqual({ state: "pending" });
  });

  it("brings nothing back when the person signs out while the code is being exchanged", async () => {
    const authorize = new URL(await signIns.start(target));
    answerCodes(authorize);
    const issue = standIn.tokenAnswer;
    let release: () => void = () => {};
    standIn.tokenAnswer = async (form) => {
      await new Promise<void>((resolve) => (release = resolve));
      return issue(form);
    };

    const page = returnToPragma(authorize, { code: "code-6", client_id: "oaiapp_1" });
    await vi.waitFor(() => expect(standIn.tokenRequests).toHaveLength(1));
    await signIns.signOut(target);
    release();

    expect((await page).status).toBe(502);
    expect(await readChatGptSignIn("chatgpt")).toEqual({ clientId: "oaiapp_1" });
  });

  it("signs out by ending the session at ChatGPT and keeping the registration", async () => {
    await saveSignIn("chatgpt", {
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "writer@example.com",
      scopes: ["chatgpt.tokens.use.direct"],
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000 },
    });

    expect(await signIns.signOut(target)).toEqual({ revoked: true });

    expect(Object.fromEntries(standIn.revocations[0])).toEqual({
      token: "rt-1",
      token_type_hint: "refresh_token",
      client_id: "oaiapp_1",
    });
    expect(await readChatGptSignIn("chatgpt")).toEqual({
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "writer@example.com",
    });
    expect((await signIns.status(target)).state).toBe("signed-out");
  });

  it("reports a sign-out ChatGPT didn't confirm, with the tokens gone all the same", async () => {
    standIn.revocationStatus = 503;
    await saveSignIn("chatgpt", {
      clientId: "oaiapp_1",
      scopes: ["chatgpt.tokens.use.direct"],
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000 },
    });

    expect(await signIns.signOut(target)).toEqual({ revoked: false });

    expect(standIn.revocations).toHaveLength(2);
    expect((await readChatGptSignIn("chatgpt")).tokens).toBeUndefined();
  });
});

// Another window, or `pragma run` beside the app, changing the same sign-in:
// written straight to the store, as that process would.
describe("ChatGPT sign-in beside another process", () => {
  it("is cancelled when the person signs out while ChatGPT's settings are being read", async () => {
    let release: () => void = () => {};
    const discovered = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("openid-configuration")) await discovered;
      return standIn.fetch(input, init);
    });

    const starting = signIns.start(target);
    await vi.waitFor(async () =>
      expect((await credentialStore().inspect(chatGptSignInSlot("chatgpt"))).state).toBe("live"),
    );
    await signIns.signOut(target);
    release();

    await expect(starting).rejects.toThrow(/cancelled/);
  });

  it("registers nothing when another window signs out before ChatGPT returns", async () => {
    const authorize = new URL(await signIns.start(target));
    await saveSignIn("chatgpt", {});

    const page = await returnToPragma(authorize, { code: "code-7", client_id: "oaiapp_1" });

    expect(page.status).toBe(502);
    expect(await page.text()).toContain("cancelled");
    expect(standIn.tokenRequests).toHaveLength(0);
    expect(await readChatGptSignIn("chatgpt")).toEqual({});
  });

  it("brings nothing back when another window signs out while the code is being exchanged", async () => {
    const authorize = new URL(await signIns.start(target));
    answerCodes(authorize);
    const issue = standIn.tokenAnswer;
    let release: () => void = () => {};
    standIn.tokenAnswer = async (form) => {
      await new Promise<void>((resolve) => (release = resolve));
      return issue(form);
    };

    const page = returnToPragma(authorize, { code: "code-8", client_id: "oaiapp_1" });
    await vi.waitFor(() => expect(standIn.tokenRequests).toHaveLength(1));
    await saveSignIn("chatgpt", { clientId: "oaiapp_1" });
    release();

    expect((await page).status).toBe(502);
    expect(await readChatGptSignIn("chatgpt")).toEqual({ clientId: "oaiapp_1" });
  });

  it("gives way to a newer sign-in started in another window", async () => {
    const elsewhere = createChatGptSignIns({ hostId: () => HOST_ID });
    try {
      const first = new URL(await signIns.start(target));
      await elsewhere.start(target);
      answerCodes(first);

      const page = await returnToPragma(first, { code: "code-9", client_id: "oaiapp_1" });

      expect(page.status).toBe(502);
      expect((await readChatGptSignIn("chatgpt")).tokens).toBeUndefined();
    } finally {
      await elsewhere.close();
    }
  });

  it("isn't cancelled by renewing the sign-in it is about to replace", async () => {
    await saveSignIn("chatgpt", {
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "writer@example.com",
      scopes: ["chatgpt.tokens.use.direct", "offline_access"],
      tokens: { accessToken: "at-0", refreshToken: "rt-0", expiresAt: Date.now() + 30_000 },
    });
    const authorize = new URL(await signIns.start(target, { planUsage: true }));

    expect(await chatGptAccessToken("chatgpt")).toBe("at-1");
    answerCodes(authorize);
    const signedIn = standIn.tokenAnswer;
    standIn.tokenAnswer = async (form) => {
      const body = await (await signedIn(form)).json();
      return Response.json({ ...body, access_token: "at-new", refresh_token: "rt-new" });
    };
    const page = await returnToPragma(authorize, { code: "code-10" });

    expect(page.status).toBe(200);
    expect(standIn.tokenRequests.map((form) => form.get("grant_type"))).toEqual([
      "refresh_token",
      "authorization_code",
    ]);
    expect((await readChatGptSignIn("chatgpt")).tokens).toMatchObject({
      accessToken: "at-new",
      refreshToken: "rt-new",
    });
  });
});

describe("ChatGPT sign-in on the desktop's encrypted store", () => {
  // Seals by prefixing "sealed:"; counts what the keychain is asked to open.
  const keychain = { unseals: 0, locked: false };
  const protector: Protector = {
    canSave: async () => ({ ok: true }),
    lastCheck: () => ({ ok: true }),
    seal: async (value: string): Promise<SealedPart> => ({ protection: "fake", tag: "v11", data: `sealed:${value}` }),
    unseal: async (part: SealedPart) => {
      keychain.unseals += 1;
      if (keychain.locked) throw new Error("The keychain is locked.");
      return { value: part.data.replace(/^sealed:/, ""), reseal: false };
    },
  };

  beforeEach(async () => {
    keychain.unseals = 0;
    keychain.locked = false;
    setCredentialStore(createFileCredentialStore({ backing: "encrypted", root: globalConfigDir, protector }));
    await saveSignIn("chatgpt", {
      clientId: "oaiapp_1",
      subject: "user-1",
      email: "writer@example.com",
      scopes: ["chatgpt.tokens.use.direct"],
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000 },
    });
  });

  it("reports the sign-in without asking the keychain", async () => {
    expect(await signIns.status(target)).toEqual({ state: "signed-in", email: "writer@example.com", planUsage: true });
    expect(keychain.unseals).toBe(0);
  });

  it("signs out while the keychain is locked, and says ChatGPT wasn't told", async () => {
    keychain.locked = true;

    expect(await signIns.signOut(target)).toEqual({ revoked: false });

    expect(standIn.revocations).toHaveLength(0);
    expect(await signIns.status(target)).toEqual({ state: "signed-out" });
    expect(await credentialStore().inspect(chatGptSignInSlot("chatgpt"))).toMatchObject({
      state: "live",
      parts: [],
      metadata: { clientId: "oaiapp_1", email: "writer@example.com" },
    });
  });
});
