import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeFlowFile } from "../../../src/protocol/flowHtml.ts";
import { createSpaceApiRoutes } from "../../../src/server/routes.ts";
import { giveSpaceLibraries } from "../../support/libraries.ts";

// Every model resolves to the one a test sets, so a turn runs with no
// provider configured.
const resolvedTo = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../../../src/protocol/modelProvider.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModel: () => ({ languageModel: resolvedTo.model, effortLevels: [], wireModel: "mock" }),
  // Opening reads a key; the stand-in model needs none.
  openModel: async (model: unknown) => model,
}));

let spaceRoot: string;
let configDir: string;

beforeEach(() => {
  spaceRoot = mkdtempSync(path.join(tmpdir(), "pragma-assistant-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-assistant-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(spaceRoot, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function answering(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("the chat route", () => {
  it("hands each turn the context sources of the modules Pragma ships", async () => {
    mkdirSync(path.join(spaceRoot, "knowledge"));
    writeFileSync(path.join(spaceRoot, "knowledge", "index.md"), '---\nokf_version: "0.2"\n---\n# Knowledge\n');
    writeFileSync(path.join(spaceRoot, "knowledge", "orders.md"), "---\ntype: Table\n---\n# Orders\n");
    const model = answering("ok");
    resolvedTo.model = model;
    const app = createSpaceApiRoutes(spaceRoot, undefined, { ownMachine: true });

    const res = await app.request("/api/chat?path=knowledge/orders.md", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: [], message: "hi", model: "mock/model" }),
    });

    expect(res.status).toBe(200);
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain(
      "## Open Knowledge Format bundle (knowledge/index.md)",
    );
  });

  // A selection is the focused tab's: the tab beside is named, never quoted.
  it("quotes the node selected on the focused Flow's canvas, never on the Flow beside", async () => {
    const graph = {
      nodes: [{ id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "hello there" } }],
      edges: [],
    };
    writeFileSync(path.join(spaceRoot, "p.flow.html"), serializeFlowFile({ version: "1.0", graph }));
    const app = createSpaceApiRoutes(spaceRoot, undefined, { ownMachine: true });
    const promptFor = async (query: string) => {
      const model = answering("ok");
      resolvedTo.model = model;
      const res = await app.request(`/api/chat?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history: [], message: "hi", model: "mock/model" }),
      });
      expect(res.status).toBe(200);
      return String(model.doGenerateCalls[0].prompt[0].content);
    };

    expect(await promptFor("flowPath=p.flow.html&node=prompt-1")).toContain(
      "The writer has selected the Prompt node `prompt-1` on the canvas",
    );
    expect(await promptFor("besideFlowPath=p.flow.html&node=prompt-1")).not.toContain("The writer has selected");
  });

  // A library's file reaches the copilot only as a raster image to look at.
  it("names a library's raster image by its library path, and any other library view as no file open", async () => {
    const library = mkdtempSync(path.join(tmpdir(), "pragma-assistant-library-"));
    giveSpaceLibraries(configDir, spaceRoot, [{ id: "footage", label: "Footage", path: library, access: "read-only" }]);
    writeFileSync(path.join(library, "still.png"), "");
    const app = createSpaceApiRoutes(spaceRoot, undefined, { ownMachine: true });
    const promptFor = async (param: string, libraryPath: string) => {
      const model = answering("ok");
      resolvedTo.model = model;
      const res = await app.request(`/api/chat?${param}=${encodeURIComponent(libraryPath)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history: [], message: "hi", model: "mock/model" }),
      });
      expect(res.status).toBe(200);
      return String(model.doGenerateCalls[0].prompt[0].content);
    };

    try {
      expect(await promptFor("imagePath", "lib:footage/still.png")).toContain(
        "the image `lib:footage/still.png` open in a read-only preview",
      );
      expect(await promptFor("besideImagePath", "lib:footage/still.png")).toContain(
        "other editor group shows the image `lib:footage/still.png`",
      );
      const others = [
        ["imagePath", "lib:footage/logo.svg"],
        ["videoPath", "lib:footage/clip.mp4"],
        ["tablePath", "lib:footage/shots.table.html"],
        ["path", "lib:footage/notes.md"],
        ["folderPath", "lib:footage"],
      ];
      for (const [param, libraryPath] of others) {
        const prompt = await promptFor(param, libraryPath);
        expect(prompt).toContain("no file open in the editor");
        expect(prompt).not.toContain("lib:footage");
      }
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  });
});
