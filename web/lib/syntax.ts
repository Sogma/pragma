// Code is colored by class: each map below names what a token is, and
// web/styles/syntax.css paints each name with the --syntax-* token of the
// same name. test/web/lib/syntax.test.ts keeps the three in step.
//
// CSS gives several tags another meaning than HTML and JavaScript do (its
// tagName is a selector, its propertyName a declaration's name), so style
// sheets get a map of their own and each token carries exactly one class.
import type { NodeType } from "@lezer/common";
import { type Highlighter, tagHighlighter, tags } from "@lezer/highlight";

// The tops of a <style> block's parse and of a style attribute's.
const inStyleSheet = (type: NodeType) => type.name === "StyleSheet" || type.name === "Styles";

const markupAndScript = tagHighlighter(
  [
    { tag: tags.angleBracket, class: "syntax-bracket" },
    { tag: [tags.tagName, tags.documentMeta], class: "syntax-tag" },
    { tag: tags.attributeName, class: "syntax-attribute" },
    { tag: tags.attributeValue, class: "syntax-attribute-value" },
    { tag: [tags.string, tags.regexp, tags.escape], class: "syntax-string" },
    { tag: tags.comment, class: "syntax-comment" },
    { tag: tags.number, class: "syntax-number" },
    {
      tag: [
        tags.function(tags.variableName),
        tags.function(tags.definition(tags.variableName)),
        tags.function(tags.propertyName),
      ],
      class: "syntax-function",
    },
    { tag: [tags.controlKeyword, tags.moduleKeyword], class: "syntax-control" },
    {
      tag: [tags.keyword, tags.bool, tags.character, tags.function(tags.punctuation), tags.special(tags.brace)],
      class: "syntax-keyword",
    },
    { tag: [tags.variableName, tags.propertyName], class: "syntax-variable" },
    { tag: [tags.className, tags.typeName], class: "syntax-type" },
  ],
  { scope: (type) => !inStyleSheet(type) },
);

const styleSheet = tagHighlighter(
  [
    { tag: [tags.tagName, tags.className, tags.labelName, tags.definitionOperator], class: "syntax-selector" },
    { tag: [tags.propertyName, tags.attributeName, tags.variableName], class: "syntax-attribute" },
    { tag: [tags.atom, tags.color], class: "syntax-value" },
    { tag: [tags.number, tags.unit], class: "syntax-number" },
    { tag: tags.string, class: "syntax-string" },
    { tag: tags.comment, class: "syntax-comment" },
    { tag: tags.operatorKeyword, class: "syntax-function" },
    { tag: tags.definitionKeyword, class: "syntax-control" },
    { tag: tags.modifier, class: "syntax-keyword" },
  ],
  { scope: inStyleSheet },
);

export const syntaxHighlighters: readonly Highlighter[] = [markupAndScript, styleSheet];
