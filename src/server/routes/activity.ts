// The Console's server-side feed. What may be recorded — and why this is not
// a general logging endpoint — is activityLog.ts's header.
//
// Polled rather than pushed: pragma has no server-to-browser channel, and one
// long-lived stream would have to survive a space switch, the Vite dev
// middleware, Electron, and the remote-access target's auth. A read this
// cheap does not justify introducing that. The client polls only while the
// Console is open, so a closed Console costs nothing at all.
import type { Hono } from "hono";
import type { ActivityResponse } from "../../protocol/api.ts";
import { activitySince } from "../activityLog.ts";

export function mountActivityRoutes(app: Hono): void {
  app.all("/api/activity", (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    // An unparseable cursor is treated as no cursor — the caller gets a fresh
    // one back and starts from now, rather than an error it could only
    // recover from by doing exactly that.
    const raw = Number(c.req.query("since"));
    const since = Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    return c.json<ActivityResponse>(activitySince(since));
  });
}
