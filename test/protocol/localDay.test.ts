import { describe, expect, it } from "vitest";
import { localDay, localDayAfter, parseLocalDay } from "../../src/protocol/localDay.ts";

describe("localDay", () => {
  // UTC would already be a day on for a late evening west of Greenwich.
  it("writes the day on the machine's own clock", () => {
    expect(localDay(new Date(2026, 9, 19, 23, 59))).toBe("2026-10-19");
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("counts on by calendar days, across months and years", () => {
    expect(localDayAfter(new Date(2026, 9, 19, 14, 2), 30)).toBe("2026-11-18");
    expect(localDayAfter(new Date(2026, 9, 19), 90)).toBe("2027-01-17");
    expect(localDayAfter(new Date(2026, 1, 28), 1)).toBe("2026-03-01");
  });
});

describe("parseLocalDay", () => {
  it("reads a real day as its local midnight", () => {
    expect(parseLocalDay("2024-02-29")).toEqual(new Date(2024, 1, 29));
  });

  it("refuses a day the calendar lacks and anything not shaped as one", () => {
    for (const value of ["2026-02-30", "2026-13-01", "2026-1-5", "2026-01-05T00:00", "", "tomorrow"]) {
      expect(parseLocalDay(value)).toBeUndefined();
    }
  });
});
