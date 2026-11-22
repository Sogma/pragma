// A video's codec and frame rate read out of its container's header — facts
// a `<video>` element never exposes, and the codec is the one that says why
// a clip the tree lists won't play — with what else the header says of the
// picture, the sound and the timecode, for the clip's folder entry.
//
// Reads box and element headers through a positional byte reader and jumps
// over everything else: an MP4 written without "fast start" keeps its index
// behind gigabytes of picture data, and the walk has to reach it without
// reading them.
import type { ClipHeaderResponse, VideoFormatResponse } from "../protocol/api.ts";
import type { ByteReader } from "./headerReader.ts";

export class UnreadableVideoFormat extends Error {
  constructor(mediaType: string, detail: string) {
    super(`Could not read the format of a ${mediaType} video: ${detail}`);
    this.name = "UnreadableVideoFormat";
  }
}

export type ClipHeader = ClipHeaderResponse;

type Picture = Omit<ClipHeader, "audio" | "startTimecode" | "duration">;

// A transfer of PQ (16) or HLG (18) is HDR; any other, or none, reads as SDR.
const HDR_TRANSFERS: Record<number, "pq" | "hlg"> = { 16: "pq", 18: "hlg" };

/** `01:00:00:00` for a frame count at a nominal rate. Drop-frame, at 30 or
 * 60, skips two (four) frame numbers each minute but every tenth, and puts a
 * `;` before the frames. */
export function timecodeText(frame: number, nominal: number, dropFrame: boolean): string {
  let count = frame;
  const drops = dropFrame && nominal % 30 === 0;
  if (drops) {
    const drop = nominal / 15;
    const perMinute = nominal * 60 - drop;
    const perTenMinutes = perMinute * 10 + drop;
    const rest = count % perTenMinutes;
    count +=
      drop * 9 * Math.floor(count / perTenMinutes) + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = Math.floor(count / nominal);
  const clock = `${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return `${clock}${drops ? ";" : ":"}${pad(count % nominal)}`;
}

// ---- MP4, M4V and QuickTime: one box structure (ISO base media) ----

// The sample entry's four-character code names the codec. An unlisted one is
// shown as its code, which is what a tool like ffprobe would print.
const ISO_CODECS: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "HEVC",
  hev1: "HEVC",
  dvh1: "HEVC (Dolby Vision)",
  dvhe: "HEVC (Dolby Vision)",
  av01: "AV1",
  vp09: "VP9",
  vp08: "VP8",
  mp4v: "MPEG-4 Visual",
  apco: "ProRes 422 Proxy",
  apcs: "ProRes 422 LT",
  apcn: "ProRes 422",
  apch: "ProRes 422 HQ",
  ap4h: "ProRes 4444",
  ap4x: "ProRes 4444 XQ",
  jpeg: "Motion JPEG",
  mjpa: "Motion JPEG",
};

// ProRes says its depth by its flavor, the 422 family 10 bits, 4444 12.
const PRORES_BIT_DEPTH: Record<string, number> = { apco: 10, apcs: 10, apcn: 10, apch: 10, ap4h: 12, ap4x: 12 };
const DOLBY_VISION = new Set(["dvh1", "dvhe"]);
// Baseline, Main, Extended and High are 8-bit profiles of H.264.
const AVC_EIGHT_BIT_PROFILES = new Set([66, 77, 88, 100]);

const ISO_AUDIO_CODECS: Record<string, string> = {
  mp4a: "AAC",
  ".mp3": "MP3",
  "ac-3": "AC-3",
  "ec-3": "E-AC-3",
  Opus: "Opus",
  alac: "ALAC",
  fLaC: "FLAC",
  lpcm: "PCM",
  sowt: "PCM",
  twos: "PCM",
  in24: "PCM",
  in32: "PCM",
  fl32: "PCM",
  fl64: "PCM",
  "raw ": "PCM",
};

interface Box {
  type: string;
  payload: number;
  end: number;
}

async function boxAt(read: ByteReader, offset: number, limit: number): Promise<Box | undefined> {
  if (offset + 8 > limit) return undefined;
  const head = await read(offset, 16);
  if (head.length < 8) return undefined;
  let size = head.readUInt32BE(0);
  let payload = offset + 8;
  if (size === 1) {
    if (head.length < 16) return undefined;
    size = Number(head.readBigUInt64BE(8)); // a box past 4 GB: the picture data of a long take
    payload = offset + 16;
  } else if (size === 0) {
    size = limit - offset; // runs to the end of its parent
  }
  if (size < payload - offset) throw new UnreadableVideoFormat("video/mp4", "a box smaller than its own header");
  return { type: head.toString("latin1", 4, 8), payload, end: Math.min(offset + size, limit) };
}

async function childBox(read: ByteReader, parent: Box, type: string): Promise<Box | undefined> {
  for (let offset = parent.payload; offset < parent.end; ) {
    const box = await boxAt(read, offset, parent.end);
    if (!box) return undefined;
    if (box.type === type) return box;
    offset = box.end;
  }
  return undefined;
}

async function boxPath(read: ByteReader, parent: Box, types: readonly string[]): Promise<Box | undefined> {
  let box: Box | undefined = parent;
  for (const type of types) {
    if (!box) return undefined;
    box = await childBox(read, box, type);
  }
  return box;
}

// The boxes inside bytes already read, such as a sample entry's.
function* boxesIn(bytes: Buffer, from: number): Generator<{ type: string; payload: Buffer }> {
  for (let at = from; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > bytes.length) return;
    yield { type: bytes.toString("latin1", at + 4, at + 8), payload: bytes.subarray(at + 8, at + size) };
    at += size;
  }
}

/** Frames per second from a track's timescale and its sample durations.
 * One duration covering nearly every frame is a constant rate — a first or
 * last frame of another length is ordinary — and anything else is variable,
 * given as the average. */
export function frameRateOf(
  timescale: number,
  runs: readonly { count: number; delta: number }[],
): Pick<VideoFormatResponse, "frameRate" | "variableFrameRate"> {
  const frames = runs.reduce((sum, run) => sum + run.count, 0);
  const ticks = runs.reduce((sum, run) => sum + run.count * run.delta, 0);
  if (!timescale || !frames || !ticks) return { frameRate: null, variableFrameRate: false };
  const dominant = runs.reduce((best, run) => (run.count > best.count ? run : best));
  if (dominant.delta > 0 && dominant.count >= frames * 0.9) {
    return { frameRate: timescale / dominant.delta, variableFrameRate: false };
  }
  return { frameRate: (frames * timescale) / ticks, variableFrameRate: true };
}

async function trackRate(
  read: ByteReader,
  mdia: Box,
  stbl: Box | undefined,
): Promise<Pick<VideoFormatResponse, "frameRate" | "variableFrameRate">> {
  const mdhd = await childBox(read, mdia, "mdhd");
  const stts = stbl && (await childBox(read, stbl, "stts"));
  if (!mdhd || !stts) return { frameRate: null, variableFrameRate: false };
  const version = (await read(mdhd.payload, 1))[0];
  const timescale = (await read(mdhd.payload + (version === 1 ? 20 : 12), 4)).readUInt32BE(0);
  const count = Math.min(
    (await read(stts.payload + 4, 4)).readUInt32BE(0),
    Math.floor((stts.end - stts.payload - 8) / 8),
  );
  const table = await read(stts.payload + 8, count * 8);
  const runs = Array.from({ length: Math.floor(table.length / 8) }, (_, i) => ({
    count: table.readUInt32BE(i * 8),
    delta: table.readUInt32BE(i * 8 + 4),
  }));
  return frameRateOf(timescale, runs);
}

// The higher H.264 profiles give their depth in an extension after the
// parameter sets, which a writer may leave off.
function avcBitDepth(config: Buffer): number | null {
  const profile = config[1];
  if (profile === undefined) return null;
  if (AVC_EIGHT_BIT_PROFILES.has(profile)) return 8;
  let at = 5;
  for (const mask of [0x1f, 0xff]) {
    const sets = (config[at++] ?? 0) & mask;
    for (let i = 0; i < sets && at + 2 <= config.length; i++) at += 2 + config.readUInt16BE(at);
  }
  return at + 1 < config.length ? (config[at + 1] & 0x07) + 8 : null;
}

// A visual sample entry, ISO's and QuickTime's alike: fixed fields with the
// coded size and the depth (32 carries alpha), then the boxes configuring
// the codec and the color it is tagged with.
const ENTRY_WIDTH = 24;
const ENTRY_DEPTH = 74;
const ENTRY_CHILDREN = 78;
const MAX_ENTRY = 64 * 1024;

function pictureDetails(format: string, entry: Buffer): Pick<Picture, "bitDepth" | "hdr" | "alpha"> {
  let bitDepth: number | null = PRORES_BIT_DEPTH[format] ?? null;
  let hdr: "pq" | "hlg" | null = DOLBY_VISION.has(format) ? "pq" : null;
  const alpha = entry.length >= ENTRY_DEPTH + 2 && entry.readUInt16BE(ENTRY_DEPTH) === 32;
  for (const { type, payload } of boxesIn(entry, ENTRY_CHILDREN)) {
    if (type === "colr" && payload.length >= 8 && /^ncl[xc]$/.test(payload.toString("latin1", 0, 4))) {
      hdr = HDR_TRANSFERS[payload.readUInt16BE(6)] ?? null;
    } else if (type === "hvcC" && payload.length > 17) {
      bitDepth = (payload[17] & 0x07) + 8;
    } else if (type === "av1C" && payload.length > 2) {
      bitDepth = payload[2] & 0x40 ? (payload[2] & 0x20 ? 12 : 10) : 8;
    } else if (type === "vpcC" && payload.length > 8) {
      bitDepth = payload[6] >> 4;
      hdr = HDR_TRANSFERS[payload[8]] ?? hdr;
    } else if (type === "avcC") {
      bitDepth = avcBitDepth(payload);
    }
  }
  return { bitDepth, hdr, alpha };
}

// The track header's size is the one shown, after any pixel aspect; a
// quarter turn in its matrix (a phone held upright) swaps it.
async function displaySize(read: ByteReader, trak: Box): Promise<{ width: number; height: number } | null> {
  const tkhd = await childBox(read, trak, "tkhd");
  if (!tkhd) return null;
  const head = await read(tkhd.payload, 96);
  const v1 = head[0] === 1;
  const matrix = v1 ? 52 : 40;
  const size = v1 ? 88 : 76;
  if (head.length < size + 8) return null;
  const width = Math.round(head.readUInt32BE(size) / 65536);
  const height = Math.round(head.readUInt32BE(size + 4) / 65536);
  if (!width || !height) return null;
  const quarterTurn = head.readInt32BE(matrix) === 0 && head.readInt32BE(matrix + 4) !== 0;
  return quarterTurn ? { width: height, height: width } : { width, height };
}

async function videoTrack(
  read: ByteReader,
  trak: Box,
  mdia: Box,
  stbl: Box | undefined,
  entry: Box | undefined,
): Promise<Picture> {
  const format = entry?.type ?? null;
  const fields = entry ? await read(entry.payload, Math.min(entry.end - entry.payload, MAX_ENTRY)) : Buffer.alloc(0);
  const coded =
    fields.length >= ENTRY_WIDTH + 4
      ? { width: fields.readUInt16BE(ENTRY_WIDTH), height: fields.readUInt16BE(ENTRY_WIDTH + 2) }
      : null;
  const shown = (await displaySize(read, trak)) ?? (coded?.width && coded.height ? coded : null);
  return {
    codec: format ? (ISO_CODECS[format] ?? format.trim()) : null,
    ...(await trackRate(read, mdia, stbl)),
    ...(format ? pictureDetails(format, fields) : { bitDepth: null, hdr: null, alpha: false }),
    width: shown?.width ?? null,
    height: shown?.height ?? null,
  };
}

// An audio sample entry: QuickTime's version 2 keeps a fixed 3 where the
// channel count sits in earlier versions and ISO's, and the real count
// further on.
async function soundTrack(read: ByteReader, entry: Box): Promise<NonNullable<ClipHeader["audio"]>> {
  const head = await read(entry.payload, 44);
  const version = head.length >= 10 ? head.readUInt16BE(8) : 0;
  const channels =
    version === 2 ? (head.length >= 44 ? head.readUInt32BE(40) : 0) : head.length >= 18 ? head.readUInt16BE(16) : 0;
  return {
    codec: ISO_AUDIO_CODECS[entry.type] ?? entry.type.trim(),
    channels: channels > 0 && channels <= 64 ? channels : null,
  };
}

// A timecode track's entry gives its flags and nominal frames per second;
// its first sample, at the first chunk's offset in the data, the first
// frame's number.
async function timecodeTrack(read: ByteReader, entry: Box, stbl: Box): Promise<string | null> {
  const head = await read(entry.payload, 26);
  if (entry.type !== "tmcd" || head.length < 25 || !head[24]) return null;
  const dropFrame = (head.readUInt32BE(12) & 1) === 1;
  const stco = await childBox(read, stbl, "stco");
  const co64 = stco ? undefined : await childBox(read, stbl, "co64");
  const chunks = stco ?? co64;
  if (!chunks) return null;
  const first = await read(chunks.payload + 4, co64 ? 12 : 8);
  if (first.length < (co64 ? 12 : 8) || first.readUInt32BE(0) === 0) return null;
  const sample = await read(co64 ? Number(first.readBigUInt64BE(4)) : first.readUInt32BE(4), 4);
  if (sample.length < 4 || sample.readInt32BE(0) < 0) return null;
  return timecodeText(sample.readInt32BE(0), head[24], dropFrame);
}

async function movieDuration(read: ByteReader, moov: Box): Promise<number | null> {
  const mvhd = await childBox(read, moov, "mvhd");
  if (!mvhd) return null;
  const head = await read(mvhd.payload, 32);
  const v1 = head[0] === 1;
  if (head.length < (v1 ? 32 : 20)) return null;
  const timescale = head.readUInt32BE(v1 ? 20 : 12);
  const length = v1 ? head.readBigUInt64BE(24) : BigInt(head.readUInt32BE(16));
  const unknown = length === (v1 ? 0xffffffffffffffffn : 0xffffffffn);
  return timescale && length && !unknown ? Number(length) / timescale : null;
}

async function isoMedia(read: ByteReader, fileSize: number, mediaType: string): Promise<ClipHeader> {
  const moov = await childBox(read, { type: "", payload: 0, end: fileSize }, "moov");
  if (!moov) throw new UnreadableVideoFormat(mediaType, "no movie header");

  let picture: Picture | undefined;
  let audio: ClipHeader["audio"] = null;
  let startTimecode: string | null = null;
  for (let offset = moov.payload; offset < moov.end; ) {
    const trak = await boxAt(read, offset, moov.end);
    if (!trak) break;
    offset = trak.end;
    if (trak.type !== "trak") continue;

    const mdia = await childBox(read, trak, "mdia");
    const hdlr = mdia && (await childBox(read, mdia, "hdlr"));
    if (!mdia || !hdlr) continue;
    // Version and flags, a predefined (QuickTime: component type) field, then
    // the handler type: "vide" for picture, "soun" for audio, "tmcd" for timecode.
    const handler = (await read(hdlr.payload + 8, 4)).toString("latin1");
    const stbl = await boxPath(read, mdia, ["minf", "stbl"]);
    const stsd = stbl && (await childBox(read, stbl, "stsd"));
    const entry = stsd && (await boxAt(read, stsd.payload + 8, stsd.end));
    // A sound or timecode track only adds to a clip: one that doesn't read
    // leaves its fact unknown rather than the clip unreadable.
    if (handler === "vide" && !picture) picture = await videoTrack(read, trak, mdia, stbl, entry);
    else if (handler === "soun" && !audio && entry) audio = await soundTrack(read, entry).catch(() => null);
    else if (handler === "tmcd" && !startTimecode && entry && stbl) {
      startTimecode = await timecodeTrack(read, entry, stbl).catch(() => null);
    }
  }
  if (!picture) throw new UnreadableVideoFormat(mediaType, "no video track");
  return { ...picture, audio, startTimecode, duration: await movieDuration(read, moov).catch(() => null) };
}

// ---- WebM: EBML, Matroska's variable-length element encoding ----

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const DEFAULT_DURATION = 0x23e383;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DISPLAY_WIDTH = 0x54b0;
const DISPLAY_HEIGHT = 0x54ba;
const DISPLAY_UNIT = 0x54b2;
const ALPHA_MODE = 0x53c0;
const COLOUR = 0x55b0;
const BITS_PER_CHANNEL = 0x55b2;
const TRANSFER_CHARACTERISTICS = 0x55ba;
const AUDIO = 0xe1;
const CHANNELS = 0x9f;
const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

const MATROSKA_CODECS: Record<string, string> = {
  V_VP8: "VP8",
  V_VP9: "VP9",
  V_AV1: "AV1",
  "V_MPEG4/ISO/AVC": "H.264",
  "V_MPEGH/ISO/HEVC": "HEVC",
};

const MATROSKA_AUDIO_CODECS: Record<string, string> = {
  A_OPUS: "Opus",
  A_VORBIS: "Vorbis",
  "A_MPEG/L3": "MP3",
  A_FLAC: "FLAC",
  A_AC3: "AC-3",
  A_EAC3: "E-AC-3",
};

// A variable-length integer: the count of leading zero bits in the first byte
// is the count of bytes that follow. An element's ID keeps that marker bit; a
// size drops it, and a size of all ones means "unknown" — a live recorder's
// way of writing a segment before it knows how long it will be.
function vint(bytes: Buffer, at: number, keepMarker: boolean) {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length, unknown: !keepMarker && value === 2 ** (7 * length) - 1 };
}

interface Element {
  id: number;
  payload: number;
  size: number;
  unknownSize: boolean;
}

function elementIn(bytes: Buffer, at: number, base = 0): Element | undefined {
  const id = vint(bytes, at, true);
  const size = id && vint(bytes, at + id.length, false);
  if (!id || !size) return undefined;
  return { id: id.value, payload: base + at + id.length + size.length, size: size.value, unknownSize: size.unknown };
}

async function elementAt(read: ByteReader, offset: number): Promise<Element | undefined> {
  return elementIn(await read(offset, 12), 0, offset);
}

function* elementsIn(bytes: Buffer, from: number, to: number): Generator<Element> {
  for (let at = from; at < to; ) {
    const element = elementIn(bytes, at);
    if (!element) return;
    yield element;
    at = element.payload + element.size;
  }
}

function uintAt(bytes: Buffer, at: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i];
  return value;
}

function uintsIn(bytes: Buffer, parent: Element | undefined): Map<number, number> {
  const values = new Map<number, number>();
  if (!parent) return values;
  for (const field of elementsIn(bytes, parent.payload, parent.payload + parent.size)) {
    if (field.size <= 6) values.set(field.id, uintAt(bytes, field.payload, field.size));
    if (field.id === COLOUR) for (const [id, value] of uintsIn(bytes, field)) values.set(id, value);
  }
  return values;
}

// The display size is in pixels only when its unit says so (0, the default);
// otherwise it is a shape, and the picture's own size stands.
function matroskaPicture(
  tracks: Buffer,
  video: Element | undefined,
  codecId: string,
  codecPrivate: Buffer | undefined,
): Omit<Picture, "codec" | "frameRate" | "variableFrameRate"> {
  const fields = uintsIn(tracks, video);
  const inPixels = (fields.get(DISPLAY_UNIT) ?? 0) === 0;
  const width = (inPixels && fields.get(DISPLAY_WIDTH)) || fields.get(PIXEL_WIDTH) || null;
  const height = (inPixels && fields.get(DISPLAY_HEIGHT)) || fields.get(PIXEL_HEIGHT) || null;
  let bitDepth = fields.get(BITS_PER_CHANNEL) || null;
  if (!bitDepth && codecId === "V_VP8") bitDepth = 8;
  if (!bitDepth && codecId === "V_AV1" && codecPrivate && codecPrivate.length > 2) {
    bitDepth = codecPrivate[2] & 0x40 ? (codecPrivate[2] & 0x20 ? 12 : 10) : 8;
  }
  return {
    bitDepth,
    hdr: HDR_TRANSFERS[fields.get(TRANSFER_CHARACTERISTICS) ?? 0] ?? null,
    alpha: fields.get(ALPHA_MODE) === 1,
    width,
    height,
  };
}

// PCM's and AAC's codec IDs go on to name a variant: A_PCM/INT/LIT, A_AAC/MPEG4/LC.
function matroskaAudioCodec(codecId: string): string {
  if (codecId.startsWith("A_PCM/")) return "PCM";
  if (codecId.startsWith("A_AAC")) return "AAC";
  return MATROSKA_AUDIO_CODECS[codecId] ?? codecId;
}

function matroskaTracks(tracks: Buffer): { video?: Picture; audio: ClipHeader["audio"] } {
  let video: Picture | undefined;
  let audio: ClipHeader["audio"] = null;
  for (const entry of elementsIn(tracks, 0, tracks.length)) {
    if (entry.id !== TRACK_ENTRY) continue;
    let type = 0;
    let codecId = "";
    let frameNanos = 0;
    let codecPrivate: Buffer | undefined;
    let pictureFields: Element | undefined;
    let soundFields: Element | undefined;
    for (const field of elementsIn(tracks, entry.payload, entry.payload + entry.size)) {
      if (field.id === TRACK_TYPE) type = uintAt(tracks, field.payload, field.size);
      else if (field.id === CODEC_ID) codecId = tracks.toString("latin1", field.payload, field.payload + field.size);
      else if (field.id === DEFAULT_DURATION) frameNanos = uintAt(tracks, field.payload, field.size);
      else if (field.id === CODEC_PRIVATE) codecPrivate = tracks.subarray(field.payload, field.payload + field.size);
      else if (field.id === VIDEO) pictureFields = field;
      else if (field.id === AUDIO) soundFields = field;
    }
    const codec = codecId.replace(/\0+$/, "");
    if (type === VIDEO_TRACK && !video) {
      video = {
        codec: codec ? (MATROSKA_CODECS[codec] ?? codec) : null,
        frameRate: frameNanos ? 1e9 / frameNanos : null,
        variableFrameRate: false,
        ...matroskaPicture(tracks, pictureFields, codec, codecPrivate),
      };
    } else if (type === AUDIO_TRACK && !audio && codec) {
      const channels = uintsIn(tracks, soundFields).get(CHANNELS);
      audio = { codec: matroskaAudioCodec(codec), channels: channels && channels <= 64 ? channels : null };
    }
  }
  return { video, audio };
}

// Duration is a float in ticks of the timecode scale, a millisecond unless
// the segment says otherwise.
function matroskaDuration(info: Buffer): number | null {
  let scale = 1_000_000;
  let ticks: number | null = null;
  for (const field of elementsIn(info, 0, info.length)) {
    if (field.id === TIMECODE_SCALE) scale = uintAt(info, field.payload, field.size);
    if (field.id === DURATION && field.size === 4) ticks = info.readFloatBE(field.payload);
    if (field.id === DURATION && field.size === 8) ticks = info.readDoubleBE(field.payload);
  }
  const seconds = ticks === null ? Number.NaN : (ticks * scale) / 1e9;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// The track list sits ahead of the clusters of picture data in every writer
// that matters, so the walk stops at the first element it cannot measure —
// a cluster of unknown size — rather than scanning the stream.
async function matroska(read: ByteReader, fileSize: number): Promise<ClipHeader> {
  const header = await elementAt(read, 0);
  if (header?.id !== EBML_HEADER) throw new UnreadableVideoFormat("video/webm", "not an EBML file");
  const segment = await elementAt(read, header.payload + header.size);
  if (segment?.id !== SEGMENT) throw new UnreadableVideoFormat("video/webm", "no segment");
  const end = segment.unknownSize ? fileSize : Math.min(segment.payload + segment.size, fileSize);

  let duration: number | null = null;
  for (let offset = segment.payload; offset < end; ) {
    const element = await elementAt(read, offset);
    if (!element) break;
    if (element.id === INFO && !element.unknownSize) {
      duration = matroskaDuration(await read(element.payload, Math.min(element.size, 1 << 16)));
    }
    if (element.id === TRACKS && !element.unknownSize) {
      const { video, audio } = matroskaTracks(await read(element.payload, Math.min(element.size, 1 << 20)));
      if (video) return { ...video, audio, startTimecode: null, duration };
      break;
    }
    if (element.unknownSize) break;
    offset = element.payload + element.size;
  }
  throw new UnreadableVideoFormat("video/webm", "no video track");
}

/** Everything the header says of one of the video types a space can hold.
 * Throws rather than guessing, the way the image header reader does. */
export async function readClipHeader(mediaType: string, read: ByteReader, fileSize: number): Promise<ClipHeader> {
  switch (mediaType) {
    case "video/mp4":
    case "video/quicktime":
      return isoMedia(read, fileSize, mediaType);
    case "video/webm":
      return matroska(read, fileSize);
    default:
      throw new UnreadableVideoFormat(mediaType, "not a container this reads");
  }
}
