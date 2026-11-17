// The space as a graph, for the inspector's Graph tab.
import type { Hono } from "hono";
import type { SpaceGraphResponse } from "../../protocol/api.ts";
import { buildSpaceGraph } from "../spaceGraph.ts";
import type { RouteContext } from "./shared.ts";

export function mountGraphRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/space/graph", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      return c.json<SpaceGraphResponse>(await buildSpaceGraph(spaceRoot));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });
}
