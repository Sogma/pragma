import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import type { McpServerConnectResponse } from "../../src/protocol/api.ts";
import { mcpSignIns, saveMcpSignIn } from "../../src/server/mcpSignIn.ts";
import { createSpaceApiRoutes, type SpaceApp } from "../../src/server/routes.ts";
import { type OAuthStandIn, startOAuthStandIn } from "../support/oauthStandIn.ts";

// The MCP server routes on a host that is the writer's own machine: what the
// Add form learns about a server it has just saved, and Remove, the one way
// to sign out. The contract suite covers the remote-access posture, where
// nothing signs in.

let standIn: OAuthStandIn;
let configDir: string;
let space: string;
let app: SpaceApp;

beforeEach(async () => {
  standIn = await startOAuthStandIn();
  space = mkdtempSync(path.join(tmpdir(), "pragma-mcp-routes-space-"));
  // Servers and sign-ins rest in the global config, so it points at a
  // throwaway directory.
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-mcp-routes-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ mcpServers: [{ id: "standin", label: "Stand-in", url: `${standIn.base}/mcp` }] }),
  );
  app = createSpaceApiRoutes(space, undefined, { ownMachine: true });
});

afterEach(async () => {
  await mcpSignIns.close();
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(space, { recursive: true, force: true });
  await standIn.close();
});

async function connect(): Promise<McpServerConnectResponse> {
  const res = await app.request("/api/mcp-servers/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "standin" }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("POST /api/mcp-servers/connect", () => {
  it("lists the tools of a server that wants no credentials", async () => {
    standIn.requireToken = false;
    expect(await connect()).toEqual({ state: "connected", tools: ["ping"] });
  });

  it("starts a sign-in for a server that offers OAuth", async () => {
    const result = await connect();
    expect(result.state).toBe("sign-in");
    expect(result.state === "sign-in" && result.authorizationUrl).toMatch(new RegExp(`^${standIn.base}/authorize\\?`));
  });

  it("asks for a token when the server offers no sign-in", async () => {
    standIn.offersOAuth = false;
    expect(await connect()).toEqual({ state: "needs-token", message: "This server needs a token." });

    await app.request("/api/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "standin", apiKey: "not-accepted" }),
    });
    expect(await connect()).toEqual({ state: "needs-token", message: "The server rejected the token." });
  });
});

describe("POST /api/mcp-servers/delete", () => {
  it("revokes a signed-in server's refresh token before deleting it", async () => {
    const tokens = standIn.issueTokens();
    const metadata = await (await fetch(`${standIn.base}/.well-known/oauth-authorization-server`)).json();
    await saveMcpSignIn(
      { id: "standin", label: "Stand-in", url: `${standIn.base}/mcp` },
      {
        client: { client_id: "client-1" },
        discovery: { authorizationServerUrl: standIn.base, authorizationServerMetadata: metadata },
        tokens,
        expiresAt: Date.now() + 3600 * 1000,
      },
    );

    const res = await app.request("/api/mcp-servers/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "standin" }),
    });
    expect(res.status).toBe(204);
    expect(standIn.revoked).toEqual([tokens.refresh_token]);
    expect((await credentialStore().inspect({ kind: "mcp-sign-ins", id: "standin" })).state).toBe("cleared");
  });
});
