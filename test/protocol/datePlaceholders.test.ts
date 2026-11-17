import { describe, expect, it } from "vitest";
import {
  type ClockReading,
  clockDay,
  DATE_OFFERS,
  fillDates,
  fillPlaceholders,
  formatClock,
  formatDate,
  parseClock,
  placeholderPattern,
  readClock,
} from "../../src/protocol/datePlaceholders.ts";

const at = (text: string): ClockReading => {
  const reading = parseClock(text);
  if (!reading) throw new Error(`not a moment: ${text}`);
  return reading;
};

// Monday 2026-11-09, 14:30:05, an hour east of UTC.
const NOV_9 = at("2026-11-09T14:30:05+01:00");

describe("formatDate", () => {
  it("replaces each POSIX directive, names in English", () => {
    const cases: [string, string][] = [
      ["%Y", "2026"],
      ["%y", "26"],
      ["%m", "11"],
      ["%d", "09"],
      ["%H", "14"],
      ["%I", "02"],
      ["%M", "30"],
      ["%S", "05"],
      ["%p", "PM"],
      ["%j", "313"],
      ["%a", "Mon"],
      ["%A", "Monday"],
      ["%b", "Nov"],
      ["%B", "November"],
      ["%u", "1"],
      ["%V", "46"],
      ["%G", "2026"],
      ["%z", "+0100"],
      ["%F", "2026-11-09"],
      ["%T", "14:30:05"],
    ];
    for (const [format, expected] of cases) expect(formatDate(NOV_9, format), format).toBe(expected);
  });

  it("drops a number's padding after a `-`, and leaves a name as it is", () => {
    expect(formatDate(NOV_9, "%B %-d, %-I %p")).toBe("November 9, 2 PM");
    expect(formatDate(at("2026-01-05T07:08:09Z"), "%-m/%-d %-H:%-M:%-S %-j")).toBe("1/5 7:8:9 5");
    expect(formatDate(NOV_9, "%-A")).toBe("Monday");
  });

  it("keeps an unknown directive and a doubled percent sign's single one", () => {
    expect(formatDate(NOV_9, "%Y %Q 100%%")).toBe("2026 %Q 100%");
    expect(formatDate(NOV_9, "%Y%")).toBe("2026%");
  });

  // Left as written by its placeholder: another tool's format, never a wrong date.
  it("gives nothing for a format with no date directive", () => {
    expect(formatDate(NOV_9, "YYYY-MM-DD")).toBeUndefined();
    expect(formatDate(NOV_9, "yyyy-MM-dd")).toBeUndefined();
    expect(formatDate(NOV_9, "100%%")).toBeUndefined();
    expect(formatDate(NOV_9, "%Q")).toBeUndefined();
  });

  it("puts a day in its ISO week's year", () => {
    expect(formatDate(at("2027-01-01T12:00:00Z"), "%G-W%V %u")).toBe("2026-W53 5");
    expect(formatDate(at("2025-12-29T12:00:00Z"), "%G-W%V %u")).toBe("2026-W01 1");
    expect(formatDate(at("2026-01-04T12:00:00Z"), "%G-W%V %a")).toBe("2026-W01 Sun");
  });

  it("counts the day of a leap year, and reads the twelve-hour clock", () => {
    expect(formatDate(at("2028-12-31T00:15:00Z"), "%j %I %p")).toBe("366 12 AM");
    expect(formatDate(at("2028-12-31T12:15:00Z"), "%I %p")).toBe("12 PM");
  });

  it("writes the offset west of UTC and at zero", () => {
    expect(formatDate(at("2026-11-09T10:00:00-03:30"), "%z")).toBe("-0330");
    expect(formatDate(at("2026-11-09T10:00:00Z"), "%z")).toBe("+0000");
  });
});

describe("filling placeholders", () => {
  it("fills {{$date}} and {{$date:FORMAT}}, the name in any case", () => {
    expect(fillDates("{{$date}} {{$DATE}} {{$Date:%A}}", NOV_9)).toBe("2026-11-09 2026-11-09 Monday");
  });

  // A bare name is a person's own, such as a Template Variables slot's.
  it("fills a date only where a $ marks it", () => {
    expect(fillDates("{{date}} {{Date:%A}} {{$date}}", NOV_9)).toBe("{{date}} {{Date:%A}} 2026-11-09");
  });

  it("leaves what isn't a date placeholder as written", () => {
    for (const text of ["{{ $date }}", "{{$date:}}", "{{$date:YYYY}}", "{{$title}}", "{date}", "{{$date:%Y\n}}"]) {
      expect(fillDates(text, NOV_9)).toBe(text);
    }
  });

  it("fills in one pass, never reading what it put in", () => {
    const fill = (name: string) => (name === "a" ? "{{b}}" : name === "b" ? "B" : undefined);
    expect(fillPlaceholders("{{a}} {{b}}", fill)).toBe("{{b}} B");
  });

  it("hands a fill the name and the format", () => {
    const seen: [string, string | undefined][] = [];
    fillPlaceholders("{{x}} {{when:%H:%M}}", (name, format) => {
      seen.push([name, format]);
      return undefined;
    });
    expect(seen).toEqual([
      ["x", undefined],
      ["when", "%H:%M"],
    ]);
  });

  it("matches what it fills", () => {
    expect([..."a {{$date:%B %-d}} {{name}}".matchAll(placeholderPattern())].map((m) => m[0])).toEqual([
      "{{$date:%B %-d}}",
      "{{name}}",
    ]);
  });
});

describe("clock readings", () => {
  it("reads and writes RFC 3339 local time with its offset", () => {
    expect(NOV_9).toEqual({ year: 2026, month: 11, day: 9, hour: 14, minute: 30, second: 5, offset: 60 });
    expect(formatClock(NOV_9)).toBe("2026-11-09T14:30:05+01:00");
    expect(formatClock(at("2026-11-09T14:30:05.123Z"))).toBe("2026-11-09T14:30:05+00:00");
    expect(clockDay(NOV_9)).toBe("2026-11-09");
  });

  it("refuses a moment that isn't one", () => {
    for (const text of [
      "2026-02-30T10:00:00+01:00",
      "2026-11-09T24:00:00Z",
      "2026-11-09T14:60:00Z",
      "2026-11-09T14:30:05",
      "2026-11-09",
      "2026-11-09T14:30:05+0100",
    ]) {
      expect(parseClock(text), text).toBeUndefined();
    }
  });

  it("reads the machine's own clock", () => {
    const now = new Date(2026, 10, 9, 14, 30, 5);
    expect(readClock(now)).toEqual({
      year: 2026,
      month: 11,
      day: 9,
      hour: 14,
      minute: 30,
      second: 5,
      offset: -now.getTimezoneOffset(),
    });
  });
});

describe("the date placeholders an editor offers", () => {
  // An offer a run left standing as written would put a stray placeholder
  // into whatever the box names.
  it("are each filled, and each differently", () => {
    const filled = DATE_OFFERS.map((offer) => fillDates(offer, NOV_9));
    expect(filled).toEqual(["2026-11-09", "November 9, 2026", "2026-11-09 14:30", "14:30", "Monday", "2026"]);
    expect(new Set(filled).size).toBe(DATE_OFFERS.length);
  });
});
