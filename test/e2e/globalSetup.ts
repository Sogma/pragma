import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { createEditorServer } from "../../src/server/createServer.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { E2E_PORT } from "./port.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const templateSpaceRoot = path.resolve(dirname, "../../templates/space");

// Boots the same Vite dev adapter `pragma dev` uses (see
// docs/architecture.md's Runtime and hosting section), against a throwaway copy of the
// template space, so the smoke suite exercises the real route layer over the
// current source rather than a test-only shortcut or a stale build. Returning a teardown keeps the
// ViteDevServer in closure scope, with no separate globalTeardown file.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const spaceRoot = await mkdtemp(path.join(tmpdir(), "pragma-e2e-space-"));
  // Contents, not links: reached through a symlinked mirror of the repo, a
  // copied link would carry a test's write to its space into the real template.
  await cp(templateSpaceRoot, spaceRoot, { recursive: true, dereference: true });

  // config.json, grants.json and layouts are install-global: without this the
  // suite reads the developer's own providers and settings, and any grant or
  // space registration a test triggers is written into them.
  const configDir = await mkdtemp(path.join(tmpdir(), "pragma-e2e-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  // Registered like every target registers the space it serves: a layout
  // saved for an unregistered space is refused, so tabs would not survive a
  // reload.
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), spaceRoot));

  const server = await createEditorServer(createServedSpace(spaceRoot), { port: E2E_PORT });
  await server.listen();

  return async () => {
    await server.close();
    await rm(spaceRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  };
}
