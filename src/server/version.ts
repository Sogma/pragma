// pragma's own version, and the GitHub repo its releases are published to,
// read once at startup — neither changes over the life of a running server,
// and two callers reading package.json separately is one copy too many.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";

const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
  version: string;
  repository?: unknown;
};

export const pragmaVersion = manifest.version;

/** `owner/repo` from package.json's `repository`, written as npm's `github:`
 * shorthand, a bare `owner/repo` or a github.com URL; undefined otherwise.
 * electron-builder's publish block reads the same field, so the release feed
 * and the update check name one repo. */
export function githubRepository(field: unknown): string | undefined {
  const value = typeof field === "object" && field !== null ? (field as { url?: unknown }).url : field;
  if (typeof value !== "string") return undefined;
  return /^(?:github:|(?:git\+)?https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(value)?.[1];
}

export const pragmaRepository = githubRepository(manifest.repository);
