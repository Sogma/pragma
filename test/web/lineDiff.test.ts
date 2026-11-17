import { describe, expect, it } from "vitest";
import { diffWords, type TextHunk } from "../../web/lineDiff.ts";

function apply(text: string, hunks: readonly TextHunk[]): string {
  let out = text;
  for (const hunk of [...hunks].reverse()) out = out.slice(0, hunk.from) + hunk.insert + out.slice(hunk.to);
  return out;
}

describe("diffWords", () => {
  it("finds nothing to change in identical text", () => {
    expect(diffWords("same text\n", "same text\n")).toEqual([]);
  });

  it("replaces just the word that changed", () => {
    expect(diffWords("the quick brown fox\n", "the fast brown fox\n")).toEqual([{ from: 4, to: 9, insert: "fast" }]);
  });

  it("merges changes separated only by a space into one phrase", () => {
    expect(diffWords("the quick brown fox", "a fast brown fox")).toEqual([{ from: 0, to: 9, insert: "a fast" }]);
  });

  it("keeps changes separated by an unchanged word apart", () => {
    expect(diffWords("one two three", "uno two tres")).toEqual([
      { from: 0, to: 3, insert: "uno" },
      { from: 8, to: 13, insert: "tres" },
    ]);
  });

  it("never merges across a line break", () => {
    expect(diffWords("one\ntwo", "uno\ndos")).toEqual([
      { from: 0, to: 3, insert: "uno" },
      { from: 4, to: 7, insert: "dos" },
    ]);
  });

  it("inserts and deletes whole lines at their offsets", () => {
    expect(diffWords("a\nb\n", "a\nnew\nb\n")).toEqual([{ from: 2, to: 2, insert: "new\n" }]);
    expect(diffWords("a\nb\nc\n", "a\nc\n")).toEqual([{ from: 2, to: 4, insert: "" }]);
  });

  it("produces hunks that rebuild the new text from the old", () => {
    const pairs: [string, string][] = [
      ["", "all new\n"],
      ["all gone\n", ""],
      ["x", "x\ny"],
      ["café crème, s'il vous plaît.\n", "café noir, merci.\n"],
      ["First paragraph stays.\n\nSecond one is rewritten here.\n", "First paragraph stays.\n\nThe second is new.\n"],
    ];
    for (const [before, after] of pairs) expect(apply(before, diffWords(before, after))).toBe(after);
  });
});
