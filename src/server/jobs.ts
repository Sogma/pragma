// The async jobs a host started at a provider, kept as host state until each
// result is saved and shown (docs/architecture.md, Space identity and state
// ownership). One file per job, named by the job's own id, so two processes
// sharing the config directory never rewrite each other's records.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { withHostStateLock, writeHostStateFile } from "../config/hostStateFile.ts";
import { globalJobsDir } from "../config/loadConfig.ts";
import type { GenerationCost, JobSettings } from "../protocol/api.ts";
import { isHiddenName } from "../protocol/entryName.ts";
import type { VideoOperation } from "../protocol/videoGeneration.ts";

// One list, which reading a record checks too: a stage missing there reads
// as no record at all.
const JOB_STAGES = ["starting", "running", "saved", "failed", "cancelled"] as const;
export type JobStage = (typeof JOB_STAGES)[number];
export type JobKind = "video" | "image";

/** One async job, shaped as a row: flat fields, and what the provider said
 * in one nested field. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  // The full digest of the job's inputs, and the take of them it makes: a
  // run asking for the same inputs and take joins this job instead of paying
  // for another.
  digest: string;
  take: number;
  spaceId: string;
  // The document whose run started it, by its grant key, and the id that
  // run sent with the start.
  document: string;
  startId?: string;
  // Where the result goes, as a rooted path resolved in the space at save
  // time, and the folder as the node names it, for messages.
  folder: string;
  folderName: string;
  // How the result's name begins: the prefix with its dates filled, and the
  // prefix as typed, placeholders and all, "" when blank
  // (generatedResults.ts's ResultStart).
  stem: string;
  prefix: string;
  model: string;
  // The prompt, cut short, for the lists that show the job.
  summary: string;
  // What the job makes: the settings sent, until its start says how the
  // provider took them.
  settings?: JobSettings;
  stage: JobStage;
  startedAt: number;
  endedAt?: number;
  provider?: { operation: VideoOperation; warnings: string[]; notes: string[]; quote?: GenerationCost };
  // The saved result's file name, or why the job ended without one.
  file?: string;
  error?: string;
  // While a run in a window waits on the job: renewed by that window's polls.
  watchedUntil?: number;
  // An ended job whose outcome a waiting run had, and one whose outcome a
  // window's waiting run has yet to take.
  delivered?: boolean;
  owed?: boolean;
  // A start the host closed in the middle of, which may have been charged.
  interrupted?: boolean;
  // A cancelled job a window has listed, kept only as a record of its spend.
  shown?: boolean;
  // What keeps a live job from finishing, worth telling the person.
  problem?: string;
}

/** Where jobs are kept. A host with other storage installs its own before
 * any job starts. */
export interface JobStore {
  list(): Promise<JobRecord[]>;
  get(id: string): Promise<JobRecord | undefined>;
  add(job: JobRecord): Promise<void>;
  /** Applies `change` to the job as it is stored now, as one step. */
  update(id: string, change: (job: JobRecord) => JobRecord): Promise<JobRecord | undefined>;
  remove(id: string): Promise<void>;
}

let installed: JobStore | undefined;

export function installJobStore(store: JobStore): void {
  installed = store;
}

export function jobStore(): JobStore {
  installed ??= createFileJobStore();
  return installed;
}

function isJobRecord(value: unknown): value is JobRecord {
  const job = value as Partial<JobRecord> | null;
  return (
    typeof job?.id === "string" &&
    (job.kind === "video" || job.kind === "image") &&
    typeof job.digest === "string" &&
    typeof job.take === "number" &&
    typeof job.spaceId === "string" &&
    typeof job.document === "string" &&
    typeof job.folder === "string" &&
    typeof job.stem === "string" &&
    typeof job.model === "string" &&
    typeof job.startedAt === "number" &&
    (JOB_STAGES as readonly string[]).includes(job.stage ?? "")
  );
}

export function createFileJobStore(dir = globalJobsDir()): JobStore {
  const fileOf = (id: string) => path.join(dir, `${encodeURIComponent(id)}.json`);
  const read = async (file: string): Promise<JobRecord | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return isJobRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async list() {
      const names = await readdir(dir).catch((): string[] => []);
      const jobs = await Promise.all(
        names.filter((name) => name.endsWith(".json") && !isHiddenName(name)).map((name) => read(path.join(dir, name))),
      );
      return jobs.filter((job): job is JobRecord => job !== undefined);
    },
    get: (id) => read(fileOf(id)),
    async add(job) {
      writeHostStateFile(fileOf(job.id), job);
    },
    // Locked across processes: a host collecting a job and a run that
    // joined it may both write its stage.
    update: (id, change) =>
      withHostStateLock(fileOf(id), async () => {
        const job = await read(fileOf(id));
        if (!job) return undefined;
        const next = change(job);
        writeHostStateFile(fileOf(id), next);
        return next;
      }),
    async remove(id) {
      await rm(fileOf(id), { force: true });
    },
  };
}
