// What this install keeps per context: the scope a surface's tab is seen in,
// as its folder's rooted path, "" for the space's own. Only the client knows
// the tab, so it names the context (web/core/tabContext.ts). Each record is
// host state in the space's layout (layout.ts): it follows its context's
// folder when that moves, and goes when that is deleted.
import { stat } from "node:fs/promises";
import { isLibraryRoot } from "../protocol/rootedPath.ts";
import { readContextViews, updateContextViews } from "./layout.ts";
import type { ContextViewRecord } from "./layoutStore.ts";
import { formatWithinRoot, resolveRootedPath } from "./rootedFiles.ts";

/** `value` as a context: "" for the space's own, a folder of the space that
 * is there, or the top of a library located here, spelled as on disk.
 * Undefined for anything else, a library's own folders included, a library
 * being one scope. */
export async function readContext(spaceRoot: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  try {
    const resolved = resolveRootedPath(spaceRoot, value, "read");
    if (isLibraryRoot(resolved.rooted.root) && resolved.rooted.path !== "") return undefined;
    if (!(await stat(resolved.filePath)).isDirectory()) return undefined;
    return formatWithinRoot(resolved, resolved.filePath);
  } catch {
    return undefined;
  }
}

/** Whether the rooted path `rooted` is `entry` or lies inside it. */
export const isAtOrUnder = (rooted: string, entry: string) => rooted === entry || rooted.startsWith(`${entry}/`);

/** `rooted` once `from` has moved to `to`. */
export const followMove = (rooted: string, from: string, to: string) =>
  isAtOrUnder(rooted, from) ? to + rooted.slice(from.length) : rooted;

/** After `from` moved to `to`: each context at or under it follows, and
 * `move` carries along what its value names. Undefined when nothing
 * changed. */
export function movedContexts<T>(
  records: Record<string, T>,
  from: string,
  to: string,
  move: (value: T) => T = (value) => value,
): Record<string, T> | undefined {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [context, value] of Object.entries(records)) {
    const movedContext = followMove(context, from, to);
    const movedValue = move(value);
    changed ||= movedContext !== context || movedValue !== value;
    next[movedContext] = movedValue;
  }
  return changed ? next : undefined;
}

/** After `removed` was deleted: each context at or under it goes, and so
 * does any whose value `gone` says went with it. Undefined when none did. */
export function forgottenContexts<T>(
  records: Record<string, T>,
  removed: string,
  gone: (value: T) => boolean = () => false,
): Record<string, T> | undefined {
  const kept = Object.entries(records).filter(([context, value]) => !isAtOrUnder(context, removed) && !gone(value));
  return kept.length === Object.keys(records).length ? undefined : Object.fromEntries(kept);
}

/** The guides and look kept for `context`, each null where none was. */
export async function contextViewFor(spaceRoot: string, context: string): Promise<{ guides: unknown; look: unknown }> {
  const record = (await readContextViews(spaceRoot))[context];
  return { guides: record?.guides ?? null, look: record?.look ?? null };
}

/** Keeps whichever of the guides and the look `change` gives for `context`. */
export async function rememberContextView(
  spaceRoot: string,
  context: string,
  change: ContextViewRecord,
): Promise<void> {
  await updateContextViews(spaceRoot, (views) => ({ ...views, [context]: { ...views[context], ...change } }));
}
