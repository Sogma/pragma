// A scrolled view's place as a line of its file: the file line under its top
// edge, plus the share of that line scrolled past (12.5 is halfway down line
// 12). The editor and a rendered page draw one file at different heights, so
// they meet on this where a share of the whole height would drift: an image
// is one line of text and a screenful of page.

/** Where a line's top sits in a surface, in pixels from the top of its
 * scrolled content. */
export interface LineAnchor {
  line: number;
  y: number;
}

/** The anchors among `points`, top to bottom, that each start lower and on a
 * later line than the one before: a list and its first item, or a block
 * under the start of the file's first line, are one place, the first kept. */
export function risingAnchors(points: Iterable<LineAnchor>): LineAnchor[] {
  const anchors: LineAnchor[] = [];
  for (const point of points) {
    const last = anchors.at(-1);
    if (!last || (point.line > last.line && point.y > last.y)) anchors.push(point);
  }
  return anchors;
}

/** The line at height `y`, between the anchors around it in proportion.
 * `anchors` must be rising (see risingAnchors) and not empty; past either
 * end, the nearer end holds. */
export function lineAtHeight(anchors: readonly LineAnchor[], y: number): number {
  return between(anchors, "y", y).line;
}

/** The height `line` sits at: lineAtHeight run backwards. */
export function heightAtLine(anchors: readonly LineAnchor[], line: number): number {
  return between(anchors, "line", line).y;
}

function between(anchors: readonly LineAnchor[], by: keyof LineAnchor, value: number): LineAnchor {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (value <= first[by]) return first;
  if (value >= last[by]) return last;
  let low = 0;
  let high = anchors.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (anchors[mid][by] <= value) low = mid;
    else high = mid;
  }
  const a = anchors[low];
  const b = anchors[high];
  const share = (value - a[by]) / (b[by] - a[by]);
  return { line: a.line + share * (b.line - a.line), y: a.y + share * (b.y - a.y) };
}
