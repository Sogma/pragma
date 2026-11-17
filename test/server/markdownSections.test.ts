import { describe, expect, it } from "vitest";
import { findSection, headingsPast, outlineOf, sectionText } from "../../src/server/markdownSections.ts";

const NOTE = [
  "---",
  "title: Look",
  "## not a heading, inside the frontmatter",
  "---",
  "# Visual Style",
  "",
  "## Lighting",
  "Warm practicals.",
  "### Night",
  "Blue.",
  "```",
  "## not a heading, inside a fence",
  "```",
  "## Lighting",
  "Again.",
  "## C# ##",
  "Sharp.",
].join("\n");

describe("a note's outline", () => {
  it("lists its headings outside frontmatter and fences, a lone # title left out, repeats numbered", () => {
    const outline = outlineOf(NOTE);
    expect(outline.sections.map(({ level, title, anchor }) => [level, title, anchor])).toEqual([
      [2, "Lighting", "lighting"],
      [3, "Night", "night"],
      [2, "Lighting", "lighting-1"],
      [2, "C#", "c"],
    ]);
  });

  it("keeps # headings as sections where a note has several", () => {
    expect(outlineOf("# One\nA\n# Two\nB\n").sections.map((section) => section.title)).toEqual(["One", "Two"]);
  });

  it("finds a section by its title or anchor, holding its subsections up to the next heading of its level", () => {
    const outline = outlineOf(NOTE);
    const lighting = findSection(outline, "Lighting");
    expect(lighting && sectionText(outline, lighting)).toBe(
      "## Lighting\nWarm practicals.\n### Night\nBlue.\n```\n## not a heading, inside a fence\n```",
    );
    const again = findSection(outline, "#lighting-1");
    expect(again && sectionText(outline, again)).toBe("## Lighting\nAgain.");
    expect(findSection(outline, "Shadows")).toBeUndefined();
  });

  it("says where a cut falls: the heading before it, and the headings past it", () => {
    const outline = outlineOf("## A\naaaa\n## B\nbbbb\n## C\ncccc\n");
    const { within, after } = headingsPast(outline, 12);
    expect(within?.title).toBe("B");
    expect(after.map((section) => section.title)).toEqual(["C"]);
  });
});
