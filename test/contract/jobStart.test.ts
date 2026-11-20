import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { JobsResponse, JobView } from "../../src/protocol/api.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { type HiggsfieldStandIn, startHiggsfieldStandIn } from "../support/higgsfieldStandIn.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// The generation routes rebuild a request field by field, so a start id they
// don't read never reaches the job, and the Tools tab lists a job that is
// starting beside its own run. Requests shaped as the browser sends them
// show the id coming back on each kind of job.
//
// As in the video reference contract, the configured server is the
// adapter's own host, and this process's requests to it go to the stand-in.
describe("API contract: a job's start id", () => {
  const FLOW = "start.flow.html";
  const HOSTED = "https://mcp.higgsfield.ai/mcp";
  let testServer: TestServer;
  let standIn: HiggsfieldStandIn;

  beforeAll(async () => {
    testServer = await startTestServer();
    standIn = await startHiggsfieldStandIn();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return realFetch(url.startsWith(HOSTED) ? standIn.url + url.slice(HOSTED.length) : input, init);
    });
    saveGlobalConfig({
      ...loadGlobalConfig(),
      mcpServers: [{ id: "higgsfield", label: "Higgsfield", url: HOSTED, flows: true }],
    });
    await credentialStore().set(
      { kind: "mcp-tokens", id: "higgsfield" },
      { absent: true },
      { endpoint: HOSTED, secrets: { key: "test-key" } },
    );

    const { spaceRoot } = testServer;
    await mkdir(path.join(spaceRoot, "renders"), { recursive: true });
    const folder = { outputFolderPath: "renders" };
    await writeFile(
      path.join(spaceRoot, FLOW),
      serializeFlowFile({
        version: "1.0",
        name: "Start",
        graph: {
          nodes: [
            { id: "image-1", type: "generateImage", position: { x: 0, y: 0 }, config: folder },
            { id: "video-1", type: "generateVideo", position: { x: 0, y: 0 }, config: folder },
          ],
          edges: [],
        },
      }),
    );
    const flow = await readFlowFile(path.join(spaceRoot, FLOW));
    const subject = { path: FLOW, contentHash: capabilityDigest(flow.graph) };
    await grantCapability(spaceRoot, subject, "generateImage:space:renders");
    await grantCapability(spaceRoot, subject, "generateVideo:space:renders");
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await standIn.close();
    await testServer.close();
  });

  // Starts a job through a route, and finds it as the Tools tab lists it.
  async function start(route: string, fields: Record<string, unknown>): Promise<JobView | undefined> {
    const response = await fetch(`${testServer.baseUrl}/api/sandbox/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "flow", path: FLOW, folder: "renders", ...fields }),
    });
    expect([response.status, response.status === 200 ? "" : await response.text()]).toEqual([200, ""]);
    const { job } = (await response.json()) as { job?: string };
    expect(job).toBeTypeOf("string");
    const listed = await fetch(`${testServer.baseUrl}/api/jobs?path=${encodeURIComponent(FLOW)}`);
    const { jobs } = (await listed.json()) as JobsResponse;
    return jobs.find((each) => each.id === job);
  }

  it("hands a clip's start id back on its job", async () => {
    const job = await start("generate-video", {
      prompt: "A kite at dusk",
      model: "higgsfield/seedance_2_5",
      startId: "start-video",
    });
    expect(job).toMatchObject({ kind: "video", startId: "start-video" });
  });

  it("hands an image's start id back on its job", async () => {
    const job = await start("generate-image", {
      prompt: "A kite at dusk",
      references: [],
      model: "higgsfield/soul_2",
      startId: "start-image",
    });
    expect(job).toMatchObject({ kind: "image", startId: "start-image" });
  });

  it("starts the job all the same when the start id isn't a short token, leaving the id out", async () => {
    const job = await start("generate-video", {
      prompt: "Steam rises from the red cup",
      model: "higgsfield/seedance_2_5",
      startId: "not a token",
    });
    expect(job).toBeDefined();
    expect(job).not.toHaveProperty("startId");
  });
});
