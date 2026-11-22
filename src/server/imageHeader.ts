// What a raster image's header says, for callers with no browser to decode
// with: its size, and its color model, alpha and bit depth, the facts a
// browser decodes straight past. The headless Flow runner measures with it,
// the thumbnail route checks an upload with it, and the image pane, the
// gallery and its preview show its pixel format.
//
// The type is read from the file's signature, as a browser reads it, never
// from its name: a JPEG saved as `.png` measures as the JPEG it is, as the
// editor's `<img>` measures it. Header-only: every format below carries these
// facts in its first bytes or in one small segment.
import type { PixelFormat } from "../protocol/api.ts";
import type { RasterImageMediaType } from "../protocol/types.ts";
import type { ByteReader } from "./headerReader.ts";

export interface ImageDimensions {
  width: number;
  height: number;
}

const NAMES: Record<RasterImageMediaType, string> = {
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/** A header that doesn't read: no raster signature, a damaged header, or a
 * format this can't name. */
export class UnreadableImageHeader extends Error {
  constructor(asked: string, mediaType: RasterImageMediaType | undefined, detail: string) {
    super(`Could not read the ${asked} of ${mediaType ? `a ${NAMES[mediaType]}` : "this file"}: ${detail}`);
    this.name = "UnreadableImageHeader";
  }
}

/** The raster type a file's first bytes name, whatever the file is called. */
export function rasterTypeOf(head: Buffer): RasterImageMediaType | undefined {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
    return "image/png";
  }
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString("latin1", 0, 6))) return "image/gif";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

interface RasterHeader {
  width: number;
  height: number;
  // The pixel format, or why it can't be named, which leaves the size readable.
  pixels: PixelFormat | string;
}

// PNG's IHDR color types: bit 1 is color, bit 2 is alpha, 3 alone is a
// palette. Its bit depth is per sample, or per palette index.
const PNG_COLOR_TYPES: Record<number, Pick<PixelFormat, "colorModel" | "alpha">> = {
  0: { colorModel: "grayscale", alpha: false },
  2: { colorModel: "rgb", alpha: false },
  3: { colorModel: "indexed", alpha: false },
  4: { colorModel: "grayscale", alpha: true },
  6: { colorModel: "rgb", alpha: true },
};

function png(head: Buffer): RasterHeader | string {
  if (head.length < 26 || head.toString("latin1", 12, 16) !== "IHDR") return "no complete IHDR chunk";
  const colorType = PNG_COLOR_TYPES[head[25]];
  return {
    width: head.readUInt32BE(16),
    height: head.readUInt32BE(20),
    pixels: colorType ? { ...colorType, bitDepth: head[24] } : `unknown color type ${head[25]}`,
  };
}

// Always a palette. The global color table's size is the depth of its
// indices; a file with only local tables can index up to 8 bits.
function gif(head: Buffer): RasterHeader | string {
  if (head.length < 13) return "truncated header";
  const packed = head[10];
  return {
    width: head.readUInt16LE(6),
    height: head.readUInt16LE(8),
    pixels: { colorModel: "indexed", alpha: false, bitDepth: packed & 0x80 ? (packed & 0x07) + 1 : 8 },
  };
}

// Three container shapes, the size in a different place in each: extended
// (VP8X) stores it minus one as 24-bit values, lossy (VP8) in its keyframe
// header, lossless (VP8L) bit-packed after its signature byte. Always 8 bits
// of RGB; alpha is a flag in the extended header, a bit in lossless, and
// absent from plain lossy.
function webp(head: Buffer): RasterHeader | string {
  if (head.length < 30) return "truncated header";
  const container = head.toString("latin1", 12, 16);
  const rgb = (alpha: boolean): PixelFormat => ({ colorModel: "rgb", alpha, bitDepth: 8 });
  if (container === "VP8X") {
    return {
      width: head.readUIntLE(24, 3) + 1,
      height: head.readUIntLE(27, 3) + 1,
      pixels: rgb((head[20] & 0x10) !== 0),
    };
  }
  if (container === "VP8 ") {
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return "no keyframe in its VP8 chunk";
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, pixels: rgb(false) };
  }
  if (container === "VP8L") {
    if (head[20] !== 0x2f) return "no VP8L signature";
    const packed = head.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
      pixels: rgb(((packed >> 28) & 1) === 1),
    };
  }
  return `unknown container "${container}"`;
}

/** One segment of a JPEG: its marker, where its 0xFF sits, and its length
 * field, so its payload runs from `at + 4` to `at + 2 + length`. */
export interface JpegSegment {
  marker: number;
  at: number;
  length: number;
}

// The first read for a marker takes just it and its length, since one
// usually sits right where the last segment ended; past stray bytes each read
// doubles.
const FIRST_WINDOW = 4;
const MAX_WINDOW = 64 * 1024;

// The next marker at or after `from`: an 0xFF followed by neither another
// 0xFF, which is fill, nor 0x00, which stuffs a literal 0xFF into scan data.
async function nextJpegMarker(read: ByteReader, from: number): Promise<{ marker: number; at: number } | undefined> {
  for (let at = from, size = FIRST_WINDOW; ; size = Math.min(size * 2, MAX_WINDOW)) {
    const window = await read(at, size);
    if (window.length < 2) return undefined;
    for (let i = 0; i + 1 < window.length; i++) {
      const next = window[i + 1];
      if (window[i] === 0xff && next !== 0xff && next !== 0x00) return { marker: next, at: at + i };
    }
    at += window.length - 1;
  }
}

/** A JPEG's segments after its start, up to its scan, where the picture data
 * begins. Markers are found as libjpeg finds them, past any stray bytes before
 * one, so a file a browser shows walks the same here; a length that runs
 * short ends the walk. */
export async function* jpegSegments(read: ByteReader): AsyncGenerator<JpegSegment> {
  for (let from = 2; ; ) {
    const found = await nextJpegMarker(read, from);
    if (found === undefined || found.marker === 0xda || found.marker === 0xd9) return;
    // Markers with no length: a restart, a start of image, TEM.
    if (found.marker === 0x01 || (found.marker >= 0xd0 && found.marker <= 0xd8)) {
      from = found.at + 2;
      continue;
    }
    const field = await read(found.at + 2, 2);
    if (field.length < 2 || field.readUInt16BE(0) < 2) return;
    const length = field.readUInt16BE(0);
    yield { marker: found.marker, at: found.at, length };
    from = found.at + 2 + length;
  }
}

// SOF0-SOF15 share a layout; C4, C8 and CC fall in the range without being
// frame headers. The component count names the model: a three-component
// JPEG stores YCbCr, which decodes to RGB and is what an editor calls it.
const JPEG_COMPONENTS: Record<number, PixelFormat["colorModel"]> = { 1: "grayscale", 3: "rgb", 4: "cmyk" };
const isFrameHeader = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

async function jpeg(read: ByteReader): Promise<RasterHeader | string> {
  for await (const segment of jpegSegments(read)) {
    if (!isFrameHeader(segment.marker)) continue;
    const frame = await read(segment.at + 4, 6);
    if (frame.length < 6) return "truncated frame header";
    const colorModel = JPEG_COMPONENTS[frame[5]];
    return {
      width: frame.readUInt16BE(3),
      height: frame.readUInt16BE(1),
      pixels: colorModel ? { colorModel, alpha: false, bitDepth: frame[0] } : `${frame[5]} color components`,
    };
  }
  return "no frame header";
}

async function rasterHeader(
  read: ByteReader,
  asked: string,
): Promise<RasterHeader & { mediaType: RasterImageMediaType }> {
  const head = await read(0, 32);
  const mediaType = rasterTypeOf(head);
  if (!mediaType) throw new UnreadableImageHeader(asked, undefined, "not a raster image (PNG, GIF, JPEG or WebP)");
  const header =
    mediaType === "image/png"
      ? png(head)
      : mediaType === "image/gif"
        ? gif(head)
        : mediaType === "image/webp"
          ? webp(head)
          : await jpeg(read);
  if (typeof header === "string") throw new UnreadableImageHeader(asked, mediaType, header);
  return { ...header, mediaType };
}

/** A raster image's size. Throws rather than guessing: a made-up size is worse
 * than a stopped run, since it would silently differ from what the same graph
 * produces in the editor. */
export async function readImageDimensions(read: ByteReader): Promise<ImageDimensions> {
  const { width, height } = await rasterHeader(read, "size");
  return { width, height };
}

/** A raster image's pixel format. Throws rather than guessing, for an SVG as
 * for a damaged header: a vector has no pixel format, and a wrong one reads as
 * a fact. */
export async function readPixelFormat(read: ByteReader): Promise<PixelFormat> {
  const { mediaType, pixels } = await rasterHeader(read, "pixel format");
  if (typeof pixels === "string") throw new UnreadableImageHeader("pixel format", mediaType, pixels);
  return pixels;
}
