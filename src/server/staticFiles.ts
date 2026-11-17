import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveWithinRoot } from "./rootedFiles.ts";

const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** The file a request path names in the assets the "build" package.json
 * script produces, with its media type, or undefined when there is none. A
 * path escaping staticRoot (`..` traversal) must never resolve to a real
 * file. There is no client-side routing, so the only fallback is "/" ->
 * index.html; every other path is an exact file or nothing. */
// No other site's page may frame the app: on loopback it needs no login, so a
// framing page could trick a click on Delete, Trust, a permission prompt or
// Run. Its own origin may still frame it.
export const FRAME_HEADERS = { "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" };

export async function readStaticFile(
  staticRoot: string,
  pathname: string,
): Promise<{ content: Buffer; type: string } | undefined> {
  try {
    const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = resolveWithinRoot(staticRoot, relativePath, "Path escapes static root");
    return {
      content: await readFile(filePath),
      type: MEDIA_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}

// The production counterpart to Vite's dev-time asset pipeline.
export async function serveStaticFile(staticRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }

  const file = await readStaticFile(staticRoot, new URL(req.url ?? "", "http://localhost").pathname);
  if (!file) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader("content-type", file.type);
  res.setHeader("content-length", file.content.length);
  for (const [name, value] of Object.entries(FRAME_HEADERS)) res.setHeader(name, value);
  res.end(req.method === "HEAD" ? undefined : file.content);
}
