import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { grantCapability, isCapabilityGranted } from "../../src/server/grants.ts";
import { saveDocument } from "../../src/server/saveDocument.ts";

// Grants are install-global: PRAGMA_CONFIG_DIR keeps these off the
// developer's own approvals.
let configDir: string;
let space: string;
const relativePath = "shot.flow.html";

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  space = mkdtempSync(path.join(tmpdir(), "pragma-save-"));
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function graph(appletConfig: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: "loadRow-1", type: "loadRow", position: { x: 0, y: 0 }, config: { tablePath: "takes.table.html" } },
      {
        id: "applet-1",
        type: "applet",
        position: { x: 300, y: 0 },
        config: { appletPath: "stage.applet.html", ...appletConfig },
      },
    ],
    edges: [],
  };
}

const file = (flow: FlowGraph) => serializeFlowFile({ version: "1.0", graph: flow });

async function saveOver(before: FlowGraph, after: FlowGraph): Promise<boolean> {
  const filePath = path.join(space, relativePath);
  writeFileSync(filePath, file(before));
  const subject = (flow: FlowGraph) => ({ path: relativePath, contentHash: capabilityDigest(flow) });
  await grantCapability(space, subject(before), "readFile:takes.table.html");
  await saveDocument(space, { filePath, relativePath }, file(after));
  return await isCapabilityGranted(space, subject(after), "readFile:takes.table.html");
}

describe("saving a Flow with an Applet node", () => {
  it("carries the grants across a change to what the Applet reported", async () => {
    const before = graph({ appletHash: "h1", outputs: { description: { type: "text", value: "Wide shot" } } });
    const after = graph({ appletHash: "h1", outputs: { description: { type: "text", value: "Close-up" } } });
    expect(await saveOver(before, after)).toBe(true);
  });

  it("drops them when the Applet's code changed, so the next run asks again", async () => {
    expect(await saveOver(graph({ appletHash: "h1" }), graph({ appletHash: "h2" }))).toBe(false);
  });
});

describe("saving a document in a site", () => {
  it("stamps its dates into the block and leaves every other line as written", async () => {
    mkdirSync(path.join(space, "blog"));
    writeFileSync(path.join(space, "blog/_site.json"), JSON.stringify({ id: "ste_1", slug: "blog", name: "Blog" }));
    const filePath = path.join(space, "blog/post.md");
    const post = "---\n# reviewed\ndate: 2026-09-01   # launch\ntags: [essay, draft]\n---\n\n# Post\n";

    const { dates } = await saveDocument(space, { filePath, relativePath: "blog/post.md" }, post);

    expect(dates).toBeDefined();
    expect(readFileSync(filePath, "utf8")).toBe(
      post.replace("draft]\n", `draft]\ncreated: ${dates?.created}\nupdated: ${dates?.updated}\n`),
    );
  });
});
