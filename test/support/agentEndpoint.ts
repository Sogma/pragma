import { onTestFinished } from "vitest";
import { createApiToken, findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { Access } from "../../src/protocol/api.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../../src/server/apiServer.ts";

/** Saves a new API token for the registered `space` and returns its secret. */
export function mintApiToken(
  space: string,
  { label = "Test client", access = "read-only" }: { label?: string; access?: Access } = {},
): string {
  const config = loadGlobalConfig();
  const spaceId = findSpaceId(config, space);
  if (spaceId === undefined) throw new Error(`${space} is not a registered space.`);
  const { secret, record } = createApiToken({ label, spaceId, access });
  saveGlobalConfig({ ...config, apiTokens: [...(config.apiTokens ?? []), record] });
  return secret;
}

/**
 * Switches the agent endpoint on at a free port and starts it for the space
 * `spaceRoot` names. It closes when the test finishes, so a test may close it
 * sooner, or start another in its place.
 */
export async function startAgentEndpoint(spaceRoot: () => string): Promise<AgentEndpoint> {
  saveGlobalConfig({ ...loadGlobalConfig(), api: { enabled: true, port: 0 } });
  const endpoint = createAgentEndpoint(spaceRoot);
  await endpoint.apply();
  onTestFinished(() => endpoint.close());
  return endpoint;
}
