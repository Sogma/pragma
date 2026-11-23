import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { changeSpaceTag, readSpaceTags } from "../../src/server/spaceTags.ts";
import { tempDir } from "../support/isolation.ts";

let space: string;

beforeEach(() => {
  space = tempDir("pragma-tags-space-");
});

const declare = (tags: unknown[]) => writeFileSync(path.join(space, "_tags.json"), JSON.stringify({ tags }));

describe("the space's declared tags", () => {
  it("declares none without a _tags.json", () => {
    expect(readSpaceTags(space)).toEqual({ tags: [] });
  });

  // docs/protocol.md's Tags: a key the reader doesn't know is no part of a
  // tag, and stays in the file through a change.
  it("reads an entry's other keys as nothing, and keeps them through a change", async () => {
    declare([{ name: "rewrite", toolkit: "/tools/first.flow.html" }, { name: "draft" }]);
    expect(readSpaceTags(space)).toEqual({
      tags: [
        { name: "rewrite", color: "" },
        { name: "draft", color: "" },
      ],
    });
    await changeSpaceTag(space, { name: "Rewrite", color: "#e03e3e" });
    expect(JSON.parse(readFileSync(path.join(space, "_tags.json"), "utf8")).tags[0]).toEqual({
      name: "rewrite",
      toolkit: "/tools/first.flow.html",
      color: "#e03e3e",
    });
  });

  it("declares nothing through a file that doesn't read", () => {
    writeFileSync(path.join(space, "_tags.json"), '{ "tags": [');
    expect(readSpaceTags(space).problem).toMatch(/^_tags\.json doesn't parse: /);
    expect(readSpaceTags(space).tags).toEqual([]);
  });
});
