// The chart library stays behind one adapter, as the graph library does
// behind the Flow canvas's (docs/architecture.md's Frontend layers): every other
// module speaks ChartSpec, so a library change touches that file alone.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTER = "web/chart/plotChart.ts";
// Static, dynamic and side-effect imports alike.
const CHART_LIBRARY = /\b(?:from|import)\s*\(?\s*["'](?:@observablehq\/plot|d3(?:-[a-z-]+)?)(?:\/[^"']*)?["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

describe("the chart library boundary", () => {
  it("is imported by the chart adapter alone", () => {
    const importers = ["web", "src", "electron", "bin"]
      .flatMap(sourceFiles)
      .filter((file) => CHART_LIBRARY.test(readFileSync(path.join(root, file), "utf8")));
    expect(importers).toEqual([ADAPTER]);
  });
});
