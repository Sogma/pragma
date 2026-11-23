import type { DiscoverModelsResponse, ProviderKind } from "./apiClient.ts";

// Which discovered text models a fresh provider starts with ticked. aliases:
// only the vendor's rolling `-latest` aliases (Gemini has one per line).
// newest: the newest stable version of each model family. all: every one, a
// local server's being the ones you downloaded. pick: all of a short list,
// none of a long one (OpenRouter, custom proxies).
//
// Image models always go by newest.
export type DiscoverMode = "aliases" | "newest" | "all" | "pick";

export interface ProviderPreset {
  kind: ProviderKind;
  baseURL: string;
  label: string;
  keyless?: boolean;
  // Signs in with the person's account instead of taking a key.
  signIn?: boolean;
  discover: DiscoverMode;
}

// Settings → AI Models' Provider choices, keyed by the id each saves as.
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: { kind: "anthropic", baseURL: "", label: "Anthropic", discover: "newest" },
  openai: { kind: "openai", baseURL: "", label: "OpenAI", discover: "newest" },
  // The plan lists only the models it offers for display.
  chatgpt: { kind: "chatgpt", baseURL: "", label: "ChatGPT plan", signIn: true, discover: "all" },
  gemini: { kind: "google", baseURL: "", label: "Gemini", discover: "aliases" },
  lmstudio: {
    kind: "openai",
    baseURL: "http://localhost:1234/v1",
    label: "LM Studio",
    keyless: true,
    discover: "all",
  },
  ollama: { kind: "openai", baseURL: "http://localhost:11434/v1", label: "Ollama", keyless: true, discover: "all" },
  openrouter: { kind: "openai", baseURL: "https://openrouter.ai/api/v1", label: "OpenRouter", discover: "pick" },
  custom: { kind: "openai", baseURL: "", label: "", discover: "pick" },
};

/** The ids the presets save as. No other connection may take one, an MCP
 * server included, or adding that preset later would collide. */
export const PROVIDER_PRESET_IDS = Object.keys(PROVIDER_PRESETS);

/** Whether an id names a model a text picker can use, rather than an
 * embedding, speech, moderation or media-making one. */
function isChatModel(id: string): boolean {
  return !/embed|tts|whisper|dall-?e|moderation|realtime|audio|transcrib|image|guard|rerank|sora|veo|lyria/i.test(id);
}

/** What a fresh provider starts with ticked, out of what discovery found. */
export function defaultModels(mode: DiscoverMode, found: DiscoverModelsResponse): DiscoverModelsResponse {
  const chat = found.textModels.filter(isChatModel);
  const aliases = chat.filter((id) => id.endsWith("-latest"));
  const models =
    mode === "all"
      ? found.textModels
      : mode === "pick"
        ? found.textModels.length <= 20
          ? found.textModels
          : []
        : mode === "aliases" && aliases.length > 0
          ? aliases
          : newestOfEachFamily(chat);
  return { textModels: models, imageModels: newestOfEachFamily(found.imageModels) };
}

// A pinned snapshot's suffix, as vendors date or number one: -2025-08-07,
// -20250514, -05-20, -0613, -001.
const PINNED = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{3,4})$/;
const UNSTABLE = new Set(["preview", "exp", "experimental"]);

interface Release {
  id: string;
  family: string;
  version: number[];
  // What may stand for the family, best first: a rolling alias (`-latest`
  // with no version of its own), a stable id, a pinned snapshot, a preview.
  tier: number;
}

// An id read as a version of a family: `gemini-3.1-flash-image` is 3.1 of
// `gemini-flash-image`, `claude-3-7-sonnet` 3.7 of `claude-sonnet`, `o4-mini`
// 4 of `o-mini`. The version is the first run of numbers; a number after the
// family's words, such as a size, is one of its words.
function release(id: string): Release {
  let rest = id.toLowerCase();
  let pinned = false;
  for (let match = PINNED.exec(rest); match; match = PINNED.exec(rest)) {
    rest = rest.slice(0, match.index);
    pinned = true;
  }
  const words: string[] = [];
  const version: number[] = [];
  let unstable = false;
  let latest = false;
  let run: "before" | "in" | "after" = "before";
  for (const token of rest.split("-")) {
    if (UNSTABLE.has(token)) {
      unstable = true;
      continue;
    }
    if (token === "latest") {
      latest = true;
      continue;
    }
    const numbered = run === "after" ? null : /^([a-z]?)(\d+(?:\.\d+)*)$/.exec(token);
    if (numbered && !(numbered[1] && run === "in")) {
      if (numbered[1]) words.push(numbered[1]);
      version.push(...numbered[2].split(".").map(Number));
      run = "in";
      continue;
    }
    if (run === "in") run = "after";
    words.push(token);
  }
  const tier = latest && version.length === 0 ? 0 : unstable ? 3 : pinned ? 2 : 1;
  return { id, family: words.join("-"), version, tier };
}

function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function outranks(a: Release, b: Release): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier;
  const order = newer(a.version, b.version);
  return order !== 0 ? order > 0 : a.id.length < b.id.length;
}

/** The one release that stands for each family, in the order `ids` gave. */
export function newestOfEachFamily(ids: readonly string[]): string[] {
  const best = new Map<string, Release>();
  for (const id of ids) {
    const next = release(id);
    const held = best.get(next.family);
    if (!held || outranks(next, held)) best.set(next.family, next);
  }
  const chosen = new Set([...best.values()].map((entry) => entry.id));
  return ids.filter((id) => chosen.has(id));
}
