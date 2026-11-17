import { describe, expect, it, vi } from "vitest";
import type { SpaceTagsResponse } from "../../../src/protocol/api.ts";
import { createTagVocabulary, type TagsApi } from "../../../web/core/tagVocabulary.ts";

const LYRICS = { name: "lyrics", color: "#dfab01" };

function api(answer: SpaceTagsResponse = { tags: [LYRICS] }) {
  return {
    fetch: vi.fn<TagsApi["fetch"]>(async () => answer),
    change: vi.fn<TagsApi["change"]>(async (change) => ({
      tags: [LYRICS, { name: change.name, color: "" }],
    })),
  };
}

describe("tag vocabulary", () => {
  it("reads the space's declared tags and keeps the last answer", async () => {
    const fake = api();
    const vocabulary = createTagVocabulary(fake);
    expect(vocabulary.known()).toEqual([]);
    const read = await vocabulary.read();
    expect(read).toEqual([LYRICS]);
    expect(vocabulary.known()).toBe(read);
    expect(vocabulary.problem()).toBeUndefined();
  });

  // A space with no `_tags.json` declares none, and a read that fails
  // behaves the same, saying why.
  it("declares nothing when the read fails, and says why", async () => {
    const vocabulary = createTagVocabulary({
      ...api(),
      fetch: async () => {
        throw new Error("Failed to load the tags (500)");
      },
    });
    await expect(vocabulary.read()).resolves.toEqual([]);
    expect(vocabulary.problem()).toBe("Failed to load the tags (500)");
  });

  it("passes on a file that doesn't read", async () => {
    const vocabulary = createTagVocabulary(api({ tags: [], problem: "_tags.json doesn't parse" }));
    await vocabulary.read();
    expect(vocabulary.problem()).toBe("_tags.json doesn't parse");
  });

  it("takes the server's answer to a change as the tags, and tells subscribers", async () => {
    const fake = api();
    const vocabulary = createTagVocabulary(fake);
    const heard = vi.fn();
    vocabulary.subscribe(heard);
    expect(heard).toHaveBeenCalledTimes(1);

    await vocabulary.change({ name: "art", color: "#e03e3e" });
    expect(fake.change).toHaveBeenCalledWith({ name: "art", color: "#e03e3e" });
    expect(vocabulary.known().map((tag) => tag.name)).toEqual(["lyrics", "art"]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("declares a tag as a change naming only it, and passes a refusal on", async () => {
    const fake = api();
    const vocabulary = createTagVocabulary(fake);
    await vocabulary.declare?.("art");
    expect(fake.change).toHaveBeenCalledWith({ name: "art" });

    fake.change.mockRejectedValueOnce(new Error("_tags.json doesn't parse. Fix the file, then try again."));
    await expect(vocabulary.change({ name: "x" })).rejects.toThrow("Fix the file");
  });
});
