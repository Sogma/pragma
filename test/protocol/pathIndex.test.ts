import { describe, expect, it } from "vitest";
import { createPathIndex, findEntry } from "../../src/protocol/pathIndex.ts";

// The one rule matching a written path to an entry, for every host: names
// fold as entry names compare, and two that fold alike name nothing.
describe("findEntry", () => {
  const index = createPathIndex({
    files: ["Notes/Plan.md", "Notes/plan.md", "Shots/a.md", "shots/b.md", "Drafts/x.md", ".git/config"],
    folders: ["Notes", "Shots", "shots", "Drafts", ".git"],
  });

  it("finds an entry whatever case each segment spells it in", () => {
    expect(findEntry(index, "drafts/X.MD", "any")).toEqual({ path: "Drafts/x.md", type: "file" });
    expect(findEntry(index, "DRAFTS", "directory")).toEqual({ path: "Drafts", type: "directory" });
  });

  it("names nothing when two entries fold alike, the exact spelling included", () => {
    expect(findEntry(index, "Notes/Plan.md", "any")).toBeUndefined();
    expect(findEntry(index, "shots", "directory")).toBeUndefined();
  });

  // Two folders fold alike, but only one holds the file: the whole path
  // still names one entry.
  it("matches the whole path, so a folder twin without the file doesn't count", () => {
    expect(findEntry(index, "SHOTS/a.md", "file")).toEqual({ path: "Shots/a.md", type: "file" });
    expect(findEntry(index, "shots/B.md", "file")).toEqual({ path: "shots/b.md", type: "file" });
  });

  it("never names a dot-entry, and narrows by type", () => {
    expect(findEntry(index, ".git/config", "any")).toBeUndefined();
    expect(findEntry(index, "Drafts", "file")).toBeUndefined();
    expect(findEntry(index, "", "directory")).toEqual({ path: "", type: "directory" });
  });
});
