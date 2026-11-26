import { describe, expect, it } from "vitest";
import {
  DOCUMENT_FORMAT_MAJOR,
  emptyFieldValue,
  extensionForMediaType,
  FIELD_TYPES,
  FIELD_VALUE_TYPES,
  fileKindForPath,
  formatTimestamp,
  hasKnownKind,
  imageMediaTypeForPath,
  isFlowFile,
  isFountainFile,
  isLutFile,
  isMarkdownFile,
  isNewerFormatVersion,
  isScoreMax,
  isTableFile,
  mediaTypeForPath,
  newRowValue,
  notARasterImage,
  parseFieldValueType,
  parseTimestamp,
  pdfMediaTypeForPath,
  rasterImageMediaTypeForPath,
  rawFileTypeForPath,
  retypeField,
  scoreMax,
  scoreOf,
  splitDocumentName,
  type TableColumn,
  thumbnailKindForPath,
  VIDEO_EXTENSIONS,
  vectorImageMediaTypeForPath,
  videoMediaTypeForPath,
} from "../../src/protocol/types.ts";

describe("document kinds", () => {
  it("reads a kind's extension in any case, as entry names compare", () => {
    expect(isMarkdownFile("Notes.MD")).toBe(true);
    expect(isFountainFile("Pilot.Fountain")).toBe(true);
    expect(isTableFile("Budget.Table.HTML")).toBe(true);
    expect(isFlowFile("Grade.FLOW.html")).toBe(true);
    expect(hasKnownKind("Notes.MD")).toBe(true);
    expect(isMarkdownFile("Notes.mdx")).toBe(false);
  });

  it("names the kind a path is, its extension in any case, and none for a file of no kind", () => {
    const paths = [
      "Notes.MD",
      "Pilot.Fountain",
      "Budget.Table.HTML",
      "Cast.CLASS.html",
      "Grade.FLOW.html",
      "Clock.Applet.html",
      "Still.JPG",
      "Logo.SVG",
      "Take.MOV",
      "Script.PDF",
      "Print.CUBE",
      "archive.zip",
      "page.html",
    ];
    expect(paths.map((path) => fileKindForPath(path))).toEqual([
      "note",
      "screenplay",
      "table",
      "class",
      "flow",
      "applet",
      "image",
      "image",
      "video",
      "pdf",
      "lut",
      undefined,
      undefined,
    ]);
  });

  it("splits a compound extension whatever its case, keeping it as written", () => {
    expect(splitDocumentName("Budget.Table.HTML")).toEqual({ stem: "Budget", extension: ".Table.HTML" });
  });
});

// The extension is the only thing that decides, for video exactly as for
// images — the bytes are never sniffed.
describe("videoMediaTypeForPath", () => {
  it("maps each listed container to the type the route serves it as", () => {
    expect(videoMediaTypeForPath("takes/a.mp4")).toBe("video/mp4");
    expect(videoMediaTypeForPath("takes/a.m4v")).toBe("video/mp4");
    expect(videoMediaTypeForPath("takes/a.webm")).toBe("video/webm");
    expect(videoMediaTypeForPath("takes/a.mov")).toBe("video/quicktime");
  });

  // A camera writes .MOV and .MP4 as often as the lowercase spellings, the
  // same reason the image map is case-insensitive.
  it("ignores case", () => {
    expect(videoMediaTypeForPath("A_0004_C003.MOV")).toBe("video/quicktime");
    expect(videoMediaTypeForPath("A_0004_C003.Mp4")).toBe("video/mp4");
  });

  it("answers nothing for a format no browser would decode, or no extension at all", () => {
    for (const path of ["takes/a.mkv", "takes/a.avi", "takes/a.braw", "takes/a.png", "takes/a", "notes.md"]) {
      expect(videoMediaTypeForPath(path), path).toBeUndefined();
    }
  });

  // A dotted directory name is not the file's extension.
  it("only reads an extension that comes after the last slash", () => {
    expect(videoMediaTypeForPath("shots.mp4/take")).toBeUndefined();
    expect(videoMediaTypeForPath("shots.v2/take.mp4")).toBe("video/mp4");
  });
});

// What a generated or pasted file is named with is the first extension a
// table lists for its type, which the tables' order decides.
describe("extensionForMediaType", () => {
  it("names each type by the first extension listed for it", () => {
    const types = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "video/mp4",
      "video/quicktime",
    ];
    expect(types.map((type) => extensionForMediaType(type))).toEqual([
      "jpg",
      "png",
      "gif",
      "webp",
      "svg",
      "mp4",
      "mov",
    ]);
  });

  it("names a type only from the table it is given", () => {
    expect([
      extensionForMediaType("video/quicktime", VIDEO_EXTENSIONS),
      extensionForMediaType("image/png", VIDEO_EXTENSIONS),
    ]).toEqual(["mov", undefined]);
  });

  it("names nothing for a type no table lists", () => {
    expect([extensionForMediaType("audio/mpeg"), extensionForMediaType("image/avif")]).toEqual([undefined, undefined]);
  });
});

// The callers that mean an image specifically keep their own question. This
// one is for the surfaces that serve or list both.
describe("mediaTypeForPath", () => {
  it("answers for every kind, and keeps the narrower questions separate", () => {
    expect(mediaTypeForPath("cover.png")).toBe("image/png");
    expect(mediaTypeForPath("take.mp4")).toBe("video/mp4");
    expect(mediaTypeForPath("paper.pdf")).toBe("application/pdf");
    expect(mediaTypeForPath("notes.md")).toBeUndefined();

    // A video or a PDF must never pass for an image: a Load Image node, a
    // model's vision input and a markdown embed all ask a narrower question.
    expect(imageMediaTypeForPath("take.mp4")).toBeUndefined();
    expect(imageMediaTypeForPath("paper.pdf")).toBeUndefined();
    expect(videoMediaTypeForPath("cover.png")).toBeUndefined();
    expect(videoMediaTypeForPath("paper.pdf")).toBeUndefined();
  });
});

// A vector image is never a raster image: it has no pixels, so nothing
// that needs them takes one. The surfaces that only draw it take either.
describe("raster and vector images", () => {
  it("keeps an SVG out of the raster images and in the images", () => {
    expect(rasterImageMediaTypeForPath("art/logo.svg")).toBeUndefined();
    expect(rasterImageMediaTypeForPath("art/cover.png")).toBe("image/png");
    expect(vectorImageMediaTypeForPath("art/LOGO.SVG")).toBe("image/svg+xml");
    expect(vectorImageMediaTypeForPath("art/cover.png")).toBeUndefined();
    expect(imageMediaTypeForPath("art/logo.svg")).toBe("image/svg+xml");
    expect(imageMediaTypeForPath("art/cover.png")).toBe("image/png");
    expect(imageMediaTypeForPath("take.mp4")).toBeUndefined();
    expect(mediaTypeForPath("art/logo.svg")).toBe("image/svg+xml");
  });

  it("gives a raster image a thumbnail and a vector image none", () => {
    expect(thumbnailKindForPath("art/cover.png")).toBe("image");
    expect(thumbnailKindForPath("art/logo.svg")).toBeUndefined();
    expect(thumbnailKindForPath("take.mp4")).toBe("video");
  });

  it("names a vector image as one when refusing it as a raster image", () => {
    expect(notARasterImage("art/logo.svg")).toBe('"art/logo.svg" is a vector image, not a raster image');
    expect(notARasterImage("notes.md")).toBe('"notes.md" is not a raster image');
  });
});

describe("pdfMediaTypeForPath", () => {
  it("reads the extension in any case, and only the file's own", () => {
    expect(pdfMediaTypeForPath("refs/paper.pdf")).toBe("application/pdf");
    expect(pdfMediaTypeForPath("SCAN_0001.PDF")).toBe("application/pdf");
    expect(pdfMediaTypeForPath("refs.pdf/notes.md")).toBeUndefined();
    expect(pdfMediaTypeForPath("paper.pdf.md")).toBeUndefined();
  });
});

describe("LUTs", () => {
  it("reads a .cube in any case, and only the file's own extension", () => {
    expect(isLutFile("looks/Film Print.cube")).toBe(true);
    expect(isLutFile("LOOKS/REC709.CUBE")).toBe(true);
    expect(isLutFile("cube.cube/notes.md")).toBe(false);
    expect(isLutFile("print.cube.md")).toBe(false);
  });

  it("is a kind Pragma knows, neither a document nor media, served raw as plain text", () => {
    expect(hasKnownKind("looks/print.cube")).toBe(true);
    expect(mediaTypeForPath("looks/print.cube")).toBeUndefined();
    expect(rawFileTypeForPath("looks/print.cube")).toBe("text/plain");
    expect(rawFileTypeForPath("cover.png")).toBe("image/png");
    expect(rawFileTypeForPath("notes.md")).toBeUndefined();
  });
});

// The `data-type` fallback rule docs/protocol.md's Tables section states
// ("any other value reads as `text`"). Tested once here because the Table
// and Class readers share this one parser, so they cannot disagree about
// the vocabulary.
describe("parseFieldValueType", () => {
  it("accepts every type in the vocabulary", () => {
    for (const type of FIELD_VALUE_TYPES) expect(parseFieldValueType(type)).toBe(type);
    expect(parseFieldValueType("media")).toBe("media");
  });

  it("falls back to text for an unrecognized type", () => {
    expect(parseFieldValueType("richtext")).toBe("text");
    expect(parseFieldValueType("Checkbox")).toBe("text");
  });

  it("falls back to text for a missing or empty attribute", () => {
    expect(parseFieldValueType(null)).toBe("text");
    expect(parseFieldValueType(undefined)).toBe("text");
    expect(parseFieldValueType("")).toBe("text");
  });
});

// docs/protocol.md's Tables section: read leniently, written one way.
describe("timestamps", () => {
  const instant = (value: string) => parseTimestamp(value)?.toISOString();

  it("reads a date and time with Z or an offset as the instant it names", () => {
    expect(instant("2026-10-07T12:32:05Z")).toBe("2026-10-07T12:32:05.000Z");
    expect(instant("2026-10-07T14:32:05+02:00")).toBe("2026-10-07T12:32:05.000Z");
    expect(instant("2026-10-07T07:32-0500")).toBe("2026-10-07T12:32:00.000Z");
    expect(instant("2026-10-07 12:32:05.987z")).toBe("2026-10-07T12:32:05.000Z");
    expect(instant(" 2026-10-07t12:32:05Z ")).toBe("2026-10-07T12:32:05.000Z");
  });

  it("refuses a time with no zone, a date alone, and an impossible date rather than rolling it over", () => {
    for (const value of ["", "2026-10-07T12:32:05", "2026-10-07", "2026-02-30T10:00:00Z", "2026-10-07T24:00:00Z"]) {
      expect(parseTimestamp(value), value).toBeUndefined();
    }
    expect(parseTimestamp("2026-10-07T12:60:00Z")).toBeUndefined();
    expect(parseTimestamp("2026-10-07T12:00:00+24:00")).toBeUndefined();
    expect(instant("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z"); // a leap day is a date
  });

  it("writes UTC to the second, whatever zone or precision it was given", () => {
    expect(formatTimestamp(new Date("2026-10-07T14:32:05.987+02:00"))).toBe("2026-10-07T12:32:05Z");
    const written = formatTimestamp(new Date("2026-10-07T12:32:05Z"));
    expect(parseTimestamp(written)?.toISOString()).toBe("2026-10-07T12:32:05.000Z");
  });
});

// A Table's "+ Add", a Flow's Add Row and a column added to existing rows all
// start a cell here, so the three can't disagree.
describe("a field's starting value", () => {
  const now = new Date("2026-10-07T12:32:05Z");

  it("is a select's first option, an unticked checkbox, and blank otherwise", () => {
    expect(emptyFieldValue({ type: "select", options: ["Open", "Closed"] })).toBe("Open");
    expect(emptyFieldValue({ type: "checkbox" })).toBe("false");
    expect(emptyFieldValue({ type: "timestamp" })).toBe("");
    expect(emptyFieldValue({ type: "text" })).toBe("");
  });

  it("gives a new row the time it's added only where the column asks for it", () => {
    expect(newRowValue({ id: "a", label: "A", type: "timestamp", default: "now" }, now)).toBe("2026-10-07T12:32:05Z");
    expect(newRowValue({ id: "a", label: "A", type: "timestamp" }, now)).toBe("");
    expect(newRowValue({ id: "a", label: "A", type: "text", default: "now" }, now)).toBe("");
    expect(newRowValue({ id: "a", label: "A", type: "select", options: ["Open"] }, now)).toBe("Open");
  });
});

describe("scores", () => {
  it("reads marks up to the field's max, 5 where it names none, and blank or 0 as none", () => {
    expect(scoreMax({ type: "score" })).toBe(5);
    expect(scoreMax({ type: "score", max: 10 })).toBe(10);
    expect(scoreOf("3", { type: "score" })).toBe(3);
    expect(scoreOf(" 5 ", { type: "score" })).toBe(5);
    expect(scoreOf("", { type: "score" })).toBe(0);
    expect(scoreOf("0", { type: "score" })).toBe(0);
    expect(scoreOf("6", { type: "score" })).toBeUndefined();
    expect(scoreOf("6", { type: "score", max: 10 })).toBe(6);
  });

  it("reads -1 as rejected only where the field allows it, and anything else as no score", () => {
    expect(scoreOf("-1", { type: "score", reject: true })).toBe(-1);
    expect(scoreOf("-1", { type: "score" })).toBeUndefined();
    expect(scoreOf("-2", { type: "score", reject: true })).toBeUndefined();
    expect(scoreOf("4.5", { type: "score" })).toBeUndefined();
    expect(scoreOf("good", { type: "score" })).toBeUndefined();
  });

  it("takes a max that is a whole number from 1 to 10", () => {
    expect([1, 5, 10].every(isScoreMax)).toBe(true);
    expect([0, 11, 2.5, Number.NaN].some(isScoreMax)).toBe(false);
  });

  it("is a number in a Flow, blank in a new row", () => {
    expect(FIELD_TYPES.score.port).toBe("number");
    expect(emptyFieldValue({ type: "score" })).toBe("");
  });
});

describe("retypeField", () => {
  it("drops what only the old type had, keeping what the new one has", () => {
    const field: TableColumn = { id: "cover", type: "media", label: "Cover", mediaFolder: "covers", showName: true };
    retypeField(field, "select");
    expect(field).toEqual({ id: "cover", type: "select", label: "Cover" });
    const status: TableColumn = { id: "s", type: "select", label: "S", options: ["a"] };
    retypeField(status, "select");
    expect(status.options).toEqual(["a"]);
  });

  it("drops a type and attributes this build couldn't read", () => {
    const field: TableColumn = {
      id: "a",
      type: "text",
      label: "A",
      unknownType: "stars",
      unknownAttributes: [["data-min", "0"]],
    };
    retypeField(field, "integer");
    expect(field).toEqual({ id: "a", type: "integer", label: "A" });
  });

  it("keeps a score's max and reject only while it is a score", () => {
    const field: TableColumn = { id: "r", type: "score", label: "R", max: 10, reject: true };
    retypeField(field, "score");
    expect(field).toMatchObject({ max: 10, reject: true });
    retypeField(field, "integer");
    expect(field).toEqual({ id: "r", type: "integer", label: "R" });
  });
});

// docs/protocol.md's Versioning rule: majors only, and lenient about
// everything else — a document is locked for being from the future, never
// for having a version string nobody can parse.
describe("isNewerFormatVersion", () => {
  it("accepts every version at or below the major this build writes", () => {
    expect(isNewerFormatVersion("1.0")).toBe(false);
    expect(isNewerFormatVersion("1")).toBe(false);
    expect(isNewerFormatVersion("0.9")).toBe(false);
  });

  it("treats a newer minor as additive, not newer", () => {
    expect(isNewerFormatVersion(`${DOCUMENT_FORMAT_MAJOR}.7`)).toBe(false);
    expect(isNewerFormatVersion(`${DOCUMENT_FORMAT_MAJOR}.99.3`)).toBe(false);
  });

  it("flags a newer major", () => {
    expect(isNewerFormatVersion(`${DOCUMENT_FORMAT_MAJOR + 1}.0`)).toBe(true);
    expect(isNewerFormatVersion("47.2")).toBe(true);
  });

  it("does not flag a version it can't parse, rather than locking over a typo", () => {
    expect(isNewerFormatVersion("")).toBe(false);
    expect(isNewerFormatVersion("draft")).toBe(false);
    expect(isNewerFormatVersion("v2.0")).toBe(false);
  });
});
