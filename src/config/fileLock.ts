// A lock that other processes on this machine wait on, held by the OS through
// SQLite's file locking, never by a timestamp. The OS frees it the moment its
// holder exits or dies, so nothing ever breaks a lock for being old: a holder
// waiting on a keychain prompt or a slow token refresh may hold it as long as
// it lives. The lock file holds no data.
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

/** Another holder kept the lock for the whole wait. */
export class LockBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`${lockPath} is held by another Pragma process. Try again once it finishes.`);
    this.name = "LockBusyError";
    this.lockPath = lockPath;
  }
}

export interface FileLockOptions {
  // How long to wait for another holder before giving up with LockBusyError.
  waitMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_WAIT_MS = 10_000;
const MAX_PAUSE_MS = 200;
const SQLITE_BUSY = 5;

// Callers in one process queue per lock, in order, rather than polling the
// OS lock against each other.
const tails = new Map<string, Promise<void>>();

/** Runs `run` while holding the lock at `lockPath`, waiting for other holders
 * in this process and in others. */
export async function withFileLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const key = path.resolve(lockPath);
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const before = tails.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  const release = () => {
    done();
    if (tails.get(key) === tail) tails.delete(key);
  };
  try {
    await untilDeadline(before, key, deadline, options.signal);
  } catch (error) {
    // Successors still wait for the holder ahead of this call.
    void before.then(release);
    throw error;
  }
  try {
    return await holdingOsLock(key, run, deadline, options.signal);
  } finally {
    release();
  }
}

async function untilDeadline(
  turn: Promise<void>,
  key: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const stop = new AbortController();
  const stopOn = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const expired = delay(Math.max(0, deadline - Date.now()), "expired", { signal: stopOn });
  try {
    const outcome = await Promise.race([turn.then(() => "turn" as const), expired]);
    if (outcome === "expired") throw new LockBusyError(key);
  } finally {
    stop.abort();
    expired.catch(() => {});
  }
}

// The busy timeout is zero and the retry is a timer, because SQLite's own wait
// would block the event loop, and the desktop app's main process also serves
// the editor.
//
// Nothing else may open the lock file: on POSIX, closing any descriptor for a
// file drops every lock the process holds on it. Changing its mode goes by
// path, so it is safe.
async function holdingOsLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    chmodSync(lockPath, 0o600);
    for (let pause = 10; ; pause = Math.min(pause * 2, MAX_PAUSE_MS)) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new LockBusyError(lockPath);
        await delay(Math.min(pause, remaining), undefined, { signal });
      }
    }
    return await run();
  } finally {
    // Closing ends the transaction and frees the OS lock.
    db.close();
  }
}
