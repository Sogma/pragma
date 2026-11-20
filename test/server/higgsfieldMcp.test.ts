import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import type { ResolvedMcpServer } from "../../src/config/loadConfig.ts";
import { callImageModel } from "../../src/protocol/imageGeneration.ts";
import { checkVideoJob, startVideoJob, type VideoCallOptions } from "../../src/protocol/videoGeneration.ts";
import {
  higgsfieldImageJobs,
  higgsfieldImageModel,
  higgsfieldModels,
  higgsfieldVideoInputs,
  higgsfieldVideoModel,
  type MediaCache,
  taskMode,
  wholeRatio,
} from "../../src/server/higgsfieldMcp.ts";
import {
  type HiggsfieldStandIn,
  RESULT_PNG,
  startHiggsfieldStandIn,
  VIDEO_JOB_ID,
} from "../support/higgsfieldStandIn.ts";

// The Higgsfield adapter against its recorded MCP server, through the SDK's
// own image call where the result matters and straight to the model where an
// error's own words do.

const REFERENCE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const JOB_ID = "71db41af-5b54-46b5-a88d-0eb4167ee799";

let standIn: HiggsfieldStandIn;
let configDir: string;
let server: ResolvedMcpServer;
let cache: Map<string, string>;

function memoryCache(): MediaCache {
  return {
    get: async (digest) => cache.get(digest),
    set: async (digest, mediaId) => void cache.set(digest, mediaId),
    drop: async (digest) => void cache.delete(digest),
  };
}

const download = async (url: string) => {
  const response = await fetch(url);
  return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") ?? "" };
};

const model = (modelId = "soul_2") => higgsfieldImageModel(server, modelId, { mediaCache: memoryCache(), download });

beforeEach(async () => {
  standIn = await startHiggsfieldStandIn();
  // The adapter looks for a sign-in first, and sign-ins rest in the global
  // config, so it points at a throwaway directory.
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-higgsfield-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  server = { id: "higgsfield", label: "Higgsfield", url: standIn.url, copilot: false, flows: true };
  await credentialStore().set(
    { kind: "mcp-tokens", id: "higgsfield" },
    { absent: true },
    { endpoint: standIn.url, secrets: { key: "test-key" } },
  );
  cache = new Map();
});

afterEach(async () => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
  await standIn.close();
});

describe("higgsfieldImageModel", () => {
  it("uploads the reference, submits on credits, waits, and downloads the result, keeping the server's own picks as notes", async () => {
    standIn.adjustments = {
      aspect_ratio: { requested: "16:10", used: "3:2", reason: "closest match by log-ratio distance" },
      "params.quality": { requested: "(unset)", used: "2k", reason: "default for model" },
    };

    const result = await callImageModel(model(), {
      prompt: "a red cup",
      references: [{ mediaType: "image/png", data: REFERENCE }],
      aspectRatio: "16:10",
    });

    expect(result.data).toEqual(RESULT_PNG);
    expect(result.mediaType).toBe("image/png");
    expect(result.warnings).toEqual(["aspect_ratio: asked for 16:10, used 3:2 (closest match by log-ratio distance)"]);
    // A default the server filled in changed nothing the node asked for.
    expect(result.notes).toEqual(["quality: used 2k (default for model)"]);
    expect(result.providerMetadata?.higgsfield).toEqual({
      images: [{ jobId: JOB_ID, cost: { amount: 0.12, unit: "credits" }, notes: result.notes }],
    });
    expect(result.cost).toEqual({ amount: 0.12, unit: "credits" });
    expect(standIn.costCalls).toEqual([{ ...standIn.generateCalls[0], get_cost: true }]);
    expect(standIn.uploads).toEqual([{ contentType: "image/png", bytes: REFERENCE.length }]);
    expect(standIn.generateCalls[0]).toEqual({
      model: "soul_2",
      prompt: "a red cup",
      count: 1,
      use_unlim: false,
      aspect_ratio: "16:10",
      medias: [{ value: "75e4ac19-3b0b-4b2a-8241-954298598ee9", role: "image" }],
    });
    expect(standIn.authorizations.every((header) => header === "Bearer test-key")).toBe(true);
  });

  it("uploads a reference image once, and reuses its media id", async () => {
    const request = { prompt: "a red cup", references: [{ mediaType: "image/png", data: REFERENCE }] };
    await callImageModel(model(), request);
    await callImageModel(model(), request);

    expect(standIn.uploads).toHaveLength(1);
    expect(standIn.generateCalls.map((params) => params.medias)).toEqual([
      [{ value: "75e4ac19-3b0b-4b2a-8241-954298598ee9", role: "image" }],
      [{ value: "75e4ac19-3b0b-4b2a-8241-954298598ee9", role: "image" }],
    ]);
  });

  it("uploads afresh when the server refuses a cached media id", async () => {
    const request = { prompt: "a red cup", references: [{ mediaType: "image/png", data: REFERENCE }] };
    await callImageModel(model(), request);
    const [digest] = [...cache.keys()];
    cache.set(digest, "stale-id");
    standIn.refusedMediaId = "stale-id";

    await callImageModel(model(), request);

    expect(standIn.uploads).toHaveLength(2);
    expect(cache.get(digest)).toBe("75e4ac19-3b0b-4b2a-8241-954298598ee9");
  });

  it("warns about a size, which Higgsfield doesn't take", async () => {
    const result = await model().doGenerate({
      prompt: "a red cup",
      n: 1,
      size: "1024x1024",
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
      providerOptions: {},
    });
    expect(result.warnings).toEqual([
      { type: "unsupported", feature: "size", details: "Higgsfield takes an aspect ratio." },
    ]);
  });

  it("fails loudly on an answer its tool's schema doesn't allow", async () => {
    standIn.offSchema = true;
    await expect(
      model().doGenerate({
        prompt: "a red cup",
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
        providerOptions: {},
      }),
    ).rejects.toThrow(/structured content/i);
  });

  it("stops waiting when aborted between polls, and says the job still bills", async () => {
    standIn.jobRunning = true;
    standIn.pollAfterSeconds = 5;
    const controller = new AbortController();
    standIn.onJobsWait = () => setTimeout(() => controller.abort(), 50);

    await expect(
      model().doGenerate({
        prompt: "a red cup",
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
        providerOptions: {},
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/will still finish, and be billed/);
  });

  it("says the job still bills when aborted in the middle of a poll", async () => {
    standIn.jobRunning = true;
    standIn.pollDelayMs = 2000;
    const controller = new AbortController();
    standIn.onJobsWait = () => controller.abort();

    await expect(
      model().doGenerate({
        prompt: "a red cup",
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
        providerOptions: {},
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/will still finish, and be billed/);
  });
});

describe("higgsfieldVideoModel", () => {
  const START = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1]);
  const END = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2, 2]);
  const MEDIA_ID = "75e4ac19-3b0b-4b2a-8241-954298598ee9";
  const videoModel = (modelId = "seedance1_5") =>
    higgsfieldVideoModel(server, modelId, { mediaCache: memoryCache(), videoCheckMs: 50 });
  const startOptions = (fields: Partial<VideoCallOptions> = {}): VideoCallOptions => ({
    prompt: "steam rises from the cup",
    n: 1,
    aspectRatio: undefined,
    resolution: undefined,
    duration: undefined,
    fps: undefined,
    seed: undefined,
    image: undefined,
    frameImages: undefined,
    inputReferences: undefined,
    generateAudio: undefined,
    providerOptions: {},
    ...fields,
  });

  it("starts a job with each frame in its role, priced first, and names the job as its operation", async () => {
    standIn.creditsExact = 2.4;
    standIn.adjustments = { duration: { requested: 7, used: 8, reason: "nearest allowed value in [4, 8, 12]" } };

    const job = await startVideoJob(videoModel(), {
      prompt: "steam rises from the cup",
      startFrame: START,
      endFrame: END,
      aspectRatio: "1:1",
      resolution: "1920x1080",
      duration: 7,
    });

    expect(job).toEqual({
      operation: { jobId: VIDEO_JOB_ID },
      warnings: ["duration: asked for 7, used 8 (nearest allowed value in [4, 8, 12])"],
      notes: [],
      quote: { amount: 2.4, unit: "credits" },
      settings: { aspectRatio: "1:1", resolution: "1080p", duration: 8 },
    });
    expect(standIn.uploads).toEqual([
      { contentType: "image/png", bytes: START.length },
      { contentType: "image/png", bytes: END.length },
    ]);
    expect(standIn.generateCalls).toEqual([
      {
        model: "seedance1_5",
        prompt: "steam rises from the cup",
        count: 1,
        use_unlim: false,
        aspect_ratio: "1:1",
        resolution: "1080p",
        duration: 7,
        medias: [
          { value: MEDIA_ID, role: "start_image" },
          { value: MEDIA_ID, role: "end_image" },
        ],
      },
    ]);
    expect(standIn.costCalls).toEqual([{ ...standIn.generateCalls[0], get_cost: true }]);
  });

  // Seedance 2.5 starts in a prompt-only mode, and moves to one that takes
  // images when a frame comes: the node never sent a mode, so asked for none.
  it("keeps a setting the server picked on its own out of the warnings, as a note", async () => {
    standIn.adjustments = {
      "params.mode": {
        requested: "t2v",
        used: "omni_reference",
        reason: "mode was omitted and reference media was provided; t2v accepts no references",
      },
    };
    const job = await startVideoJob(videoModel("seedance_2_5"), { prompt: "the cup turns", startFrame: START });
    expect(job.warnings).toEqual([]);
    expect(job.notes).toEqual([
      "mode: used omni_reference (mode was omitted and reference media was provided; t2v accepts no references)",
    ]);
  });

  it("leaves out a frame the model takes no role for, and says so", async () => {
    standIn.videoRoles = ["start_image"];
    const job = await startVideoJob(videoModel("grok_video_v15_lite"), {
      prompt: "the cup turns",
      startFrame: START,
      endFrame: END,
    });
    expect(job.warnings).toEqual(["end_frame: grok_video_v15_lite takes none, so it was left out"]);
    expect(standIn.uploads).toHaveLength(1);
    expect(standIn.generateCalls[0].medias).toEqual([{ value: MEDIA_ID, role: "start_image" }]);
  });

  it("uploads each reference in the role its kind takes, after any frame", async () => {
    standIn.videoRoles = ["start_image", "end_image", "image_references"];
    const job = await startVideoJob(videoModel("seedance_2_5"), {
      prompt: "Image 2 walks past Image 1",
      references: [
        { mediaType: "image/png", data: START },
        { mediaType: "image/png", data: END },
      ],
    });
    expect(job.warnings).toEqual([]);
    expect(standIn.generateCalls[0].medias).toEqual([
      { value: MEDIA_ID, role: "image_references" },
      { value: MEDIA_ID, role: "image_references" },
    ]);
  });

  // One model's mode stays text-to-video unless sent, and then refuses the
  // references; another requires a mode.
  it("sends the mode its placed inputs ask for, in the model's own words", async () => {
    standIn.videoRoles = ["start_image", "image_references", "video_references"];
    standIn.videoModes = ["text-to-video", "image-to-video", "reference-to-video", "video-edit"];
    await startVideoJob(videoModel("kling_4_0_flash"), {
      prompt: "pixel art as in Video 1",
      references: [{ mediaType: "video/mp4", data: START }],
    });
    await startVideoJob(videoModel("kling_4_0_flash"), { prompt: "the cup turns", startFrame: START });
    await startVideoJob(videoModel("kling_4_0_flash"), { prompt: "the cup turns" });
    standIn.videoModes = ["std", "pro", "4k"];
    await startVideoJob(videoModel("kling3_0"), { prompt: "the cup turns" });
    expect(standIn.generateCalls.map((call) => call.mode)).toEqual([
      "reference-to-video",
      "image-to-video",
      "text-to-video",
      undefined,
    ]);
  });

  // media_upload tells a file's kind by its name, and media_confirm is told
  // it, so a clip that went up as an image would never be a video reference.
  it("uploads a clip named by its own extension, confirms it as video, and places it as a video reference", async () => {
    standIn.videoRoles = ["image_references", "video_references"];
    const job = await startVideoJob(videoModel("seedance_2_5"), {
      prompt: "move as in Video 1 and Video 2",
      references: [
        { mediaType: "video/mp4", data: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1]) },
        { mediaType: "video/quicktime", data: new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 2]) },
      ],
    });
    expect(job.warnings).toEqual([]);
    expect(standIn.uploadNames).toEqual(["reference.mp4", "reference.mov"]);
    expect(standIn.confirmTypes).toEqual(["video", "video"]);
    expect(standIn.uploads.map((upload) => upload.contentType)).toEqual(["video/mp4", "video/quicktime"]);
    expect(standIn.generateCalls[0].medias).toEqual([
      { value: MEDIA_ID, role: "video_references" },
      { value: MEDIA_ID, role: "video_references" },
    ]);
  });

  it("still names and confirms a picture as an image", async () => {
    standIn.videoRoles = ["image_references"];
    await startVideoJob(videoModel("seedance_2_5"), {
      prompt: "Image 1 turns",
      references: [{ mediaType: "image/jpeg", data: START }],
    });
    expect(standIn.uploadNames).toEqual(["reference.jpg"]);
    expect(standIn.confirmTypes).toEqual(["image"]);
  });

  it("leaves out references the model takes no role for, and says so once", async () => {
    standIn.videoRoles = ["start_image"];
    const job = await startVideoJob(videoModel("grok_video_v15_lite"), {
      prompt: "the cup turns",
      references: [
        { mediaType: "image/png", data: START },
        { mediaType: "image/png", data: END },
      ],
    });
    expect(job.warnings).toEqual(["image references: grok_video_v15_lite takes none, so it was left out"]);
    expect(standIn.uploads).toHaveLength(0);
  });

  it("sends the nearest resolution the model lists, by its own name, and says when it isn't the size asked", async () => {
    standIn.videoResolutions = ["512", "768", "1080"];
    const snapped = await startVideoJob(videoModel("minimax_hailuo"), {
      prompt: "the cup turns",
      resolution: "1280x720",
    });
    expect(snapped.warnings).toEqual(["resolution: asked for 720p, used 768 (closest supported resolution)"]);
    expect(snapped.settings).toEqual({ resolution: "768p" });
    const same = await startVideoJob(videoModel("minimax_hailuo"), {
      prompt: "the cup turns",
      resolution: "1920x1080",
    });
    expect(same.warnings).toEqual([]);
    expect(standIn.generateCalls.map((call) => call.resolution)).toEqual(["768", "1080"]);
  });

  // Kling 3.0 has a mode instead and Veo 3.1 a quality; neither is a size.
  it("leaves out a resolution for a model that lists none, and says so", async () => {
    standIn.videoResolutions = [];
    const job = await startVideoJob(videoModel("kling3_0"), { prompt: "the cup turns", resolution: "1920x1080" });
    expect(job.warnings).toEqual(["resolution: kling3_0 takes none, so it was left out"]);
    expect(standIn.generateCalls[0]).not.toHaveProperty("resolution");
    expect(job.settings).toEqual({});
  });

  it("says a job makes the settings the server filled in, as it used them", async () => {
    standIn.adjustments = {
      "params.resolution": { requested: "(unset)", used: "720p", reason: "default for model" },
      "params.duration": { requested: "(unset)", used: 5, reason: "default for model" },
      "params.mode": { requested: "t2v", used: "omni_reference", reason: "reference media was provided" },
    };
    const job = await startVideoJob(videoModel("seedance_2_5"), { prompt: "the cup turns", aspectRatio: "16:9" });
    expect(job.settings).toEqual({ aspectRatio: "16:9", resolution: "720p", duration: 5 });
  });

  // A model may refuse a whole job over a seed, after its quote passed.
  it("never sends a seed, or a setting Higgsfield's video models don't take, and says so", async () => {
    const started = await videoModel().doStart?.(startOptions({ seed: 42, fps: 24 }));
    expect(started?.warnings).toEqual([
      { type: "unsupported", feature: "fps" },
      { type: "unsupported", feature: "seed" },
    ]);
    expect(standIn.generateCalls[0]).not.toHaveProperty("seed");
    expect(standIn.generateCalls[0]).not.toHaveProperty("medias");
  });

  it("checks a job from a fresh connection: still running, then its clip", async () => {
    const model = videoModel();
    standIn.jobRunning = true;
    expect(await model.doStatus?.({ operation: { jobId: VIDEO_JOB_ID } })).toMatchObject({ status: "pending" });
    standIn.jobRunning = false;
    expect(await checkVideoJob(model, { jobId: VIDEO_JOB_ID })).toEqual({
      status: "completed",
      video: { type: "url", url: `${new URL(standIn.url).origin}/result.mp4`, mediaType: "video/mp4" },
    });
  });

  it("ends a job the server won't name, or an operation that names none", async () => {
    standIn.refusedJobId = VIDEO_JOB_ID;
    expect(await videoModel().doStatus?.({ operation: { jobId: VIDEO_JOB_ID } })).toMatchObject({
      status: "error",
      error: "Higgsfield refused jobs_wait: Job not found",
    });
    expect(await videoModel().doStatus?.({ operation: {} })).toMatchObject({
      status: "error",
      error: "This job names no Higgsfield job id.",
    });
  });
});

describe("taskMode", () => {
  const seedance = ["t2v", "omni_reference", "video_edit", "video_extension"];
  it("picks the task the inputs ask for in each spelling, references over frames", () => {
    expect(taskMode(seedance, { references: true, frames: true })).toBe("omni_reference");
    expect(taskMode(seedance, { references: false, frames: false })).toBe("t2v");
    expect(taskMode(["text-to-video", "reference-to-video", "edit"], { references: true, frames: false })).toBe(
      "reference-to-video",
    );
  });

  it("leaves the mode to the server where no option names the task", () => {
    // A model taking a frame in omni_reference is moved there by the server.
    expect(taskMode(seedance, { references: false, frames: true })).toBeUndefined();
    expect(taskMode(["std", "pro", "4k"], { references: true, frames: false })).toBeUndefined();
    expect(taskMode([], { references: false, frames: false })).toBeUndefined();
  });
});

describe("higgsfieldImageJobs", () => {
  it("starts an image job priced first, names the job as its operation, and checks it from a fresh connection", async () => {
    standIn.adjustments = {
      aspect_ratio: { requested: "16:10", used: "3:2", reason: "closest match by log-ratio distance" },
      "params.quality": { requested: "(unset)", used: "2k", reason: "default for model" },
    };
    const jobs = higgsfieldImageJobs(server, "soul_2", { mediaCache: memoryCache(), videoCheckMs: 50 });
    const started = await jobs.start({
      prompt: "a red cup",
      references: [{ mediaType: "image/png", data: REFERENCE }],
      aspectRatio: "16:10",
    });
    expect(started).toEqual({
      operation: { jobId: JOB_ID },
      warnings: ["aspect_ratio: asked for 16:10, used 3:2 (closest match by log-ratio distance)"],
      notes: ["quality: used 2k (default for model)"],
      quote: { amount: 0.12, unit: "credits" },
      settings: { aspectRatio: "3:2" },
    });
    expect(standIn.costCalls).toEqual([{ ...standIn.generateCalls[0], get_cost: true }]);
    expect(standIn.generateCalls[0]).toMatchObject({ model: "soul_2", prompt: "a red cup", aspect_ratio: "16:10" });

    standIn.jobRunning = true;
    expect(await jobs.check({ jobId: JOB_ID })).toEqual({ status: "running" });
    standIn.jobRunning = false;
    expect(await jobs.check({ jobId: JOB_ID })).toEqual({
      status: "completed",
      image: { type: "url", url: `${new URL(standIn.url).origin}/result.png`, mediaType: "image/png" },
    });
    expect(await jobs.check({})).toEqual({ status: "failed", error: "This job names no Higgsfield job id." });
  });
});

describe("higgsfieldModels", () => {
  it("lists a video model only if it takes a start frame, which an edit tool doesn't", async () => {
    expect(await higgsfieldModels(server, "video")).toEqual([
      {
        id: "grok_video_v15_lite",
        label: "Grok Imagine Video 1.5 Lite",
        takes: { references: [], frames: ["start"] },
      },
      { id: "seedance1_5", label: "Seedance 1.5 Pro", takes: { references: [], frames: ["start", "end"] } },
    ]);
  });

  it("lists a video model taking only reference images, as Kling 3.0 Omni does", async () => {
    standIn.extraVideoModels = [
      {
        id: "kling_o3_image_reference",
        name: "Kling 3.0 Omni",
        output_type: "video",
        medias: [{ name: "medias", type: "image", roles: ["image_references"] }],
      },
    ];
    expect(await higgsfieldModels(server, "video")).toContainEqual({
      id: "kling_o3_image_reference",
      label: "Kling 3.0 Omni",
      takes: { references: ["image"], frames: [] },
    });
  });
});

describe("higgsfieldVideoInputs", () => {
  it("reads what a model takes from its catalog entry's roles, and asks once a while", async () => {
    standIn.videoRoles = ["start_image", "image_references", "video_references"];
    const inputs = higgsfieldVideoInputs(server, "inputs_probe_model", { mediaCache: memoryCache() });
    expect(await inputs()).toEqual({ references: ["image", "video"], frames: ["start"] });
    expect(await inputs()).toEqual({ references: ["image", "video"], frames: ["start"] });
    expect(standIn.explores).toBe(1);
  });
});

describe("wholeRatio", () => {
  it("writes a decimal ratio in whole terms and leaves a whole one alone", () => {
    expect(wholeRatio("1.85:1")).toBe("37:20");
    expect(wholeRatio("1:2.39")).toBe("100:239");
    expect(wholeRatio("1.90:1")).toBe("19:10");
    expect(wholeRatio("16:9")).toBe("16:9");
  });
});
