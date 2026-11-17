// Settings → API Access: the agent endpoint's settings and tokens. They sit on
// the cookie-authed /api/*, so a session that can open Settings can mint an
// agent token — the same trust level, since it can already read and write the
// whole space. It must never reach the *agent* endpoint itself, which is why
// that listener accepts no cookie (apiServer.ts).
//
// No route here opens a listener: saving asks the host's AgentEndpoint to
// re-read the config, and a host that should not offer it passes none.
import type { Hono } from "hono";
import {
  type ApiToken,
  apiPort,
  createApiToken,
  findSpaceId,
  loadGlobalConfig,
  saveGlobalConfig,
  spaceLabel,
} from "../../config/loadConfig.ts";
import type {
  ApiSettingsRequestBody,
  ApiSettingsResponse,
  ApiTokenRow,
  CreateApiTokenRequestBody,
  CreateApiTokenResponse,
  SpaceIdRequestBody,
} from "../../protocol/api.ts";
import type { RouteContext } from "./shared.ts";

function toRow(token: ApiToken, spaces: ReturnType<typeof loadGlobalConfig>["spaces"]): ApiTokenRow {
  const record = spaces?.[token.spaceId];
  return {
    id: token.id,
    label: token.label,
    createdAt: token.createdAt,
    access: token.access,
    // A token whose space was removed from the registry still lists, so it can
    // be revoked rather than lingering invisibly.
    spaceLabel: record ? spaceLabel(record) : "(unknown space)",
  };
}

export function mountApiTokenRoutes(app: Hono, { spaceRoot, agentEndpoint }: RouteContext): void {
  app.all("/api/api-settings", async (c) => {
    const config = loadGlobalConfig();

    if (c.req.method === "GET") {
      return c.json<ApiSettingsResponse>({
        enabled: config.api?.enabled === true,
        port: apiPort(config),
        runningPort: agentEndpoint?.port(),
        tokens: (config.apiTokens ?? []).map((token) => toRow(token, config.spaces)),
      });
    }
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as ApiSettingsRequestBody;
      if (body.port !== undefined && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) {
        return c.text("Port must be between 1 and 65535", 400);
      }
      saveGlobalConfig({
        ...config,
        api: {
          ...config.api,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.port !== undefined ? { port: body.port } : {}),
        },
      });

      // Ask the host to match the config it just wrote. The settings are saved
      // either way — a port that turns out to be taken is a failure to *start*,
      // not a failure to configure, and the panel reports the running state
      // alongside the error rather than pretending the save was rejected.
      try {
        await agentEndpoint?.apply();
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "The endpoint could not start", 409);
      }
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Mints a token for the space this process is serving. The secret comes back
  // exactly once — only its hash is stored, so there is no second chance to
  // read it and the panel has to say so.
  app.all("/api/api-tokens", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as CreateApiTokenRequestBody;
      const label = body.label.trim();
      if (!label) return c.text("Give the token a name", 400);

      const config = loadGlobalConfig();
      const spaceId = findSpaceId(config, spaceRoot);
      if (!spaceId) return c.text("This space is not registered", 400);

      const { secret, record } = createApiToken({
        label,
        spaceId,
        access: body.access === "read-write" ? "read-write" : "read-only",
      });
      saveGlobalConfig({ ...config, apiTokens: [...(config.apiTokens ?? []), record] });
      return c.json<CreateApiTokenResponse>({ token: toRow(record, config.spaces), secret });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  // Revoking one token is the whole point of storing them plurally: a client
  // can be cut off without rotating every other client's.
  app.all("/api/api-tokens/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const { id } = (await c.req.json()) as SpaceIdRequestBody;
      const config = loadGlobalConfig();
      const remaining = (config.apiTokens ?? []).filter((token) => token.id !== id);
      if (remaining.length === (config.apiTokens ?? []).length) return c.text("No such token", 400);
      saveGlobalConfig({ ...config, apiTokens: remaining });
      return c.body(null, 204);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });
}
