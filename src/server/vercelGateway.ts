// Vercel's AI Gateway as a video provider. Its public model list says what
// each video model takes, and a request is fitted to that before the gateway
// sees it, each change reported. Frames and references go as links from
// Sharing whatever their size: the gateway refuses a start request over
// 300 KiB, which a single frame can pass.
import { type ResolvedProvider, VENDOR_BASE_URLS } from "../config/loadConfig.ts";
import type { GenerationCost, ModelSetting } from "../protocol/api.ts";
import { isAspectRatio, nearestAspectRatio, sameAspectRatio } from "../protocol/aspectRatio.ts";
import type { FrameKind } from "../protocol/flowNodes.ts";
import {
  type DeclaredVideoInputs,
  jobSettings,
  offeredSettings,
  type ProviderVideoModel,
  type VideoCallOptions,
  type VideoStartResult,
  type VideoStatusResult,
} from "../protocol/videoGeneration.ts";
import { nearestResolution, resolutionName, resolutionShortSide, resolutionSize } from "../protocol/videoResolution.ts";
import { type LinkSharing, sharingNeeded } from "./sharing.ts";

/** What the gateway's model list says a video model takes. */
export interface GatewayVideoFacts {
  name?: string;
  takes: DeclaredVideoInputs;
  resolutions: string[];
  durations: number[];
  aspectRatios: string[];
  settings: ModelSetting[];
}

type Fields = Record<string, unknown>;
type VideoFile = NonNullable<VideoCallOptions["image"]>;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];

/** The address the gateway answers on for a provider entry. */
export function gatewayRoot(provider: Pick<ResolvedProvider, "baseURL">): string {
  return (provider.baseURL || (VENDOR_BASE_URLS.vercel as string)).replace(/\/+$/, "");
}

/** A video model's entry in the gateway's list, read loosely: a field it
 * doesn't give is one the model doesn't take. */
export function gatewayVideoFacts(entry: Fields): GatewayVideoFacts {
  const capabilities = isFields(entry.video_capabilities) ? entry.video_capabilities : {};
  const operations = strings(capabilities.supported_operations);
  const limits = isFields(capabilities.input_limits) ? capabilities.input_limits : {};
  const frames: FrameKind[] = operations.includes("first-last-frame")
    ? ["start", "end"]
    : operations.includes("image-to-video")
      ? ["start"]
      : [];
  const counted = (kind: string): boolean => {
    const limit = limits[kind];
    return isFields(limit) && typeof limit.max_count === "number" && limit.max_count > 0;
  };
  const references = operations.includes("reference-to-video")
    ? (["image", "video", "audio"] as const).filter(counted)
    : [];
  return {
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    takes: { references, frames },
    resolutions: strings(capabilities.supported_resolutions),
    durations: numbers(capabilities.supported_durations_seconds),
    aspectRatios: strings(capabilities.supported_aspect_ratios),
    settings: capabilities.generate_audio === true ? [{ name: "generate_audio", kind: "switch" }] : [],
  };
}

// Listing asks the gateway, which takes a moment; a Flow opened twice in a
// few minutes reuses the answer. A failed answer is never kept.
const CATALOG_TTL_MS = 10 * 60_000;
const catalogs = new Map<string, { at: number; facts: Promise<Map<string, GatewayVideoFacts>> }>();

/** Every video model the gateway lists, by id, with what each takes. The
 * list is public, so it is read without the key. */
export function gatewayVideoCatalog(
  provider: Pick<ResolvedProvider, "baseURL" | "label">,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<Map<string, GatewayVideoFacts>> {
  const root = gatewayRoot(provider);
  const now = deps.now ?? Date.now;
  const cached = catalogs.get(root);
  if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.facts;
  const facts = (async () => {
    const response = await (deps.fetch ?? fetch)(`${root}/v1/models`);
    if (!response.ok) throw new Error(`${provider.label}'s model list answered ${response.status}.`);
    const body = (await response.json()) as { data?: unknown };
    const found = new Map<string, GatewayVideoFacts>();
    for (const entry of Array.isArray(body.data) ? body.data : []) {
      if (isFields(entry) && entry.type === "video" && typeof entry.id === "string") {
        found.set(entry.id, gatewayVideoFacts(entry));
      }
    }
    return found;
  })();
  catalogs.set(root, { at: now(), facts });
  facts.catch(() => {
    if (catalogs.get(root)?.facts === facts) catalogs.delete(root);
  });
  return facts;
}

// The frame size a catalog's size name is sent as. Vercel's docs give
// Seedance's 480p as 864x480; every other size goes as the 16:9 frame the
// SDK reads as that tier.
function frameSize(name: string): `${number}x${number}` | undefined {
  const side = resolutionShortSide(name);
  if (side === undefined) return undefined;
  return side === 480 ? "864x480" : resolutionSize(side);
}

// The listed duration nearest `seconds`, the shorter of two as near.
function nearestDuration(seconds: number, listed: readonly number[]): number {
  return listed.reduce((best, next) => {
    const gap = Math.abs(next - seconds);
    const bestGap = Math.abs(best - seconds);
    return gap < bestGap || (gap === bestGap && next < best) ? next : best;
  });
}

// The gateway's own word on a job's price, where it gives one, in dollars.
function costOf(metadata: VideoStartResult["providerMetadata"]): GenerationCost | undefined {
  const gateway = metadata?.gateway;
  const said = isFields(gateway) ? (gateway.cost ?? gateway.marketCost) : undefined;
  const amount = typeof said === "string" ? Number(said) : said;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? { amount, unit: "USD" } : undefined;
}

// A job as Pragma records it: the gateway's operation, and the keys of the
// files shared for it, deleted once it ends.
interface Operation {
  job: VideoStartResult["operation"];
  shared: string[];
}

function operationOf(operation: unknown): Operation {
  if (isFields(operation) && "job" in operation && Array.isArray(operation.shared)) {
    return { job: operation.job as Operation["job"], shared: strings(operation.shared) };
  }
  return { job: operation as Operation["job"], shared: [] };
}

// A signed link reads its file for a day, so a refusal quoting one is
// reported with the link cut at its signature.
function withoutLinks(error: unknown, urls: readonly string[]): unknown {
  if (!(error instanceof Error)) return error;
  for (const url of urls) error.message = error.message.split(url).join(url.split("?")[0]);
  return error;
}

export interface GatewayVideoDeps {
  // The gateway's own model, with the key read for this call.
  open(): Promise<ProviderVideoModel>;
  // What the model takes, or undefined when the list can't say.
  facts(): Promise<GatewayVideoFacts | undefined>;
  sharing(): Promise<LinkSharing | undefined>;
}

/** The video model a gateway provider makes `modelId` with. */
export function gatewayVideoModel(
  provider: Pick<ResolvedProvider, "id" | "label">,
  modelId: string,
  deps: GatewayVideoDeps,
): ProviderVideoModel {
  return {
    specificationVersion: "v4",
    provider: provider.id,
    modelId,
    maxVideosPerCall: 1,
    async doStart(options): Promise<VideoStartResult> {
      const warnings: VideoStartResult["warnings"] = [];
      const changed = (setting: string, asked: string, used: string) =>
        warnings.push({
          type: "other",
          message: `${setting}: asked for ${asked}, used ${used} (the nearest ${modelId} makes)`,
        });
      const leftOut = (setting: string) =>
        warnings.push({ type: "other", message: `${setting}: ${modelId} takes none, so it was left out` });
      const facts = await deps.facts().catch(() => undefined);

      let resolution = options.resolution;
      const askedSide = resolution ? resolutionShortSide(resolution) : undefined;
      if (askedSide !== undefined && facts && facts.resolutions.length === 0) {
        leftOut("resolution");
        resolution = undefined;
      } else if (askedSide !== undefined) {
        const nearest = facts ? nearestResolution(askedSide, facts.resolutions) : resolutionName(askedSide);
        const usedSide = nearest ? resolutionShortSide(nearest) : undefined;
        if (nearest && usedSide !== undefined) {
          if (usedSide !== askedSide) changed("resolution", resolutionName(askedSide), resolutionName(usedSide));
          resolution = frameSize(nearest);
        }
      }

      let duration = options.duration;
      if (duration !== undefined && facts?.durations.length) {
        const used = nearestDuration(duration, facts.durations);
        if (used !== duration) changed("duration", `${duration} s`, `${used} s`);
        duration = used;
      }

      let aspectRatio = options.aspectRatio;
      const ratios = facts?.aspectRatios.filter(isAspectRatio) ?? [];
      if (aspectRatio && aspectRatio !== "adaptive" && ratios.length) {
        const asked = aspectRatio;
        if (!ratios.some((ratio) => sameAspectRatio(ratio, asked))) {
          const used = nearestAspectRatio(asked, ratios) as `${number}:${number}`;
          changed("aspect_ratio", asked, used);
          aspectRatio = used;
        }
      }

      const { pragma: asked, ...providerOptions } = options.providerOptions ?? {};
      const chosen = offeredSettings(asked, facts?.settings ?? [], modelId);
      for (const message of chosen.leftOut) warnings.push({ type: "other", message });
      const generateAudio =
        typeof chosen.settings.generate_audio === "boolean" ? chosen.settings.generate_audio : options.generateAudio;

      const files = [
        options.image,
        ...(options.frameImages ?? []).map((frame) => frame.image),
        ...(options.inputReferences ?? []),
      ];
      const sending = files.some((file) => file?.type === "file");
      const sharing = sending ? await deps.sharing() : undefined;
      if (sending && !sharing) throw sharingNeeded(provider.label);
      const shared: string[] = [];
      const urls: string[] = [];
      // The SDK hands the first frame over twice, as `image` too, as one
      // object: each file goes up once.
      const links = new Map<VideoFile, Promise<VideoFile>>();
      const share = async (file: VideoFile): Promise<VideoFile> => {
        if (file.type !== "file" || !sharing) return file;
        const data = typeof file.data === "string" ? Buffer.from(file.data, "base64") : file.data;
        const { key, url } = await sharing.share({ mediaType: file.mediaType, data }, options.abortSignal);
        shared.push(key);
        urls.push(url);
        return { type: "url", url, mediaType: file.mediaType };
      };
      const linked = (file: VideoFile): Promise<VideoFile> => {
        const link = links.get(file) ?? share(file);
        links.set(file, link);
        return link;
      };

      try {
        const image = options.image && (await linked(options.image));
        const frameImages =
          options.frameImages &&
          (await Promise.all(
            options.frameImages.map(async (frame) => ({ ...frame, image: await linked(frame.image) })),
          ));
        const inputReferences = options.inputReferences && (await Promise.all(options.inputReferences.map(linked)));
        const model = await deps.open();
        if (!model.doStart) throw new Error(`${provider.label} can't start ${modelId} as a job.`);
        const started = await model.doStart({
          ...options,
          image,
          frameImages,
          inputReferences,
          resolution,
          duration,
          aspectRatio,
          generateAudio,
          providerOptions,
        });
        const cost = costOf(started.providerMetadata);
        const operation: Operation = { job: started.operation, shared };
        return {
          ...started,
          operation: { ...operation },
          warnings: [...warnings, ...started.warnings],
          providerMetadata: {
            ...started.providerMetadata,
            [provider.id]: {
              ...started.providerMetadata?.[provider.id],
              settings: { ...jobSettings({ aspectRatio, resolution, duration }) },
              ...(cost ? { cost: { ...cost } } : {}),
            },
          },
        };
      } catch (error) {
        await sharing?.unshare(shared);
        throw withoutLinks(error, urls);
      }
    },
    async doStatus({ operation, abortSignal, headers }): Promise<VideoStatusResult> {
      const { job, shared } = operationOf(operation);
      const model = await deps.open();
      if (!model.doStatus) throw new Error(`${provider.label} can't check on ${modelId}'s jobs.`);
      const status = await model.doStatus({ operation: job, abortSignal, headers });
      if (status.status !== "pending" && shared.length) {
        const sharing = await deps.sharing().catch(() => undefined);
        await sharing?.unshare(shared);
      }
      return status;
    },
  };
}
