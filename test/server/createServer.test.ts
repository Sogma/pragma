import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { spaceApiPlugin } from "../../src/server/createServer.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;

let space: string;
let configDir: string;

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-dev-api-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-dev-api-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

// The middleware the plugin adds to the dev server, taken as it registers.
function devApi(): Middleware {
  let added: Middleware | undefined;
  const configure = spaceApiPlugin(createServedSpace(space)).configureServer as (server: unknown) => void;
  configure({ middlewares: { use: (handler: Middleware) => (added = handler) } });
  if (!added) throw new Error("The plugin added no middleware");
  return added;
}

function answer(): { statusCode: number; setHeader: () => void; end: () => void } {
  return { statusCode: 200, setHeader: () => {}, end: () => {} };
}

it("refuses an API request on a Host the production server refuses, before any route", async () => {
  const handle = devApi();
  for (const host of ["foo.localhost:14319", "192.168.1.5:14319", "evil.example.com"]) {
    const res = answer();
    await handle(
      { url: "/api/space/info", headers: { host } } as IncomingMessage,
      res as unknown as ServerResponse,
      () => {},
    );
    expect(res.statusCode).toBe(403);
  }
});

it("leaves everything outside /api/ to the dev server", async () => {
  let passed = false;
  await devApi()(
    { url: "/index.html", headers: { host: "evil.example.com" } } as IncomingMessage,
    answer() as unknown as ServerResponse,
    () => (passed = true),
  );
  expect(passed).toBe(true);
});
