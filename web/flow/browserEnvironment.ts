// The browser's backing for a flow executor's environment seam
// (src/protocol/flowExecutors.ts). The executors are isomorphic; these are
// the things they cannot be: HTTP to the sandbox routes, an image decoder,
// and the space's scopes. A headless runner supplies its own instead.
import type {
  GenerateImageRequestBody,
  GenerateImageResponse,
  GenerateVideoRequestBody,
  GenerateVideoResponse,
  JobView,
  SandboxKind,
} from "../../src/protocol/api.ts";
import { readClock } from "../../src/protocol/datePlaceholders.ts";
import {
  describeContextSent,
  type NodeExecutionContext,
  type SandboxPort,
  type TextGeneration,
} from "../../src/protocol/flowExecutors.ts";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";
import {
  fetchFileRaw,
  sandboxAddRow,
  sandboxAddToNote,
  sandboxGenerate,
  sandboxGenerateImage,
  sandboxGenerateOptions,
  sandboxGenerateVideo,
  sandboxRead,
  sandboxWrite,
} from "../core/apiClient.ts";
import { noteUnlistedWrites, scopesOf } from "../core/spaceTree.ts";
import { bytesToBase64 } from "../lib/base64.ts";
import type { LlmCallOutcome } from "../services/modelConsole.ts";
import { jobsFeed } from "./jobsFeed.ts";

// What a write leaves is in the space's listing only after its next read,
// and a Table or Class drawn before then must not call a generated picture
// gone.
const noted =
  <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    const result = await write(...args);
    noteUnlistedWrites();
    return result;
  };

// The route answers once the job is recorded, and the run waits on the job
// through the window's jobs feed, never holding a request for a result's
// minutes: a browser keeps only a few connections to one host open at once.
//
// The start is never aborted with the run: the job may be paid for by the
// time the host answers, and its id is what lets a cancelled run cancel it.
async function generateVideo(
  kind: SandboxKind,
  path: string,
  body: GenerateVideoRequestBody,
  signal?: AbortSignal,
  jobStarting?: JobStarting,
): Promise<GenerateVideoResponse> {
  const started = await answered(sandboxGenerateVideo(kind, path, body), jobStarting?.());
  if (!("job" in started)) return started;
  const job = await savedJob(path, started.job, signal, "clip", body.folder);
  return {
    path: job.result,
    model: job.model,
    reused: false,
    resumed: started.resumed,
    warnings: job.warnings ?? [],
    ...(!started.resumed && job.notes?.length ? { notes: job.notes } : {}),
    ...(!started.resumed && job.quote ? { quote: job.quote } : {}),
  };
}

// An image a provider makes within the request comes back in it; one it
// makes as a job is waited on as a clip is, then read from where it saved.
async function generateImage(
  kind: SandboxKind,
  path: string,
  body: GenerateImageRequestBody,
  signal?: AbortSignal,
  jobStarting?: JobStarting,
): Promise<GenerateImageResponse> {
  const started = await answered(sandboxGenerateImage(kind, path, body), jobStarting?.());
  if (!("job" in started)) return started;
  const job = await savedJob(path, started.job, signal, "image", body.folder);
  const file = await fetchFileRaw(job.file ?? job.result);
  if (!file.ok) throw new Error(`The image was saved, but couldn't be read: ${file.status} ${file.statusText}`);
  return {
    image: {
      mediaType: file.headers.get("content-type") ?? "application/octet-stream",
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    },
    path: job.result,
    model: job.model,
    reused: false,
    warnings: job.warnings ?? [],
    ...(!started.resumed && job.notes?.length ? { notes: job.notes } : {}),
    ...(!started.resumed && job.quote ? { cost: job.quote } : {}),
  };
}

// A run's job once it saved its result. A stopped wait says the host still
// saves it, as it does.
async function savedJob(
  path: string,
  id: string,
  signal: AbortSignal | undefined,
  noun: "clip" | "image",
  folder: string,
): Promise<JobView & { result: string }> {
  let job: JobView;
  try {
    job = await jobsFeed().wait(path, id, signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    const reason = signal.reason instanceof Error ? signal.reason.message : "the run stopped";
    throw new Error(
      `Stopped waiting for the ${noun}: ${reason}. It is still being made, and Pragma saves it into ${folder.replace(/\/+$/, "")}/ when it's done.`,
    );
  }
  if (job.stage !== "saved" || job.result === undefined) {
    throw new Error(job.error ?? `The job ended without ${noun === "clip" ? "a clip" : "an image"}.`);
  }
  return { ...job, result: job.result };
}

/** Called as a paid job's start is sent; the function it returns hears the
 * job's id once the host has recorded it, or nothing when no job started. */
export type JobStarting = () => (job?: string) => void;

async function answered<T>(start: Promise<T>, started: ((job?: string) => void) | undefined): Promise<T> {
  let answer: T | undefined;
  try {
    answer = await start;
    return answer;
  } finally {
    const job = (answer as { job?: unknown } | undefined)?.job;
    started?.(typeof job === "string" ? job : undefined);
  }
}

const browserSandbox: SandboxPort = {
  read: sandboxRead,
  write: noted(sandboxWrite),
  addRow: noted(sandboxAddRow),
  addToNote: sandboxAddToNote,
  generate: sandboxGenerate,
  generateOptions: sandboxGenerateOptions,
  generateImage: noted(generateImage),
  generateVideo: noted(generateVideo),
};

/** Where a run records each text generation, by the node that made it: the
 * Console entry, written as every Flow's is, and what the model couldn't
 * have as context, for the surface the run reports on. */
export interface GenerationRecord {
  log(nodeId: string, outcome: LlmCallOutcome): void;
  warned(nodeId: string, warnings: readonly string[]): void;
}

// What went as context is the Console's to show, whichever surface started
// the run; only a warning stays on the surface itself.
function recordGeneration(record: GenerationRecord, nodeId: string, generation: TextGeneration): void {
  if (generation.failed) {
    const { error } = generation;
    const message = error instanceof Error ? error.message : "Request failed.";
    record.log(nodeId, { failed: true, message, need: setupNeedOf(error) });
    return;
  }
  const { result } = generation;
  const options = "reply" in result ? [result.reply] : result.options;
  const context = result.context && describeContextSent(result.context);
  const effort = result.effort ? { effort: result.effort } : {};
  const warnings = (result.context?.messages ?? []).filter((message) => message.level === "warn");
  const said = { ...(context ? { context } : {}), ...(warnings.length ? { warn: true } : {}) };
  record.log(nodeId, { failed: false, model: result.model, ...effort, options, ...said });
  if (warnings.length) {
    record.warned(
      nodeId,
      warnings.map((message) => message.text),
    );
  }
}

/** A run's context, with the environment half filled in. The caller supplies
 * only what is specific to *this* flow and *this* canvas; everything an
 * executor needs from the browser itself comes from here, so the canvas never
 * restates it. */
export function createFlowContext(
  flow: Omit<NodeExecutionContext, "sandbox" | "decodeImageDimensions" | "scopes" | "clock" | "generated"> & {
    jobStarting?: JobStarting;
    generations: GenerationRecord;
  },
): NodeExecutionContext {
  const { jobStarting, generations, ...context } = flow;
  return {
    ...context,
    generated: (nodeId, generation) => recordGeneration(generations, nodeId, generation),
    sandbox: jobStarting
      ? {
          ...browserSandbox,
          generateImage: noted((kind, path, body, signal) => generateImage(kind, path, body, signal, jobStarting)),
          generateVideo: noted((kind, path, body, signal) => generateVideo(kind, path, body, signal, jobStarting)),
        }
      : browserSandbox,
    decodeImageDimensions,
    scopes: async () => scopesOf(flow.flowPath),
    clock: readClock(new Date()),
  };
}

// Reads the pixel dimensions out of the image bytes themselves, the same way
// the canvas's own dropzone preview does, rather than trusting OS or space
// file metadata that either source could lack or lie about.
export function decodeImageDimensions(mediaType: string, data: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not read the image's dimensions"));
    img.src = `data:${mediaType};base64,${data}`;
  });
}
