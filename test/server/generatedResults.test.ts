import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findResult, highestTake, resultStart, saveResult, takeOf } from "../../src/server/generatedResults.ts";
import { tempDir } from "../support/isolation.ts";

// A generated result's name: its start (the node's prefix, its dates
// filled), then `_`, the digest a later run with the same inputs finds it
// by, `_` and its take, the `_` first for a blank prefix.

const VIDEO = /\.(mp4|m4v|webm|mov)$/i;
const DIGEST = "1a2b3c4d5e6f";
let folder: string;

beforeEach(() => {
  folder = tempDir("pragma-results-");
});

const typed = "shot_{{$date:%y%m%d}}";
const start = (filledDay: string) => resultStart(`shot_${filledDay}`, typed, VIDEO);
const blank = resultStart("  ", undefined, VIDEO);
const save = (startOf: ReturnType<typeof resultStart>, take = 1) =>
  saveResult(folder, startOf, DIGEST, take, async (base) => {
    await writeFile(`${base}.mp4`, "clip");
    return `${base}.mp4`;
  });

describe("resultStart", () => {
  it("starts a blank prefix's result with nothing", () => {
    expect(blank).toEqual({ filled: "", typed: "" });
  });

  it("repairs a prefix as a file name, keeping its placeholders whole", () => {
    expect(resultStart("shot/12 14:32", "shot/12 {{$date:%H:%M}}", VIDEO)).toEqual({
      filled: "shot-12 14-32",
      typed: "shot-12 {{$date:%H:%M}}",
    });
  });
});

describe("takeOf", () => {
  it("reads a whole number from 1 as its take, and anything else as take 1", () => {
    expect(takeOf("3")).toBe(3);
    expect([takeOf(undefined), takeOf(""), takeOf("0"), takeOf("2.5"), takeOf("-2"), takeOf("x")]).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect(takeOf("9".repeat(20))).toBe(1);
  });
});

describe("findResult", () => {
  it("finds a result made on another day as carrying the typed prefix", async () => {
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_0002.mp4`), "clip");
    expect(await findResult(folder, DIGEST, 2, start("261122"))).toEqual({
      found: `shot_261121_${DIGEST}_0002.mp4`,
      carried: true,
    });
  });

  it("finds only the take asked for", async () => {
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_0001.mp4`), "clip");
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_0003.mp4`), "clip");
    expect(await findResult(folder, DIGEST, 2, start("261122"))).toBeUndefined();
    expect((await findResult(folder, DIGEST, 3, start("261122")))?.found).toBe(`shot_261121_${DIGEST}_0003.mp4`);
  });

  it("matches a take by its number, however many leading zeros it has", async () => {
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_12.mp4`), "clip");
    expect((await findResult(folder, DIGEST, 12, start("261122")))?.found).toBe(`shot_261121_${DIGEST}_12.mp4`);
    expect(await findResult(folder, DIGEST, 2, start("261122"))).toBeUndefined();
  });

  it("finds one under other words as not carrying the prefix, to be copied", async () => {
    writeFileSync(path.join(folder, `hero_${DIGEST}_0001.mp4`), "clip");
    expect(await findResult(folder, DIGEST, 1, start("261122"))).toEqual({
      found: `hero_${DIGEST}_0001.mp4`,
      carried: false,
    });
  });

  it("finds a blank prefix's result, `_` first, and a blank prefix carries any", async () => {
    writeFileSync(path.join(folder, `_${DIGEST}_0001.mp4`), "clip");
    expect(await findResult(folder, DIGEST, 1, start("261122"))).toEqual({
      found: `_${DIGEST}_0001.mp4`,
      carried: false,
    });
    expect(await findResult(folder, DIGEST, 1, blank)).toEqual({ found: `_${DIGEST}_0001.mp4`, carried: true });
  });

  it("matches the digest in any case, and only between `_`s", async () => {
    writeFileSync(path.join(folder, `hero-${DIGEST}_0001.mp4`), "clip");
    writeFileSync(path.join(folder, `hero${DIGEST}_0001.mp4`), "clip");
    writeFileSync(path.join(folder, `hero_${DIGEST}.mp4`), "clip");
    writeFileSync(path.join(folder, `hero_${DIGEST}-0001.mp4`), "clip");
    expect(await findResult(folder, DIGEST, 1, start("261122"))).toBeUndefined();
    writeFileSync(path.join(folder, `shot_261122_${DIGEST.toUpperCase()}_0001.mp4`), "clip");
    expect((await findResult(folder, DIGEST, 1, start("261122")))?.carried).toBe(true);
  });

  it("refuses a link carrying the prefix rather than paying again over it", async () => {
    const target = path.join(folder, "elsewhere.mp4");
    writeFileSync(target, "clip");
    symlinkSync(target, path.join(folder, `shot_261122_${DIGEST}_0001.mp4`));
    await expect(findResult(folder, DIGEST, 1, start("261122"))).rejects.toThrow();
  });
});

describe("highestTake", () => {
  it("is the highest take any result in the folder has for these inputs, whatever its prefix", async () => {
    expect(await highestTake(folder, DIGEST)).toBe(0);
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_0002.mp4`), "clip");
    writeFileSync(path.join(folder, `hero_${DIGEST}_0007.mp4`), "clip");
    writeFileSync(path.join(folder, `261121_${"f".repeat(12)}_0009.mp4`), "clip");
    writeFileSync(path.join(folder, `.261121_${DIGEST}_0011.mp4`), "clip");
    expect(await highestTake(folder, DIGEST)).toBe(7);
  });

  it("passes over a take too long to count", async () => {
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_0003.mp4`), "clip");
    writeFileSync(path.join(folder, `shot_261121_${DIGEST}_${"9".repeat(20)}.mp4`), "clip");
    expect(await highestTake(folder, DIGEST)).toBe(3);
  });
});

describe("saveResult", () => {
  it("names a result by its start, the digest and its take, four digits at least", async () => {
    expect(path.basename(await save(start("261121")))).toBe(`shot_261121_${DIGEST}_0001.mp4`);
    expect(path.basename(await save(start("261121"), 12))).toBe(`shot_261121_${DIGEST}_0012.mp4`);
    expect(path.basename(await save(start("261121"), 12345))).toBe(`shot_261121_${DIGEST}_12345.mp4`);
  });

  it("saves a blank prefix's result as `_`, the digest and the take", async () => {
    expect(path.basename(await save(blank))).toBe(`_${DIGEST}_0001.mp4`);
  });

  it("keeps a placeholder the host doesn't fill as the text it is", async () => {
    mkdirSync(folder, { recursive: true });
    const old = resultStart("{{$number}}_261122", "{{$number}}_{{$date:%y%m%d}}", VIDEO);
    expect(path.basename(await save(old))).toBe(`{{$number}}_261122_${DIGEST}_0001.mp4`);
  });
});
