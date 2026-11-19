// Color model, alpha and bit depth read out of a raster image's header — the
// facts a browser decodes straight past and never exposes, which the image
// pane, the gallery and its preview show beside the dimensions an `<img>`
// does report.
//
// Reads through a positional byte reader, never the whole file: a JPEG's
// frame header can sit behind hundreds of kilobytes of embedded profile and
// metadata segments, and the walk below jumps from one segment's length to
// the next rather than reading what it skips.
import { open } from "node:fs/promises";
import type { PixelFormat } from "../protocol/api.ts";

/** `length` bytes from `offset`, or fewer at the end of the file. */
export type ByteReader = (offset: number, length: number) => Promise<Buffer>;

// Positional reads through one open handle, for the header readers: they
// jump between a file's boxes and segments rather than reading it through.
export async function withHeaderReader<T>(
  filePath: string,
  use: (read: ByteReader, size: number) => Promise<T>,
): Promise<T> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return await use(async (offset, length) => {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
  } finally {
    await handle.close();
  }
}

export class UnreadablePixelFormat extends Error {
  constructor(mediaType: string, detail: string) {
    super(`Could not read the pixel format of a ${mediaType} image: ${detail}`);
    this.name = "UnreadablePixelFormat";
  }
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

async function png(read: ByteReader): Promise<PixelFormat> {
  const header = await read(0, 26);
  if (header.length < 26 || header.toString("ascii", 12, 16) !== "IHDR") {
    throw new UnreadablePixelFormat("image/png", "no IHDR chunk");
  }
  const colorType = PNG_COLOR_TYPES[header[25]];
  if (!colorType) throw new UnreadablePixelFormat("image/png", `unknown color type ${header[25]}`);
  return { ...colorType, bitDepth: header[24] };
}

// Always a palette. The global color table's size is the depth of its
// indices; a file with only local tables can index up to 8 bits.
async function gif(read: ByteReader): Promise<PixelFormat> {
  const header = await read(0, 13);
  if (header.length < 13 || header.toString("ascii", 0, 3) !== "GIF") {
    throw new UnreadablePixelFormat("image/gif", "truncated header");
  }
  const packed = header[10];
  return { colorModel: "indexed", alpha: false, bitDepth: packed & 0x80 ? (packed & 0x07) + 1 : 8 };
}

// SOF0-SOF15 share a layout; C4, C8 and CC fall in the range without being
// frame headers. The component count names the model: a three-component
// JPEG stores YCbCr, which decodes to RGB and is what an editor calls it.
const JPEG_COMPONENTS: Record<number, PixelFormat["colorModel"]> = { 1: "grayscale", 3: "rgb", 4: "cmyk" };

async function jpeg(read: ByteReader): Promise<PixelFormat> {
  let offset = 2;
  for (;;) {
    const segment = await read(offset, 10);
    if (segment.length < 4 || segment[0] !== 0xff)
      throw new UnreadablePixelFormat("image/jpeg", "broken segment chain");
    const marker = segment[1];
    if (marker === 0xff) {
      offset += 1; // fill byte before a marker
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segment.length < 10) throw new UnreadablePixelFormat("image/jpeg", "truncated frame header");
      const colorModel = JPEG_COMPONENTS[segment[9]];
      if (!colorModel) throw new UnreadablePixelFormat("image/jpeg", `${segment[9]} color components`);
      return { colorModel, alpha: false, bitDepth: segment[4] };
    }
    if (marker === 0xda || marker === 0xd9) throw new UnreadablePixelFormat("image/jpeg", "no frame header");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    offset += 2 + segment.readUInt16BE(2);
  }
}

// Always 8 bits of RGB. Alpha is a header flag in the extended container,
// a header bit in lossless, and absent from plain lossy.
async function webp(read: ByteReader): Promise<PixelFormat> {
  const header = await read(0, 30);
  if (header.length < 25 || header.toString("ascii", 8, 12) !== "WEBP") {
    throw new UnreadablePixelFormat("image/webp", "truncated header");
  }
  const container = header.toString("ascii", 12, 16);
  const rgb = (alpha: boolean): PixelFormat => ({ colorModel: "rgb", alpha, bitDepth: 8 });
  if (container === "VP8X") return rgb((header[20] & 0x10) !== 0);
  if (container === "VP8L") return rgb(((header.readUInt32LE(21) >> 28) & 1) === 1);
  if (container === "VP8 ") return rgb(false);
  throw new UnreadablePixelFormat("image/webp", `unknown container "${container}"`);
}

/** The pixel format of one of the raster types a space can hold. Throws
 * rather than guessing, for an SVG as for a damaged header: a vector has no
 * pixel format, and a wrong one reads as a fact. */
export async function readPixelFormat(mediaType: string, read: ByteReader): Promise<PixelFormat> {
  switch (mediaType) {
    case "image/png":
      return png(read);
    case "image/gif":
      return gif(read);
    case "image/jpeg":
      return jpeg(read);
    case "image/webp":
      return webp(read);
    default:
      throw new UnreadablePixelFormat(mediaType, "not a raster type this reads");
  }
}
