import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { MockVideoModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig } from "../../src/config/loadConfig.ts";
import type { GenerateVideoRequestBody } from "../../src/protocol/api.ts";
import type { VideoCallOptions, VideoStatusResult } from "../../src/protocol/videoGeneration.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { createJobRunner, type JobRunner } from "../../src/server/jobRunner.ts";
import type { JobRecord } from "../../src/server/jobs.ts";
import type { ResolvedVideoModel } from "../../src/server/mediaModels.ts";
import {
  performSandboxGenerateVideo,
  readSandboxDocument,
  type SandboxDocument,
  SandboxRequestError,
  startSandboxGenerateVideo,
} from "../../src/server/sandbox.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";
import { memoryJobStore } from "../support/memoryJobStore.ts";

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
// What the mock provider says a job makes; undefined when it says nothing.
let reported: { aspectRatio?: string; resolution?: string; duration?: number } | undefined;
let checked: unknown[];
const records = new Map<string, JobRecord>();
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
        providerMetadata: {
          test: {
            cost: { amount: 2.4, unit: "credits" },
            notes: ["mode: used omni_reference"],
            ...(reported ? { settings: { ...reported } } : {}),
          },
        },
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

const store = memoryJobStore(records);

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
  configDir = isolateConfig();
  space = tempSpace("pragma-generate-video-");
  writeFileSync(path.join(space, "v.flow.html"), FLOW);
  mkdirSync(path.join(space, "clips"));
  flow = await readSandboxDocument(space, "flow", "v.flow.html");
  starts = [];
  reported = undefined;
  checked = [];
  records.clear();
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
    expect(result.path).toMatch(/^clips\/_[0-9a-f]{12}\.mp4$/);
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
      settings: { aspectRatio: "16:9", duration: 7 },
    });
  });

  it("records the id the start was sent with on its job, and none when it came without one", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const started = await startSandboxGenerateVideo(space, flow, body({ startId: "start-1" }), runner);
    if ("found" in started) throw new Error("expected a job");
    expect(started.job.startId).toBe("start-1");
    expect(only().startId).toBe("start-1");

    records.clear();
    const plain = await startSandboxGenerateVideo(space, flow, body({ prompt: "A kite at dusk" }), runner);
    if ("found" in plain) throw new Error("expected a job");
    expect(plain.job).not.toHaveProperty("startId");
  });

  it("sends the model's own settings in name order, and names a clip by them only when some are set", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const plain = await run();
    const set = await run({ modelSettings: { mode: "edit", genre: "noir" } });
    expect(set.path).not.toBe(plain.path);
    expect(starts[0].providerOptions?.pragma).toBeUndefined();
    expect(starts[1].providerOptions).toEqual({ pragma: { genre: "noir", mode: "edit" } });
    expect(Object.keys(starts[1].providerOptions?.pragma ?? {})).toEqual(["genre", "mode"]);
    // The same settings in another order are the same clip.
    expect(await run({ modelSettings: { genre: "noir", mode: "edit" } })).toMatchObject({
      reused: true,
      path: set.path,
    });
  });

  it("records what the provider says the job makes over the settings sent", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    reported = { aspectRatio: "16:9", resolution: "1080p", duration: 8 };
    await run({ resolution: "4K" });
    expect(only().settings).toEqual({ aspectRatio: "16:9", resolution: "1080p", duration: 8 });
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
    expect((await run()).path).toBe(`clips/_${digest}.mp4`);
  });

  it("copies the clip to a new prefix on the same inputs, without a job", async () => {
    await grantCapability(space, flow.subject, "generateVideo:space:clips");
    const hero = await run({ prefix: "hero.mp4" });
    const poster = await run({ prefix: "poster" });
    expect(hero.path).toMatch(/^clips\/hero_[0-9a-f]{12}\.mp4$/);
    expect(poster).toMatchObject({ reused: true, path: hero.path.replace("clips/hero_", "clips/poster_") });
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

// A clip goes from Load Video to a reference pin by reference: the server
// reads it under the Flow's own grants, once, and only if it is still the
// clip that was read.
describe("video references", () => {
  const CLIP = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 7, 7, 7]);
  const digestOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const loadNode = (id: string, videoPath: string) => ({
    id,
    type: "loadVideo",
    position: { x: 0, y: 0 },
    config: { videoPath },
  });
  const flowWith = (paths: string[]) =>
    `<!DOCTYPE html><html data-format="flow" data-format-version="1.0" data-id="flow_c"><head><script type="application/json" data-role="graph">${JSON.stringify(
      {
        nodes: [
          { id: "g", type: "generateVideo", position: { x: 0, y: 0 }, config: { outputFolderPath: "clips" } },
          ...paths.map((videoPath, index) => loadNode(`l${index}`, videoPath)),
        ],
        edges: [],
      },
    )}</script></head><body></body></html>`;
  const clip = (pin: number, file = "shots/take.mp4", bytes = CLIP) => ({
    pin,
    path: `/${file}`,
    digest: digestOf(bytes),
  });
  let doc: SandboxDocument;
  let inputs: ResolvedVideoModel["inputs"];

  const runnerOn = (modelId: string) =>
    createJobRunner({
      store: () => store,
      resolve: () => ({ ...resolve(), modelId, ...(inputs ? { inputs } : {}) }),
      resolveImage: () => {
        throw new Error("no image models here");
      },
      sleep: () => new Promise((wake) => setTimeout(wake, 1)),
      now: Date.now,
      spaceRoot: (spaceId) => loadGlobalConfig().spaces?.[spaceId]?.path,
    });
  const send = (fields: Partial<GenerateVideoRequestBody>, modelId = "seedance_2_0") =>
    performSandboxGenerateVideo(space, doc, body(fields), undefined, runnerOn(modelId));

  beforeEach(async () => {
    inputs = undefined;
    mkdirSync(path.join(space, "shots"));
    writeFileSync(path.join(space, "shots", "take.mp4"), CLIP);
    writeFileSync(path.join(space, "shots", "copy.mp4"), CLIP);
    writeFileSync(path.join(space, "c.flow.html"), flowWith(["shots/take.mp4", "shots/copy.mp4"]));
    doc = await readSandboxDocument(space, "flow", "c.flow.html");
    await grantCapability(space, doc.subject, "generateVideo:space:clips");
  });

  const grantReads = async () => {
    await grantCapability(space, doc.subject, "readFile:space:shots/take.mp4");
    await grantCapability(space, doc.subject, "readFile:space:shots/copy.mp4");
  };

  it("sends the clip's bytes as a video reference in the model's words, read under the Flow's grant", async () => {
    await grantReads();
    await send({ prompt: "Move like @video_1", videoReferences: [clip(1)] });
    expect(starts[0].prompt).toBe("Move like @Video1");
    const [sent] = starts[0].inputReferences ?? [];
    expect(sent?.type === "file" && [sent.mediaType, [...sent.data]]).toEqual(["video/mp4", [...CLIP]]);
  });

  it("needs the clip's read declared and granted, and starts nothing without", async () => {
    expect((await failure(send({ videoReferences: [clip(1)] })))?.status).toBe(403);
    const elsewhere = { pin: 1, path: "/elsewhere/take.mp4", digest: digestOf(CLIP) };
    expect((await failure(send({ videoReferences: [elsewhere] })))?.status).toBe(400);
    expect(starts).toHaveLength(0);
  });

  it("refuses a clip that changed after Load Video read it", async () => {
    await grantReads();
    const stale = { ...clip(1), digest: digestOf(Buffer.from("an older take")) };
    const refused = await failure(send({ videoReferences: [stale] }));
    expect(refused?.status).toBe(400);
    expect(refused?.message).toMatch(/changed after Load Video read it/);
    expect(starts).toHaveLength(0);
  });

  it("refuses clips past 256 MiB in all before reading any", async () => {
    // Sparse files: their size is what's checked, so nothing is written out.
    for (const name of ["take.mp4", "copy.mp4"]) {
      const handle = openSync(path.join(space, "shots", name), "w");
      ftruncateSync(handle, 129 * 1024 * 1024);
      closeSync(handle);
    }
    await grantReads();
    const refused = await failure(send({ videoReferences: [clip(1), clip(2, "shots/copy.mp4")] }));
    expect(refused?.status).toBe(400);
    expect(refused?.message).toBe("The reference clips come to 258 MiB, over the 256 MiB one generation can send");
    expect(starts).toHaveLength(0);
  });

  it("names a result by the clip's digest, never its path", async () => {
    await grantReads();
    const first = await send({ videoReferences: [clip(1)] });
    const moved = await send({ videoReferences: [clip(1, "shots/copy.mp4")] });
    expect(moved).toMatchObject({ path: first.path, reused: true });
    expect(starts).toHaveLength(1);
  });

  it("leaves out clips past the model's count, and refuses a prompt naming one", async () => {
    await grantReads();
    const four = [clip(1), clip(2), clip(3), clip(4)];
    const result = await send({ prompt: "Cut between the takes", videoReferences: four });
    expect(result.warnings).toContain("test/seedance_2_0 takes 3 reference videos, so video_4 was left out");
    expect(starts[0].inputReferences).toHaveLength(3);
    const named = await failure(send({ prompt: "End on @video_4", videoReferences: four }));
    expect(named?.message).toBe(
      "The prompt names @video_4, but test/seedance_2_0 takes 3 reference videos, so video_4 was left out",
    );
  });

  // The clean break: what a model would ignore stays out of the job and the
  // name alike, so swapping it never pays for a new result.
  it("asks an unlisted model's catalog what it takes, and keeps what it doesn't take out of the job and the name", async () => {
    await grantReads();
    inputs = async () => ({ references: ["image"], frames: ["start"] });
    const without = await send({}, "m");
    const ignored = await send({ videoReferences: [clip(1)] }, "m");
    expect(ignored).toMatchObject({ path: without.path, reused: true });
    expect(starts).toHaveLength(1);

    const named = await failure(send({ prompt: "Move like @video_1", videoReferences: [clip(1)] }, "m"));
    expect(named?.message).toBe(
      "The prompt names @video_1, but test/m takes no reference videos, so video_1 was left out",
    );
    expect(starts).toHaveLength(1);

    const frame = { mediaType: "image/png", data: PNG_BASE64 };
    const started = await send({ startFrame: frame, endFrame: frame }, "m");
    expect(started.warnings).toContain("test/m takes no end frame, so end_frame was left out");
    expect(starts[1].frameImages?.map((each) => each.frameType)).toEqual(["first_frame"]);
    const startOnly = await send({ startFrame: frame }, "m");
    expect(startOnly).toMatchObject({ path: started.path, reused: true });
  });

  it("sends everything when the catalog can't be read, as before anyone asked", async () => {
    await grantReads();
    inputs = async () => {
      throw new Error("signed out");
    };
    await send({ videoReferences: [clip(1)] }, "m");
    expect(starts[0].inputReferences).toHaveLength(1);
  });
});
