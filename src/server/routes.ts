// The space API as a Hono app, one mount per resource family
// (src/server/routes/), shared by the dev and production servers through one
// dispatcher so the two hosting modes can't drift apart. Built for one
// spaceRoot; switching spaces rebuilds the app.
//
// Every route uses `app.all` and checks its own method rather than
// `app.get`/`app.post`: several routes branch on the method, and the
// contract tests pin each 405 byte for byte.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { AuthCheck } from "./auth.ts";
import { createLocalChangeFeeds } from "./changeFeeds.ts";
import { shippedContextSources } from "./modules.ts";
import { hasProxyHeaders } from "./remoteAccess.ts";
import { mountActivityRoutes } from "./routes/activity.ts";
import { mountApiTokenRoutes } from "./routes/api-tokens.ts";
import { mountAssistantRoutes } from "./routes/assistant.ts";
import { mountBookmarkRoutes } from "./routes/bookmarks.ts";
import { mountEntryRoutes } from "./routes/entries.ts";
import { mountFileRoutes } from "./routes/file.ts";
import { mountGitRoutes } from "./routes/git.ts";
import { mountGraphRoutes } from "./routes/graph.ts";
import { mountHistoryRoutes } from "./routes/history.ts";
import { mountJobRoutes } from "./routes/jobs.ts";
import { mountMcpServerRoutes } from "./routes/mcpServers.ts";
import { mountPresetRoutes } from "./routes/presets.ts";
import { mountProviderRoutes } from "./routes/providers.ts";
import { mountPublishingRoutes } from "./routes/publishing.ts";
import { mountSandboxRoutes } from "./routes/sandbox.ts";
import type { RouteContext, RouteOptions, SpaceSwitcher } from "./routes/shared.ts";
import { mountSpaceRoutes } from "./routes/space.ts";
import { mountTagRoutes } from "./routes/tags.ts";
import { mountTemplateRoutes } from "./routes/templates.ts";
import { mountTrashRoutes } from "./routes/trash.ts";
import { mountUpdateRoutes } from "./routes/updates.ts";
import type { ServedSpace } from "./servedSpace.ts";
import { createDiskThumbnailStore } from "./thumbnailStore.ts";

export type { RouteContext, RouteOptions, SpaceSwitcher } from "./routes/shared.ts";

export type SpaceApp = Hono;

const MOUNTS: ((app: Hono, context: RouteContext) => void)[] = [
  mountSpaceRoutes,
  mountEntryRoutes,
  mountTagRoutes,
  mountGraphRoutes,
  mountBookmarkRoutes,
  mountPresetRoutes,
  mountTemplateRoutes,
  mountTrashRoutes,
  mountFileRoutes,
  mountHistoryRoutes,
  mountSandboxRoutes,
  mountJobRoutes,
  mountProviderRoutes,
  mountPublishingRoutes,
  mountAssistantRoutes,
  mountGitRoutes,
  mountUpdateRoutes,
  mountApiTokenRoutes,
  mountActivityRoutes,
  mountMcpServerRoutes,
];

export function createSpaceApiRoutes(
  spaceRoot: string,
  spaceSwitcher: SpaceSwitcher | undefined,
  options: RouteOptions,
): SpaceApp {
  const app = new Hono();
  // An empty body, so a miss says nothing beyond "no such route".
  app.notFound((c) => c.body(null, 404));
  const context: RouteContext = {
    spaceRoot,
    spaceSwitcher,
    agentEndpoint: options.agentEndpoint,
    ownMachine: options.ownMachine,
    thumbnails: options.thumbnails ?? createDiskThumbnailStore(),
    changes: options.changes ?? createLocalChangeFeeds(),
    contextSources: options.contextSources ?? shippedContextSources(),
  };
  for (const mount of MOUNTS) mount(app, context);
  return app;
}

/** The space API for whichever space `served` serves, rebuilt on each
 * switch. Read it per request, never hold it, so the request after a switch
 * reaches the new space. */
export function spaceRoutes(served: ServedSpace, options: RouteOptions): () => SpaceApp {
  let app = createSpaceApiRoutes(served.root(), served, options);
  served.onSwitch((root) => {
    app = createSpaceApiRoutes(root, served, options);
  });
  return () => app;
}

// Origin, when sent, must be this server's own, scheme included: a
// plain-http page on the external URL's host is another origin, and so is a
// sandboxed frame's "null". Routes parse JSON whatever the content-type, so
// a no-cors text/plain POST from any page could otherwise write.
//
// A missing Origin passes, as navigation and many same-origin requests send
// none; a browser's Sec-Fetch-Site still marks a request another site's page
// sent, an image's GET with side effects among them.
export function isCrossOriginRequest(req: IncomingMessage, externalUrl?: URL): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host?.toLowerCase();
  if (!host) return true;
  // Loopback is served over plain HTTP; only the external URL is https.
  const external = externalUrl !== undefined && host.replace(/:443$/, "") === externalUrl.host.toLowerCase();
  const own = external ? externalUrl.origin : `http://${host}`;
  return origin.toLowerCase() !== own.toLowerCase();
}

export function refuseCrossOrigin(res: ServerResponse): void {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: "Cross-origin request blocked" }));
}

// The checkpoint every /api/* request passes, before the Hono app so a
// rejected caller can't tell a real route from a missing one.

export async function dispatchApiRequest(
  app: SpaceApp,
  auth: AuthCheck,
  req: IncomingMessage,
  res: ServerResponse,
  externalUrl?: URL,
): Promise<void> {
  // Only a host given an external URL is meant to sit behind a proxy:
  // `pragma start` and `pragma dev` have no login, so a proxy in front of
  // them hands the space to whoever reaches it. Best effort — a proxy that
  // rewrites Host to loopback and adds no forwarding header goes unseen,
  // though the Origin check below still refuses its writes.
  if (!externalUrl && hasProxyHeaders(req)) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ message: "Proxied request refused: only `pragma start --external-url` serves through a proxy" }),
    );
    return;
  }

  if (isCrossOriginRequest(req, externalUrl)) {
    refuseCrossOrigin(res);
    return;
  }

  const authorized = await auth.authorize(req);
  if (!authorized) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "Unauthorized" }));
    return;
  }

  await getRequestListener(app.fetch)(req, res);
}
