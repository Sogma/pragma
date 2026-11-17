// The host's half of a paid job: it waits on every recorded job and saves
// the result whether or not a run still waits, unless the person cancels the
// job, and a host's startup picks up the unfinished ones (docs/architecture.md,
// Space identity and state ownership).
//
// A run asking for the same inputs joins a job's wait, and stopping ends only
// that run's own. Nothing here starts or resubmits a job on its own.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadGlobalConfig } from "../config/loadConfig.ts";
import { checkVideoJob, type VideoData, type VideoJob, type VideoOperation } from "../protocol/videoGeneration.ts";
import { fetchPublicToFile } from "./fetchPublic.ts";
import { findResult, IMAGE_EXTENSIONS_BY_TYPE, VIDEO_EXTENSIONS_BY_TYPE } from "./generatedResults.ts";
import { type JobRecord, type JobStore, jobStore } from "./jobs.ts";
import {
  type ResolvedImageModel,
  type ResolvedVideoModel,
  resolveImageModel,
  resolveVideoModel,
} from "./mediaModels.ts";
import { resolveHeldPath } from "./rootedFiles.ts";
import { withFileLock, writeFileAtomic } from "./spaceFiles.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Long past any job's end: by then the provider has likely let the result
// go, so the job is given up on.
const KEEP_MS = 7 * 24 * HOUR;

// A start this recent may still be under way in another process, so a
// host's startup leaves it alone rather than calling it interrupted.
const START_GRACE_MS = 5 * MINUTE;

// A check failing this long is told once; a network that drops for a moment
// comes back on its own.
const FAILING_NOTICE_MS = 10 * MINUTE;

// How long a window's word that a run there waits on a job holds: its polls
// renew it every few seconds, so a closed window's lapses soon after.
const WATCH_MS = 30_000;

// A result that can't be saved is tried again after each of these, then left
// for the next startup.
const SAVE_RETRIES_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE];

// What each kind of result is: its name in messages, the type each
// extension is taken for, and the most a download may be. A long 4K clip
// runs to a few hundred MB, a 4K PNG to tens; the download streams into its
// file, so it is never held whole.
const KINDS = {
  video: { noun: "clip", extensions: VIDEO_EXTENSIONS_BY_TYPE, fallback: "mp4", maxBytes: 1024 * 1024 * 1024 },
  image: { noun: "image", extensions: IMAGE_EXTENSIONS_BY_TYPE, fallback: "png", maxBytes: 100 * 1024 * 1024 },
} as const;

// What one check of a job found, whatever its kind.
type JobCheck = { status: "running" } | { status: "completed"; file: VideoData } | { status: "failed"; error: string };

/** How long to wait before checking a job this old again: the provider's
 * pace while the job is young or a run waits on it, less often after. An
 * adapter whose check already waits on the provider answers within it. */
export function checkPause(ageMs: number, waited: boolean): number {
  if (waited || ageMs < 10 * MINUTE) return 10_000;
  if (ageMs < HOUR) return MINUTE;
  return 5 * MINUTE;
}

/** How a job ended: the saved result's file name, or why there is none. */
export type JobOutcome = { file: string; error?: undefined } | { error: string; file?: undefined };

/** What a run names when it starts a job; the runner adds the rest. */
export type NewJob = Omit<JobRecord, "id" | "stage" | "startedAt">;

/** A result that is made but couldn't be saved yet: a run waiting on it
 * hears so, and the runner tries again. */
export class UnsavedResult extends Error {}

const cancelledText = (job: JobRecord) => `This job was cancelled, so its ${KINDS[job.kind].noun} is never saved.`;

export interface JobRunner {
  /** The model a run's ref resolves to, on this runner's providers. */
  model(ref: string | undefined): ResolvedVideoModel;
  /** The job not yet ended for these inputs, if any. */
  live(digest: string): Promise<JobRecord | undefined>;
  /** Records a job as starting, starts it with `call`, and records it
   * running. A start already going for the same inputs is joined. A start
   * that throws leaves nothing recorded. */
  begin(job: NewJob, call: () => Promise<VideoJob>): Promise<{ job: JobRecord; joined: boolean }>;
  /** Makes sure this host waits on a recorded job, with no caller waiting. */
  follow(job: JobRecord): void;
  /** Waits on a recorded job until it ends, joining the wait already going.
   * `signal` ends only this caller's wait. */
  collect(job: JobRecord, signal?: AbortSignal): Promise<JobOutcome>;
  /** A run in a window waits on these jobs, so an outcome reached meanwhile
   * is delivered, and each is checked at the provider's pace. */
  watched(ids: readonly string[]): Promise<void>;
  /** Cancels a job not yet ended: its result is never downloaded, and whoever
   * waits on it hears so. Resolves with the job as recorded, if it is. */
  cancel(id: string): Promise<JobRecord | undefined>;
  /** Picks up every unfinished job, at a host's startup. */
  resume(): Promise<void>;
}

export interface JobRunnerDeps {
  store(): JobStore;
  resolve(ref: string | undefined): ResolvedVideoModel;
  resolveImage(ref: string | undefined): ResolvedImageModel;
  sleep(ms: number): Promise<void>;
  now(): number;
  spaceRoot(spaceId: string): string | undefined;
}

interface Waiter {
  resolve(outcome: JobOutcome): void;
  reject(error: unknown): void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A job's model that can't be resolved now: its provider removed, signed
// out, or no longer making that kind as jobs.
class Unresolved extends Error {}

function resolving<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    throw new Unresolved(errorText(error));
  }
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const starting = new Map<string, Promise<JobRecord>>();
  const following = new Map<string, Set<Waiter>>();

  async function setProblem(job: JobRecord, problem: string | undefined): Promise<JobRecord> {
    if (job.problem === problem) return job;
    return (await deps.store().update(job.id, (stored) => ({ ...stored, problem }))) ?? { ...job, problem };
  }

  function cancelled(waiters: Set<Waiter>, job: JobRecord): void {
    for (const waiter of waiters) waiter.reject(new Error(job.error ?? cancelledText(job)));
    waiters.clear();
  }

  // A job cancelled meanwhile stays cancelled, and `written`, the file this
  // loop wrote for it, goes: a cancelled job's clip is never kept.
  async function finish(job: JobRecord, waiters: Set<Waiter>, outcome: JobOutcome, written?: string): Promise<void> {
    const ended =
      outcome.file !== undefined
        ? { stage: "saved" as const, file: outcome.file }
        : { stage: "failed" as const, error: outcome.error };
    const stored = await deps.store().update(job.id, (current) =>
      current.stage === "cancelled"
        ? current
        : {
            ...current,
            ...ended,
            endedAt: deps.now(),
            delivered: waiters.size > 0 || (current.watchedUntil ?? 0) > deps.now(),
            owed: (current.watchedUntil ?? 0) > deps.now(),
            problem: undefined,
          },
    );
    if (stored?.stage === "cancelled") {
      if (written !== undefined) await rm(written, { force: true });
      return cancelled(waiters, stored);
    }
    for (const waiter of waiters) waiter.resolve(outcome);
    waiters.clear();
  }

  // The saved file's name, and its path when this call wrote it.
  async function save(job: JobRecord, result: VideoData): Promise<{ file: string; written?: string }> {
    const kind = KINDS[job.kind];
    const spaceRoot = deps.spaceRoot(job.spaceId);
    if (spaceRoot === undefined) throw new Error("Its space is no longer registered here.");
    const { filePath: folderPath } = resolveHeldPath(spaceRoot, job.folder, "write");
    if (!(await stat(folderPath).catch(() => undefined))?.isDirectory()) {
      throw new Error(`${job.folderName}/ is gone. Put it back and the ${kind.noun} is saved at the next check.`);
    }
    const digest = job.digest.slice(0, 12);
    return withFileLock(path.join(folderPath, job.stem), async () => {
      // Another process, or a run with a new prefix, may have saved it.
      const existing = await findResult(folderPath, job.stem, digest, job.prefix);
      if (existing) {
        if (existing.kept === existing.found) return { file: existing.kept };
        const copy = path.join(folderPath, existing.kept);
        await writeFileAtomic(copy, createReadStream(path.join(folderPath, existing.found)));
        return { file: existing.kept, written: copy };
      }
      const nameFor = (mediaType: string) =>
        path.join(
          folderPath,
          `${job.stem}.${kind.extensions[mediaType] ?? kind.extensions[result.mediaType] ?? kind.fallback}`,
        );
      if (result.type === "url") {
        const fetched = await fetchPublicToFile(result.url, { maxBytes: kind.maxBytes }, nameFor);
        return { file: path.basename(fetched), written: fetched };
      }
      const filePath = nameFor(result.mediaType);
      await writeFileAtomic(filePath, result.type === "base64" ? Buffer.from(result.data, "base64") : result.data);
      return { file: path.basename(filePath), written: filePath };
    });
  }

  // Asks once how a job is doing, on the model its kind resolves to. A
  // model that can't be resolved throws `unresolved`, told at once.
  async function checkJob(job: JobRecord, operation: VideoOperation): Promise<JobCheck> {
    if (job.kind === "image") {
      const jobs = resolving(() => deps.resolveImage(job.model)).jobs;
      if (!jobs) throw new Unresolved(`${job.model} no longer makes its images as jobs.`);
      const check = await jobs.check(operation);
      return check.status === "completed" ? { status: "completed", file: check.image } : check;
    }
    const check = await checkVideoJob(resolving(() => deps.resolve(job.model)).model, operation);
    return check.status === "completed" ? { status: "completed", file: check.video } : check;
  }

  // One loop per job, whoever waits on it, reading the job afresh each round
  // for a window's word that a run waits. A failure to ask the provider keeps
  // the job and tries again, further apart each time.
  async function follow(start: JobRecord, waiters: Set<Waiter>): Promise<void> {
    let job = start;
    let failures = 0;
    let failingSince: number | undefined;
    let saveTries = 0;
    for (;;) {
      const stored = await deps.store().get(job.id);
      if (stored === undefined) {
        for (const waiter of waiters) waiter.reject(new Error("This job is no longer recorded."));
        waiters.clear();
        return;
      }
      job = stored;
      if (job.stage === "cancelled") return cancelled(waiters, job);
      const age = deps.now() - job.startedAt;
      const waited = waiters.size > 0 || (job.watchedUntil ?? 0) > deps.now();
      const noun = KINDS[job.kind].noun;
      if (age > KEEP_MS) {
        return finish(job, waiters, { error: `Pragma gave up on this ${noun} a week after it started.` });
      }
      const operation = job.provider?.operation;
      if (operation === undefined) return finish(job, waiters, { error: "This job names no job at its provider." });
      let check: JobCheck;
      try {
        try {
          check = await checkJob(job, operation);
        } catch (error) {
          // A provider removed or signed out needs the person, so it is told at once.
          if (error instanceof Unresolved) {
            job = await setProblem(job, `${error.message} The ${noun} waits there and is saved once that is fixed.`);
          }
          throw error;
        }
        failures = 0;
        failingSince = undefined;
      } catch (error) {
        failures++;
        failingSince ??= deps.now();
        if (deps.now() - failingSince >= FAILING_NOTICE_MS && job.problem === undefined) {
          job = await setProblem(job, `Can't reach the provider: ${errorText(error)} Checking again.`);
        }
        const backoff = Math.min(5 * MINUTE, 10_000 * 2 ** (failures - 1));
        await deps.sleep(Math.max(checkPause(age, waited), backoff));
        continue;
      }
      if (check.status === "failed") return finish(job, waiters, { error: check.error });
      if (check.status === "running") {
        job = await setProblem(job, undefined);
        await deps.sleep(checkPause(age, waited));
        continue;
      }
      // A cancel that landed while the provider finished: nothing is downloaded.
      if ((await deps.store().get(job.id))?.stage === "cancelled") continue;
      try {
        const { file, written } = await save(job, check.file);
        return finish(job, waiters, { file }, written);
      } catch (error) {
        const message = `${errorText(error)} The ${noun} is made, and Pragma tries saving it again.`;
        job = await setProblem(job, message);
        for (const waiter of waiters) waiter.reject(new UnsavedResult(message));
        waiters.clear();
        if (saveTries >= SAVE_RETRIES_MS.length) return;
        await deps.sleep(SAVE_RETRIES_MS[saveTries++]);
      }
    }
  }

  // The job's one loop, started if none is going. Following a job is not
  // waiting on it: only a run that waits makes its outcome delivered.
  function followed(job: JobRecord): Set<Waiter> {
    const going = following.get(job.id);
    if (going) return going;
    const waiters = new Set<Waiter>();
    following.set(job.id, waiters);
    void follow(job, waiters)
      .catch((error: unknown) => {
        for (const waiter of waiters) waiter.reject(error);
      })
      .finally(() => {
        if (following.get(job.id) === waiters) following.delete(job.id);
      });
    return waiters;
  }

  function collect(job: JobRecord, signal?: AbortSignal): Promise<JobOutcome> {
    return new Promise<JobOutcome>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const waiters = followed(job);
      const waiter: Waiter = { resolve, reject };
      waiters.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          waiters.delete(waiter);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  async function live(digest: string): Promise<JobRecord | undefined> {
    const ours = starting.get(digest);
    if (ours) return ours.catch(() => undefined);
    // A start under way in another process: wait for it to be recorded
    // running rather than pay for a second job.
    for (let waited = 0; ; waited += 1000) {
      const found = (await deps.store().list()).find(
        (job) => job.digest === digest && (job.stage === "running" || job.stage === "starting"),
      );
      if (!found || found.stage === "running") return found;
      if (deps.now() - found.startedAt > START_GRACE_MS || waited >= 2 * MINUTE) return undefined;
      await deps.sleep(1000);
    }
  }

  function begin(fields: NewJob, call: () => Promise<VideoJob>): Promise<{ job: JobRecord; joined: boolean }> {
    const going = starting.get(fields.digest);
    if (going) return going.then((job) => ({ job, joined: true }));
    const started = (async (): Promise<JobRecord> => {
      const job: JobRecord = { ...fields, id: randomUUID(), stage: "starting", startedAt: deps.now() };
      await deps.store().add(job);
      let begun: VideoJob;
      try {
        begun = await call();
      } catch (error) {
        await deps.store().remove(job.id);
        throw error;
      }
      const provider = { operation: begun.operation, warnings: begun.warnings, notes: begun.notes, quote: begun.quote };
      // Cancelled while it started, it stays cancelled, with what was quoted.
      const recorded = await deps
        .store()
        .update(job.id, (stored) =>
          stored.stage === "cancelled" ? { ...stored, provider } : { ...stored, stage: "running", provider },
        );
      if (recorded) return recorded;
      const running: JobRecord = { ...job, stage: "running", provider };
      await deps.store().add(running);
      return running;
    })();
    starting.set(fields.digest, started);
    const settled = () => {
      if (starting.get(fields.digest) === started) starting.delete(fields.digest);
    };
    started.then(settled, settled);
    return started.then((job) => ({ job, joined: false }));
  }

  async function watched(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await deps
        .store()
        .update(id, (stored) =>
          stored.stage === "starting" || stored.stage === "running"
            ? { ...stored, watchedUntil: deps.now() + WATCH_MS }
            : stored,
        );
    }
  }

  async function cancel(id: string): Promise<JobRecord | undefined> {
    const job = await deps
      .store()
      .update(id, (stored) =>
        stored.stage === "starting" || stored.stage === "running"
          ? { ...stored, stage: "cancelled", endedAt: deps.now(), error: cancelledText(stored), problem: undefined }
          : stored,
      );
    const waiters = following.get(id);
    if (job?.stage === "cancelled" && waiters) cancelled(waiters, job);
    return job;
  }

  async function resume(): Promise<void> {
    for (const job of await deps.store().list()) {
      const age = deps.now() - job.startedAt;
      if (job.stage === "starting") {
        if (age < START_GRACE_MS) continue;
        await deps.store().update(job.id, (stored) => ({
          ...stored,
          stage: "failed",
          interrupted: true,
          endedAt: deps.now(),
          error:
            "This job was starting when Pragma closed. It may have been charged, and Pragma has nothing to collect it with.",
        }));
      } else if (job.stage === "running") {
        followed(job);
      } else if (age > KEEP_MS) {
        await deps.store().remove(job.id);
      }
    }
  }

  return {
    model: deps.resolve,
    live,
    begin,
    follow: (job) => void followed(job),
    collect,
    watched,
    cancel,
    resume,
  };
}

let runner: JobRunner | undefined;

/** This process's runner, on the configured providers and the installed
 * store. */
export function jobRunner(): JobRunner {
  runner ??= createJobRunner({
    store: jobStore,
    resolve: (ref) => resolveVideoModel(ref),
    resolveImage: (ref) => resolveImageModel(ref),
    // Unreferenced, so a one-off run's process can end while a job it left
    // waits: the next host to start picks the job up.
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }),
    now: Date.now,
    spaceRoot: (spaceId) => loadGlobalConfig().spaces?.[spaceId]?.path,
  });
  return runner;
}

/** Picks up every job left unfinished, called once by a host that stays up:
 * the desktop app, `pragma start` and `pragma dev`. */
export function resumeJobs(): void {
  jobRunner()
    .resume()
    .catch((error: unknown) => console.error("Couldn't pick up unfinished jobs:", error));
}
