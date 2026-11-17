import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";

/** The built app `npm run build` writes, which `pragma start` serves. */
export const BUILT_APP = path.join(PACKAGE_ROOT, "dist/web");

// web/vite.config.mjs writes it: when the build started, and every file it
// read, relative to the app root. Beside dist/web, never in it, since every
// file there is served.
const BUILD_RECORD = "dist/web-inputs.json";

interface BuildRecord {
  builtAt: number;
  inputs: string[];
}

/** Whether the app's sources sit beside its build, as in a clone. The npm
 * package ships the build alone. */
export function isSourceCheckout(root = PACKAGE_ROOT): boolean {
  return statSync(path.join(root, "web"), { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Why the built app under `root` can't be served, or undefined when it can.
 * A source file changed since the build means a frontend out of step with
 * the routes it calls, which fails in ways that never name the build. */
export function builtAppProblem(root = PACKAGE_ROOT): string | undefined {
  if (!statSync(path.join(root, "dist/web/index.html"), { throwIfNoEntry: false })) {
    return "No built app in dist/web.";
  }
  // A package ships no sources, so there is nothing for its build to lag.
  if (!isSourceCheckout(root)) return undefined;
  let record: BuildRecord;
  try {
    record = JSON.parse(readFileSync(path.join(root, BUILD_RECORD), "utf8")) as BuildRecord;
  } catch {
    return "No built app in dist/web.";
  }
  for (const input of record.inputs) {
    const stat = statSync(path.join(root, input), { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs > record.builtAt) return `${input} has changed since dist/web was built.`;
  }
  return undefined;
}
