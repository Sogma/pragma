// Media thumbnails as host state: a rebuildable cache outside every root,
// keyed by the resolved path of the file each one shows and the version of
// that file it was made from (docs/architecture.md's Space identity and state
// ownership). Storing one is never a write to its root — a read-only library
// gets thumbnails too, and the space's git never sees them.
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { globalCacheDir } from "../config/loadConfig.ts";
import type { ClipDetails, PictureDetails, PixelFormat } from "../protocol/api.ts";
import { THUMBNAIL_MAX_EDGE } from "../protocol/types.ts";
import { imageDimensionsOf } from "./imageDimensions.ts";
import { writeFileAtomic } from "./spaceFiles.ts";

export interface ThumbnailKey {
  /** The root's own directory, absolute. */
  root: string;
  /** The file the thumbnail shows, absolute and inside `root`. */
  file: string;
  /** That file's version when the thumbnail was made. */
  version: string;
}

/** What the browser that made a thumbnail decoded of its file: the size it
 * displays at, a rotated photo already turned, and a video's length. */
export interface DecodedFacts {
  width: number;
  height: number;
  /** Seconds; absent for a still, or a clip that doesn't say. */
  duration?: number;
}

/** A file's facts as kept: what was decoded, and what the host read of its
 * header, a clip's details or a picture's. `thumbnail: false` marks facts
 * kept with no thumbnail, for a clip the browser couldn't decode, its size
 * and length read from its header instead. */
export interface ThumbnailFacts extends DecodedFacts {
  thumbnail?: false;
  clip?: ClipDetails;
  picture?: PictureDetails;
}

export interface ThumbnailUsage {
  /** On disk, the facts beside each thumbnail included. */
  bytes: number;
  count: number;
}

/** Where thumbnails are kept. The default is a directory on this machine;
 * a host with other storage supplies its own. `facts` answers only while
 * the thumbnail itself is held, or facts kept in its place, so it is also
 * the "is there one" check. */
export interface ThumbnailStore {
  facts(key: ThumbnailKey): Promise<ThumbnailFacts | undefined>;
  read(key: ThumbnailKey): Promise<Uint8Array | undefined>;
  /** A thumbnail and its facts, or with `null` the facts alone. */
  write(key: ThumbnailKey, bytes: Uint8Array | null, facts: ThumbnailFacts): Promise<void>;
  usage(): Promise<ThumbnailUsage>;
  /** Drops every thumbnail; galleries make them again as they show files. */
  clear(): Promise<void>;
}

/** A token that changes whenever a file's bytes may have: its modified time
 * and size. Handed out by the folder listing and named back by an upload, so
 * a thumbnail rendered from bytes that changed since is refused rather than
 * filed under the new version. */
export function fileVersion(stats: Pick<Stats, "mtimeMs" | "size">): string {
  return `${Math.trunc(stats.mtimeMs)}-${stats.size}`;
}

export function isFileVersion(value: string): boolean {
  return /^\d+-\d+$/.test(value);
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** One directory per root, so a library's thumbnails can go with it; inside,
 * a two-character shard keeps any one directory small on a large library.
 * Each thumbnail's facts sit beside it as JSON, written after it, so facts
 * that read back have their thumbnail unless they say they stand alone.
 *
 * A file's older versions are deleted as a new one lands. Nothing else
 * evicts: a thumbnail whose file is gone stays until the cache is cleared. */
export function createDiskThumbnailStore(dir = path.join(globalCacheDir(), "thumbnails")): ThumbnailStore {
  function locate(key: ThumbnailKey): { shard: string; prefix: string; name: string } {
    const fileDigest = digest(key.file);
    const shard = path.join(dir, digest(key.root).slice(0, 16), fileDigest.slice(0, 2));
    return { shard, prefix: `${fileDigest}-`, name: `${fileDigest}-${key.version}` };
  }

  return {
    async facts(key) {
      const { shard, name } = locate(key);
      try {
        return parseFacts(JSON.parse(await readFile(path.join(shard, `${name}.json`), "utf8")));
      } catch {
        return undefined;
      }
    },
    async read(key) {
      const { shard, name } = locate(key);
      try {
        return await readFile(path.join(shard, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async write(key, bytes, facts) {
      const { shard, prefix, name } = locate(key);
      await mkdir(shard, { recursive: true });
      if (bytes) await writeFileAtomic(path.join(shard, name), bytes);
      await writeFileAtomic(path.join(shard, `${name}.json`), JSON.stringify(facts));
      for (const entry of await readdir(shard)) {
        const current = (bytes !== null && entry === name) || entry === `${name}.json`;
        if (entry.startsWith(prefix) && !current) await rm(path.join(shard, entry), { force: true });
      }
    },
    async usage() {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { recursive: true, withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, count: 0 };
        throw error;
      }
      let bytes = 0;
      let count = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        bytes += (await stat(path.join(entry.parentPath, entry.name)).catch(() => undefined))?.size ?? 0;
        // Facts, and a write's temporary file, are no thumbnail of their own.
        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) count++;
      }
      return { bytes, count };
    },
    async clear() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// A side past this is no picture a browser decodes, and a claim of one is
// garbage rather than a large file.
const MAX_SIDE = 100_000;

/** Facts as decoded and claimed, or undefined for anything that isn't a
 * positive whole width and height, with a finite, non-negative duration. */
export function parseDecoded(value: unknown): DecodedFacts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { width, height, duration } = value as Record<string, unknown>;
  const side = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_SIDE;
  if (!side(width) || !side(height)) return undefined;
  if (duration === undefined) return { width, height };
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return undefined;
  return { width, height, duration };
}

const isText = (value: unknown, max = 64): value is string => typeof value === "string" && value.length <= max;
const orNull = <T>(value: unknown, check: (value: unknown) => value is T): value is T | null =>
  value === null || check(value);
const isCount =
  (max: number) =>
  (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) > 0 && (value as number) <= max;
const isRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1000;

function parseClip(value: unknown): ClipDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { codec, frameRate, variableFrameRate, bitDepth, hdr, alpha, audio, startTimecode } = value as Record<
    string,
    unknown
  >;
  const sound = audio as Record<string, unknown> | null;
  const soundReads =
    sound === null || (typeof sound === "object" && isText(sound.codec) && orNull(sound.channels, isCount(64)));
  const timecode = (text: unknown): text is string => typeof text === "string" && /^\d\d:\d\d:\d\d[:;]\d\d$/.test(text);
  if (
    !orNull(codec, isText) ||
    !orNull(frameRate, isRate) ||
    typeof variableFrameRate !== "boolean" ||
    !orNull(bitDepth, isCount(32)) ||
    !(hdr === null || hdr === "pq" || hdr === "hlg") ||
    typeof alpha !== "boolean" ||
    !soundReads ||
    !orNull(startTimecode, timecode)
  ) {
    return undefined;
  }
  return {
    codec,
    frameRate,
    variableFrameRate,
    bitDepth,
    hdr,
    alpha,
    audio: sound && { codec: sound.codec as string, channels: sound.channels as number | null },
    startTimecode,
  };
}

const COLOR_MODELS = new Set<PixelFormat["colorModel"]>(["grayscale", "rgb", "cmyk", "indexed"]);

function isPixelFormat(value: unknown): value is PixelFormat {
  if (typeof value !== "object" || value === null) return false;
  const { colorModel, alpha, bitDepth } = value as Record<string, unknown>;
  return (
    COLOR_MODELS.has(colorModel as PixelFormat["colorModel"]) && typeof alpha === "boolean" && isCount(32)(bitDepth)
  );
}

function parsePicture(value: unknown): PictureDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sourceType, pixels } = value as Record<string, unknown>;
  const code = (text: unknown): text is string => typeof text === "string" && /^[A-Za-z]{1,64}$/.test(text);
  if (!orNull(sourceType, code) || !orNull(pixels, isPixelFormat)) return undefined;
  const kept = pixels && { colorModel: pixels.colorModel, alpha: pixels.alpha, bitDepth: pixels.bitDepth };
  return { sourceType, pixels: kept };
}

/** Facts as kept, or undefined for any that don't read. Facts lacking a
 * header's details read as none too: the thumbnail is made again, and its
 * upload reads the header. */
export function parseFacts(value: unknown): ThumbnailFacts | undefined {
  const decoded = parseDecoded(value);
  if (!decoded) return undefined;
  const { thumbnail, clip, picture } = value as Record<string, unknown>;
  if (thumbnail !== undefined && thumbnail !== false) return undefined;
  const details = clip !== undefined ? { clip: parseClip(clip) } : { picture: parsePicture(picture) };
  if (!details.clip && !details.picture) return undefined;
  return { ...decoded, ...(thumbnail === false ? { thumbnail } : {}), ...details };
}

/** Comfortably above what a full-size thumbnail weighs as WebP or JPEG. */
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

export class InvalidThumbnail extends Error {
  constructor(detail: string) {
    super(`Not a usable thumbnail: ${detail}`);
    this.name = "InvalidThumbnail";
  }
}

/** The type of a stored or uploaded thumbnail, read from its bytes: a store
 * keeps no type beside them, and an upload's own Content-Type is the
 * client's claim, not the file's. */
export function thumbnailMediaType(bytes: Uint8Array): "image/webp" | "image/jpeg" | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  return undefined;
}

/** Refuses an upload that isn't a small WebP or JPEG within the protocol's
 * thumbnail edge on both sides, or whose shape isn't the claimed file's.
 * Whatever passes is served back to every device that browses the folder.
 *
 * The shape is all that can be checked without decoding the file: a claim
 * of the right proportions at the wrong scale still passes. */
export function checkThumbnail(bytes: Uint8Array, facts: DecodedFacts): void {
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) throw new InvalidThumbnail(`over ${MAX_THUMBNAIL_BYTES} bytes`);
  const mediaType = thumbnailMediaType(bytes);
  if (!mediaType) throw new InvalidThumbnail("neither WebP nor JPEG");
  let width: number;
  let height: number;
  try {
    ({ width, height } = imageDimensionsOf(mediaType, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  } catch (error) {
    throw new InvalidThumbnail(error instanceof Error ? error.message : "unreadable header");
  }
  if (width < 1 || height < 1 || width > THUMBNAIL_MAX_EDGE || height > THUMBNAIL_MAX_EDGE) {
    throw new InvalidThumbnail(`${width}×${height} is outside 1–${THUMBNAIL_MAX_EDGE} pixels`);
  }
  // Each side of a scaled-down thumbnail is off by under a pixel (a sliver
  // is held to one), so its cross-product with the file's sides is within
  // their sum.
  if (Math.abs(width * facts.height - height * facts.width) > facts.width + facts.height) {
    throw new InvalidThumbnail(`${width}×${height} isn't the shape of ${facts.width}×${facts.height}`);
  }
}
