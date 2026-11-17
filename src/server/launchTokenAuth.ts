import { randomBytes, timingSafeEqual } from "node:crypto";
import { type AuthCheck, readCookie } from "./auth.ts";

export const LAUNCH_TOKEN_COOKIE = "pragma_launch";

export interface LaunchTokenAuth {
  auth: AuthCheck;
  /** The secret the host hands its own window as the LAUNCH_TOKEN_COOKIE
   * cookie. Never logged or written to disk: it lives exactly as long as the
   * process that minted it. */
  token: string;
}

// The desktop target's AuthCheck. A loopback port is reachable by every local
// process and, through DNS rebinding or a cross-site request, by any web page;
// a secret only this process's window holds is what separates the writer from
// them. No login flow — nobody but the host can present the token, so a miss
// is a plain 401.
export function createLaunchTokenAuth(): LaunchTokenAuth {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(token, "utf8");

  return {
    token,
    auth: {
      authorize(req) {
        const presented = Buffer.from(readCookie(req, LAUNCH_TOKEN_COOKIE) ?? "", "utf8");
        return presented.length === expected.length && timingSafeEqual(presented, expected);
      },
    },
  };
}
