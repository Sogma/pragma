// The one module that imports a chart library (test/web/chartBoundary.test.ts
// holds it to that). Everything else speaks ChartSpec and rows, so a Plot
// release that breaks its API is absorbed here and never reaches a saved Flow.
// Callers load it with import(), so Plot's weight arrives with the first chart.
import * as Plot from "@observablehq/plot";
import type { ChartSpec } from "../../src/protocol/types.ts";

// Marks and axes draw in currentColor, and web/styles/chart.css points color
// at theme tokens, so a drawn chart follows a theme switch without a redraw.
// A token can't go in a mark's fill directly: Plot writes it as an SVG
// attribute, where var() doesn't resolve.
const CHART_CLASS = "chart";
const MARKS_CLASS = "chart-marks";

/** Draws `rows` as `spec` describes, `width` by `height` pixels (0.6 of the
 * width when no height is given); the SVG scales down with its container from
 * there. Values are table text: a `y` that doesn't read as a number is no
 * data, never zero — a gap in a line, and no bar or category at all, since
 * Plot stacks bars and would draw it as a zero. */
export function drawChart(
  spec: ChartSpec,
  rows: readonly Record<string, unknown>[],
  width: number,
  height = Math.round(width * 0.6),
  names: ReadonlyMap<string, string> = new Map(),
): Element {
  const xLabel = names.get(spec.x) ?? spec.x;
  const text = (value: unknown) => (value == null ? "" : String(value).trim());
  const xs = rows.map((row) => text(row[spec.x]));
  // A line over numbers is a line over a scale; anything else keeps the
  // rows' own order, where Plot would sort the categories.
  const numericX = spec.type === "line" && xs.length > 0 && xs.every((x) => x !== "" && Number.isFinite(Number(x)));
  const all = rows.map((row, i) => {
    const y = text(row[spec.y]);
    return { x: numericX ? Number(xs[i]) : xs[i], y: y === "" ? Number.NaN : Number(y) };
  });
  const data = spec.type === "bar" ? all.filter((point) => Number.isFinite(point.y)) : all;
  const mark =
    spec.type === "line"
      ? Plot.lineY(data, { x: "x", y: "y", stroke: "currentColor", marker: "circle", className: MARKS_CLASS })
      : Plot.barY(data, { x: "x", y: "y", fill: "currentColor", className: MARKS_CLASS });
  const categories = numericX ? [] : [...new Set(data.map((point) => String(point.x)))];
  // Plot neither tilts nor shortens category labels, so past roughly a
  // label's width per category they overlap: tilt them, cut at a dozen
  // characters, and give them the margin to hang into.
  const crowded = categories.reduce((sum, label) => sum + Math.min(label.length, 12) + 2, 0) * 6 > width - 60;
  return Plot.plot({
    className: CHART_CLASS,
    width,
    height,
    marginLeft: 48,
    marginBottom: crowded ? 64 : undefined,
    x: { domain: numericX ? undefined : categories },
    y: { label: names.get(spec.y) ?? spec.y, grid: true },
    marks: [
      Plot.axisX(
        crowded ? { label: xLabel, tickRotate: -35, lineWidth: 7, textOverflow: "ellipsis" } : { label: xLabel },
      ),
      Plot.ruleY([0]),
      mark,
    ],
  });
}
