// @vitest-environment jsdom
// Splitting off the properties extracts a leading `# Heading` through
// markdownRender.ts, which builds a real DOM node to do it — see that
// file's own "not DOM-free" caveat. Only this one code path needs it; every other
// module in test/web stays on the default node environment.
import { describe, expect, it } from "vitest";
import type { FileResponse, TextFileResponse } from "../../../web/core/apiClient.ts";
import {
  activeTitleFor,
  coerceScalarPropertyValue,
  composeDocumentContent,
  countWordsAndChars,
  displayTitleOf,
  splitDocumentProperties,
  splitExactly,
  titleFromName,
} from "../../../web/core/documentContent.ts";

function textFile(content: string, documentType: TextFileResponse["documentType"] = "note"): TextFileResponse {
  return { kind: "text", path: "note.md", revision: "rev-1", content, documentType, toolkits: [], classLinks: [] };
}

describe("displayTitleOf", () => {
  it("reads a note's leading heading, past its frontmatter", () => {
    expect(displayTitleOf(textFile("---\ntags: [a]\n---\n# Bob *Smith*\n\nBody"))).toBe("Bob Smith");
    expect(displayTitleOf(textFile("No heading here"))).toBeUndefined();
  });

  it("has no title for a screenplay, and takes a Table's or an Applet's stored name", () => {
    expect(displayTitleOf(textFile("# Not a title", "screenplay"))).toBeUndefined();
    expect(displayTitleOf({ kind: "table", name: "Takes" } as FileResponse)).toBe("Takes");
    expect(displayTitleOf({ kind: "table", name: "" } as FileResponse)).toBeUndefined();
    expect(
      displayTitleOf({ kind: "applet", manifest: { version: "1", meta: { name: "Picker" } } } as FileResponse),
    ).toBe("Picker");
  });
});

describe("activeTitleFor", () => {
  it("uses the heading text when there is one", () => {
    expect(activeTitleFor("My Title", "notes/a.md")).toEqual({ text: "My Title", placeholder: "a" });
  });

  it("falls back to an empty text with the stripped filename as placeholder", () => {
    expect(activeTitleFor(undefined, "notes/a.md")).toEqual({ text: "", placeholder: "a" });
    expect(activeTitleFor(undefined, "lib:lab/story.flow.html")).toEqual({ text: "", placeholder: "story" });
  });
});

describe("titleFromName", () => {
  it("reads a dashed or underscored name as a title", () => {
    expect(titleFromName("music-references")).toBe("Music References");
    expect(titleFromName("fitness_training")).toBe("Fitness Training");
    expect(titleFromName("about")).toBe("About");
    expect(titleFromName("--")).toBe("");
  });

  it("leaves a minor English word lowercase inside the title, never first or last", () => {
    expect(titleFromName("terms-of-service")).toBe("Terms of Service");
    expect(titleFromName("the-future")).toBe("The Future");
    expect(titleFromName("what-are-you-looking-at")).toBe("What Are You Looking At");
    // Spanish particles aren't minor: lowercasing them would also give "Welcome to los Angeles".
    expect(titleFromName("la-vida-es-un-carnaval")).toBe("La Vida Es Un Carnaval");
  });

  it("keeps a word's own capitals, a dash between digits, and a word that opens with a digit", () => {
    expect(titleFromName("iPhone-tips")).toBe("iPhone Tips");
    expect(titleFromName("API_notes")).toBe("API Notes");
    expect(titleFromName("Music References")).toBe("Music References");
    expect(titleFromName("meeting-2026-10-27")).toBe("Meeting 2026-10-27");
    expect(titleFromName("2nd-draft")).toBe("2nd Draft");
    expect(titleFromName("(old)-notes")).toBe("(Old) Notes");
  });
});

describe("composeDocumentContent", () => {
  it("returns the doc unchanged with no title and no properties", () => {
    expect(composeDocumentContent("body text", undefined, undefined)).toBe("body text");
  });

  it("prepends the title heading when title is non-blank", () => {
    expect(composeDocumentContent("body text", "My Title", undefined)).toBe("# My Title\n\nbody text");
  });

  it("writes no heading for a blank/whitespace-only title", () => {
    expect(composeDocumentContent("body text", "   ", undefined)).toBe("body text");
  });

  it("wraps the body in the frontmatter block as written", () => {
    const result = composeDocumentContent("body text", undefined, "tags: [a] # mine");
    expect(result).toBe("---\ntags: [a] # mine\n---\n\nbody text");
  });

  it("combines title and frontmatter together", () => {
    const result = composeDocumentContent("body text", "My Title", "tags:\n  - a");
    expect(result).toBe("---\ntags:\n  - a\n---\n\n# My Title\n\nbody text");
  });
});

describe("writing a note's title back", () => {
  // A file split as the editor opens it, then put back together as a save
  // does, with the title bar left alone or holding `title`.
  function saved(content: string, title?: string): string {
    const split = splitDocumentProperties(textFile(content));
    return composeDocumentContent(split.body, title ?? split.title, split.frontmatter, split.read, split.gap);
  }

  it("writes a heading nobody edited back exactly as the file holds it", () => {
    for (const content of [
      "# The *Forbidden* screenplay\n\nbody",
      "# See [the brief](brief.md)\n\nbody",
      "# \\*Draft\\* notes\n\nbody",
      "# ![Logo](logo.png)\n\nbody",
      "A long\ntitle\n===\n\nbody",
      "# Tight\nbody",
      "# Alone",
      "---\ntags: [a]\n---\n\n# Kept\n\n\nbody",
      "\n\n# Opens low\n\nbody",
      "\nno heading",
    ]) {
      expect(saved(content)).toBe(content);
    }
  });

  it("writes an edited title as a heading that reads back as typed", () => {
    expect(saved("# Old\n\nbody", "Part 1: Intro")).toBe("# Part 1: Intro\n\nbody");
    expect(saved("# Old\n\nbody", "*Draft* notes")).toBe("# \\*Draft\\* notes\n\nbody");
    expect(saved("# Old\n\nbody", "Issue #")).toBe("# Issue \\#\n\nbody");
  });

  it("keeps the blank lines the file holds after its block, and leaves out a byte order mark", () => {
    for (const content of [
      "---\ntags: [a]\n---\n# Tight\nbody",
      "---\ntags: [a]\n---\n\n\n# Spaced\n\nbody",
      "---\ntags: [a]\n---\nbody",
      "---\ntags: [a]\n---\n",
    ]) {
      expect(saved(content)).toBe(content);
    }
    expect(saved("\uFEFF---\ntags: [a]\n---\n\n# Note\n\nbody")).toBe("---\ntags: [a]\n---\n\n# Note\n\nbody");
    expect(saved("\uFEFF# Note\n\nbody")).toBe("# Note\n\nbody");
    expect(saved("\uFEFF---\ntitle: Chapter 1: The Start\n---\nbody")).toBe(
      "---\ntitle: Chapter 1: The Start\n---\nbody",
    );
  });

  it("reads a bracket pair in the heading as its text, so an edited title keeps it", () => {
    expect(splitDocumentProperties(textFile("# Notes [draft]\n\nbody")).title).toBe("Notes [draft]");
    expect(saved("# Notes [draft]\n\nbody", "Notes [draft] v2")).toBe("# Notes [draft] v2\n\nbody");
  });

  it("lifts the comments above a heading with it, and keeps them whatever the title becomes", () => {
    const content = "---\ntags: [a]\n---\n\n<!-- license -->\n\n# Old <!-- v2 -->\n\nbody";
    const split = splitDocumentProperties(textFile(content));
    expect(split.title).toBe("Old");
    expect(split.body).toBe("body");
    expect(split.lineOffset).toBe(8);
    expect(saved(content)).toBe(content);
    expect(saved(content, "New")).toBe("---\ntags: [a]\n---\n\n<!-- license -->\n\n# New\n\nbody");
    expect(saved(content, "")).toBe("---\ntags: [a]\n---\n\n<!-- license -->\n\nbody");
  });

  it("writes the heading as the file held it again once the title reads as it did", () => {
    expect(saved("# The *Forbidden* screenplay\n\nbody", " The Forbidden screenplay ")).toBe(
      "# The *Forbidden* screenplay\n\nbody",
    );
  });
});

describe("splitExactly", () => {
  const back = (content: string) => {
    const parts = splitExactly(textFile(content));
    return composeDocumentContent(parts.body, parts.title, parts.frontmatter, parts.read, parts.gap);
  };

  it("splits text as a file is split on load", () => {
    const content = "---\ntags: [a]\n---\n\n# Title\n\nbody";
    expect(splitExactly(textFile(content))).toEqual(splitDocumentProperties(textFile(content)));
  });

  // Text the editor holds whole must come back from its parts as it is, or
  // the next keystroke lands on a file the editor doesn't show.
  it("keeps text whole as the body while a save wouldn't write it back as is", () => {
    for (const content of ["---\ntags: [a]\n---", "\uFEFF# Marked\n\nbody", "", "# Only"]) {
      expect(back(content)).toBe(content);
    }
    expect(splitExactly(textFile("---\ntags: [a]\n---"))).toMatchObject({
      body: "---\ntags: [a]\n---",
      frontmatter: undefined,
      title: undefined,
      properties: {},
    });
  });
});

describe("splitDocumentProperties", () => {
  it("leaves a document that isn't a note entirely untouched", () => {
    const file = textFile("scene content", "screenplay");
    expect(splitDocumentProperties(file)).toEqual({
      properties: undefined,
      body: "scene content",
      lineOffset: 0,
      title: undefined,
    });
  });

  it("splits frontmatter, heading, and body out of a plain note", () => {
    const file = textFile("---\ntags:\n  - a\n---\n\n# My Title\n\nbody text");
    const result = splitDocumentProperties(file);
    expect(result.properties).toEqual({ tags: ["a"] });
    expect(result.title).toBe("My Title");
    expect(result.body).toBe("body text");
  });

  it("yields an empty properties object for a note with no frontmatter", () => {
    const file = textFile("just body text, no heading");
    const result = splitDocumentProperties(file);
    expect(result.properties).toEqual({});
    expect(result.title).toBeUndefined();
    expect(result.body).toBe("just body text, no heading");
    expect(result.lineOffset).toBe(0);
  });

  it("keeps the block's YAML as written, and the blank lines after it, their line breaks as \\n", () => {
    const file = textFile("---\r\ntags: [a] # mine\r\nmood: blue\r\n---\r\n\r\n\r\nbody text");
    expect(splitDocumentProperties(file).frontmatter).toBe("tags: [a] # mine\nmood: blue");
    expect(splitDocumentProperties(file).gap).toBe("\n\n");
    expect(splitDocumentProperties(textFile("no block")).frontmatter).toBeUndefined();
    expect(splitDocumentProperties(textFile("no block")).gap).toBe("");
    // With no block, the blank lines the file opens with stand where its gap would.
    expect(splitDocumentProperties(textFile("\n\n# Low\n\nbody")).gap).toBe("\n\n");
  });

  it("leaves a block that doesn't parse in the body, lifting nothing, and says why", () => {
    const content = "---\ntitle: Chapter 1: The Start\n---\n\n# Chapter 1\n\nbody text";
    expect(splitDocumentProperties(textFile(content))).toEqual({
      properties: undefined,
      frontmatter: undefined,
      frontmatterError: "line 2: Nested mappings are not allowed in compact mappings",
      body: content,
      lineOffset: 0,
      title: undefined,
    });
  });

  it("computes lineOffset as the number of lines consumed by frontmatter + title", () => {
    const file = textFile("---\ntags:\n  - a\n---\n\n# My Title\n\nbody text");
    // "---\n" + "tags:\n" + "  - a\n" + "---\n" + "\n" + "# My Title\n" + "\n" = 7 lines before body
    expect(splitDocumentProperties(file).lineOffset).toBe(7);
  });
});

describe("coerceScalarPropertyValue", () => {
  it("round-trips an integer", () => {
    expect(coerceScalarPropertyValue("5")).toBe(5);
  });

  it("round-trips a boolean", () => {
    expect(coerceScalarPropertyValue("true")).toBe(true);
    expect(coerceScalarPropertyValue("false")).toBe(false);
  });

  it("keeps a plain word as a string, including the literal 'null'", () => {
    expect(coerceScalarPropertyValue("null")).toBe("null");
  });

  it("keeps arbitrary text as a string", () => {
    expect(coerceScalarPropertyValue("hello world")).toBe("hello world");
  });
});

describe("countWordsAndChars", () => {
  it("counts words and chars for plain prose", () => {
    expect(countWordsAndChars("hello world")).toEqual({ words: 2, chars: 11 });
  });

  it("returns zero words but a real char count for whitespace-only text", () => {
    expect(countWordsAndChars("   ")).toEqual({ words: 0, chars: 3 });
  });

  it("returns zero for both on empty text", () => {
    expect(countWordsAndChars("")).toEqual({ words: 0, chars: 0 });
  });
});
