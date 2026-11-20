import { generateImage, type ImageModel } from "ai";
import type { GenerationCost } from "./api.ts";
import { nearestAspectRatio, sameAspectRatio } from "./aspectRatio.ts";
import type { VideoData, VideoJob, VideoOperation } from "./videoGeneration.ts";

/**
 * An image model bound to a configured provider: the SDK's current image
 * interface, picked out of its `ImageModel` union. Excludes the bare-string
 * form, which would route through the SDK's hosted gateway, as the language
 * model's type does (modelProvider.ts).
 *
 * An adapter that knows an image's price puts `cost: {amount, unit}` on that
 * image's entry in its `providerMetadata` record's `images`, and what the
 * provider decided about settings it wasn't sent as `notes`. The SDK has no
 * field for either, and drops any key of the record but `images`.
 */
export type ProviderImageModel = Extract<ImageModel, { readonly specificationVersion: "v4" }>;
export type ImageCallOptions = Parameters<ProviderImageModel["doGenerate"]>[0];
export type ImageCallResult = Awaited<ReturnType<ProviderImageModel["doGenerate"]>>;

export interface ImageRequest {
  prompt: string;
  references: Array<{ mediaType: string; data: Uint8Array }>;
  aspectRatio?: `${number}:${number}`;
  seed?: number;
  signal?: AbortSignal;
}

export interface ImageResult {
  mediaType: string;
  data: Uint8Array;
  // What the provider changed or ignored, said for a person to read.
  warnings: string[];
  // What it decided on its own, about settings it wasn't sent.
  notes: string[];
  providerMetadata: ImageCallResult["providerMetadata"];
  cost?: GenerationCost;
}

/** The one call every image generation goes through, whatever the provider. */
export async function callImageModel(model: ProviderImageModel, request: ImageRequest): Promise<ImageResult> {
  const result = await generateImage({
    model,
    prompt: request.references.length
      ? { text: request.prompt, images: request.references.map((reference) => reference.data) }
      : request.prompt,
    aspectRatio: request.aspectRatio,
    seed: request.seed,
    abortSignal: request.signal,
    // A retry submits a second job, and every job is paid for.
    maxRetries: 0,
  });
  return {
    mediaType: result.image.mediaType,
    data: result.image.uint8Array,
    warnings: result.warnings.map(describeWarning),
    notes: Object.values(result.providerMetadata ?? {}).flatMap((record) => record.images.flatMap(notesOf)),
    providerMetadata: result.providerMetadata,
    cost: costOf(result.providerMetadata),
  };
}

/** An adapter's `notes` on its metadata entry, as image and video put them. */
export function notesOf(entry: unknown): string[] {
  const notes = (entry as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) ? notes.map(String) : [];
}

function costOf(metadata: ImageCallResult["providerMetadata"]): GenerationCost | undefined {
  for (const record of Object.values(metadata ?? {})) {
    for (const image of record.images) {
      const cost = (image as { cost?: Partial<GenerationCost> } | null)?.cost;
      if (typeof cost?.amount === "number" && typeof cost.unit === "string") {
        return { amount: cost.amount, unit: cost.unit };
      }
    }
  }
  return undefined;
}

// The fields an image model carries besides its call, copied one by one: an
// SDK model keeps some as getters, which a spread would drop.
function wrap(model: ProviderImageModel, doGenerate: ProviderImageModel["doGenerate"]): ProviderImageModel {
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    maxImagesPerCall: model.maxImagesPerCall,
    doGenerate,
  };
}

/** `model`, with each call's options passed through `change` first. */
export function withOptions(
  model: ProviderImageModel,
  change: (options: ImageCallOptions) => ImageCallOptions,
): ProviderImageModel {
  return wrap(model, (options) => model.doGenerate(change(options)));
}

/**
 * `model`, for an API that takes only the aspect ratios `place` keys: a
 * ratio off that list goes as the nearest one, with a warning naming both,
 * as a server's own adjustment is reported. `place` holds the options that
 * ask for each listed ratio: the ratio itself, or a pixel size.
 */
export function withListedAspectRatios(
  model: ProviderImageModel,
  place: Readonly<Record<string, Partial<ImageCallOptions>>>,
): ProviderImageModel {
  const listed = Object.keys(place);
  return wrap(model, async (options) => {
    if (!options.aspectRatio) return model.doGenerate(options);
    const used = nearestAspectRatio(options.aspectRatio, listed);
    const result = await model.doGenerate({ ...options, aspectRatio: undefined, ...place[used] });
    if (sameAspectRatio(used, options.aspectRatio)) return result;
    const message = `aspect_ratio: asked for ${options.aspectRatio}, used ${used} (the nearest ${model.modelId} makes)`;
    return { ...result, warnings: [...result.warnings, { type: "other", message }] };
  });
}

/** What a model changed or ignored, said for a person to read. */
export function describeWarning(warning: Awaited<ReturnType<typeof generateImage>>["warnings"][number]): string {
  if ("message" in warning) return warning.message;
  const details = warning.details ? `: ${warning.details}` : "";
  return warning.type === "unsupported"
    ? `${warning.feature} isn't supported${details}`
    : `${warning.feature}${details}`;
}

/** What starting a provider's image job gave back: as a video job's start. */
export type ImageJob = VideoJob;

/** What one check of an image job found: still going, its image, or the
 * provider's own words for why it ended without one. A failure to ask
 * throws instead, since the job may still end well. */
export type ImageCheck =
  | { status: "running" }
  | { status: "completed"; image: VideoData }
  | { status: "failed"; error: string };

/**
 * An image model whose provider makes each image as a job, started once and
 * then checked, as a clip is, so a host can record the job and wait on it
 * from a later request. A model of a provider that answers at once has none.
 *
 * A start's warnings, notes, quote and settings are as a video job's.
 */
export interface ProviderImageJobs {
  start(request: Omit<ImageRequest, "signal">): Promise<ImageJob>;
  check(operation: VideoOperation, signal?: AbortSignal): Promise<ImageCheck>;
}
