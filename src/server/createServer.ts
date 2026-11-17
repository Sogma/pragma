import path from "node:path";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";
import type { AgentEndpoint } from "./apiServer.ts";
import { alwaysAuthorized } from "./auth.ts";
import { hasLoopbackHost } from "./loopback.ts";
import { dispatchApiRequest, spaceRoutes } from "./routes.ts";
import type { ServedSpace } from "./servedSpace.ts";
import { FRAME_HEADERS } from "./staticFiles.ts";

const webRoot = path.join(PACKAGE_ROOT, "web");

// Thin Vite-dev adapter over the production server's route dispatch, so dev
// and prod can't drift on route behavior. No-op auth, as for `pragma start`.
// Vite's defaults give this target its loopback bind and a Host check for the
// page, so never widen `server.host` or `server.allowedHosts`. The API checks
// Host itself with the production server's rule, which admits fewer names.
//
// Not `use("/api", ...)`: connect strips the mount prefix from `req.url`, and
// the route lookup is keyed by the full "/api/..." pathname.
export function spaceApiPlugin(served: ServedSpace, agentEndpoint?: AgentEndpoint): Plugin {
  // Dev runs on the writer's own machine, as Electron does (see
  // RouteContext.ownMachine, routes/shared.ts).
  const routes = spaceRoutes(served, { agentEndpoint, ownMachine: true });

  return {
    name: "pragma-space-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "", "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) {
          next();
          return;
        }
        if (!hasLoopbackHost(req)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: "This server only answers on loopback" }));
          return;
        }
        await dispatchApiRequest(routes(), alwaysAuthorized, req, res);
      });
    },
  };
}

export interface EditorServerOptions {
  agentEndpoint?: AgentEndpoint;
  port: number;
}

export async function createEditorServer(served: ServedSpace, options: EditorServerOptions): Promise<ViteDevServer> {
  return createViteServer({
    root: webRoot,
    plugins: [spaceApiPlugin(served, options.agentEndpoint)],
    // `strictPort` rather than Vite's fallback to the next free port: a stale
    // server still holding the port would silently push a new one to the
    // next, and the URL would drift out from under the tab checking it. A
    // loud failure says an old instance needs killing, not a new port to find.
    //
    // `forwardConsole` pinned off: Vite turns it on when an AI agent started
    // it, which adds a plugin to the hash of its dependency cache, so an
    // agent's server and a person's would rebuild the shared cache in turn.
    server: { port: options.port, strictPort: true, forwardConsole: false, headers: { ...FRAME_HEADERS } },
  });
}
