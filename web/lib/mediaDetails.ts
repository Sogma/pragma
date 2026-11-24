// What a media file's header says beyond its size and length, worded once:
// the Info rows of the video tab, the image tab and a gallery's selection.
// A fact the header doesn't give gets no row.
import type { ClipDetails, PictureDetails, PixelFormat } from "../../src/protocol/api.ts";
import { countText } from "./dom.ts";

export interface DetailRow {
  label: string;
  value: string;
}

/** `8 bits per channel`; a palette's depth is its index's, one per pixel. */
export function bitDepthText(bitDepth: number, per: "channel" | "pixel" = "channel"): string {
  return `${countText(bitDepth, "bit")} per ${per}`;
}

const COLOR_MODEL_NAMES: Record<PixelFormat["colorModel"], string> = {
  grayscale: "Grayscale",
  rgb: "RGB",
  cmyk: "CMYK",
  indexed: "Indexed",
};

/** The name an image editor's Mode menu gives it: `RGB`, `RGBA`,
 * `Grayscale + alpha`. */
function colorModeName({ colorModel, alpha }: PixelFormat): string {
  if (!alpha) return COLOR_MODEL_NAMES[colorModel];
  return colorModel === "rgb" ? "RGBA" : `${COLOR_MODEL_NAMES[colorModel]} + alpha`;
}

/** The mode with its depth in one, as a bar shows it: `RGBA 8-bit`. */
export function pixelFormatText(pixels: PixelFormat): string {
  return `${colorModeName(pixels)} ${pixels.bitDepth}-bit`;
}

/** A raster still's Color mode and Bit depth rows. Without a pixel format
 * both read `unknown`: Unknown where its header gave none, or a stand-in
 * while it is read. */
export function pixelFormatRows(pixels: PixelFormat | null, unknown = "Unknown"): DetailRow[] {
  const per = pixels?.colorModel === "indexed" ? "pixel" : "channel";
  return [
    { label: "Color mode", value: pixels ? colorModeName(pixels) : unknown },
    { label: "Bit depth", value: pixels ? bitDepthText(pixels.bitDepth, per) : unknown },
  ];
}

const DYNAMIC_RANGES = { pq: "HDR (PQ)", hlg: "HDR (HLG)" } as const;

// The IPTC digital source types in plain words. A code not listed shows as
// itself, the standard's own name for it.
const SOURCE_TYPES: Record<string, string> = {
  trainedAlgorithmicMedia: "Made by AI",
  compositeWithTrainedAlgorithmicMedia: "Edited with AI",
  algorithmicMedia: "Made by an algorithm",
  algorithmicallyEnhanced: "Enhanced by an algorithm",
  digitalCapture: "Camera",
  computationalCapture: "Camera, computational",
  negativeFilm: "Scanned film negative",
  positiveFilm: "Scanned film",
  print: "Scanned print",
  digitalCreation: "Digital art",
  digitalArt: "Digital art",
  screenCapture: "Screenshot",
  virtualRecording: "Virtual recording",
  composite: "Composite",
  compositeCapture: "Composite of captures",
  compositeSynthetic: "Composite with synthetic parts",
  dataDrivenMedia: "Data-driven media",
  humanEdits: "Edited by hand",
  minorHumanEdits: "Lightly edited by hand",
};

export function sourceTypeText(sourceType: string): string {
  return SOURCE_TYPES[sourceType] ?? sourceType;
}

function audioText(audio: NonNullable<ClipDetails["audio"]>): string {
  if (audio.channels === null) return audio.codec;
  return `${audio.codec}, ${countText(audio.channels, "channel")}`;
}

/** A clip's rows past its frame rate and codec, which its surfaces show beside its size. */
export function clipDetailRows(clip: ClipDetails): DetailRow[] {
  const rows: DetailRow[] = [];
  if (clip.bitDepth !== null) rows.push({ label: "Bit depth", value: bitDepthText(clip.bitDepth) });
  rows.push({ label: "Dynamic range", value: clip.hdr ? DYNAMIC_RANGES[clip.hdr] : "SDR" });
  if (clip.alpha) rows.push({ label: "Alpha", value: "Yes" });
  rows.push({ label: "Audio", value: clip.audio ? audioText(clip.audio) : "None" });
  if (clip.startTimecode !== null) rows.push({ label: "Start timecode", value: clip.startTimecode });
  return rows;
}

export function pictureDetailRows(picture: Pick<PictureDetails, "sourceType">): DetailRow[] {
  return picture.sourceType === null ? [] : [{ label: "Source", value: sourceTypeText(picture.sourceType) }];
}
