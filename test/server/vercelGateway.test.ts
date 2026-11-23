import { describe, expect, it, vi } from "vitest";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";
import {
  checkVideoJob,
  type ProviderVideoModel,
  startVideoJob,
  type VideoCallOptions,
  type VideoStartResult,
  type VideoStatusResult,
} from "../../src/protocol/videoGeneration.ts";
import { resolutionSize } from "../../src/protocol/videoResolution.ts";
import type { LinkSharing } from "../../src/server/sharing.ts";
import {
  type GatewayVideoFacts,
  gatewayVideoCatalog,
  gatewayVideoFacts,
  gatewayVideoModel,
} from "../../src/server/vercelGateway.ts";

// The gateway's video adapter around a stand-in for the gateway's own model:
// what each model's list entry says it takes, and how a request is fitted to
// it, its files sent as links, before the gateway sees it.

const ENTRY = {
  id: "maker/clip-2",
  type: "video",
  name: "Clip 2",
  video_capabilities: {
    supported_operations: ["text-to-video", "image-to-video", "first-last-frame", "reference-to-video"],
    supported_resolutions: ["480p", "720p", "1080p"],
    supported_aspect_ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
    supported_durations_seconds: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    generate_audio: true,
    input_limits: {
      image: { max_count: 9, supported_sources: ["url"] },
      video: { max_count: 3, supported_sources: ["url"] },
      audio: { max_file_size_mb: 15, supported_sources: ["url"] },
    },
  },
};

const FACTS = gatewayVideoFacts(ENTRY);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const provider = { id: "vercel", label: "Vercel AI Gateway" };

function standIn() {
  const started: VideoCallOptions[] = [];
  const checked: unknown[] = [];
  let status: VideoStatusResult["status"] = "pending";
  const response = () => ({ timestamp: new Date(0), modelId: "maker/clip-2", headers: undefined });
  const model: ProviderVideoModel = {
    specificationVersion: "v4",
    provider: "gateway",
    modelId: "maker/clip-2",
    maxVideosPerCall: Number.MAX_SAFE_INTEGER,
    doGenerate: async () => {
      throw new Error("not used");
    },
    async doStart(options): Promise<VideoStartResult> {
      started.push(options);
      return { operation: { id: "job-1" }, warnings: [], response: response() };
    },
    async doStatus({ operation }): Promise<VideoStatusResult> {
      checked.push(operation);
      if (status === "completed") {
        return {
          status,
          videos: [{ type: "url", url: "https://cdn.example.test/clip.mp4", mediaType: "video/mp4" }],
          warnings: [],
          response: response(),
        };
      }
      if (status === "error") return { status, error: "refused", response: response() };
      return { status: "pending", response: response() };
    },
  };
  return { model, started, checked, finish: (next: VideoStatusResult["status"]) => (status = next) };
}

function fakeSharing() {
  const unshared: string[][] = [];
  let next = 0;
  const sharing: LinkSharing = {
    share: vi.fn(async ({ mediaType }) => {
      next += 1;
      return { key: `pragma-shared/${next}`, url: `https://bucket.example.test/${next}?signed&type=${mediaType}` };
    }),
    unshare: vi.fn(async (keys) => {
      unshared.push([...keys]);
    }),
  };
  return { sharing, unshared };
}

function adapter(
  model: ProviderVideoModel,
  options: { facts?: GatewayVideoFacts; sharing?: LinkSharing | undefined } = {},
): ProviderVideoModel {
  return gatewayVideoModel(provider, "maker/clip-2", {
    open: async () => model,
    facts: async () => ("facts" in options ? options.facts : FACTS),
    sharing: async () => options.sharing,
  });
}

describe("gatewayVideoFacts", () => {
  it("reads frames, reference kinds, sizes, lengths, ratios and the audio switch from a list entry", () => {
    expect(FACTS).toEqual({
      name: "Clip 2",
      takes: { references: ["image", "video"], frames: ["start", "end"] },
      resolutions: ["480p", "720p", "1080p"],
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
      aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
      settings: [{ name: "generate_audio", kind: "switch" }],
    });
  });

  it("takes a start frame alone from an image-to-video model, and nothing a list entry leaves out", () => {
    const facts = gatewayVideoFacts({ id: "m", video_capabilities: { supported_operations: ["image-to-video"] } });
    expect(facts).toEqual({
      takes: { references: [], frames: ["start"] },
      resolutions: [],
      durations: [],
      aspectRatios: [],
      settings: [],
    });
  });
});

describe("gatewayVideoCatalog", () => {
  it("lists the video models alone, reusing the answer for ten minutes, never a failed one", async () => {
    let now = 0;
    const fetch = vi.fn(async () => Response.json({ data: [ENTRY, { id: "maker/still", type: "image" }] }));
    const gateway = { baseURL: "https://catalog.example.test", label: "Gateway" };
    const first = await gatewayVideoCatalog(gateway, { fetch, now: () => now });
    expect([...first.keys()]).toEqual(["maker/clip-2"]);
    expect(fetch).toHaveBeenCalledWith("https://catalog.example.test/v1/models");
    now += 9 * 60_000;
    await gatewayVideoCatalog(gateway, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await gatewayVideoCatalog(gateway, { fetch, now: () => now });
    expect(fetch).toHaveBeenCalledTimes(2);

    const failing = { baseURL: "https://failing.example.test", label: "Gateway" };
    const refuse = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(gatewayVideoCatalog(failing, { fetch: refuse })).rejects.toThrow("Gateway's model list answered 503.");
    await expect(gatewayVideoCatalog(failing, { fetch: refuse })).rejects.toThrow();
    expect(refuse).toHaveBeenCalledTimes(2);
  });
});

describe("gatewayVideoModel", () => {
  it("fits a request to what the model takes, saying each change, and sends its frame as a link", async () => {
    const { model, started } = standIn();
    const { sharing } = fakeSharing();
    const job = await startVideoJob(adapter(model, { sharing }), {
      prompt: "a red cup",
      startFrame: PNG,
      resolution: resolutionSize(480),
      duration: 3,
      aspectRatio: "3:2",
      modelSettings: { generate_audio: false, mode: "omni" },
    });
    const sent = started[0];
    expect(sent.resolution).toBe("864x480");
    expect(sent.duration).toBe(4);
    expect(sent.aspectRatio).toBe("4:3");
    expect(sent.generateAudio).toBe(false);
    expect(sent.providerOptions).toEqual({});
    expect(sent.frameImages).toEqual([
      {
        frameType: "first_frame",
        image: { type: "url", url: "https://bucket.example.test/1?signed&type=image/png", mediaType: "image/png" },
      },
    ]);
    expect(job.warnings).toEqual([
      "duration: asked for 3 s, used 4 s (the nearest maker/clip-2 makes)",
      "aspect_ratio: asked for 3:2, used 4:3 (the nearest maker/clip-2 makes)",
      "mode: maker/clip-2 takes none, so it was left out",
    ]);
    expect(job.operation).toEqual({ job: { id: "job-1" }, shared: ["pragma-shared/1"] });
    expect(job.settings).toEqual({ aspectRatio: "4:3", resolution: "480p", duration: 4 });
  });

  it("goes to the nearest size the model lists, and leaves out a size where it lists none", async () => {
    const { model, started } = standIn();
    const job = await startVideoJob(adapter(model), { prompt: "p", resolution: resolutionSize(2160) });
    expect(started[0].resolution).toBe("1920x1080");
    expect(job.warnings).toEqual(["resolution: asked for 4K, used 1080p (the nearest maker/clip-2 makes)"]);

    const sizeless = standIn();
    const left = await startVideoJob(adapter(sizeless.model, { facts: { ...FACTS, resolutions: [] } }), {
      prompt: "p",
      resolution: resolutionSize(720),
    });
    expect(sizeless.started[0].resolution).toBeUndefined();
    expect(left.warnings).toEqual(["resolution: maker/clip-2 takes none, so it was left out"]);
  });

  it("still sends a size the gateway reads when its list can't be read", async () => {
    const { model, started } = standIn();
    const job = await startVideoJob(adapter(model, { facts: undefined }), {
      prompt: "p",
      resolution: resolutionSize(480),
      duration: 3,
    });
    expect(started[0].resolution).toBe("864x480");
    expect(started[0].duration).toBe(3);
    expect(job.warnings).toEqual([]);
  });

  it("refuses a request with files when Sharing isn't set up, before the gateway is asked", async () => {
    const { model, started } = standIn();
    const refusal = await startVideoJob(adapter(model, { sharing: undefined }), {
      prompt: "p",
      references: [{ mediaType: "image/png", data: PNG }],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe(
      "Vercel AI Gateway takes frames and references as links. Set up Sharing in Settings.",
    );
    expect(setupNeedOf(refusal)).toEqual({ kind: "sharing" });
    expect(started).toEqual([]);
  });

  it("deletes what it shared when the gateway refuses the start, quoting no signed link", async () => {
    const { model } = standIn();
    model.doStart = async (options) => {
      const [reference] = options.inputReferences ?? [];
      throw new Error(`Couldn't fetch ${reference?.type === "url" ? reference.url : ""}.`);
    };
    const { sharing, unshared } = fakeSharing();
    await expect(
      startVideoJob(adapter(model, { sharing }), { prompt: "p", references: [{ mediaType: "image/png", data: PNG }] }),
    ).rejects.toThrow(/^Couldn't fetch https:\/\/bucket\.example\.test\/1\.$/);
    expect(unshared).toEqual([["pragma-shared/1"]]);
  });

  it("checks the gateway's own job, and deletes the shared files once it ends", async () => {
    const { model, checked, finish } = standIn();
    const { sharing, unshared } = fakeSharing();
    const gateway = adapter(model, { sharing });
    const operation = { job: { id: "job-1" }, shared: ["pragma-shared/1", "pragma-shared/2"] };
    expect(await checkVideoJob(gateway, operation)).toEqual({ status: "running" });
    expect(unshared).toEqual([]);
    finish("completed");
    expect(await checkVideoJob(gateway, operation)).toEqual({
      status: "completed",
      video: { type: "url", url: "https://cdn.example.test/clip.mp4", mediaType: "video/mp4" },
    });
    expect(checked).toEqual([{ id: "job-1" }, { id: "job-1" }]);
    expect(unshared).toEqual([["pragma-shared/1", "pragma-shared/2"]]);
  });
});
