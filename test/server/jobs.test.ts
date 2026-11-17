import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileJobStore, type JobRecord } from "../../src/server/jobs.ts";

// The paid jobs a host started, one file each beside config.json until the
// result is saved and shown.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-jobs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const job = (id: string, fields: Partial<JobRecord> = {}): JobRecord => ({
  id,
  kind: "video",
  digest: "a".repeat(64),
  spaceId: "spc_1",
  document: "v.flow.html",
  folder: "clips",
  folderName: "clips",
  stem: "video-aaaaaaaaaaaa",
  prefix: "",
  model: "higgsfield/seedance_2_5",
  summary: "Steam rises from the red cup",
  stage: "running",
  startedAt: 1,
  ...fields,
});

describe("createFileJobStore", () => {
  it("keeps one file per job, read back by a fresh store", async () => {
    await createFileJobStore(dir).add(job("one"));
    await createFileJobStore(dir).add(job("two", { stage: "starting" }));
    expect(readdirSync(dir).sort()).toEqual(["one.json", "two.json"]);
    const store = createFileJobStore(dir);
    expect((await store.list()).map((each) => each.id).sort()).toEqual(["one", "two"]);
    expect(await store.get("two")).toEqual(job("two", { stage: "starting" }));
  });

  it("reads back a job in every stage, a cancelled one kept as a record among them", async () => {
    const store = createFileJobStore(dir);
    for (const stage of ["starting", "running", "saved", "failed", "cancelled"] as const) {
      await store.add(job(stage, { stage }));
    }
    expect((await store.list()).map((each) => each.stage).sort()).toEqual([
      "cancelled",
      "failed",
      "running",
      "saved",
      "starting",
    ]);
  });

  it("changes one job as it is stored, and removes it", async () => {
    const store = createFileJobStore(dir);
    await store.add(job("one"));
    expect(await store.update("one", (stored) => ({ ...stored, stage: "saved", file: "a.mp4" }))).toMatchObject({
      stage: "saved",
      file: "a.mp4",
    });
    expect(await store.get("one")).toMatchObject({ stage: "saved", file: "a.mp4" });
    expect(await store.update("missing", (stored) => stored)).toBeUndefined();
    await store.remove("one");
    expect(await store.list()).toEqual([]);
  });

  it("loses no change when two land at once", async () => {
    const store = createFileJobStore(dir);
    await store.add(job("one"));
    await Promise.all([
      store.update("one", (stored) => ({ ...stored, problem: "a" })),
      store.update("one", (stored) => ({ ...stored, file: "b.mp4" })),
    ]);
    expect(await store.get("one")).toMatchObject({ problem: "a", file: "b.mp4" });
  });

  it("reads a missing folder as no jobs, and skips a file that isn't a job", async () => {
    expect(await createFileJobStore(path.join(dir, "nowhere")).list()).toEqual([]);
    writeFileSync(path.join(dir, "broken.json"), "{");
    writeFileSync(path.join(dir, "other.json"), JSON.stringify({ id: "x" }));
    writeFileSync(path.join(dir, ".one.json.123.tmp"), JSON.stringify(job("tmp")));
    expect(await createFileJobStore(dir).list()).toEqual([]);
  });
});
