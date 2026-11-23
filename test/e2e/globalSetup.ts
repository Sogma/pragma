import { createEditorServer } from "../../src/server/createServer.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { copyTemplateSpace } from "../support/templateSpace.ts";
import { E2E_PORT } from "./port.ts";

// Boots the same Vite dev adapter `pragma dev` uses (see
// docs/architecture.md's Runtime and hosting section), against a throwaway copy of the
// template space, so the smoke suite exercises the real route layer over the
// current source rather than a test-only shortcut or a stale build. Returning a teardown keeps the
// ViteDevServer in closure scope, with no separate globalTeardown file.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const space = await copyTemplateSpace("e2e");
  const server = await createEditorServer(createServedSpace(space.spaceRoot), { port: E2E_PORT });
  await server.listen();

  return async () => {
    await server.close();
    await space.remove();
  };
}
