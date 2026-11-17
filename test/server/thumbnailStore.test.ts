import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkThumbnail,
  createDiskThumbnailStore,
  fileVersion,
  InvalidThumbnail,
  isFileVersion,
  MAX_THUMBNAIL_BYTES,
  parseDecoded,
  parseFacts,
  thumbnailMediaType,
} from "../../src/server/thumbnailStore.ts";

// Headers only: the store and the check read a thumbnail's type and size,
// never its pixels.
function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

// A clip's header as the host reads it for its facts.
const clip = {
  codec: "H.264",
  frameRate: 24,
  variableFrameRate: false,
  bitDepth: 8,
  hdr: null,
  alpha: false,
  audio: { codec: "AAC", channels: 2 },
  startTimecode: "01:00:00:00",
};

describe("disk thumbnail store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pragma-thumbnails-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const key = (version: string, file = "/space/stills/a.png", root = "/space") => ({ root, file, version });
  const pixels = { colorModel: "rgb" as const, alpha: true, bitDepth: 8 };
  const facts = { width: 4, height: 4, picture: { sourceType: null, pixels } };

  it("answers a thumbnail only for the version it was made from", async () => {
    const store = createDiskThumbnailStore(dir);
    expect(await store.read(key("1-10"))).toBeUndefined();
    expect(await store.facts(key("1-10"))).toBeUndefined();

    const clipFacts = { width: 400, height: 400, duration: 2.5, clip };
    await store.write(key("1-10"), webp(4, 4), clipFacts);
    expect(await store.facts(key("1-10"))).toEqual(clipFacts);
    expect(await store.facts(key("2-10"))).toBeUndefined();
    expect(Buffer.from((await store.read(key("1-10"))) ?? [])).toEqual(webp(4, 4));
    expect(await store.read(key("2-10"))).toBeUndefined();
  });

  // A file edited a hundred times leaves one thumbnail behind, not a hundred.
  it("drops a file's older versions as a newer one lands", async () => {
    const store = createDiskThumbnailStore(dir);
    await store.write(key("1-10"), webp(4, 4), facts);
    await store.write(key("2-10"), webp(8, 8), facts);
    await store.write(key("1-10", "/space/stills/b.png"), webp(4, 4), facts);

    expect(await store.read(key("1-10"))).toBeUndefined();
    expect(await store.facts(key("1-10"))).toBeUndefined();
    expect(Buffer.from((await store.read(key("2-10"))) ?? [])).toEqual(webp(8, 8));
    expect(await store.read(key("1-10", "/space/stills/b.png"))).toBeDefined();
    const stored = (await readdir(dir, { recursive: true })).filter((entry) => /-\d+-\d+(\.json)?$/.test(entry));
    expect(stored).toHaveLength(4);
  });

  it("keeps each root's thumbnails in a directory of its own", async () => {
    const store = createDiskThumbnailStore(dir);
    await store.write(key("1-10", "/space/a.png", "/space"), webp(4, 4), facts);
    await store.write(key("1-10", "/footage/a.png", "/footage"), webp(4, 4), facts);
    expect(await readdir(dir)).toHaveLength(2);
  });

  // A clip the browser couldn't decode: its facts stand alone, and a thumbnail
  // of the same version made later by another browser takes their place.
  it("keeps facts with no thumbnail, and drops a thumbnail they replace", async () => {
    const store = createDiskThumbnailStore(dir);
    const alone = { width: 1188, height: 2112, duration: 26.8, thumbnail: false as const, clip };
    await store.write(key("1-10", "/space/take.mov"), webp(4, 4), { width: 1188, height: 2112, clip });
    await store.write(key("1-10", "/space/take.mov"), null, alone);
    expect(await store.facts(key("1-10", "/space/take.mov"))).toEqual(alone);
    expect(await store.read(key("1-10", "/space/take.mov"))).toBeUndefined();

    await store.write(key("1-10", "/space/take.mov"), webp(4, 7), { width: 1188, height: 2112, clip });
    expect(await store.facts(key("1-10", "/space/take.mov"))).toEqual({ width: 1188, height: 2112, clip });
    expect(await store.read(key("1-10", "/space/take.mov"))).toBeDefined();
  });

  it("measures the thumbnails it keeps, facts included, and clears them all", async () => {
    const store = createDiskThumbnailStore(dir);
    expect(await store.usage()).toEqual({ bytes: 0, count: 0 });
    await store.write(key("1-10"), webp(4, 4), facts);
    await store.write(key("1-10", "/footage/a.png", "/footage"), webp(4, 4), facts);
    await store.write(key("1-10", "/space/take.mov"), null, { width: 8, height: 8, thumbnail: false, clip });
    const { bytes, count } = await store.usage();
    expect(count).toBe(2);
    const factsBytes = Buffer.byteLength(JSON.stringify(facts)) * 2;
    expect(bytes).toBeGreaterThan(webp(4, 4).length * 2 + factsBytes);

    await store.clear();
    expect(await store.usage()).toEqual({ bytes: 0, count: 0 });
    expect(await store.facts(key("1-10"))).toBeUndefined();
    await store.write(key("1-10"), webp(4, 4), facts);
    expect(await store.facts(key("1-10"))).toEqual(facts);
  });
});

describe("thumbnail uploads", () => {
  it("accepts a WebP or JPEG within the edge, by its bytes", () => {
    expect(thumbnailMediaType(webp(512, 300))).toBe("image/webp");
    expect(thumbnailMediaType(jpeg(300, 512))).toBe("image/jpeg");
    expect(() => checkThumbnail(webp(512, 288), { width: 3840, height: 2160 })).not.toThrow();
    expect(() => checkThumbnail(jpeg(288, 512), { width: 1080, height: 1920 })).not.toThrow();
  });

  it("refuses anything larger, heavier, or not one of the two", () => {
    const square = { width: 8, height: 8 };
    expect(() => checkThumbnail(webp(513, 513), { width: 513, height: 513 })).toThrow(InvalidThumbnail);
    expect(() => checkThumbnail(jpeg(10, 2000), { width: 10, height: 2000 })).toThrow(InvalidThumbnail);
    expect(() => checkThumbnail(Buffer.from("GIF89a\x01\x00\x01\x00"), square)).toThrow(InvalidThumbnail);
    expect(() => checkThumbnail(Buffer.concat([webp(8, 8), Buffer.alloc(MAX_THUMBNAIL_BYTES)]), square)).toThrow(
      InvalidThumbnail,
    );
  });

  // The facts ride along unchecked against the file, so their proportions
  // are held to the thumbnail's — within a pixel of rounding, a sliver
  // included.
  it("refuses facts that aren't the thumbnail's shape", () => {
    expect(() => checkThumbnail(webp(512, 288), { width: 1080, height: 1920 })).toThrow(InvalidThumbnail);
    expect(() => checkThumbnail(webp(512, 289), { width: 3840, height: 2160 })).not.toThrow();
    expect(() => checkThumbnail(webp(512, 1), { width: 10_000, height: 1 })).not.toThrow();
    expect(() => checkThumbnail(webp(200, 100), { width: 200, height: 100 })).not.toThrow();
  });

  it("reads a decoder's claim as whole sides and a finite duration, or not at all", () => {
    expect(parseDecoded({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(parseDecoded({ width: 1920, height: 1080, duration: 12.5 })).toEqual({
      width: 1920,
      height: 1080,
      duration: 12.5,
    });
    expect(parseDecoded({ width: 0, height: 1080 })).toBeUndefined();
    expect(parseDecoded({ width: 19.5, height: 1080 })).toBeUndefined();
    expect(parseDecoded({ width: Number.NaN, height: 1080 })).toBeUndefined();
    expect(parseDecoded({ width: 1920, height: 1080, duration: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(parseDecoded({ width: 1920, height: 1080, duration: -1 })).toBeUndefined();
    expect(parseDecoded("1920x1080")).toBeUndefined();
  });

  // Facts with no header's details, or details short of a field the host
  // keeps, read as none, so the thumbnail is made again and its upload reads
  // the header.
  it("reads kept facts only with a clip's or a picture's details, each field as its kind allows", () => {
    const pixels = { colorModel: "indexed", alpha: false, bitDepth: 4 };
    expect(parseFacts({ width: 1920, height: 1080 })).toBeUndefined();
    expect(
      parseFacts({ width: 1920, height: 1080, picture: { sourceType: "trainedAlgorithmicMedia", pixels } }),
    ).toEqual({ width: 1920, height: 1080, picture: { sourceType: "trainedAlgorithmicMedia", pixels } });
    expect(parseFacts({ width: 1920, height: 1080, picture: { sourceType: null, pixels: null } })).toEqual({
      width: 1920,
      height: 1080,
      picture: { sourceType: null, pixels: null },
    });
    for (const picture of [
      { sourceType: "trainedAlgorithmicMedia" },
      { sourceType: "made by <AI>", pixels },
      { sourceType: null, pixels: { ...pixels, colorModel: "lab" } },
      { sourceType: null, pixels: { ...pixels, bitDepth: 0 } },
    ]) {
      expect(parseFacts({ width: 1920, height: 1080, picture }), JSON.stringify(picture)).toBeUndefined();
    }
    expect(parseFacts({ width: 1920, height: 1080, duration: 5, thumbnail: false, clip })).toEqual({
      width: 1920,
      height: 1080,
      duration: 5,
      thumbnail: false,
      clip,
    });
    expect(parseFacts({ width: 1920, height: 1080, thumbnail: true, clip })).toBeUndefined();
    for (const wrong of [
      { hdr: "dolby" },
      { bitDepth: 0 },
      { frameRate: -24 },
      { startTimecode: "1:00:00" },
      { audio: { codec: "AAC", channels: 0 } },
      { alpha: "no" },
    ]) {
      expect(
        parseFacts({ width: 1920, height: 1080, clip: { ...clip, ...wrong } }),
        JSON.stringify(wrong),
      ).toBeUndefined();
    }
  });

  it("names a file's version from its time and size, and recognizes one", () => {
    expect(fileVersion({ mtimeMs: 1_700_000_000_123.75, size: 42 })).toBe("1700000000123-42");
    expect(isFileVersion("1700000000123-42")).toBe(true);
    expect(isFileVersion("../escape")).toBe(false);
    expect(isFileVersion("12")).toBe(false);
  });
});
