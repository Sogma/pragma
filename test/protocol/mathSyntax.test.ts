import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { mathSyntax, readMath } from "../../src/protocol/mathSyntax.ts";

const markdown = parser.configure([GFM, mathSyntax]);

// Each math node in `text`, in order: inline or block, and its TeX, marked
// `display` when it is display math.
function math(text: string): string[] {
  const found: string[] = [];
  markdown.parse(text).iterate({
    enter(node) {
      if (node.name !== "InlineMath" && node.name !== "BlockMath") return;
      const { tex, display } = readMath(node.node, (from, to) => text.slice(from, to));
      found.push(`${node.name === "BlockMath" ? "block" : "inline"}${display ? " display" : ""}: ${tex}`);
    },
  });
  return found;
}

function tree(text: string): string {
  return markdown.parse(text).toString();
}

describe("inline math", () => {
  it("is TeX between `$` marks, or display math between `$$` marks", () => {
    expect(math("Euler: $e^{i\\pi} + 1 = 0$.")).toEqual(["inline: e^{i\\pi} + 1 = 0"]);
    expect(math("so $$\\sum_i x_i$$ holds")).toEqual(["inline display: \\sum_i x_i"]);
  });

  it("opens only before a non-blank and closes only after one, never before a digit", () => {
    expect(math("costs $5 and $10")).toEqual([]);
    expect(math("$ x$ and $x $ and $5,$6")).toEqual([]);
  });

  it("closes at the next `$` that can", () => {
    expect(math("a $b $c$ d")).toEqual(["inline: b $c"]);
    expect(math("$x$5 then $y$")).toEqual(["inline: x$5 then $y"]);
    expect(math("$HOME/$PATH")).toEqual(["inline: HOME/"]);
  });

  it("is not opened by an escaped `$`, nor closed by one inside it", () => {
    expect(math("\\$x$ is text")).toEqual([]);
    expect(math("$a \\$ b$")).toEqual(["inline: a \\$ b"]);
  });

  it("leaves a placeholder's `$` alone", () => {
    expect(math("{{$title}} on {{$date}}")).toEqual([]);
    expect(math("Title: {{$title}}\nDate: {{$date:%Y}}")).toEqual([]);
    expect(math("$x$ on {{$date}}")).toEqual(["inline: x"]);
  });

  it("holds no other syntax, and none holds it but a link's label", () => {
    expect(tree("$*a* [[b]] #c `d`$")).toBe("Document(Paragraph(InlineMath(MathMark,MathMark)))");
    expect(math("`$code$` and $m$")).toEqual(["inline: m"]);
    expect(math("[$x$](url) # $\\alpha$")).toEqual(["inline: x", "inline: \\alpha"]);
  });

  it("reads in headings and table cells", () => {
    expect(math("# The $\\alpha$ particle")).toEqual(["inline: \\alpha"]);
    expect(math("| a | $b$ |\n|---|---|\n| $c$ | d |")).toEqual(["inline: b", "inline: c"]);
  });

  it("holds no empty display math", () => {
    expect(math("x $$$$ y")).toEqual([]);
  });
});

describe("block math", () => {
  it("runs from a line opening with `$$` to one closing with it", () => {
    expect(math("$$\n\\int_0^1 x\\,dx\n= \\tfrac12\n$$")).toEqual(["block display: \\int_0^1 x\\,dx\n= \\tfrac12"]);
    expect(math("$$ a\nb $$")).toEqual(["block display: a\nb"]);
  });

  it("keeps a line's TeX that would read as Markdown, blank lines and all", () => {
    expect(math("$$\n# x\n- y\n\n> z\n$$")).toEqual(["block display: # x\n- y\n> z"]);
  });

  it("ends a paragraph above it, as fenced code does", () => {
    expect(tree("The equation\n$$\nE = mc^2\n$$\nfollows.")).toBe(
      "Document(Paragraph,BlockMath(MathMark,MathText,MathMark),Paragraph)",
    );
  });

  it("is a paragraph's display math when its line holds another `$`", () => {
    expect(math("$$x = 1$$")).toEqual(["inline display: x = 1"]);
  });

  it("closes only on a run as long as the opening one, with no `$` before it", () => {
    expect(math("$$$\na $$\n$$$")).toEqual(["block display: a $$"]);
    expect(math("$$\na$b$$\n$$")).toEqual(["block display: a$b$$"]);
  });

  it("runs to the end of the note when left open", () => {
    expect(math("$$\nx\n\nmore")).toEqual(["block display: x\nmore"]);
  });

  it("stays in the quote or list item holding it, without their marks", () => {
    expect(math("> $$\n> a\n>\n> b\n> $$\nafter")).toEqual(["block display: a\nb"]);
    expect(math("> $$\n> a\nnot quoted")).toEqual(["block display: a"]);
    expect(math("- item\n  $$\n  x\n  $$\n- two")).toEqual(["block display: x"]);
  });

  it("reads a CRLF file's lines without their returns", () => {
    expect(math("$$\r\nx\r\n$$\r\nafter")).toEqual(["block display: x"]);
  });

  it("is code when indented as code", () => {
    expect(math("    $$\n    x\n    $$")).toEqual([]);
    expect(tree("    $$\n    x\n    $$")).toMatch(/^Document\(CodeBlock\(/);
  });
});
