import { createServer, type Server } from "node:http";
import type { AgentEndpoint } from "./apiServer.ts";
import { type AuthCheck, alwaysAuthorized } from "./auth.ts";
import { hasLoopbackHost } from "./loopback.ts";
import { hasExternalHost } from "./remoteAccess.ts";
import { dispatchApiRequest, spaceRoutes } from "./routes.ts";
import type { ServedSpace } from "./servedSpace.ts";
import { serveStaticFile } from "./staticFiles.ts";

export interface ProductionServerOptions {
  port: number;
  served: ServedSpace;
  staticRoot: string;
  auth?: AuthCheck;
  /** The agent endpoint this host runs, so its Settings panel can report and
   * control it — see src/server/routes/api-tokens.ts. */
  agentEndpoint?: AgentEndpoint;
  // See RouteContext.ownMachine (routes/shared.ts). Defaults to off.
  ownMachine?: boolean;
  /** The https:// address an HTTPS proxy serves this server under for other
   * devices. Its host is answered beside loopback names, and only with it set
   * are proxied requests served (routes.ts). */
  externalUrl?: URL;
}

export interface ProductionServer {
  server: Server;
}

// The host-agnostic server the built app runs on, always on 127.0.0.1, under
// whichever AuthCheck its target supplies: the desktop app
// (launchTokenAuth.ts), `pragma start` (none) and `pragma start
// --external-url` (passphraseAuth.ts), which other devices reach through an
// HTTPS proxy.
//
// A space switch only rebuilds the route map; the listener stays up for the
// life of the process, so no target rebinds a port — the remote-access
// target keeps serving the address other devices already have open.
export function createProductionServer(options: ProductionServerOptions): ProductionServer {
  const { port, served, staticRoot, auth = alwaysAuthorized, agentEndpoint, externalUrl } = options;
  // Off unless the target says otherwise: only one on the writer's own
  // machine opts in. See RouteContext.ownMachine.
  const ownMachine = options.ownMachine ?? false;
  const routes = spaceRoutes(served, { agentEndpoint, ownMachine });

  const server = createServer((req, res) => {
    // Any Host but a loopback name or the external URL's is refused, before
    // every route, static assets included: DNS rebinding otherwise reaches
    // this listener under the attacker's own name.
    if (!hasLoopbackHost(req) && !hasExternalHost(req, externalUrl)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "This server only answers on loopback and its external URL" }));
      return;
    }
    void (async () => {
      const pathname = new URL(req.url ?? "", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/login" && auth.handleLoginPage) {
        await auth.handleLoginPage(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/api/auth/login" && auth.handleLoginSubmit) {
        await auth.handleLoginSubmit(req, res);
        return;
      }

      // /api/* does its own auth check in the route dispatch — the one
      // checkpoint every API request passes through (see routes.ts). Static
      // assets are gated here instead, since the static server has no auth
      // of its own; either way, auth.authorize() runs at most once per
      // request.
      if (pathname.startsWith("/api/")) {
        await dispatchApiRequest(routes(), auth, req, res, externalUrl);
        return;
      }

      if (!(await auth.authorize(req))) {
        // No login page means nothing a redirect could fix — sending one would
        // loop, since /login itself falls through to this same check.
        if (auth.handleLoginPage) {
          res.statusCode = 302;
          res.setHeader("location", "/login");
        } else {
          res.statusCode = 401;
        }
        res.end();
        return;
      }
      await serveStaticFile(staticRoot, req, res);
    })().catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "Internal error");
    });
  });

  server.listen(port, "127.0.0.1");
  return { server };
}
