import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { pointConfigAt } from "./configDir.ts";

// The scaffolded starter space, kept in sync with pragma's document kinds
// (AGENTS.md's "Keep the template space in sync"), doubles as the space the
// contract and smoke suites run against.
const templateSpaceRoot = fileURLToPath(new URL("../../templates/space", import.meta.url));

export interface TemplateSpace {
  spaceRoot: string;
  configDir: string;
  /** Deletes both folders and puts PRAGMA_CONFIG_DIR back. */
  remove(): Promise<void>;
}

/**
 * A throwaway copy of the template space, registered in a throwaway config
 * that PRAGMA_CONFIG_DIR points at until `remove`. Config, grants and layouts
 * are install-global, so a suite's writes reach neither the developer's own
 * nor the template.
 */
export async function copyTemplateSpace(label: string): Promise<TemplateSpace> {
  const configDir = await mkdtemp(path.join(tmpdir(), `pragma-${label}-config-`));
  const spaceRoot = await mkdtemp(path.join(tmpdir(), `pragma-${label}-space-`));
  // Contents, not links: reached through a symlinked mirror of the repo, a
  // copied link would carry a test's write to its space into the real template.
  await cp(templateSpaceRoot, spaceRoot, { recursive: true, dereference: true });
  const restoreConfig = pointConfigAt(configDir);
  // Registered as every host registers the space it serves: grants key off
  // the id this mints, and a layout saved for an unregistered space is refused.
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), spaceRoot));
  return {
    spaceRoot,
    configDir,
    async remove() {
      restoreConfig();
      await rm(spaceRoot, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    },
  };
}
