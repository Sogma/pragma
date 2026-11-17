import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type AuthCheck, readCookie } from "./auth.ts";
import { createLoginThrottle } from "./loginThrottle.ts";
import { readRequestBody } from "./requestBody.ts";

const SESSION_COOKIE = "pragma_session";
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEVICE_COOKIE = "pragma_device";
const DEVICE_LIFETIME_SECONDS = 365 * 24 * 60 * 60; // a year
const UNKNOWN_DEVICES = "unknown";

// Read before any credential is checked, by anyone who reaches the proxy,
// so it is capped near what a typed passphrase needs.
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

// No self-contained styling library on this route — it's a one-off gate
// screen outside the SPA, not a themed part of the app — but it borrows the
// main app's own color/font tokens (web/styles/tokens.css) so it doesn't look like a
// different product. Light mode only: not worth porting dark-theme logic
// for a form nobody stays on.
function loginPageHtml(error: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Pragma</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    color: #1c1c1a;
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  form {
    width: 280px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h1 {
    font-size: 16px;
    margin: 0 0 4px;
  }
  input {
    font: inherit;
    padding: 8px 10px;
    border: 1px solid #ccc;
    border-radius: 6px;
  }
  button {
    font: inherit;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: #1d4ed8;
    color: #fff;
    cursor: pointer;
  }
  .error {
    color: #b91c1c;
    font-size: 13px;
    display: ${error ? "block" : "none"};
  }
</style>
</head>
<body>
  <form id="login-form">
    <h1>Pragma</h1>
    <input id="passphrase" type="password" placeholder="Passphrase" autofocus autocomplete="current-password" />
    <div class="error" id="login-error">Incorrect passphrase.</div>
    <button type="submit">Open space</button>
  </form>
  <script>
    document.getElementById("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const passphrase = document.getElementById("passphrase").value;
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (response.ok) {
        location.href = "/";
        return;
      }
      const error = document.getElementById("login-error");
      const wait = Number(response.headers.get("retry-after")) || 60;
      const minutes = Math.ceil(wait / 60);
      const after =
        wait < 60 ? wait + (wait === 1 ? " second." : " seconds.") : minutes > 1 ? minutes + " minutes." : "a minute.";
      error.textContent =
        response.status === 429 ? "Too many wrong tries. Try again in " + after : "Incorrect passphrase.";
      error.style.display = "block";
    });
  </script>
</body>
</html>`;
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function seal(key: Buffer, claims: { exp: number; id?: string }): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(key, payload)}`;
}

// What a cookie's signature vouches for, until its `exp` passes.
function unseal(key: Buffer, cookie: string | undefined): Record<string, unknown> | undefined {
  const [payload, signature] = cookie?.split(".") ?? [];
  if (!payload || !signature) return undefined;
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(sign(key, payload), "hex");
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof claims.exp === "number" && claims.exp > Date.now() ? claims : undefined;
  } catch {
    return undefined;
  }
}

// Sessions are stateless: each cookie carries its own expiry, so a restart
// signs no one out. Cookies are signed with keys from the cookie secret saved
// beside the passphrase, never with one computed from the passphrase: that
// would let anyone holding one cookie test guesses offline, out of the
// throttle's sight.
//
// Each cookie has a key of its own: the session check accepts any signed
// claims that haven't expired, so a device cookie under the session key would
// sign its holder in.
export function createPassphraseAuth({
  passphrase,
  cookieSecret,
}: {
  passphrase: string;
  cookieSecret: string;
}): AuthCheck {
  const keyFor = (cookie: string) => createHmac("sha256", cookieSecret).update(cookie).digest();
  const sessionKey = keyFor(SESSION_COOKIE);
  const deviceKey = keyFor(DEVICE_COOKIE);
  const throttle = createLoginThrottle();
  // Guesses are compared as digests, all one length, so how long a compare
  // takes says nothing about the passphrase's length either.
  const digestOf = (text: string) => createHash("sha256").update(text, "utf8").digest();
  const passphraseDigest = digestOf(passphrase);

  return {
    authorize(req) {
      return unseal(sessionKey, readCookie(req, SESSION_COOKIE)) !== undefined;
    },

    handleLoginPage(_req, res) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(loginPageHtml(false));
    },

    async handleLoginSubmit(req, res) {
      const body = await readRequestBody(req, MAX_LOGIN_BODY_BYTES);
      if (body === undefined) {
        // Closed rather than kept alive: whoever sent it hasn't signed in,
        // and may still be sending.
        res.statusCode = 413;
        res.setHeader("connection", "close");
        res.end();
        return;
      }

      let submitted: unknown;
      try {
        submitted = (JSON.parse(body.toString("utf8")) as { passphrase?: unknown }).passphrase;
      } catch {
        // malformed body — falls through to the mismatch case below
      }

      // Every new device shares one count: behind the proxy each request
      // arrives from loopback, so no address tells devices apart. A device
      // that signed in before shows its device cookie and keeps a count of
      // its own, so someone guessing can hold up only a device that never has.
      //
      // Nothing awaits between the check and the count: an await would let
      // parallel tries all pass the check before any failure was counted.
      const device = unseal(deviceKey, readCookie(req, DEVICE_COOKIE))?.id;
      const tries = typeof device === "string" ? `device:${device}` : UNKNOWN_DEVICES;
      const wait = throttle.secondsToWait(tries);
      if (wait > 0) {
        res.statusCode = 429;
        res.setHeader("retry-after", String(wait));
        res.end();
        return;
      }

      // Only a string is compared. Turned into bytes, a JSON object with a
      // numeric `length` reads as array-like and allocates that many, so a
      // 35-byte body could stall the server for seconds.
      const matches = typeof submitted === "string" && timingSafeEqual(digestOf(submitted), passphraseDigest);

      if (!matches) {
        throttle.countFailure(tries);
        res.statusCode = 401;
        res.end();
        return;
      }

      const now = Date.now();
      const session = seal(sessionKey, { exp: now + SESSION_LIFETIME_SECONDS * 1000 });
      // A sign-in clears no count: the shared one fades only with time, or
      // signing in from a new device would hand a guesser fresh free tries. A
      // device starts over because it leaves with a new ID.
      const id = randomBytes(16).toString("base64url");
      const deviceCookie = seal(deviceKey, { id, exp: now + DEVICE_LIFETIME_SECONDS * 1000 });
      // Secure: this login is only reached through the HTTPS proxy in front
      // of `pragma start --external-url`.
      res.setHeader("set-cookie", [
        `${SESSION_COOKIE}=${session}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_LIFETIME_SECONDS}`,
        `${DEVICE_COOKIE}=${deviceCookie}; HttpOnly; Secure; Path=/api/auth/login; SameSite=Strict; Max-Age=${DEVICE_LIFETIME_SECONDS}`,
      ]);
      res.statusCode = 204;
      res.end();
    },
  };
}
