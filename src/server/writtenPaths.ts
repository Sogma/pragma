// What each request changes in a space or library's listing, recorded where
// every write resolves its target (rootedFiles.ts), so no route names its
// writes by hand, and named in the response for the page to tell its views
// (web/core/written.ts).
import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { MiddlewareHandler } from "hono";
import { formatWrittenPaths, WRITTEN_HEADER } from "../protocol/api.ts";

interface Resolved {
  filePath: string;
  wasFile: boolean;
}

const requests = new AsyncLocalStorage<Map<string, Resolved>>();

/** Notes a rooted path the current request resolved to write, and whether a
 * file was there then; nothing outside a request, as for a job the host
 * saves on its own. */
export function recordWrite(rooted: string, filePath: string): void {
  const resolved = requests.getStore();
  if (!resolved || resolved.has(rooted)) return;
  resolved.set(rooted, { filePath, wasFile: statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false });
}

/** Records what each request resolves to write, and names in a response that
 * succeeded what changed a listing: an entry made, one gone, or a folder
 * written into. A file still a file was only saved, which lists nothing new,
 * so a note's autosave never has the trees read again. */
export const nameWrites: MiddlewareHandler = async (c, next) => {
  const resolved = new Map<string, Resolved>();
  await requests.run(resolved, next);
  if (resolved.size === 0 || !c.res.ok) return;
  const changed: string[] = [];
  for (const [rooted, { filePath, wasFile }] of resolved) {
    const isFile = (await stat(filePath).catch(() => undefined))?.isFile() ?? false;
    if (!(wasFile && isFile)) changed.push(rooted);
  }
  if (changed.length === 0) return;
  try {
    c.res.headers.set(WRITTEN_HEADER, formatWrittenPaths(changed));
  } catch {
    // A response passed through from elsewhere keeps its headers; the change
    // feed still brings the write.
  }
};
