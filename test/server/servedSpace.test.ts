import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentEndpoint } from "../../src/cli/hostSpace.ts";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { AgentEndpoint } from "../../src/server/apiServer.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { mintApiToken } from "../support/agentEndpoint.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

let first: string;
let second: string;
let endpoint: AgentEndpoint | undefined;

beforeEach(() => {
  isolateConfig();
  first = tempSpace("pragma-served-first-");
  second = tempSpace("pragma-served-second-");
  saveGlobalConfig({ ...loadGlobalConfig(), api: { enabled: true, port: 0 } });
});

afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
  vi.restoreAllMocks();
});

describe("a switch of the served space", () => {
  it("moves a CLI host's agent endpoint, tokens and all", async () => {
    const firstToken = mintApiToken(first, { label: "reader" });
    const secondToken = mintApiToken(second, { label: "reader" });
    const served = createServedSpace(first);
    vi.spyOn(console, "log").mockImplementation(() => {});
    endpoint = await openAgentEndpoint(served);
    const space = (token: string) =>
      fetch(`http://127.0.0.1:${endpoint?.port()}/space`, { headers: { authorization: `Bearer ${token}` } });

    expect(await (await space(firstToken)).json()).toMatchObject({ name: path.basename(first) });
    served.switchTo(second);
    expect(await (await space(secondToken)).json()).toMatchObject({ name: path.basename(second) });
    expect((await space(firstToken)).status).toBe(403);
  });

  it("rebuilds the routes for the new space", async () => {
    const served = createServedSpace(first);
    const routes = spaceRoutes(served, { ownMachine: true });
    const name = async () => ((await (await routes().request("/api/space/info")).json()) as { name: string }).name;

    expect(await name()).toBe(path.basename(first));
    served.switchTo(second);
    expect(await name()).toBe(path.basename(second));
  });
});
