import { describe, expect, it } from "vitest";
import { formatSelectedRange, parseSelectedRange } from "../../src/protocol/selectedRange.ts";

describe("a selected range written as line:column", () => {
  it("writes both ends, even on one line", () => {
    expect(formatSelectedRange({ startLine: 10, startColumn: 4, endLine: 16, endColumn: 30 })).toBe("10:4-16:30");
    expect(formatSelectedRange({ startLine: 12, startColumn: 4, endLine: 12, endColumn: 30 })).toBe("12:4-12:30");
  });

  it("reads back what it writes", () => {
    const range = { startLine: 10, startColumn: 4, endLine: 16, endColumn: 30 };
    expect(parseSelectedRange(formatSelectedRange(range))).toEqual(range);
  });

  it("refuses a range that isn't whole positions counted from 1", () => {
    const malformed = ["", "12", "12-16", "12:4", "12:4-16", "0:1-1:1", "1:0-1:3", "a:1-2:3", "1.5:1-2:1", " 1:1-1:2"];
    for (const text of malformed) expect(parseSelectedRange(text), text).toBeUndefined();
  });

  it("refuses a range that ends before it starts", () => {
    expect(parseSelectedRange("3:5-3:4")).toBeUndefined();
    expect(parseSelectedRange("4:1-3:9")).toBeUndefined();
    expect(parseSelectedRange("3:4-3:4")).toEqual({ startLine: 3, startColumn: 4, endLine: 3, endColumn: 4 });
  });
});
