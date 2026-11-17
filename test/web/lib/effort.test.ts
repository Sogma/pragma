import { describe, expect, it } from "vitest";
import { effortFor } from "../../../src/protocol/api.ts";
import { effortSlider } from "../../../web/lib/effort.ts";

describe("effortFor", () => {
  it("sends the pick where the model takes it, else the model's level nearest it", () => {
    expect(effortFor("medium", ["low", "medium", "high", "xhigh"])).toBe("medium");
    expect(effortFor("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(effortFor("low", ["high", "xhigh"])).toBe("high");
  });

  // A stored pick from another version can name a level this one lacks.
  it("sends none for the default, a pick that isn't a level, or a model with no levels", () => {
    expect(effortFor("", ["low", "high"])).toBeUndefined();
    expect(effortFor("max", ["low", "high"])).toBeUndefined();
    expect(effortFor("high", [])).toBeUndefined();
    expect(effortFor("high", undefined)).toBeUndefined();
  });
});

describe("effortSlider", () => {
  it("starts on Default, a ring, then the model's levels, set where a turn would send", () => {
    const slider = effortSlider(["low", "medium", "high"], "xhigh", () => {});
    expect(slider.label).toBe("Effort");
    expect(slider.stops).toEqual([
      { value: "", label: "Default", ring: true },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ]);
    expect(slider.value).toBe("high");
    expect(effortSlider(["low"], "", () => {}).value).toBe("");
  });
});
