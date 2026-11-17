import { describe, expect, it } from "vitest";
import {
  nearestResolution,
  resolutionName,
  resolutionShortSide,
  resolutionSize,
} from "../../src/protocol/videoResolution.ts";

describe("resolutionShortSide", () => {
  it("reads a size however a model or a person writes it", () => {
    expect(resolutionShortSide("720p")).toBe(720);
    expect(resolutionShortSide(" 1080P ")).toBe(1080);
    expect(resolutionShortSide("768")).toBe(768);
    expect(resolutionShortSide("4K")).toBe(2160);
    expect(resolutionShortSide("2k")).toBe(1440);
    expect(resolutionShortSide("1280x720")).toBe(720);
    expect(resolutionShortSide("720x1280")).toBe(720);
  });

  it("reads nothing else", () => {
    for (const text of ["", "HD", "8K", "0p", "720i", "16:9", "x720"])
      expect(resolutionShortSide(text)).toBeUndefined();
  });
});

describe("resolutionName", () => {
  it("says 4K and 2K by name and any other size by its lines", () => {
    expect([2160, 1440, 1080, 768, 480].map(resolutionName)).toEqual(["4K", "2K", "1080p", "768p", "480p"]);
  });
});

describe("resolutionSize", () => {
  it("gives the landscape 16:9 frame the SDK's adapters read as each size", () => {
    expect([480, 720, 1080, 2160].map(resolutionSize)).toEqual(["854x480", "1280x720", "1920x1080", "3840x2160"]);
  });
});

describe("nearestResolution", () => {
  it("picks the listed name for the size, or the nearest listed one", () => {
    expect(nearestResolution(1080, ["480p", "720p", "1080p"])).toBe("1080p");
    expect(nearestResolution(720, ["512", "768", "1080"])).toBe("768");
    expect(nearestResolution(2160, ["480p", "720p", "1080p"])).toBe("1080p");
    expect(nearestResolution(480, ["720p", "1080p"])).toBe("720p");
  });

  it("takes the smaller of two as near, and passes over a name that is no size", () => {
    expect(nearestResolution(1080, ["2K", "720p"])).toBe("720p");
    expect(nearestResolution(720, ["standard", "1080p"])).toBe("1080p");
    expect(nearestResolution(720, ["standard"])).toBeUndefined();
    expect(nearestResolution(720, [])).toBeUndefined();
  });
});
