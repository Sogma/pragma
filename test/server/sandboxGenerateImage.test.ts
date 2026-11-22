import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockImageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { GenerateImageRequestBody } from "../../src/protocol/api.ts";
import type { ImageCallOptions, ProviderImageJobs } from "../../src/protocol/imageGeneration.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { createJobRunner } from "../../src/server/jobRunner.ts";
import type { JobRecord, JobStore } from "../../src/server/jobs.ts";
import type { ResolvedImageModel } from "../../src/server/mediaModels.ts";
import {
  performSandboxGenerateImage,
  readSandboxDocument,
  type SandboxDocument,
  SandboxRequestError,
  startSandboxGenerateImage,
} from "../../src/server/sandbox.ts";

// The server half of a Generate Image node: the grant, the folder, and reuse
// by input digest. A mock model stands in for the configured providers.

const FLOW = `<!DOCTYPE html><html data-format="flow" data-format-version="1.0" data-id="flow_g"><head><script type="application/json" data-role="graph">${JSON.stringify(
  {
    nodes: [{ id: "n1", type: "generateImage", position: { x: 0, y: 0 }, config: { outputFolderPath: "art" } }],
    edges: [],
  },
)}</script></head><body></body></html>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let space: string;
let configDir: string;
let flow: SandboxDocument;
let calls: ImageCallOptions[];

const resolve = (): ResolvedImageModel => ({
  model: new MockImageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        images: [PNG],
        warnings: [{ type: "other", message: "aspect_ratio: asked for 16:10, used 3:2" }],
        providerMetadata: { test: { images: [{ cost: { amount: 0.12, unit: "credits" } }] } },
        response: { timestamp: new Date(), modelId: "m", headers: undefined },
      };
    },
  }),
  providerId: "test",
  modelId: "m",
});

const body = (fields: Partial<GenerateImageRequestBody> = {}): GenerateImageRequestBody => ({
  folder: "art",
  prompt: "A neon city at dusk, rain on the glass",
  references: [],
  aspectRatio: "16:10",
  ...fields,
});

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SandboxRequestError ? error.status : undefined;
  }
}

beforeEach(async () => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-generate-image-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-generate-image-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
  writeFileSync(path.join(space, "g.flow.html"), FLOW);
  mkdirSync(path.join(space, "art"));
  flow = await readSandboxDocument(space, "flow", "g.flow.html");
  calls = [];
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("performSandboxGenerateImage", () => {
  it("declares generateImage for the node's folder", async () => {
    expect(flow.capabilities.map((capability) => capability.key)).toEqual(["generateImage:space:art"]);
  });

  it("needs the folder declared and granted", async () => {
    expect(
      await statusOf(performSandboxGenerateImage(space, flow, body({ folder: "elsewhere" }), undefined, resolve)),
    ).toBe(400);
    expect(await statusOf(performSandboxGenerateImage(space, flow, body(), undefined, resolve))).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("generates into the folder, named by the prompt and a digest of the inputs", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const result = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);

    expect(result.reused).toBe(false);
    expect(result.path).toMatch(/^art\/image-[0-9a-f]{12}\.png$/);
    expect(result.image).toEqual({ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(result.warnings).toEqual(["aspect_ratio: asked for 16:10, used 3:2"]);
    expect(result.model).toBe("test/m");
    expect(result.cost).toEqual({ amount: 0.12, unit: "credits" });
    expect(readdirSync(path.join(space, "art"))).toEqual([path.basename(result.path)]);
    expect(calls[0]).toMatchObject({ prompt: "A neon city at dusk, rain on the glass", aspectRatio: "16:10" });
  });

  it("hands back the result already there for the same inputs, without a call", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    const again = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);

    expect(again).toMatchObject({ reused: true, path: first.path, model: "test/m", warnings: [] });
    expect(again.cost).toBeUndefined();
    expect(again.image).toEqual(first.image);
    expect(calls).toHaveLength(1);
  });

  // Runs go side by side, so a second Run can ask while the first is still
  // being made; a new prefix on the same inputs is the same image too.
  it("makes the image once for requests with the same inputs at once, the later ones finding it", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    let open = () => {};
    const gate = new Promise<void>((resolveGate) => {
      open = resolveGate;
    });
    const slow = (): ResolvedImageModel => ({
      ...resolve(),
      model: new MockImageModelV4({
        doGenerate: async (options) => {
          calls.push(options);
          await gate;
          return { images: [PNG], warnings: [], response: { timestamp: new Date(), modelId: "m", headers: undefined } };
        },
      }),
    });
    const all = Promise.all(
      [body(), body(), body({ prefix: "poster" })].map((sent) =>
        performSandboxGenerateImage(space, flow, sent, undefined, slow),
      ),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    open();
    const [first, second, poster] = await all;
    expect(calls).toHaveLength(1);
    expect([first.reused, second.reused, poster.reused]).toEqual([false, true, true]);
    expect(second.path).toBe(first.path);
    expect(poster.path).toMatch(/^art\/poster-[0-9a-f]{12}\.png$/);
    expect(second.image).toEqual(first.image);
  });

  it("makes a new file when the seed changes, keeping the old one", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    const second = await performSandboxGenerateImage(space, flow, body({ seed: "42" }), undefined, resolve);

    expect(second.reused).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(readdirSync(path.join(space, "art")).sort()).toEqual(
      [path.basename(first.path), path.basename(second.path)].sort(),
    );
    expect(calls[1].seed).toBe(42);
  });

  it('leads a result\'s name with its prefix in place of "image", keeping the digest', async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const result = await performSandboxGenerateImage(space, flow, body({ prefix: "shot-12" }), undefined, resolve);
    expect(result.path).toMatch(/^art\/shot-12-[0-9a-f]{12}\.png$/);
    expect(readdirSync(path.join(space, "art"))).toEqual([path.basename(result.path)]);
  });

  it("repairs a prefix into one file name inside the folder", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const titled = await performSandboxGenerateImage(
      space,
      flow,
      body({ prefix: "Scene 12: Rooftop" }),
      undefined,
      resolve,
    );
    expect(titled.path).toMatch(/^art\/Scene 12 - Rooftop-[0-9a-f]{12}\.png$/);
    const climbing = await performSandboxGenerateImage(
      space,
      flow,
      body({ prefix: "../../etc/passwd.png", seed: "2" }),
      undefined,
      resolve,
    );
    expect(climbing.path).toMatch(/^art\/etc-passwd-[0-9a-f]{12}\.png$/);
    expect(readdirSync(path.join(space, "art"))).toHaveLength(2);
  });

  it("copies the image to a new prefix on the same inputs, without a call", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body({ prefix: "hero" }), undefined, resolve);
    const renamed = await performSandboxGenerateImage(space, flow, body({ prefix: "poster" }), undefined, resolve);

    expect(calls).toHaveLength(1);
    expect(renamed).toMatchObject({ reused: true, warnings: [] });
    expect(renamed.path).toBe(first.path.replace("art/hero-", "art/poster-"));
    expect(renamed.image).toEqual(first.image);
    expect(readdirSync(path.join(space, "art")).sort()).toEqual(
      [path.basename(first.path), path.basename(renamed.path)].sort(),
    );
  });

  it("takes a prefix differing only in case as the same file", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body({ prefix: "Hero" }), undefined, resolve);
    const again = await performSandboxGenerateImage(space, flow, body({ prefix: "hero" }), undefined, resolve);
    expect(again).toMatchObject({ reused: true, path: first.path });
    expect(readdirSync(path.join(space, "art"))).toHaveLength(1);
  });

  // Results named before the prefix, after the prompt's first words, are
  // matched by the digest alone, so a Run on the same inputs still pays nothing.
  it("finds a result named by the prompt's words, as results once were", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    const older = first.path.replace("art/image-", "art/a-neon-city-at-dusk-rain-");
    renameSync(path.join(space, first.path), path.join(space, older));
    const again = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    expect(again).toMatchObject({ reused: true, path: older });
    expect(calls).toHaveLength(1);
  });

  // A result is found by its name alone, and a cloned or synced space can
  // carry a link under one (docs/protocol.md, Symbolic links).
  const linkOut = (result: string) => {
    const secret = path.join(configDir, "secret.txt");
    writeFileSync(secret, "SECRET");
    rmSync(path.join(space, result));
    symlinkSync(secret, path.join(space, result));
  };

  it("refuses a link holding the result's own name, before calling the model", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    linkOut(first.path);

    await expect(performSandboxGenerateImage(space, flow, body(), undefined, resolve)).rejects.toMatchObject({
      status: 403,
      message: `"${path.basename(first.path)}" is a symbolic link, and Pragma follows none inside a space or library`,
    });
    expect(calls).toHaveLength(1);
    expect(lstatSync(path.join(space, first.path)).isSymbolicLink()).toBe(true);
  });

  it("never reads or copies a result through a link under another prefix", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const first = await performSandboxGenerateImage(space, flow, body(), undefined, resolve);
    linkOut(first.path);

    const poster = await performSandboxGenerateImage(space, flow, body({ prefix: "poster" }), undefined, resolve);
    expect(poster.reused).toBe(false);
    expect(poster.image.data).toBe(Buffer.from(PNG).toString("base64"));
    expect([...readFileSync(path.join(space, poster.path))]).toEqual([...PNG]);
    expect(calls).toHaveLength(2);
  });

  const reference = (pin: number) => ({ pin, mediaType: "image/png", data: Buffer.from(PNG).toString("base64") });
  const resolveAs = (modelId: string) => (): ResolvedImageModel => ({ ...resolve(), modelId });

  it("sends each mention as its image's place, in the model's own words, else the default ones", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const pinned = body({ prompt: "Light @image_3 like @image_1", references: [reference(1), reference(3)] });
    await performSandboxGenerateImage(space, flow, pinned, undefined, resolve);
    // OpenAI's prompting guide names each input "image 1" and on.
    await performSandboxGenerateImage(space, flow, pinned, undefined, resolveAs("gpt-image-1"));

    expect(calls.map((call) => call.prompt)).toEqual([
      "Light reference image 2 like reference image 1",
      "Light image 2 like image 1",
    ]);
    expect(calls[0].files).toHaveLength(2);
  });

  it("finds a result made when the node sent its prompt already spelled", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const references = [reference(1), reference(3)];
    const spelled = body({ prompt: "Light reference image 2 like reference image 1", references });
    const first = await performSandboxGenerateImage(space, flow, spelled, undefined, resolve);
    const again = await performSandboxGenerateImage(
      space,
      flow,
      body({ prompt: "Light @image_3 like @image_1", references }),
      undefined,
      resolve,
    );

    expect(again).toMatchObject({ reused: true, path: first.path });
    expect(calls).toHaveLength(1);
  });

  it("leaves out references past the number the model takes, and refuses a prompt naming one", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const references = [reference(1), reference(2), reference(5), reference(6)];
    const nanoBanana = resolveAs("gemini-2.5-flash-image");
    const result = await performSandboxGenerateImage(
      space,
      flow,
      body({ prompt: "@image_5 in the style of @image_1", references }),
      undefined,
      nanoBanana,
    );

    expect(calls[0].files).toHaveLength(3);
    expect(result.warnings[0]).toBe("test/gemini-2.5-flash-image takes 3 reference images, so image_6 was left out");
    await expect(
      performSandboxGenerateImage(space, flow, body({ prompt: "Use @image_6", references }), undefined, nanoBanana),
    ).rejects.toThrow("The prompt names @image_6, but test/gemini-2.5-flash-image takes 3 reference images");
  });

  it("refuses a folder that isn't there", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    rmSync(path.join(space, "art"), { recursive: true });
    expect(await statusOf(performSandboxGenerateImage(space, flow, body(), undefined, resolve))).toBe(400);
  });
});

describe("an image a provider makes as a job", () => {
  // A provider whose images are jobs: started at once, done once `ready`
  // says so, at the second check unless a test says otherwise.
  function jobProvider(ready: (checks: number) => boolean = (checks) => checks >= 2) {
    const records = new Map<string, JobRecord>();
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
    const starts: unknown[] = [];
    let checks = 0;
    const jobs: ProviderImageJobs = {
      start: async (request) => {
        starts.push(request);
        return {
          operation: { jobId: "img-1" },
          warnings: ["aspect_ratio: asked for 16:10, used 3:2"],
          notes: ["quality: used 2k (default for model)"],
          quote: { amount: 2, unit: "credits" },
          settings: { aspectRatio: "3:2" },
        };
      },
      check: async () =>
        !ready(++checks)
          ? { status: "running" }
          : {
              status: "completed",
              image: { type: "base64", data: Buffer.from(PNG).toString("base64"), mediaType: "image/png" },
            },
    };
    const resolveJobs = (): ResolvedImageModel => ({ ...resolve(), jobs });
    const runner = createJobRunner({
      store: () => store,
      resolve: () => {
        throw new Error("no video models here");
      },
      resolveImage: resolveJobs,
      sleep: () => new Promise((wake) => setTimeout(wake, 1)),
      now: Date.now,
      spaceRoot: (spaceId) => loadGlobalConfig().spaces?.[spaceId]?.path,
    });
    return { records, starts, resolveJobs, runner, checks: () => checks };
  }

  it("records the job and saves its image with nobody waiting, never making it within the request", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const { records, starts, resolveJobs, runner } = jobProvider();
    const started = await startSandboxGenerateImage(space, flow, body(), undefined, resolveJobs, runner);
    if ("found" in started) throw new Error("expected a job");
    expect(started.job).toMatchObject({
      kind: "image",
      stage: "running",
      model: "test/m",
      folderName: "art",
      settings: { aspectRatio: "3:2" },
    });
    expect(starts).toEqual([
      { prompt: "A neon city at dusk, rain on the glass", references: [], aspectRatio: "16:10", seed: undefined },
    ]);
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect([...records.values()][0]?.stage).toBe("saved"));
    expect(readdirSync(path.join(space, "art"))).toEqual([expect.stringMatching(/^image-[0-9a-f]{12}\.png$/)]);

    // The same inputs again find the saved image, paying nothing.
    const again = await performSandboxGenerateImage(space, flow, body(), undefined, resolveJobs, runner);
    expect(again).toMatchObject({ reused: true });
    expect(starts).toHaveLength(1);
  });

  it("records the id the start was sent with on its job", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const { resolveJobs, runner } = jobProvider();
    const started = await startSandboxGenerateImage(
      space,
      flow,
      body({ startId: "start-1" }),
      undefined,
      resolveJobs,
      runner,
    );
    if ("found" in started) throw new Error("expected a job");
    expect(started.job.startId).toBe("start-1");
  });

  it("waits on the job in-process for a headless run, and hands back the image and what it cost", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    const { resolveJobs, runner } = jobProvider();
    const result = await performSandboxGenerateImage(space, flow, body(), undefined, resolveJobs, runner);
    expect(result).toMatchObject({
      image: { mediaType: "image/png", data: Buffer.from(PNG).toString("base64") },
      model: "test/m",
      reused: false,
      warnings: ["aspect_ratio: asked for 16:10, used 3:2"],
      notes: ["quality: used 2k (default for model)"],
      cost: { amount: 2, unit: "credits" },
    });
    expect(result.path).toMatch(/^art\/image-[0-9a-f]{12}\.png$/);
  });

  it("saves the image of a headless run that stopped waiting, with no request left", async () => {
    await grantCapability(space, flow.subject, "generateImage:space:art");
    let finished = false;
    const { records, resolveJobs, runner, checks } = jobProvider(() => finished);
    const stop = new AbortController();
    const waiting = performSandboxGenerateImage(space, flow, body(), stop.signal, resolveJobs, runner);
    await vi.waitFor(() => expect(checks()).toBeGreaterThan(0));
    stop.abort(new Error("the run passed its 5m time limit"));
    await expect(waiting).rejects.toThrow(
      "Stopped waiting for the image: the run passed its 5m time limit. It is still being made, and Pragma saves it into art/ when it's done.",
    );

    finished = true;
    await vi.waitFor(() => expect([...records.values()][0]?.stage).toBe("saved"));
  });
});
