// The IPTC digital source type a picture's XMP declares: the industry's flag
// for how a picture was made, `trainedAlgorithmicMedia` for an AI model's,
// `digitalCapture` for a camera's. Read from the XMP packet alone, through
// a positional byte reader, never the picture data.
import { inflateSync } from "node:zlib";
import type { ByteReader } from "./headerReader.ts";
import { jpegSegments, rasterTypeOf } from "./imageHeader.ts";

const XMP_KEYWORD = "XML:com.adobe.xmp";
const JPEG_XMP = "http://ns.adobe.com/xap/1.0/\0";
const MAX_PACKET = 1 << 20;

/** The source type's code in an XMP packet, under whatever prefix the packet
 * binds IPTC's namespace to, as an attribute, an element or its resource. A
 * value is the code's IPTC address or the bare code. */
export function sourceTypeIn(xmp: string): string | null {
  const match =
    /:DigitalSourceType\s*=\s*["']([^"']+)["']/.exec(xmp) ??
    /:DigitalSourceType\b[^>]*\brdf:resource\s*=\s*["']([^"']+)["']/.exec(xmp) ??
    /:DigitalSourceType>\s*([^<\s]+)\s*</.exec(xmp);
  const code = match?.[1].split("/").pop() ?? "";
  return /^[A-Za-z]{1,64}$/.test(code) ? code : null;
}

// A PNG text chunk: a keyword, then the text; iTXt adds a compression flag,
// a language tag and a translated keyword, zTXt compresses always.
function pngText(type: string, data: Buffer): string | undefined {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 0 || data.toString("latin1", 0, keywordEnd) !== XMP_KEYWORD) return undefined;
  if (type === "tEXt") return data.toString("utf8", keywordEnd + 1);
  if (type === "zTXt") return inflateSync(data.subarray(keywordEnd + 2)).toString("utf8");
  const compressed = data[keywordEnd + 1] === 1;
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return undefined;
  const text = data.subarray(translatedEnd + 1);
  return (compressed ? inflateSync(text) : text).toString("utf8");
}

// Writers put the packet ahead of the picture data, where a browser reads it
// too; the walk stops there rather than stepping through every chunk of a
// large picture.
async function pngXmp(read: ByteReader, size: number): Promise<string | null> {
  for (let at = 8; at + 8 <= size; ) {
    const head = await read(at, 8);
    if (head.length < 8) return null;
    const length = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    if (type === "IDAT" || type === "IEND") return null;
    if ((type === "tEXt" || type === "iTXt" || type === "zTXt") && length <= MAX_PACKET) {
      const text = pngText(type, await read(at + 8, length));
      if (text !== undefined) return text;
    }
    at += 12 + length;
  }
  return null;
}

// An APP1 segment ahead of the scan, where the picture data begins.
async function jpegXmp(read: ByteReader): Promise<string | null> {
  for await (const { marker, at, length } of jpegSegments(read)) {
    if (marker !== 0xe1 || length <= JPEG_XMP.length + 2 || length > MAX_PACKET) continue;
    const data = await read(at + 4, length - 2);
    if (data.toString("latin1", 0, JPEG_XMP.length) === JPEG_XMP) return data.toString("utf8", JPEG_XMP.length);
  }
  return null;
}

// Only an extended WebP carries metadata, and its first chunk flags an XMP
// packet before the walk goes past the picture data to find it.
async function webpXmp(read: ByteReader, size: number): Promise<string | null> {
  const head = await read(12, 9);
  if (head.toString("latin1", 0, 4) !== "VP8X" || !(head[8] & 0x04)) return null;
  for (let at = 12; at + 8 <= size; ) {
    const chunk = await read(at, 8);
    if (chunk.length < 8) return null;
    const length = chunk.readUInt32LE(4);
    if (chunk.toString("latin1", 0, 4) === "XMP " && length <= MAX_PACKET) {
      return (await read(at + 8, length)).toString("utf8");
    }
    at += 8 + length + (length & 1);
  }
  return null;
}

/** A PNG's, JPEG's or WebP's source type, by what its signature says it is,
 * or null where it declares none, its packet doesn't read, or it is another
 * type. */
export async function readDigitalSourceType(read: ByteReader, size: number): Promise<string | null> {
  try {
    const mediaType = rasterTypeOf(await read(0, 12));
    const xmp =
      mediaType === "image/png"
        ? await pngXmp(read, size)
        : mediaType === "image/jpeg"
          ? await jpegXmp(read)
          : mediaType === "image/webp"
            ? await webpXmp(read, size)
            : null;
    return xmp === null ? null : sourceTypeIn(xmp);
  } catch {
    return null;
  }
}
