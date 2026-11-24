// The newest published release, from GitHub's API without a token: the update
// check of everything that installs no update itself, a browser tab and the
// macOS desktop app.
import type { UpdateStatus } from "../protocol/api.ts";
import { pragmaRepository, pragmaVersion } from "./version.ts";

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

// Plain X.Y.Z comparison: this project's tags are always `npm version`-produced
// semver with no pre-release qualifiers, so a full semver dependency would be
// more than the one comparison needs.
export function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [la = 0, lb = 0, lc = 0] = parts(latest);
  const [ca = 0, cb = 0, cc = 0] = parts(current);
  return la !== ca ? la > ca : lb !== cb ? lb > cb : lc > cc;
}

/** Whether a release newer than this one is out. With `installer`, the
 * extension of the file a person downloads to install by hand, an available
 * update carries that file's link, or the release page's when it has none. */
export async function checkLatestRelease(installer?: string): Promise<UpdateStatus> {
  const repository = pragmaRepository;
  if (!repository) return { phase: "error", message: "package.json names no GitHub repository" };
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { phase: "error", message: `GitHub returned ${response.status}` };
    const release = (await response.json()) as GitHubRelease;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = tag.replace(/^v/, "");
    if (!version) return { phase: "error", message: "No release tag in GitHub's response" };
    if (!isNewerVersion(version, pragmaVersion)) return { phase: "not-available" };
    if (installer === undefined) return { phase: "available", version };
    const page =
      httpsUrl(release.html_url) ?? `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
    return { phase: "available", version, downloadUrl: installerUrl(release, installer) ?? page };
  } catch (error) {
    return { phase: "error", message: error instanceof Error ? error.message : "Network error" };
  }
}

function installerUrl(release: GitHubRelease, extension: string): string | undefined {
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const { name, browser_download_url } = (asset ?? {}) as { name?: unknown; browser_download_url?: unknown };
    const url = typeof name === "string" && name.endsWith(extension) ? httpsUrl(browser_download_url) : undefined;
    if (url) return url;
  }
  return undefined;
}

// Only an https link passes: the desktop app hands it to the system to open,
// which would launch whatever app another scheme names.
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  return new URL(value).protocol === "https:" ? value : undefined;
}
