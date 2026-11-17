// The tags the space declares (docs/protocol.md's Tags), as the tag inputs,
// the pills and the Tags section read them, and the one way they change. A
// change names one tag and the server applies it to `_tags.json` as the file
// stands, answering with every tag, so this copy is the file's after each.
// Each answer also holds the tags in use that none declares.
import type { SpaceTagChangeRequestBody, SpaceTagsResponse } from "../../src/protocol/api.ts";
import type { TagDefinition } from "../../src/protocol/tags.ts";
import { Emitter } from "../lib/emitter.ts";
import type { TagSource } from "../lib/tagSuggestions.ts";
import { fetchSpaceTags, postSpaceTagChange } from "./apiClient.ts";

export interface TagVocabulary extends TagSource {
  // Why the tags couldn't be read, as of the last answer.
  problem(): string | undefined;
  // Rejects with the server's message, for the caller to report.
  change(change: SpaceTagChangeRequestBody): Promise<void>;
  // Fires at once, then after every answer, a read's or a change's.
  subscribe(listener: (answer: SpaceTagsResponse) => void): () => void;
}

export interface TagsApi {
  fetch(): Promise<SpaceTagsResponse>;
  change(change: SpaceTagChangeRequestBody): Promise<SpaceTagsResponse>;
}

const SPACE_TAGS: TagsApi = { fetch: fetchSpaceTags, change: postSpaceTagChange };

export function createTagVocabulary(api: TagsApi = SPACE_TAGS): TagVocabulary {
  const answer = new Emitter<SpaceTagsResponse>({ tags: [] });
  const settle = (next: SpaceTagsResponse): readonly TagDefinition[] => {
    answer.set(next);
    return next.tags;
  };
  const change = async (next: SpaceTagChangeRequestBody): Promise<void> => {
    settle(await api.change(next));
  };

  return {
    known: () => answer.get().tags,
    used: () => answer.get().used ?? [],
    problem: () => answer.get().problem,
    // A read that fails declares nothing, as a space with no `_tags.json`
    // does, and says why.
    async read() {
      try {
        return settle(await api.fetch());
      } catch (error) {
        return settle({ tags: [], problem: error instanceof Error ? error.message : "Failed to load the tags" });
      }
    },
    change,
    declare: (name) => change({ name }),
    subscribe: (listener) => answer.subscribe(listener),
  };
}

/** The space's tags, declared and in use: one copy, so the pills, the
 * suggestions and the Tags section all read the same answer. */
export const tagVocabulary = createTagVocabulary();
