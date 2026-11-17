import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { withFileLock } from "../../src/config/fileLock.ts";

// Another process holding a lock: a real child, since the claim is about
// processes, not two callers in one.
const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { timeout: 0 });
db.exec("BEGIN EXCLUSIVE");
process.stdout.write("held\\n");
setInterval(() => {}, 1000);
`;

export interface LockHolder {
  /** Kills the holder, as a crash would; the OS frees its lock. */
  kill(): void;
  /** Kills the holder and waits until it has exited. */
  release(): Promise<void>;
}

const running: ChildProcess[] = [];

export async function holdLockInAnotherProcess(file: string): Promise<LockHolder> {
  // Makes the folder the child opens the file in.
  await withFileLock(file, async () => {});
  const child = spawn(process.execPath, ["-e", HOLDER, file], { stdio: ["ignore", "pipe", "inherit"] });
  running.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
  const release = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  return { kill: () => void child.kill("SIGKILL"), release };
}

/** Ends every holder still running, for an afterEach. */
export async function releaseLockHolders(): Promise<void> {
  for (const child of running.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}
