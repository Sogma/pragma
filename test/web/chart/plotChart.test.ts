// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ChartSpec } from "../../../src/protocol/types.ts";
import { drawChart } from "../../../web/chart/plotChart.ts";

const bar: ChartSpec = { type: "bar", x: "Scene", y: "Takes" };

function barHeights(svg: Element): number[] {
  return [...svg.querySelectorAll(".chart-marks rect")].map((rect) => Number(rect.getAttribute("height")));
}

describe("drawChart", () => {
  it("draws one bar per row with a number, leaving out a blank or non-numeric value rather than drawing zero", () => {
    const svg = drawChart(
      bar,
      [
        { Scene: "One", Takes: "3" },
        { Scene: "Two", Takes: "" },
        { Scene: "Three", Takes: "lots" },
        { Scene: "Four", Takes: "5" },
      ],
      400,
    );
    const heights = barHeights(svg);
    expect(heights).toHaveLength(2);
    expect(heights.every((height) => height > 0)).toBe(true);
  });

  it("keeps the rows' own order on the x axis, where Plot would sort it", () => {
    const svg = drawChart(
      bar,
      [
        { Scene: "Zebra", Takes: "1" },
        { Scene: "Apple", Takes: "2" },
      ],
      400,
    );
    const labels = [...svg.querySelectorAll('[aria-label="x-axis tick label"] text')].map((text) => text.textContent);
    expect(labels).toEqual(["Zebra", "Apple"]);
  });

  it("tilts and shortens category labels that wouldn't fit, and leaves ones that would alone", () => {
    const scenes = ["Cold open", "The diner", "Rooftop", "Car chase", "Interrogation at dawn", "Epilogue"];
    const rows = scenes.map((Scene, i) => ({ Scene, Takes: String(i + 1) }));
    const tickLabels = (width: number) => [
      ...drawChart(bar, rows, width).querySelectorAll('[aria-label="x-axis tick label"] text'),
    ];
    // A shortened label keeps its full text as a tooltip, outside the label's own text.
    const shown = (text: Element) => text.firstChild?.textContent;
    const narrow = tickLabels(240);
    expect(narrow.every((text) => /rotate\(-35\)/.test(text.getAttribute("transform") ?? ""))).toBe(true);
    const shortened = narrow.find((text) => shown(text) === "Interrogatio…");
    expect(shortened?.querySelector("title")?.textContent).toBe("Interrogation at dawn");
    const wide = tickLabels(1200);
    expect(wide.some((text) => /rotate/.test(text.getAttribute("transform") ?? ""))).toBe(false);
    expect(wide.map(shown)).toContain("Interrogation at dawn");
  });

  it("draws at the height it's given, and at 0.6 of the width without one", () => {
    const rows = [{ Scene: "One", Takes: "3" }];
    expect(drawChart(bar, rows, 500, 180).getAttribute("height")).toBe("180");
    expect(drawChart(bar, rows, 500).getAttribute("height")).toBe("300");
  });

  it("draws marks and axes in currentColor, so the stylesheet's tokens colour them", () => {
    const svg = drawChart({ type: "line", x: "Day", y: "Words" }, [{ Day: "1", Words: "200" }], 400);
    expect(svg.classList.contains("chart")).toBe(true);
    expect(svg.querySelector(".chart-marks")?.getAttribute("stroke")).toBe("currentColor");
    expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
