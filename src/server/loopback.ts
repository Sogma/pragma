import type { IncomingMessage } from "node:http";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Whether a request named a loopback host. A loopback listener must refuse
 * anything else: under DNS rebinding a malicious page reaches 127.0.0.1 while
 * still sending its own domain as `Host` — and as a matching `Origin`, so an
 * Origin-equals-Host check alone lets it through. */
export function hasLoopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_NAMES.has(host);
}
