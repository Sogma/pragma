import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialStore,
  mcpToken,
  providerEndpoint,
  providerKey,
  providerKeyStatus,
  publisherKey,
} from "../../src/config/credentials.ts";
import {
  loadGlobalConfig,
  resolveProviders,
  saveGlobalConfig,
  upsertMcpServerConfig,
  upsertProviderConfig,
} from "../../src/config/loadConfig.ts";
import { resolveModel, UnresolvedModelError } from "../../src/protocol/modelProvider.ts";
import { isolateConfig } from "../support/isolation.ts";

// Which providers there are (only the configured ones), which key each
// resolves, its two model lists, how a model ref finds its provider, and the
// id namespace providers share with MCP servers.

let configDir: string;

beforeEach(() => {
  configDir = isolateConfig();
  vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
  vi.stubEnv("OPENAI_API_KEY", "env-openai");
  vi.stubEnv("GEMINI_API_KEY", "env-gemini");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider keys", () => {
  // OpenAI requires that a ChatGPT plan request never moves to another way
  // of paying, and its token is for OpenAI's own endpoint alone.
  it("gives a ChatGPT plan no key from anywhere, and no address but OpenAI's own", async () => {
    const [plan] = resolveProviders({
      modelProviders: [{ id: "chatgpt", kind: "chatgpt", baseURL: "https://elsewhere.test/v1" }],
    });
    expect(plan).toMatchObject({ kind: "chatgpt", baseURL: undefined });
    await expect(providerKey({ id: "chatgpt", kind: "chatgpt" })).resolves.toEqual({ found: false });
    await expect(providerKeyStatus({ id: "chatgpt", kind: "chatgpt" })).resolves.toEqual({ source: "none" });

    upsertProviderConfig({ id: "chatgpt", kind: "chatgpt", baseURL: "https://elsewhere.test/v1" });
    expect(loadGlobalConfig().modelProviders?.[0]).toEqual({ id: "chatgpt", kind: "chatgpt" });
  });

  it("reads a kind's env var only for an entry on the vendor's own endpoint", async () => {
    const openrouter = { id: "openrouter", kind: "openai" as const, baseURL: "https://openrouter.ai/api/v1" };
    await expect(providerKey({ id: "anthropic", kind: "anthropic" })).resolves.toMatchObject({ key: "env-anthropic" });
    await expect(providerKey({ id: "openai", kind: "openai" })).resolves.toMatchObject({ key: "env-openai" });
    await expect(providerKey(openrouter)).resolves.toEqual({ found: false });
    await expect(providerKey({ id: "gemini", kind: "google" })).resolves.toMatchObject({ key: "env-gemini" });
    await expect(providerKeyStatus(openrouter)).resolves.toEqual({ source: "none" });
    await expect(providerKeyStatus({ id: "gemini", kind: "google" })).resolves.toEqual({ source: "env" });
  });

  it("uses a stored key for its own endpoint ahead of the environment", async () => {
    const anthropic = { id: "anthropic", kind: "anthropic" as const };
    const endpoint = providerEndpoint(anthropic);
    await credentialStore().set(
      { kind: "provider-keys", id: "anthropic" },
      { absent: true },
      { endpoint, secrets: { key: "sk-stored" } },
    );
    await expect(providerKey(anthropic)).resolves.toEqual({ found: true, key: "sk-stored", source: "stored" });
    await expect(providerKeyStatus(anthropic)).resolves.toEqual({ source: "stored" });
  });

  it("lets a stored key it can't use block the environment variable, saying why", async () => {
    const anthropic = { id: "anthropic", kind: "anthropic" as const };
    await credentialStore().set(
      { kind: "provider-keys", id: "anthropic" },
      { absent: true },
      { endpoint: "https://proxy.example/v1", secrets: { key: "sk-proxy" } },
    );
    await expect(providerKey(anthropic)).resolves.toMatchObject({ found: false, problem: expect.any(String) });
    await expect(providerKeyStatus(anthropic)).resolves.toMatchObject({ source: "unreadable" });
  });

  it("never reads a key left in config.json by an earlier version, or written there by hand", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        modelProviders: [{ id: "anthropic", kind: "anthropic", apiKey: "sk-inline" }],
        publishers: [{ id: "sogma", kind: "sogma", baseURL: "https://api.sogma.test", apiKey: "pk-inline" }],
        mcpServers: [{ id: "linear", url: "https://mcp.linear.app/mcp", apiKey: "tok-inline" }],
        modelProviderSecretsEncrypted: { anthropic: "b2xk" },
        publisherSecretsEncrypted: { sogma: "b2xk" },
        mcpServerSecretsEncrypted: { linear: "b2xk" },
      }),
    );
    await expect(providerKey({ id: "anthropic", kind: "anthropic" })).resolves.toEqual({ found: false });
    await expect(publisherKey({ id: "sogma", baseURL: "https://api.sogma.test" })).resolves.toEqual({ found: false });
    await expect(mcpToken({ id: "linear", url: "https://mcp.linear.app/mcp" })).resolves.toEqual({ found: false });
  });
});

describe("provider entries", () => {
  it("has none built in, so an empty config has no providers", () => {
    expect(resolveProviders({})).toEqual([]);
  });

  it("refuses an entry with no kind, naming the kinds, whatever its id", () => {
    expect(() => resolveProviders({ modelProviders: [{ id: "anthropic" }] })).toThrow(
      'Provider "anthropic" in config.json is missing "kind". Set it to one of "anthropic", "openai", "google" or "chatgpt".',
    );
    expect(() => upsertProviderConfig({ id: "anthropic" })).toThrow('Provider "anthropic" needs a "kind"');
  });

  it("keeps image models apart from text models, each saved on its own", () => {
    upsertProviderConfig({ id: "openai", kind: "openai", textModels: ["gpt-5"] });
    upsertProviderConfig({ id: "openai", imageModels: ["gpt-image-1"] });
    expect(resolveProviders(loadGlobalConfig()).find((provider) => provider.id === "openai")).toMatchObject({
      textModels: ["gpt-5"],
      imageModels: ["gpt-image-1"],
    });
  });

  it("names every kind when refusing an unknown one", () => {
    expect(() => resolveProviders({ modelProviders: [{ id: "x", kind: "mystery" as never }] })).toThrow(
      'Expected "anthropic", "openai", "google" or "chatgpt"',
    );
  });
});

describe("one id namespace for providers and MCP servers", () => {
  it("refuses a new provider an MCP server's id", () => {
    upsertMcpServerConfig({ id: "higgsfield", url: "https://mcp.higgsfield.ai/mcp" });
    expect(() => upsertProviderConfig({ id: "higgsfield", kind: "openai" })).toThrow(
      'An MCP server already has the id "higgsfield".',
    );
  });

  it("refuses a new MCP server a configured provider's id, and only that", () => {
    upsertProviderConfig({ id: "openai", kind: "openai" });
    expect(() => upsertMcpServerConfig({ id: "openai", url: "https://mcp.openai.com/mcp" })).toThrow(
      'A model provider already has the id "openai".',
    );
    upsertMcpServerConfig({ id: "anthropic", url: "https://mcp.anthropic.com/mcp" });
    expect(loadGlobalConfig().mcpServers?.map((entry) => entry.id)).toEqual(["anthropic"]);
  });

  it("still updates an entry that exists", () => {
    upsertMcpServerConfig({ id: "linear", url: "https://mcp.linear.app/mcp" });
    upsertMcpServerConfig({ id: "linear", copilot: true });
    expect(loadGlobalConfig().mcpServers).toEqual([{ id: "linear", url: "https://mcp.linear.app/mcp", copilot: true }]);
  });
});

describe("resolveModel", () => {
  beforeEach(() => {
    saveGlobalConfig({
      modelProviders: [
        { id: "openai", kind: "openai", textModels: ["gpt-5", "shared"] },
        { id: "lmstudio", kind: "openai", baseURL: "http://localhost:1234/v1", textModels: ["qwen/qwen3", "shared"] },
      ],
    });
  });

  it("finds a bare id through the one provider that lists it", () => {
    expect(resolveModel("gpt-5")).toMatchObject({ providerId: "openai", wireModel: "gpt-5" });
    // A model id may hold a "/"; "qwen" names no provider, so it is a bare id.
    expect(resolveModel("qwen/qwen3")).toMatchObject({ providerId: "lmstudio", wireModel: "qwen/qwen3" });
  });

  it("lets a prefix name its provider, whatever that provider lists", () => {
    expect(resolveModel("openai/gpt-9")).toMatchObject({ providerId: "openai", wireModel: "gpt-9" });
  });

  it("says what to fix when nothing, or more than one, resolves", () => {
    expect(() => resolveModel("claude-sonnet-5")).toThrow(UnresolvedModelError);
    expect(() => resolveModel("claude-sonnet-5")).toThrow('No provider lists model "claude-sonnet-5".');
    expect(() => resolveModel("anthropic/claude-sonnet-5")).toThrow(
      'No provider "anthropic" is configured for model "anthropic/claude-sonnet-5".',
    );
    expect(() => resolveModel("shared")).toThrow('Ambiguous model "shared": configured on openai, lmstudio.');
  });

  it("says which providers can take an image in a tool's result", () => {
    saveGlobalConfig({
      modelProviders: [
        { id: "anthropic", kind: "anthropic", textModels: ["claude-sonnet-5"] },
        { id: "gemini", kind: "google", textModels: ["gemini-pro-latest"] },
        { id: "openai", kind: "openai", textModels: ["gpt-6.1-sol"] },
        { id: "lmstudio", kind: "openai", baseURL: "http://localhost:1234/v1", textModels: ["qwen/qwen3"] },
      ],
    });
    expect(resolveModel("anthropic/claude-sonnet-5").imagesInToolResults).toBe(true);
    expect(resolveModel("gemini/gemini-pro-latest").imagesInToolResults).toBe(true);
    expect(resolveModel("openai/gpt-6.1-sol").imagesInToolResults).toBe(true);
    expect(resolveModel("lmstudio/qwen/qwen3").imagesInToolResults).toBe(false);
  });
});
