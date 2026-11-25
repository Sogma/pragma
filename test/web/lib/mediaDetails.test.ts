import { describe, expect, it } from "vitest";
import {
  bitDepthText,
  clipDetailRows,
  clipFormatText,
  pictureDetailRows,
  pixelFormatRows,
  pixelFormatText,
  sourceTypeText,
} from "../../../web/lib/mediaDetails.ts";

const clip = {
  codec: "H.264",
  frameRate: 24,
  variableFrameRate: false,
  bitDepth: 8,
  hdr: null,
  alpha: false,
  audio: { codec: "AAC", channels: 2 },
  startTimecode: null,
};

describe("clipDetailRows", () => {
  it("words each fact the header gives, SDR where it names no HDR transfer", () => {
    expect(clipDetailRows(clip)).toEqual([
      { label: "Bit depth", value: "8 bits per channel" },
      { label: "Dynamic range", value: "SDR" },
      { label: "Audio", value: "AAC, 2 channels" },
    ]);
  });

  it("adds alpha and a start timecode only where the clip has them, and says when it has no sound", () => {
    const graded = {
      ...clip,
      bitDepth: 12,
      hdr: "hlg" as const,
      alpha: true,
      audio: null,
      startTimecode: "01:00:00;00",
    };
    expect(clipDetailRows(graded)).toEqual([
      { label: "Bit depth", value: "12 bits per channel" },
      { label: "Dynamic range", value: "HDR (HLG)" },
      { label: "Alpha", value: "Yes" },
      { label: "Audio", value: "None" },
      { label: "Start timecode", value: "01:00:00;00" },
    ]);
  });

  it("leaves out a depth the header doesn't give, and a channel count it doesn't", () => {
    const rows = clipDetailRows({ ...clip, bitDepth: null, audio: { codec: "Opus", channels: null } });
    expect(rows.map((row) => row.label)).not.toContain("Bit depth");
    expect(rows).toContainEqual({ label: "Audio", value: "Opus" });
    expect(clipDetailRows({ ...clip, audio: { codec: "PCM", channels: 1 } })).toContainEqual({
      label: "Audio",
      value: "PCM, 1 channel",
    });
  });
});

// A previewed clip's bottom bar: its picture in one.
describe("clipFormatText", () => {
  it("puts the frame rate first, then the codec and the depth, leaving SDR unsaid", () => {
    expect(clipFormatText(clip)).toBe("24 fps · H.264 · 8-bit");
  });

  it("adds an HDR transfer and alpha where the clip has them", () => {
    const graded = {
      ...clip,
      codec: "ProRes 4444",
      frameRate: 30_000 / 1001,
      bitDepth: 12,
      hdr: "pq" as const,
      alpha: true,
    };
    expect(clipFormatText(graded)).toBe("29.97 fps · ProRes 4444 · 12-bit · HDR (PQ) · Alpha");
  });

  it("leaves out what the header doesn't give, and says when the rate varies", () => {
    expect(clipFormatText({ ...clip, codec: null, bitDepth: null })).toBe("24 fps");
    expect(clipFormatText({ ...clip, frameRate: null })).toBe("H.264 · 8-bit");
    expect(clipFormatText({ ...clip, frameRate: 29.97, variableFrameRate: true })).toBe(
      "30 fps (variable) · H.264 · 8-bit",
    );
    expect(clipFormatText({ ...clip, codec: null, frameRate: null, bitDepth: null })).toBe("");
  });
});

describe("pictureDetailRows", () => {
  it("names a source in plain words, a code it doesn't know as itself, and none without one", () => {
    expect(pictureDetailRows({ sourceType: "trainedAlgorithmicMedia" })).toEqual([
      { label: "Source", value: "Made by AI" },
    ]);
    expect(sourceTypeText("compositeWithTrainedAlgorithmicMedia")).toBe("Edited with AI");
    expect(sourceTypeText("digitalCapture")).toBe("Camera");
    expect(sourceTypeText("someFutureCode")).toBe("someFutureCode");
    expect(pictureDetailRows({ sourceType: null })).toEqual([]);
  });
});

describe("bitDepthText", () => {
  it("says bits per channel, or per pixel for a palette's index", () => {
    expect(bitDepthText(16)).toBe("16 bits per channel");
    expect(bitDepthText(1, "pixel")).toBe("1 bit per pixel");
  });
});

// The image tab's rows and a gallery selection's, worded once.
describe("pixelFormatRows", () => {
  it("names a still's color mode as an image editor's Mode menu does, and its depth", () => {
    expect(pixelFormatRows({ colorModel: "grayscale", alpha: true, bitDepth: 16 })).toEqual([
      { label: "Color mode", value: "Grayscale + alpha" },
      { label: "Bit depth", value: "16 bits per channel" },
    ]);
    expect(pixelFormatRows({ colorModel: "indexed", alpha: false, bitDepth: 1 })[1].value).toBe("1 bit per pixel");
  });

  it("says Unknown for both without a pixel format, or the stand-in it is given while one is read", () => {
    expect(pixelFormatRows(null).map((row) => row.value)).toEqual(["Unknown", "Unknown"]);
    expect(pixelFormatRows(null, "…").map((row) => row.value)).toEqual(["…", "…"]);
  });
});

// The image tab's bottom bar: the mode and its depth in one.
describe("pixelFormatText", () => {
  it("puts the depth after the mode's name", () => {
    expect(pixelFormatText({ colorModel: "rgb", alpha: true, bitDepth: 8 })).toBe("RGBA 8-bit");
    expect(pixelFormatText({ colorModel: "grayscale", alpha: true, bitDepth: 16 })).toBe("Grayscale + alpha 16-bit");
    expect(pixelFormatText({ colorModel: "indexed", alpha: false, bitDepth: 4 })).toBe("Indexed 4-bit");
  });
});
