// The agent-facing listener: a second HTTP server on a fixed loopback port
// (see docs/agent-api.md), not a path prefix on the app server.
//
// A listener of its own, so this handler chain structurally cannot see the
// app's session cookie, and the HTTPS proxy in front of the remote-access
// target never reaches it.
//
// `/api/*` stays the app's private contract: a token honoured there would
// reach chat, sandbox execution, provider secrets, git and publishing, none
// of which "read-only" contains.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  type ApiToken,
  apiEnabled,
  apiPort,
  findApiToken,
  findSpaceId,
  loadGlobalConfig,
} from "../config/loadConfig.ts";
import { recordActivity } from "./activityLog.ts";
import { hasLoopbackHost } from "./loopback.ts";
import { readRequestBody } from "./requestBody.ts";

export interface ApiServerOptions {
  /** The space this process is serving, read per request rather than captured:
   * switching spaces changes which tokens are accepted, and a listener holding
   * a stale root would keep serving the old one. A token is bound to a space
   * id, so one minted for a different space is refused rather than quietly
   * served the wrong tree. */
  spaceRoot: () => string;
  port?: number;
}

export interface AuthorizedRequest {
  token: ApiToken;
  /** Whether this token may do anything beyond reading. Decided at creation
   * and never widened afterwards: a token's access travels with the token,
   * rather than depending on a mode somewhere else that can be forgotten. */
  canWrite: boolean;
}

/** Why a request was refused, and the status that says so. */
export class ApiAuthError extends Error {
  readonly status: 401 | 403 | 413;

  constructor(status: 401 | 403 | 413, message: string) {
    super(message);
    this.name = "ApiAuthError";
    this.status = status;
  }
}

/** The DNS-rebinding check the MCP Streamable HTTP spec requires. Inverts the
 * app server's: here **any** browser origin is wrong — a legitimate MCP client
 * is not a web page — so a present `Origin` is refused outright, and `Host`
 * must be loopback, or a page on a domain that rebinds to 127.0.0.1 reaches
 * this listener with the attacker's own `Host`. */
export function checkRequestOrigin(req: IncomingMessage): void {
  if (req.headers.origin !== undefined) {
    throw new ApiAuthError(403, "Browser origins are not accepted on this endpoint");
  }
  if (!hasLoopbackHost(req)) {
    throw new ApiAuthError(403, "This endpoint only answers on loopback");
  }
}

/** Authorizes one request. Bearer only — this listener never reads a cookie,
 * so the app's session can't reach it and a token can't reach the app. */
export function authorizeApiRequest(req: IncomingMessage, spaceRoot: string): AuthorizedRequest {
  const header = req.headers.authorization ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!secret) throw new ApiAuthError(401, "Missing bearer token");

  const config = loadGlobalConfig();
  const token = findApiToken(config, secret);
  if (!token) throw new ApiAuthError(401, "Unknown token");

  // Bound by space id rather than path, so relocating a space keeps its
  // tokens working — and a token minted for another space never reads this
  // one just because this process happens to be serving it.
  if (token.spaceId !== findSpaceId(config, spaceRoot)) {
    throw new ApiAuthError(403, "This token is for a different space");
  }

  return { token, canWrite: token.access === "read-write" };
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

/** The largest request body either encoding takes: the MCP SDK's own
 * default, which handing it an already-parsed body bypasses. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// How long a whole request, body included, and its headers may take to
// arrive. A local agent sends 4 MiB in well under either; a client holding a
// request open has no business with the listener's default five minutes.
const REQUEST_DEADLINE_MS = 30_000;
const HEADERS_DEADLINE_MS = 10_000;

/** Serves a request that passed every check, its whole body already read,
 * from `spaceRoot`, the space its last check was made against. */
export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  authorized: AuthorizedRequest,
  body: Buffer,
  spaceRoot: string,
) => Promise<void> | void;

export interface ApiServer {
  server: Server;
  port: number;
  /** Stops listening and ends every open request with it. */
  close(): Promise<void>;
  /** Ends every request the token with `id` has open, a run included. */
  dropToken(id: string): void;
}

/** Starts the listener. Rejects if the port is taken rather than scanning for
 * a free one: an address that silently moves is worse than one that refuses,
 * because the harness config naming it has no way to notice. */
function startApiServer(options: ApiServerOptions, handler: ApiHandler): Promise<ApiServer> {
  const port = options.port ?? apiPort(loadGlobalConfig());

  // Each token's open connections, so revoking it ends them at once.
  const opened = new Map<string, Set<Socket>>();
  const hold = (tokenId: string, socket: Socket): void => {
    const sockets = opened.get(tokenId) ?? new Set<Socket>();
    opened.set(tokenId, sockets);
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const server = createServer(
    { requestTimeout: REQUEST_DEADLINE_MS, headersTimeout: HEADERS_DEADLINE_MS },
    async (req, res) => {
      try {
        checkRequestOrigin(req);
        hold(authorizeApiRequest(req, options.spaceRoot()).token.id, req.socket);
        // After the token check, so an unknown caller never gets a body read.
        const body = await readRequestBody(req, MAX_BODY_BYTES);
        if (body === undefined) throw new ApiAuthError(413, `Request body over ${MAX_BODY_BYTES / 1024 / 1024} MiB`);
        // Checked again once the body is in, and served from the space this
        // check sees: a token revoked, or a space switched, while the body
        // arrived refuses the request instead of riding the first check.
        const spaceRoot = options.spaceRoot();
        await handler(req, res, authorizeApiRequest(req, spaceRoot), body, spaceRoot);
      } catch (error) {
        // A refused request is the only thing here that leaves no trace at all:
        // the client sees a status code and pragma's own window shows nothing,
        // which is how a stale token looks exactly like a stopped endpoint.
        // Warn rather than error — it completed, just unhappily.
        if (error instanceof ApiAuthError) {
          recordActivity("warn", "API", `Refused: ${error.message}`, `${req.method ?? "GET"} ${req.url ?? "/"}`);
          return sendError(res, error.status, error.message);
        }
        const message = error instanceof Error ? error.message : "Internal error";
        recordActivity("error", "API", `${req.method ?? "GET"} ${req.url ?? "/"}`, message);
        sendError(res, 500, message);
      }
    },
  );

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback unconditionally, on every target: agents run on this machine.
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve({
        server,
        // The port actually bound, not the one asked for: they differ when 0
        // was requested, and everything downstream — the CLI's log line, the
        // panel's copy-paste config — names this one.
        port: typeof address === "object" && address !== null ? address.port : port,
        // Switched off means no answer to anyone, so requests still open end
        // now, not when their clients finish them.
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
        dropToken: (id) => {
          for (const socket of opened.get(id) ?? []) socket.destroy();
        },
      });
    });
  });
}

// ── The endpoint ────────────────────────────────────────────────────────

/** Owns the agent endpoint across its whole life: starting it, stopping it,
 * and moving it when its port changes.
 *
 * A controller rather than a bare start call because the Settings panel must
 * be able to switch the endpoint on without restarting pragma — but a *route*
 * must never open a listener itself. So the host holds this, the route asks it
 * to re-read config, and a host that should not offer that simply does not
 * pass it on (the same shape as SpaceSwitcher). */
export interface AgentEndpoint {
  /** Re-reads config and starts, stops, or rebinds to match it. Returns the
   * port now listening, or undefined when the endpoint is off. Rejects if the
   * wanted port is unavailable, leaving the endpoint stopped — a listener that
   * silently moved would leave every harness config pointing at nothing. */
  apply(): Promise<number | undefined>;
  /** The port currently listening, if any. */
  port(): number | undefined;
  close(): Promise<void>;
  /** Ends what a just-revoked token has open, so its client is cut off now
   * rather than once its requests, a run among them, finish. */
  dropToken(id: string): void;
}

export function createAgentEndpoint(spaceRoot: () => string): AgentEndpoint {
  let running: ApiServer | undefined;

  async function apply(): Promise<number | undefined> {
    const config = loadGlobalConfig();
    const wanted = apiEnabled(config) ? apiPort(config) : undefined;
    if (running?.port === wanted) return wanted;

    // Always stop first. Rebinding to a new port while still holding the old
    // one would leave two endpoints answering, one of them at an address
    // nothing is configured to use any more.
    await running?.close();
    running = undefined;
    if (wanted === undefined) return undefined;

    running = await startAgentEndpoint(spaceRoot, wanted);
    return running?.port;
  }

  return {
    apply,
    port: () => running?.port,
    dropToken: (id) => running?.dropToken(id),
    close: async () => {
      await running?.close();
      running = undefined;
    },
  };
}

/** Starts the endpoint unconditionally on `port`, serving MCP at `/mcp`. */
async function startAgentEndpoint(spaceRoot: () => string, port: number): Promise<ApiServer> {
  const { handleMcpRequest } = await import("./mcpServer.ts");

  const { handleRestRequest } = await import("./restApi.ts");

  return startApiServer({ spaceRoot, port }, async (req, res, authorized, body, servedRoot) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const who = `token \u201c${authorized.token.label}\u201d \u00b7 ${authorized.canWrite ? "read-write" : "read-only"}`;
    // Written once the response is decided, so an entry carries the outcome
    // rather than the intent — the Console never mutates an entry it already
    // showed.
    const record = (kind: string, label: string, detail = ""): void =>
      recordActivity(res.statusCode >= 400 ? "warn" : "info", kind, label, detail ? `${who}\n${detail}` : who);

    // Two encodings of one surface: MCP owns /mcp, REST owns the rest of the
    // root. Both arrive here already authorized.
    if (url.pathname !== "/mcp") {
      if (!(await handleRestRequest(servedRoot, req, res, authorized, body))) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "No such route. MCP is at /mcp; see docs/agent-api.md." }));
      }
      record("API", `${req.method ?? "GET"} ${url.pathname}`);
      return;
    }
    // The spec lets a server either open an SSE stream on GET or answer 405.
    // This endpoint is stateless and read-only: it has no server-initiated
    // messages to push and no session to terminate, so it says so at once
    // rather than holding open a connection that will never carry anything.
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "This endpoint answers POST only; it offers no server-initiated stream." }));
      record("MCP", `${req.method ?? "GET"} /mcp`);
      return;
    }
    const message = parseJsonBody(body);
    await handleMcpRequest(servedRoot, req, res, authorized, message);
    const { label, detail } = describeMcpCall(message);
    record("MCP", label, detail);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What one MCP call should say in the Console.
 *
 * `initialize` is the closest thing this endpoint has to a connection being
 * established. It is stateless per request by design, so a client does not
 * hold one — but `initialize` is the first call any client makes and the only
 * one that says who it is, which is exactly the moment worth reporting. */
function describeMcpCall(body: unknown): { label: string; detail: string } {
  // A JSON-RPC batch is one request carrying several calls; the first names
  // it well enough for a log line.
  const call = Array.isArray(body) ? body[0] : body;
  const method = isRecord(call) && typeof call.method === "string" ? call.method : "(malformed call)";
  const params = isRecord(call) && isRecord(call.params) ? call.params : undefined;

  if (method === "initialize") {
    const info = params && isRecord(params.clientInfo) ? params.clientInfo : undefined;
    const name = info && typeof info.name === "string" ? info.name : "an unnamed client";
    const version = info && typeof info.version === "string" ? ` ${info.version}` : "";
    return { label: `Connected: ${name}${version}`, detail: "" };
  }
  if (method === "tools/call") {
    const name = params && typeof params.name === "string" ? params.name : "(unnamed tool)";
    const args = params?.arguments;
    return { label: name, detail: args === undefined ? "" : JSON.stringify(args) };
  }
  return { label: method, detail: "" };
}

/** The SDK's transport wants a parsed body rather than a stream. An empty
 * body parses to none. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiAuthError(403, "Malformed JSON body");
  }
}
