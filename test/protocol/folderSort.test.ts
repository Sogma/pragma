import { describe, expect, it } from "vitest";
import {
  compareEntryNames,
  orderByProperty,
  parseFolderSort,
  parseSortChoice,
  sameSortChoice,
  toSortValue,
} from "../../src/protocol/folderSort.ts";

describe("compareEntryNames", () => {
  it("puts folders first, then names as a person counts them, case aside but never tied", () => {
    const entries = [
      { name: "take 10.md", type: "file" as const },
      { name: "b", type: "directory" as const },
      { name: "Take 2.md", type: "file" as const },
      { name: "take 2.md", type: "file" as const },
      { name: "a", type: "directory" as const },
    ];
    expect(entries.sort(compareEntryNames).map((entry) => entry.name)).toEqual([
      "a",
      "b",
      "Take 2.md",
      "take 2.md",
      "take 10.md",
    ]);
  });
});

describe("parseSortChoice", () => {
  it("reads each sort, defaulting the order to ascending and trimming a property's key", () => {
    expect(parseSortChoice({ by: "manual" })).toEqual({ by: "manual" });
    expect(parseSortChoice({ by: "size", order: "desc" })).toEqual({ by: "size", order: "desc" });
    expect(parseSortChoice({ by: "created" })).toEqual({ by: "created", order: "asc" });
    expect(parseSortChoice({ by: "property", property: " date ", order: "desc" })).toEqual({
      by: "property",
      property: "date",
      order: "desc",
    });
  });

  it("reads anything else as none, the forms before `by` included", () => {
    for (const value of [
      undefined,
      "name",
      ["manual"],
      { order: "desc" },
      { by: "colour", order: "desc" },
      { by: "property", property: " ", order: "desc" },
    ]) {
      expect(parseSortChoice(value)).toBeUndefined();
    }
  });
});

describe("parseFolderSort", () => {
  it("reads every sort but manual, which a folder keeps as its _structure.json", () => {
    expect(parseFolderSort({ by: "modified", order: "desc" })).toEqual({ by: "modified", order: "desc" });
    expect(parseFolderSort({ by: "manual" })).toBeUndefined();
  });
});

describe("sameSortChoice", () => {
  it("compares kind, direction and property; any two manual orders are the same choice", () => {
    expect(sameSortChoice({ by: "manual" }, { by: "manual" })).toBe(true);
    expect(sameSortChoice({ by: "name", order: "asc" }, { by: "name", order: "desc" })).toBe(false);
    expect(sameSortChoice({ by: "name", order: "asc" }, { by: "manual" })).toBe(false);
    const date = { by: "property", property: "date", order: "desc" } as const;
    expect(sameSortChoice(date, { ...date })).toBe(true);
    expect(sameSortChoice(date, { ...date, property: "title" })).toBe(false);
  });
});

describe("toSortValue", () => {
  it("reads ISO dates as instants, a zoneless time as UTC", () => {
    expect(toSortValue("2026-09-24")).toBe(Date.UTC(2026, 8, 24));
    expect(toSortValue("2026-09-24T10:30")).toBe(Date.UTC(2026, 8, 24, 10, 30));
    expect(toSortValue("2026-09-24T10:30:00+02:00")).toBe(Date.UTC(2026, 8, 24, 8, 30));
  });

  it("keeps free-form text as text", () => {
    expect(toSortValue("March 3")).toBe("March 3");
    expect(toSortValue("2026")).toBe("2026");
  });

  it("has no value for empty, list or map entries", () => {
    for (const raw of [undefined, null, "", "  ", [1], { a: 1 }, Number.NaN]) {
      expect(toSortValue(raw)).toBeUndefined();
    }
  });
});

describe("orderByProperty", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const values: Record<string, unknown> = { a: "2026-03-01", b: undefined, c: "2026-01-15", d: "2026-03-01", e: 5 };
  const sortValueOf = (node: string) => toSortValue(values[node]);

  it("orders by value, ties and missing values in their given order", () => {
    expect(orderByProperty(nodes, { order: "asc" }, sortValueOf)).toEqual(["e", "c", "a", "d", "b"]);
  });

  it("keeps missing values last when descending", () => {
    expect(orderByProperty(nodes, { order: "desc" }, sortValueOf)).toEqual(["a", "d", "c", "e", "b"]);
  });

  it("puts numbers and dates before text", () => {
    const mixed: Record<string, unknown> = { x: "draft", y: "2026-01-01", z: 3 };
    const order = orderByProperty(["x", "y", "z"], { order: "asc" }, (node) => toSortValue(mixed[node]));
    expect(order).toEqual(["z", "y", "x"]);
  });

  it("orders text naturally, ignoring case", () => {
    const titles = ["Post 10", "post 2", "Post 1"];
    expect(orderByProperty(titles, { order: "asc" }, (title) => title)).toEqual(["Post 1", "post 2", "Post 10"]);
  });
});
