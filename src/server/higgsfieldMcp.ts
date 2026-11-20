import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedMcpServer } from "../config/loadConfig.ts";
import type { FrameKind } from "../protocol/flowNodes.ts";
import type {
  ImageCallResult,
  ImageCheck,
  ImageJob,
  ProviderImageJobs,
  ProviderImageModel,
} from "../protocol/imageGeneration.ts";
import {
  type DeclaredVideoInputs,
  jobSettings,
  type ProviderVideoModel,
  type VideoStartResult,
  type VideoStatusResult,
} from "../protocol/videoGeneration.ts";
import { nearestResolution, resolutionName, resolutionShortSide } from "../protocol/videoResolution.ts";
import { fetchPublic, type PublicFile } from "./fetchPublic.ts";
import { withMcpBearer } from "./mcpTools.ts";
import { uploadIdStore } from "./uploadIds.ts";

/**
 * Higgsfield's image and video models through its hosted MCP server, as SDK
 * models. Its tools are written for chat agents and carry no version, so this
 * uses as few as it can and checks every answer against the tool's declared
 * output schema: a changed server fails loudly rather than being misread.
 */

/** Reference image digest → Higgsfield media id, so an image uploads once. */
export interface MediaCache {
  get(digest: string): Promise<string | undefined>;
  set(digest: string, mediaId: string): Promise<void>;
  drop(digest: string): Promise<void>;
}

// The extension `media_upload` reads a file's kind from, where a media type's
// subtype isn't one; any other type goes as its subtype.
const UPLOAD_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "video/quicktime": "mov" };

// The kinds `media_confirm` takes for a generation's input.
const CONFIRM_TYPES = new Set(["image", "video", "audio"]);

export interface HiggsfieldDeps {
  mediaCache?: MediaCache;
  download?: (url: string, signal?: AbortSignal) => Promise<PublicFile>;
  // The presigned upload's PUT.
  putFn?: typeof fetch;
  // How long one check of a video job waits on it before saying it still runs.
  videoCheckMs?: number;
}

// A 4K PNG runs to tens of MB; this leaves room without inviting a runaway.
const MAX_RESULT_BYTES = 100 * 1024 * 1024;
// Longer than a generation takes to be accepted, and than one long poll.
const TOOL_TIMEOUT_MS = 120_000;
const VIDEO_CHECK_MS = 60_000;

type Fields = Record<string, unknown>;

// The server's own answer refusing a call, apart from a failure to ask it.
class Refusal extends Error {}

interface Upload {
  mediaType: string;
  data: string | Uint8Array;
  role: string;
}

type JobEnd = { resultUrl: string } | { failed: string };

// The installed upload-id store, as this server's media cache.
function uploadIdsOf(serverId: string): MediaCache {
  const store = uploadIdStore();
  return {
    get: (digest) => store.get(serverId, digest),
    set: (digest, mediaId) => store.set(serverId, digest, mediaId),
    drop: (digest) => store.drop(serverId, digest),
  };
}

// What the image and video models share: one connection's calls, the media
// cache, and the price-then-submit and wait each job goes through.
function higgsfieldSession(server: ResolvedMcpServer, deps: HiggsfieldDeps) {
  const mediaCache = deps.mediaCache ?? uploadIdsOf(server.id);
  const putFn = deps.putFn ?? fetch;

  async function open(bearer: string | undefined): Promise<Client> {
    const client = new Client({ name: "pragma", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
    });
    try {
      await client.connect(transport);
      // Listing caches each tool's output schema; the client checks every
      // call's answer against it from then on.
      await client.listTools();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async function call(client: Client, name: string, args: Fields, signal?: AbortSignal): Promise<Fields> {
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: TOOL_TIMEOUT_MS });
    const fields = (result.structuredContent ?? {}) as Fields;
    if (result.isError || typeof fields.error === "string") {
      const text = Array.isArray(result.content)
        ? result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
        : "";
      throw new Refusal(`${server.label} refused ${name}: ${String(fields.error ?? text) || "no reason given"}`);
    }
    return fields;
  }

  async function upload(client: Client, mediaType: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const [kind, subtype] = mediaType.split("/");
    const extension = UPLOAD_EXTENSIONS[mediaType] ?? (subtype || "png");
    const answer = await call(
      client,
      "media_upload",
      { filename: `reference.${extension}`, content_type: mediaType },
      signal,
    );
    const slot = (answer.uploads as Fields[] | undefined)?.[0];
    const uploadUrl = typeof slot?.upload_url === "string" ? slot.upload_url : undefined;
    const mediaId = typeof slot?.media_id === "string" ? slot.media_id : undefined;
    if (!uploadUrl || !mediaId) throw new Error(`${server.label} gave no address to upload a reference to.`);
    // A presigned URL carries temporary credentials: it never reaches a log.
    // The bytes go as they are, never copied: a clip can run to hundreds of MB.
    const put = await putFn(uploadUrl, {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: bytes as Uint8Array<ArrayBuffer>,
      signal,
    });
    if (!put.ok) throw new Error(`Uploading a reference to ${server.label} answered ${put.status}.`);
    await call(client, "media_confirm", { type: CONFIRM_TYPES.has(kind) ? kind : "image", media_id: mediaId }, signal);
    return mediaId;
  }

  async function medias(client: Client, uploads: Upload[], fresh: boolean, signal?: AbortSignal) {
    const placed: Array<{ value: string; role: string }> = [];
    const cachedDigests: string[] = [];
    for (const file of uploads) {
      const bytes = typeof file.data === "string" ? Buffer.from(file.data, "base64") : file.data;
      const digest = createHash("sha256").update(bytes).digest("hex");
      let mediaId = fresh ? undefined : await mediaCache.get(digest);
      if (mediaId) {
        cachedDigests.push(digest);
      } else {
        mediaId = await upload(client, file.mediaType, bytes, signal);
        await mediaCache.set(digest, mediaId);
      }
      placed.push({ value: mediaId, role: file.role });
    }
    return { placed, cachedDigests };
  }

  async function submit(
    client: Client,
    tool: "generate_image" | "generate_video",
    params: (placed: Array<{ value: string; role: string }>) => Fields,
    uploads: Upload[],
    signal: AbortSignal | undefined,
    fresh = false,
  ): Promise<{ submitted: Fields; sent: Fields; credits?: number }> {
    const { placed, cachedDigests } = await medias(client, uploads, fresh, signal);
    const request = params(placed);
    try {
      // No answer to a job says what it charged, so the price is asked first:
      // free, and it submits nothing.
      const quote = await call(client, tool, { params: { ...request, get_cost: true } }, signal);
      const credits = (quote.cost as Fields | undefined)?.credits_exact;
      const submitted = await call(client, tool, { params: request }, signal);
      return { submitted, sent: request, credits: typeof credits === "number" ? credits : undefined };
    } catch (error) {
      // A media id can go stale (another account, an expired upload): refused
      // once, the images upload afresh. Nothing was submitted, so nothing bills.
      if (fresh || cachedDigests.length === 0) throw error;
      for (const digest of cachedDigests) await mediaCache.drop(digest);
      return submit(client, tool, params, uploads, signal, true);
    }
  }

  function jobId(submitted: Fields): string {
    const id = (submitted.results as Fields[] | undefined)?.[0]?.id;
    if (typeof id !== "string") throw new Error(`${server.label} accepted the job but named no job id.`);
    return id;
  }

  // What the server changed, split by whom it concerns. `changed` is a
  // setting the node sent, for the node to show. `decided` goes to the
  // Console alone, as the adapter's `notes`: the server's pick for a setting
  // it wasn't sent (a default, the mode a frame needs), which asked for
  // nothing, and a seed a model ignores, which Regenerate's seed outlives.
  function adjustments(submitted: Fields, sent: Fields): { changed: string[]; decided: string[] } {
    const changed: string[] = [];
    const decided: string[] = [];
    for (const [key, change] of Object.entries((submitted.adjustments ?? {}) as Record<string, Fields>)) {
      const setting = key.replace(/^params\./, "");
      const used = `used ${String(change.used)} (${String(change.reason)})`;
      const asked = `${setting}: asked for ${String(change.requested)}, ${used}`;
      if (!(setting in sent)) decided.push(`${setting}: ${used}`);
      else if (/(^|\.)seed$/.test(setting) && change.used === "omitted") decided.push(asked);
      else changed.push(asked);
    }
    return { changed, decided };
  }

  // The settings a job runs with: each one sent, or filled in by the server,
  // as the server used it.
  function used(submitted: Fields, sent: Fields): Fields {
    const settings: Fields = { ...sent };
    for (const [key, change] of Object.entries((submitted.adjustments ?? {}) as Record<string, Fields>)) {
      settings[key.replace(/^params\./, "")] = change.used;
    }
    return settings;
  }

  // Waits on a job until it ends, or until `deadline` passes with it still
  // running. Once a job is submitted, stopping only stops the wait: no tool
  // cancels a job, so the error says it still bills.
  async function waitFor(
    client: Client,
    id: string,
    signal?: AbortSignal,
    deadline = Infinity,
  ): Promise<JobEnd | undefined> {
    const stopped = () =>
      new Error(`Stopped waiting for ${server.label}. The job will still finish, and be billed.`, {
        cause: signal?.reason,
      });
    while (Date.now() < deadline) {
      if (signal?.aborted) throw stopped();
      let answer: Fields;
      try {
        answer = await call(client, "jobs_wait", { jobs: [{ index: 0, job_id: id }], timeout_seconds: 15 }, signal);
      } catch (error) {
        if (signal?.aborted) throw stopped();
        throw error;
      }
      const job = (answer.jobs as Fields[] | undefined)?.[0];
      if (job?.status === "completed" && typeof job.result_url === "string") return { resultUrl: job.result_url };
      // A job ends in more ways than "failed": canceled, refused as nsfw, and
      // others. Whichever it was, the person reads its name.
      if (job?.status === "failed" || job?.error || answer.all_terminal === true) {
        const reason = job?.error ? `: ${String(job.error)}` : "";
        return { failed: `${server.label}'s job ended as "${String(job?.status ?? "unknown")}"${reason}.` };
      }
      const pause = Math.max(0, Number(answer.poll_after_seconds ?? 2) * 1000);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pause);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    return undefined;
  }

  // What a model's catalog entry declares: the frame roles it takes, such as
  // start_image, the resolutions it lists, in its own names (`720p`, or
  // Minimax's `768`), and its `mode` options. A model that picks its own
  // resolution lists none.
  async function details(client: Client, modelId: string, signal?: AbortSignal) {
    const entry = await call(client, "models_explore", { action: "get", model_id: modelId }, signal);
    const parameters = Array.isArray(entry.parameters) ? (entry.parameters as Fields[]) : [];
    const listed = (name: string) => {
      const options = parameters.find((parameter) => parameter.name === name)?.options;
      return Array.isArray(options) ? options.map(String) : [];
    };
    return { roles: rolesOf(entry), resolutions: listed("resolution"), modes: listed("mode") };
  }

  return {
    // Only the connection retries on a 401: a retry after submitting would
    // pay for a second job.
    connect: () => withMcpBearer(server, open),
    submit,
    jobId,
    adjustments,
    used,
    waitFor,
    details,
  };
}

export function higgsfieldImageModel(
  server: ResolvedMcpServer,
  modelId: string,
  deps: HiggsfieldDeps = {},
): ProviderImageModel {
  const session = higgsfieldSession(server, deps);
  const download = deps.download ?? ((url, signal) => fetchPublic(url, { maxBytes: MAX_RESULT_BYTES, signal }));

  return {
    specificationVersion: "v4",
    provider: "higgsfield-mcp",
    modelId,
    // One image per job; the SDK splits a request for more into calls.
    maxImagesPerCall: 1,
    async doGenerate(options): Promise<ImageCallResult> {
      const warnings: ImageCallResult["warnings"] = [];
      if (options.size)
        warnings.push({ type: "unsupported", feature: "size", details: "Higgsfield takes an aspect ratio." });
      if (options.mask) warnings.push({ type: "unsupported", feature: "mask" });

      const client = await session.connect();
      try {
        const uploads = (options.files ?? []).map((file): Upload => {
          if (file.type !== "file") throw new Error(`${server.label} takes reference images as bytes, not links.`);
          return { mediaType: file.mediaType, data: file.data, role: "image" };
        });
        const { submitted, sent, credits } = await session.submit(
          client,
          "generate_image",
          (placed) => imageParams(modelId, options, placed),
          uploads,
          options.abortSignal,
        );
        const id = session.jobId(submitted);
        const { changed, decided } = session.adjustments(submitted, sent);
        for (const message of changed) warnings.push({ type: "other", message });
        const end = await session.waitFor(client, id, options.abortSignal);
        if (!end || "failed" in end) throw new Error(end?.failed ?? `${server.label}'s job never ended.`);
        const file = await download(end.resultUrl, options.abortSignal);
        return {
          images: [file.bytes],
          warnings,
          providerMetadata: {
            [server.id]: {
              images: [
                {
                  jobId: id,
                  ...(credits !== undefined ? { cost: { amount: credits, unit: "credits" } } : {}),
                  ...(decided.length ? { notes: decided } : {}),
                },
              ],
            },
          },
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

// An image request's own settings, from the SDK's call or a job's start.
interface ImageSettings {
  prompt?: string;
  aspectRatio?: string;
  seed?: number;
}

function imageParams(modelId: string, options: ImageSettings, placed: Array<{ value: string; role: string }>) {
  return {
    model: modelId,
    prompt: options.prompt ?? "",
    count: 1,
    // Free-trial generations come as a question instead of a job; the
    // plan's credits never do.
    use_unlim: false,
    ...(options.aspectRatio ? { aspect_ratio: wholeRatio(options.aspectRatio) } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(placed.length ? { medias: placed } : {}),
  };
}

/** One Higgsfield image model's jobs, started and checked as two calls, as
 * its video jobs are: the operation is the job id, which any later
 * connection can wait on, so a host can record it and save the image after
 * the request that started it has gone. */
export function higgsfieldImageJobs(
  server: ResolvedMcpServer,
  modelId: string,
  deps: HiggsfieldDeps = {},
): ProviderImageJobs {
  const session = higgsfieldSession(server, deps);
  return {
    async start(request): Promise<ImageJob> {
      const client = await session.connect();
      try {
        const uploads = request.references.map(
          (reference): Upload => ({ mediaType: reference.mediaType, data: reference.data, role: "image" }),
        );
        const { submitted, sent, credits } = await session.submit(
          client,
          "generate_image",
          (placed) => imageParams(modelId, request, placed),
          uploads,
          undefined,
        );
        const id = session.jobId(submitted);
        const { changed, decided } = session.adjustments(submitted, sent);
        return {
          operation: { jobId: id },
          warnings: changed,
          notes: decided,
          ...(credits !== undefined ? { quote: { amount: credits, unit: "credits" } } : {}),
          // The ratio alone: an image model's 2K is no video size.
          settings: jobSettings({ aspectRatio: session.used(submitted, sent).aspect_ratio }),
        };
      } finally {
        await client.close().catch(() => {});
      }
    },
    async check(operation, signal): Promise<ImageCheck> {
      const id = (operation as { jobId?: unknown } | null)?.jobId;
      if (typeof id !== "string") return { status: "failed", error: "This job names no Higgsfield job id." };
      const client = await session.connect();
      try {
        const end = await session.waitFor(client, id, signal, Date.now() + (deps.videoCheckMs ?? VIDEO_CHECK_MS));
        if (!end) return { status: "running" };
        if ("failed" in end) return { status: "failed", error: end.failed };
        return {
          status: "completed",
          image: { type: "url", url: end.resultUrl, mediaType: imageTypeOf(end.resultUrl) },
        };
      } catch (error) {
        // As a video job's check: a job the server won't name is over.
        if (error instanceof Refusal) return { status: "failed", error: error.message };
        throw error;
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

function imageTypeOf(url: string): string {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return extension === "webp" ? "image/webp" : "image/png";
}

// The role each of the SDK's frames goes in, and the node input it came from.
const FRAMES = {
  first_frame: { role: "start_image", input: "start_frame" },
  last_frame: { role: "end_image", input: "end_frame" },
} as const;

// The role a reference goes in, by its media type's kind.
const REFERENCE_ROLES: Record<string, string> = {
  image: "image_references",
  video: "video_references",
  audio: "audio_references",
};

// The task a job's inputs ask for, in each spelling a model's `mode` lists
// it. Without one the server keeps its default, which on some models is a
// text-only mode that refuses references. A `mode` naming none of these is a
// quality tier and is left alone; edit and extend are never picked.
const TASK_MODES = {
  references: ["reference-to-video", "omni_reference"],
  frames: ["image-to-video"],
  text: ["text-to-video", "t2v"],
} as const;

/** The `mode` a job's placed inputs ask for among `modes`, a model's own
 * options, or undefined when it lists no such task. */
export function taskMode(
  modes: readonly string[],
  placed: { references: boolean; frames: boolean },
): string | undefined {
  const task = placed.references ? "references" : placed.frames ? "frames" : "text";
  return TASK_MODES[task].find((spelling) => modes.includes(spelling));
}

// What each video model's catalog entry declares, kept a while: a run asks
// before it names its result, and an unchanged Run otherwise asks nothing.
const DECLARED_TTL_MS = 10 * 60_000;
const declaredInputs = new Map<string, { at: number; inputs: DeclaredVideoInputs }>();

// What a video model takes, by the roles its catalog entry declares: the
// same roles its job start places inputs by.
function declaredFromRoles(roles: readonly string[]): DeclaredVideoInputs {
  const frames: FrameKind[] = [
    ...(roles.includes(FRAMES.first_frame.role) ? (["start"] as const) : []),
    ...(roles.includes(FRAMES.last_frame.role) ? (["end"] as const) : []),
  ];
  const references = (["image", "video", "audio"] as const).filter((kind) => roles.includes(REFERENCE_ROLES[kind]));
  return { references, frames };
}

function rolesOf(entry: Fields): string[] {
  const medias = Array.isArray(entry.medias) ? (entry.medias as Fields[]) : [];
  return medias.flatMap((media) => (Array.isArray(media.roles) ? media.roles.map(String) : []));
}

/** What one of this server's video models takes, read from the roles its catalog entry
 * declares. */
export function higgsfieldVideoInputs(
  server: ResolvedMcpServer,
  modelId: string,
  deps: HiggsfieldDeps = {},
): (signal?: AbortSignal) => Promise<DeclaredVideoInputs> {
  const session = higgsfieldSession(server, deps);
  const key = `${server.id}\n${modelId}`;
  return async (signal) => {
    const kept = declaredInputs.get(key);
    if (kept && Date.now() - kept.at < DECLARED_TTL_MS) return kept.inputs;
    const client = await session.connect();
    try {
      const { roles } = await session.details(client, modelId, signal);
      const inputs = declaredFromRoles(roles);
      declaredInputs.set(key, { at: Date.now(), inputs });
      return inputs;
    } finally {
      await client.close().catch(() => {});
    }
  };
}

/** One Higgsfield video model. Its jobs run minutes, so it starts a job and
 * checks it as two calls: the operation is the job id, which any later
 * connection can wait on. No video model takes a seed (a model may refuse
 * the whole job over one), so a seed asked for is never sent. */
export function higgsfieldVideoModel(
  server: ResolvedMcpServer,
  modelId: string,
  deps: HiggsfieldDeps = {},
): ProviderVideoModel {
  const session = higgsfieldSession(server, deps);
  const response = () => ({ timestamp: new Date(), modelId, headers: undefined });

  return {
    specificationVersion: "v4",
    provider: "higgsfield-mcp",
    modelId,
    maxVideosPerCall: 1,
    async doStart(options): Promise<VideoStartResult> {
      const warnings: VideoStartResult["warnings"] = [];
      const unsent = { fps: options.fps, seed: options.seed };
      for (const [feature, value] of Object.entries(unsent)) {
        if (value !== undefined) warnings.push({ type: "unsupported", feature });
      }
      if (options.generateAudio !== undefined) warnings.push({ type: "unsupported", feature: "generateAudio" });
      const leftOut = (input: string) => ({
        type: "other" as const,
        message: `${input}: ${modelId} takes none, so it was left out`,
      });

      const client = await session.connect();
      try {
        // A frame or resolution the model doesn't list is left out and said
        // so, as a setting the server changes is: sent, it could refuse the
        // job. A resolution it lacks goes to the nearest one it lists.
        const declared = await session.details(client, modelId, options.abortSignal);
        const frames =
          options.frameImages ?? (options.image ? [{ image: options.image, frameType: "first_frame" as const }] : []);
        const uploads: Upload[] = [];
        for (const frame of frames) {
          const { role, input } = FRAMES[frame.frameType];
          if (!declared.roles.includes(role)) {
            warnings.push(leftOut(input));
            continue;
          }
          if (frame.image.type !== "file") throw new Error(`${server.label} takes frames as bytes, not links.`);
          uploads.push({ mediaType: frame.image.mediaType, data: frame.image.data, role });
        }
        const unplaced = new Set<string>();
        for (const reference of options.inputReferences ?? []) {
          if (reference.type !== "file") throw new Error(`${server.label} takes references as bytes, not links.`);
          const kind = reference.mediaType.split("/")[0];
          const role = REFERENCE_ROLES[kind];
          if (role && declared.roles.includes(role))
            uploads.push({ mediaType: reference.mediaType, data: reference.data, role });
          else unplaced.add(kind);
        }
        for (const kind of unplaced) warnings.push(leftOut(`${kind} references`));
        const mode = taskMode(declared.modes, {
          references: uploads.some((upload) => Object.values(REFERENCE_ROLES).includes(upload.role)),
          frames: uploads.some(
            (upload) => upload.role === FRAMES.first_frame.role || upload.role === FRAMES.last_frame.role,
          ),
        });
        const asked = options.resolution ? resolutionShortSide(options.resolution) : undefined;
        const resolution = asked ? nearestResolution(asked, declared.resolutions) : undefined;
        if (options.resolution && !resolution) warnings.push(leftOut("resolution"));
        else if (asked && resolution && resolutionShortSide(resolution) !== asked) {
          const message = `resolution: asked for ${resolutionName(asked)}, used ${resolution} (closest supported resolution)`;
          warnings.push({ type: "other", message });
        }
        const { submitted, sent, credits } = await session.submit(
          client,
          "generate_video",
          (placed) => ({
            model: modelId,
            prompt: options.prompt ?? "",
            count: 1,
            use_unlim: false,
            ...(options.aspectRatio && options.aspectRatio !== "adaptive"
              ? { aspect_ratio: wholeRatio(options.aspectRatio) }
              : {}),
            ...(resolution ? { resolution } : {}),
            ...(mode ? { mode } : {}),
            ...(options.duration !== undefined ? { duration: Math.round(options.duration) } : {}),
            ...(placed.length ? { medias: placed } : {}),
          }),
          uploads,
          options.abortSignal,
        );
        const id = session.jobId(submitted);
        const { changed, decided } = session.adjustments(submitted, sent);
        for (const message of changed) warnings.push({ type: "other", message });
        const settings = session.used(submitted, sent);
        return {
          operation: { jobId: id },
          warnings,
          providerMetadata: {
            [server.id]: {
              jobId: id,
              ...(credits !== undefined ? { cost: { amount: credits, unit: "credits" } } : {}),
              ...(decided.length ? { notes: decided } : {}),
              settings: {
                ...jobSettings({
                  aspectRatio: settings.aspect_ratio,
                  resolution: settings.resolution,
                  duration: settings.duration,
                }),
              },
            },
          },
          response: response(),
        };
      } finally {
        await client.close().catch(() => {});
      }
    },
    async doStatus({ operation, abortSignal }): Promise<VideoStatusResult> {
      const id = (operation as { jobId?: unknown } | null)?.jobId;
      if (typeof id !== "string")
        return { status: "error", error: "This job names no Higgsfield job id.", response: response() };
      const client = await session.connect();
      try {
        const end = await session.waitFor(client, id, abortSignal, Date.now() + (deps.videoCheckMs ?? VIDEO_CHECK_MS));
        if (!end) return { status: "pending", response: response() };
        if ("failed" in end) return { status: "error", error: end.failed, response: response() };
        return {
          status: "completed",
          videos: [{ type: "url", url: end.resultUrl, mediaType: videoTypeOf(end.resultUrl) }],
          warnings: [],
          response: response(),
        };
      } catch (error) {
        // A job the server won't name, from another account or long gone, is
        // over for good; a failure to ask leaves it to be asked again.
        if (error instanceof Refusal) return { status: "error", error: error.message, response: response() };
        throw error;
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

function videoTypeOf(url: string): string {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return extension === "webm" ? "video/webm" : extension === "mov" ? "video/quicktime" : "video/mp4";
}

// Higgsfield's ratios are whole numbers, so 1.85:1 goes as 37:20, the same
// ratio; the server then snaps it to the model's list as it does any other.
export function wholeRatio(ratio: string): string {
  const terms = ratio.split(":");
  const places = Math.max(...terms.map((term) => term.split(".")[1]?.length ?? 0));
  if (places === 0) return ratio;
  const [a, b] = terms.map((term) => Math.round(Number(term) * 10 ** places));
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const divisor = gcd(a, b) || 1;
  return `${a / divisor}:${b / divisor}`;
}

export interface ModelChoice {
  id: string;
  label: string;
  // What a video model's catalog entry declares it takes.
  takes?: DeclaredVideoInputs;
}

/** The models of one kind the server offers, for a node's model picker. The
 * list comes from the server, so a new model shows up without a pragma
 * release; a list answer is read loosely, taking any array of entries with
 * an id.
 *
 * A video model is listed only if it takes a start frame or reference
 * images: the list also holds edit tools, upscalers and dubbing, and nothing
 * else tells them apart. */
export async function higgsfieldModels(server: ResolvedMcpServer, type: "image" | "video"): Promise<ModelChoice[]> {
  const client = await withMcpBearer(server, async (bearer) => {
    const connecting = new Client({ name: "pragma", version: "1" });
    await connecting.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
      }),
    );
    return connecting;
  });
  try {
    const result = await client.callTool(
      { name: "models_explore", arguments: { action: "list", type, limit: 100 } },
      undefined,
      { timeout: TOOL_TIMEOUT_MS },
    );
    const fields = (result.structuredContent ?? {}) as Fields;
    const entries = Object.values(fields).find(
      (value): value is Fields[] => Array.isArray(value) && value.some((entry) => typeof entry?.id === "string"),
    );
    return (entries ?? [])
      .filter((entry) => typeof entry.id === "string" && (entry.output_type ?? type) === type)
      .filter((entry) => type === "image" || takesImages(entry))
      .map((entry) => ({
        id: String(entry.id),
        label: typeof entry.name === "string" ? entry.name : String(entry.id),
        ...(type === "video" ? { takes: declaredFromRoles(rolesOf(entry)) } : {}),
      }));
  } finally {
    await client.close().catch(() => {});
  }
}

function takesImages(entry: Fields): boolean {
  const declared = Array.isArray(entry.medias) ? (entry.medias as Fields[]) : [];
  return declared.some(
    (media) =>
      Array.isArray(media.roles) && (media.roles.includes("start_image") || media.roles.includes("image_references")),
  );
}
