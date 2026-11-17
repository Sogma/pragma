import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import type { ResolvedMcpServer } from "../../src/config/loadConfig.ts";
import { saveMcpSignIn } from "../../src/server/mcpSignIn.ts";
import { connectMcpServer, mcpServerSignIn } from "../../src/server/mcpTools.ts";
import { type OAuthStandIn, startOAuthStandIn } from "../support/oauthStandIn.ts";

// The copilot's connector with a real MCP client against a stand-in server:
// which credential it sends, and the one refresh it allows itself on a 401.

let standIn: OAuthStandIn;
let configDir: string;
let server: ResolvedMcpServer;

// A hand-set bearer token for the server, as Settings would save it.
async function storeToken(token: string, url: string): Promise<void> {
  await credentialStore().set(
    { kind: "mcp-tokens", id: "standin" },
    { absent: true },
    { endpoint: url, secrets: { key: token } },
  );
}

beforeEach(async () => {
  standIn = await startOAuthStandIn();
  // Sign-ins rest in the global config, so it points at a throwaway directory.
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-mcp-sign-in-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  server = { id: "standin", label: "Stand-in", url: `${standIn.base}/mcp`, copilot: true, flows: false };
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ mcpServers: [{ id: "standin", label: "Stand-in", url: server.url }] }),
  );
});

afterEach(async () => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  await standIn.close();
});

// A sign-in as an earlier session left it. A stale one holds an access token
// the server no longer accepts, though its refresh token still works.
async function storeSignIn({ stale }: { stale: boolean }): Promise<void> {
  const tokens = standIn.issueTokens();
  const metadata = await (await fetch(`${standIn.base}/.well-known/oauth-authorization-server`)).json();
  const resourceMetadata = await (await fetch(`${standIn.base}/.well-known/oauth-protected-resource/mcp`)).json();
  await saveMcpSignIn(mcpServerSignIn(server), {
    client: { client_id: "client-1" },
    discovery: { authorizationServerUrl: standIn.base, authorizationServerMetadata: metadata, resourceMetadata },
    tokens: stale ? { ...tokens, access_token: "at-stale" } : tokens,
    expiresAt: Date.now() + 3600 * 1000,
  });
}

describe("connectMcpServer with a sign-in", () => {
  it("refreshes once on a 401 and retries with the new token", async () => {
    await storeSignIn({ stale: true });

    const connection = await connectMcpServer(server);
    try {
      expect(Object.keys(connection.tools)).toEqual(["ping"]);
    } finally {
      await connection.close();
    }
    expect(standIn.refreshCount).toBe(1);
  });

  it("sends the sign-in ahead of a stored token", async () => {
    await storeSignIn({ stale: false });

    await storeToken("not-accepted", server.url);
    const connection = await connectMcpServer(server);
    await connection.close();
    expect(standIn.refreshCount).toBe(0);
  });

  it("sends no token to a URL edited by hand after signing in", async () => {
    await storeSignIn({ stale: false });

    await expect(connectMcpServer({ ...server, url: `${server.url}?moved=1` })).rejects.toThrow(
      "Stand-in needs you to sign in, or a token",
    );
    expect(standIn.refreshCount).toBe(0);
  });

  it("doesn't refresh on a 401 for a hand-set token", async () => {
    await storeToken("not-accepted", server.url);
    await expect(connectMcpServer(server)).rejects.toThrow(/401/);
    expect(standIn.refreshCount).toBe(0);
  });
});
