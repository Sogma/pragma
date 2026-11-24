// pragma's own version and the update check.
import type { Hono } from "hono";
import type { AppletInfoResponse, UpdateStatus } from "../../protocol/api.ts";
import { checkLatestRelease } from "../latestRelease.ts";
import { pragmaVersion } from "../version.ts";
import type { RouteContext } from "./shared.ts";

export function mountUpdateRoutes(app: Hono, _context: RouteContext): void {
  // One changelog page holds every release's notes; the app keeps no copy.
  // The fragment is the anchor every entry on it carries (`desktop-v0.6.1`),
  // so the link opens at this version's entry, or at the top of the page for
  // an entry without one.
  const releaseNotesUrl = `https://pragma.sogma.com/changelog#desktop-v${pragmaVersion}`;
  app.all("/api/applet/info", (c) => c.json<AppletInfoResponse>({ version: pragmaVersion, releaseNotesUrl }));

  // "Check for updates" in a browser tab, which can't install an update and
  // learns only whether a newer release is out. The desktop app checks in its
  // own process instead.
  app.all("/api/updates/check", async (c) => c.json<UpdateStatus>(await checkLatestRelease()));
}
