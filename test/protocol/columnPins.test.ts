import { describe, expect, it } from "vitest";
import { columnPinsConfig, recordColumns, typedFieldValue, wiredFieldValue } from "../../src/protocol/columnPins.ts";
import { fieldPortType, type TableColumn } from "../../src/protocol/types.ts";

const COLUMNS: TableColumn[] = [
  { id: "prompt", label: "Prompt", type: "text" },
  { id: "image", label: "Image", type: "media", mediaFolder: "renders" },
  { id: "keep", label: "Keep", type: "checkbox" },
  { id: "width", label: "Width", type: "integer" },
  { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
  { id: "added", label: "Added", type: "timestamp", default: "now" },
];

it("maps a column type to its pin's type", () => {
  expect(fieldPortType("checkbox")).toBe("boolean");
  expect(fieldPortType("integer")).toBe("number");
  expect(fieldPortType("score")).toBe("number");
  for (const type of ["text", "select", "color", "media", "timestamp"] as const)
    expect(fieldPortType(type)).toBe("text");
});

describe("what a node keeps of a Table's columns", () => {
  it("keeps what types a port and draws its control, and no more", () => {
    expect(recordColumns(COLUMNS)).toEqual([
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "image", label: "Image", type: "media" },
      { id: "keep", label: "Keep", type: "checkbox" },
      { id: "width", label: "Width", type: "integer" },
      { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
      { id: "added", label: "Added", type: "timestamp", default: "now" },
    ]);
  });

  // Two pins can't share one wire identifier, and a column with no id has
  // none to give.
  it("drops a column without an id and a repeated id, and labels an unlabelled one by its id", () => {
    expect(
      recordColumns([
        { id: "", label: "Nameless", type: "text" },
        { id: "a", label: "", type: "text" },
        { id: "a", label: "Again", type: "checkbox" },
      ]),
    ).toEqual([{ id: "a", label: "a", type: "text" }]);
  });

  it("re-checks what a saved graph holds, as from a hand edit", () => {
    const config = columnPinsConfig({
      tablePath: 7,
      columns: [{ id: "a", label: "A", type: "bogus" }, "junk", { label: "No id" }],
      values: { a: "kept", b: 3 },
    });
    expect(config).toEqual({ tablePath: "", columns: [{ id: "a", label: "A", type: "text" }], values: { a: "kept" } });
  });

  it("keeps a score's scale and reject mark, which draw its control", () => {
    const scores: TableColumn[] = [
      { id: "rating", label: "Rating", type: "score", max: 10, reject: true },
      { id: "wild", label: "Wild", type: "score", max: 40 },
      { id: "n", label: "N", type: "integer", max: 10, reject: true },
    ];
    expect(recordColumns(scores)).toEqual([
      { id: "rating", label: "Rating", type: "score", max: 10, reject: true },
      { id: "wild", label: "Wild", type: "score" },
      { id: "n", label: "N", type: "integer" },
    ]);
    expect(columnPinsConfig({ columns: recordColumns(scores) }).columns[0]).toEqual(scores[0]);
  });
});

describe("a field's value", () => {
  const [prompt, , keep, width] = COLUMNS;

  it("is a wired value as it arrives", () => {
    expect(wiredFieldValue(prompt, { type: "text", value: "a red door" })).toBe("a red door");
    expect(wiredFieldValue(keep, { type: "boolean", value: false })).toBe(false);
    expect(wiredFieldValue(width, { type: "number", value: 1024 })).toBe(1024);
  });

  it("refuses a wired value no field holds", () => {
    expect(() => wiredFieldValue(prompt, { type: "object", value: {} })).toThrow('"Prompt" can\'t hold an object');
    expect(() => wiredFieldValue(prompt, { type: "image", mediaType: "image/png", data: "" })).toThrow(
      '"Prompt" can\'t hold an image',
    );
  });

  it("is typed text as its input would take it", () => {
    expect(typedFieldValue(prompt, "typed")).toBe("typed");
    expect(typedFieldValue(keep, "true")).toBe(true);
    expect(typedFieldValue(keep, "false")).toBe(false);
    expect(typedFieldValue(width, " 640 ")).toBe(640);
    expect(typedFieldValue({ id: "stars", label: "Stars", type: "score" }, "-1")).toBe(-1);
  });

  it("fails on typed text that isn't the whole number its input takes", () => {
    for (const text of ["wide", "6.5", "1e400"]) {
      expect(() => typedFieldValue(width, text), text).toThrow('"Width" isn\'t a whole number');
    }
  });
});
