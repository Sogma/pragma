// The `#` tag suggester for Markdown: once a tag's name is begun, the
// space's tags, declared ones first, as the tag inputs suggest them. Read
// from the list the browser keeps, so typing never asks the server.
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { holdsProse, tagsInProse } from "../src/protocol/inlineTags.ts";
import { tagKey } from "../src/protocol/tags.ts";
import { suggested, type TagSource } from "./lib/tagSuggestions.ts";

function inProse(context: CompletionContext): boolean {
  const tree = syntaxTree(context.state);
  for (let node: SyntaxNode | null = tree.resolveInner(context.pos, -1); node; node = node.parent) {
    if (!holdsProse(node.name)) return false;
  }
  return true;
}

// The tag the cursor ends, by the rule a note's tags are read by: a `#`
// alone, as a heading begins, offers nothing.
export function tagSource(tags: TagSource) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const at = before.lastIndexOf("#");
    if (at === -1 || !inProse(context)) return null;
    const [typed] = tagsInProse(before.slice(at), line.from + at, at === 0 ? "" : before[at - 1]);
    if (!typed || typed.to !== context.pos) return null;
    // What's typed whole is no suggestion: Enter after it starts a line.
    const seen = new Set([tagKey(typed.name)]);
    const options = suggested(tags).flatMap((tag) => {
      const key = tagKey(tag.name);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ label: `#${tag.name}` }];
    });
    return options.length > 0 ? { from: typed.from, options } : null;
  };
}

export function tagCompletion(tags: TagSource): Extension {
  return markdownLanguage.data.of({ autocomplete: tagSource(tags) });
}
