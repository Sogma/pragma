import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlLanguage } from "@codemirror/lang-html";
import { highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { syntaxHighlighters } from "../../../web/lib/syntax.ts";

// Each colored span of an applet's code with its classes, as the editor draws them.
function spans(code: string): [string, string][] {
  const found: [string, string][] = [];
  highlightTree(htmlLanguage.parser.parse(code), syntaxHighlighters, (from, to, classes) => {
    found.push([code.slice(from, to), classes]);
  });
  return found;
}

const MARKUP = '<!-- note --><div class="stage">Fish &amp; chips</div>';
const SELECTORS = "<style>button.primary:hover, #main > * {}</style>";
const DECLARATIONS =
  '<style>@media (max-width: 600px) { a { color: var(--accent) !important; font: 2px "Inter", serif; fill: #e93147 } }</style>';
const ATTRIBUTES = '<p style="color: red" onclick="go(1)"></p>';
const SCRIPT = `<script>
import { x } from "./y.js";
function go(n) { if (n) return new Map([[\`a\${n}\`, /e+/g]]); }
box.addEventListener("click", async (event) => this.count ?? null ?? true);
</script>`;

describe("syntax classes", () => {
  it("names a tag's parts in markup", () => {
    expect(spans(MARKUP)).toEqual([
      ["<!-- note -->", "syntax-comment"],
      ["<", "syntax-bracket"],
      ["div", "syntax-tag"],
      ["class", "syntax-attribute"],
      ['"stage"', "syntax-attribute-value"],
      [">", "syntax-bracket"],
      ["&amp;", "syntax-keyword"],
      ["</", "syntax-bracket"],
      ["div", "syntax-tag"],
      [">", "syntax-bracket"],
    ]);
  });

  it("reads every part of a style sheet's selector as a selector, tag names included", () => {
    const selectors = spans(SELECTORS).filter(
      ([, classes]) => classes !== "syntax-bracket" && classes !== "syntax-tag",
    );
    expect(selectors).toEqual([
      ["button", "syntax-selector"],
      ["primary", "syntax-selector"],
      ["hover", "syntax-selector"],
      ["main", "syntax-selector"],
      ["*", "syntax-selector"],
    ]);
  });

  it("names a declaration's parts", () => {
    expect(spans(DECLARATIONS)).toEqual(
      expect.arrayContaining([
        ["@media", "syntax-control"],
        ["max-width", "syntax-attribute"],
        ["600px", "syntax-number"],
        ["color", "syntax-attribute"],
        ["var", "syntax-function"],
        ["--accent", "syntax-attribute"],
        ["!important", "syntax-keyword"],
        ['"Inter"', "syntax-string"],
        ["serif", "syntax-value"],
        ["#e93147", "syntax-value"],
      ]),
    );
  });

  it("reads a style attribute as CSS and an event attribute as JavaScript", () => {
    expect(spans(ATTRIBUTES)).toEqual(
      expect.arrayContaining([
        ["red", "syntax-value"],
        ["go", "syntax-function"],
        ["1", "syntax-number"],
      ]),
    );
  });

  it("parts a script's control words from its other keywords", () => {
    expect(spans(SCRIPT)).toEqual(
      expect.arrayContaining([
        ["import", "syntax-control"],
        ["return", "syntax-control"],
        ["function", "syntax-keyword"],
        ["new", "syntax-keyword"],
        ["=>", "syntax-keyword"],
        ["this", "syntax-keyword"],
        ["true", "syntax-keyword"],
        ["${", "syntax-keyword"],
        ["go", "syntax-function"],
        ["addEventListener", "syntax-function"],
        ["n", "syntax-variable"],
        ["count", "syntax-variable"],
        ["Map", "syntax-type"],
        ['"./y.js"', "syntax-string"],
        ["/e+/g", "syntax-string"],
      ]),
    );
  });
});

describe("the syntax stylesheet", () => {
  const stylesDir = fileURLToPath(new URL("../../../web/styles", import.meta.url));
  const read = (name: string) => `\n${readFileSync(path.join(stylesDir, name), "utf8")}`;
  const tokens = read("tokens.css");
  const block = (opening: string) => {
    const start = tokens.indexOf(`\n${opening} {\n`);
    return tokens.slice(start, tokens.indexOf("\n}", start));
  };
  const used = spans([MARKUP, SELECTORS, DECLARATIONS, ATTRIBUTES, SCRIPT].join("\n")).map(([, classes]) => classes);

  it("gives each token exactly one class", () => {
    for (const classes of used) expect(classes.split(" ")).toHaveLength(1);
  });

  it("paints each class from the token of its own name, in both themes", () => {
    const rules = [...read("syntax.css").matchAll(/^\.(syntax-[\w-]+) \{\n\s*color: var\(--([\w-]+)\);\n\}/gm)];
    expect(new Set(rules.map(([, name]) => name))).toEqual(new Set(used));
    for (const [, name, token] of rules) {
      expect(token).toBe(name);
      expect(block(":root")).toContain(`--${name}:`);
      expect(block('html[data-theme="dark"]')).toContain(`--${name}:`);
    }
  });
});
