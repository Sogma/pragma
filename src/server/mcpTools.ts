import { createMCPClient } from "@ai-sdk/mcp";
import type { Tool, ToolSet } from "ai";
import { credentialHint, mcpToken } from "../config/credentials.ts";
import type { McpServerConfig, ResolvedMcpServer } from "../config/loadConfig.ts";
import { mcpSignIns, type SignInTarget } from "./mcpSignIn.ts";

/**
 * The copilot's MCP client side: the servers in config.json's `mcpServers`
 * switched on for it contribute tools alongside pragma's own; shares no code
 * with pragma *as* an MCP server. Every server is connected before a chat turn
 * and closed after it, whatever the outcome — leak-proof at a handshake per turn.
 *
 * A server switched on is trusted as configured: its tools run outside
 * propose-then-confirm (see docs/architecture.md's Copilot as an MCP client section).
 */

export interface McpConnection {
  // Keyed by the server's own tool names; re-keyed when collected.
  tools: ToolSet;
  close(): Promise<void>;
}

// Injectable so the loop's handling of external tools — namespacing,
// failure isolation, close-on-every-path — is testable with no server.
export type McpConnector = (server: ResolvedMcpServer) => Promise<McpConnection>;

export interface McpToolSurface {
  tools: ToolSet;
  // What the system prompt tells the model about each external tool.
  described: Array<{ name: string; server: string; description?: string }>;
  // Servers that couldn't be reached this turn — dropped, never fatal.
  failures: Array<{ server: string; message: string }>;
  close(): Promise<void>;
}

// A server that never answers its initialize request would otherwise hold
// the whole turn; ten seconds is generous for a handshake on loopback or a
// hosted endpoint alike.
const CONNECT_TIMEOUT_MS = 10_000;

/** An HTTP server's OAuth sign-in target. */
export function mcpServerSignIn(server: Pick<McpServerConfig, "id" | "label" | "url">): SignInTarget {
  return { id: server.id, label: server.label ?? server.id, url: server.url ?? "" };
}

/** Runs `use` with the server's bearer token. A sign-in goes ahead of a
 * stored token: signing in is the later, explicit choice, and saving a token
 * signs the server out. */
export async function withMcpBearer<T>(
  server: ResolvedMcpServer,
  use: (bearer: string | undefined) => Promise<T>,
): Promise<T> {
  const signIn = mcpServerSignIn(server);
  const signedIn = await mcpSignIns.accessToken(signIn);
  let token: string | undefined;
  if (!signedIn) {
    const found = await mcpToken(server);
    if (!found.found && found.problem) throw new Error(`${server.label}: ${found.problem}`);
    token = found.found ? found.key : undefined;
  }
  try {
    return await use(signedIn ?? token);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    if (!signedIn && !token) throw new CredentialsNeededError(server.label);
    // A server can stop accepting a token before it expires; one refresh
    // and one retry recover a sign-in whose refresh token still works.
    if (!signedIn) throw error;
    return use(await mcpSignIns.accessToken(signIn, { refresh: true }));
  }
}

/** A server that wants credentials it was never given. Still a 401 to
 * whatever checks, so a caller that starts a sign-in on one still does. */
export class CredentialsNeededError extends Error {
  readonly code = 401;
  constructor(label: string) {
    super(`${label} needs you to sign in, or a token: open it in Settings, MCP servers.${credentialHint("token")}`);
    this.name = "CredentialsNeededError";
  }
}

/** Opens one client and lists its tools. Closes the client itself if the
 * listing fails, so a caller only ever owns a connection that worked. */
export function connectMcpServer(server: ResolvedMcpServer): Promise<McpConnection> {
  return withMcpBearer(server, (bearer) => openClient(server, bearer));
}

// Neither MCP client exports a usable error class, so this reads the HTTP
// status their errors carry: `statusCode` from the AI SDK's, `code` from the
// MCP SDK's.
export function isUnauthorized(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return statusCode === 401 || code === 401;
}

async function openClient(server: ResolvedMcpServer, bearer: string | undefined): Promise<McpConnection> {
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
    },
    initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
    clientName: "pragma",
  });
  try {
    const tools = await client.tools();
    return { tools, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

// Provider tool-name rules are roughly `[a-zA-Z0-9_-]{1,64}`; a server id
// is already a slug, a server's tool name usually is, and anything else is
// folded to "_" so a tool never fails at the provider for its name.
function slug(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The name an external tool is offered under: `mcp_<server>_<tool>`, so
 * two servers exporting `search` collide with neither each other nor with
 * `search_space_files`, and the model can tell which server it's calling. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`;
}

// A tool's own claim, through its MCP readOnlyHint, that it changes nothing.
// Taken at its word, as far as its server is trusted: a tool that says
// nothing counts as one that writes, the spec's default.
function claimsReadOnly(tool: Tool): boolean {
  const annotations = tool.metadata?.annotations;
  return typeof annotations === "object" && annotations !== null && "readOnlyHint" in annotations
    ? annotations.readOnlyHint === true
    : false;
}

/**
 * Connects every server (in parallel), re-keys their tools into one set,
 * and records which servers failed. A failed server contributes nothing and
 * a note; the turn still runs. `readOnly` keeps only the tools that claim to
 * change nothing. `close()` closes every connection that opened; call it in
 * a `finally`.
 */
export async function collectMcpTools(
  servers: ResolvedMcpServer[],
  connect: McpConnector = connectMcpServer,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<McpToolSurface> {
  const settled = await Promise.allSettled(servers.map((server) => connect(server)));

  const tools: ToolSet = {};
  const described: McpToolSurface["described"] = [];
  const failures: McpToolSurface["failures"] = [];
  const connections: McpConnection[] = [];

  settled.forEach((outcome, index) => {
    const server = servers[index];
    if (outcome.status === "rejected") {
      const reason = outcome.reason;
      failures.push({ server: server.id, message: reason instanceof Error ? reason.message : String(reason) });
      return;
    }
    connections.push(outcome.value);
    for (const [toolName, tool] of Object.entries(outcome.value.tools)) {
      if (readOnly && !claimsReadOnly(tool)) continue;
      const name = mcpToolName(server.id, toolName);
      tools[name] = tool;
      // A tool's description can also be a function of the runtime context
      // (a dynamic tool); only a plain string is worth relaying.
      described.push({
        name,
        server: server.id,
        description: typeof tool.description === "string" ? tool.description : undefined,
      });
    }
  });

  return {
    tools,
    described,
    failures,
    close: async () => {
      await Promise.allSettled(connections.map((connection) => connection.close()));
    },
  };
}
