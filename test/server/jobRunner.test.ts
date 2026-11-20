import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockVideoModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { VideoJob, VideoStatusResult } from "../../src/protocol/videoGeneration.ts";
import { checkPause, createJobRunner, type JobRunner } from "../../src/server/jobRunner.ts";
import type { JobRecord, JobStore } from "../../src/server/jobs.ts";
import type { ResolvedVideoModel } from "../../src/server/mediaModels.ts";

// The host's half of a paid job: checking it on its own schedule, saving its
// clip with or without a run waiting, picking unfinished jobs up at startup,
// and keeping a job through what goes wrong. A clock the runner's sleeps move
// forward stands in for the hours a job can take.

const MINUTE = 60_000;
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const response = { timestamp: new Date(), modelId: "m", headers: undefined };

let space: string;
let records: Map<string, JobRecord>;
let clock: number;
let status: () => Promise<VideoStatusResult>;
let resolve: () => ResolvedVideoModel;
let runner: JobRunner;

const done = async (): Promise<VideoStatusResult> => ({
  status: "completed",
  videos: [{ type: "binary", data: MP4, mediaType: "video/mp4" }],
  warnings: [],
  response,
});

const model = (): ResolvedVideoModel => ({
  model: new MockVideoModelV4({
    doStart: async () => {
      throw new Error("a runner never starts a job");
    },
    doStatus: async () => status(),
  }),
  providerId: "test",
  modelId: "m",
});

const store: JobStore = {
  list: async () => [...records.values()],
  get: async (id) => records.get(id),
  add: async (job) => void records.set(job.id, job),
  update: async (id, change) => {
    const job = records.get(id);
    if (!job) return undefined;
    const next = change(job);
    records.set(id, next);
    return next;
  },
  remove: async (id) => void records.delete(id),
};

const job = (id: string, fields: Partial<JobRecord> = {}): JobRecord => ({
  id,
  kind: "video",
  digest: "b".repeat(64),
  spaceId: "spc_1",
  document: "v.flow.html",
  folder: "clips",
  folderName: "clips",
  stem: `video-${"b".repeat(12)}`,
  prefix: "",
  model: "test/m",
  summary: "Steam rises from the red cup",
  stage: "running",
  startedAt: clock - 3 * MINUTE,
  provider: { operation: { job: id }, warnings: [], notes: [] },
  ...fields,
});

const add = (record: JobRecord) => {
  records.set(record.id, record);
  return record;
};

beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-job-runner-"));
  mkdirSync(path.join(space, "clips"));
  records = new Map();
  clock = Date.UTC(2026, 10, 10, 12);
  status = done;
  resolve = model;
  runner = createJobRunner({
    store: () => store,
    resolve: () => resolve(),
    resolveImage: () => {
      throw new Error("no image models here");
    },
    sleep: async (ms) => {
      clock += ms;
      await new Promise((wake) => setTimeout(wake, 0));
    },
    now: () => clock,
    spaceRoot: (spaceId) => (spaceId === "spc_1" ? space : undefined),
  });
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe("checkPause", () => {
  it("checks at the provider's pace while a job is young or waited on, then less often", () => {
    expect(checkPause(0, false)).toBe(10_000);
    expect(checkPause(9 * MINUTE, false)).toBe(10_000);
    expect(checkPause(10 * MINUTE, false)).toBe(MINUTE);
    expect(checkPause(59 * MINUTE, false)).toBe(MINUTE);
    expect(checkPause(60 * MINUTE, false)).toBe(5 * MINUTE);
    expect(checkPause(120 * MINUTE, true)).toBe(10_000);
  });
});

describe("createJobRunner", () => {
  it("saves a clip with nobody waiting, and says a waiting run had it", async () => {
    add(job("alone"));
    await runner.resume();
    await vi.waitFor(() => expect(records.get("alone")?.stage).toBe("saved"));
    expect(records.get("alone")).toMatchObject({ delivered: false, owed: false, file: `video-${"b".repeat(12)}.mp4` });
    expect(readdirSync(path.join(space, "clips"))).toEqual([`video-${"b".repeat(12)}.mp4`]);

    add(job("waited", { digest: "c".repeat(64), stem: `video-${"c".repeat(12)}` }));
    expect(await runner.collect(job("waited", { digest: "c".repeat(64), stem: `video-${"c".repeat(12)}` }))).toEqual({
      file: `video-${"c".repeat(12)}.mp4`,
    });
    expect(records.get("waited")?.delivered).toBe(true);
  });

  it("counts an outcome delivered and owed while a window's run waits on it", async () => {
    add(job("watched"));
    await runner.watched(["watched"]);
    await runner.resume();
    await vi.waitFor(() => expect(records.get("watched")?.stage).toBe("saved"));
    expect(records.get("watched")).toMatchObject({ delivered: true, owed: true });
  });

  it("stops following a job no longer recorded, and tells a run waiting on it", async () => {
    status = async () => ({ status: "pending", response });
    add(job("dropped"));
    const waited = runner.collect(job("dropped"));
    records.delete("dropped");
    await expect(waited).rejects.toThrow("This job is no longer recorded.");
  });

  it("picks up a running job at startup, calls an old start interrupted, and drops a week-old outcome", async () => {
    add(job("running"));
    add(job("old start", { stage: "starting", startedAt: clock - 6 * MINUTE, provider: undefined }));
    add(job("new start", { stage: "starting", startedAt: clock - MINUTE, provider: undefined }));
    add(job("stale", { stage: "saved", startedAt: clock - 8 * 24 * 60 * MINUTE, file: "x.mp4" }));
    await runner.resume();
    expect(records.get("old start")).toMatchObject({
      stage: "failed",
      interrupted: true,
      error:
        "This job was starting when Pragma closed. It may have been charged, and Pragma has nothing to collect it with.",
    });
    expect(records.get("new start")?.stage).toBe("starting");
    expect(records.has("stale")).toBe(false);
    await vi.waitFor(() => expect(records.get("running")?.stage).toBe("saved"));
  });

  it("keeps a job through failed checks, and tells a failure only once it lasts", async () => {
    let failing = true;
    status = async () => {
      if (failing) throw new Error("fetch failed.");
      return done();
    };
    add(job("flaky"));
    runner.collect(job("flaky")).catch(() => undefined);
    await vi.waitFor(() =>
      expect(records.get("flaky")?.problem).toBe("Can't reach the provider: fetch failed. Checking again."),
    );
    expect(records.get("flaky")?.stage).toBe("running");
    failing = false;
    await vi.waitFor(() => expect(records.get("flaky")?.stage).toBe("saved"));
    expect(records.get("flaky")?.problem).toBeUndefined();
  });

  it("tells at once of a provider it can't reach any more, and saves the clip once it can", async () => {
    let gone = true;
    resolve = () => {
      if (gone) throw new Error('No provider named "test".');
      return model();
    };
    add(job("orphan"));
    runner.collect(job("orphan")).catch(() => undefined);
    await vi.waitFor(() =>
      expect(records.get("orphan")?.problem).toBe(
        'No provider named "test". The clip waits there and is saved once that is fixed.',
      ),
    );
    gone = false;
    await vi.waitFor(() => expect(records.get("orphan")?.stage).toBe("saved"));
  });

  it("tries again to save a clip whose folder is gone, and saves it once it is back", async () => {
    rmSync(path.join(space, "clips"), { recursive: true });
    add(job("homeless"));
    await expect(runner.collect(job("homeless"))).rejects.toThrow(
      "clips/ is gone. Put it back and the clip is saved at the next check. The clip is made, and Pragma tries saving it again.",
    );
    expect(records.get("homeless")?.stage).toBe("running");
    mkdirSync(path.join(space, "clips"));
    await vi.waitFor(() => expect(records.get("homeless")?.stage).toBe("saved"));
  });

  // docs/protocol.md's Symbolic links: a cloned or synced space can carry a
  // link under another prefix's name for the same inputs, pointing anywhere.
  it("saves its own clip rather than copying one through a link under another prefix", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "pragma-job-runner-outside-"));
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(path.join(outside, "secret.txt"), "SECRET");
    symlinkSync(path.join(outside, "secret.txt"), path.join(space, "clips", `video-${"b".repeat(12)}.mp4`));

    const poster = add(job("poster", { stem: `poster-${"b".repeat(12)}`, prefix: "poster" }));
    expect(await runner.collect(poster)).toEqual({ file: `poster-${"b".repeat(12)}.mp4` });
    expect([...readFileSync(path.join(space, "clips", `poster-${"b".repeat(12)}.mp4`))]).toEqual([...MP4]);
  });

  it("ends a job the provider ended, and gives up on one a week old", async () => {
    status = async () => ({ status: "error", error: 'Higgsfield\'s job ended as "nsfw".', response });
    add(job("refused"));
    expect(await runner.collect(job("refused"))).toEqual({ error: 'Higgsfield\'s job ended as "nsfw".' });
    expect(records.get("refused")).toMatchObject({ stage: "failed", delivered: true });

    status = async () => ({ status: "pending", response });
    add(job("ancient", { startedAt: clock - 8 * 24 * 60 * MINUTE }));
    expect(await runner.collect(job("ancient", { startedAt: clock - 8 * 24 * 60 * MINUTE }))).toEqual({
      error: "Pragma gave up on this clip a week after it started.",
    });
  });

  it("ends a job whose clip the provider sent to other storage, saving nothing", async () => {
    status = async () => ({
      status: "completed",
      videos: [{ type: "uploaded", mediaType: "video/mp4" }],
      warnings: [],
      response,
    });
    add(job("elsewhere"));
    expect(await runner.collect(job("elsewhere"))).toEqual({
      error: "The provider sent the clip to other storage instead of back to Pragma.",
    });
    expect(records.get("elsewhere")).toMatchObject({ stage: "failed" });
    expect(readdirSync(path.join(space, "clips"))).toEqual([]);
  });
});

describe("createJobRunner starting", () => {
  it("records the settings sent as a job starts, then what the provider says it makes, when it says", async () => {
    let answer: (begun: VideoJob) => void = () => {};
    const sent = { aspectRatio: "16:9", resolution: "4K", duration: 7 };
    const { id: _id, stage: _stage, startedAt: _startedAt, ...fields } = job("unused", { settings: sent });
    const started = runner.begin(fields, () => new Promise((resolve) => (answer = resolve)));
    await vi.waitFor(() => expect(records.size).toBe(1));
    const [id] = records.keys();
    expect(records.get(id)?.settings).toEqual(sent);
    const took = { aspectRatio: "16:9", resolution: "1080p", duration: 8 };
    answer({ operation: { job: "x" }, warnings: [], notes: [], settings: took });
    expect((await started).job.settings).toEqual(took);
    expect(records.get(id)?.settings).toEqual(took);

    const {
      id: _id2,
      stage: _stage2,
      startedAt: _startedAt2,
      ...other
    } = job("unused", {
      digest: "c".repeat(64),
      settings: { duration: 5 },
    });
    const quiet = await runner.begin(other, async () => ({ operation: { job: "y" }, warnings: [], notes: [] }));
    expect(quiet.job.settings).toEqual({ duration: 5 });
  });

  // A run hears its job's id only once the provider has taken the job, and
  // lists the job before then by its start's id.
  it("keeps the id the start was sent with on the job from the moment it is recorded", async () => {
    let answer: (begun: VideoJob) => void = () => {};
    const { id: _id, stage: _stage, startedAt: _startedAt, ...fields } = job("unused", { startId: "start-1" });
    const started = runner.begin(fields, () => new Promise((resolve) => (answer = resolve)));
    await vi.waitFor(() => expect(records.size).toBe(1));
    expect([...records.values()][0]).toMatchObject({ stage: "starting", startId: "start-1" });
    answer({ operation: { job: "x" }, warnings: [], notes: [] });
    expect((await started).job).toMatchObject({ stage: "running", startId: "start-1" });
  });
});

describe("createJobRunner cancelling", () => {
  const quoted = { operation: { job: "x" }, warnings: [], notes: [], quote: { amount: 70, unit: "credits" } };

  it("tells a run waiting on a cancelled job at once, keeps its record, and never saves its clip", async () => {
    let ready = false;
    status = async () => (ready ? done() : { status: "pending", response });
    add(job("given up", { provider: quoted }));
    const waited = runner.collect(job("given up"));
    expect(await runner.cancel("given up")).toMatchObject({
      stage: "cancelled",
      endedAt: clock,
      error: "This job was cancelled, so its clip is never saved.",
      provider: quoted,
    });
    await expect(waited).rejects.toThrow("This job was cancelled, so its clip is never saved.");
    ready = true;
    await runner.resume();
    await new Promise((wake) => setTimeout(wake, 20));
    expect(records.get("given up")?.stage).toBe("cancelled");
    expect(readdirSync(path.join(space, "clips"))).toEqual([]);
    expect(await runner.live(job("given up").digest)).toBeUndefined();
  });

  it("names what an image job makes when it is cancelled, and when its model can't be reached", async () => {
    add(job("picture", { kind: "image" }));
    expect((await runner.cancel("picture"))?.error).toBe("This job was cancelled, so its image is never saved.");

    add(job("orphaned picture", { kind: "image" }));
    runner.collect(job("orphaned picture", { kind: "image" })).catch(() => undefined);
    await vi.waitFor(() =>
      expect(records.get("orphaned picture")?.problem).toBe(
        "no image models here The image waits there and is saved once that is fixed.",
      ),
    );
  });

  it("leaves an ended job as it ended", async () => {
    add(job("kept", { stage: "saved", file: "a.mp4" }));
    expect((await runner.cancel("kept"))?.stage).toBe("saved");
    expect(await runner.cancel("missing")).toBeUndefined();
  });

  it("drops a clip that finished downloading as its job was cancelled", async () => {
    add(job("late"));
    const update = store.update;
    // The cancel lands between the download and the save being recorded.
    store.update = async (id, change) => {
      const current = records.get(id);
      if (current && change(current).stage === "saved") records.set(id, { ...current, stage: "cancelled" });
      return update(id, change);
    };
    try {
      await expect(runner.collect(job("late"))).rejects.toThrow("This job was cancelled, so its clip is never saved.");
    } finally {
      store.update = update;
    }
    expect(records.get("late")?.stage).toBe("cancelled");
    expect(readdirSync(path.join(space, "clips"))).toEqual([]);
  });

  it("keeps a job cancelled while it started cancelled, with what it was quoted", async () => {
    let answer: (begun: typeof quoted) => void = () => {};
    const { id: _id, stage: _stage, startedAt: _startedAt, ...fields } = job("unused");
    const started = runner.begin(fields, () => new Promise((resolve) => (answer = resolve)));
    await vi.waitFor(() => expect(records.size).toBe(1));
    const [id] = records.keys();
    await runner.cancel(id);
    answer(quoted);
    const { job: begun } = await started;
    expect(begun).toMatchObject({ stage: "cancelled", provider: quoted });
    expect(records.get(id)?.stage).toBe("cancelled");
  });
});
