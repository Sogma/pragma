import { describe, expect, it } from "vitest";
import { createFormats, PLAIN_TEXT, type TextFormat } from "../../../web/services/formats.ts";

function format(): TextFormat {
  return { extensions: () => [], links: () => ({ found: [], missing: [] }), embedsImages: false };
}

describe("createFormats", () => {
  it("answers each document type with its format, and plain text where none is registered", () => {
    const formats = createFormats();
    const markdown = format();
    formats.register("note", markdown);

    expect(formats.get("note")).toBe(markdown);
    expect(formats.get("screenplay")).toBe(PLAIN_TEXT);
  });

  it("rejects a second format for the same document type", () => {
    const formats = createFormats();
    formats.register("note", format());

    expect(() => formats.register("note", format())).toThrow(/already registered/);
  });

  it("disposing a registration removes it, and only it", () => {
    const formats = createFormats();
    const note = formats.register("note", format());
    const screenplay = format();
    formats.register("screenplay", screenplay);

    note.dispose();

    expect(formats.get("note")).toBe(PLAIN_TEXT);
    expect(formats.get("screenplay")).toBe(screenplay);
    expect(() => formats.register("note", format())).not.toThrow();
  });
});
