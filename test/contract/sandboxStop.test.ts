import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// A run stopped in the browser aborts its request to /api/sandbox/*, and the
// server has to carry that abort on to the model, or the call runs, billed,
// to the end. A stand-in model that never answers shows whether it did.
describe("API contract — stopping a generation", () => {
  let testServer: TestServer;
  let model: Server;
  let seen = 0;
  let closed = 0;

  beforeAll(async () => {
    testServer = await startTestServer();
    model = createServer((req) => {
      seen += 1;
      req.on("close", () => {
        closed += 1;
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { port } = model.address() as AddressInfo;
    saveGlobalConfig({
      ...loadGlobalConfig(),
      modelProviders: [{ id: "hung", kind: "openai", baseURL: `http://127.0.0.1:${port}/v1`, textModels: ["m"] }],
    });

    const file = "hang.flow.html";
    await writeFile(
      path.join(testServer.spaceRoot, file),
      serializeFlowFile({
        version: "1.0",
        name: "Hang",
        graph: {
          nodes: [
            { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hi" } },
            { id: "gen-1", type: "generateText", position: { x: 0, y: 0 }, config: { model: "hung/m" } },
          ],
          edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "gen-1", targetPort: "prompt" }],
        },
      }),
    );
    const flow = await readFlowFile(path.join(testServer.spaceRoot, file));
    await grantCapability(
      testServer.spaceRoot,
      { path: file, contentHash: capabilityDigest(flow.graph) },
      "generateText",
    );
  });

  afterAll(async () => {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await testServer.close();
  });

  for (const route of ["generate", "generate-options"]) {
    it(`closes the model call when ${route}'s request is aborted`, async () => {
      const before = { seen, closed };
      const stop = new AbortController();
      const pending = fetch(`${testServer.baseUrl}/api/sandbox/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "flow",
          path: "hang.flow.html",
          instruction: "hi",
          values: {},
          images: {},
          model: "hung/m",
          numOptions: 3,
        }),
        signal: stop.signal,
      }).catch(() => undefined);
      await vi.waitFor(() => expect(seen).toBe(before.seen + 1));

      stop.abort();
      await pending;
      await vi.waitFor(() => expect(closed).toBe(before.closed + 1));
    });
  }
});
