import { describe, expect, it } from "vitest";
import { decodeImageDimensions } from "../../src/server/imageDimensions.ts";

const b64 = (bytes: Buffer): string => bytes.toString("base64");

// A real 2x2 PNG, so the most common path is tested against actual encoder
// output rather than a header this test wrote itself.
const PNG_2X2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxEgFGFdFAIAB3+AR+WvKZ6AAAAAElFTkSuQmCC";

function gif(width: number, height: number): string {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return b64(bytes);
}

// SOI, one segment to skip over, then the frame header the size lives in —
// the skip is the point, since a real JPEG never puts SOF first. `fill`
// 0xFF bytes go before each marker after SOI, as an encoder may pad them.
function jpeg(width: number, height: number, fill = 0): string {
  const pad = Buffer.alloc(fill, 0xff);
  const skipped = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(0x0011, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return b64(Buffer.concat([Buffer.from([0xff, 0xd8]), pad, skipped, pad, frame]));
}

function webpExtended(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return b64(bytes);
}

describe("decodeImageDimensions", () => {
  it("reads a real PNG's size from its header", () => {
    expect(decodeImageDimensions("image/png", PNG_2X2)).toEqual({ width: 2, height: 2 });
  });

  it("reads GIF, JPEG and WebP sizes", () => {
    expect(decodeImageDimensions("image/gif", gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(decodeImageDimensions("image/jpeg", jpeg(1456, 816))).toEqual({ width: 1456, height: 816 });
    expect(decodeImageDimensions("image/webp", webpExtended(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it("reads past fill bytes before a JPEG marker", () => {
    expect(decodeImageDimensions("image/jpeg", jpeg(1456, 816, 3))).toEqual({ width: 1456, height: 816 });
  });

  // A vector image has no pixels to measure, and no Flow node loads one.
  it("reads no size from a vector image", () => {
    const svg = b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"/>'));
    expect(() => decodeImageDimensions("image/svg+xml", svg)).toThrow(/unsupported type/);
  });

  // A guessed size would differ silently from what the same graph produces in
  // the editor, which is worse than a stopped run.
  it("refuses rather than guessing", () => {
    expect(() => decodeImageDimensions("image/png", b64(Buffer.alloc(4)))).toThrow(/truncated/);
    expect(() => decodeImageDimensions("image/jpeg", b64(Buffer.from([0xff, 0xd8])))).toThrow(/no frame header/);
    expect(() => decodeImageDimensions("image/avif", PNG_2X2)).toThrow(/unsupported type/);
  });
});
