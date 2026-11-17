// pragma's scope marks as the graph draws them: a scope's AGENTS.md as the logo's
// six dots round a dot in the notes' grey, its folder as a disc in a ring of
// the mark's four corner colours, and the scope itself as an outline in the
// folder ring's seven hues.

// The mark's dots on its 24-unit square: centre x, y and colour. The logo's
// own colours, the same in both themes.
export const MARK_DOTS: [number, number, number][] = [
  [8.2, 5.42, 0xcc004e],
  [15.8, 5.42, 0x0db14c],
  [19.6, 12, 0x4dc4ca],
  [15.8, 18.58, 0x0189d2],
  [8.2, 18.58, 0xecb72b],
  [4.4, 12, 0xf3701f],
];
export const MARK_DOT_RADIUS = 3.1;
export const MARK_CENTRE_RADIUS = 2;

export interface Hues {
  green: number;
  cyan: number;
  blue: number;
  yellow: number;
  orange: number;
  red: number;
  crimson: number;
}

// Degrees clockwise from the top, as the folder glyph's ring runs.
const RING_STOPS: [number, number, keyof Hues][] = [
  [5, 60, "green"],
  [60, 118, "cyan"],
  [118, 175, "blue"],
  [185, 232, "yellow"],
  [232, 270, "orange"],
  [270, 302, "red"],
  [302, 355, "crimson"],
];

// A scope folder's ring: the mark's four corner colours, two to a half, parted
// at top and bottom where the logo's halves part.
export const FOLDER_RING_STOPS: [number, number, keyof Hues][] = [
  [5, 90, "green"],
  [90, 175, "blue"],
  [185, 270, "yellow"],
  [270, 355, "crimson"],
];

type Point = [number, number];

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let at = sorted.length - 1; at >= 0; at--) {
    const point = sorted[at];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Each centre becomes a small ring of points, so the outline clears them by
// `pad` and one or two files still get a round outline.
function paddedOutline(centres: Point[], pad: number): Point[] {
  const ring: Point[] = [];
  for (const [x, y] of centres) {
    for (let step = 0; step < 8; step++) {
      const angle = (step / 8) * Math.PI * 2;
      ring.push([x + Math.cos(angle) * pad, y + Math.sin(angle) * pad]);
    }
  }
  return convexHull(ring);
}

function traceSmooth(ctx: CanvasRenderingContext2D, outline: Point[]): void {
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(outline[outline.length - 1], outline[0]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let at = 0; at < outline.length; at++) {
    const next = mid(outline[at], outline[(at + 1) % outline.length]);
    ctx.quadraticCurveTo(outline[at][0], outline[at][1], next[0], next[1]);
  }
  ctx.closePath();
}

// A scope's outline round the centres of its files, in the ring's hues run
// round the outline's centre. Unlike the folder glyph's ring it closes. Kept
// within a view, a scope larger than the view becomes a frame round it, warm
// down the left and cool down the right, as the logo's halves are.
//
// Returns where the outline crosses its centre's column, over the top and
// under the bottom, for the scope's name and its counts.
export function strokeScopeRegion(
  ctx: CanvasRenderingContext2D,
  centres: Point[],
  hues: Hues,
  options: { pad: number; width: number; alpha: number; within: { width: number; height: number; margin: number } },
): { top: Point; bottom: Point } | null {
  if (centres.length === 0) return null;
  const { within } = options;
  const keep = (value: number, size: number) => Math.min(size - within.margin, Math.max(within.margin, value));
  const outline = convexHull(
    paddedOutline(centres, options.pad).map(([x, y]): Point => [keep(x, within.width), keep(y, within.height)]),
  );
  if (outline.length < 3) return null;
  const cx = outline.reduce((sum, p) => sum + p[0], 0) / outline.length;
  const cy = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;
  // Each hue runs on to where the next begins, so the glyph's gaps close
  // where their neighbours meet.
  const gradient = ctx.createConicGradient(-Math.PI / 2, cx, cy);
  RING_STOPS.forEach(([from, to, hue], i) => {
    const before = RING_STOPS[i - 1];
    const after = RING_STOPS[i + 1];
    gradient.addColorStop((before ? (before[1] + from) / 2 : 0) / 360, css(hues[hue]));
    gradient.addColorStop((after ? (to + after[0]) / 2 : 360) / 360, css(hues[hue]));
  });
  ctx.save();
  ctx.globalAlpha = options.alpha;
  traceSmooth(ctx, outline);
  ctx.lineWidth = options.width;
  ctx.strokeStyle = gradient;
  ctx.stroke();
  ctx.restore();
  // A frame's straight edges have no corner at the centre's column, so the
  // edges are crossed rather than the corners searched.
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < outline.length; i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[(i + 1) % outline.length];
    if ((ax - cx) * (bx - cx) > 0 || ax === bx) continue;
    const y = ay + ((cx - ax) * (by - ay)) / (bx - ax);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  if (!Number.isFinite(top)) top = Math.min(...outline.map((p) => p[1]));
  if (!Number.isFinite(bottom)) bottom = Math.max(...outline.map((p) => p[1]));
  return { top: [cx, top], bottom: [cx, bottom] };
}
