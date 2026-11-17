import { describe, expect, it } from "vitest";
import {
  imageAttachRefusal,
  imageEmbedFor,
  isSpaceImageMediaType,
  pastedImageName,
} from "../../../web/core/imageAttach.ts";

describe("imageEmbedFor", () => {
  it("names a sibling image by its bare filename", () => {
    expect(imageEmbedFor("projects/kite/notes.md", "projects/kite/cover.png")).toBe("![cover](cover.png)");
  });

  it("hops up out of the document's folder for an image elsewhere", () => {
    expect(imageEmbedFor("projects/kite/notes.md", "assets/logo.png")).toBe("![logo](../../assets/logo.png)");
  });

  it("works from a document at the space root", () => {
    expect(imageEmbedFor("notes.md", "assets/logo.png")).toBe("![logo](assets/logo.png)");
  });

  // A bare `)` would close the Markdown destination early and leave the rest
  // of the reference as literal text in the document.
  it("percent-encodes spaces and parentheses in the destination", () => {
    expect(imageEmbedFor("notes.md", "sun (1).png")).toBe("![sun (1)](sun%20%281%29.png)");
  });

  // An unescaped `]` closes the alt text early, which breaks the embed the
  // same way — and the alt text is what reading view shows when the file is
  // missing, so it can't just be dropped either.
  it("escapes brackets in the alt text", () => {
    expect(imageEmbedFor("notes.md", "shot [2].png")).toBe("![shot \\[2\\]](shot%20%5B2%5D.png)");
  });
});

describe("imageEmbedFor a library image", () => {
  it("names the file outright from a space document", () => {
    expect(imageEmbedFor("blog/post.md", "lib:footage/stills/hero.png")).toBe("![hero](lib:footage/stills/hero.png)");
  });

  it("stays relative inside a library document", () => {
    expect(imageEmbedFor("lib:footage/notes/a.md", "lib:footage/stills/hero.png")).toBe("![hero](../stills/hero.png)");
  });

  it("gives nothing for a library document naming a space image", () => {
    expect(imageEmbedFor("lib:footage/a.md", "art/hero.png")).toBeUndefined();
  });
});

describe("pastedImageName", () => {
  it("mints a timestamped name with the extension for the media type", () => {
    expect(pastedImageName("image/png")).toMatch(/^Pasted image \d{8}-\d{6}\.png$/);
    expect(pastedImageName("image/jpeg")).toMatch(/^Pasted image \d{8}-\d{6}\.jpg$/);
  });

  // The clipboard can report a type pragma has no extension for; the name
  // still has to be writable rather than ending in "undefined".
  it("falls back to .png for an unrecognized media type", () => {
    expect(pastedImageName("image/heic")).toMatch(/\.png$/);
  });
});

describe("imageAttachRefusal", () => {
  it("accepts an image within the size cap", () => {
    expect(imageAttachRefusal("cover.png", 1024)).toBeUndefined();
    expect(imageAttachRefusal("CAMERA.JPG", 1024)).toBeUndefined();
  });

  it("refuses a file that isn't an image", () => {
    expect(imageAttachRefusal("archive.zip", 1024)).toMatch(/isn't an image/);
  });

  // No size ceiling: the route streams to disk, so nothing here has to
  // protect the server's memory from a large file.
  it("refuses an empty file, and nothing for being large", () => {
    expect(imageAttachRefusal("cover.png", 0)).toMatch(/empty/);
    expect(imageAttachRefusal("cover.png", 4 * 1024 * 1024 * 1024)).toBeUndefined();
  });
});

describe("isSpaceImageMediaType", () => {
  it("covers what the space can hold, not just what a model accepts", () => {
    expect(isSpaceImageMediaType("image/png")).toBe(true);
    expect(isSpaceImageMediaType("image/svg+xml")).toBe(true);
    expect(isSpaceImageMediaType("application/pdf")).toBe(false);
    expect(isSpaceImageMediaType("")).toBe(false);
  });
});
