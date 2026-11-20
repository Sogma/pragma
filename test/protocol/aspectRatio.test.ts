import { describe, expect, it } from "vitest";
import {
  formatAspectRatio,
  isAspectRatio,
  nearestAspectRatio,
  sameAspectRatio,
} from "../../src/protocol/aspectRatio.ts";

describe("formatAspectRatio", () => {
  it("names a familiar ratio, either way up", () => {
    expect(formatAspectRatio(3840, 2160)).toBe("16:9");
    expect(formatAspectRatio(1080, 1920)).toBe("9:16");
    expect(formatAspectRatio(2560, 1600)).toBe("16:10");
    expect(formatAspectRatio(1600, 2560)).toBe("10:16");
    expect(formatAspectRatio(1998, 1080)).toBe("1.85:1");
    expect(formatAspectRatio(4096, 1716)).toBe("2.39:1");
    expect(formatAspectRatio(1716, 4096)).toBe("1:2.39");
    expect(formatAspectRatio(1080, 2160)).toBe("1:2");
    expect(formatAspectRatio(2520, 1080)).toBe("21:9");
  });

  // Within 1%: an encoder's padding, a laptop panel's odd width.
  it("rounds a frame just off a familiar ratio onto it", () => {
    expect(formatAspectRatio(1920, 1088)).toBe("16:9");
    expect(formatAspectRatio(1366, 768)).toBe("16:9");
  });

  it("writes anything else to two decimals, never as a fraction", () => {
    expect(formatAspectRatio(1216, 832)).toBe("1.46:1");
    expect(formatAspectRatio(832, 1216)).toBe("1:1.46");
    expect(formatAspectRatio(1152, 896)).toBe("1.29:1");
    expect(formatAspectRatio(4096, 2160)).toBe("1.90:1");
  });

  it("names nothing for a frame with no size", () => {
    expect(formatAspectRatio(0, 0)).toBe("");
  });
});

describe("nearestAspectRatio", () => {
  const gptImage = ["1:1", "3:2", "2:3"];

  it("picks the nearest by log ratio, either way up", () => {
    expect(nearestAspectRatio("16:10", gptImage)).toBe("3:2");
    expect(nearestAspectRatio("10:16", gptImage)).toBe("2:3");
    expect(nearestAspectRatio("2.39:1", ["16:9", "21:9"])).toBe("21:9");
    expect(nearestAspectRatio("9:8", gptImage)).toBe("1:1");
  });

  it("keeps a listed ratio, however it's written", () => {
    expect(nearestAspectRatio("3:2", gptImage)).toBe("3:2");
    expect(nearestAspectRatio("1.5:1", gptImage)).toBe("3:2");
  });
});

describe("isAspectRatio", () => {
  it("takes whole or decimal terms, and nothing else", () => {
    expect(isAspectRatio("16:9")).toBe(true);
    expect(isAspectRatio("1.85:1")).toBe(true);
    expect(isAspectRatio("16/9")).toBe(false);
    expect(isAspectRatio("omitted")).toBe(false);
    expect(isAspectRatio(" 16:9")).toBe(false);
    expect(isAspectRatio("")).toBe(false);
  });
});

describe("sameAspectRatio", () => {
  it("compares shapes, not spellings", () => {
    expect(sameAspectRatio("1.5:1", "3:2")).toBe(true);
    expect(sameAspectRatio("32:18", "16:9")).toBe(true);
    expect(sameAspectRatio("16:10", "3:2")).toBe(false);
  });
});
