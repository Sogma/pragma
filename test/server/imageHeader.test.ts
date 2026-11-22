import { describe, expect, it } from "vitest";
import { bytesReader } from "../../src/server/headerReader.ts";
import { readImageDimensions, readPixelFormat } from "../../src/server/imageHeader.ts";
import { countingReader } from "../support/countingReader.ts";

// A real 2x2 RGBA PNG, so the common path runs against encoder output rather
// than a header this test wrote itself.
const PNG_RGBA_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxEgFGFdFAIAB3+AR+WvKZ6AAAAAElFTkSuQmCC",
  "base64",
);

const size = (bytes: Buffer) => readImageDimensions(bytesReader(bytes));
const format = (bytes: Buffer) => readPixelFormat(countingReader(bytes));

function png(bitDepth: number, colorType: number): Buffer {
  const bytes = Buffer.from(PNG_RGBA_2X2.subarray(0, 33));
  bytes[24] = bitDepth;
  bytes[25] = colorType;
  return bytes;
}

function gif(width: number, height: number, globalTableBits?: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  if (globalTableBits) bytes[10] = 0x80 | (globalTableBits - 1);
  return bytes;
}

// SOI, an APP0 segment and `before` more bytes of APP2 segments (an embedded
// color profile, split the way an encoder has to), then the frame header and
// the scan. `fill` 0xFF bytes go before each marker after SOI, as an encoder
// may pad them, and `stray` other bytes before the frame header.
function jpeg(
  options: {
    width?: number;
    components?: number;
    precision?: number;
    before?: number;
    fill?: number;
    stray?: number;
  } = {},
): Buffer {
  const { width = 1456, components = 3, precision = 8, before = 0, fill = 0, stray = 0 } = options;
  const pad = Buffer.alloc(fill, 0xff);
  const segments = [Buffer.from([0xff, 0xd8]), pad, Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])];
  for (let left = before; left > 0; left -= 65_000) {
    const body = Math.min(left, 65_000);
    const segment = Buffer.alloc(4 + body);
    segment.writeUInt16BE(0xffe2, 0);
    segment.writeUInt16BE(body + 2, 2);
    segments.push(pad, segment);
  }
  const frame = Buffer.alloc(10 + 3 * components);
  frame.writeUInt16BE(0xffc2, 0); // progressive: any SOF, not only baseline
  frame.writeUInt16BE(8 + 3 * components, 2);
  frame.writeUInt8(precision, 4);
  frame.writeUInt16BE(816, 5);
  frame.writeUInt16BE(width, 7);
  frame.writeUInt8(components, 9);
  segments.push(Buffer.alloc(stray, 0x20), pad, frame, Buffer.from([0xff, 0xda, 0x00, 0x02]));
  return Buffer.concat(segments);
}

function webp(container: "VP8X" | "VP8L" | "VP8 ", { width = 300, height = 200, alpha = false } = {}): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write(container, 12, "ascii");
  if (container === "VP8X") {
    if (alpha) bytes[20] = 0x10;
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  } else if (container === "VP8L") {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((alpha ? 1 << 28 : 0) | ((height - 1) << 14) | (width - 1), 21);
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23); // a keyframe's start code
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  }
  return bytes;
}

describe("readImageDimensions", () => {
  it("reads a real PNG's size from its header", async () => {
    expect(await size(PNG_RGBA_2X2)).toEqual({ width: 2, height: 2 });
  });

  it("reads a GIF's, a JPEG's and every WebP container's size", async () => {
    expect(await size(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(await size(jpeg())).toEqual({ width: 1456, height: 816 });
    for (const container of ["VP8X", "VP8 ", "VP8L"] as const) {
      expect(await size(webp(container))).toEqual({ width: 300, height: 200 });
    }
  });

  it("reads past fill bytes before a JPEG marker", async () => {
    expect(await size(jpeg({ fill: 3 }))).toEqual({ width: 1456, height: 816 });
  });

  // A vector image has no pixels to measure, and no Flow node loads one.
  it("reads no size from a vector image", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"/>');
    await expect(size(svg)).rejects.toThrow(/not a raster image/);
  });

  // A guessed size would differ silently from what the same graph produces in
  // the editor, which is worse than a stopped run.
  it("refuses rather than guessing", async () => {
    await expect(size(PNG_RGBA_2X2.subarray(0, 20))).rejects.toThrow(/IHDR/);
    await expect(size(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).rejects.toThrow(/no frame header/);
    await expect(size(Buffer.from("RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"))).rejects.toThrow(
      /no keyframe/,
    );
  });
});

describe("a JPEG's segments", () => {
  // libjpeg steps over stray bytes to the next marker, and a browser shows the
  // file, so its size and pixel format read too.
  it("finds the frame header past stray bytes before its marker", async () => {
    expect(await size(jpeg({ stray: 5 }))).toEqual({ width: 1456, height: 816 });
    expect(await format(jpeg({ stray: 5 }))).toEqual({ colorModel: "rgb", alpha: false, bitDepth: 8 });
  });

  it("never reads a frame header out of the picture data", async () => {
    const fake = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), fake]);
    await expect(size(bytes)).rejects.toThrow(/no frame header/);
  });

  // A print-profile CMYK JPEG carries its ICC profile ahead of the frame
  // header, often more than half a megabyte of it. The walk jumps over it.
  it("finds the frame header behind a large profile without reading it", async () => {
    const bytes = jpeg({ components: 4, before: 600_000 });
    const read = countingReader(bytes);
    expect(await readPixelFormat(read)).toMatchObject({ colorModel: "cmyk" });
    expect(bytes.length).toBeGreaterThan(600_000);
    expect(read.requested).toBeLessThan(200);
  });
});

describe("readPixelFormat", () => {
  it("reads a real PNG's color type and depth", async () => {
    expect(await format(PNG_RGBA_2X2)).toEqual({ colorModel: "rgb", alpha: true, bitDepth: 8 });
  });

  it("names every PNG color type", async () => {
    expect(await format(png(16, 0))).toEqual({ colorModel: "grayscale", alpha: false, bitDepth: 16 });
    expect(await format(png(8, 2))).toEqual({ colorModel: "rgb", alpha: false, bitDepth: 8 });
    expect(await format(png(4, 3))).toEqual({ colorModel: "indexed", alpha: false, bitDepth: 4 });
    expect(await format(png(8, 4))).toEqual({ colorModel: "grayscale", alpha: true, bitDepth: 8 });
    await expect(format(png(8, 5))).rejects.toThrow(/color type 5/);
  });

  // The size still reads where the format doesn't.
  it("reads a JPEG's model from its component count", async () => {
    expect(await format(jpeg({ components: 3 }))).toEqual({ colorModel: "rgb", alpha: false, bitDepth: 8 });
    expect(await format(jpeg({ components: 1, precision: 12 }))).toEqual({
      colorModel: "grayscale",
      alpha: false,
      bitDepth: 12,
    });
    expect(await format(jpeg({ components: 4 }))).toEqual({ colorModel: "cmyk", alpha: false, bitDepth: 8 });
    await expect(format(jpeg({ components: 2 }))).rejects.toThrow(/2 color components/);
    expect(await size(jpeg({ components: 2 }))).toEqual({ width: 1456, height: 816 });
  });

  it("reads alpha from each WebP container", async () => {
    const alpha = async (container: "VP8X" | "VP8L" | "VP8 ", on: boolean) =>
      (await format(webp(container, { alpha: on }))).alpha;
    expect(await alpha("VP8X", true)).toBe(true);
    expect(await alpha("VP8X", false)).toBe(false);
    expect(await alpha("VP8L", true)).toBe(true);
    expect(await alpha("VP8L", false)).toBe(false);
    expect(await alpha("VP8 ", false)).toBe(false);
  });

  it("reads a GIF's palette depth from its global table", async () => {
    expect(await format(gif(1, 1, 4))).toEqual({ colorModel: "indexed", alpha: false, bitDepth: 4 });
    expect((await format(gif(1, 1))).bitDepth).toBe(8);
  });

  it("refuses an SVG and a truncated header rather than guessing", async () => {
    await expect(format(Buffer.from("<svg/>"))).rejects.toThrow(/raster/);
    await expect(format(PNG_RGBA_2X2.subarray(0, 20))).rejects.toThrow(/IHDR/);
  });
});
