// Reading and writing the install-global JSON files — `config.json`,
// `grants.json`, each space's layout, the job list and upload ids — under the
// one rule that keeps them from destroying themselves. See
// docs/architecture.md's Space identity and state ownership section.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { withFileLock } from "./fileLock.ts";

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
 * The bytes reach the disk before the rename, so a power cut just after it
 * leaves the old file or the new one, never an empty one.
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
    const fd = openSync(tempPath, "w", options.mode);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Runs `run` holding the OS lock beside `filePath`, which other processes
 * wait on, for a read-modify-write two processes must never do at once. The
 * OS frees it the moment its holder exits or dies, so none waits on a crashed
 * one. */
export async function withHostStateLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(path.dirname(filePath), `.${path.basename(filePath)}.lock`), run);
}
