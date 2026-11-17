// The model lists every picker reads: the text list behind chat's chip,
// Settings' text default and a Flow's text fields; the image and video lists
// behind Settings' defaults of those kinds and a Flow's fields. Each carries
// its kind's default, config.json's. One copy of each, so no picker keeps a
// list the others have outgrown.
//
// A list is fetched when a picker first asks for it, and again on every
// `refresh`, which a provider or MCP server change must call.
import type { ImageModelsResponse, ModelsResponse, VideoModelsResponse } from "../../src/protocol/api.ts";
import {
  fetchImageModels,
  fetchModels,
  fetchVideoModels,
  postDefaultImageModel,
  postDefaultModel,
  postDefaultVideoModel,
} from "../core/apiClient.ts";
import { Emitter } from "../lib/emitter.ts";
import type { ModelKind } from "../lib/modelPicker.ts";

interface Lists {
  text: ModelsResponse;
  image: ImageModelsResponse;
  video: VideoModelsResponse;
}

const FETCH: { [K in ModelKind]: () => Promise<Lists[K]> } = {
  text: fetchModels,
  image: fetchImageModels,
  video: fetchVideoModels,
};
const SAVE_DEFAULT: Record<ModelKind, (ref: string) => Promise<void>> = {
  text: postDefaultModel,
  image: postDefaultImageModel,
  video: postDefaultVideoModel,
};
const FAILURE: Record<ModelKind, string> = {
  text: "Couldn't load the model list",
  image: "Couldn't load the image model list",
  video: "Couldn't load the video model list",
};

export interface ModelListsDeps {
  // A picker has nowhere to say why its menu is empty, so a failed fetch is
  // a Console warning.
  modelConsole: { logEntry(level: "warn", kind: string, label: string, content: string): void };
}

export interface ModelLists {
  /** The kind's list from its last fetch: undefined until one answers, and after one fails. */
  get<K extends ModelKind>(kind: K): Lists[K] | undefined;
  /** Fetches the kind's list, unless it has been asked for already. */
  load(kind: ModelKind): void;
  /** Fetches again every list asked for so far. */
  refresh(): Promise<void>;
  /** The kind's default: "" for none, and until its list arrives. */
  defaultOf(kind: ModelKind): string;
  /** Saves the kind's default, "" for none, rejecting with the server's reason. */
  setDefault(kind: ModelKind, ref: string): Promise<void>;
  /** Fires now, then whenever a fetch settles or a default is saved. */
  subscribe(listener: () => void): () => void;
}

export function createModelLists(deps: ModelListsDeps): ModelLists {
  const lists = new Emitter<Partial<Lists>>({});
  // Each kind's newest fetch. A refresh can start while an older fetch is
  // out, and the older one landing last would undo the change it follows.
  const newest: Partial<Record<ModelKind, number>> = {};
  let fetches = 0;

  async function fetchList<K extends ModelKind>(kind: K): Promise<void> {
    const ticket = ++fetches;
    newest[kind] = ticket;
    let list: Lists[K] | undefined;
    try {
      list = await FETCH[kind]();
    } catch (error) {
      if (newest[kind] !== ticket) return;
      const message = error instanceof Error ? error.message : "Request failed.";
      deps.modelConsole.logEntry("warn", "Models", FAILURE[kind], message);
    }
    if (newest[kind] !== ticket) return;
    const next: Partial<Lists> = { ...lists.get() };
    next[kind] = list;
    lists.set(next);
  }

  return {
    get: (kind) => lists.get()[kind],
    load(kind) {
      if (newest[kind] === undefined) void fetchList(kind);
    },
    async refresh() {
      await Promise.all((Object.keys(newest) as ModelKind[]).map((kind) => fetchList(kind)));
    },
    defaultOf: (kind) => lists.get()[kind]?.defaultModel ?? "",
    // Set in the list at once, so every picker following the default names
    // the new one without waiting on a listing, which can take seconds. Then
    // fetched again: a fetch already out may have read the old default, and
    // the newer fetch is the one whose answer lands.
    async setDefault(kind, ref) {
      await SAVE_DEFAULT[kind](ref);
      const next: Partial<Lists> = { ...lists.get() };
      const list = next[kind];
      if (list) Object.assign(next, { [kind]: { ...list, defaultModel: ref || null } });
      lists.set(next);
      void fetchList(kind);
    },
    subscribe: (listener) => lists.subscribe(() => listener()),
  };
}
