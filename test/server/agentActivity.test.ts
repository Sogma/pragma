import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApiToken,
  findSpaceId,
  loadGlobalConfig,
  rememberSpace,
  saveGlobalConfig,
} from "../../src/config/loadConfig.ts";
import { activitySince, resetActivityLog } from "../../src/server/activityLog.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../../src/server/apiServer.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

// Over real HTTP, like the REST and MCP suites: what the Console reports is
// what actually reached the listener, not what a unit test handed a function.
let space: string;
let endpoint: AgentEndpoint | undefined;
let base: string;
let token: string;

const entries = () => activitySince(0).entries;

// The body is read to completion, not just awaited: an entry is written once
// the handler has finished answering, and fetch resolves as soon as the
// headers land — asserting before the body drains would race it.
async function rest(route: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${base}${route}`, { headers });
  await res.text();
  return res.status;
}

async function mcp(body: unknown, bearer = token): Promise<void> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  await res.text();
}

beforeEach(async () => {
  isolateConfig();
  space = tempDir("pragma-activity-space-");
  writeFileSync(path.join(space, "hello.md"), "# Hello\n");

  saveGlobalConfig({ ...rememberSpace(loadGlobalConfig(), space), api: { enabled: true, port: 0 } });
  const config = loadGlobalConfig();
  const { secret, record } = createApiToken({
    label: "Claude Desktop",
    spaceId: findSpaceId(config, space) as string,
    access: "read-only",
  });
  saveGlobalConfig({ ...config, apiTokens: [...(config.apiTokens ?? []), record] });
  token = secret;

  endpoint = createAgentEndpoint(() => space);
  await endpoint.apply();
  base = `http://127.0.0.1:${endpoint.port()}`;
  // After startup, so the log holds only what each test provoked.
  resetActivityLog();
});

afterEach(async () => {
  await endpoint?.close();
});

describe("what the agent endpoint reports to the Console", () => {
  it("records a refused token as a warning, naming why", async () => {
    // The case that has no other trace anywhere: the client sees a 401 and
    // pragma's own window would otherwise show nothing at all.
    expect(await rest("/space", { authorization: "Bearer nonsense" })).toBe(401);

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ level: "warn", kind: "API", label: "Refused: Unknown token" });
    expect(entries()[0].content).toContain("GET /space");
  });

  it("records a refused browser origin", async () => {
    const status = await rest("/space", { authorization: `Bearer ${token}`, origin: "http://evil.example" });
    expect(status).toBe(403);
    expect(entries()[0]).toMatchObject({
      level: "warn",
      label: "Refused: Browser origins are not accepted on this endpoint",
    });
  });

  it("records a REST call with the token that made it", async () => {
    await rest("/files/hello.md", { authorization: `Bearer ${token}` });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ level: "info", kind: "API", label: "GET /files/hello.md" });
    expect(entries()[0].content).toContain("Claude Desktop");
    expect(entries()[0].content).toContain("read-only");
  });

  it("warns on a REST route that does not exist", async () => {
    await rest("/nope", { authorization: `Bearer ${token}` });
    expect(entries()[0]).toMatchObject({ level: "warn", label: "GET /nope" });
  });

  it("reports initialize as the client connecting, by name", async () => {
    await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "Claude Desktop", version: "1.2.3" },
      },
    });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ level: "info", kind: "MCP", label: "Connected: Claude Desktop 1.2.3" });
  });

  it("names the tool a call invoked", async () => {
    await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_space_file", arguments: { path: "hello.md" } },
    });

    expect(entries()[0]).toMatchObject({ kind: "MCP", label: "read_space_file" });
    expect(entries()[0].content).toContain("hello.md");
  });

  it("records nothing at all when no one calls", () => {
    expect(entries()).toEqual([]);
  });
});
