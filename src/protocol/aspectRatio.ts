// Long side, short side. Within 1% of one of these, a frame reads as it:
// an encoder's padding (1920 × 1088) is still 16:9, while ratios that are
// really different stay apart — DCI's 1.90:1 is 2.5% off 1.85:1, and
// ultrawide's 21:9 is 2.3% off film's 2.39:1.
const FAMILIAR_RATIOS: readonly [string, string][] = [
  ["1", "1"],
  ["5", "4"],
  ["4", "3"],
  ["3", "2"],
  ["16", "10"],
  ["16", "9"],
  ["1.85", "1"],
  ["2", "1"],
  ["21", "9"],
  ["2.39", "1"],
];

/** The ratio alone: `16:9`, or `9:16` for a portrait frame. One that isn't
 * familiar is written the cinema way, long side over one, to two decimals —
 * `1.46:1`, `1:1.46` — never as a fraction like 19:13, which reads as noise. */
export function formatAspectRatio(width: number, height: number): string {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!(short > 0)) return "";
  const ratio = long / short;
  const familiar = FAMILIAR_RATIOS.find(([a, b]) => Math.abs(ratio / (Number(a) / Number(b)) - 1) <= 0.01);
  const [a, b] = familiar ?? [ratio.toFixed(2), "1"];
  return width >= height ? `${a}:${b}` : `${b}:${a}`;
}

/** Whether `text` is a `W:H` ratio. Terms may be decimal: Load Image writes
 * 1.85:1 the way film does. */
export function isAspectRatio(text: string): boolean {
  return /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(text);
}

const logRatio = (ratio: string): number => {
  const [width, height] = ratio.split(":").map(Number);
  return Math.log(width / height);
};

/** Whether two `W:H` ratios are one shape, however written: 1.5:1 is 3:2. */
export function sameAspectRatio(a: string, b: string): boolean {
  return Math.abs(logRatio(a) - logRatio(b)) < 1e-9;
}

/** The ratio in `listed` nearest `ratio` by log-ratio distance, so 16:10 goes
 * to 3:2 as 10:16 goes to 2:3. */
export function nearestAspectRatio(ratio: string, listed: readonly string[]): string {
  const target = logRatio(ratio);
  return listed.reduce((best, next) =>
    Math.abs(logRatio(next) - target) < Math.abs(logRatio(best) - target) ? next : best,
  );
}
