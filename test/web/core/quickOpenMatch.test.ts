import { describe, expect, it } from "vitest";
import { rankPaths, scoreLabel } from "../../../web/core/quickOpenMatch.ts";

describe("rankPaths", () => {
  it("ranks a name match above a match in the folders over it", () => {
    const paths = ["songs/verse.md", "songs/chorus.md", "lyrics/songs.md"];
    expect(rankPaths(paths, "songs")[0]).toBe("lyrics/songs.md");
  });

  it("names a file by its stem, so a compound kind suffix is not part of the name", () => {
    expect(rankPaths(["cast.table.html", "table-notes.md"], "table")).toEqual(["table-notes.md", "cast.table.html"]);
    expect(rankPaths(["cast.table.html"], "cast")).toEqual(["cast.table.html"]);
  });

  it("puts the file the query would resolve to as a wikilink first", () => {
    // `cast` is a prefix of both names, but only one of them is [[cast]].
    const paths = ["people/castle.md", "people/cast.md", "cast-list.md"];
    expect(rankPaths(paths, "cast")[0]).toBe("people/cast.md");
    // An exact path wins too, even when its stem is shared and so ambiguous.
    expect(rankPaths(["a/cast.md", "b/cast.md"], "b/cast")[0]).toBe("b/cast.md");
  });

  it("orders exact, prefix, word start, contains, then scattered", () => {
    const paths = ["xdraftx.md", "d-r-a-f-t.md", "my draft.md", "draftsman.md", "draft.md"];
    expect(rankPaths(paths, "draft")).toEqual([
      "draft.md",
      "draftsman.md",
      "my draft.md",
      "xdraftx.md",
      "d-r-a-f-t.md",
    ]);
  });

  it("requires every word to match, each in the name or the path", () => {
    const paths = ["act1/scene intro.fountain", "act2/scene intro.fountain", "act1/notes.md"];
    expect(rankPaths(paths, "act1 intro")).toEqual(["act1/scene intro.fountain"]);
    expect(rankPaths(paths, "act1 missing")).toEqual([]);
  });

  it("breaks a tie by recency, then by the shorter path", () => {
    const paths = ["b/long/notes.md", "a/notes.md", "c/notes.md"];
    expect(rankPaths(paths, "notes", ["c/notes.md"])[0]).toBe("c/notes.md");
    expect(rankPaths(paths, "notes")[0]).toBe("a/notes.md");
  });

  it("matches scattered letters in a name, but only an unbroken run in the folders", () => {
    const paths = ["projects/getting-started/prompt-picker.applet.html", "projects/getting-started/README.md"];
    expect(rankPaths(paths, "readme")).toEqual(["projects/getting-started/README.md"]);
    expect(rankPaths(paths, "ppkr")).toEqual(["projects/getting-started/prompt-picker.applet.html"]);
    expect(rankPaths(paths, "getting")).toHaveLength(2);
  });

  it("matches nothing for a blank query", () => {
    expect(rankPaths(["a.md"], "  ")).toEqual([]);
  });

  it("lifts a preferred file over a slightly better match, never a clearly better one", () => {
    const inA = (path: string) => path.startsWith("a/");
    expect(rankPaths(["b/my-bob.md", "a/mybob.md"], "bob", [], inA)[0]).toBe("a/mybob.md");
    expect(rankPaths(["b/bob.md", "a/bobcat.md"], "bob", [], inA)[0]).toBe("b/bob.md");
  });
});

describe("scoreLabel", () => {
  it("scores a label on every word, case-insensitively, or rejects it", () => {
    expect(scoreLabel("Flow: App mode", "app")).toBeGreaterThan(scoreLabel("Flow: App mode", "fam") ?? 0);
    expect(scoreLabel("Flow: App mode", "FLOW mode")).toBeDefined();
    expect(scoreLabel("Flow: App mode", "rename")).toBeUndefined();
  });
});
