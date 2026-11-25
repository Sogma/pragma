import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Access, LibraryEntry, ProviderKind, PublisherKind } from "../protocol/api.ts";
import { withFileLock } from "./fileLock.ts";
import { readHostStateFile, writeHostStateFile } from "./hostStateFile.ts";

export interface PragmaGlobalConfig {
  spacePath?: string;
  // This installation's `ext_agent_host_id` for ChatGPT sign-in: minted once
  // and reused by every account, as OpenAI asks. An identifier, not a secret.
  chatgptHostId?: string;
  // Every space pragma knows about, keyed by an opaque, immutable space id.
  // Permanent and never capped — unlike recentSpaceIds below — because
  // grants.json keys its approvals by these ids: dropping an entry orphans
  // every approval made against that space. See docs/architecture.md's Space identity and state ownership section.
  spaces?: Record<string, SpaceRecord>;
  // Most-recently-opened first, capped — the space switcher dropdown's short
  // list, and nothing else. Holds ids into `spaces`, never paths. Management
  // surfaces enumerate `spaces` instead, so ageing out of this list hides a
  // space from the dropdown but never puts it beyond reach.
  recentSpaceIds?: string[];
  // An install-wide list of libraries, which no host writes: a host moves
  // each onto the spaces that name it before serving one (spaceLibraries.ts).
  libraries?: LibraryEntry[];
  // Electron-only; the CLI never reads it. The window's normal size and
  // place, kept while it is maximized or full screen, and whether it was.
  windowBounds?: { width: number; height: number; x?: number; y?: number; maximized?: true; fullScreen?: true };
  // Electron-only: the theme last picked in Settings → Appearance, applied at
  // launch before any window opens. The setting itself is the page's, in a
  // localStorage the main process can't read until the page has loaded.
  windowTheme?: "system" | "light" | "dark";
  // Electron-only: whether the app checks for updates at launch (Settings →
  // General, "Automatic updates"). Absent is on: only an explicit false skips it.
  automaticUpdates?: boolean;
  // Electron-only, macOS: the newest version the launch check has offered to
  // download. The offer isn't made again for it, so a Later stays answered.
  offeredUpdate?: string;
  // Whether a write keeps the version it replaces (Settings → Files,
  // "History"). Absent is on: only an explicit false stops it.
  keepHistory?: boolean;
  // Model providers — hosted APIs and local LLMs (LM Studio, Ollama). None is
  // built in. Hand-edited on the CLI targets, or through Settings →
  // Models. See README.md's Configuration section.
  //
  // Named `modelProviders` (not just `providers`) so it stays unambiguous if
  // pragma ever grows other kinds of providers (storage, sync, auth, ...).
  modelProviders?: ProviderConfig[];
  // Publish targets (Settings → Publishing), e.g. Sogma CMS. A separate array
  // from modelProviders: a publisher isn't a model provider. See
  // docs/publishing.md.
  publishers?: PublisherConfig[];
  // MCP servers pragma connects to as a client (src/server/mcpTools.ts).
  // Global like modelProviders: a server is a connection, not a space fact.
  // See docs/architecture.md's Copilot as an MCP client section.
  mcpServers?: McpServerConfig[];
  // The bucket Pragma shares files from when a provider fetches them by link
  // (Settings → Files → Sharing). Its secret rests in the credential store.
  sharing?: SharingConfig;
  // The "<providerId>/<model>" text, image and video models a call that
  // names none runs on, set from Settings → AI Models. Absent is none: such a
  // call fails.
  defaultTextModel?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  // Whether Delete offers to move to the trash (Settings → Files). Absent
  // is on: only an explicit false offers a permanent delete.
  moveToTrash?: boolean;
  // Whether the space lists every file, not only those Pragma opens
  // (Settings → Files, "Show all file types"). Absent is off.
  showAllFileTypes?: boolean;
  // The agent-facing API and MCP endpoint — off unless switched on, and a
  // separate listener from the one serving the app (docs/agent-api.md,
  // Posture). Never reachable off loopback.
  api?: ApiConfig;
  // Bearer tokens for that endpoint, hashed. Plural from the start even
  // though the panel mints one: grants and scopes hang off a token's identity,
  // and a scalar here would make "revoke one client" a format migration.
  apiTokens?: ApiToken[];
}

export interface ApiConfig {
  // No listener at all until this is true. Off is the only state in which
  // pragma opens no port a harness could reach.
  enabled?: boolean;
  // Fixed rather than ephemeral, because a harness config names it. Reported
  // rather than scanned-for on a conflict: an address that silently moves
  // breaks every config that already named it — a known failure mode for
  // local tools that scan upward, and worse than a refusal a person can see.
  port?: number;
}

export interface ApiToken {
  id: string;
  label: string;
  // sha256 of the token, hex. The token itself is shown once at creation and
  // never stored: nothing here ever needs to read it back, only compare, so
  // storing it recoverably (even encrypted) would be strictly worse.
  hash: string;
  createdAt: string;
  // The space this token may reach, by registry id rather than path — so
  // relocating a space keeps its tokens working, exactly as it keeps its
  // grants.
  spaceId: string;
  access: Access;
}

// One entry in PragmaGlobalConfig.spaces. The record's *key* is the space id:
// opaque, minted once, and never rewritten, because it is what grants.json
// keys approvals by. `path` is the only field a relocate changes, and `label`
// is a display name the user edits — deliberately not the id, since renaming a
// space must never orphan its approvals.
export interface SpaceRecord {
  path: string;
  label?: string;
  // Whether git may run in this space: undefined until the person is asked,
  // false once they decline. Here rather than in the space, because a space
  // cannot vouch for itself — see docs/architecture.md's Space identity and
  // state ownership section.
  trusted?: boolean;
  // Where each library the space's `_libraries.json` declares sits on this
  // machine, by id. Here for the same reason: a space naming a folder would
  // point every host that opens it at that folder.
  libraries?: Record<string, LibraryLocation>;
}

// One library's folder on this machine, and what Pragma may do there.
// Locating or relocating one is Electron-only (docs/architecture.md's Document
// writes and reference integrity).
export interface LibraryLocation {
  path: string;
  access: Access;
}

// One entry in PragmaGlobalConfig.modelProviders: a connection (kind + endpoint +
// key) that contributes a list of models. `openai` covers OpenAI proper and
// any OpenAI-compatible endpoint — LM Studio, Ollama, OpenRouter, vLLM — via
// `baseURL`; `google` is Google's Gemini API; `vercel` is Vercel's AI Gateway.
// See README.md's Configuration section for the full format.
export interface ProviderConfig {
  id: string;
  label?: string;
  kind?: ProviderKind;
  // openai: omitted → https://api.openai.com/v1; set for local/gateway.
  // anthropic: omitted → the SDK default; set for a Bedrock/Vertex-style proxy.
  // google: omitted → the Gemini API.
  baseURL?: string;
  // Text model ids this provider contributes (e.g. "gpt-5",
  // "qwen/qwen3.5-35b-a3b"). Hand-listed, or filled by model discovery.
  textModels?: string[];
  // Image model ids it contributes to Generate Image. A list of their own, so
  // no text picker ever offers one.
  imageModels?: string[];
  // Video model ids it contributes to Generate Video, kept apart the same way.
  videoModels?: string[];
  // Optional floor on the per-call token budget (reasoning + output). Bump
  // this for a provider serving a verbose local reasoning model that would
  // otherwise spend the whole default budget thinking. Hand-edited; no UI.
  maxTokens?: number;
}

// A ProviderConfig after validation and defaulting: `kind` and `label` are
// always present. It carries no key: a key is read from the credential store
// only when a request is about to be made (credentials.ts).
export interface ResolvedProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseURL?: string;
  textModels: string[];
  imageModels: string[];
  videoModels: string[];
  maxTokens?: number;
}

// PragmaGlobalConfig.sharing: an S3-compatible bucket, reached at `endpoint`
// by path. `region` is what requests are signed for; left out, the endpoint's
// own name says it where it can.
export interface SharingConfig {
  kind?: "s3";
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
}

// One entry in PragmaGlobalConfig.publishers: a connection (kind + endpoint +
// key) to an external service a space can publish content to. Shaped like
// ProviderConfig deliberately, but a distinct type: a publisher isn't a model
// provider and carries no `textModels`/`maxTokens`.
export interface PublisherConfig {
  id: string;
  label?: string;
  kind?: PublisherKind;
  baseURL?: string;
}

// A PublisherConfig after validation: `kind` and `label` are always present.
// No key, as with ResolvedProvider.
export interface ResolvedPublisher {
  id: string;
  label: string;
  kind: PublisherKind;
  baseURL?: string;
}

// One entry in PragmaGlobalConfig.mcpServers: an MCP Streamable HTTP
// endpoint at `url`, reached with a bearer token, an OAuth sign-in, or
// neither, each kept in the credential store.
export interface McpServerConfig {
  id: string;
  label?: string;
  url?: string;
  // Off unless switched on: the copilot runs a server's tools without asking.
  copilot?: boolean;
  // Whether pragma's own nodes may use the server, for one pragma has an
  // adapter for (src/server/mediaModels.ts).
  flows?: boolean;
}

// An McpServerConfig after validation. No token, as with ResolvedProvider.
export interface ResolvedMcpServer {
  id: string;
  label: string;
  url: string;
  copilot: boolean;
  flows: boolean;
}

const PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai", "google", "vercel", "chatgpt"];

// Each kind's conventional key variable. It holds a key for the vendor's own
// endpoint, so an entry with a baseURL never reads it: a keyless OpenRouter
// or LM Studio entry must not send the OpenAI key to another host.
//
// `chatgpt` has none and takes no key at all: OpenAI requires that a ChatGPT
// plan request never moves silently to another billing path.
const KEY_ENV_VARS: Partial<Record<ProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
};

/** Each vendor's own endpoint, which an entry with no baseURL talks to. A
 * stored key is bound to it, and requests name it outright rather than let an
 * SDK read a base URL from the environment. */
export const VENDOR_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  vercel: "https://ai-gateway.vercel.sh",
};

const KIND_NAMES = '"anthropic", "openai", "google", "vercel" or "chatgpt"';

function isProviderKind(kind: string): kind is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** Whether a provider of this kind signs in rather than taking a key. */
export function signsIn(kind: ProviderKind | undefined): boolean {
  return kind === "chatgpt";
}

// The vendor an entry talks to: its kind, but only with no baseURL, when the
// endpoint is the vendor's own. Its key variable and its mark in a picker
// both follow: an LM Studio entry is the `openai` kind too, and must neither
// send the OpenAI key nor wear OpenAI's mark.
export function providerVendor(entry: { kind?: ProviderKind; baseURL?: string }): ProviderKind | undefined {
  return entry.kind && !entry.baseURL ? entry.kind : undefined;
}

/** The vendor's key from its conventional environment variable, for an entry
 * talking to that vendor's own endpoint only. */
/** The variable an entry may read its key from: its vendor's, for an entry on
 * the vendor's own endpoint. */
export function environmentVariable(entry: { kind?: ProviderKind; baseURL?: string }): string | undefined {
  const vendor = providerVendor(entry);
  return vendor ? KEY_ENV_VARS[vendor] : undefined;
}

export function environmentKey(entry: { kind?: ProviderKind; baseURL?: string }): string | undefined {
  const variable = environmentVariable(entry);
  return variable ? process.env[variable] || undefined : undefined;
}

// config.modelProviders, merged by id and validated. Throws on a
// structural error (unknown kind, a slash in an id, an entry with no kind)
// rather than dropping the entry — a silently-missing model reads as
// "pragma is broken".
export function resolveProviders(config: PragmaGlobalConfig): ResolvedProvider[] {
  const byId = new Map<string, ProviderConfig>();

  for (const entry of config.modelProviders ?? []) {
    if (!entry.id || entry.id.includes("/")) {
      throw new Error(
        `Invalid provider id ${JSON.stringify(entry.id)} in config.json: it must be non-empty and contain no "/".`,
      );
    }
    if (entry.kind && !isProviderKind(entry.kind)) {
      throw new Error(
        `Provider "${entry.id}" in config.json has unknown kind ${JSON.stringify(entry.kind)}. Expected ${KIND_NAMES}.`,
      );
    }
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? { ...existing, ...entry } : entry);
  }

  return [...byId.values()].map((entry) => {
    if (!entry.kind) {
      throw new Error(`Provider "${entry.id}" in config.json is missing "kind". Set it to one of ${KIND_NAMES}.`);
    }
    return {
      id: entry.id,
      label: entry.label ?? entry.id,
      kind: entry.kind,
      // A ChatGPT plan token is for OpenAI's own endpoint alone, so a
      // hand-edited address never receives it.
      baseURL: signsIn(entry.kind) ? undefined : entry.baseURL,
      textModels: entry.textModels ?? [],
      imageModels: entry.imageModels ?? [],
      videoModels: entry.videoModels ?? [],
      maxTokens: entry.maxTokens,
    };
  });
}

export interface ProviderUpsertInput {
  id: string;
  label?: string;
  kind?: ProviderKind;
  baseURL?: string;
  textModels?: string[];
  imageModels?: string[];
  videoModels?: string[];
}

// Shape only. Whether a `kind` is *required* depends on whether the entry
// already exists, so that check happens after the merge, in the upsert below.
export function validateProviderInput(input: ProviderUpsertInput): void {
  if (!input.id || input.id.includes("/")) {
    throw new Error(`Provider id ${JSON.stringify(input.id)} must be non-empty and contain no "/".`);
  }
  if (input.kind && !isProviderKind(input.kind)) {
    throw new Error(`Unknown provider kind ${JSON.stringify(input.kind)}. Expected ${KIND_NAMES}.`);
  }
}

// Writes the non-secret fields of a provider into config.modelProviders
// (never the key: that goes to the credential store). Merges over an
// existing entry, so a `{ id, textModels }` payload updates just the model list.
// A brand-new entry must end up with a kind.
export function upsertProviderConfig(input: ProviderUpsertInput): void {
  validateProviderInput(input);
  const config = loadGlobalConfig();
  const modelProviders = [...(config.modelProviders ?? [])];
  const index = modelProviders.findIndex((entry) => entry.id === input.id);
  // Providers and MCP servers share one id namespace: an image model ref's first
  // segment may name either.
  if (index === -1 && config.mcpServers?.some((entry) => entry.id === input.id)) {
    throw new Error(`An MCP server already has the id "${input.id}".`);
  }
  const next: ProviderConfig = {
    ...(index === -1 ? {} : modelProviders[index]),
    id: input.id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.baseURL !== undefined ? { baseURL: input.baseURL || undefined } : {}),
    ...(input.textModels !== undefined ? { textModels: input.textModels } : {}),
    ...(input.imageModels !== undefined ? { imageModels: input.imageModels } : {}),
    ...(input.videoModels !== undefined ? { videoModels: input.videoModels } : {}),
  };
  if (!next.kind) {
    throw new Error(`Provider "${next.id}" needs a "kind" (${KIND_NAMES}).`);
  }
  if (signsIn(next.kind)) delete next.baseURL;
  if (index === -1) modelProviders.push(next);
  else modelProviders[index] = next;
  saveGlobalConfig({ ...config, modelProviders });
}

export function removeProviderConfig(id: string): void {
  const config = loadGlobalConfig();
  if (!config.modelProviders) return;
  saveGlobalConfig({ ...config, modelProviders: config.modelProviders.filter((entry) => entry.id !== id) });
}

// ── Sharing ─────────────────────────────────────────────────────────────

export interface ResolvedSharing {
  kind: "s3";
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
}

// What's wrong with a sharing setup's fields, said after its name, or
// undefined when nothing is. A bucket is reached by path, so its name may
// hold dots and capitals that a host-style address couldn't.
function sharingProblem(fields: SharingConfig): string | undefined {
  let endpoint: URL | undefined;
  try {
    endpoint = fields.endpoint ? new URL(fields.endpoint) : undefined;
  } catch {
    endpoint = undefined;
  }
  if (!endpoint || (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")) {
    return "needs an endpoint, an http or https URL.";
  }
  if (endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    return "needs an endpoint with no query, fragment or account in it.";
  }
  if (!fields.bucket || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(fields.bucket)) {
    return "needs a bucket name: 2 to 63 letters, digits, dots, dashes or underscores.";
  }
  if (!fields.accessKeyId?.trim()) return "needs a key ID.";
  if (fields.region !== undefined && !/^[A-Za-z0-9-]*$/.test(fields.region)) {
    return "needs a region of letters, digits and dashes, or none.";
  }
  return undefined;
}

/** config.sharing, validated, or undefined when none is set up. Throws on a
 * structural error rather than ignoring it, as a provider entry does. */
export function resolveSharing(config: PragmaGlobalConfig): ResolvedSharing | undefined {
  const entry = config.sharing;
  if (!entry) return undefined;
  if (entry.kind !== undefined && entry.kind !== "s3") {
    throw new Error(`"sharing" in config.json has unknown kind ${JSON.stringify(entry.kind)}. Expected "s3".`);
  }
  const problem = sharingProblem(entry);
  if (problem) throw new Error(`"sharing" in config.json ${problem}`);
  return {
    kind: "s3",
    endpoint: (entry.endpoint as string).replace(/\/+$/, ""),
    bucket: entry.bucket as string,
    accessKeyId: (entry.accessKeyId as string).trim(),
    ...(entry.region ? { region: entry.region } : {}),
  };
}

/** Why these fields can't be saved as the sharing setup, or undefined. */
export function sharingInputProblem(fields: SharingConfig): string | undefined {
  const problem = sharingProblem(fields);
  return problem ? `Sharing ${problem}` : undefined;
}

/** Writes the sharing setup's fields into config.json, never its secret. */
export function saveSharingConfig(fields: Omit<SharingConfig, "kind">): void {
  const problem = sharingInputProblem(fields);
  if (problem) throw new Error(problem);
  const config = loadGlobalConfig();
  saveGlobalConfig({
    ...config,
    sharing: {
      kind: "s3",
      endpoint: (fields.endpoint as string).replace(/\/+$/, ""),
      bucket: fields.bucket,
      ...(fields.region ? { region: fields.region } : {}),
      accessKeyId: fields.accessKeyId?.trim(),
    },
  });
}

export function removeSharingConfig(): void {
  const { sharing: _sharing, ...rest } = loadGlobalConfig();
  saveGlobalConfig(rest);
}

// ── Publishers ──────────────────────────────────────────────────────────

// config.publishers, validated. Throws on a structural error rather than
// dropping the entry: a silently-dropped one reads as "pragma is broken".
export function resolvePublishers(config: PragmaGlobalConfig): ResolvedPublisher[] {
  return (config.publishers ?? []).map((entry) => {
    if (!entry.id || entry.id.includes("/")) {
      throw new Error(
        `Invalid publisher id ${JSON.stringify(entry.id)} in config.json: it must be non-empty and contain no "/".`,
      );
    }
    if (!entry.kind) {
      throw new Error(`Publisher "${entry.id}" in config.json is missing "kind".`);
    }
    if (entry.kind !== "sogma") {
      throw new Error(
        `Publisher "${entry.id}" in config.json has unknown kind ${JSON.stringify(entry.kind)}. Expected "sogma".`,
      );
    }
    return {
      id: entry.id,
      label: entry.label ?? entry.id,
      kind: entry.kind,
      baseURL: entry.baseURL,
    };
  });
}

export interface PublisherUpsertInput {
  id: string;
  label?: string;
  kind?: PublisherKind;
  baseURL?: string;
}

export function validatePublisherInput(input: PublisherUpsertInput): void {
  if (!input.id || input.id.includes("/")) {
    throw new Error(`Publisher id ${JSON.stringify(input.id)} must be non-empty and contain no "/".`);
  }
  if (input.kind && input.kind !== "sogma") {
    throw new Error(`Unknown publisher kind ${JSON.stringify(input.kind)}. Expected "sogma".`);
  }
}

// Writes the non-secret fields of a publisher into config.publishers (never
// the key: that goes to the credential store). Merges over an
// existing entry, so a partial payload updates only the fields it names.
export function upsertPublisherConfig(input: PublisherUpsertInput): void {
  validatePublisherInput(input);
  const config = loadGlobalConfig();
  const publishers = [...(config.publishers ?? [])];
  const index = publishers.findIndex((entry) => entry.id === input.id);
  const next: PublisherConfig = {
    ...(index === -1 ? {} : publishers[index]),
    id: input.id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.baseURL !== undefined ? { baseURL: input.baseURL || undefined } : {}),
  };
  if (!next.kind) {
    throw new Error(`Publisher "${next.id}" needs a "kind".`);
  }
  if (index === -1) publishers.push(next);
  else publishers[index] = next;
  saveGlobalConfig({ ...config, publishers });
}

export function removePublisherConfig(id: string): void {
  const config = loadGlobalConfig();
  if (!config.publishers) return;
  saveGlobalConfig({ ...config, publishers: config.publishers.filter((entry) => entry.id !== id) });
}

/** This installation's ChatGPT host id, minted and saved on first use. */
export function chatGptHostId(): string {
  const config = loadGlobalConfig();
  if (config.chatgptHostId) return config.chatgptHostId;
  const id = `urn:uuid:${randomUUID()}`;
  saveGlobalConfig({ ...config, chatgptHostId: id });
  return id;
}

export interface McpServerUpsertInput {
  id: string;
  label?: string;
  url?: string;
  copilot?: boolean;
  flows?: boolean;
}

function validateMcpServer(entry: McpServerConfig): asserts entry is McpServerConfig & { url: string } {
  if (!entry.id || entry.id.includes("/")) {
    throw new Error(`MCP server id ${JSON.stringify(entry.id)} must be non-empty and contain no "/".`);
  }
  if (!entry.url) throw new Error(`MCP server "${entry.id}" needs a "url".`);
}

// config.mcpServers, validated. Throws on a structural error rather than
// dropping the entry, same posture as the provider and publisher resolvers.
export function resolveMcpServers(config: PragmaGlobalConfig): ResolvedMcpServer[] {
  return (config.mcpServers ?? []).map((entry) => {
    validateMcpServer(entry);
    return {
      id: entry.id,
      label: entry.label ?? entry.id,
      url: entry.url,
      copilot: entry.copilot === true,
      flows: entry.flows === true,
    };
  });
}

// Writes the non-secret fields of an MCP server into config.mcpServers
// (never the token: that goes to the credential store). Merges
// over an existing entry, so a partial payload updates only the fields it names.
export function upsertMcpServerConfig(input: McpServerUpsertInput): void {
  const config = loadGlobalConfig();
  const mcpServers = [...(config.mcpServers ?? [])];
  const index = mcpServers.findIndex((entry) => entry.id === input.id);
  // The provider side of the shared id namespace.
  if (index === -1 && config.modelProviders?.some((entry) => entry.id === input.id)) {
    throw new Error(`A model provider already has the id "${input.id}".`);
  }
  const next: McpServerConfig = {
    ...(index === -1 ? {} : mcpServers[index]),
    id: input.id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.url !== undefined ? { url: input.url || undefined } : {}),
    ...(input.copilot !== undefined ? { copilot: input.copilot } : {}),
    ...(input.flows !== undefined ? { flows: input.flows } : {}),
  };
  validateMcpServer(next);
  if (index === -1) mcpServers.push(next);
  else mcpServers[index] = next;
  saveGlobalConfig({ ...config, mcpServers });
}

export function removeMcpServerConfig(id: string): void {
  const config = loadGlobalConfig();
  if (!config.mcpServers) return;
  saveGlobalConfig({ ...config, mcpServers: config.mcpServers.filter((entry) => entry.id !== id) });
}

const MAX_RECENT_SPACES = 10;

/** The registry id for a space at this path, or undefined if it isn't
 * registered. Path equality is the only way in — a space carries no id of its
 * own, deliberately (docs/architecture.md's Space identity and state ownership section), so a folder that
 * moved is a *different* space until someone relocates its entry. */
export function findSpaceId(config: PragmaGlobalConfig, spacePath: string): string | undefined {
  return Object.entries(config.spaces ?? {}).find(([, record]) => record.path === spacePath)?.[0];
}

/** The trust recorded for the space at this path: undefined both before the
 * person is asked and for a path the registry doesn't know, so an unregistered
 * space is never trusted. */
export function spaceTrust(config: PragmaGlobalConfig, spacePath: string): boolean | undefined {
  const id = findSpaceId(config, spacePath);
  return id === undefined ? undefined : config.spaces?.[id]?.trusted;
}

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** A space id no registry entry is using. A collision is vanishingly unlikely,
 * but a duplicate would overwrite an existing entry *and* hand the new space
 * its approvals, since grants key off this id — so it is refused outright.
 *
 * Not widened past the shared 8 hex: an id that travels with a shared or
 * hosted space would be a different identity from this deliberately local
 * one — see docs/architecture.md's Space identity and state ownership section. */
function mintSpaceId(config: PragmaGlobalConfig): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = generateId("spc");
    if (!config.spaces?.[id]) return id;
  }
  throw new Error("Could not mint an unused space id.");
}

/** What the UI shows for a space: the user's label if they set one, else the
 * folder name. Never the id — that's a key, not a name. */
export function spaceLabel(record: SpaceRecord): string {
  return record.label || path.basename(record.path);
}

// Points the config at `spacePath` under `id`, moving that id to the front of
// recentSpaceIds (deduped, capped). Every caller that changes which space is
// being served ends up here, so the registry and the recents list stay
// consistent whichever target the switch came from.
function withSpaceOpen(config: PragmaGlobalConfig, spacePath: string, id: string): PragmaGlobalConfig {
  const spaces = { ...(config.spaces ?? {}), [id]: { ...config.spaces?.[id], path: spacePath } };
  const recentSpaceIds = [id, ...(config.recentSpaceIds ?? []).filter((entry) => entry !== id)].slice(
    0,
    MAX_RECENT_SPACES,
  );
  return { ...config, spacePath, spaces, recentSpaceIds };
}

/** Opens `spacePath`, registering it under a fresh id if it isn't known.
 *
 * Minting an entry assigns identity, so this is only for targets where
 * something owns it — Electron and the local hosts, `pragma start` and
 * `pragma dev`, where a human chose the path. Every other target uses the
 * lookup-only variant below. See docs/architecture.md's Space identity and
 * state ownership section. */
export function rememberSpace(config: PragmaGlobalConfig, spacePath: string): PragmaGlobalConfig {
  return withSpaceOpen(config, spacePath, findSpaceId(config, spacePath) ?? mintSpaceId(config));
}

/** Opens `spacePath` only if it is already registered; undefined if it isn't.
 *
 * For a target that may not assign identity. Identity is inferred from a
 * path, and a path is what changes when a space moves — minting on a miss
 * would silently turn a moved space into a new one, detaching its approvals
 * and API tokens, on a target with no UI to notice or undo it. */
export function rememberKnownSpace(config: PragmaGlobalConfig, spacePath: string): PragmaGlobalConfig | undefined {
  const id = findSpaceId(config, spacePath);
  return id === undefined ? undefined : withSpaceOpen(config, spacePath, id);
}

/** Registers `spacePath` under a fresh id, or leaves the id it has, without
 * opening it: the configured space and the recents stay as they are, so
 * adding a space never changes what a running host serves or opens next.
 * Minting assigns identity, so only for a command whose human typed the path
 * (docs/architecture.md's Space identity and state ownership section). */
export function registerSpace(config: PragmaGlobalConfig, spacePath: string): PragmaGlobalConfig {
  if (findSpaceId(config, spacePath) !== undefined) return config;
  return { ...config, spaces: { ...config.spaces, [mintSpaceId(config)]: { path: spacePath } } };
}

/** Points the registered space `id` at `spacePath`, keeping the id and with
 * it every approval and token keyed to it: the only way back for a space
 * whose folder moved. A configured `spacePath` on the old folder moves too,
 * or a host that serves only its configured space could no longer start. */
export function relocateSpace(
  config: PragmaGlobalConfig,
  id: string,
  spacePath: string,
): { config: PragmaGlobalConfig } | { refused: string } {
  const record = config.spaces?.[id];
  if (!record) return { refused: "Not a known space" };

  // Two entries on one folder would make "which space is this path?"
  // ambiguous: the path lookup would answer with whichever came first.
  const claimed = Object.entries(config.spaces ?? {}).some(
    ([other, entry]) => other !== id && entry.path === spacePath,
  );
  if (claimed) return { refused: "That folder is already registered as another space" };

  const spaces = { ...config.spaces, [id]: { ...record, path: spacePath } };
  return { config: { ...config, spaces, ...(config.spacePath === record.path && { spacePath }) } };
}

/** The configured `spacePath` if its folder still exists, else the most
 * recently opened registered space that does, else any other registered one.
 * Undefined is a first run, not an error: offer to make or pick a space.
 *
 * A stale path (an unmounted share, a removable disk) is recovered from, not
 * fatal — but only by a caller that may switch spaces silently. A service
 * reachable by other machines, or a scripted run whose paths are relative to
 * one space, resolves its own path instead. */
export function resolveOpenableSpace(config: PragmaGlobalConfig): string | undefined {
  const registered = config.spaces ?? {};
  const recent = (config.recentSpaceIds ?? []).map((id) => registered[id]?.path);
  const rest = Object.keys(registered)
    .filter((id) => !(config.recentSpaceIds ?? []).includes(id))
    .map((id) => registered[id]?.path);
  return [config.spacePath, ...recent, ...rest].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && existsSync(candidate) && statSync(candidate).isDirectory(),
  );
}

/** The directory holding `config.json` and `grants.json`.
 *
 * `PRAGMA_CONFIG_DIR` overrides it outright — the seam that keeps tests off
 * the developer's own install-global files, and how a second install sits
 * side by side. It is ours rather than `XDG_CONFIG_HOME` alone because macOS
 * has no env convention of its own. */
export function globalConfigDir(): string {
  if (process.env.PRAGMA_CONFIG_DIR) return path.resolve(process.env.PRAGMA_CONFIG_DIR);

  const platform = process.platform;
  const home = homedir();

  const appSupportBase =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"));

  return path.join(appSupportBase, "pragma");
}

/** Where this install keeps what it can rebuild — thumbnails — apart from
 * the config directory, which holds what it can't: a backup that skips caches
 * loses nothing, and clearing one never touches config or grants.
 *
 * Under `PRAGMA_CONFIG_DIR` when that is set, so a test server or a second
 * install side by side keeps its cache with the rest of its state. */
export function globalCacheDir(): string {
  if (process.env.PRAGMA_CONFIG_DIR) return path.join(globalConfigDir(), "cache");

  const home = homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "pragma");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "pragma", "Cache");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "pragma");
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.json");
}

/** Capability approvals, keyed by space id — deliberately install-global and
 * outside every space, so a space that is committed, zipped or synced cannot
 * carry approvals to a machine where nobody granted them.
 *
 * A separate file from config.json: approvals are written on every grant while
 * config is written rarely, and a corrupted grants file must not take API keys
 * with it. See docs/architecture.md's Space identity and state ownership section. */
export function globalGrantsPath(): string {
  return path.join(globalConfigDir(), "grants.json");
}

/** One space's layout. A file per space rather than one shared file: layouts
 * are written on every tab change, and processes sharing this directory would
 * otherwise overwrite each other's spaces. An id may be any string, so it is
 * encoded to stay a single file name. */
export function globalLayoutPath(spaceId: string): string {
  return path.join(globalConfigDir(), "layouts", `${encodeURIComponent(spaceId)}.json`);
}

/** Where a space's earlier file versions are kept: host state beside its
 * layout, never inside the space, so no copy or sync of the space holds them. */
export function globalHistoryDir(spaceId: string): string {
  return path.join(globalConfigDir(), "history", encodeURIComponent(spaceId));
}

/** Where the paid jobs this install started are kept until their results
 * land: host state, never a cache, since losing one loses work paid for. */
export function globalJobsDir(): string {
  return path.join(globalConfigDir(), "jobs");
}

/** The global config, `{}` on a first run — and a throw, never `{}`, when the
 * file is there but unparseable. Every caller spreads this back into a save,
 * so an empty result would be persisted: the registry goes, its space ids are
 * re-minted, and every grant and API token keyed to the old ones is orphaned.
 * Startup's own space registration is enough to trigger that. */
export function loadGlobalConfig(): PragmaGlobalConfig {
  return readHostStateFile<PragmaGlobalConfig>(globalConfigPath()) ?? {};
}

// Owner-only: on the CLI targets this file holds sign-in tokens in plaintext.
export function saveGlobalConfig(config: PragmaGlobalConfig): void {
  writeHostStateFile(globalConfigPath(), config, { mode: 0o600 });
}

/** Runs `run` holding the lock connection saves and deletions take across
 * processes, before a credential's own commit lock and never inside it.
 * Other config writers don't take it. */
export function withConfigMutationLock<T>(run: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(globalConfigDir(), ".config.lock"), run);
}

// ── API tokens ──────────────────────────────────────────────────────────

/** Whether the agent endpoint should be listening at all. */
export function apiEnabled(config: PragmaGlobalConfig): boolean {
  return config.api?.enabled === true;
}

export function showsAllFileTypes(config: PragmaGlobalConfig): boolean {
  return config.showAllFileTypes === true;
}

export function keepsHistory(config: PragmaGlobalConfig): boolean {
  return config.keepHistory !== false;
}

export function updatesAutomatically(config: PragmaGlobalConfig): boolean {
  return config.automaticUpdates !== false;
}

/** "system" when none is saved, and for a hand-edited value Electron would
 * throw on, which at launch would stop any window from opening. */
export function windowTheme(config: PragmaGlobalConfig): "system" | "light" | "dark" {
  return config.windowTheme === "light" || config.windowTheme === "dark" ? config.windowTheme : "system";
}

/** Arbitrary but fixed, and configurable. Chosen clear of the ports pragma
 * already shares a machine with — 14319 (its own editor), 5173 (Vite's
 * default), 1234 (LM Studio), 11434 (Ollama) — and of the ranges comparable
 * local-first tools were found to bind when this was picked. */
const DEFAULT_API_PORT = 4319;

export function apiPort(config: PragmaGlobalConfig): number {
  return config.api?.port ?? DEFAULT_API_PORT;
}

/** A new token: the secret to show the user once, and the record to store.
 *
 * The `pragma_` prefix is deliberate. A leaked token is far likelier to be
 * spotted by a secret scanner when it announces what it is — the same reason
 * `ghp_` and `sk_live_` exist — and it costs nothing. */
export function createApiToken(input: { label: string; spaceId: string; access: Access }): {
  secret: string;
  record: ApiToken;
} {
  const secret = `pragma_${randomBytes(32).toString("hex")}`;
  return {
    secret,
    record: {
      id: generateId("tok"),
      label: input.label,
      hash: createHash("sha256").update(secret).digest("hex"),
      createdAt: new Date().toISOString(),
      spaceId: input.spaceId,
      access: input.access,
    },
  };
}

/** The token record a presented secret matches, or undefined.
 *
 * Constant-time on the hash, same as passphraseAuth's cookie check: comparing
 * hashes with `===` leaks how long a prefix matched, which is a slow but real
 * way to forge one. */
export function findApiToken(config: PragmaGlobalConfig, secret: string): ApiToken | undefined {
  const presented = Buffer.from(createHash("sha256").update(secret).digest("hex"), "utf8");
  return (config.apiTokens ?? []).find((token) => {
    const stored = Buffer.from(token.hash, "utf8");
    return stored.length === presented.length && timingSafeEqual(stored, presented);
  });
}
