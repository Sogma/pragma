import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { commentsOf, leadingCommentsEnd, withoutComments } from "../../src/protocol/markdownComments.ts";

// The comments a whole Markdown text holds, as written.
function comments(text: string): string[] {
  const found: string[] = [];
  parser
    .configure([GFM])
    .parse(text)
    .iterate({
      enter: (ref) => {
        for (const { from, to } of commentsOf(ref, (start, end) => text.slice(start, end))) {
          found.push(text.slice(from, to));
        }
      },
    });
  return found;
}

describe("the comments a Markdown text holds", () => {
  it("takes an inline comment whole, over a line break too", () => {
    expect(comments("Para <!-- one\ntwo --> after, <!-- -- three -->.")).toEqual([
      "<!-- one\ntwo -->",
      "<!-- -- three -->",
    ]);
  });

  it("takes each comment a block holds, and none of the HTML past them", () => {
    expect(comments("<!-- a --> <!-- b --> <b>c</b>\n\n<!--\n\nd\n\n-->")).toEqual([
      "<!-- a -->",
      "<!-- b -->",
      "<!--\n\nd\n\n-->",
    ]);
    expect(withoutComments("<!-- a --> <!-- b --> <b>c</b>")).toBe("  <b>c</b>");
  });

  it("ends `<!-->` and `<!--->` where they start, and runs one left open to its block's end", () => {
    expect(comments("<!-->\n<!--->\n<!---->")).toEqual(["<!-->", "<!--->", "<!---->"]);
    expect(comments("<!-- open\n\nstill")).toEqual(["<!-- open\n\nstill"]);
  });

  it("finds none in code", () => {
    expect(comments("`<!-- a -->`\n\n    <!-- b -->\n\n```\n<!-- c -->\n```")).toEqual([]);
  });
});

describe("where the comments a body opens with end", () => {
  it("is past each comment block and the blank lines among them", () => {
    const body = "\n<!-- a -->\n\n<!--\n\nb\n-->\n# Title\n";
    expect(body.slice(leadingCommentsEnd(body))).toBe("# Title\n");
    expect(leadingCommentsEnd("<!-- a -->\r\n\r\nText")).toBe(14);
  });

  it("is the start for a body that opens with anything else, code indented as a comment included", () => {
    expect(leadingCommentsEnd("Text <!-- a -->")).toBe(0);
    expect(leadingCommentsEnd("    <!-- code -->\nText")).toBe(0);
    expect(leadingCommentsEnd("   <!-- a -->\nText")).toBe(14);
  });

  it("is the body's end while a comment is still open", () => {
    expect(leadingCommentsEnd("<!-- open\n\n# Title")).toBe(18);
    expect(leadingCommentsEnd("<!-- closed -->")).toBe(15);
  });
});
