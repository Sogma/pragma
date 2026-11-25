// The entries this window's requests wrote into a space or library, as each
// response names them (src/server/writtenPaths.ts), told to every view that
// lists their folders so it reads them now rather than at the change feed's
// next check. Writes made anywhere else reach the views through that feed.

let notified = 0;
let pending = new Set<string>();
let telling: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(paths: readonly string[], through: number) => void>();

/** How many writes have been told so far: a read that starts at this count
 * holds every one of them. */
export function writesNotified(): number {
  return notified;
}

/** Tells the views the rooted paths a write left. */
export function notifyWritten(paths: readonly string[]): void {
  if (paths.length === 0) return;
  notified++;
  for (const path of paths) pending.add(path);
  // Paths written in one go are told together, so a view reads once.
  if (telling !== undefined) return;
  telling = setTimeout(() => {
    const told = [...pending];
    pending = new Set();
    telling = undefined;
    for (const listener of listeners) listener(told, notified);
  }, 0);
}

/** Calls `listener` with the paths written together, and the count of writes
 * told once they are: a read started at that count or later holds them.
 * Returns the way to stop. */
export function onWritten(listener: (paths: readonly string[], through: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
