import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGenerate, dispatchGenerateOptions, generationEffort } from "../../src/protocol/dispatchAction.ts";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";

// What a generation sends, read off the provider's one completion call.
const { complete } = vi.hoisted(() => ({ complete: vi.fn(async () => ({ text: '["a", "b"]' })) }));
vi.mock("../../src/protocol/modelProvider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/protocol/modelProvider.ts")>()),
  resolveModel: () => ({
    provider: { complete },
    providerId: "test",
    wireModel: "wire",
    effortLevels: ["low", "medium", "high"],
  }),
  // Opening reads a key; the stand-in model needs none.
  openModel: async (model: unknown) => model,
  defaultTextModel: () => undefined,
}));

const sentPrompt = () => (complete.mock.calls.at(-1) as unknown as [{ content: string }])[0].content;
const context = [
  { path: "/projects/story/README.md", content: "# Story\n" },
  { path: "/projects/story/world/Lina.md", content: "# Lina\n" },
];
const files =
  "Files from the writer's space, for reference:\n\n" +
  '<file path="/projects/story/README.md">\n# Story\n\n</file>\n\n' +
  '<file path="/projects/story/world/Lina.md">\n# Lina\n\n</file>\n\n';

beforeEach(() => complete.mockClear());

describe("a generation's effort", () => {
  const sentEffort = () => (complete.mock.calls.at(-1) as unknown as [{ effort?: string }])[0].effort;

  it("runs at the model's own level nearest the one picked, and says which", async () => {
    complete.mockResolvedValueOnce({ text: "Reply." });
    const reply = await dispatchGenerate(
      { instruction: "Go.", values: {}, images: {} },
      "test/model",
      undefined,
      undefined,
      "xhigh",
    );
    expect(sentEffort()).toBe("high");
    expect(reply).toEqual({ reply: "Reply.", model: "test/model", effort: "high" });

    const options = await dispatchGenerateOptions(
      { instruction: "Two.", values: {}, images: {}, numOptions: 2 },
      "test/model",
      undefined,
      undefined,
      "low",
    );
    expect(sentEffort()).toBe("low");
    expect(options.effort).toBe("low");
  });

  it("leaves the model at its own default when none is picked", async () => {
    const options = await dispatchGenerateOptions(
      { instruction: "Two.", values: {}, images: {}, numOptions: 2 },
      "test/model",
    );
    expect(sentEffort()).toBeUndefined();
    expect(options).toEqual({ options: ["a", "b"], model: "test/model" });
  });

  it("names the level a pick runs at, which a look reaches by", () => {
    expect(generationEffort("test/model", "xhigh")).toBe("high");
    expect(generationEffort("test/model", undefined)).toBeUndefined();
    expect(generationEffort(undefined, "low")).toBeUndefined();
  });
});

describe("a generation's context in its prompt", () => {
  it("goes first, each file tagged with its path, so the instruction comes last", async () => {
    await dispatchGenerate({ instruction: "List the shots.", values: {}, images: {}, context }, "test/model");
    expect(sentPrompt().startsWith(`${files}List the shots.\n\n`)).toBe(true);
  });

  it("goes first in an options call too", async () => {
    await dispatchGenerateOptions(
      { instruction: "Two titles.", values: {}, images: {}, context, numOptions: 2 },
      "test/model",
    );
    expect(sentPrompt().startsWith(`${files}Two titles.\n\n`)).toBe(true);
  });

  it("tags a section with the heading it was read under", async () => {
    const section = { path: "/look.md", section: 'Camera "Language"', content: "## Camera" };
    await dispatchGenerate({ instruction: "Go.", values: {}, images: {}, context: [section] }, "test/model");
    expect(sentPrompt()).toContain('<file path="/look.md" section="Camera &quot;Language&quot;">\n## Camera\n</file>');
  });

  it("leaves a prompt with none, or with no file in it, as it was", async () => {
    await dispatchGenerate({ instruction: "List the shots.", values: {}, images: {} }, "test/model");
    const without = sentPrompt();
    await dispatchGenerate({ instruction: "List the shots.", values: {}, images: {}, context: [] }, "test/model");
    expect(sentPrompt()).toBe(without);
    expect(without.startsWith("List the shots.\n\n")).toBe(true);
  });
});

describe("a generation that may look further", () => {
  const found = { path: "/projects/story/notes/arc.md", content: "Lina goes home.\n" };
  const look = {
    tools: { set: {}, guidance: "You may look.", mustStop: () => false },
    found: () => [found],
  };
  type Sent = [{ content: string; tools?: unknown }];
  const sent = (call: number) => (complete.mock.calls[call] as unknown as Sent)[0];

  it("keeps the model's answer when it needed nothing more: one call, the tools offered", async () => {
    complete.mockResolvedValueOnce({ text: "Shot 1" });
    const result = await dispatchGenerate(
      { instruction: "Go.", values: {}, images: {}, context },
      "test/model",
      undefined,
      look,
    );
    expect(result.reply).toBe("Shot 1");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sent(0).tools).toBe(look.tools);
  });

  it("once it has looked, asks again without tools, with what it read after the starting files", async () => {
    complete.mockResolvedValueOnce({ text: "", looked: true } as never).mockResolvedValueOnce({ text: "Shot 2" });
    const result = await dispatchGenerate(
      { instruction: "Go.", values: {}, images: {}, context },
      "test/model",
      undefined,
      look,
    );
    expect(result.reply).toBe("Shot 2");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sent(1).tools).toBeUndefined();
    expect(sent(1).content).toContain(
      '<file path="/projects/story/world/Lina.md">\n# Lina\n\n</file>\n\n<file path="/projects/story/notes/arc.md">\nLina goes home.\n\n</file>',
    );
  });

  it("does the same for an options call, parsing the answer it asks for again", async () => {
    complete.mockResolvedValueOnce({ text: "", looked: true } as never).mockResolvedValueOnce({ text: '["x", "y"]' });
    const result = await dispatchGenerateOptions(
      { instruction: "Two.", values: {}, images: {}, context, numOptions: 2 },
      "test/model",
      undefined,
      look,
    );
    expect(result.options).toEqual(["x", "y"]);
    expect(sent(1).content).toContain('<file path="/projects/story/notes/arc.md">');
  });
});

describe("a refusal a setting fixes", () => {
  const ask = { instruction: "List the shots.", values: {}, images: {} };
  let configDir: string;

  // The no-model refusal's wording depends on the providers config.json
  // lists, so this points PRAGMA_CONFIG_DIR at a throwaway one, with none.
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "pragma-dispatch-config-"));
    process.env.PRAGMA_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    delete process.env.PRAGMA_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("needs a default text model when the call names none", async () => {
    const refused = await dispatchGenerate(ask, undefined).catch((error: unknown) => error);
    expect((refused as Error).message).toBe("No models yet. Add a provider in Settings.");
    expect(setupNeedOf(refused)).toEqual({ kind: "defaultModel", output: "text" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("names the provider whose key was rejected", async () => {
    const rejection = new APICallError({
      message: "bad key",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 401,
    });
    complete.mockRejectedValueOnce(rejection);
    const refused = await dispatchGenerate(ask, "test/model").catch((error: unknown) => error);
    expect((refused as Error).message).toBe('The provider rejected the API key configured for model "test/model".');
    expect(setupNeedOf(refused)).toEqual({ kind: "providerKey", provider: "test" });
  });
});
