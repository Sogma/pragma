import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// One server standing in for both sides of an OAuth-protected MCP server: the
// authorization server (metadata, registration, consent, tokens, revocation)
// and the MCP endpoint at /mcp, which accepts only the latest access token.
// `requireToken` and `offersOAuth` turn it into an open server, or one that
// wants credentials but offers no sign-in.

export interface OAuthStandIn {
  base: string;
  registrations: Array<Record<string, unknown>>;
  authorizeRequests: URLSearchParams[];
  revoked: string[];
  refreshCount: number;
  refreshAnswer: "rotate" | "refuse" | "unavailable";
  denyConsent: boolean;
  requireToken: boolean;
  offersOAuth: boolean;
  /** Issues a token pair outside any flow, as an earlier sign-in would have. */
  issueTokens(): { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  close(): Promise<void>;
}

export async function startOAuthStandIn(): Promise<OAuthStandIn> {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  let liveAccessToken = "";
  let liveRefreshToken = "";
  let issued = 0;

  const issueTokens = () => {
    issued += 1;
    liveAccessToken = `at-${issued}`;
    liveRefreshToken = `rt-${issued}`;
    return { access_token: liveAccessToken, refresh_token: liveRefreshToken, token_type: "bearer", expires_in: 3600 };
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const standIn: OAuthStandIn = {
    base: "",
    registrations: [],
    authorizeRequests: [],
    revoked: [],
    refreshCount: 0,
    refreshAnswer: "rotate",
    denyConsent: false,
    requireToken: true,
    offersOAuth: true,
    issueTokens,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", standIn.base);
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const oauthPath = url.pathname.startsWith("/.well-known/") || url.pathname === "/register";
      if (oauthPath && !standIn.offersOAuth) {
        res.writeHead(404);
        return res.end();
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(res, 200, {
          resource: `${standIn.base}/mcp`,
          authorization_servers: [standIn.base],
          scopes_supported: ["openid", "offline_access"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: standIn.base,
          authorization_endpoint: `${standIn.base}/authorize`,
          token_endpoint: `${standIn.base}/token`,
          registration_endpoint: `${standIn.base}/register`,
          revocation_endpoint: `${standIn.base}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const metadata = JSON.parse(raw) as Record<string, unknown>;
        standIn.registrations.push(metadata);
        return json(res, 201, { ...metadata, client_id: `client-${standIn.registrations.length}` });
      }
      if (url.pathname === "/authorize") {
        standIn.authorizeRequests.push(url.searchParams);
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (standIn.denyConsent) {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", "The person declined");
        } else {
          const code = `code-${standIn.authorizeRequests.length}`;
          codes.set(code, {
            challenge: url.searchParams.get("code_challenge") ?? "",
            clientId: url.searchParams.get("client_id") ?? "",
            redirectUri: url.searchParams.get("redirect_uri") ?? "",
          });
          redirect.searchParams.set("code", code);
        }
        res.writeHead(302, { location: redirect.href });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const challenge = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");
          if (
            !grant ||
            grant.challenge !== challenge ||
            grant.clientId !== form.get("client_id") ||
            grant.redirectUri !== form.get("redirect_uri")
          ) {
            return json(res, 400, { error: "invalid_grant" });
          }
          return json(res, 200, issueTokens());
        }
        if (form.get("grant_type") === "refresh_token") {
          standIn.refreshCount += 1;
          if (standIn.refreshAnswer === "unavailable") {
            res.writeHead(503);
            return res.end("down for maintenance");
          }
          if (standIn.refreshAnswer === "refuse" || form.get("refresh_token") !== liveRefreshToken) {
            return json(res, 400, { error: "invalid_grant" });
          }
          return json(res, 200, issueTokens());
        }
      }
      if (url.pathname === "/revoke" && req.method === "POST") {
        standIn.revoked.push(new URLSearchParams(raw).get("token") ?? "");
        res.writeHead(200);
        return res.end();
      }
      if (url.pathname === "/mcp") {
        if (standIn.requireToken && req.headers.authorization !== `Bearer ${liveAccessToken}`) {
          res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
          return res.end();
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const message = JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (message.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "stand-in", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    { name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } },
                  ],
                }
              : {};
        return json(res, 200, { jsonrpc: "2.0", id: message.id, result });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  standIn.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return standIn;
}
