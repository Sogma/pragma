import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import {
  createMcpSignIns,
  type McpSignIns,
  SignInRequiredError,
  type SignInTarget,
} from "../../src/server/mcpSignIn.ts";
import { holdLockInAnotherProcess, releaseLockHolders } from "../support/lockHolder.ts";
import { type OAuthStandIn, startOAuthStandIn } from "../support/oauthStandIn.ts";

// OAuth sign-in against a stand-in authorization server. The test plays the
// browser: it follows the consent redirect to the loopback callback, as a
// person approving would.

const slot = { kind: "mcp-sign-ins", id: "standin" } as const;

// The tokens the sign-in holds now, as another process would read them.
async function storedTokens(url: string): Promise<Record<string, unknown> | undefined> {
  const selected = await credentialStore().select(slot, url);
  return selected.ok ? JSON.parse(selected.secrets.tokens) : undefined;
}

// A port free now, so the callback keeps one redirect across sign-ins, as
// the fixed production port does.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("MCP sign-in", () => {
  let standIn: OAuthStandIn;
  let signIns: McpSignIns;
  let target: SignInTarget;
  let clock: number;
  let configDir: string;

  beforeEach(async () => {
    standIn = await startOAuthStandIn();
    // Sign-ins rest under the config folder, so it points at a throwaway one.
    configDir = mkdtempSync(path.join(tmpdir(), "pragma-mcp-sign-in-"));
    process.env.PRAGMA_CONFIG_DIR = configDir;
    clock = 1_000_000;
    signIns = createMcpSignIns({ port: await freePort(), now: () => clock });
    target = { id: "standin", label: "Stand-in", url: `${standIn.base}/mcp` };
  });

  afterEach(async () => {
    await releaseLockHolders();
    vi.unstubAllGlobals();
    await signIns.close();
    await standIn.close();
    delete process.env.PRAGMA_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  // Starts a sign-in and approves it, returning the callback the browser hit.
  async function signIn(): Promise<string> {
    const authorizationUrl = await signIns.start(target);
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = consent.headers.get("location") ?? "";
    const landing = await fetch(callback);
    expect(landing.status).toBe(200);
    return callback;
  }

  it("signs in through the person's browser and a loopback callback", async () => {
    const authorizationUrl = await signIns.start(target);
    expect(await signIns.status(target)).toEqual({ state: "pending" });

    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = consent.headers.get("location") ?? "";
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/);
    const landing = await fetch(callback);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Signed in to Stand-in");

    expect(await signIns.status(target)).toEqual({ state: "signed-in" });
    expect(await signIns.accessToken(target)).toBe("at-1");
    const asked = standIn.authorizeRequests[0];
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("resource")).toBe(`${standIn.base}/mcp`);
    expect(standIn.registrations).toEqual([
      expect.objectContaining({
        token_endpoint_auth_method: "none",
        redirect_uris: [`${new URL(callback).origin}/callback`],
      }),
    ]);
  });

  it("closes the callback listener once no sign-in is pending", async () => {
    const callback = await signIn();
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("refuses a callback link that was already used", async () => {
    const other: SignInTarget = { ...target, id: "other" };
    await signIns.start(other);
    const callback = await signIn();

    const reused = await fetch(callback);
    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain("expired or was already used");
    expect(await signIns.status(other)).toEqual({ state: "pending" });
  });

  it("refreshes a token near expiry once, however many callers ask, and keeps the rotated one", async () => {
    await signIn();
    clock += 3600 * 1000;

    const tokens = await Promise.all([
      signIns.accessToken(target),
      signIns.accessToken(target),
      signIns.accessToken(target),
    ]);
    expect(tokens).toEqual(["at-2", "at-2", "at-2"]);
    expect(standIn.refreshCount).toBe(1);
    expect((await storedTokens(target.url))?.refresh_token).toBe("rt-2");

    expect(await signIns.accessToken(target)).toBe("at-2");
    expect(standIn.refreshCount).toBe(1);
  });

  it("refreshes on demand, for a token the server stopped accepting early", async () => {
    await signIn();

    expect(await signIns.accessToken(target, { refresh: true })).toBe("at-2");
    expect(standIn.refreshCount).toBe(1);
  });

  it("signs out when the refresh is refused, and says how to fix it", async () => {
    await signIn();
    standIn.refreshAnswer = "refuse";
    clock += 3600 * 1000;

    const refused = signIns.accessToken(target);
    await expect(refused).rejects.toBeInstanceOf(SignInRequiredError);
    await expect(refused).rejects.toThrow("Sign in to Stand-in again in Settings → MCP Servers");
    expect(await signIns.status(target)).toEqual({ state: "signed-out", message: "The sign-in expired." });
    expect(await signIns.accessToken(target)).toBeUndefined();
  });

  it("keeps the sign-in when the authorization server is unavailable", async () => {
    await signIn();
    standIn.refreshAnswer = "unavailable";
    clock += 3600 * 1000;

    const failed = signIns.accessToken(target);
    await expect(failed).rejects.toThrow();
    await expect(failed).rejects.not.toBeInstanceOf(SignInRequiredError);
    expect(await signIns.status(target)).toEqual({ state: "signed-in" });
  });

  it("revokes the refresh token on sign-out and keeps the registration", async () => {
    await signIn();
    await signIns.signOut(target);

    expect(standIn.revoked).toEqual(["rt-1"]);
    expect(await signIns.status(target)).toEqual({ state: "signed-out" });
    expect(await signIns.accessToken(target)).toBeUndefined();

    await signIn();
    expect(standIn.registrations).toHaveLength(1);
  });

  it("serves a sign-in only to the URL it was made for, yet revokes it from anywhere", async () => {
    await signIn();
    const moved: SignInTarget = { ...target, url: `${standIn.base}/elsewhere` };

    expect(await signIns.accessToken(moved)).toBeUndefined();
    expect(await signIns.status(moved)).toEqual({ state: "signed-out" });

    await signIns.signOut(moved);
    expect(standIn.revoked).toEqual(["rt-1"]);
    expect((await credentialStore().inspect(slot)).state).toBe("cleared");
  });

  it("reports a sign-in the person declined", async () => {
    standIn.denyConsent = true;
    const authorizationUrl = await signIns.start(target);
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const landing = await fetch(consent.headers.get("location") ?? "");

    expect(landing.status).toBe(400);
    expect(await landing.text()).toContain("The person declined");
    expect(await signIns.status(target)).toEqual({
      state: "signed-out",
      message: "Stand-in refused the sign-in: The person declined",
    });
  });

  it("has no token for a target that never signed in", async () => {
    expect(await signIns.status(target)).toEqual({ state: "signed-out" });
    expect(await signIns.accessToken(target)).toBeUndefined();
  });

  it("keeps the tokens out of the record's open details", async () => {
    await signIn();

    const record = await credentialStore().inspect(slot);
    expect(record).toMatchObject({ state: "live", parts: ["tokens"] });
    expect(JSON.stringify(record)).not.toMatch(/at-1|rt-1/);
  });

  it("never reads a sign-in left in config.json by an earlier version", async () => {
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        mcpServers: [{ id: "standin", url: target.url, signIn: JSON.stringify({ url: target.url, tokens: {} }) }],
        mcpSignInsEncrypted: { standin: "b2xk" },
      }),
    );

    expect(await signIns.accessToken(target)).toBeUndefined();
    expect(await signIns.status(target)).toEqual({ state: "signed-out" });
  });

  it("refuses a sign-in whose record can't be read, and says to sign in again", async () => {
    await signIn();
    const file = path.join(configDir, "credentials", "plain", "mcp-sign-ins", "id-standin.json");
    writeFileSync(file, "{ not json", { mode: 0o600 });

    await expect(signIns.accessToken(target)).rejects.toThrow(/saved sign-in can't be used.*Sign in to Stand-in again/);
    expect(await signIns.status(target)).toMatchObject({ state: "signed-out", message: /can't be used/ });
  });

  it("waits on another process's refresh and uses its token, rather than spending the refresh token again", async () => {
    await signIn();
    clock += 3600 * 1000;
    const lock = path.join(configDir, "credentials", "plain", "mcp-sign-ins", "id-standin.renewal.lock");
    const holder = await holdLockInAnotherProcess(lock);
    const waiting = signIns.accessToken(target);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The other process refreshes and saves before it lets go.
    const current = await credentialStore().inspect(slot);
    if (current.state !== "live") throw new Error("not signed in");
    await credentialStore().set(slot, current.observation, {
      endpoint: target.url,
      metadata: { ...current.metadata, expiresAt: clock + 3600 * 1000 },
      secrets: { tokens: JSON.stringify({ access_token: "at-elsewhere", refresh_token: "rt-elsewhere" }) },
    });
    await holder.release();

    expect(await waiting).toBe("at-elsewhere");
    expect(standIn.refreshCount).toBe(0);
  });
});

// A sign-out from another window, written straight to the store, or one here
// while the SDK is mid-flow: the sign-in it ends never comes back.
describe("MCP sign-in cancelled mid-flow", () => {
  let standIn: OAuthStandIn;
  let signIns: McpSignIns;
  let target: SignInTarget;
  let configDir: string;

  beforeEach(async () => {
    standIn = await startOAuthStandIn();
    configDir = mkdtempSync(path.join(tmpdir(), "pragma-mcp-sign-in-"));
    process.env.PRAGMA_CONFIG_DIR = configDir;
    signIns = createMcpSignIns({ port: await freePort() });
    target = { id: "standin", label: "Stand-in", url: `${standIn.base}/mcp` };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await signIns.close();
    await standIn.close();
    delete process.env.PRAGMA_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  // Holds every request to `path` until the returned release is called.
  function holdRequests(pathname: string): () => void {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === pathname) await held;
      return realFetch(input, init);
    });
    return release;
  }

  it("saves no registration when the person signs out while Pragma registers", async () => {
    const release = holdRequests("/register");
    const starting = signIns.start(target);
    await vi.waitFor(async () => expect((await credentialStore().inspect(slot)).state).toBe("live"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await signIns.signOut(target);
    release();

    await expect(starting).rejects.toThrow(/cancelled/);
    const record = await credentialStore().inspect(slot);
    expect(record.state === "live" && record.metadata?.clientId).toBeFalsy();
  });

  it("saves no tokens when another window signs out before the code is exchanged", async () => {
    const authorizationUrl = await signIns.start(target);
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    // Another window's sign-out: the record without this attempt's claim.
    const current = await credentialStore().inspect(slot);
    if (current.state !== "live") throw new Error("no attempt");
    const { attempt: _attempt, ...details } = current.metadata ?? {};
    await credentialStore().set(slot, current.observation, { endpoint: target.url, metadata: details, secrets: {} });

    const landing = await fetch(consent.headers.get("location") ?? "");

    expect(landing.status).toBe(502);
    expect(await landing.text()).toContain("cancelled");
    expect(await signIns.accessToken(target)).toBeUndefined();
  });
});
