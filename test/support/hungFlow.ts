import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { grantCapability, setUnattended } from "../../src/server/grants.ts";

// A Flow at `file` in `space` whose model endpoint never answers, so a run of
// it is reliably in flight, granted to run unattended. It says whether the
// model request came and whether it has been closed.
export async function hungFlow(
  space: string,
  file: string,
): Promise<{ closed: () => boolean; seen: () => boolean; stop: () => void }> {
  let seen = false;
  let closed = false;
  const hung = createServer((req) => {
    seen = true;
    req.on("close", () => (closed = true));
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const port = (hung.address() as { port: number }).port;
  saveGlobalConfig({
    ...loadGlobalConfig(),
    modelProviders: [{ id: "hung", kind: "openai", baseURL: `http://127.0.0.1:${port}/v1`, textModels: ["m"] }],
  });
  writeFileSync(
    path.join(space, file),
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
  const flow = await readFlowFile(path.join(space, file));
  const subject = { path: file, contentHash: capabilityDigest(flow.graph) };
  await grantCapability(space, subject, "generateText");
  await setUnattended(space, subject, true);
  return {
    closed: () => closed,
    seen: () => seen,
    stop: () => {
      hung.closeAllConnections();
      hung.close();
    },
  };
}
