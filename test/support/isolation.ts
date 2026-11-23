import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { pointConfigAt } from "./configDir.ts";

// Each helper undoes itself once the test has finished, after the file's own
// teardown hooks, so a server or watcher those close is gone before its
// folder is removed. Call them from a test or a per-test setup hook: a folder
// one suite shares needs a teardown of its own.

/** A new empty folder in the system temp directory, removed when the test finishes. */
export function tempDir(prefix = "pragma-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Points PRAGMA_CONFIG_DIR at `dir`, a new temp folder unless given, until the
 * test finishes, so nothing the test runs reads or writes the developer's own
 * config.
 */
export function isolateConfig(dir = tempDir("pragma-config-")): string {
  onTestFinished(pointConfigAt(dir));
  return dir;
}

/**
 * A new empty space: a temp folder registered as every host registers the
 * space it serves, since grants and layouts key off the id that mints.
 * Refused until the config is isolated, or it would land in the developer's.
 */
export function tempSpace(prefix = "pragma-space-"): string {
  if (!process.env.PRAGMA_CONFIG_DIR) throw new Error("Isolate the config before registering a space.");
  const space = tempDir(prefix);
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
  return space;
}
