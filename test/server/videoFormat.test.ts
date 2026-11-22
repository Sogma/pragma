import { describe, expect, it } from "vitest";
import { frameRateOf, readClipHeader, timecodeText } from "../../src/server/videoFormat.ts";
import { countingReader } from "../support/countingReader.ts";
import {
  box,
  element,
  isoVideo,
  soundEntry,
  trackHeader,
  uintElement,
  visualEntry,
  webmVideo,
} from "../support/videoFixtures.ts";

const readMp4 = (bytes: Buffer) => readClipHeader("video/mp4", countingReader(bytes), bytes.length);
const readWebm = (bytes: Buffer) => readClipHeader("video/webm", countingReader(bytes), bytes.length);

describe("frameRateOf", () => {
  it("takes a constant rate from the one frame duration", () => {
    expect(frameRateOf(24_000, [{ count: 100, delta: 1001 }]).frameRate).toBeCloseTo(23.976, 3);
    expect(frameRateOf(25, [{ count: 100, delta: 1 }])).toEqual({ frameRate: 25, variableFrameRate: false });
  });

  // A first or last frame of another length is how encoders end a clip,
  // not a variable rate.
  it("keeps a rate constant through an odd frame at either end", () => {
    const runs = [
      { count: 1, delta: 1500 },
      { count: 239, delta: 1000 },
    ];
    expect(frameRateOf(30_000, runs)).toEqual({ frameRate: 30, variableFrameRate: false });
  });

  it("averages a variable rate", () => {
    const runs = [
      { count: 50, delta: 1000 },
      { count: 50, delta: 1100 },
    ];
    const { frameRate, variableFrameRate } = frameRateOf(30_000, runs);
    expect(variableFrameRate).toBe(true);
    expect(frameRate).toBeCloseTo((100 * 30_000) / 105_000, 6);
  });

  it("says nothing for an empty table", () => {
    expect(frameRateOf(25, [])).toEqual({ frameRate: null, variableFrameRate: false });
  });
});

describe("readVideoFormat", () => {
  it("reads the video track's codec and rate past an audio track", async () => {
    expect(await readMp4(isoVideo({ codec: "avc1", timescale: 24_000, runs: [[240, 1001]] }))).toMatchObject({
      codec: "H.264",
      variableFrameRate: false,
    });
    expect((await readMp4(isoVideo({ timescale: 24_000, runs: [[240, 1001]] }))).frameRate).toBeCloseTo(23.976, 3);
  });

  it("names QuickTime's ProRes flavors, and shows an unlisted code as itself", async () => {
    const readMov = (codec: string) =>
      readClipHeader("video/quicktime", countingReader(isoVideo({ codec })), isoVideo({ codec }).length);
    expect((await readMov("apch")).codec).toBe("ProRes 422 HQ");
    expect((await readMov("ap4h")).codec).toBe("ProRes 4444");
    expect((await readMov("hvc1")).codec).toBe("HEVC");
    expect((await readMov("xyz ")).codec).toBe("xyz");
  });

  // A file written without "fast start" keeps its index after the picture
  // data; the walk jumps the data box by its size instead of reading it.
  it("finds an index behind the picture data without reading the data", async () => {
    for (const largeData of [false, true]) {
      const bytes = isoVideo({ dataBefore: 2_000_000, largeData });
      const read = countingReader(bytes);
      expect(await readClipHeader("video/mp4", read, bytes.length), `largeData ${largeData}`).toMatchObject({
        codec: "H.264",
        frameRate: 25,
      });
      expect(read.requested).toBeLessThan(2_000);
    }
  });

  it("refuses a file with no movie header or no video track", async () => {
    await expect(readMp4(Buffer.from("not a video at all"))).rejects.toThrow(/no movie header/);
    await expect(readMp4(isoVideo({ audioOnly: true }))).rejects.toThrow(/no video track/);
  });

  it("reads a WebM's codec and its default frame duration", async () => {
    expect(await readWebm(webmVideo())).toMatchObject({ codec: "VP9", frameRate: 25, variableFrameRate: false });
    expect((await readWebm(webmVideo({ codecId: "V_AV1", frameNanos: 41_708_333 }))).frameRate).toBeCloseTo(23.976, 2);
  });

  // A live recorder writes the segment before it knows its length, and may
  // never write a frame duration: the codec still reads, the rate doesn't.
  it("reads a live-recorded WebM's codec without a frame rate", async () => {
    expect(await readWebm(webmVideo({ codecId: "V_VP8", frameNanos: null, liveRecorded: true }))).toMatchObject({
      codec: "VP8",
      frameRate: null,
      variableFrameRate: false,
    });
  });

  it("stops at a cluster it cannot measure rather than scanning the stream", async () => {
    await expect(readWebm(webmVideo({ tracksAfterCluster: true }))).rejects.toThrow(/no video track/);
    await expect(readWebm(Buffer.from("RIFF...."))).rejects.toThrow(/EBML/);
  });
});

const readHeader = (bytes: Buffer, mediaType = "video/mp4") =>
  readClipHeader(mediaType, countingReader(bytes), bytes.length);

// A colour box of the nclx kind: primaries, transfer, matrix and range.
function colr(transfer: number, primaries = 1) {
  const fields = Buffer.alloc(11);
  fields.write("nclx", 0, "latin1");
  fields.writeUInt16BE(primaries, 4);
  fields.writeUInt16BE(transfer, 6);
  fields.writeUInt16BE(1, 8);
  return box("colr", fields);
}

function hvcC(bitDepth: number) {
  const fields = Buffer.alloc(23);
  fields[16] = 0xfc | 1; // 4:2:0
  fields[17] = 0xf8 | (bitDepth - 8);
  return box("hvcC", fields);
}

// An avcC with one parameter set of each kind, and the high profiles'
// extension giving the depth when `bitDepth` is set.
function avcC(profile: number, bitDepth?: number) {
  const sets = Buffer.from([0xe1, 0x00, 0x02, 0x67, profile, 0x01, 0x00, 0x02, 0x68, 0xce]);
  const extension = bitDepth === undefined ? [] : [0xfd, 0xf8 | (bitDepth - 8), 0xf8 | (bitDepth - 8), 0x00];
  return box("avcC", Buffer.from([1, profile, 0, 40, 0xff]), sets, Buffer.from(extension));
}

describe("readClipHeader", () => {
  it("reads the picture's bits per sample from its codec's configuration, and ProRes's from its flavor", async () => {
    const depthOf = async (entry: Buffer) => (await readHeader(isoVideo({ entry }))).bitDepth;
    expect(await depthOf(visualEntry("hvc1", { boxes: [hvcC(10)] }))).toBe(10);
    expect(await depthOf(visualEntry("avc1", { boxes: [avcC(100)] }))).toBe(8);
    expect(await depthOf(visualEntry("avc1", { boxes: [avcC(110, 10)] }))).toBe(10);
    expect(await depthOf(visualEntry("avc1", { boxes: [avcC(110)] }))).toBeNull();
    expect(
      await depthOf(visualEntry("av01", { boxes: [box("av1C", Buffer.from([0x81, 0x08, 0x40 | 0x20, 0]))] })),
    ).toBe(12);
    expect(
      await depthOf(visualEntry("vp09", { boxes: [box("vpcC", Buffer.from([1, 0, 0, 0, 2, 31, 0xa0, 9, 16, 9]))] })),
    ).toBe(10);
    expect(await depthOf(visualEntry("apch"))).toBe(10);
    expect(await depthOf(visualEntry("ap4x"))).toBe(12);
    expect(await depthOf(visualEntry("mp4v"))).toBeNull();
  });

  it("says HDR for a PQ or HLG transfer, and alpha for a picture 32 bits deep", async () => {
    const pictureOf = async (entry: Buffer) => {
      const { hdr, alpha } = await readHeader(isoVideo({ entry }));
      return { hdr, alpha };
    };
    expect(await pictureOf(visualEntry("hvc1", { boxes: [colr(16, 9), hvcC(10)] }))).toEqual({
      hdr: "pq",
      alpha: false,
    });
    expect(await pictureOf(visualEntry("hvc1", { boxes: [colr(18, 9)] }))).toEqual({ hdr: "hlg", alpha: false });
    expect(await pictureOf(visualEntry("avc1", { boxes: [colr(1)] }))).toEqual({ hdr: null, alpha: false });
    expect(await pictureOf(visualEntry("dvh1"))).toEqual({ hdr: "pq", alpha: false });
    expect(await pictureOf(visualEntry("ap4h", { depth: 32 }))).toEqual({ hdr: null, alpha: true });
  });

  // An upright phone clip is stored lying down, with a quarter turn to show it.
  it("reads the shown size from the track header, turned upright where it turns, and the length from the movie's", async () => {
    const shown = await readHeader(isoVideo({ tkhd: trackHeader(1920, 1080, true), movie: [600, 3000] }));
    expect([shown.width, shown.height, shown.duration]).toEqual([1080, 1920, 5]);
    const coded = await readHeader(isoVideo({ entry: visualEntry("ap4x", { width: 1188, height: 2112 }) }));
    expect([coded.width, coded.height, coded.duration]).toEqual([1188, 2112, null]);
  });

  it("names the first audio track and its channels, QuickTime's version 2 description included", async () => {
    expect((await readHeader(isoVideo({ sound: soundEntry("mp4a", { channels: 2 }) }))).audio).toEqual({
      codec: "AAC",
      channels: 2,
    });
    expect((await readHeader(isoVideo({ sound: soundEntry("lpcm", { channels: 6, version: 2 }) }))).audio).toEqual({
      codec: "PCM",
      channels: 6,
    });
    expect((await readHeader(isoVideo({ sound: null }))).audio).toBeNull();
  });

  it("reads the first frame's timecode from a timecode track, a drop-frame one with its semicolon", async () => {
    const at = (frame: number, fps: number, dropFrame = false) =>
      readHeader(isoVideo({ timecode: { frame, fps, dropFrame } })).then((header) => header.startTimecode);
    expect(await at(86_400, 24)).toBe("01:00:00:00");
    expect(await at(107_892, 30, true)).toBe("01:00:00;00");
    expect((await readHeader(isoVideo())).startTimecode).toBeNull();
  });

  it("reads a WebM's length, shown size, depth, transfer, alpha and audio channels", async () => {
    const header = await readHeader(
      webmVideo({
        duration: 12_500,
        pictureFields: [
          uintElement(0xb0, 1920),
          uintElement(0xba, 1080),
          uintElement(0x53c0, 1),
          element(0x55b0, uintElement(0x55b2, 10), uintElement(0x55ba, 16)),
        ],
        audioChannels: 2,
      }),
      "video/webm",
    );
    expect(header).toMatchObject({
      codec: "VP9",
      frameRate: 25,
      width: 1920,
      height: 1080,
      duration: 12.5,
      bitDepth: 10,
      hdr: "pq",
      alpha: true,
      audio: { codec: "Opus", channels: 2 },
      startTimecode: null,
    });
    // A display size in pixels is the one shown; one in another unit is only a shape.
    const anamorphic = (unit: number) =>
      readHeader(
        webmVideo({
          pictureFields: [
            uintElement(0xb0, 1440),
            uintElement(0xba, 1080),
            uintElement(0x54b0, unit === 0 ? 1920 : 16),
            uintElement(0x54ba, unit === 0 ? 1080 : 9),
            uintElement(0x54b2, unit),
          ],
        }),
        "video/webm",
      );
    expect(await anamorphic(0)).toMatchObject({ width: 1920, height: 1080 });
    expect(await anamorphic(3)).toMatchObject({ width: 1440, height: 1080 });
    expect(await readHeader(webmVideo({ codecId: "V_VP8" }), "video/webm")).toMatchObject({
      bitDepth: 8,
      duration: null,
    });
  });
});

describe("timecodeText", () => {
  it("counts hours, minutes, seconds and frames at the nominal rate, past 24 hours round again", () => {
    expect(timecodeText(0, 25, false)).toBe("00:00:00:00");
    expect(timecodeText(25 * 3661 + 7, 25, false)).toBe("01:01:01:07");
    expect(timecodeText(24 * 86_400 + 3, 24, false)).toBe("00:00:00:03");
  });

  // Drop-frame skips frame numbers 0 and 1 at each minute but every tenth.
  it("skips drop-frame's numbers at each minute but every tenth", () => {
    expect(timecodeText(1799, 30, true)).toBe("00:00:59;29");
    expect(timecodeText(1800, 30, true)).toBe("00:01:00;02");
    expect(timecodeText(17_982, 30, true)).toBe("00:10:00;00");
    expect(timecodeText(3600, 60, true)).toBe("00:01:00;04");
  });
});
