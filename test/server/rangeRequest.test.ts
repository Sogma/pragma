import { describe, expect, it } from "vitest";
import { parseByteRange } from "../../src/server/rangeRequest.ts";

// The three outcomes are deliberately distinct, and the distinction is the
// whole point of the function: undefined means "send the whole file", null
// means "refuse with a 416", and a range means "send exactly this window".
describe("parseByteRange", () => {
  const SIZE = 100;

  it("asks for the whole file when no range was sent", () => {
    expect(parseByteRange(undefined, SIZE)).toBeUndefined();
  });

  it("reads a closed range inclusively at both ends, as the header means it", () => {
    expect(parseByteRange("bytes=0-9", SIZE)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=10-10", SIZE)).toEqual({ start: 10, end: 10 });
    expect(parseByteRange(" bytes=5-15 ", SIZE)).toEqual({ start: 5, end: 15 });
  });

  it("runs an open end to the last byte", () => {
    expect(parseByteRange("bytes=40-", SIZE)).toEqual({ start: 40, end: 99 });
    expect(parseByteRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 99 });
  });

  // How a player finds an MP4's index, which sits at the end of the file:
  // it asks for the last few kilobytes before it knows anything else.
  it("reads a suffix range as the last N bytes", () => {
    expect(parseByteRange("bytes=-10", SIZE)).toEqual({ start: 90, end: 99 });
  });

  it("clamps a range that runs past the end instead of refusing it", () => {
    expect(parseByteRange("bytes=90-500", SIZE)).toEqual({ start: 90, end: 99 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseByteRange("bytes=-500", SIZE)).toEqual({ start: 0, end: 99 });
  });

  // The one case that owes a 416. Answering it with the whole file is how a
  // player ends up decoding bytes it did not ask for.
  it("refuses a range that starts past the end, or runs backwards", () => {
    expect(parseByteRange("bytes=100-", SIZE)).toBeNull();
    expect(parseByteRange("bytes=500-600", SIZE)).toBeNull();
    expect(parseByteRange("bytes=20-10", SIZE)).toBeNull();
    expect(parseByteRange("bytes=-0", SIZE)).toBeNull();
  });

  // An empty file has no byte to name, so every range over it is
  // unsatisfiable rather than an empty success.
  it("refuses any range over an empty file", () => {
    expect(parseByteRange("bytes=0-", 0)).toBeNull();
    expect(parseByteRange("bytes=-10", 0)).toBeNull();
    expect(parseByteRange(undefined, 0)).toBeUndefined();
  });

  // A range this server does not understand is answered with the whole
  // file, which is what the spec asks for — not a 416, which would strand a
  // client whose request was legal.
  it("falls back to the whole file for a range it doesn't understand", () => {
    for (const header of ["bytes=0-9, 20-29", "items=0-9", "bytes=abc", "bytes=-", "", "bytes=0-9;q=1"]) {
      expect(parseByteRange(header, SIZE), header).toBeUndefined();
    }
  });
});
