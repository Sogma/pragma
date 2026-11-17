// Pixel dimensions read out of an image's own header bytes, for callers with
// no browser to decode with — the headless Flow runner (flowRun.ts), and the
// thumbnail route checking an upload. Not for the editor: its `<img>` decodes
// strictly more than this parses (see web/flow/browserEnvironment.ts).
//
// Header-only by design: every format below carries its size within the first
// bytes or in one small segment, so nothing here decodes pixels.
import type { RasterImageMediaType } from "../protocol/types.ts";

export interface ImageDimensions {
  width: number;
  height: number;
}

class UndecodableImage extends Error {
  constructor(mediaType: string, detail: string) {
    super(`Could not read the dimensions of a ${mediaType} image: ${detail}`);
    this.name = "UndecodableImage";
  }
}

function png(bytes: Buffer): ImageDimensions {
  // 8-byte signature, then the IHDR chunk's length+type, then the size.
  if (bytes.length < 24) throw new UndecodableImage("image/png", "truncated header");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gif(bytes: Buffer): ImageDimensions {
  if (bytes.length < 10) throw new UndecodableImage("image/gif", "truncated header");
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

// A JPEG's size lives in its start-of-frame segment, which sits after any
// number of other segments, so this walks the chain rather than reading a
// fixed offset. SOF0-SOF15 all carry the same layout; C4/C8/CC are not frame
// headers despite falling in the range.
function jpeg(bytes: Buffer): ImageDimensions {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte before a marker
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new UndecodableImage("image/jpeg", "no frame header found");
}

// WebP has three container shapes, and the size sits in a different place in
// each: extended (VP8X) stores it minus one as 24-bit values, lossy (VP8)
// inside the keyframe header, lossless (VP8L) bit-packed after its signature.
function webp(bytes: Buffer): ImageDimensions {
  if (bytes.length < 30) throw new UndecodableImage("image/webp", "truncated header");
  const format = bytes.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (format === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  throw new UndecodableImage("image/webp", `unknown container "${format}"`);
}

/** Dimensions for one of the raster image types a space can hold
 * (RASTER_IMAGE_EXTENSIONS), from base64 bytes. Throws rather than guessing: a made
 * up size is worse than a stopped run, since it would silently differ from
 * what the same graph produces in the editor. */
export function decodeImageDimensions(mediaType: RasterImageMediaType | string, data: string): ImageDimensions {
  return imageDimensionsOf(mediaType, Buffer.from(data, "base64"));
}

/** The same, from the bytes themselves. */
export function imageDimensionsOf(mediaType: RasterImageMediaType | string, bytes: Buffer): ImageDimensions {
  switch (mediaType) {
    case "image/png":
      return png(bytes);
    case "image/gif":
      return gif(bytes);
    case "image/jpeg":
      return jpeg(bytes);
    case "image/webp":
      return webp(bytes);
    default:
      throw new UndecodableImage(mediaType, "unsupported type");
  }
}
