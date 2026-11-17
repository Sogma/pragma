import { describe, expect, it } from "vitest";
import { readSearchQuery } from "../../src/protocol/searchQuery.ts";

describe("readSearchQuery", () => {
  it("takes each tag: term out of the text, a leading # dropped", () => {
    expect(readSearchQuery("tag:draft")).toEqual({ tags: ["draft"], text: "" });
    expect(readSearchQuery("rain tag:#Night tag:project/alpha storm")).toEqual({
      tags: ["Night", "project/alpha"],
      text: "rain storm",
    });
  });

  it("leaves text without a term as written, and a term with no name as text", () => {
    expect(readSearchQuery("  two  spaces ")).toEqual({ tags: [], text: "two  spaces" });
    expect(readSearchQuery("tag:")).toEqual({ tags: [], text: "tag:" });
    expect(readSearchQuery("pretag:x")).toEqual({ tags: [], text: "pretag:x" });
    expect(readSearchQuery("tag:#")).toEqual({ tags: [], text: "" });
  });
});
