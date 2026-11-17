import { cp, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { type AuthCheck, alwaysAuthorized } from "../../src/server/auth.ts";
import { createProductionServer, type ProductionServer } from "../../src/server/productionServer.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The scaffolded starter space (kept in sync with pragma's document kinds —
// see AGENTS.md's "Keep the template space in sync") doubles as the fixture
// every contract/protocol test runs against. It's never mutated in place:
// each test server gets its own throwaway copy, so a PUT/write test can't
// leave the real template dirty for the next run or for `pragma init`.
const templateSpaceRoot = path.resolve(dirname, "../../templates/space");

// staticRoot is never actually served in these tests (only /api/* is
// exercised), so any always-present directory is a harmless placeholder.
const placeholderStaticRoot = path.resolve(dirname, "../../web");

export interface TestServer {
  baseUrl: string;
  spaceRoot: string;
  configDir: string;
  server: ProductionServer;
  [Symbol.asyncDispose]: () => Promise<void>;
  close(): Promise<void>;
}

// Boots a real node:http server (the same one Electron and `pragma start`
// run — see productionServer.ts) on an OS-assigned port, against a fresh
// copy of the template space. Contract tests hit it over real HTTP via
// baseUrl, never by importing route handlers directly, so swapping the
// router changes only this helper.
export async function startTestServer(auth: AuthCheck = alwaysAuthorized, externalUrl?: URL): Promise<TestServer> {
  // Config and grants are install-global, so a test server that used the real
  // ones would read and write the developer's own. Each gets a throwaway
  // directory instead, via the PRAGMA_CONFIG_DIR seam (loadConfig.ts).
  const configDir = await mkdtemp(path.join(tmpdir(), "pragma-test-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;

  const spaceRoot = await mkdtemp(path.join(tmpdir(), "pragma-test-space-"));
  // Contents, not links: reached through a symlinked mirror of the repo, a
  // copied link would carry a test's write to its space into the real template.
  await cp(templateSpaceRoot, spaceRoot, { recursive: true, dereference: true });

  // Registering the space is what every real path that opens one does
  // (start.ts, Electron, the switch route). Grants key off the id it mints,
  // so a server started without this can't record an approval at all.
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), spaceRoot));

  const server = createProductionServer({
    port: 0,
    served: createServedSpace(spaceRoot),
    staticRoot: placeholderStaticRoot,
    auth,
    externalUrl,
  });

  await new Promise<void>((resolve) => server.server.once("listening", resolve));
  const { port } = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(spaceRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    delete process.env.PRAGMA_CONFIG_DIR;
  }

  return { baseUrl, spaceRoot, configDir, server, close, [Symbol.asyncDispose]: close };
}
