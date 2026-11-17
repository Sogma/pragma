import { describe, expect, it } from "vitest";
import {
  fountainNotes,
  fountainTitlePage,
  frameLine,
  type LineFrame,
  startFrame,
} from "../../src/protocol/fountainLines.ts";

// Each note's text, brackets included.
function notes(source: string): string[] {
  return fountainNotes(source).map((note) => source.slice(note.from, note.to));
}

describe("fountainNotes", () => {
  it("finds a note inside a line, several on one, and one over several lines", () => {
    expect(notes("He waits [[check blocking]] and [[this]].")).toEqual(["[[check blocking]]", "[[this]]"]);
    expect(notes("Snow falls. [[Ask Lina about\n= the ending\nbefore Friday]] She goes.")).toEqual([
      "[[Ask Lina about\n= the ending\nbefore Friday]]",
    ]);
  });

  it("keeps a note together across a line of spaces", () => {
    expect(notes("[[one\n  \ntwo]]")).toEqual(["[[one\n  \ntwo]]"]);
  });

  it("leaves a `[[` as text when an empty line or the end comes before its `]]`", () => {
    expect(notes("[[never closed\n\nSnow falls. [[closed]]")).toEqual(["[[closed]]"]);
    expect(notes("Snow falls. [[the end?")).toEqual([]);
  });

  it("finds none on the title page or in a boneyard", () => {
    expect(notes("Title: [[draft]]\n\n/* [[cut]] */\nSnow falls.")).toEqual([]);
  });
});

function frames(source: string): LineFrame[] {
  const state = startFrame();
  return source.split("\n").map((line) => frameLine(state, line));
}

describe("frameLine", () => {
  it("reads a title page from the top to its first empty line", () => {
    expect(frames("Title: Big Fish\nCredit: Written by\n\n= A synopsis")).toEqual([
      "title-page",
      "title-page",
      "blank",
      "text",
    ]);
  });

  it("keeps the title page through a line of spaces, which is content, not blank", () => {
    expect(frames("Title: Big Fish\n  \n= Still the title page\n\nSnow falls.")).toEqual([
      "title-page",
      "title-page",
      "title-page",
      "blank",
      "text",
    ]);
  });

  it("has no title page when the first line that isn't blank isn't `Key: value`, a line of spaces included", () => {
    expect(frames("\nEXT. SNOW - DAY\n\nTitle: too late")).toEqual(["blank", "text", "blank", "text"]);
    expect(frames("  \nTitle: too late")).toEqual(["text", "text"]);
  });

  it("frames a boneyard by whole lines, an empty line in it included, and lets the title page wait for it", () => {
    expect(frames("/* cut:\n\nGone */\nTitle: Kept\n\nText")).toEqual([
      "boneyard",
      "boneyard",
      "boneyard",
      "title-page",
      "blank",
      "text",
    ]);
    expect(frames("Before /* gone */ after")).toEqual(["boneyard"]);
  });
});

describe("fountainTitlePage", () => {
  it("reads each key and its value, a value running on over the lines below", () => {
    const source = [
      "Title:",
      "    _**BRICK & STEEL**_",
      "    _**FULL RETIRED**_",
      "Credit: Written by",
      "Draft date: 1/20/2012",
      "",
      "EXT. BRICK'S PATIO - DAY",
    ].join("\n");
    expect(fountainTitlePage(source)).toEqual([
      { key: "Title", value: "_**BRICK & STEEL**_ _**FULL RETIRED**_" },
      { key: "Credit", value: "Written by" },
      { key: "Draft date", value: "1/20/2012" },
    ]);
  });

  it("has none when the source opens with anything but a key", () => {
    expect(fountainTitlePage("EXT. PATIO - DAY\n\nTitle: not a title page\n")).toEqual([]);
    expect(fountainTitlePage("")).toEqual([]);
  });

  it("passes over a boneyard before the page, and stops at its first empty line", () => {
    expect(fountainTitlePage("/* draft */\r\nTitle: Brick\r\n\r\nAuthor: nobody\r\n")).toEqual([
      { key: "Title", value: "Brick" },
    ]);
  });
});
