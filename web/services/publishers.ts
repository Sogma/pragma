// Which publishers hold a stored key — the ones a site can be created on.
// None gates New Site out of the tree's menu; more than one puts a picker in
// its dialog. Refreshed opportunistically and never awaited on a menu open,
// so the menu reads whatever the last refresh left.
import type { PublisherRow } from "../../src/protocol/api.ts";
import type { fetchPublishers } from "../core/apiClient.ts";
import { Emitter } from "../lib/emitter.ts";

export interface PublishersDeps {
  fetch: typeof fetchPublishers;
}

export interface Publishers {
  /** The publishers with a key, as of the last successful refresh. */
  get(): readonly PublisherRow[];
  /** Fires immediately with the current list, then on every refresh. */
  subscribe(listener: (stored: readonly PublisherRow[]) => void): () => void;
  refresh(): Promise<void>;
}

export function createPublishers(deps: PublishersDeps): Publishers {
  const stored = new Emitter<readonly PublisherRow[]>([]);

  return {
    get: () => stored.get(),
    subscribe: (listener) => stored.subscribe(listener),
    async refresh() {
      try {
        const { publishers } = await deps.fetch();
        stored.set(publishers.filter((entry) => entry.keySource === "stored"));
      } catch {
        // The cached list stands: a transient fetch failure must not flip
        // New Site off for an otherwise-configured publisher.
      }
    },
  };
}
