import { describe, expect, it } from "vitest";
import { fountainDescription, synopsisLines } from "../../src/protocol/fountainSynopsis.ts";

describe("synopsisLines", () => {
  it("finds every `=` line with its span and text", () => {
    const source = "= The whole file.\n\nEXT. SNOW - DAY\n\n  = A door opens.\n\nSnow falls.";
    expect(synopsisLines(source)).toEqual([
      { number: 1, from: 0, to: 17, text: "The whole file." },
      { number: 5, from: 36, to: 53, text: "A door opens." },
    ]);
  });

  it("finds none in a boneyard, on the title page, or in a note over several lines", () => {
    const source = [
      "Title: = Not a synopsis",
      "Credit: = Nor this",
      "",
      "/* cut:",
      "= Gone",
      "*/",
      "[[a note",
      "= still the note",
      "]]",
      "= Kept",
    ].join("\n");
    expect(synopsisLines(source).map((line) => line.text)).toEqual(["Kept"]);
  });

  it("counts a synopsis after a `[[` an empty line left open, which is no note", () => {
    expect(synopsisLines("[[never closed\n\n= Counted\n\nLater ]]").map((line) => line.text)).toEqual(["Counted"]);
  });

  it("keeps the title page going through a line of spaces", () => {
    expect(synopsisLines("Title: Big Fish\n  \n= Still the title page\n\n= Kept").map((line) => line.text)).toEqual([
      "Kept",
    ]);
  });

  it("reads `===` as a page break", () => {
    expect(synopsisLines("===\n\n= After the break")).toHaveLength(1);
  });

  it("leaves a carriage return out of a line's span", () => {
    expect(synopsisLines("= One\r\nEXT. SNOW")).toEqual([{ number: 1, from: 0, to: 5, text: "One" }]);
  });
});

describe("fountainDescription", () => {
  it("is the first synopsis with text, wherever it sits", () => {
    expect(fountainDescription("EXT. SNOW - DAY\n\n=\n\n= A door opens.\n\n= Later.")).toBe("A door opens.");
  });

  it("is undefined for a screenplay with none", () => {
    expect(fountainDescription("EXT. SNOW - DAY\n\nSnow falls.")).toBeUndefined();
  });
});
