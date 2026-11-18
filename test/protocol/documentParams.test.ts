import { describe, expect, it } from "vitest";
import { documentParamKeys, documentParams, paramKeyOf } from "../../src/protocol/documentParams.ts";
import { parseFrontmatterYaml } from "../../src/protocol/frontmatter.ts";

// The shape Sogma serves as components.schemas.DocumentParams.
const sogmaSchema = {
  type: "object",
  description: "Hints a theme reads for this one document.",
  properties: {
    anchor: { type: "string", title: "Anchor", pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$", maxLength: 100 },
  },
  additionalProperties: false,
};

describe("documentParamKeys", () => {
  it("reads the keys a publisher takes from its schema's properties", () => {
    expect(documentParamKeys(sogmaSchema)).toEqual(["anchor"]);
  });

  it("tells a publisher that takes no params from one that lists none", () => {
    expect(documentParamKeys(undefined)).toBeUndefined();
    expect(documentParamKeys({ type: "object", additionalProperties: false })).toEqual([]);
  });
});

describe("documentParams", () => {
  it("sends each listed key the frontmatter sets, and nothing else", () => {
    const data = parseFrontmatterYaml("date: 2026-11-17\ntags: [release]\nanchor: v0.6.1\n");
    expect(documentParams(data, ["anchor", "unset"])).toEqual({ anchor: "v0.6.1" });
  });

  it("treats empty text as no value", () => {
    expect(documentParams({ anchor: "" }, ["anchor"])).toEqual({});
    expect(documentParams({ anchor: "   " }, ["anchor"])).toEqual({});
  });

  // The publisher judges these, and refuses each one, naming the key.
  it("sends a key with no value, and any other value, as written", () => {
    expect(documentParams(parseFrontmatterYaml("anchor: #v0.6.1\n"), ["anchor"])).toEqual({ anchor: null });
    expect(documentParams(parseFrontmatterYaml("anchor: 1.0\n"), ["anchor"])).toEqual({ anchor: 1 });
    expect(documentParams({ anchor: " v0.6.1 " }, ["anchor"])).toEqual({ anchor: " v0.6.1 " });
  });

  it("keeps a key named like an object built-in as plain data", () => {
    const params = documentParams(JSON.parse('{"__proto__": "x"}'), ["__proto__"]);
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.keys(params)).toEqual(["__proto__"]);
  });
});

describe("paramKeyOf", () => {
  it("names the key a pointer into params blames", () => {
    expect(paramKeyOf("/params/anchor")).toBe("anchor");
    expect(paramKeyOf("/params/a~1b")).toBe("a/b");
  });

  it("names nothing for a pointer anywhere else", () => {
    expect(paramKeyOf("/slug")).toBeUndefined();
    expect(paramKeyOf("/params")).toBeUndefined();
    expect(paramKeyOf(undefined)).toBeUndefined();
  });
});
