import type { Hono } from "hono";
import {
  credentialStore,
  credentialStoreDescription,
  providerEndpoint,
  providerKeyStatus,
  SIGN_IN_ELSEWHERE,
  saveCredential,
} from "../../config/credentials.ts";
import {
  loadGlobalConfig,
  type PragmaGlobalConfig,
  type ProviderConfig,
  providerVendor,
  removeProviderConfig,
  resolveProviders,
  saveGlobalConfig,
  signsIn,
  upsertProviderConfig,
  validateProviderInput,
  withConfigMutationLock,
} from "../../config/loadConfig.ts";
import type {
  DefaultModelRequestBody,
  DiscoverModelsResponse,
  ImageModelsResponse,
  ModelProviderSummary,
  ModelsResponse,
  ProviderIdRequestBody,
  ProviderKind,
  ProviderRow,
  ProviderSignInRequestBody,
  ProviderSignInStartResponse,
  ProviderSignInStatus,
  ProviderSignOutResponse,
  ProvidersResponse,
  SaveProviderRequestBody,
  VideoModelsResponse,
} from "../../protocol/api.ts";
import {
  discoverModels,
  effortLevels,
  providerApiKey,
  resolveModel,
  verifyProviderKey,
} from "../../protocol/modelProvider.ts";
import { chatGptSignIns, chatGptSignInTarget } from "../chatgptSignIn.ts";
import { listImageModels, listVideoModels, resolveImageModel, resolveVideoModel } from "../mediaModels.ts";
import type { RouteContext } from "./shared.ts";

const vendorField = (provider: { kind: ProviderKind; baseURL?: string }) => {
  const vendor = providerVendor(provider);
  return vendor ? { vendor } : {};
};

// One of Settings → AI Models' defaults, kept in config.json so a run with
// no one present uses it too. "" clears it: a call that names no model then
// fails rather than guessing. A ref no run could use is refused here, rather
// than saved to fail every node that leaves its model blank.
function mountDefaultRoute(
  app: Hono,
  route: string,
  key: "defaultTextModel" | "defaultImageModel" | "defaultVideoModel",
  check: (ref: string, config: PragmaGlobalConfig) => unknown,
): void {
  app.all(route, async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { model } = (await c.req.json()) as Partial<DefaultModelRequestBody>;
      if (typeof model !== "string") {
        return c.json({ message: 'Name a model, as "<provider>/<model>", or "" for none.' }, 400);
      }
      const ref = model.trim();
      const config = loadGlobalConfig();
      try {
        if (ref) check(ref, config);
      } catch (error) {
        return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
      }
      saveGlobalConfig({ ...config, [key]: ref || undefined });
      return c.body(null, 204);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });
}

export function mountProviderRoutes(app: Hono, { ownMachine }: RouteContext): void {
  // The raw entry, not the resolved one: resolving validates every entry, and
  // one broken entry must not stop another from signing out or being deleted.
  const entryById = (id: string | undefined): ProviderConfig | undefined =>
    id ? loadGlobalConfig().modelProviders?.find((entry) => entry.id === id) : undefined;

  // Settings → AI Models' provider list. Returns every resolved provider with
  // enough to render and edit a row — but never a key value, only
  // whether/whence one resolves. `store` drives the panel's honest at-rest
  // copy.
  app.all("/api/providers", async (c) => {
    try {
      if (c.req.method === "POST") {
        const body = (await c.req.json()) as SaveProviderRequestBody;
        const { apiKey, ...fields } = body;
        const existing = loadGlobalConfig().modelProviders?.find((entry) => entry.id === fields.id);
        const kind = fields.kind ?? existing?.kind;
        const baseURL = (fields.baseURL ?? existing?.baseURL) || undefined;

        if (signsIn(kind) && apiKey) {
          return c.json({ message: "A ChatGPT provider signs in; it takes no API key." }, 400);
        }
        if (apiKey !== undefined && apiKey !== "") {
          validateProviderInput(fields);
          if (!kind) return c.json({ message: `Provider "${fields.id}" needs a "kind".` }, 400);
          // A rejected key (401/403) never creates or touches an entry, so a
          // dud never shows as "set". An unreachable endpoint or a missing
          // `/models` is inconclusive and passes, so a proxy that's just down
          // still saves.
          const candidate = {
            id: fields.id,
            label: fields.label ?? existing?.label ?? fields.id,
            kind,
            baseURL,
            textModels: [],
            imageModels: [],
          };
          const saved = await saveCredential({
            kind: "provider-keys",
            id: fields.id,
            endpoint: providerEndpoint({ kind, baseURL }),
            secret: apiKey,
            verify: async () =>
              (await verifyProviderKey(candidate, apiKey)) ? undefined : "The provider rejected that API key.",
            publish: () => upsertProviderConfig(fields),
          });
          if (!saved.ok) return c.json({ message: saved.message }, saved.status);
          return c.body(null, 204);
        }

        // No key in the payload. Block only the *creation* of a husk: a new
        // entry needing a key, with none resolvable from the environment
        // either, would contribute models that all fail at call time. A local
        // endpoint (`openai` *with* a baseURL) may serve without auth, so it's
        // allowed through.
        if (
          !existing &&
          kind &&
          !signsIn(kind) &&
          (kind !== "openai" || !baseURL) &&
          (await providerKeyStatus({ id: fields.id, kind, baseURL })).source === "none"
        ) {
          return c.json({ message: "Enter an API key for this provider." }, 400);
        }
        upsertProviderConfig(fields);
        return c.body(null, 204);
      }
      if (c.req.method !== "GET") return c.body(null, 405);

      const config = loadGlobalConfig();
      const providers = await Promise.all(
        resolveProviders(config).map(async (provider): Promise<ProviderRow> => {
          const key = await providerKeyStatus(provider);
          const signIn = signsIn(provider.kind)
            ? await chatGptSignIns.status(chatGptSignInTarget(provider))
            : undefined;
          return {
            id: provider.id,
            label: provider.label,
            kind: provider.kind,
            baseURL: provider.baseURL ?? "",
            ...vendorField(provider),
            textModels: provider.textModels,
            imageModels: provider.imageModels,
            keySource: key.source,
            ...(key.problem ? { keyProblem: key.problem } : {}),
            ...(signIn && { signIn }),
          };
        }),
      );
      return c.json<ProvidersResponse>({ providers, store: credentialStoreDescription(), signInAllowed: ownMachine });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
  });

  // Removes a provider entry, its stored key and its sign-in, ending the
  // sign-in at ChatGPT first.
  app.all("/api/providers/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { id } = (await c.req.json()) as Partial<ProviderIdRequestBody>;
      if (!id) return c.text("Missing id", 400);
      const entry = entryById(id);
      if (entry && signsIn(entry.kind)) await chatGptSignIns.signOut(chatGptSignInTarget(entry));
      // Withdrawn before the entry goes, so a removal cut short never leaves
      // a connection that still sends them.
      await credentialStore().clear({ kind: "provider-sign-ins", id });
      await credentialStore().clear({ kind: "provider-keys", id });
      await withConfigMutationLock(async () => removeProviderConfig(id));
      return c.body(null, 204);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // POST starts a ChatGPT sign-in and answers the page to approve it on; GET
  // reports where it stands, for the form to poll while the browser is open.
  app.all("/api/providers/sign-in", async (c) => {
    if (c.req.method === "GET") {
      const entry = entryById(c.req.query("id"));
      if (!entry || !signsIn(entry.kind)) {
        return c.json({ message: `No ChatGPT provider "${c.req.query("id") ?? ""}" in config.json` }, 404);
      }
      return c.json<ProviderSignInStatus>(await chatGptSignIns.status(chatGptSignInTarget(entry)));
    }
    if (c.req.method !== "POST") return c.body(null, 405);
    if (!ownMachine) return c.json({ message: SIGN_IN_ELSEWHERE }, 400);
    let entry: ProviderConfig | undefined;
    let planUsage = false;
    try {
      const body = (await c.req.json()) as Partial<ProviderSignInRequestBody>;
      entry = entryById(body.id);
      planUsage = body.planUsage === true;
      if (!entry || !signsIn(entry.kind)) {
        return c.json({ message: `No ChatGPT provider "${body.id ?? ""}" in config.json` }, 404);
      }
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Bad request" }, 400);
    }
    try {
      const authorizationUrl = await chatGptSignIns.start(chatGptSignInTarget(entry), { planUsage });
      return c.json<ProviderSignInStartResponse>({ authorizationUrl });
    } catch (error) {
      // ChatGPT's sign-in settings couldn't be read: its answer, not a pragma fault.
      const message = error instanceof Error ? error.message : "ChatGPT didn't answer";
      return c.json({ message: `Couldn't start signing in to ChatGPT: ${message}` }, 502);
    }
  });

  app.all("/api/providers/sign-out", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { id } = (await c.req.json()) as Partial<ProviderIdRequestBody>;
      const entry = entryById(id);
      if (!entry || !signsIn(entry.kind))
        return c.json({ message: `No ChatGPT provider "${id ?? ""}" in config.json` }, 404);
      return c.json<ProviderSignOutResponse>(await chatGptSignIns.signOut(chatGptSignInTarget(entry)));
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // Every enabled model across every configured provider, as
  // "<providerId>/<model>" refs. Never returns baseURLs or keys.
  app.all("/api/models", (c) => {
    try {
      const config = loadGlobalConfig();
      const resolved = resolveProviders(config);
      const models = resolved.flatMap((provider) =>
        provider.textModels.map((model) => {
          const levels = effortLevels(provider, model);
          return {
            id: `${provider.id}/${model}`,
            label: `${model} (${provider.label})`,
            provider: provider.id,
            model,
            ...(levels.length > 0 && { effortLevels: levels }),
          };
        }),
      );
      const providers = resolved.map(
        (provider): ModelProviderSummary => ({
          id: provider.id,
          label: provider.label,
          ...vendorField(provider),
        }),
      );
      return c.json<ModelsResponse>({ models, providers, defaultModel: config.defaultTextModel ?? null });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // The image models a Generate Image node can pick from: the ones each
  // provider lists, and those each Flows-enabled server reports (cached
  // briefly in mediaModels.ts).
  app.all("/api/image-models", async (c) => {
    try {
      const config = loadGlobalConfig();
      const { models, providers, failures } = await listImageModels(config);
      return c.json<ImageModelsResponse>({
        models,
        providers,
        defaultModel: config.defaultImageModel ?? null,
        failures,
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  // The video models a Generate Video node can pick from, the same way.
  app.all("/api/video-models", async (c) => {
    try {
      const config = loadGlobalConfig();
      const { models, providers, failures } = await listVideoModels(config);
      return c.json<VideoModelsResponse>({
        models,
        providers,
        defaultModel: config.defaultVideoModel ?? null,
        failures,
      });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Internal error" }, 500);
    }
  });

  mountDefaultRoute(app, "/api/models/default", "defaultTextModel", (ref) => resolveModel(ref));
  mountDefaultRoute(app, "/api/image-models/default", "defaultImageModel", resolveImageModel);
  mountDefaultRoute(app, "/api/video-models/default", "defaultVideoModel", resolveVideoModel);

  // Asks a configured provider's endpoint which models it serves, for the
  // provider form's "pick which models to enable" step.
  app.all("/api/providers/discover", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { id } = (await c.req.json()) as Partial<ProviderIdRequestBody>;
      const provider = resolveProviders(loadGlobalConfig()).find((entry) => entry.id === id);
      if (!provider) return c.json({ message: `No provider "${id ?? ""}" in config.json` }, 404);
      return c.json<DiscoverModelsResponse>(await discoverModels(provider, await providerApiKey(provider)));
    } catch (error) {
      // A bad key, an unreachable baseURL, or an endpoint with no /models —
      // all "the upstream provider couldn't answer", not a pragma fault.
      return c.json({ message: error instanceof Error ? error.message : "Discovery failed" }, 502);
    }
  });
}
