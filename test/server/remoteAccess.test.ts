import { type IncomingMessage, request } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthCheck } from "../../src/server/auth.ts";
import { createPassphraseAuth } from "../../src/server/passphraseAuth.ts";
import { parseExternalUrl } from "../../src/server/remoteAccess.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

const EXTERNAL = new URL("https://notes.example.ts.net");
const PROXY_HEADERS = { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" };
const SECRET = "test cookie secret";

// fetch() can't set Host, hence node:http.
function send(
  server: TestServer,
  pathname: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number | undefined;
  cookie: string | undefined;
  cookies: string[];
  retryAfter: string | undefined;
}> {
  const { port } = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method: body === undefined ? "GET" : "POST", headers },
      (res) => {
        res.resume();
        const cookies = res.headers["set-cookie"] ?? [];
        resolve({ status: res.statusCode, cookie: cookies[0], cookies, retryAfter: res.headers["retry-after"] });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Sends the headers and at most the start of a body, never its end, so an
// answer proves the server didn't wait for the rest.
function sendLoginStart(
  server: TestServer,
  headers: Record<string, string>,
  start: string,
): Promise<{ status: number | undefined; connection: string | undefined }> {
  const { port } = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/auth/login", method: "POST", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, connection: res.headers.connection });
      req.destroy();
    });
    req.on("error", reject);
    if (start) req.write(start);
    else req.flushHeaders();
  });
}

describe("parseExternalUrl", () => {
  it("accepts an https origin, keeping a port other than 443", () => {
    expect(parseExternalUrl("https://notes.example.com")).toBeInstanceOf(URL);
    expect((parseExternalUrl("https://Notes.Example.com:8443/") as URL).host).toBe("notes.example.com:8443");
  });

  it("refuses plain http, a path, a query and what isn't a URL", () => {
    expect(parseExternalUrl("http://notes.example.com")).toMatch(/^must be an https:\/\/ address/);
    expect(parseExternalUrl("https://example.com/pragma")).toMatch(/^must be an origin only/);
    expect(parseExternalUrl("https://example.com/?space=main")).toMatch(/^must be an origin only/);
    expect(parseExternalUrl("notes.example.com")).toBe("is not a URL");
  });
});

describe("a server with no external URL", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves a direct loopback request", async () => {
    const { port } = new URL(server.baseUrl);
    expect((await send(server, "/api/space/info", { host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  // A proxy that rewrites Host to loopback would otherwise pass the Host
  // check and hand `pragma start`'s login-free space to whoever reaches it.
  it("refuses a proxied API request, even on a loopback Host", async () => {
    const { port } = new URL(server.baseUrl);
    const res = await send(server, "/api/space/info", { host: `127.0.0.1:${port}`, ...PROXY_HEADERS });
    expect(res.status).toBe(403);
  });

  it("refuses an external name it was not given", async () => {
    expect((await send(server, "/api/space/info", { host: EXTERNAL.host })).status).toBe(403);
  });
});

describe("a server behind an HTTPS proxy", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(undefined, EXTERNAL);
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves what the proxy forwards under the external URL's host", async () => {
    const res = await send(server, "/api/space/info", {
      host: EXTERNAL.host,
      origin: EXTERNAL.origin,
      ...PROXY_HEADERS,
    });
    expect(res.status).toBe(200);
  });

  it("still refuses any other name", async () => {
    const res = await send(server, "/api/space/info", { host: "evil.example.com", ...PROXY_HEADERS });
    expect(res.status).toBe(403);
  });
});

describe("the passphrase login", () => {
  const LOGIN_HEADERS = { host: EXTERNAL.host, "content-type": "application/json", ...PROXY_HEADERS };
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(
      createPassphraseAuth({ passphrase: "correct horse", cookieSecret: SECRET }),
      EXTERNAL,
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it("sets its session cookie Secure, since only the HTTPS proxy reaches it", async () => {
    const res = await send(server, "/api/auth/login", LOGIN_HEADERS, JSON.stringify({ passphrase: "correct horse" }));
    expect(res.status).toBe(204);
    expect(res.cookie).toMatch(/; Secure;/);
  });

  // Read before any credential is checked, by anyone who reaches the proxy.
  it("refuses an oversized body without waiting for the rest of it", async () => {
    const refused = { status: 413, connection: "close" };
    const declared = { ...LOGIN_HEADERS, "content-length": String(1024 * 1024) };
    expect(await sendLoginStart(server, declared, "")).toEqual(refused);
    // No declared length: the cap is counted as the body arrives.
    expect(await sendLoginStart(server, LOGIN_HEADERS, `{"passphrase":"${"a".repeat(5000)}`)).toEqual(refused);
  });

  // Anything array-like would be turned into bytes: the right bytes spelled
  // as numbers would sign in, and `{ "length": N }` would allocate N of them.
  it("compares only a string passphrase", async () => {
    for (const passphrase of [5, [...Buffer.from("correct horse")]]) {
      const res = await send(server, "/api/auth/login", LOGIN_HEADERS, JSON.stringify({ passphrase }));
      expect(res.status).toBe(401);
    }
  });
});

describe("signing in through the proxy", () => {
  const LOGIN_HEADERS = { host: EXTERNAL.host, "content-type": "application/json", ...PROXY_HEADERS };
  let auth: AuthCheck;
  let server: TestServer;

  beforeEach(async () => {
    auth = createPassphraseAuth({ passphrase: "correct horse", cookieSecret: SECRET });
    server = await startTestServer(auth, EXTERNAL);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  const signIn = (passphrase: string, cookie?: string) =>
    send(
      server,
      "/api/auth/login",
      cookie ? { ...LOGIN_HEADERS, cookie } : LOGIN_HEADERS,
      JSON.stringify({ passphrase }),
    );

  // `name=value` of one cookie a sign-in set.
  const pair = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
  const withCookie = (cookie: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;

  // The clock stands still in these two, so each wait is exactly what the
  // count earned, however slowly the requests run.
  it("holds up every new device once wrong tries pass 5, the right passphrase included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 6; i++) expect((await signIn("wrong")).status).toBe(401);
    const held = await signIn("correct horse");
    expect(held.status).toBe(429);
    expect(held.retryAfter).toBe("1");
  });

  it("leaves a device that signed in before a count of its own", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { cookies } = await signIn("correct horse");
    expect(cookies.find((c) => c.startsWith("pragma_device="))).toMatch(
      /; HttpOnly; Secure; Path=\/api\/auth\/login; SameSite=Strict; Max-Age=31536000$/,
    );
    const device = pair(cookies, "pragma_device");

    for (let i = 0; i < 6; i++) await signIn("wrong");
    expect((await signIn("correct horse")).status).toBe(429);
    expect((await signIn("correct horse", device)).status).toBe(204);

    for (let i = 0; i < 6; i++) await signIn("wrong", device);
    expect((await signIn("correct horse", device)).status).toBe(429);
  });

  it("never takes a device cookie for a session", async () => {
    const { cookies } = await signIn("correct horse");
    const cookieValue = (name: string) => pair(cookies, name).slice(name.length + 1);
    expect(await auth.authorize(withCookie(`pragma_session=${cookieValue("pragma_session")}`))).toBe(true);
    expect(await auth.authorize(withCookie(`pragma_session=${cookieValue("pragma_device")}`))).toBe(false);
  });

  it("signs sessions with the saved cookie secret, not with the passphrase", async () => {
    const session = withCookie(pair((await signIn("correct horse")).cookies, "pragma_session"));
    const signedWith = (cookieSecret: string) => createPassphraseAuth({ passphrase: "correct horse", cookieSecret });
    expect(await signedWith(SECRET).authorize(session)).toBe(true);
    expect(await signedWith("another secret").authorize(session)).toBe(false);
  });
});
