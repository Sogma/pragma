// A LUT file: a 3D color lookup table in the Cube format (docs/protocol.md's
// LUTs section). Every surface that reads one goes through here: the tab
// showing a LUT, and the players that show a clip through one.

/** A color's red, green and blue. */
export type Rgb = readonly [red: number, green: number, blue: number];

/** A 3D LUT: `size` points along each axis and an RGB triple for each, red
 * changing fastest, then green, then blue, as a `.cube` file lists them. The
 * cube spans `domainMin` to `domainMax` of each input channel. */
export interface Lut {
  size: number;
  table: Float32Array;
  domainMin: Rgb;
  domainMax: Rgb;
}

/** A LUT file's table, and the name its TITLE line gives it. */
export interface LutFile extends Lut {
  title?: string;
}

/** What reading a LUT file found: its table, or what stops it being
 * applied, as a sentence for the person looking at it. */
export type LutRead = { lut: LutFile } | { problem: string };

/** The input range a cube spans unless its file says otherwise. */
export const UNIT_DOMAIN: { min: Rgb; max: Rgb } = { min: [0, 0, 0], max: [1, 1, 1] };

/** The most points a side a LUT may have here. The format allows 256, a
 * cube of 50 million numbers, too large to hold for each player showing it. */
export const MAX_LUT_SIZE = 129;

const KEYWORD = /^[A-Za-z_]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const WHOLE = /^\d+$/;

// The numbers a line holds after its keyword, or undefined unless it holds
// exactly `count` of them.
function numbers(parts: readonly string[], count: number): number[] | undefined {
  if (parts.length !== count || !parts.every((part) => NUMBER.test(part))) return undefined;
  return parts.map(Number);
}

const counted = (count: number) => count.toLocaleString("en-US");

/** Reads a `.cube` file's text. Lines are keywords, then the table's rows;
 * a line starting `#` is a comment, and a keyword this reader doesn't know
 * is passed over. */
export function readLutFile(text: string): LutRead {
  let title: string | undefined;
  let size: number | undefined;
  let curve = false;
  let domainMin = UNIT_DOMAIN.min;
  let domainMax = UNIT_DOMAIN.max;
  let table: Float32Array | undefined;
  let rows = 0;
  const curveProblem = () =>
    size === undefined
      ? "This is a 1D LUT, which Pragma can't apply yet."
      : "This LUT puts a 1D curve before its cube, which Pragma can't apply yet.";

  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = `Line ${index + 1}`;

    if (KEYWORD.test(line)) {
      const [word, ...rest] = line.split(/\s+/);
      if (table) return { problem: `${at}: ${word} comes after the rows begin.` };
      const keyword = word.toUpperCase();
      if (keyword === "TITLE") {
        const quoted = /"(.*)"/.exec(line);
        title = (quoted ? quoted[1] : line.slice(word.length)).trim() || undefined;
      } else if (keyword === "LUT_3D_SIZE") {
        if (size !== undefined) return { problem: `${at} gives LUT_3D_SIZE a second time.` };
        if (rest.length !== 1 || !WHOLE.test(rest[0])) return { problem: `${at}: LUT_3D_SIZE needs a whole number.` };
        size = Number(rest[0]);
        if (size < 2 || size > MAX_LUT_SIZE) {
          return { problem: `This LUT is ${size} points a side. Pragma reads 2 to ${MAX_LUT_SIZE}.` };
        }
      } else if (keyword === "LUT_1D_SIZE") {
        curve = true;
      } else if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
        const found = numbers(rest, 3);
        if (!found) return { problem: `${at}: ${keyword} needs three numbers.` };
        const range: Rgb = [found[0], found[1], found[2]];
        if (keyword === "DOMAIN_MIN") domainMin = range;
        else domainMax = range;
      } else if (keyword === "LUT_3D_INPUT_RANGE") {
        const found = numbers(rest, 2);
        if (!found) return { problem: `${at}: LUT_3D_INPUT_RANGE needs two numbers.` };
        domainMin = [found[0], found[0], found[0]];
        domainMax = [found[1], found[1], found[1]];
      }
      continue;
    }

    if (curve) return { problem: curveProblem() };
    if (size === undefined) return { problem: "This file has no LUT_3D_SIZE line before its rows." };
    table ??= new Float32Array(size ** 3 * 3);
    const values = numbers(line.split(/\s+/), 3);
    if (!values) return { problem: `${at} isn't a row of three numbers.` };
    if (rows === size ** 3) {
      return { problem: `This LUT has more rows than ${size} points a side takes (${counted(size ** 3)}).` };
    }
    table.set(values, rows * 3);
    rows++;
  }

  if (curve) return { problem: curveProblem() };
  if (size === undefined) return { problem: "This file has no LUT_3D_SIZE line, so it isn't a 3D LUT." };
  if (rows !== size ** 3) {
    return { problem: `This LUT has ${counted(rows)} rows, but ${size} points a side takes ${counted(size ** 3)}.` };
  }
  if (domainMin.some((low, channel) => !(domainMax[channel] > low))) {
    return { problem: "DOMAIN_MAX must be above DOMAIN_MIN in every channel." };
  }
  return { lut: { size, table: table ?? new Float32Array(0), domainMin, domainMax, ...(title ? { title } : {}) } };
}

// Where a channel's value falls along the cube's axis, in points from its
// first. A value outside the input range takes the nearest edge, and one
// that isn't a number the first point.
function place(value: number, low: number, high: number, last: number): number {
  const at = (value - low) / (high - low) || 0;
  return Math.min(Math.max(at, 0), 1) * last;
}

/** Writes `red`, `green`, `blue` through `lut` into `out`: the eight points
 * around the color blended in each channel, as a GPU's linear filtering
 * blends them, so a still and a player agree. */
export function lookUp(lut: Lut, red: number, green: number, blue: number, out: { [channel: number]: number }): void {
  const { size, table, domainMin, domainMax } = lut;
  const last = size - 1;
  const r = place(red, domainMin[0], domainMax[0], last);
  const g = place(green, domainMin[1], domainMax[1], last);
  const b = place(blue, domainMin[2], domainMax[2], last);
  // The lower corner stops one point short of the last, so a color on the
  // cube's far face blends that face in whole rather than reading past it.
  const r0 = Math.min(Math.floor(r), last - 1);
  const g0 = Math.min(Math.floor(g), last - 1);
  const b0 = Math.min(Math.floor(b), last - 1);
  const fr = r - r0;
  const fg = g - g0;
  const fb = b - b0;
  const row = size * 3;
  const plane = size * row;
  const base = b0 * plane + g0 * row + r0 * 3;
  for (let channel = 0; channel < 3; channel++) {
    const at = base + channel;
    const near = table[at] + (table[at + 3] - table[at]) * fr;
    const up = table[at + row] + (table[at + row + 3] - table[at + row]) * fr;
    const back = table[at + plane] + (table[at + plane + 3] - table[at + plane]) * fr;
    const backUp = table[at + plane + row] + (table[at + plane + row + 3] - table[at + plane + row]) * fr;
    const front = near + (up - near) * fg;
    const rear = back + (backUp - back) * fg;
    out[channel] = front + (rear - front) * fb;
  }
}
