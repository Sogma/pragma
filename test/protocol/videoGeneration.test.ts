import { describe, expect, it } from "vitest";
import { jobSettings } from "../../src/protocol/videoGeneration.ts";

describe("jobSettings", () => {
  it("keeps each setting that reads as one, saying a size the one way", () => {
    expect(jobSettings({ aspectRatio: "16:9", resolution: "1080P", duration: 8 })).toEqual({
      aspectRatio: "16:9",
      resolution: "1080p",
      duration: 8,
    });
    expect(jobSettings({ resolution: 768, duration: "5" })).toEqual({ resolution: "768p", duration: 5 });
    expect(jobSettings({ resolution: "4k" })).toEqual({ resolution: "4K" });
  });

  it("leaves out what a provider wrote that is no setting", () => {
    expect(jobSettings({ aspectRatio: "omitted", resolution: "standard", duration: 0 })).toEqual({});
    expect(jobSettings({ aspectRatio: 16, resolution: null, duration: "five" })).toEqual({});
    expect(jobSettings(undefined)).toEqual({});
    expect(jobSettings("720p")).toEqual({});
  });
});
