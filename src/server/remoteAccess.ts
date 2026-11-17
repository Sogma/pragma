import type { IncomingMessage } from "node:http";

// What a reverse proxy or tunnel adds to a request it forwards. Tailscale
// Serve, Caddy and Cloudflare Tunnel each set at least one of these.
const PROXY_HEADERS = [
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
];

/** The address an HTTPS proxy serves Pragma under for other devices, or why
 * `raw` can't be one. https only: browsers withhold APIs Pragma uses, such as
 * `crypto.randomUUID`, from a page served over plain http. An origin only:
 * the app is served from the root, so a proxy path prefix would break it. */
export function parseExternalUrl(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") {
    return "must be an https:// address: browsers withhold APIs Pragma uses from a page served over plain http";
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    return "must be an origin only, like https://notes.example.com: Pragma is served from the root";
  }
  return url;
}

/** Whether a request names the external URL's host, as a proxy that keeps
 * `Host` forwards it. */
export function hasExternalHost(req: IncomingMessage, externalUrl: URL | undefined): boolean {
  if (!externalUrl) return false;
  const host = (req.headers.host ?? "").toLowerCase().replace(/:443$/, "");
  return host === externalUrl.host;
}

/** Whether a reverse proxy or tunnel forwarded this request. */
export function hasProxyHeaders(req: IncomingMessage): boolean {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}
