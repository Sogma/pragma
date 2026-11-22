import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readDigitalSourceType, sourceTypeIn } from "../../src/server/digitalSourceType.ts";
import { countingReader } from "../support/countingReader.ts";

const AI = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

// The packet Midjourney writes: the code as an attribute, under its own prefix.
const xmp = (type = AI) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:iptcExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ` +
  `iptcExt:DigImageGUID="e2310561" iptcExt:DigitalSourceType="${type}"/></rdf:RDF></x:xmpmeta>`;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

const keyword = Buffer.from("XML:com.adobe.xmp\0", "latin1");
const ihdr = chunk("IHDR", Buffer.alloc(13));
const idat = chunk("IDAT", Buffer.alloc(40_000));
const iend = chunk("IEND", Buffer.alloc(0));
const png = (...chunks: Buffer[]) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), ...chunks]);

function itxt(text: string, compressed = false): Buffer {
  const body = compressed ? deflateSync(Buffer.from(text)) : Buffer.from(text);
  return chunk("iTXt", Buffer.concat([keyword, Buffer.from([compressed ? 1 : 0, 0, 0, 0]), body]));
}

function jpeg(packet: string): Buffer {
  const app1 = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(packet)]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(app1.length + 2);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, app1, sos, Buffer.alloc(40_000)]);
}

function webp(packet: string | undefined): Buffer {
  const riffChunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
  };
  const flags = Buffer.alloc(10);
  flags[0] = packet === undefined ? 0 : 0x04;
  const body = Buffer.concat([
    riffChunk("VP8X", flags),
    riffChunk("VP8 ", Buffer.alloc(40_000)),
    ...(packet === undefined ? [] : [riffChunk("XMP ", Buffer.from(packet))]),
  ]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

const read = (bytes: Buffer) => readDigitalSourceType(countingReader(bytes), bytes.length);

describe("sourceTypeIn", () => {
  it("finds the code as an attribute, an element, or an element's resource, by any prefix", () => {
    expect(sourceTypeIn(xmp())).toBe("trainedAlgorithmicMedia");
    expect(sourceTypeIn(`<Iptc4xmpExt:DigitalSourceType>${AI}</Iptc4xmpExt:DigitalSourceType>`)).toBe(
      "trainedAlgorithmicMedia",
    );
    expect(
      sourceTypeIn(
        `<x:DigitalSourceType rdf:resource="https://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"/>`,
      ),
    ).toBe("digitalCapture");
    expect(sourceTypeIn(xmp("compositeWithTrainedAlgorithmicMedia"))).toBe("compositeWithTrainedAlgorithmicMedia");
  });

  it("gives null for a packet naming none, or a value that is no code", () => {
    expect(sourceTypeIn("<x:xmpmeta/>")).toBeNull();
    expect(sourceTypeIn(xmp("made by <a model>"))).toBeNull();
  });
});

describe("readDigitalSourceType", () => {
  it("reads a PNG's packet from a text chunk, compressed or not, without the picture data", async () => {
    expect(await read(png(ihdr, chunk("tEXt", Buffer.concat([keyword, Buffer.from(xmp())])), idat, iend))).toBe(
      "trainedAlgorithmicMedia",
    );
    expect(await read(png(ihdr, itxt(xmp("digitalCapture"), true), idat, iend))).toBe("digitalCapture");
    const bytes = png(ihdr, itxt(xmp()), idat, iend);
    const counted = countingReader(bytes);
    expect(await readDigitalSourceType(counted, bytes.length)).toBe("trainedAlgorithmicMedia");
    expect(counted.requested).toBeLessThan(2_000);
  });

  // The walk stops at the picture data, as a browser's would.
  it("leaves a PNG's packet behind its picture data unread", async () => {
    expect(await read(png(ihdr, idat, itxt(xmp()), iend))).toBeNull();
  });

  it("reads a JPEG's packet from its XMP segment, and a WebP's from its XMP chunk past the picture", async () => {
    expect(await read(jpeg(xmp()))).toBe("trainedAlgorithmicMedia");
    expect(await read(webp(xmp("digitalCapture")))).toBe("digitalCapture");
    expect(await read(webp(undefined))).toBeNull();
  });

  // Found as libjpeg finds a marker, past the fill bytes an encoder may pad
  // one with.
  it("reads a JPEG's packet past fill bytes before its segment", async () => {
    const bytes = jpeg(xmp());
    expect(await read(Buffer.concat([bytes.subarray(0, 2), Buffer.from([0xff, 0xff]), bytes.subarray(2)]))).toBe(
      "trainedAlgorithmicMedia",
    );
  });

  it("gives null for another type, a file that is no picture, or a packet that doesn't read", async () => {
    expect(await read(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00"))).toBeNull();
    expect(await read(Buffer.from("not a picture at all"))).toBeNull();
    expect(
      await read(
        png(ihdr, chunk("iTXt", Buffer.concat([keyword, Buffer.from([1, 0, 0, 0]), Buffer.from("not deflate")])), iend),
      ),
    ).toBeNull();
  });
});
