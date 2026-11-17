import { describe, expect, it } from "vitest";
import { dateLabel, dateTimeLabel, shortWhen, versionWhen } from "../../../web/lib/dateText.ts";

const NOW = new Date(2026, 10, 1, 15, 30).getTime();
const HOUR = 60 * 60 * 1000;

const as = (options: Intl.DateTimeFormatOptions, at: number) => new Intl.DateTimeFormat(undefined, options).format(at);

describe("dateText", () => {
  it("writes a moment in full and a day alone, whichever way the moment comes", () => {
    const full = as({ dateStyle: "medium", timeStyle: "short" }, NOW);
    expect([dateTimeLabel(NOW), dateTimeLabel(new Date(NOW)), dateTimeLabel(new Date(NOW).toISOString())]).toEqual([
      full,
      full,
      full,
    ]);
    expect(dateLabel(NOW)).toBe(as({ dateStyle: "medium" }, NOW));
  });

  it("writes a moment that doesn't parse as Unknown", () => {
    expect(dateTimeLabel("not a time")).toBe("Unknown");
    expect(dateLabel("")).toBe("Unknown");
  });

  it("writes today's by the clock, yesterday's so named, and older ones by their day", () => {
    const time = (at: number) => as({ timeStyle: "short" }, at);
    expect(versionWhen(NOW - HOUR, NOW)).toBe(time(NOW - HOUR));
    expect(versionWhen(NOW - 24 * HOUR, NOW)).toBe(`Yesterday ${time(NOW - 24 * HOUR)}`);
    expect(shortWhen(NOW - HOUR, NOW)).toBe(time(NOW - HOUR));
    expect(shortWhen(NOW - 3 * 24 * HOUR, NOW)).toBe(as({ month: "short", day: "numeric" }, NOW - 3 * 24 * HOUR));
  });
});
