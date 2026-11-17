// The open document's paid jobs, for its Tools tab and the runs waiting on
// them: what is still going, and what ended since a window last showed it.
// Polled while a job is going, as the Console's feed is, since pragma has no
// server-to-browser channel. A poll names the jobs a run there waits on; a
// window says which ended jobs it showed or a run there took.
import type { Hono } from "hono";
import { findSpaceId, loadGlobalConfig, type PragmaGlobalConfig } from "../../config/loadConfig.ts";
import type { JobCancelRequestBody, JobsResponse, JobsShownRequestBody, JobView } from "../../protocol/api.ts";
import { jobRunner } from "../jobRunner.ts";
import { type JobRecord, jobStore } from "../jobs.ts";
import type { Incoming, RouteContext } from "./shared.ts";

// Long enough for any window still waiting on a job to poll it again.
const OWED_MS = 10 * 60_000;

// The name Settings lists the job's server under, from its model's ref: a
// video model only ever comes from an MCP server.
function providerOf(job: JobRecord, config: PragmaGlobalConfig): string | undefined {
  const id = job.model.slice(0, job.model.indexOf("/"));
  const server = config.mcpServers?.find((each) => each.id === id);
  return server && (server.label ?? server.id);
}

function viewOf(job: JobRecord, config: PragmaGlobalConfig): JobView {
  const provider = providerOf(job, config);
  return {
    id: job.id,
    kind: job.kind,
    stage: job.stage,
    model: job.model,
    ...(provider !== undefined ? { provider } : {}),
    summary: job.summary,
    folder: job.folderName,
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.provider?.quote ? { quote: job.provider.quote } : {}),
    ...(job.file !== undefined
      ? { file: job.folder ? `${job.folder}/${job.file}` : job.file, result: `${job.folderName}/${job.file}` }
      : {}),
    ...(job.provider?.warnings.length ? { warnings: job.provider.warnings } : {}),
    ...(job.provider?.notes.length ? { notes: job.provider.notes } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.problem !== undefined ? { problem: job.problem } : {}),
    ...(job.delivered ? { delivered: true } : {}),
    ...(job.interrupted ? { interrupted: true } : {}),
  };
}

export function mountJobRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  const spaceJobs = async () => {
    const spaceId = findSpaceId(loadGlobalConfig(), spaceRoot);
    return spaceId === undefined ? [] : (await jobStore().list()).filter((job) => job.spaceId === spaceId);
  };
  // A cancelled job a window has listed stays a record of its spend, and is
  // never listed again.
  const listed = (job: JobRecord) => !(job.stage === "cancelled" && job.shown);

  app.all("/api/jobs", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    const document = c.req.query("path") ?? "";
    const waiting = new Set((c.req.query("waiting") ?? "").split(",").filter(Boolean));
    const ofDocument = (await spaceJobs()).filter((job) => job.document === document);
    await jobRunner().watched(ofDocument.filter((job) => waiting.has(job.id)).map((job) => job.id));
    const jobs = (await spaceJobs())
      .filter((job) => job.document === document && listed(job))
      .sort((a, b) => b.startedAt - a.startedAt);
    const config = loadGlobalConfig();
    return c.json<JobsResponse>({ jobs: jobs.map((job) => viewOf(job, config)) });
  });

  app.all("/api/jobs/cancel", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    const { id } = (await c.req.json()) as Incoming<JobCancelRequestBody>;
    if (typeof id !== "string") return c.text("id must be a string", 400);
    if (!(await spaceJobs()).some((job) => job.id === id)) return c.text("No such job in this space", 404);
    await jobRunner().cancel(id);
    return c.body(null, 204);
  });

  app.all("/api/jobs/shown", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    const { ids, taken } = (await c.req.json()) as Incoming<JobsShownRequestBody>;
    if (!Array.isArray(ids) || (taken !== undefined && !Array.isArray(taken))) {
      return c.text("ids and taken must be lists", 400);
    }
    const strings = (list: unknown[]) => new Set(list.filter((id): id is string => typeof id === "string"));
    const shown = strings(ids);
    const took = strings(taken ?? []);
    const store = jobStore();
    // An outcome a window's waiting run is owed stays until that run took it,
    // so another window showing it first can't take it from the run; past a
    // while, that window is gone.
    for (const job of await spaceJobs()) {
      if (job.stage === "cancelled") {
        if (shown.has(job.id) || took.has(job.id)) await store.update(job.id, (stored) => ({ ...stored, shown: true }));
        continue;
      }
      if (job.stage !== "saved" && job.stage !== "failed") continue;
      const owed = job.owed && Date.now() - (job.endedAt ?? 0) < OWED_MS;
      if (took.has(job.id) || (shown.has(job.id) && !owed)) await store.remove(job.id);
    }
    return c.body(null, 204);
  });
}
