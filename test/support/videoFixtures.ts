// Minimal video containers, built box by box and element by element: just
// the headers the video-format reader walks, with no picture data. Shared by
// the reader's unit tests and the route's contract test.

/** An ISO base media box: a 32-bit size, a four-character type, a payload. */
export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** A box with a 64-bit size, the form a data box past 4 GB takes. */
export function largeBox(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(type, 4, "latin1");
  head.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([head, payload]);
}

/** A visual sample entry: its coded size and depth (32 carries alpha) in
 * the fixed fields, then the boxes that configure the codec. */
export function visualEntry(format: string, { width = 0, height = 0, depth = 24, boxes = [] as Buffer[] } = {}) {
  const fields = Buffer.alloc(78);
  fields.writeUInt16BE(width, 24);
  fields.writeUInt16BE(height, 26);
  fields.writeUInt16BE(depth, 74);
  return box(format, fields, ...boxes);
}

/** An audio sample entry, QuickTime's version 2 keeping the real channel
 * count past a fixed 3. */
export function soundEntry(format: string, { channels = 2, version = 0 } = {}) {
  const fields = Buffer.alloc(version === 2 ? 64 : 28);
  fields.writeUInt16BE(version, 8);
  fields.writeUInt16BE(version === 2 ? 3 : channels, 16);
  if (version === 2) fields.writeUInt32BE(channels, 40);
  return box(format, fields);
}

/** A track header: its shown size, and a matrix with or without a quarter turn. */
export function trackHeader(width = 0, height = 0, quarterTurn = false) {
  const fields = Buffer.alloc(84);
  const matrix = quarterTurn
    ? [0, 0x10000, -0x10000, 0, 0, 0, 0, 0, 0x40000000]
    : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  for (const [i, value] of matrix.entries()) fields.writeInt32BE(value, 40 + i * 4);
  fields.writeUInt32BE(width * 65536, 76);
  fields.writeUInt32BE(height * 65536, 80);
  return box("tkhd", fields);
}

function track(
  handler: string,
  entry: Buffer,
  timescale: number,
  runs: [number, number][],
  { tkhd = box("tkhd", Buffer.alloc(84)), chunkOffset }: { tkhd?: Buffer; chunkOffset?: number } = {},
): Buffer {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(timescale, 12);
  const hdlr = Buffer.alloc(25);
  hdlr.write("mhlr", 4, "latin1"); // QuickTime's component type; MP4 leaves it zero
  hdlr.write(handler, 8, "latin1");
  const stsd = Buffer.alloc(8);
  stsd.writeUInt32BE(1, 4);
  const stts = Buffer.alloc(8 + runs.length * 8);
  stts.writeUInt32BE(runs.length, 4);
  runs.forEach(([count, delta], i) => {
    stts.writeUInt32BE(count, 8 + i * 8);
    stts.writeUInt32BE(delta, 12 + i * 8);
  });
  const stco = Buffer.alloc(12);
  stco.writeUInt32BE(1, 4);
  stco.writeUInt32BE(chunkOffset ?? 0, 8);
  return box(
    "trak",
    tkhd,
    box(
      "mdia",
      box("mdhd", mdhd),
      box("hdlr", hdlr),
      box(
        "minf",
        box("vmhd", Buffer.alloc(12)),
        box(
          "stbl",
          box("stsd", stsd, entry),
          box("stts", stts),
          ...(chunkOffset === undefined ? [] : [box("stco", stco)]),
        ),
      ),
    ),
  );
}

export interface IsoVideo {
  codec?: string; // the sample entry's four-character code
  timescale?: number;
  runs?: [count: number, delta: number][]; // the stts table
  // Bytes of picture data ahead of the index, as a file written without
  // "fast start" has them.
  dataBefore?: number;
  largeData?: boolean;
  audioOnly?: boolean;
  /** The video sample entry, in place of a bare one of `codec`. */
  entry?: Buffer;
  tkhd?: Buffer;
  /** The movie header's timescale and duration. */
  movie?: [timescale: number, duration: number];
  /** The audio track's sample entry, in place of a bare AAC one; null for none. */
  sound?: Buffer | null;
  /** A timecode track whose first sample, in the data ahead of the index, is this frame. */
  timecode?: { frame: number; fps: number; dropFrame?: boolean };
}

/** An MP4 or QuickTime file: an audio track first, then the video track. */
export function isoVideo({
  codec = "avc1",
  timescale = 25,
  runs = [[200, 1]],
  dataBefore = 0,
  largeData = false,
  audioOnly = false,
  entry,
  tkhd,
  movie,
  sound,
  timecode,
}: IsoVideo = {}): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isomavc1", "latin1"));
  const mvhd = Buffer.alloc(100);
  if (movie) {
    mvhd.writeUInt32BE(movie[0], 12);
    mvhd.writeUInt32BE(movie[1], 16);
  }
  // The timecode's first sample sits first in the data box, just past its header.
  const sample = Buffer.alloc(4);
  if (timecode) sample.writeInt32BE(timecode.frame);
  // QuickTime's timecode entry: reserved, flags (1 is drop-frame), its own
  // timescale and frame duration, then the nominal frames per second.
  const tmcd = Buffer.alloc(26);
  if (timecode) {
    tmcd.writeUInt32BE(timecode.dropFrame ? 1 : 0, 12);
    tmcd.writeUInt32BE(timecode.fps * 1000, 16);
    tmcd.writeUInt32BE(timecode.dropFrame ? 1001 : 1000, 20);
    tmcd.writeUInt8(timecode.fps, 24);
  }
  const data = Buffer.concat([timecode ? sample : Buffer.alloc(0), Buffer.alloc(dataBefore)]);
  const mdat = data.length ? [largeData ? largeBox("mdat", data) : box("mdat", data)] : [];
  const moov = box(
    "moov",
    box("mvhd", mvhd),
    ...(sound === null ? [] : [track("soun", sound ?? box("mp4a", Buffer.alloc(28)), 48_000, [[400, 1024]])]),
    ...(audioOnly ? [] : [track("vide", entry ?? visualEntry(codec), timescale, runs, { tkhd })]),
    ...(timecode
      ? [track("tmcd", box("tmcd", tmcd), timecode.fps, [[1, 1]], { chunkOffset: ftyp.length + (largeData ? 16 : 8) })]
      : []),
  );
  return Buffer.concat([ftyp, ...mdat, moov]);
}

// ---- WebM ----

const hex = (value: number) =>
  Buffer.from(
    value.toString(16).padStart(value > 0xffffff ? 8 : value > 0xffff ? 6 : value > 0xff ? 4 : 2, "0"),
    "hex",
  );

/** An EBML element with an 8-byte size, or an unknown one. */
export function element(id: number, payload: Buffer | "unknown-size", ...rest: Buffer[]): Buffer {
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  if (payload === "unknown-size") {
    size.fill(0xff, 1);
    return Buffer.concat([hex(id), size, ...rest]);
  }
  const body = Buffer.concat([payload, ...rest]);
  size.writeUIntBE(body.length, 2, 6);
  return Buffer.concat([hex(id), size, body]);
}

const uint = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

export interface WebmVideo {
  codecId?: string;
  frameNanos?: number | null; // DefaultDuration; null leaves it out
  liveRecorded?: boolean; // unknown-size segment, as a live recorder writes it
  tracksAfterCluster?: boolean;
  /** The segment's length, in ticks of its timecode scale. */
  duration?: number;
  timecodeScale?: number;
  /** Elements of the video track's Video element: sizes, alpha, colour. */
  pictureFields?: Buffer[];
  audioChannels?: number;
}

/** An EBML element holding an unsigned integer. */
export const uintElement = (id: number, value: number) => element(id, uint(value));

/** A WebM file: an audio track, then the video track. */
export function webmVideo({
  codecId = "V_VP9",
  frameNanos = 40_000_000,
  liveRecorded = false,
  tracksAfterCluster = false,
  duration,
  timecodeScale,
  pictureFields,
  audioChannels,
}: WebmVideo = {}): Buffer {
  const audio = element(
    0xae,
    element(0x83, uint(2)),
    element(0x86, Buffer.from("A_OPUS")),
    ...(audioChannels === undefined ? [] : [element(0xe1, uintElement(0x9f, audioChannels))]),
  );
  const video = element(
    0xae,
    element(0x83, uint(1)),
    element(0x86, Buffer.from(codecId)),
    ...(frameNanos === null ? [] : [element(0x23e383, uint(frameNanos))]),
    ...(pictureFields ? [element(0xe0, ...(pictureFields as [Buffer, ...Buffer[]]))] : []),
  );
  const ticks = Buffer.alloc(8);
  if (duration !== undefined) ticks.writeDoubleBE(duration);
  const info = element(
    0x1549a966,
    Buffer.concat([
      ...(timecodeScale === undefined ? [] : [uintElement(0x2ad7b1, timecodeScale)]),
      ...(duration === undefined ? [] : [element(0x4489, ticks)]),
    ]),
  );
  const tracks = element(0x1654ae6b, audio, video);
  const cluster =
    liveRecorded || tracksAfterCluster ? element(0x1f43b675, "unknown-size") : element(0x1f43b675, Buffer.alloc(64));
  const children = [info, ...(tracksAfterCluster ? [cluster, tracks] : [tracks, cluster])];
  return Buffer.concat([
    element(0x1a45dfa3, Buffer.from("webm")),
    liveRecorded ? element(0x18538067, "unknown-size", ...children) : element(0x18538067, Buffer.concat(children)),
  ]);
}
