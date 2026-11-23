import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthCheck, alwaysAuthorized } from "../../src/server/auth.ts";
import { createProductionServer, type ProductionServer } from "../../src/server/productionServer.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { copyTemplateSpace } from "./templateSpace.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const space = await copyTemplateSpace("test");
  const server = createProductionServer({
    port: 0,
    served: createServedSpace(space.spaceRoot),
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
    await space.remove();
  }

  const { spaceRoot, configDir } = space;
  return { baseUrl, spaceRoot, configDir, server, close, [Symbol.asyncDispose]: close };
}
