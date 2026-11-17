import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Found by walking up to package.json, never by a fixed `../..`: the npm
// package bundles every module into dist/cli/, so a path relative to a
// module's own file lands somewhere else there. A file read from here ships
// only because both scripts/pack-npm.mjs and electron-builder.yml list it.

/** The nearest folder at or above `start` that holds a package.json. */
export function packageRootAbove(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`No package.json at or above ${start}`);
  }
}

/** Pragma's own folder: the repository in a clone, the installed package
 * from npm, the app archive in the desktop app. */
export const PACKAGE_ROOT = packageRootAbove(path.dirname(fileURLToPath(import.meta.url)));
