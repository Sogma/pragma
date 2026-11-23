import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiToken, findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { ApiAuthError, authorizeApiRequest, checkRequestOrigin } from "../../src/server/apiServer.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

let space: string;
let secret: string;

// Only the headers the checks read; a real IncomingMessage carries far more.
const request = (headers: Record<string, string>): IncomingMessage =>
  ({ headers: { host: "127.0.0.1:4319", ...headers } }) as unknown as IncomingMessage;

const bearer = (value: string) => request({ authorization: `Bearer ${value}` });

function mintToken(options: { readOnly?: boolean; spaceId?: string } = {}): string {
  const config = loadGlobalConfig();
  const { secret: value, record } = createApiToken({
    label: "Test client",
    spaceId: options.spaceId ?? (findSpaceId(config, space) as string),
    access: (options.readOnly ?? true) ? "read-only" : "read-write",
  });
  saveGlobalConfig({ ...config, apiTokens: [...(config.apiTokens ?? []), record] });
  return value;
}

beforeEach(() => {
  isolateConfig();
  space = tempSpace("pragma-api-space-");
  secret = mintToken();
});

describe("the agent endpoint's origin check", () => {
  // Inverted from the app server's: there a matching origin means allowed,
  // here any browser origin is wrong, because an MCP client is not a web page.
  it("refuses any request carrying an Origin, matching or not", () => {
    for (const origin of ["http://localhost:4319", "https://evil.example", "null"]) {
      expect(() => checkRequestOrigin(request({ origin }))).toThrow(/Browser origins/);
    }
  });

  it("accepts a loopback Host when no Origin is sent", () => {
    expect(() => checkRequestOrigin(request({ host: "127.0.0.1:4319" }))).not.toThrow();
    expect(() => checkRequestOrigin(request({ host: "localhost" }))).not.toThrow();
  });

  // The DNS-rebinding case: a browser reaches 127.0.0.1 while still sending
  // the attacker's domain as Host.
  it("refuses a non-loopback Host", () => {
    expect(() => checkRequestOrigin(request({ host: "evil.example" }))).toThrow(/loopback/);
  });
});

describe("the agent endpoint's authorization", () => {
  it("refuses a missing, malformed or unknown token", () => {
    expect(() => authorizeApiRequest(request({}), space)).toThrow(/Missing bearer token/);
    expect(() => authorizeApiRequest(request({ authorization: secret }), space)).toThrow(/Missing bearer token/);
    expect(() => authorizeApiRequest(bearer("pragma_nope"), space)).toThrow(/Unknown token/);
  });

  // Bearer only. A session cookie must never reach this listener, or the
  // cookie/token separation is a convention rather than a boundary.
  it("ignores a session cookie entirely", () => {
    expect(() => authorizeApiRequest(request({ cookie: "pragma_session=whatever" }), space)).toThrow(
      /Missing bearer token/,
    );
  });

  it("accepts a valid token and reports it read-only by default", () => {
    const authorized = authorizeApiRequest(bearer(secret), space);
    expect(authorized.token.label).toBe("Test client");
    expect(authorized.canWrite).toBe(false);
  });

  // A token's access is decided at creation and never widened afterwards:
  // there is no mode elsewhere that can change what an existing token may do.
  it("takes a token's access from the token itself", () => {
    expect(authorizeApiRequest(bearer(secret), space).canWrite).toBe(false);

    const writable = mintToken({ readOnly: false });
    expect(authorizeApiRequest(bearer(writable), space).canWrite).toBe(true);
    // Minting a second one does not disturb the first.
    expect(authorizeApiRequest(bearer(secret), space).canWrite).toBe(false);
  });

  // A token names one space, so it cannot read another just because this
  // process happens to be serving it.
  it("refuses a token minted for a different space", () => {
    const other = mintToken({ spaceId: "spc_someother" });
    expect(() => authorizeApiRequest(bearer(other), space)).toThrow(/different space/);
  });

  it("stores only a hash, never the token itself", () => {
    const stored = loadGlobalConfig().apiTokens ?? [];
    expect(stored[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(secret).toMatch(/^pragma_[0-9a-f]{64}$/);
  });

  it("reports the status each refusal should become", () => {
    try {
      authorizeApiRequest(request({}), space);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiAuthError);
      expect((error as ApiAuthError).status).toBe(401);
    }
  });
});
