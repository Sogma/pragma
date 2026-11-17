import { describe, expect, it } from "vitest";
import { hexToOklab, readableTextColor } from "../../../web/lib/color.ts";

const DARK = "#1a1a1a";
const LIGHT = "#f5f5f5";

describe("readableTextColor", () => {
  it("puts dark text on light fills and light text on dark ones", () => {
    expect(readableTextColor("#e3e2e0")).toBe(DARK); // light gray
    expect(readableTextColor("#ecb72b")).toBe(DARK); // yellow
    expect(readableTextColor("#505050")).toBe(LIGHT); // dark gray
    expect(readableTextColor("#ad1a72")).toBe(LIGHT); // pink
    expect(readableTextColor("#0b6e99")).toBe(LIGHT); // blue
  });

  // The WCAG 2 ratio gives this orange dark text, at 5.3:1 against light's 3.0:1.
  it("puts light text on a saturated mid-tone the WCAG 2 ratio gets wrong", () => {
    expect(readableTextColor("#d9730d")).toBe(LIGHT);
  });

  // On #b0b0b0 dark text has more contrast (Lc 60 to light's 41), but not 1.68 times as much.
  it("keeps light text until dark text wins by the lean", () => {
    expect(readableTextColor("#b0b0b0")).toBe(LIGHT);
    expect(readableTextColor("#c0c0c0")).toBe(DARK);
  });
});

describe("hexToOklab", () => {
  it("puts white at full lightness and black at none, both without hue", () => {
    const [whiteL, whiteA, whiteB] = hexToOklab("#ffffff");
    expect(whiteL).toBeCloseTo(1, 3);
    expect(Math.abs(whiteA) + Math.abs(whiteB)).toBeLessThan(1e-3);
    expect(hexToOklab("#000000")).toEqual([0, 0, 0]);
  });
});
