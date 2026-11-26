import { describe, expect, it } from "vitest";
import {
  hasMetadataBlock,
  isPrivateMetadata,
  METADATA_TYPE_OPTIONS,
  metadataFields,
  metadataFromProperties,
  metadataProperties,
  metadataText,
  stampTableDates,
} from "../../src/protocol/metadata.ts";
import { isPrivateContent } from "../../src/protocol/privacy.ts";
import type { MetadataEntry } from "../../src/protocol/types.ts";

const block: MetadataEntry[] = [
  { key: "description", values: ["Models to pick from."] },
  { key: "tags", values: ["studio"] },
  { key: "aliases", values: ["a", "b"] },
  { key: "status", values: [] },
  { key: "created", values: ["2026-08-08"] },
];

describe("metadata keys", () => {
  it("reads a key's text as its first value", () => {
    expect(metadataText(block, "description")).toBe("Models to pick from.");
    expect(metadataText(block, "aliases")).toBe("a");
    expect(metadataText(block, "status")).toBeUndefined();
    expect(metadataText(undefined, "description")).toBeUndefined();
  });

  it("stamps a Table's created date once and its modified date on every save, each in its place", () => {
    expect(stampTableDates([{ key: "description", values: ["d"] }], "2026-10-19")).toEqual([
      { key: "description", values: ["d"] },
      { key: "created", values: ["2026-10-19"] },
      { key: "modified", values: ["2026-10-19"] },
    ]);
    const saved = stampTableDates(
      [...block, { key: "modified", values: ["2026-09-01"] }, { key: "x", values: [] }],
      "2026-10-19",
    );
    expect(saved.map((entry) => entry.key)).toEqual([...block.map((entry) => entry.key), "modified", "x"]);
    expect(metadataText(saved, "created")).toBe("2026-08-08");
    expect(metadataText(saved, "modified")).toBe("2026-10-19");
    expect(stampTableDates(undefined, "2026-10-19").map((entry) => entry.key)).toEqual(["created", "modified"]);
  });

  it("knows which kinds carry a block", () => {
    for (const name of ["a.table.html", "a.flow.html", "a.class.html"]) {
      expect(hasMetadataBlock(name)).toBe(true);
    }
    for (const name of ["a.md", "a.applet.html", "a.html", "a.fountain"]) expect(hasMetadataBlock(name)).toBe(false);
  });
});

describe("metadata as properties", () => {
  it("shows one value as text, several as a list, none as empty, and tags always as a list", () => {
    expect(metadataProperties(block)).toEqual({
      description: "Models to pick from.",
      tags: ["studio"],
      aliases: ["a", "b"],
      status: "",
      created: "2026-08-08",
    });
  });

  it("writes the editor's properties back in its order, every value as text", () => {
    const properties = { tags: ["studio", " draft ", ""], state: "wip", count: 3, done: false, empty: "", none: null };
    expect(metadataFromProperties(properties)).toEqual([
      { key: "tags", values: ["studio", "draft"] },
      { key: "state", values: ["wip"] },
      { key: "count", values: ["3"] },
      { key: "done", values: ["false"] },
      { key: "empty", values: [] },
      { key: "none", values: [] },
    ]);
  });

  it("round-trips a block through the editor's data", () => {
    expect(metadataFromProperties(metadataProperties(block))).toEqual(block);
  });

  it("carries a key's type through the editor, as a field keyed by the key", () => {
    const typed: MetadataEntry[] = [
      { key: "rating", values: ["4"], field: { type: "score", reject: true } },
      { key: "description", values: ["d"] },
    ];
    const fields = metadataFields(typed);
    expect(fields).toEqual([{ id: "rating", label: "rating", type: "score", reject: true }]);
    expect(metadataFromProperties(metadataProperties(typed), fields)).toEqual(typed);
  });

  it("offers a key every column type but media and path", () => {
    expect(METADATA_TYPE_OPTIONS.map((option) => option.value)).toEqual([
      "checkbox",
      "color",
      "integer",
      "score",
      "select",
      "text",
      "timestamp",
    ]);
  });

  it("keeps a typed date's type when a save stamps it", () => {
    const saved = stampTableDates([{ key: "modified", values: ["2026-09-01"], field: { type: "text" } }], "2026-10-19");
    expect(saved.find((entry) => entry.key === "modified")).toEqual({
      key: "modified",
      values: ["2026-10-19"],
      field: { type: "text" },
    });
  });
});

describe("privacy", () => {
  const table = (rows: string) => `<html data-format="table"><body><dl data-role="metadata">${rows}</dl></body></html>`;

  it("reads a Table's, Flow's or Class's metadata block", () => {
    const marked = table("<dt>visibility</dt><dd>private</dd>");
    for (const name of ["a.table.html", "a.flow.html", "a.class.html"]) {
      expect(isPrivateContent(name, marked)).toBe(true);
    }
    expect(isPrivateContent("a.table.html", table("<dt>visibility</dt><dd>public</dd>"))).toBe(false);
    expect(isPrivateContent("a.table.html", table("<dt>tags</dt><dd>private</dd>"))).toBe(false);
    expect(isPrivateContent("a.table.html", table(""))).toBe(false);
    expect(isPrivateContent("a.table.html", table("<dt>visibility</dt><dd>public</dd><dd>private</dd>"))).toBe(true);
  });

  it("reads a note's frontmatter, unparseable frontmatter counting as private", () => {
    expect(isPrivateContent("a.md", "---\nvisibility: private\n---\nText")).toBe(true);
    expect(isPrivateContent("a.md", "---\nvisibility: [\n---\nText")).toBe(true);
    expect(isPrivateContent("a.md", "Text")).toBe(false);
  });

  it("finds no other kind private", () => {
    const marked = table("<dt>visibility</dt><dd>private</dd>");
    expect(isPrivateContent("a.applet.html", marked)).toBe(false);
    expect(isPrivateContent("a.fountain", "visibility: private")).toBe(false);
  });

  it("takes a list holding private as private", () => {
    expect(isPrivateMetadata([{ key: "visibility", values: ["private"] }])).toBe(true);
    expect(isPrivateMetadata([{ key: "visibility", values: [] }])).toBe(false);
    expect(isPrivateMetadata(undefined)).toBe(false);
  });
});
