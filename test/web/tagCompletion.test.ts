import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { tagSource } from "../../web/tagCompletion.ts";

const tags = {
  known: () => [
    { name: "Draft", color: "#e03e3e" },
    { name: "draft", color: "" },
    { name: "night", color: "" },
  ],
  read: async () => [],
  used: () => ["rain", "Night"],
};

// `^` in `doc` marks the cursor.
function complete(doc: string): CompletionResult | null {
  const pos = doc.indexOf("^");
  const text = doc.replace("^", "");
  const state = EditorState.create({ doc: text, extensions: markdown() });
  ensureSyntaxTree(state, text.length);
  return tagSource(tags)(new CompletionContext(state, pos, false)) as CompletionResult | null;
}

describe("the # tag suggester", () => {
  it("offers the space's tags once a name is begun, declared ones first, each once in any case", () => {
    const result = complete("Some #d^");
    expect(result?.from).toBe(5);
    expect(result?.options.map((option) => option.label)).toEqual(["#Draft", "#night", "#rain"]);
  });

  it("leaves out the tag typed whole, so Enter after it starts a line", () => {
    expect(complete("#night^")?.options.map((option) => option.label)).toEqual(["#Draft", "#rain"]);
  });

  it("offers nothing for a # alone, a # that starts no tag, or one in code", () => {
    expect(complete("#^")).toBeNull();
    expect(complete("# ^")).toBeNull();
    expect(complete("C#d^")).toBeNull();
    expect(complete("`#d^`")).toBeNull();
    expect(complete("```\n#d^\n```")).toBeNull();
  });
});
