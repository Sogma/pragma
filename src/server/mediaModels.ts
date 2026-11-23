import {
  loadGlobalConfig,
  type PragmaGlobalConfig,
  providerVendor,
  type ResolvedMcpServer,
  type ResolvedProvider,
  resolveMcpServers,
  resolveProviders,
} from "../config/loadConfig.ts";
import type { GroupedModelOption, ModelProviderSummary, ProviderKind } from "../protocol/api.ts";
import type { ProviderImageJobs, ProviderImageModel } from "../protocol/imageGeneration.ts";
import {
  assertMakesImages,
  assertMakesVideos,
  imageModelFor,
  makesVideos,
  providerApiKey,
  videoModelFor,
} from "../protocol/modelProvider.ts";
import { SetupError } from "../protocol/setupNeed.ts";
import type { DeclaredVideoInputs, ProviderVideoModel } from "../protocol/videoGeneration.ts";
import {
  higgsfieldImageJobs,
  higgsfieldImageModel,
  higgsfieldModels,
  higgsfieldVideoInputs,
  higgsfieldVideoModel,
  type ModelChoice,
} from "./higgsfieldMcp.ts";
import { modelSupport, supportWith } from "./modelSupport.ts";
import { linkSharing } from "./sharing.ts";
import { gatewayVideoCatalog, gatewayVideoModel } from "./vercelGateway.ts";

type MediaKind = "image" | "video";

interface Adapter<Model> {
  model: (server: ResolvedMcpServer, modelId: string) => Model;
  list: (server: ResolvedMcpServer) => Promise<ModelChoice[]>;
}

// What a model takes, as its server's catalog declares it.
type DeclaredInputs = (signal?: AbortSignal) => Promise<DeclaredVideoInputs>;

interface ServerAdapters {
  // A server that makes each image as a job says how to start and check one.
  image?: Adapter<ProviderImageModel> & { jobs?: (server: ResolvedMcpServer, modelId: string) => ProviderImageJobs };
  video?: Adapter<ProviderVideoModel> & { inputs?: (server: ResolvedMcpServer, modelId: string) => DeclaredInputs };
}

// The MCP servers pragma's own nodes can use, by the host each serves: the
// adapter speaks that server's tools, so a server is recognized, never
// configured into one.
const ADAPTERS: Record<string, ServerAdapters> = {
  "mcp.higgsfield.ai": {
    image: {
      model: higgsfieldImageModel,
      jobs: higgsfieldImageJobs,
      list: (server) => higgsfieldModels(server, "image"),
    },
    video: {
      model: higgsfieldVideoModel,
      inputs: higgsfieldVideoInputs,
      list: (server) => higgsfieldModels(server, "video"),
    },
  },
};

function adaptersFor(url: string): ServerAdapters | undefined {
  try {
    return ADAPTERS[new URL(url).hostname];
  } catch {
    return undefined;
  }
}

/** Whether a Flow node can use the server at this URL, which decides whether
 * it offers a Flows switch at all. */
export function offersFlows(url: string): boolean {
  return adaptersFor(url) !== undefined;
}

export interface ResolvedImageModel {
  model: ProviderImageModel;
  providerId: string;
  modelId: string;
  // Its jobs, when its provider makes each image as one.
  jobs?: ProviderImageJobs;
  // Who serves it, as the model support file names a host.
  host?: string;
}

export interface ResolvedVideoModel {
  model: ProviderVideoModel;
  providerId: string;
  modelId: string;
  host?: string;
  // What its server's catalog says it takes, where the server says.
  inputs?: DeclaredInputs;
}

// A host as the model support file names one (docs/model-support.md): an
// MCP server by its hostname, a provider entry by its kind when it talks to
// that kind's own endpoint, otherwise by its baseURL's hostname.
function hostOf(entry: { url: string } | { kind?: ProviderKind; baseURL?: string }): string | undefined {
  const vendor = "url" in entry ? undefined : providerVendor(entry);
  if (vendor) return vendor;
  try {
    const url = "url" in entry ? entry.url : entry.baseURL;
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

// A ref's provider and model, `"<providerId>/<model>"`, or the kind's
// configured default when the ref is blank.
function splitRef(ref: string | undefined, kind: MediaKind, config: PragmaGlobalConfig) {
  const chosen = ref?.trim() || (kind === "image" ? config.defaultImageModel : config.defaultVideoModel)?.trim();
  if (!chosen) throw noModelError(kind, config);
  const slash = chosen.indexOf("/");
  if (slash <= 0 || slash === chosen.length - 1) {
    throw new Error(
      `${kind === "image" ? "Image" : "Video"} model "${chosen}" needs its provider, as "<provider>/<model>".`,
    );
  }
  return { chosen, providerId: chosen.slice(0, slash), modelId: chosen.slice(slash + 1) };
}

// No model named and no default set. With nothing offering an image model
// there is nothing to pick, so the image refusal names what to add, as the
// picker's empty menu does. A video refusal always says to pick one: its
// Settings link lands on the video picker, as no provider makes videos.
function noModelError(kind: MediaKind, config: PragmaGlobalConfig): SetupError {
  const { servers, providers } = sourcesOf(kind, config);
  const message =
    kind === "image" && servers.length === 0 && providers.length === 0
      ? "No image models yet. Add a provider in Settings, or an MCP server that makes images."
      : `No ${kind} model. Pick one on the node, or set a default ${kind} model in Settings.`;
  return new SetupError(message, { kind: "defaultModel", output: kind });
}

// A provider's image model that reads its key when it is called and builds
// the client with it then, so resolving a ref reads no key. A missing or
// unusable key fails the call by name, before any request.
function keyedImageModel(provider: ResolvedProvider, modelId: string): ProviderImageModel {
  assertMakesImages(provider);
  return {
    specificationVersion: "v4",
    provider: provider.id,
    modelId,
    maxImagesPerCall: undefined,
    doGenerate: async (options) => imageModelFor(provider, modelId, await providerApiKey(provider)).doGenerate(options),
  };
}

// A provider's video model, built as its image model is: the key is read
// when a job starts or is checked, and what the model takes from the
// provider's own list when there is one.
function keyedVideoModel(provider: ResolvedProvider, modelId: string): ProviderVideoModel {
  assertMakesVideos(provider);
  return gatewayVideoModel(provider, modelId, {
    open: async () => videoModelFor(provider, modelId, await providerApiKey(provider)),
    facts: async () => (await gatewayVideoCatalog(provider)).get(modelId),
    sharing: linkSharing,
  });
}

// What a provider's video model takes, as its list declares it.
function providerVideoInputs(provider: ResolvedProvider, modelId: string): DeclaredInputs {
  return async () => {
    const facts = (await gatewayVideoCatalog(provider)).get(modelId);
    if (!facts) throw new Error(`${provider.label} lists no video model "${modelId}".`);
    return facts.takes;
  };
}

// The Flows-enabled server a ref names, with its adapter for `kind`.
function serverAdapter<K extends MediaKind>(server: ResolvedMcpServer, kind: K): NonNullable<ServerAdapters[K]> {
  const adapter = adaptersFor(server.url)?.[kind];
  if (!adapter) throw new Error(`${server.label} offers no ${kind} models Pragma can use.`);
  if (!server.flows) throw new Error(`${server.label} isn't switched on for Flows.`);
  return adapter as NonNullable<ServerAdapters[K]>;
}

/** Resolves an image model ref, `"<providerId>/<model>"`, or the configured
 * default when the ref is blank. The provider is a model provider of a kind
 * that makes images, or an MCP server switched on for Flows, with an adapter
 * pragma has. */
export function resolveImageModel(
  ref: string | undefined,
  config: PragmaGlobalConfig = loadGlobalConfig(),
): ResolvedImageModel {
  const { chosen, providerId, modelId } = splitRef(ref, "image", config);
  const provider = resolveProviders(config).find((entry) => entry.id === providerId);
  const server = resolveMcpServers(config).find((entry) => entry.id === providerId);
  if (provider && server) {
    throw new Error(`"${providerId}" names both a model provider and an MCP server in config.json; rename one.`);
  }
  if (provider) return { model: keyedImageModel(provider, modelId), providerId, modelId, host: hostOf(provider) };
  if (!server) throw new Error(`No provider "${providerId}" is configured for image model "${chosen}".`);
  const adapter = serverAdapter(server, "image");
  const jobs = adapter.jobs?.(server, modelId);
  return { model: adapter.model(server, modelId), jobs, providerId, modelId, host: hostOf(server) };
}

/** Resolves a video model ref the same way: the provider is a model provider
 * of a kind that makes videos, or an MCP server switched on for Flows with an
 * adapter pragma has. */
export function resolveVideoModel(
  ref: string | undefined,
  config: PragmaGlobalConfig = loadGlobalConfig(),
): ResolvedVideoModel {
  const { chosen, providerId, modelId } = splitRef(ref, "video", config);
  const provider = resolveProviders(config).find((entry) => entry.id === providerId);
  const server = resolveMcpServers(config).find((entry) => entry.id === providerId);
  if (provider && server) {
    throw new Error(`"${providerId}" names both a model provider and an MCP server in config.json; rename one.`);
  }
  if (provider) {
    return {
      model: keyedVideoModel(provider, modelId),
      providerId,
      modelId,
      host: hostOf(provider),
      inputs: providerVideoInputs(provider, modelId),
    };
  }
  if (!server) throw new Error(`No provider "${providerId}" is configured for video model "${chosen}".`);
  const adapter = serverAdapter(server, "video");
  return {
    model: adapter.model(server, modelId),
    providerId,
    modelId,
    host: hostOf(server),
    ...(adapter.inputs ? { inputs: adapter.inputs(server, modelId) } : {}),
  };
}

// Listing asks the server, which takes seconds; a Flow opened twice in a few
// minutes reuses the answer.
const LIST_TTL_MS = 10 * 60_000;
const listed = new Map<string, { at: number; models: ModelChoice[] }>();

export interface MediaModelListing {
  models: GroupedModelOption[];
  // Every provider with models of the kind, then every server switched on
  // for Flows that makes them, listed or not, so a failure below still has
  // a heading.
  providers: ModelProviderSummary[];
  // Providers and servers whose list couldn't be read, and why: an expired
  // sign-in, most often. Their models, or what they take, are missing rather
  // than the whole list failing.
  failures: Array<{ server: string; message: string }>;
}

/** Every image model the providers list and the Flows-enabled servers offer,
 * as `"<providerId>/<model>"` refs, for a node's model picker. */
export function listImageModels(config: PragmaGlobalConfig = loadGlobalConfig()): Promise<MediaModelListing> {
  return listMediaModels("image", config);
}

/** Every video model the providers list and the Flows-enabled servers offer,
 * the same way. */
export function listVideoModels(config: PragmaGlobalConfig = loadGlobalConfig()): Promise<MediaModelListing> {
  return listMediaModels("video", config);
}

// What offers models of the kind: the servers switched on for Flows with an
// adapter for it, and the providers that list some, of a kind that makes them.
function sourcesOf(kind: MediaKind, config: PragmaGlobalConfig) {
  const servers = resolveMcpServers(config).flatMap((server) => {
    const adapter: Adapter<unknown> | undefined = server.flows ? adaptersFor(server.url)?.[kind] : undefined;
    return adapter ? [{ server, adapter }] : [];
  });
  const providers = resolveProviders(config).filter((provider) => modelsOf(provider, kind).length > 0);
  return { servers, providers };
}

const modelsOf = (provider: ResolvedProvider, kind: MediaKind): string[] =>
  kind === "image" ? provider.imageModels : makesVideos(provider) ? provider.videoModels : [];

// A provider's video models, with what each takes from the provider's own
// list. A list that can't be read leaves them bare and says why.
async function providerVideoModels(
  provider: ResolvedProvider,
  failures: MediaModelListing["failures"],
): Promise<GroupedModelOption[]> {
  let catalog: Awaited<ReturnType<typeof gatewayVideoCatalog>> | undefined;
  try {
    catalog = await gatewayVideoCatalog(provider);
  } catch (error) {
    failures.push({ server: provider.id, message: error instanceof Error ? error.message : String(error) });
  }
  return provider.videoModels.map((model) => {
    const facts = catalog?.get(model);
    const name = facts?.name ?? model;
    return {
      id: `${provider.id}/${model}`,
      label: `${name} (${provider.label})`,
      provider: provider.id,
      model: name,
      ...supportOf(model, hostOf(provider), facts?.takes),
      ...(facts ? { resolutions: facts.resolutions } : {}),
      ...(facts?.settings.length ? { settings: facts.settings } : {}),
    };
  });
}

async function listMediaModels(kind: MediaKind, config: PragmaGlobalConfig): Promise<MediaModelListing> {
  const { servers, providers } = sourcesOf(kind, config);
  const failures: MediaModelListing["failures"] = [];
  const listing: MediaModelListing = {
    models:
      kind === "image"
        ? providers.flatMap((provider) =>
            provider.imageModels.map((model) => ({
              id: `${provider.id}/${model}`,
              label: `${model} (${provider.label})`,
              provider: provider.id,
              model,
              ...supportOf(model, hostOf(provider)),
            })),
          )
        : (await Promise.all(providers.map((provider) => providerVideoModels(provider, failures)))).flat(),
    providers: [
      ...providers.map((provider) => {
        const vendor = providerVendor(provider);
        return { id: provider.id, label: provider.label, ...(vendor && { vendor }) };
      }),
      ...servers.map(({ server }) => ({ id: server.id, label: server.label })),
    ],
    failures,
  };
  await Promise.all(
    servers.map(async ({ server, adapter }) => {
      const key = `${kind} ${server.id} ${server.url}`;
      const cached = listed.get(key);
      try {
        const models = cached && Date.now() - cached.at < LIST_TTL_MS ? cached.models : await adapter.list(server);
        listed.set(key, { at: cached && models === cached.models ? cached.at : Date.now(), models });
        for (const model of models) {
          listing.models.push({
            id: `${server.id}/${model.id}`,
            label: `${model.label} (${server.label})`,
            provider: server.id,
            model: model.label,
            ...supportOf(model.id, hostOf(server), model.takes),
            ...(model.resolutions ? { resolutions: model.resolutions } : {}),
            ...(model.settings?.length ? { settings: model.settings } : {}),
          });
        }
      } catch (error) {
        listing.failures.push({ server: server.id, message: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return listing;
}

// What a listed model takes, which a node's card follows: how many
// references, and which frames.
function supportOf(
  modelId: string,
  host: string | undefined,
  declared?: DeclaredVideoInputs,
): Pick<GroupedModelOption, "references" | "frames"> {
  const { references, frames } = supportWith(modelSupport(modelId, host), declared);
  return { ...(Object.keys(references).length ? { references } : {}), ...(frames ? { frames } : {}) };
}
