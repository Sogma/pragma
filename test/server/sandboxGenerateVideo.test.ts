import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockVideoModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { GenerateVideoRequestBody } from "../../src/protocol/api.ts";
import type { VideoCallOptions, VideoStatusResult } from "../../src/protocol/videoGeneration.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { createJobRunner, type JobRunner } from "../../src/server/jobRunner.ts";
import type { JobRecord, JobStore } from "../../src/server/jobs.ts";
import type { ResolvedVideoModel } from "../../src/server/mediaModels.ts";
import {
  performSandboxGenerateVideo,
  readSandboxDocument,
  type SandboxDocument,
  SandboxRequestError,
  startSandboxGenerateVideo,
} from "../../src/server/sandbox.ts";

// The server half of a Generate Video node: the grant, the folder, reuse by
// input digest, and a job recorded as it starts, whose clip the host saves
// whether or not a request still waits. A mock model stands in for the
// configured ones, and a map for the job store.

const FLOW = `<!DOCTYPE html><html data-format="flow" data-format-version="1.0" data-id="flow_v"><head><script type="application/json" data-role="graph">${JSON.stringify(
  {
    nodes: [{ id: "n1", type: "generateVideo", position: { x: 0, y: 0 }, config: { outputFolderPath: "clips" } }],
    edges: [],
  },
)}</script></head><body></body></html>`;

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const response = { timestamp: new Date(), modelId: "m", headers: undefined };

let space: string;
let configDir: string;
let flow: SandboxDocument;
let starts: VideoCallOptions[];
let checked: unknown[];
let records: Map<string, JobRecord>;
let runner: JobRunner;
let status: (signal?: AbortSignal) => Promise<VideoStatusResult>;

const done = async (): Promise<VideoStatusResult> => ({
  status: "completed",
  videos: [{ type: "binary", data: MP4, mediaType: "video/mp4" }],
  warnings: [],
  response,
});

const resolve = (): ResolvedVideoModel => ({
  model: new MockVideoModelV4({
    doStart: async (options) => {
      starts.push(options);
      return {
        operation: { job: starts.length },
        warnings: [{ type: "other", message: "duration: asked for 7, used 8" }],
        providerMetadata: { test: { cost: { amount: 2.4, unit: "credits" }, notes: ["mode: used omni_reference"] } },
        response,
      };
    },
    doStatus: async ({ operation, abortSignal }) => {
      checked.push(operation);
      return status(abortSignal);
    },
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

const only = () => {
  expect(records.size).toBe(1);
  return [...records.values()][0];
};

const body = (fields: Partial<GenerateVideoRequestBody> = {}): GenerateVideoRequestBody => ({
  folder: "clips",
  prompt: "Steam rises from the red cup",
  aspectRatio: "16:9",
  duration: "7",
  ...fields,
});

const run = (fields: Partial<GenerateVideoRequestBody> = {}, signal?: AbortSignal) =>
  performSandboxGenerateVideo(space, flow, body(fields), signal, runner);

async function failure(promise: Promise<unknown>): Promise<SandboxRequestError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SandboxRequestError ? error : undefined;
  }
}

beforeEach(async () => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-generate-video-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-generate-video-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
  writeFileSync(path.join(space, "v.flow.html"), FLOW);
  mkdirSync(path.join(space, "clips"));
  flow = await readSandboxDocument(space, "flow", "v.flow.html");
  starts = [];
  checked = [];
  records = new Map();
  status = done;
  runner = createJobRunner({
    store: () => store,
    resolve,
    resolveImage: () => {
      throw new Error("no image models here");
    },
    sleep: () => new Promise((wake) => setTimeout(wake, 1)),
    now: Date.now,
    spaceRoot: (spaceId) => loadGlobalConfig().spaces?.[spaceId]?.path,
  });
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("performSandboxGenerateVideo", () => {
  it("declares generateVideo for the node's folder", async () => {
    expect(flow.capabilities.map((capability) => capability.key)).toEqual(["generateVideo:space:clips"]);
  });

  it("needs the folder declared and granted, by its own grant", async () => {
    expect((await failure(run({ folder: "elsewhere" })))?.status).toBe(400);
    expect((await failure(run()))?.status).toBe(403);
    await grantCapability(space, flow.subject, "generateImage:space:clips");
    expect((await failure(run()))?.status).toBe(403);
    expect(starts).toHaveLength(0);
  });

  it('generates into the folder, named "video" and a digest, and records the job as delivered', async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const result = await run();

    expect(result).toMatchObject({
      model: "test/m",
      reused: false,
      resumed: false,
      warnings: ["duration: asked for 7, used 8"],
      notes: ["mode: used omni_reference"],
      quote: { amount: 2.4, unit: "credits" },
    });
    expect(result.path).toMatch(/^clips\/video-[0-9a-f]{12}\.mp4$/);
    expect([...readFileSync(path.join(space, result.path))]).toEqual([...MP4]);
    expect(starts[0]).toMatchObject({ prompt: "Steam rises from the red cup", aspectRatio: "16:9", duration: 7 });
    expect(starts[0].seed).toBeUndefined();
    expect(starts[0].frameImages).toBeUndefined();
    expect(only()).toMatchObject({
      stage: "saved",
      delivered: true,
      file: path.basename(result.path),
      document: "v.flow.html",
      folder: "clips",
      summary: "Steam rises from the red cup",
    });
  });

  it("hands back the job it started without waiting on it, and the clip once it is there", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    let finished = false;
    status = async () => (finished ? done() : { status: "pending", response });
    const started = await startSandboxGenerateVideo(space, flow, body(), runner);
    expect(started).toMatchObject({ resumed: false, folder: "clips", model: "test/m", job: { stage: "running" } });
    expect(readdirSync(path.join(space, "clips"))).toEqual([]);

    // The host saves it with nobody waiting at all; the same inputs then find it.
    finished = true;
    await vi.waitFor(() => expect(only().stage).toBe("saved"));
    expect(await startSandboxGenerateVideo(space, flow, body(), runner)).toEqual({
      found: { path: `clips/${only().file}`, model: "test/m", reused: true, resumed: false, warnings: [] },
    });
  });

  it("sends its frames as the clip's first and last", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    await run({
      startFrame: { mediaType: "image/png", data: PNG_BASE64 },
      endFrame: { mediaType: "image/png", data: PNG_BASE64 },
    });
    expect(starts[0].frameImages?.map((frame) => [frame.frameType, frame.image.type])).toEqual([
      ["first_frame", "file"],
      ["last_frame", "file"],
    ]);
  });

  it("sends references in the model's own words for them, and never beside a frame", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const seedance = createJobRunner({
      store: () => store,
      resolve: () => ({ ...resolve(), modelId: "seedance_2_5" }),
      resolveImage: () => {
        throw new Error("no image models here");
      },
      sleep: () => new Promise((wake) => setTimeout(wake, 1)),
      now: Date.now,
      spaceRoot: (spaceId) => loadGlobalConfig().spaces?.[spaceId]?.path,
    });
    const reference = (pin: number) => ({ pin, mediaType: "image/png", data: PNG_BASE64 });
    const references = [reference(2), reference(5)];
    const clip = await performSandboxGenerateVideo(
      space,
      flow,
      body({ prompt: "@image_5 walks into @image_2's bar", references }),
      undefined,
      seedance,
    );

    // BytePlus's Seedance docs number references per kind by upload order.
    expect(starts[0].prompt).toBe("@Image2 walks into @Image1's bar");
    expect(starts[0].inputReferences?.map((file) => [file.type, file.type === "file" && file.mediaType])).toEqual([
      ["file", "image/png"],
      ["file", "image/png"],
    ]);
    expect(starts[0].frameImages).toBeUndefined();
    // The references' bytes are in the digest, so other pictures make another clip.
    const altered = { pin: 5, mediaType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") };
    const other = await performSandboxGenerateVideo(
      space,
      flow,
      body({ prompt: "@image_5 walks into @image_2's bar", references: [reference(2), altered] }),
      undefined,
      seedance,
    );
    expect(other.path).not.toBe(clip.path);

    const both = await failure(run({ startFrame: { mediaType: "image/png", data: PNG_BASE64 }, references }));
    expect(both?.status).toBe(400);
  });

  it("hands back the clip already there for the same inputs, without a job", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const first = await run();
    const again = await run();
    expect(again).toEqual({ path: first.path, model: "test/m", reused: true, resumed: false, warnings: [] });
    expect(starts).toHaveLength(1);
  });

  it("makes a new file for a new take, and finds the first again at take 1 or a blank one", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const first = await run();
    const second = await run({ take: "2" });
    expect(second.path).not.toBe(first.path);
    expect(await run({ take: "1" })).toMatchObject({ reused: true, path: first.path });
    expect(starts).toHaveLength(2);
    // The take names the result; the model never sees it.
    expect(starts[1]).toEqual(expect.objectContaining({ prompt: starts[0].prompt, seed: undefined }));
  });

  it("sends a resolution as the SDK's frame size, and makes one file per size however it is written", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const blank = await run();
    const sharp = await run({ resolution: "1080p" });
    expect(sharp.path).not.toBe(blank.path);
    expect(starts.map((start) => start.resolution)).toEqual([undefined, "1920x1080"]);
    expect(await run({ resolution: "1080" })).toMatchObject({ reused: true, path: sharp.path });
    expect(await run({ resolution: "1920x1080" })).toMatchObject({ reused: true, path: sharp.path });
    expect(starts).toHaveLength(2);
  });

  // A blank resolution joining the digest as "" would rename every Default
  // clip, and the next run would pay for each again.
  it("leaves a blank resolution out of the digest, so a Default clip keeps its name", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          model: "test/m",
          prompt: "Steam rises from the red cup",
          startFrame: "",
          endFrame: "",
          aspectRatio: "16:9",
          duration: 7,
          take: "",
        }),
      )
      .digest("hex")
      .slice(0, 12);
    expect((await run()).path).toBe(`clips/video-${digest}.mp4`);
  });

  it("copies the clip to a new prefix on the same inputs, without a job", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const hero = await run({ prefix: "hero.mp4" });
    const poster = await run({ prefix: "poster" });
    expect(hero.path).toMatch(/^clips\/hero-[0-9a-f]{12}\.mp4$/);
    expect(poster).toMatchObject({ reused: true, path: hero.path.replace("clips/hero-", "clips/poster-") });
    expect([...readFileSync(path.join(space, poster.path))]).toEqual([...MP4]);
    expect(starts).toHaveLength(1);
  });

  // docs/protocol.md's Symbolic links: a cloned or synced space can carry a
  // link under a clip's name, pointing anywhere.
  it("refuses a link holding the clip's own name, and never copies through one under another prefix", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const first = await run();
    const secret = path.join(configDir, "secret.txt");
    writeFileSync(secret, "SECRET");
    rmSync(path.join(space, first.path));
    symlinkSync(secret, path.join(space, first.path));

    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(starts).toHaveLength(1);

    const poster = await run({ prefix: "poster" });
    expect(poster.reused).toBe(false);
    expect([...readFileSync(path.join(space, poster.path))]).toEqual([...MP4]);
    expect(starts).toHaveLength(2);
  });

  it("saves the clip of a request that stopped waiting, with no request left", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const stop = new AbortController();
    let finished = false;
    status = async () => (finished ? done() : { status: "pending", response });
    const waiting = run({}, stop.signal);
    await vi.waitFor(() => expect(checked.length).toBeGreaterThan(0));
    stop.abort(new Error("the run passed its 5m time limit"));
    expect((await failure(waiting))?.message).toBe(
      "Stopped waiting for the clip: the run passed its 5m time limit. It is still being made, and Pragma saves it into clips/ when it's done.",
    );
    expect(only().stage).toBe("running");

    finished = true;
    await vi.waitFor(() => expect(only().stage).toBe("saved"));
    expect(only().delivered).toBe(false);
    expect(readdirSync(path.join(space, "clips"))).toEqual([only().file]);

    // A later run with the same inputs finds the clip rather than paying again.
    expect(await run()).toMatchObject({ reused: true, path: `clips/${only().file}` });
    expect(starts).toHaveLength(1);
  });

  it("saves into the folder the run was allowed, though the Flow was edited since", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const stop = new AbortController();
    let finished = false;
    status = async () => (finished ? done() : { status: "pending", response });
    const waiting = run({}, stop.signal);
    await vi.waitFor(() => expect(checked.length).toBeGreaterThan(0));
    stop.abort(new Error("stopped"));
    await failure(waiting);
    // A changed node withdraws the grant until someone allows the Flow again.
    writeFileSync(path.join(space, "v.flow.html"), FLOW.replace('"clips"}', '"clips","prefix":"edited"}'));
    finished = true;
    await vi.waitFor(() => expect(only().stage).toBe("saved"));
    expect(readdirSync(path.join(space, "clips"))).toHaveLength(1);
  });

  it("forgets a job that failed, so the next request starts another", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    status = async () => ({ status: "error", error: 'Higgsfield\'s job ended as "nsfw".', response });
    expect((await failure(run()))?.message).toBe('Higgsfield\'s job ended as "nsfw".');
    expect(only()).toMatchObject({ stage: "failed", delivered: true, error: 'Higgsfield\'s job ended as "nsfw".' });
    status = done;
    await run();
    expect(starts).toHaveLength(2);
  });

  it("waits on the job a request at the same moment is starting, rather than paying for another", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const [one, two] = await Promise.all([run(), run()]);
    expect(starts).toHaveLength(1);
    expect(two.path).toBe(one.path);
    expect(readdirSync(path.join(space, "clips"))).toEqual([path.basename(one.path)]);
    // One job, so one price: only the request that started it reports it.
    expect([one.quote, two.quote].filter(Boolean)).toEqual([{ amount: 2.4, unit: "credits" }]);
    expect([one.resumed, two.resumed]).toContain(true);
  });

  it("keeps a finished job recorded when its clip can't be fetched, to save it again", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    status = async () => ({
      status: "completed",
      videos: [{ type: "url", url: "http://cdn.example/clip.mp4", mediaType: "video/mp4" }],
      warnings: [],
      response,
    });
    expect((await failure(run()))?.message).toMatch(
      /only https.* The clip is made, and Pragma tries saving it again\.$/,
    );
    expect(only()).toMatchObject({ stage: "running", problem: expect.stringMatching(/tries saving it again/) });
    expect(readdirSync(path.join(space, "clips"))).toEqual([]);
  });

  it("refuses a folder that isn't there", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    rmSync(path.join(space, "clips"), { recursive: true });
    expect((await failure(run()))?.status).toBe(400);
  });
});
