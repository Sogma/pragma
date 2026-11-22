import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findResult, resultStart, saveResult } from "../../src/server/generatedResults.ts";

// A generated result's name: its start (the node's prefix, its dates filled
// and its number given as it is saved), then `_` and the digest a later run
// with the same inputs finds it by, the `_` first for a blank prefix.

const VIDEO = /\.(mp4|m4v|webm|mov)$/i;
const DIGEST = "1a2b3c4d5e6f";
let folder: string;

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "pragma-results-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const typed = "{{$number}}_{{$date:%y%m%d}}";
const start = (filledDay: string) => resultStart(`{{$number}}_${filledDay}`, typed, VIDEO);
const blank = resultStart("  ", undefined, VIDEO);
const save = (startOf: ReturnType<typeof resultStart>, digest = DIGEST) =>
  saveResult(folder, startOf, digest, async (base) => {
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

describe("findResult", () => {
  it("finds a result made on another day, with whatever number it has, as carrying the typed prefix", async () => {
    writeFileSync(path.join(folder, `0007_261121_${DIGEST}.mp4`), "clip");
    expect(await findResult(folder, DIGEST, start("261122"))).toEqual({
      found: `0007_261121_${DIGEST}.mp4`,
      carried: true,
    });
  });

  it("finds one under other words as not carrying the prefix, to be copied", async () => {
    writeFileSync(path.join(folder, `hero_${DIGEST}.mp4`), "clip");
    expect(await findResult(folder, DIGEST, start("261122"))).toEqual({ found: `hero_${DIGEST}.mp4`, carried: false });
  });

  it("finds a blank prefix's result, `_` and the digest, and a blank prefix carries any", async () => {
    writeFileSync(path.join(folder, `_${DIGEST}.mp4`), "clip");
    expect(await findResult(folder, DIGEST, start("261122"))).toEqual({ found: `_${DIGEST}.mp4`, carried: false });
    expect(await findResult(folder, DIGEST, blank)).toEqual({ found: `_${DIGEST}.mp4`, carried: true });
  });

  it("matches the digest in any case, and only after `_`", async () => {
    writeFileSync(path.join(folder, `hero-${DIGEST}.mp4`), "clip");
    writeFileSync(path.join(folder, `hero${DIGEST}.mp4`), "clip");
    writeFileSync(path.join(folder, `${DIGEST}.mp4`), "clip");
    expect(await findResult(folder, DIGEST, start("261122"))).toBeUndefined();
    writeFileSync(path.join(folder, `0001_261122_${DIGEST.toUpperCase()}.mp4`), "clip");
    expect((await findResult(folder, DIGEST, start("261122")))?.carried).toBe(true);
  });
});

describe("saveResult", () => {
  it("numbers results from 0001, one past the highest under the same prefix, across days", async () => {
    expect(path.basename(await save(start("261121")))).toBe(`0001_261121_${DIGEST}.mp4`);
    writeFileSync(path.join(folder, `hero_0041_261121_${"0".repeat(12)}.mp4`), "clip");
    expect(path.basename(await save(start("261122"), "f".repeat(12)))).toBe(`0002_261122_${"f".repeat(12)}.mp4`);
  });

  it("gives saves at the same moment different numbers", async () => {
    const digests = ["a", "b", "c", "d"].map((letter) => letter.repeat(12));
    await Promise.all(digests.map((digest) => save(start("261122"), digest)));
    const numbers = readdirSync(folder).map((name) => name.slice(0, 4));
    expect(numbers.sort()).toEqual(["0001", "0002", "0003", "0004"]);
  });

  it("saves a prefix without a number as it is", async () => {
    const plain = resultStart("hero", "hero", VIDEO);
    expect(path.basename(await save(plain))).toBe(`hero_${DIGEST}.mp4`);
  });

  it("saves a blank prefix's result as `_` and the digest", async () => {
    expect(path.basename(await save(blank))).toBe(`_${DIGEST}.mp4`);
  });
});
