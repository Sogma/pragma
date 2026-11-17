// pragma's own version and the update check.
import type { Hono } from "hono";
import type { AppletInfoResponse, UpdateStatus } from "../../protocol/api.ts";
import { httpCall } from "../../protocol/httpCall.ts";
import { pragmaRepository, pragmaVersion } from "../version.ts";
import type { RouteContext } from "./shared.ts";

// Plain X.Y.Z comparison for /api/updates/check — this project's tags are
// always `npm version`-produced semver with no pre-release qualifiers, so
// a full semver dependency would be more than the one comparison needs.
function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [la = 0, lb = 0, lc = 0] = parts(latest);
  const [ca = 0, cb = 0, cc = 0] = parts(current);
  return la !== ca ? la > ca : lb !== cb ? lb > cb : lc > cc;
}

export function mountUpdateRoutes(app: Hono, _context: RouteContext): void {
  // One changelog page holds every release's notes; the app keeps no copy.
  const releaseNotesUrl = "https://pragma.sogma.com/changelog";
  app.all("/api/applet/info", (c) => c.json<AppletInfoResponse>({ version: pragmaVersion, releaseNotesUrl }));

  // "Check for updates" for targets that don't auto-install: the CLI targets
  // (no Electron main process) and macOS Electron (auto-update is off there);
  // Windows/Linux Electron use electron-updater instead.
  // Answers electron-updater's UpdateStatus shape so the renderer shares one
  // render path, but only the checking phases.
  //
  // Unauthenticated GitHub call: while the repo is private it 404s,
  // surfacing as a normal "error" phase.
  app.all("/api/updates/check", async (c) => {
    if (!pragmaRepository) {
      return c.json<UpdateStatus>({ phase: "error", message: "package.json names no GitHub repository" });
    }
    try {
      const { response } = await httpCall(`https://api.github.com/repos/${pragmaRepository}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        return c.json<UpdateStatus>({ phase: "error", message: `GitHub returned ${response.status}` });
      }
      const release = (await response.json()) as { tag_name?: string };
      const latest = release.tag_name?.replace(/^v/, "");
      if (!latest) return c.json<UpdateStatus>({ phase: "error", message: "No release tag in GitHub's response" });
      return c.json<UpdateStatus>(
        isNewerVersion(latest, pragmaVersion) ? { phase: "available", version: latest } : { phase: "not-available" },
      );
    } catch (error) {
      return c.json<UpdateStatus>({
        phase: "error",
        message: error instanceof Error ? error.message : "Network error",
      });
    }
  });
}
