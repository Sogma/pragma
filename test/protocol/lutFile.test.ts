import { describe, expect, it } from "vitest";
import { type Lut, lookUp, MAX_LUT_SIZE, readLutFile } from "../../src/protocol/lutFile.ts";

// A 2-point cube's eight rows, red fastest, each point mapped to itself
// unless `point` says otherwise.
function rows(point: (red: number, green: number, blue: number) => number[] = (r, g, b) => [r, g, b]): string {
  const lines: string[] = [];
  for (let blue = 0; blue < 2; blue++) {
    for (let green = 0; green < 2; green++) {
      for (let red = 0; red < 2; red++) lines.push(point(red, green, blue).join(" "));
    }
  }
  return lines.join("\n");
}

const problemOf = (text: string) => {
  const read = readLutFile(text);
  return "problem" in read ? read.problem : undefined;
};

const lutOf = (text: string) => {
  const read = readLutFile(text);
  if (!("lut" in read)) throw new Error(read.problem);
  return read.lut;
};

describe("readLutFile", () => {
  it("reads the title, the size and every row, red changing fastest, over the unit range by default", () => {
    const lut = lutOf(`# Made by a grading app\nTITLE "Film Print"\nLUT_3D_SIZE 2\n\n${rows()}\n`);
    expect(lut.title).toBe("Film Print");
    expect(lut.size).toBe(2);
    expect(Array.from(lut.table)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
  });

  it("takes any line ending, keywords in any case, and passes over keywords it doesn't know", () => {
    const lut = lutOf(`lut_3d_size 2\r\nLUT_IN_VIDEO_RANGE\r\n${rows().split("\n").join("\r")}`);
    expect(lut.size).toBe(2);
    expect(lut.title).toBeUndefined();
    expect(lut.table).toHaveLength(24);
  });

  it("reads an input range from DOMAIN_MIN and DOMAIN_MAX, or one LUT_3D_INPUT_RANGE for all three channels", () => {
    const domain = lutOf(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 -0.5 0\nDOMAIN_MAX 1 1.5 4e-1\n${rows()}`);
    expect(domain.domainMin).toEqual([0, -0.5, 0]);
    expect(domain.domainMax).toEqual([1, 1.5, 0.4]);
    const range = lutOf(`LUT_3D_INPUT_RANGE 0.1 0.9\nLUT_3D_SIZE 2\n${rows()}`);
    expect(range.domainMin).toEqual([0.1, 0.1, 0.1]);
    expect(range.domainMax).toEqual([0.9, 0.9, 0.9]);
  });

  it("keeps values past 0 and 1, which a LUT may write", () => {
    expect(lutOf(`LUT_3D_SIZE 2\n${rows(() => [-0.25, 1.5, 2])}`).table.slice(0, 3)).toEqual(
      new Float32Array([-0.25, 1.5, 2]),
    );
  });

  it("refuses a 1D LUT, and a 1D curve before a cube, as not applied yet", () => {
    expect(problemOf("LUT_1D_SIZE 2\n0 0 0\n1 1 1")).toBe("This is a 1D LUT, which Pragma can't apply yet.");
    expect(problemOf(`LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n1 1 1\n${rows()}`)).toBe(
      "This LUT puts a 1D curve before its cube, which Pragma can't apply yet.",
    );
  });

  it("refuses a file with no size, or rows before it", () => {
    expect(problemOf("")).toBe("This file has no LUT_3D_SIZE line, so it isn't a 3D LUT.");
    expect(problemOf('TITLE "Empty"\n# nothing\n')).toBe("This file has no LUT_3D_SIZE line, so it isn't a 3D LUT.");
    expect(problemOf(`${rows()}\nLUT_3D_SIZE 2`)).toBe("This file has no LUT_3D_SIZE line before its rows.");
  });

  it("refuses a size that isn't whole, is out of range, or is given twice", () => {
    expect(problemOf("LUT_3D_SIZE 2.5")).toBe("Line 1: LUT_3D_SIZE needs a whole number.");
    expect(problemOf("LUT_3D_SIZE 1")).toBe(`This LUT is 1 points a side. Pragma reads 2 to ${MAX_LUT_SIZE}.`);
    expect(problemOf("LUT_3D_SIZE 256")).toBe(`This LUT is 256 points a side. Pragma reads 2 to ${MAX_LUT_SIZE}.`);
    expect(problemOf("LUT_3D_SIZE 2\nLUT_3D_SIZE 2")).toBe("Line 2 gives LUT_3D_SIZE a second time.");
  });

  it("names the line of a row that isn't three numbers, and of a keyword after the rows", () => {
    expect(problemOf("LUT_3D_SIZE 2\n0 0 0\n0 0")).toBe("Line 3 isn't a row of three numbers.");
    expect(problemOf("LUT_3D_SIZE 2\n0 0 zero")).toBe("Line 2 isn't a row of three numbers.");
    expect(problemOf('LUT_3D_SIZE 2\n0 0 0\nTITLE "Late"')).toBe("Line 3: TITLE comes after the rows begin.");
  });

  it("counts the rows against the size, either way", () => {
    expect(problemOf("LUT_3D_SIZE 2\n0 0 0\n1 1 1")).toBe("This LUT has 2 rows, but 2 points a side takes 8.");
    expect(problemOf(`LUT_3D_SIZE 2\n${rows()}\n0 0 0`)).toBe("This LUT has more rows than 2 points a side takes (8).");
  });

  it("refuses an input range that ends where it starts or below", () => {
    expect(problemOf(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 1\n${rows()}`)).toBe(
      "DOMAIN_MAX must be above DOMAIN_MIN in every channel.",
    );
    expect(problemOf(`LUT_3D_SIZE 2\nDOMAIN_MAX 1 1\n${rows()}`)).toBe("Line 2: DOMAIN_MAX needs three numbers.");
  });
});

describe("lookUp", () => {
  const out = [0, 0, 0];
  const through = (lut: Lut, red: number, green: number, blue: number) => {
    lookUp(lut, red, green, blue, out);
    return out.map((channel) => Number(channel.toFixed(6)));
  };

  it("gives a cube's own points back, and blends between them", () => {
    const swap = lutOf(`LUT_3D_SIZE 2\n${rows((r, g, b) => [b, g, r])}`);
    expect(through(swap, 1, 0, 0)).toEqual([0, 0, 1]);
    expect(through(swap, 0.25, 0.5, 0.75)).toEqual([0.75, 0.5, 0.25]);
  });

  it("lands each channel's input range on the cube's first and last points, holding the edge past them", () => {
    const shifted = lutOf(`LUT_3D_SIZE 2\nDOMAIN_MIN 0.5 0.5 0.5\nDOMAIN_MAX 1 1 1\n${rows()}`);
    expect(through(shifted, 0.75, 0.5, 1)).toEqual([0.5, 0, 1]);
    expect(through(shifted, 0, 2, Number.NaN)).toEqual([0, 1, 0]);
  });

  it("reads a larger cube's points where they sit", () => {
    const size = 3;
    const table = new Float32Array(size ** 3 * 3);
    // Every point's red is its own blue index, so the lookup's axis order shows.
    for (let at = 0; at < size ** 3; at++) table[at * 3] = Math.floor(at / (size * size));
    const lut: Lut = { size, table, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
    expect(through(lut, 0, 0, 0.5)[0]).toBe(1);
    expect(through(lut, 1, 1, 0.75)[0]).toBe(1.5);
  });
});
