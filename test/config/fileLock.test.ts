import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockBusyError, withFileLock } from "../../src/config/fileLock.ts";
import { holdLockInAnotherProcess, releaseLockHolders } from "../support/lockHolder.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-filelock-"));
  lockPath = path.join(dir, "locks", "slot.lock");
});

afterEach(async () => {
  await releaseLockHolders();
  rmSync(dir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("withFileLock", () => {
  it("runs one holder at a time within a process, in order", async () => {
    const order: string[] = [];
    const firstMayFinish = deferred();
    const first = withFileLock(lockPath, async () => {
      order.push("first start");
      await firstMayFinish.promise;
      order.push("first end");
    });
    const second = withFileLock(lockPath, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first start"]);
    firstMayFinish.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("lets different locks run at the same time", async () => {
    const otherPath = path.join(dir, "locks", "other.lock");
    const firstMayFinish = deferred();
    const first = withFileLock(lockPath, () => firstMayFinish.promise);
    const value = await withFileLock(otherPath, async () => "other ran");
    expect(value).toBe("other ran");
    firstMayFinish.resolve();
    await first;
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    await expect(withFileLock(lockPath, async () => "next")).resolves.toBe("next");
  });

  it("keeps the lock file owner-only and in an owner-only folder", async () => {
    await withFileLock(lockPath, async () => {});
    if (process.platform === "win32") return;
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(lockPath)).mode & 0o777).toBe(0o700);
  });

  it("gives up with LockBusyError while another process holds the lock", async () => {
    await holdLockInAnotherProcess(lockPath);
    const started = Date.now();
    await expect(withFileLock(lockPath, async () => "ran", { waitMs: 150 })).rejects.toBeInstanceOf(LockBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("takes the lock as soon as the other process dies, however long it held it", async () => {
    const holder = await holdLockInAnotherProcess(lockPath);
    const waiting = withFileLock(lockPath, async () => "ran", { waitMs: 5_000 });
    setTimeout(() => holder.kill(), 200);
    await expect(waiting).resolves.toBe("ran");
  });

  it("stops waiting when its signal aborts", async () => {
    await holdLockInAnotherProcess(lockPath);
    const abort = new AbortController();
    const waiting = withFileLock(lockPath, async () => "ran", { waitMs: 5_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops a caller queued behind a holder in this process at its deadline, and keeps the order", async () => {
    const order: string[] = [];
    const firstMayFinish = deferred();
    const first = withFileLock(lockPath, async () => {
      await firstMayFinish.promise;
      order.push("first");
    });
    const impatient = withFileLock(lockPath, async () => order.push("impatient"), { waitMs: 50 });
    const third = withFileLock(lockPath, async () => {
      order.push("third");
    });
    await expect(impatient).rejects.toBeInstanceOf(LockBusyError);
    firstMayFinish.resolve();
    await Promise.all([first, third]);
    expect(order).toEqual(["first", "third"]);
  });
});
