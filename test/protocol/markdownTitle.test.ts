import { describe, expect, it } from "vitest";
import {
  addTextToNote,
  foldBlanks,
  noteExcerpt,
  splitNoteTitle,
  splitTitleHeading,
  titleHeadingSpan,
} from "../../src/protocol/markdownTitle.ts";

describe("splitTitleHeading", () => {
  it("lifts an ATX heading and the blank lines after it", () => {
    expect(splitTitleHeading("# Chapter One\n\nIt begins.\n")).toEqual({
      title: "Chapter One",
      lead: "",
      rest: "It begins.\n",
    });
  });

  it("lifts a Setext heading", () => {
    expect(splitTitleHeading("Chapter One\n===\n\nIt begins.")).toEqual({
      title: "Chapter One",
      lead: "",
      rest: "It begins.",
    });
  });

  it("reads inline markup as plain text", () => {
    const { title } = splitTitleHeading("# **Draft** of [the plan](plan.md), `v2` \\# &amp; [[notes/a|more]] #\n");
    expect(title).toBe("Draft of the plan, v2 # & more");
  });

  it("decodes entities by HTML's table, and keeps a name HTML doesn't know as written", () => {
    expect(splitTitleHeading("# Caf&eacute; &hellip; &#169; &#x41; &foo; &notit;").title).toBe(
      "Caf\u00e9 \u2026 \u00a9 A &foo; &notit;",
    );
  });

  it("leaves an inline HTML tag out and keeps the text inside it", () => {
    expect(splitTitleHeading("# My <b>bold</b> idea").title).toBe("My bold idea");
    expect(splitTitleHeading("# <b></b>\n\nbody")).toEqual({ title: undefined, lead: "", rest: "# <b></b>\n\nbody" });
  });

  it("folds each run of spaces, tabs and line breaks to one space", () => {
    expect(splitTitleHeading("# Too   many\tspaces").title).toBe("Too many spaces");
    expect(splitTitleHeading("A long\ntitle\n===").title).toBe("A long title");
  });

  it("reads math as written, its marks and all", () => {
    expect(splitTitleHeading("# The $\\alpha$ and $[[0,1]]$ cases").title).toBe("The $\\alpha$ and $[[0,1]]$ cases");
  });

  it("reads a highlight as its text, and a lone == as written", () => {
    expect(splitTitleHeading("# The ==key== part").title).toBe("The key part");
    expect(splitTitleHeading("# a == b").title).toBe("a == b");
  });

  it("reads a URL written in a link's label as text, and keeps a no-break space", () => {
    expect(splitTitleHeading("# [see https://a.com now](https://b.com) end").title).toBe("see https://a.com now end");
    expect(splitTitleHeading("# Chapter 1").title).toBe("Chapter 1");
  });

  it("keeps an image's alt text and drops its source", () => {
    expect(splitTitleHeading("# ![Logo](logo.png) Home").title).toBe("Logo Home");
  });

  // A heading alone holds no definitions, so a bracket pair is its text, and
  // a title edited in the editor writes the brackets back.
  it("keeps a reference-style link's brackets", () => {
    expect(splitTitleHeading("# Notes [draft], [*one*][a] and [two][]").title).toBe(
      "Notes [draft], [one][a] and [two][]",
    );
  });

  it("leaves a body that does not open with a level-1 heading alone", () => {
    for (const body of ["## Section\n\ntext", "Intro\n\n# Later", "#\n\ntext", ""]) {
      expect(splitTitleHeading(body)).toEqual({ title: undefined, lead: "", rest: body });
    }
  });

  // docs/protocol.md's Display title: a comment is no text.
  it("reads a title past the comments above it, which go with it", () => {
    expect(splitTitleHeading("<!-- license -->\n\n# Title\n\nbody")).toEqual({
      title: "Title",
      lead: "<!-- license -->\n\n",
      rest: "body",
    });
    expect(splitTitleHeading("<!-- a -->\n<!--\n\nb\n\n-->\nThe\n===\n\nbody")).toEqual({
      title: "The",
      lead: "<!-- a -->\n<!--\n\nb\n\n-->\n",
      rest: "body",
    });
  });

  it("leaves a comment in the heading out of the title", () => {
    expect(splitTitleHeading("# Draft <!-- v2 --> notes").title).toBe("Draft notes");
    expect(splitTitleHeading("# <!-- only -->\n\nbody")).toEqual({
      title: undefined,
      lead: "",
      rest: "# <!-- only -->\n\nbody",
    });
  });

  it("reads no title past a comment block holding more, or one left open", () => {
    for (const body of ["<!-- a --> <b>b</b>\n# Title", "<!-- open\n\n# Title\n", "Intro <!-- a -->\n\n# Title"]) {
      expect(splitTitleHeading(body)).toEqual({ title: undefined, lead: "", rest: body });
    }
  });
});

describe("foldBlanks", () => {
  it("folds each run of spaces, tabs and line breaks to one space and trims the ends, keeping a no-break space", () => {
    expect(foldBlanks("  a \t\r\n b  c ")).toBe("a b c");
    expect(foldBlanks("a\u00a0 b")).toBe("a\u00a0 b");
  });
});

describe("titleHeadingSpan", () => {
  it("says where the heading splitTitleHeading reads a title from lies, and nothing where it reads none", () => {
    expect(titleHeadingSpan("<!-- draft -->\n# Chapter One\n\nIt begins.")).toEqual({ from: 15, to: 28 });
    expect(titleHeadingSpan("Chapter One\n===\n\nIt begins.")).toEqual({ from: 0, to: 15 });
    for (const body of ["Intro.\n\n# Chapter One", "# <!-- only -->\n\nbody", "## Chapter One"]) {
      expect(titleHeadingSpan(body), body).toBeUndefined();
    }
  });
});

describe("splitNoteTitle", () => {
  it("skips frontmatter, even malformed, before looking for the title", () => {
    expect(splitNoteTitle("---\nkey: [unclosed\n---\n\n# Title\n\nbody")).toEqual({ title: "Title", body: "body" });
  });
});

describe("addTextToNote", () => {
  it("appends on a line of its own, ending the note with a break", () => {
    expect(addTextToNote("# Log\n\n- one\n", "- two", "append")).toBe("# Log\n\n- one\n- two\n");
    expect(addTextToNote("# Log\n\n- one", "- two", "append")).toBe("# Log\n\n- one\n- two\n");
    expect(addTextToNote("", "- one", "append")).toBe("- one\n");
  });

  it("adds the text as it is: its own blank line and closing break, and no others", () => {
    expect(addTextToNote("A\n", "\nB\n", "append")).toBe("A\n\nB\n");
    expect(addTextToNote("A\n", "B\nC", "append")).toBe("A\nB\nC\n");
  });

  it("prepends where the body starts, below the frontmatter and the title", () => {
    expect(addTextToNote("---\ntags: [log]\n---\n\n# Log\n\n- one\n", "- zero", "prepend")).toBe(
      "---\ntags: [log]\n---\n\n# Log\n\n- zero\n- one\n",
    );
    expect(addTextToNote("<!-- kept -->\n# Log\n\n- one\n", "- zero", "prepend")).toBe(
      "<!-- kept -->\n# Log\n\n- zero\n- one\n",
    );
    expect(addTextToNote("Log\n===\n\n- one\n", "- zero", "prepend")).toBe("Log\n===\n\n- zero\n- one\n");
  });

  it("prepends at the top of a note with no title, past any frontmatter and a byte-order mark", () => {
    expect(addTextToNote("- one\n", "- zero", "prepend")).toBe("- zero\n- one\n");
    expect(addTextToNote("---\na: 1\n---\n- one\n", "- zero", "prepend")).toBe("---\na: 1\n---\n- zero\n- one\n");
    expect(addTextToNote("\uFEFF- one\n", "- zero", "prepend")).toBe("\uFEFF- zero\n- one\n");
  });

  it("prepends on a line of its own under a title with no body", () => {
    expect(addTextToNote("# Log\n", "- zero", "prepend")).toBe("# Log\n- zero\n");
    expect(addTextToNote("# Log", "- zero", "prepend")).toBe("# Log\n- zero\n");
    expect(addTextToNote("", "- zero", "prepend")).toBe("- zero\n");
  });

  it("writes the added lines with a CRLF note's breaks, below the blank lines after its title", () => {
    expect(addTextToNote("# Log\r\n\r\n- one\r\n", "- zero", "prepend")).toBe("# Log\r\n\r\n- zero\r\n- one\r\n");
    expect(addTextToNote("# Log\r\n\r\n- one\r\n", "- two\n- three", "append")).toBe(
      "# Log\r\n\r\n- one\r\n- two\r\n- three\r\n",
    );
  });

  it("adds nothing for an empty text", () => {
    expect(addTextToNote("# Log\n", "", "append")).toBe("# Log\n");
    expect(addTextToNote("# Log\n", "", "prepend")).toBe("# Log\n");
  });
});

describe("noteExcerpt", () => {
  it("reads past the frontmatter and title, a line per paragraph, heading or list item", () => {
    const note = [
      "---",
      "tags: [a]",
      "---",
      "# Title",
      "",
      "First **bold** [link](a.md) and [[notes/b|bee]],",
      "still first.",
      "",
      "## Section",
      "",
      "- one",
      "- [ ] two",
      "  1. nested",
      "",
      "> quoted",
      "> on",
    ].join("\n");
    expect(noteExcerpt(note, 1000)).toBe("First bold link and bee, still first.\nSection\none\ntwo\nnested\nquoted on");
  });

  it("leaves out code, tables, pictures, rules and HTML blocks, and reads a hard break as a space", () => {
    const note = [
      "![cover](a.png)",
      "",
      "```",
      "code",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "<div>block</div>",
      "",
      "<!-- aside -->",
      "",
      "Text ![inline](b.png) with a break\\",
      "here.",
    ].join("\n");
    expect(noteExcerpt(note, 1000)).toBe("Text with a break here.");
  });

  it("leaves out block math and reads inline math as written", () => {
    expect(noteExcerpt("Area $\\pi r^2$ of\n\n$$\nA = \\pi r^2\n$$\n\nNext.", 1000)).toBe("Area $\\pi r^2$ of\nNext.");
  });

  it("leaves out comments, a title's and any in the text", () => {
    expect(
      noteExcerpt("<!-- above -->\n# Title\n\nFirst <!-- aside --> line.\n\n<!-- a\nblock -->\n\nNext.", 1000),
    ).toBe("First line.\nNext.");
  });

  it("keeps inline HTML as written, as reading view shows it", () => {
    expect(noteExcerpt("Q: <describe the problem> What went <b>wrong</b>?", 1000)).toBe(
      "Q: <describe the problem> What went <b>wrong</b>?",
    );
  });

  it("is undefined for a note with no text past its title", () => {
    for (const note of ["", "# Title\n", "---\nstatus: done\n---\n", "# Title\n\n![cover](a.png)\n"]) {
      expect(noteExcerpt(note, 1000)).toBeUndefined();
    }
  });

  it("ends past its limit at a word, with an ellipsis", () => {
    expect(noteExcerpt("one two three", 13)).toBe("one two three");
    expect(noteExcerpt("one two three", 9)).toBe("one two…");
    expect(noteExcerpt("one two three", 7)).toBe("one two…");
    expect(noteExcerpt("onetwothree", 6)).toBe("onetwo…");
  });
});
