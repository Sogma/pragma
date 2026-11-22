import { describe, expect, it } from "vitest";
import { countText, formatDimensions, formatDuration, formatFileSize, formatFrameRate } from "../../../web/lib/dom.ts";

// The DOM helpers are trivial glue around querySelector/createElement and
// stay untested; the formatters are pure and have real boundary logic.
// One rule for every count the app writes out: a Class's rows and the tree's
// drag badge once read 1234 and 1,234.
describe("countText", () => {
  it("writes a count with its noun, plural but for one, the thousands separated", () => {
    expect([countText(1, "file"), countText(0, "file"), countText(1234, "item")]).toEqual([
      "1 file",
      "0 files",
      "1,234 items",
    ]);
  });
});

describe("formatFileSize", () => {
  it("shows bytes below 1024 with no unit conversion", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("switches to KB at 1024 with one decimal below 10", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("drops the decimal at 10 units and above", () => {
    expect(formatFileSize(10 * 1024)).toBe("10 KB");
    expect(formatFileSize(999 * 1024)).toBe("999 KB");
  });

  it("keeps converting up through MB and GB", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("stops converting at GB even for huge values", () => {
    expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe("1024 GB");
  });
});

describe("formatDuration", () => {
  it("writes a short clip as m:ss, zero-padding the seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(8)).toBe("0:08");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("grows to h:mm:ss past the hour, padding the minutes too", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(45296)).toBe("12:34:56");
  });

  // Floored, never rounded: a clip must not report a length it has not
  // reached, which is what a seek bar would then run past.
  it("floors a fractional second", () => {
    expect(formatDuration(8.9)).toBe("0:08");
    expect(formatDuration(59.99)).toBe("0:59");
  });

  // A media element reports NaN before it has a header and Infinity for a
  // stream whose length nobody knows. Both read Unknown, not a crash.
  it("shows Unknown for a duration no player could work out", () => {
    expect(formatDuration(Number.NaN)).toBe("Unknown");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("Unknown");
    expect(formatDuration(-1)).toBe("Unknown");
  });
});

describe("formatFrameRate", () => {
  it("gives a constant rate to three places, without trailing zeros", () => {
    expect(formatFrameRate({ codec: null, frameRate: 24_000 / 1001, variableFrameRate: false })).toBe("23.976 fps");
    expect(formatFrameRate({ codec: null, frameRate: 25, variableFrameRate: false })).toBe("25 fps");
  });

  it("gives a variable rate's average to a tenth, and says it varies", () => {
    expect(formatFrameRate({ codec: null, frameRate: 29.834, variableFrameRate: true })).toBe("29.8 fps (variable)");
  });

  it("gives nothing for a rate the header doesn't name", () => {
    expect(formatFrameRate({ codec: "H.264", frameRate: null, variableFrameRate: false })).toBeUndefined();
  });
});

describe("formatDimensions", () => {
  it("adds the reduced aspect ratio", () => {
    expect(formatDimensions(1080, 1920)).toBe("1080 × 1920px (9:16)");
    expect(formatDimensions(1920, 1080)).toBe("1920 × 1080px (16:9)");
    expect(formatDimensions(1024, 768)).toBe("1024 × 768px (4:3)");
    expect(formatDimensions(500, 500)).toBe("500 × 500px (1:1)");
  });

  it("writes a ratio with large terms as long side over one", () => {
    expect(formatDimensions(2400, 946)).toBe("2400 × 946px (2.54:1)");
    expect(formatDimensions(946, 2400)).toBe("946 × 2400px (1:2.54)");
  });

  it("leaves the ratio off when a side is zero", () => {
    expect(formatDimensions(0, 0)).toBe("0 × 0px");
  });

  it("drops the unit when given an empty one", () => {
    expect(formatDimensions(1080, 1920, "")).toBe("1080 × 1920 (9:16)");
  });
});
