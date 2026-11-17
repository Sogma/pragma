import { describe, expect, it } from "vitest";
import { type ByteReader, readPixelFormat } from "../../src/server/pixelFormat.ts";

// A reader over bytes in memory that records every range asked of it, so a
// test can say how much of a file the walk touched.
function reader(bytes: Buffer): ByteReader & { requested: number } {
  const read = Object.assign(
    async (offset: number, length: number) => {
      read.requested += Math.max(0, Math.min(length, bytes.length - offset));
      return bytes.subarray(offset, offset + length);
    },
    { requested: 0 },
  );
  return read;
}

// A real 2x2 RGBA PNG, so the common path runs against encoder output.
const PNG_RGBA_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxEgFGFdFAIAB3+AR+WvKZ6AAAAAElFTkSuQmCC",
  "base64",
);

function png(bitDepth: number, colorType: number): Buffer {
  const bytes = Buffer.from(PNG_RGBA_2X2.subarray(0, 33));
  bytes[24] = bitDepth;
  bytes[25] = colorType;
  return bytes;
}

// SOI, then `before` bytes of APP2 segments (an embedded color profile, split
// across segments the way an encoder has to), then the frame header.
function jpeg(components: number, precision: number, before = 0): Buffer {
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (let left = before; left > 0; left -= 65_000) {
    const body = Math.min(left, 65_000);
    const segment = Buffer.alloc(4 + body);
    segment.writeUInt16BE(0xffe2, 0);
    segment.writeUInt16BE(body + 2, 2);
    segments.push(segment);
  }
  const frame = Buffer.alloc(10 + 3 * components);
  frame.writeUInt16BE(0xffc2, 0); // progressive: any SOF, not only baseline
  frame.writeUInt16BE(8 + 3 * components, 2);
  frame.writeUInt8(precision, 4);
  frame.writeUInt16BE(816, 5);
  frame.writeUInt16BE(1456, 7);
  frame.writeUInt8(components, 9);
  segments.push(frame, Buffer.from([0xff, 0xda, 0x00, 0x02]));
  return Buffer.concat(segments);
}

function webp(container: "VP8X" | "VP8L" | "VP8 ", alpha: boolean): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write(container, 12, "ascii");
  if (container === "VP8X" && alpha) bytes[20] = 0x10;
  if (container === "VP8L") {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((alpha ? 1 << 28 : 0) | (99 << 14) | 199, 21);
  }
  return bytes;
}

function gif(globalTableBits?: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  if (globalTableBits) bytes[10] = 0x80 | (globalTableBits - 1);
  return bytes;
}

describe("readPixelFormat", () => {
  it("reads a real PNG's color type and depth", async () => {
    expect(await readPixelFormat("image/png", reader(PNG_RGBA_2X2))).toEqual({
      colorModel: "rgb",
      alpha: true,
      bitDepth: 8,
    });
  });

  it("names every PNG color type", async () => {
    const read = async (depth: number, type: number) => readPixelFormat("image/png", reader(png(depth, type)));
    expect(await read(16, 0)).toEqual({ colorModel: "grayscale", alpha: false, bitDepth: 16 });
    expect(await read(8, 2)).toEqual({ colorModel: "rgb", alpha: false, bitDepth: 8 });
    expect(await read(4, 3)).toEqual({ colorModel: "indexed", alpha: false, bitDepth: 4 });
    expect(await read(8, 4)).toEqual({ colorModel: "grayscale", alpha: true, bitDepth: 8 });
    await expect(read(8, 5)).rejects.toThrow(/color type 5/);
  });

  it("reads a JPEG's model from its component count", async () => {
    const read = async (bytes: Buffer) => readPixelFormat("image/jpeg", reader(bytes));
    expect(await read(jpeg(3, 8))).toEqual({ colorModel: "rgb", alpha: false, bitDepth: 8 });
    expect(await read(jpeg(1, 12))).toEqual({ colorModel: "grayscale", alpha: false, bitDepth: 12 });
    expect(await read(jpeg(4, 8))).toEqual({ colorModel: "cmyk", alpha: false, bitDepth: 8 });
  });

  // A print-profile CMYK JPEG carries its ICC profile ahead of the frame
  // header, often more than half a megabyte of it. The walk jumps over it.
  it("finds a JPEG's frame header behind a large profile without reading it", async () => {
    const bytes = jpeg(4, 8, 600_000);
    const read = reader(bytes);
    expect(await readPixelFormat("image/jpeg", read)).toMatchObject({ colorModel: "cmyk" });
    expect(bytes.length).toBeGreaterThan(600_000);
    expect(read.requested).toBeLessThan(200);
  });

  it("refuses a JPEG whose scan starts before any frame header", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
    await expect(readPixelFormat("image/jpeg", reader(bytes))).rejects.toThrow(/no frame header/);
  });

  it("reads alpha from each WebP container", async () => {
    const read = async (container: "VP8X" | "VP8L" | "VP8 ", alpha: boolean) =>
      (await readPixelFormat("image/webp", reader(webp(container, alpha)))).alpha;
    expect(await read("VP8X", true)).toBe(true);
    expect(await read("VP8X", false)).toBe(false);
    expect(await read("VP8L", true)).toBe(true);
    expect(await read("VP8L", false)).toBe(false);
    expect(await read("VP8 ", false)).toBe(false);
  });

  it("reads a GIF's palette depth from its global table", async () => {
    expect(await readPixelFormat("image/gif", reader(gif(4)))).toEqual({
      colorModel: "indexed",
      alpha: false,
      bitDepth: 4,
    });
    expect((await readPixelFormat("image/gif", reader(gif()))).bitDepth).toBe(8);
  });

  it("refuses an SVG and a truncated header rather than guessing", async () => {
    await expect(readPixelFormat("image/svg+xml", reader(Buffer.from("<svg/>")))).rejects.toThrow(/raster/);
    await expect(readPixelFormat("image/png", reader(PNG_RGBA_2X2.subarray(0, 20)))).rejects.toThrow(/IHDR/);
  });
});
