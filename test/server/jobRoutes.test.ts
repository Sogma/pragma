import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { JobsResponse } from "../../src/protocol/api.ts";
import { createFileJobStore, installJobStore, type JobRecord, type JobStore } from "../../src/server/jobs.ts";
import { createSpaceApiRoutes, type SpaceApp } from "../../src/server/routes.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

// /api/jobs: the open document's async jobs for its Tools tab, and the ended
// ones a window has shown, which the host then forgets.

let space: string;
let configDir: string;
let spaceId: string;
let store: JobStore;
let app: SpaceApp;

const job = (id: string, fields: Partial<JobRecord> = {}): JobRecord => ({
  id,
  kind: "video",
  digest: id.repeat(64).slice(0, 64),
  take: 1,
  spaceId,
  document: "v.flow.html",
  folder: "shots/clips",
  folderName: "clips",
  stem: "video-aaaaaaaaaaaa",
  prefix: "",
  model: "higgsfield/seedance_2_5",
  summary: "Steam rises from the red cup",
  stage: "running",
  startedAt: 1,
  provider: { operation: {}, warnings: [], notes: [], quote: { amount: 70, unit: "credits" } },
  ...fields,
});

beforeEach(() => {
  configDir = isolateConfig();
  space = tempSpace("pragma-job-routes-");
  spaceId = findSpaceId(loadGlobalConfig(), space) as string;
  store = createFileJobStore(path.join(configDir, "jobs"));
  installJobStore(store);
  app = createSpaceApiRoutes(space, undefined, { ownMachine: true });
});

afterEach(() => {
  installJobStore(createFileJobStore());
});

describe("/api/jobs", () => {
  it("lists the document's jobs in this space, newest first, as the Tools tab shows them", async () => {
    await store.add(job("a", { startedAt: 1 }));
    await store.add(
      job("b", {
        startedAt: 2,
        stage: "saved",
        file: "video-b.mp4",
        delivered: true,
        endedAt: 3,
        settings: { resolution: "720p", duration: 5 },
      }),
    );
    await store.add(job("c", { document: "other.flow.html" }));
    await store.add(job("d", { spaceId: "spc_elsewhere" }));
    const res = await app.request("/api/jobs?path=v.flow.html");
    const { jobs } = (await res.json()) as JobsResponse;
    expect(jobs.map((each) => each.id)).toEqual(["b", "a"]);
    expect(jobs[0]).toEqual({
      id: "b",
      kind: "video",
      stage: "saved",
      model: "higgsfield/seedance_2_5",
      summary: "Steam rises from the red cup",
      settings: { resolution: "720p", duration: 5 },
      folder: "clips",
      startedAt: 2,
      endedAt: 3,
      quote: { amount: 70, unit: "credits" },
      file: "shots/clips/video-b.mp4",
      result: "clips/video-b.mp4",
      delivered: true,
    });
  });

  it("hands back the id each job's start was sent with, when it had one", async () => {
    await store.add(job("a", { startId: "start-1", stage: "starting" }));
    await store.add(job("b", { startedAt: 2 }));
    const res = await app.request("/api/jobs?path=v.flow.html");
    const { jobs } = (await res.json()) as JobsResponse;
    expect(jobs.map((each) => [each.id, each.stage, each.startId])).toEqual([
      ["b", "running", undefined],
      ["a", "starting", "start-1"],
    ]);
  });

  it("renews the jobs a run in the window waits on, and only those still going", async () => {
    await store.add(job("waited"));
    await store.add(job("other"));
    await store.add(job("ended", { stage: "saved", file: "a.mp4" }));
    await app.request("/api/jobs?path=v.flow.html&waiting=waited,ended");
    expect((await store.get("waited"))?.watchedUntil).toBeGreaterThan(Date.now());
    expect((await store.get("other"))?.watchedUntil).toBeUndefined();
    expect((await store.get("ended"))?.watchedUntil).toBeUndefined();
  });

  it("forgets the ended jobs a window showed, keeping one owed to a waiting run until it is taken", async () => {
    const now = Date.now();
    await store.add(job("live"));
    await store.add(job("done", { stage: "failed", error: "nope", endedAt: now }));
    await store.add(job("owed", { stage: "saved", file: "a.mp4", owed: true, endedAt: now }));
    await store.add(job("long owed", { stage: "saved", file: "b.mp4", owed: true, endedAt: now - 11 * 60_000 }));
    await store.add(job("other", { stage: "saved", spaceId: "spc_elsewhere" }));
    const shown = (ids: string[], taken: string[] = []) =>
      app.request("/api/jobs/shown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, taken }),
      });
    expect((await shown(["live", "done", "owed", "long owed", "other"])).status).toBe(204);
    expect((await store.list()).map((each) => each.id).sort()).toEqual(["live", "other", "owed"]);
    await shown([], ["owed"]);
    expect((await store.list()).map((each) => each.id).sort()).toEqual(["live", "other"]);
  });

  it("names the job's server as Settings lists it", async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      mcpServers: [{ id: "higgsfield", label: "Higgsfield", url: "https://mcp.higgsfield.ai/mcp" }],
    });
    await store.add(job("a", { model: "higgsfield/seedance_2_5" }));
    const { jobs } = (await (await app.request("/api/jobs?path=v.flow.html")).json()) as JobsResponse;
    expect(jobs[0].provider).toBe("Higgsfield");
  });

  it("cancels a job of this space, lists it cancelled until a window shows it, then keeps it only as a record", async () => {
    await store.add(job("a"));
    await store.add(job("elsewhere", { spaceId: "spc_elsewhere" }));
    const cancel = (id: string) =>
      app.request("/api/jobs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    expect((await cancel("elsewhere")).status).toBe(404);
    expect((await store.get("elsewhere"))?.stage).toBe("running");
    expect((await cancel("a")).status).toBe(204);
    expect(await store.get("a")).toMatchObject({
      stage: "cancelled",
      error: "This job was cancelled, so its clip is never saved.",
    });

    const listed = async () =>
      ((await (await app.request("/api/jobs?path=v.flow.html")).json()) as JobsResponse).jobs.map((each) => each.stage);
    expect(await listed()).toEqual(["cancelled"]);
    await app.request("/api/jobs/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["a"] }),
    });
    expect(await listed()).toEqual([]);
    expect(await store.get("a")).toMatchObject({ stage: "cancelled", shown: true });
  });
});
