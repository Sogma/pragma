// Reading and writing the install-global JSON files — `config.json`,
// `grants.json` and each space's layout — under the one rule that keeps them
// from destroying themselves. See docs/architecture.md's Space identity and state ownership section.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A host-state file that exists but does not hold a JSON object. Its own
 * class so a caller can choose to degrade on it — a capability check reading
 * unreadable approvals as "nothing granted" — without also swallowing a
 * permissions error it should surface. */
export class HostStateParseError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${filePath} exists but could not be read as JSON: ${detail}\n\n` +
        "Pragma refuses to continue from a host-state file it cannot parse: writes to these files are " +
        "read-modify-writes, so treating this one as empty would persist that emptiness over everything it " +
        "holds: the space registry, provider keys, publishers and API tokens in config.json, and every " +
        "recorded approval in grants.json. Fix the syntax error, or move the file aside to start over: a " +
        "new registry mints new space ids, orphaning every approval and API token keyed to the old ones.",
    );
    this.name = "HostStateParseError";
    this.filePath = filePath;
  }
}

/** The file's contents, or undefined when it isn't there yet.
 *
 * Missing and unparseable are deliberately different answers: callers
 * read-modify-write, so an unparseable file reported as empty looks like a
 * first run and the next save makes that emptiness permanent.
 *
 * Hand-editing these files is documented workflow on the targets with no
 * settings UI (docs/deployment.md), so a syntax error here is an expected
 * event, not an unreachable corruption. */
export function readHostStateFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new HostStateParseError(filePath, error);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostStateParseError(filePath, "top level is not a JSON object");
  }
  return parsed as T;
}

/** Never leaves a half-written file behind: a plain write truncates first, so
 * a crash or a full disk partway through leaves a file that parses as nothing.
 *
 * Synchronous rather than reusing spaceFiles.ts's async atomic writer:
 * Electron saves window bounds from a `close` handler during teardown, where
 * a promise is not guaranteed to settle before the process goes away.
 *
 * `mode` is set on the fresh file every write: the rename replaces the file,
 * so permissions someone set on the old one would not survive it. */
export function writeHostStateFile(filePath: string, value: unknown, options: { mode?: number } = {}): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: options.mode });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

// Longer than any work a lock is held for, so only a holder that died leaves
// one this old.
const STALE_LOCK_MS = 60_000;

/** Runs `run` holding `<filePath>.lock`, which other processes wait on: for
 * work two processes sharing this directory must never do at once, such as
 * spending a refresh token that rotates. A stale lock is broken. */
export async function withHostStateLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + STALE_LOCK_MS + 5_000;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) rmSync(lockPath, { force: true });
      } catch {
        // Released between the open and the stat: the next try takes it.
      }
      if (Date.now() > deadline) throw new Error(`${lockPath} stayed locked; try again.`);
      await delay(50);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
