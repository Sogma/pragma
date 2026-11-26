import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { type HiggsfieldStandIn, startHiggsfieldStandIn } from "../support/higgsfieldStandIn.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// The generate-video route rebuilds a request field by field, so a field it
// doesn't read never reaches the server half, and an async job runs without
// it. A request shaped as the browser sends one shows which clip reaches the
// provider, and how.
//
// A server's adapter is picked by its host, so the configured server is the
// adapter's own host, and this process's requests to it go to the recorded
// stand-in instead.
describe("API contract — a clip sent as a video reference", () => {
  const CLIP = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 3, 1, 4, 1, 5]);
  const FLOW = "clip.flow.html";
  const HOSTED = "https://mcp.higgsfield.ai/mcp";
  let testServer: TestServer;
  let standIn: HiggsfieldStandIn;

  beforeAll(async () => {
    testServer = await startTestServer();
    standIn = await startHiggsfieldStandIn();
    standIn.videoRoles = ["image_references", "video_references"];
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
    await mkdir(path.join(spaceRoot, "shots"), { recursive: true });
    await mkdir(path.join(spaceRoot, "renders"), { recursive: true });
    await writeFile(path.join(spaceRoot, "shots", "take.mp4"), CLIP);
    await writeFile(
      path.join(spaceRoot, FLOW),
      serializeFlowFile({
        version: "1.0",
        name: "Clip",
        graph: {
          nodes: [
            { id: "load-1", type: "loadVideo", position: { x: 0, y: 0 }, config: { videoPath: "shots/take.mp4" } },
            {
              id: "gen-1",
              type: "generateVideo",
              position: { x: 0, y: 0 },
              config: { outputFolderPath: "renders" },
            },
          ],
          edges: [{ id: "e1", source: "load-1", sourcePort: "video", target: "gen-1", targetPort: "video_1" }],
        },
      }),
    );
    const flow = await readFlowFile(path.join(spaceRoot, FLOW));
    const subject = { path: FLOW, contentHash: capabilityDigest(flow.graph) };
    await grantCapability(spaceRoot, subject, "generateVideo:space:renders");
    await grantCapability(spaceRoot, subject, "readFile:space:shots/take.mp4");
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await standIn.close();
    await testServer.close();
  });

  it("uploads the clip's own bytes as a video, placed as a video reference the prompt names in the model's words", async () => {
    const response = await fetch(`${testServer.baseUrl}/api/sandbox/generate-video`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "flow",
        path: FLOW,
        folder: "renders",
        prompt: "Move like @video_1",
        videoReferences: [{ pin: 1, path: "/shots/take.mp4", digest: createHash("sha256").update(CLIP).digest("hex") }],
        model: "higgsfield/seedance_2_5",
      }),
    });
    expect([response.status, response.status === 200 ? "" : await response.text()]).toEqual([200, ""]);
    await vi.waitFor(() => expect(standIn.generateCalls).toHaveLength(1), { timeout: 5000 });
    expect(standIn.uploadNames).toEqual(["reference.mp4"]);
    expect(standIn.confirmTypes).toEqual(["video"]);
    expect(standIn.uploads).toEqual([{ contentType: "video/mp4", bytes: CLIP.length }]);
    expect(standIn.generateCalls[0]).toMatchObject({
      prompt: "Move like @Video1",
      medias: [{ role: "video_references" }],
    });
  });

  it("refuses a malformed clip entry rather than starting without it", async () => {
    const response = await fetch(`${testServer.baseUrl}/api/sandbox/generate-video`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "flow",
        path: FLOW,
        folder: "renders",
        prompt: "Move like @video_1",
        videoReferences: [{ pin: 1, path: "/shots/take.mp4", digest: "not-a-digest" }],
        model: "higgsfield/seedance_2_5",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/digest must be a SHA-256/);
    expect(standIn.generateCalls).toHaveLength(1);
  });
});
