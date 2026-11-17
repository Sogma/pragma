import type { IncomingMessage, ServerResponse } from "node:http";

// The one checkpoint every /api/* request (and, via productionServer.ts,
// every static asset request) passes through. alwaysAuthorized is the
// no-op default (dev server, tests); launchTokenAuth.ts gates the desktop
// target and passphraseAuth.ts the remote-access one — see docs/deployment.md.
export interface AuthCheck {
  authorize(req: IncomingMessage): boolean | Promise<boolean>;

  // Optional: an implementation that supports an interactive login flow
  // handles these two routes itself (see productionServer.ts). alwaysAuthorized
  // leaves them undefined — there's nothing to log into.
  handleLoginPage?(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
  handleLoginSubmit?(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
}

export const alwaysAuthorized: AuthCheck = {
  authorize: () => true,
};

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
