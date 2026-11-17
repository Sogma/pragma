import { describe, expect, it } from "vitest";
import { parseLocalSort } from "../../src/protocol/localSort.ts";

describe("parseLocalSort", () => {
  it("keeps a sort, an arrangement, or both, and nothing that keeps neither", () => {
    expect(parseLocalSort({ sort: { by: "manual" }, arrangement: ["b.md", "a.md"] })).toEqual({
      sort: { by: "manual" },
      arrangement: ["b.md", "a.md"],
    });
    expect(parseLocalSort({ arrangement: ["a.md"], sort: "name" })).toEqual({ arrangement: ["a.md"] });
    expect(parseLocalSort({ sort: { by: "size", order: "desc" }, arrangement: [1] })).toEqual({
      sort: { by: "size", order: "desc" },
    });
    expect(parseLocalSort({})).toBeUndefined();
    expect(parseLocalSort(null)).toBeUndefined();
  });
});
