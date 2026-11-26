// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { propertyIcon } from "../../../web/lib/propertyIcon.ts";

function icon(key: string, data: Record<string, unknown>, path?: string) {
  const { knownKey, valueType } = propertyIcon(key, data, path).dataset;
  return { knownKey, valueType };
}

describe("propertyIcon", () => {
  it("names what Pragma does with a key it acts on, whatever its value", () => {
    for (const key of ["tags", "description", "date", "visibility"]) {
      expect(icon(key, { [key]: 3 })).toEqual({ knownKey: key, valueType: undefined });
    }
  });

  it("gives `pragma` the scope mark only in an AGENTS.md, the file that opens a scope", () => {
    expect(icon("pragma", { pragma: null }, "projects/forbidden/AGENTS.md").knownKey).toBe("pragma");
    expect(icon("pragma", { pragma: null }, "AGENTS.md").knownKey).toBe("pragma");
    expect(icon("pragma", { pragma: null }, "projects/forbidden/README.md")).toEqual({
      knownKey: undefined,
      valueType: "text",
    });
    expect(icon("pragma", { pragma: null }, "projects/notes.md")).toEqual({ knownKey: undefined, valueType: "text" });
    expect(icon("pragma", { pragma: null })).toEqual({ knownKey: undefined, valueType: "text" });
  });

  it("names any other key's value type", () => {
    const data = { a: "x", b: "", c: null, d: 4, e: false, f: ["x"], g: { h: 1 } };
    expect(Object.keys(data).map((key) => icon(key, data).valueType)).toEqual([
      "text",
      "text",
      "text",
      "number",
      "boolean",
      "list",
      "object",
    ]);
  });

  it("is hidden from assistive tech: the key beside it names the row", () => {
    expect(propertyIcon("a", { a: "x" }).getAttribute("aria-hidden")).toBe("true");
  });

  it("names the type of the field a Class gives a key, over its value's, but never over a known key", () => {
    const rated = propertyIcon("rating", { rating: 4 }, undefined, { type: "score" }).dataset;
    expect([rated.fieldType, rated.valueType]).toEqual(["score", undefined]);
    expect(propertyIcon("tags", { tags: ["a"] }, undefined, { type: "select" }).dataset.knownKey).toBe("tags");
  });
});
