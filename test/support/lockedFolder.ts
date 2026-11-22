// A folder that can't be listed, for a test of what a walk does with one.
// chmod can't hide a folder from root, and Windows ignores it, so a test
// that needs one skips there.
import { chmodSync } from "node:fs";

export const canLockFolders = process.platform !== "win32" && process.getuid?.() !== 0;

/** Runs `run` with `folder` unlistable, then lists it again, so the test's
 * cleanup can remove it. */
export async function lockedFolder<T>(folder: string, run: () => Promise<T>): Promise<T> {
  chmodSync(folder, 0o000);
  try {
    return await run();
  } finally {
    chmodSync(folder, 0o755);
  }
}
