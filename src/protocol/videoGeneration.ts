import { experimental_getVideoStatus, experimental_startVideo } from "ai";
import type { GenerationCost, JobSettings, ModelSettingValue } from "./api.ts";
import { isAspectRatio } from "./aspectRatio.ts";
import type { FrameKind } from "./flowNodes.ts";
import { describeWarning, notesOf } from "./imageGeneration.ts";
import { resolutionName, resolutionShortSide } from "./videoResolution.ts";

/**
 * A video model bound to a configured provider: the SDK's current video
 * interface, picked out of the models its start call takes. Excludes the
 * bare-string form, which would route through the SDK's hosted gateway.
 *
 * A clip is a job, started once and then checked until it ends, so a host
 * can keep a job's operation and wait on it again from a later request. A
 * request's model settings reach the start as `providerOptions.pragma`.
 *
 * An adapter's start result's `providerMetadata` record carries the price
 * the provider quoted as `cost: {amount, unit}`, what it decided about
 * settings it wasn't sent as `notes`, and what the job makes, its changes
 * applied, as `settings` (a `JobSettings`).
 */
export type ProviderVideoModel = Extract<
  Parameters<typeof experimental_startVideo>[0]["model"],
  { readonly specificationVersion: "v4" }
>;
export type VideoCallOptions = Parameters<NonNullable<ProviderVideoModel["doStart"]>>[0];
export type VideoStartResult = Awaited<ReturnType<NonNullable<ProviderVideoModel["doStart"]>>>;
export type VideoStatusResult = Awaited<ReturnType<NonNullable<ProviderVideoModel["doStatus"]>>>;
export type VideoOperation = VideoStartResult["operation"];

/** What a provider's catalog says a video model takes: which kinds of
 * reference, and which frames. A host asks before it names a result, so an
 * input the model would ignore never changes the name or rides into a paid
 * job. */
export interface DeclaredVideoInputs {
  references: Array<"image" | "video" | "audio">;
  frames: FrameKind[];
}
/** A finished clip Pragma can save. An "uploaded" clip is left out: the
 * provider delivered it to storage the caller manages, with no URL or bytes,
 * and Pragma never asks for that, so a job that ends that way fails. */
export type VideoData = Exclude<
  Extract<VideoStatusResult, { status: "completed" }>["videos"][number],
  { type: "uploaded" }
>;

export interface VideoRequest {
  prompt: string;
  startFrame?: Uint8Array;
  endFrame?: Uint8Array;
  // Never beside a frame: a model's call takes one or the other.
  references?: Array<{ mediaType: string; data: Uint8Array }>;
  aspectRatio?: `${number}:${number}`;
  resolution?: `${number}x${number}`;
  duration?: number;
  // The model's own settings, by the names its catalog gives them.
  modelSettings?: Record<string, ModelSettingValue>;
  signal?: AbortSignal;
}

export interface VideoJob {
  operation: VideoOperation;
  // What the provider changed or ignored, said for a person to read.
  warnings: string[];
  // What it decided on its own, about settings it wasn't sent.
  notes: string[];
  // The price the provider asked before taking the job.
  quote?: GenerationCost;
  // What the job makes, as the provider took the request; absent when the
  // adapter doesn't say.
  settings?: JobSettings;
}

/** What one check of a started job found: still going, its clip, or the
 * provider's own words for why it ended without one. A failure to ask
 * throws instead, since the job may still end well. */
export type VideoCheck =
  | { status: "running" }
  | { status: "completed"; video: VideoData }
  | { status: "failed"; error: string };

/** The one call that starts every video job, whatever the provider. */
export async function startVideoJob(model: ProviderVideoModel, request: VideoRequest): Promise<VideoJob> {
  const frameImages = [
    ...(request.startFrame ? [{ image: request.startFrame, frameType: "first_frame" as const }] : []),
    ...(request.endFrame ? [{ image: request.endFrame, frameType: "last_frame" as const }] : []),
  ];
  const references = request.references ?? [];
  const result = await experimental_startVideo({
    model,
    prompt: request.prompt,
    ...(frameImages.length ? { frameImages } : {}),
    ...(references.length ? { inputReferences: references } : {}),
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    duration: request.duration,
    ...(request.modelSettings && Object.keys(request.modelSettings).length
      ? { providerOptions: { pragma: request.modelSettings } }
      : {}),
    abortSignal: request.signal,
    // A retry submits a second job, and every job is paid for.
    maxRetries: 0,
  });
  const settings = Object.values(result.providerMetadata ?? {}).find(
    (record) => typeof (record as { settings?: unknown } | null)?.settings === "object",
  )?.settings;
  return {
    operation: result.operation,
    warnings: result.warnings.map(describeWarning),
    notes: Object.values(result.providerMetadata ?? {}).flatMap(notesOf),
    quote: costOf(result.providerMetadata),
    ...(settings ? { settings: jobSettings(settings) } : {}),
  };
}

/** An adapter's word on what a job makes, keeping only what reads as each
 * setting: a `W:H` ratio, a video size, said as `720p` or `4K` however the
 * provider wrote it, and a length in seconds. */
export function jobSettings(raw: unknown): JobSettings {
  const { aspectRatio, resolution, duration } = (raw ?? {}) as Record<string, unknown>;
  const side =
    typeof resolution === "string" || typeof resolution === "number"
      ? resolutionShortSide(String(resolution))
      : undefined;
  const seconds = typeof duration === "string" && /^\d+$/.test(duration) ? Number(duration) : duration;
  return {
    ...(typeof aspectRatio === "string" && isAspectRatio(aspectRatio) ? { aspectRatio } : {}),
    ...(side ? { resolution: resolutionName(side) } : {}),
    ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? { duration: seconds } : {}),
  };
}

/** Asks once how a started job is doing. An adapter's check may itself wait
 * on the provider a while before answering. */
export async function checkVideoJob(model: ProviderVideoModel, operation: VideoOperation): Promise<VideoCheck> {
  const status = await experimental_getVideoStatus(model, { operation, maxRetries: 0 });
  if (status.status === "error") return { status: "failed", error: status.error };
  if (status.status !== "completed") return { status: "running" };
  const [video] = status.videos;
  if (!video) return { status: "failed", error: "The job ended without a clip." };
  if (video.type === "uploaded") {
    return { status: "failed", error: "The provider sent the clip to other storage instead of back to Pragma." };
  }
  return { status: "completed", video };
}

function costOf(metadata: VideoStartResult["providerMetadata"]): GenerationCost | undefined {
  for (const record of Object.values(metadata ?? {})) {
    const cost = (record as { cost?: Partial<GenerationCost> } | null)?.cost;
    if (typeof cost?.amount === "number" && typeof cost.unit === "string")
      return { amount: cost.amount, unit: cost.unit };
  }
  return undefined;
}
