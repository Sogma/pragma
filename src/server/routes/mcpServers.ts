import type { Hono } from "hono";
import {
  canonicalEndpointOrUndefined,
  credentialStore,
  credentialStoreDescription,
  mcpTokenStatus,
  SIGN_IN_ELSEWHERE,
  saveCredential,
} from "../../config/credentials.ts";
import {
  loadGlobalConfig,
  type McpServerConfig,
  removeMcpServerConfig,
  resolveMcpServers,
  upsertMcpServerConfig,
  withConfigMutationLock,
} from "../../config/loadConfig.ts";
import type {
  McpServerConnectResponse,
  McpServerIdRequestBody,
  McpServerRow,
  McpServersResponse,
  McpSignInStartResponse,
  McpSignInStatus,
  SaveMcpServerRequestBody,
} from "../../protocol/api.ts";
import { mcpSignIns, SignInRequiredError } from "../mcpSignIn.ts";
import { connectMcpServer, isUnauthorized, mcpServerSignIn } from "../mcpTools.ts";
import { offersFlows } from "../mediaModels.ts";
import type { RouteContext } from "./shared.ts";

// Settings → MCP Servers' list. Same shape as the provider routes:
// never a token value back, only whether one is stored. The token and a
// sign-in rest in the credential store, apart. Starting a sign-in needs the
// host to be the writer's own machine (RouteContext.ownMachine).
export function mountMcpServerRoutes(app: Hono, { ownMachine }: RouteContext): void {
  // The raw entry, not the resolved one: resolving validates every entry, and
  // one broken entry must not stop another from signing out or being deleted.
  const entryById = (id: string | undefined): McpServerConfig | undefined =>
    id ? loadGlobalConfig().mcpServers?.find((entry) => entry.id === id) : undefined;

  app.all("/api/mcp-servers", async (c) => {
    try {
      if (c.req.method === "POST") {
        const { apiKey, ...fields } = (await c.req.json()) as SaveMcpServerRequestBody;
        // Fixed once added: the name, the id and any sign-in came from it.
        const existing = entryById(fields.id);
        if (existing && fields.url !== undefined && fields.url !== existing.url) {
          return c.json({ message: "A server's URL can't change. Remove it and add the new one." }, 400);
        }
        // On by default where a node can use the server; nowhere else.
        if (!existing && fields.url && fields.flows === undefined && offersFlows(fields.url)) fields.flows = true;
        if (apiKey === undefined || apiKey === "") {
          upsertMcpServerConfig(fields);
          return c.body(null, 204);
        }
        // Saving a token signs the server out: signing in is the later,
        // explicit choice, and the two never both hold.
        if (existing) await mcpSignIns.signOut(mcpServerSignIn(existing));
        const saved = await saveCredential({
          kind: "mcp-tokens",
          id: fields.id,
          endpoint: canonicalEndpointOrUndefined(fields.url ?? existing?.url),
          secret: apiKey,
          publish: () => upsertMcpServerConfig(fields),
        });
        if (!saved.ok) return c.json({ message: saved.message }, saved.status);
        return c.body(null, 204);
      }
      if (c.req.method !== "GET") return c.body(null, 405);

      const config = loadGlobalConfig();
      const servers = await Promise.all(
        resolveMcpServers(config).map(async (server): Promise<McpServerRow> => {
          const token = await mcpTokenStatus(server);
          return {
            id: server.id,
            label: server.label,
            url: server.url,
            keySource: token.source === "env" ? "none" : token.source,
            ...(token.problem ? { keyProblem: token.problem } : {}),
            signIn: await mcpSignIns.status(mcpServerSignIn(server)),
            copilot: server.copilot,
            flows: server.flows,
            flowsAvailable: offersFlows(server.url),
          };
        }),
      );
      return c.json<McpServersResponse>({
        servers,
        store: credentialStoreDescription(),
        signInAllowed: ownMachine,
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
  });

  app.all("/api/mcp-servers/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { id } = (await c.req.json()) as Partial<McpServerIdRequestBody>;
      if (!id) return c.text("Missing id", 400);
      const entry = entryById(id);
      if (entry) await mcpSignIns.signOut(mcpServerSignIn(entry));
      await credentialStore().clear({ kind: "mcp-sign-ins", id });
      await credentialStore().clear({ kind: "mcp-tokens", id });
      await withConfigMutationLock(async () => removeMcpServerConfig(id));
      return c.body(null, 204);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // A real connect-and-list against one configured server, so the form can
  // show what the copilot will get, and learn what the server wants first.
  app.all("/api/mcp-servers/connect", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    let server: ReturnType<typeof resolveMcpServers>[number] | undefined;
    try {
      const { id } = (await c.req.json()) as Partial<McpServerIdRequestBody>;
      server = resolveMcpServers(loadGlobalConfig()).find((entry) => entry.id === id);
      if (!server) return c.json({ message: `No MCP server "${id ?? ""}" in config.json` }, 404);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
    try {
      const connection = await connectMcpServer(server);
      try {
        return c.json<McpServerConnectResponse>({ state: "connected", tools: Object.keys(connection.tools).sort() });
      } finally {
        await connection.close();
      }
    } catch (error) {
      if (!(error instanceof SignInRequiredError) && !isUnauthorized(error)) {
        // Unreachable, or not an MCP server: "the server couldn't answer",
        // not a pragma fault.
        return c.json({ message: error instanceof Error ? error.message : "Couldn't connect" }, 502);
      }
    }
    const needsToken =
      (await mcpTokenStatus(server)).source === "stored"
        ? "The server rejected the token."
        : "This server needs a token.";
    if (!ownMachine)
      return c.json<McpServerConnectResponse>({ state: "needs-token", message: `${needsToken} ${SIGN_IN_ELSEWHERE}` });
    try {
      const authorizationUrl = await mcpSignIns.start(mcpServerSignIn(server));
      return c.json<McpServerConnectResponse>({ state: "sign-in", authorizationUrl });
    } catch {
      // No OAuth metadata, or a registration it refused: a server that wants
      // credentials but offers no sign-in takes a token.
      return c.json<McpServerConnectResponse>({ state: "needs-token", message: needsToken });
    }
  });

  // POST starts a sign-in and answers the page to approve it on; GET reports
  // where it stands, for the form to poll while the browser is open.
  app.all("/api/mcp-servers/sign-in", async (c) => {
    if (c.req.method === "GET") {
      const entry = entryById(c.req.query("id"));
      if (!entry) return c.json({ message: `No MCP server "${c.req.query("id") ?? ""}" in config.json` }, 404);
      return c.json<McpSignInStatus>(await mcpSignIns.status(mcpServerSignIn(entry)));
    }
    if (c.req.method !== "POST") return c.body(null, 405);
    if (!ownMachine) return c.json({ message: SIGN_IN_ELSEWHERE }, 400);
    let entry: McpServerConfig | undefined;
    try {
      const { id } = (await c.req.json()) as Partial<McpServerIdRequestBody>;
      entry = entryById(id);
      if (!entry) return c.json({ message: `No MCP server "${id ?? ""}" in config.json` }, 404);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
    if (!entry.url) return c.json({ message: `MCP server "${entry.id}" needs a "url".` }, 400);
    try {
      const authorizationUrl = await mcpSignIns.start(mcpServerSignIn(entry));
      return c.json<McpSignInStartResponse>({ authorizationUrl });
    } catch (error) {
      // No OAuth metadata, an unreachable authorization server, a refused
      // registration: the server's answer, not a pragma fault.
      const message = error instanceof Error ? error.message : "the server didn't answer";
      return c.json({ message: `Couldn't start signing in to ${entry.label ?? entry.id}: ${message}` }, 502);
    }
  });
}
