import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPublishImages,
  describeImageNotes,
  type PublishImage,
  rewriteImageEmbeds,
} from "../../src/server/publishAssets.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";

// Collecting reads real bytes off disk, so every case needs a real space.
// A one-pixel PNG, and a second that differs only in its trailing byte, so
// two files can be told apart by content rather than by name.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7d4c3c40000000049454e44ae426082",
  "hex",
);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0x00])]);

async function space(files: Record<string, string | Buffer>): Promise<string> {
  const root = tempDir("pragma-publish-assets-");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function collect(root: string, docPath: string, siteDir: string, markdown: string) {
  const result = await collectPublishImages(root, docPath, siteDir, markdown);
  if (!result.ok) throw new Error(`expected collecting to succeed: ${result.message}`);
  return result;
}

/** Stands in for what a service would have us write, one entry per digest. */
function referencesFor(images: PublishImage[]): Map<string, string> {
  return new Map(images.map((image, index) => [image.sha256, `asset:pub${index}`]));
}

describe("collecting the images a publish has to upload", () => {
  it("resolves an embed beside the document", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });

    const { images } = await collect(root, "blog/post.md", "blog", "![Hero](hero.png)");

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ spacePath: "blog/hero.png", filename: "hero.png", mimeType: "image/png" });
  });

  it("resolves an embed that climbs out of the document's folder", async () => {
    const root = await space({ "blog/posts/one.md": "", "blog/hero.png": PNG });

    const { images } = await collect(root, "blog/posts/one.md", "blog", "![Hero](../hero.png)");

    expect(images[0].spacePath).toBe("blog/hero.png");
  });

  it("uploads one file for repeated embeds of the same image", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });

    const { images } = await collect(root, "blog/post.md", "blog", "![One](hero.png)\n\n![Two](hero.png)");

    expect(images).toHaveLength(1);
    expect(images[0].references).toHaveLength(2);
  });

  it("uploads one file for two paths holding identical bytes", async () => {
    const root = await space({ "blog/post.md": "", "blog/a.png": PNG, "blog/b.png": PNG });

    const { images } = await collect(root, "blog/post.md", "blog", "![A](a.png) ![B](b.png)");

    expect(images).toHaveLength(1);
  });

  it("keeps files whose bytes differ apart", async () => {
    const root = await space({ "blog/post.md": "", "blog/a.png": PNG, "blog/b.png": OTHER_PNG });

    const { images } = await collect(root, "blog/post.md", "blog", "![A](a.png) ![B](b.png)");

    expect(images).toHaveLength(2);
  });

  it("leaves a link alone, however much it looks like an image", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });

    const { images, skipped } = await collect(root, "blog/post.md", "blog", "[Hero](hero.png)");

    expect(images).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("passes over an image that is already on the web", async () => {
    const root = await space({ "blog/post.md": "" });

    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![R](https://example.com/x.png)");

    expect(images).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("uploads an embed naming a library file, and marks it outside the site", async () => {
    const root = await space({ "blog/post.md": "" });
    const library = await space({ "stills/hero.png": PNG });
    const configDir = await space({});
    giveSpaceLibraries(configDir, root, [{ id: "shots", label: "Shots", path: library, access: "read-only" }]);
    isolateConfig(configDir);
    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![L](lib:shots/stills/hero.png)");

    expect(skipped).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      spacePath: "lib:shots/stills/hero.png",
      filename: "hero.png",
      outsideSite: true,
    });
  });

  it("reports an embed naming a library the space hasn't got rather than resolving it against the space", async () => {
    const root = await space({ "blog/post.md": "", "lib:shots/hero.png": PNG });
    const configDir = await space({});
    isolateConfig(configDir);
    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![L](lib:shots/hero.png)");

    expect(images).toEqual([]);
    expect(skipped).toEqual([{ raw: "lib:shots/hero.png", reason: 'No library "shots" is located in this space' }]);
  });

  it("reports an embed with a scheme pragma doesn't define", async () => {
    const root = await space({ "blog/post.md": "" });

    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![D](data:image/png;base64,AAAA)");

    expect(images).toEqual([]);
    expect(skipped).toEqual([{ raw: "data:image/png;base64,AAAA", reason: "not a file in this space or a library" }]);
  });

  it("carries an SVG as an image", async () => {
    const root = await space({ "blog/post.md": "", "blog/logo.svg": "<svg/>" });

    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![L](logo.svg)");

    expect(images.map((image) => image.mimeType)).toEqual(["image/svg+xml"]);
    expect(skipped).toEqual([]);
  });

  it("reports a missing file and leaves the rest of the page publishable", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });

    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![Gone](gone.png) ![Hero](hero.png)");

    expect(images).toHaveLength(1);
    expect(skipped[0]).toEqual({ raw: "gone.png", reason: "the file is missing" });
  });

  it("refuses the whole publish when one image is over the image limit", async () => {
    const root = await space({ "blog/post.md": "", "blog/huge.png": Buffer.alloc(10 * 1024 * 1024 + 1) });

    const result = await collectPublishImages(root, "blog/post.md", "blog", "![H](huge.png)");

    expect(result.ok).toBe(false);
    // Names the file, its size and the ceiling. The size rounds up, so a
    // file a byte over never prints the same number as the limit it broke.
    if (!result.ok) {
      expect(result.message).toBe('"blog/huge.png" is 10.1 MB, over the 10 MB the publisher accepts for images.');
    }
  });

  it("accepts an image just under the limit", async () => {
    const root = await space({ "blog/post.md": "", "blog/big.png": Buffer.alloc(10 * 1024 * 1024) });

    const { images } = await collect(root, "blog/post.md", "blog", "![B](big.png)");

    expect(images).toHaveLength(1);
  });

  it("marks an image that lives outside the site folder", async () => {
    const root = await space({ "blog/post.md": "", "media/hero.png": PNG });

    const { images } = await collect(root, "blog/post.md", "blog", "![Hero](../media/hero.png)");

    expect(images[0]).toMatchObject({ spacePath: "media/hero.png", outsideSite: true });
  });

  it("counts nothing as outside when the site is the space root", async () => {
    const root = await space({ "post.md": "", "media/hero.png": PNG });

    const { images } = await collect(root, "post.md", "", "![Hero](media/hero.png)");

    expect(images[0].outsideSite).toBe(false);
  });
});

describe("rewriting the body that gets sent", () => {
  it("swaps an embed's destination for the file's reference", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });
    const markdown = "Before\n\n![Hero](hero.png)\n\nAfter";
    const { images } = await collect(root, "blog/post.md", "blog", markdown);

    expect(rewriteImageEmbeds(markdown, images, referencesFor(images))).toBe("Before\n\n![Hero](asset:pub0)\n\nAfter");
  });

  it("keeps the alt text and rewrites every embed of one image", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });
    const markdown = "![First](hero.png)\n\n![Second](hero.png)";
    const { images } = await collect(root, "blog/post.md", "blog", markdown);

    expect(rewriteImageEmbeds(markdown, images, referencesFor(images))).toBe(
      "![First](asset:pub0)\n\n![Second](asset:pub0)",
    );
  });

  it("leaves a link to the same file untouched", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });
    const markdown = "![Hero](hero.png) and [the file](hero.png)";
    const { images } = await collect(root, "blog/post.md", "blog", markdown);

    expect(rewriteImageEmbeds(markdown, images, referencesFor(images))).toBe(
      "![Hero](asset:pub0) and [the file](hero.png)",
    );
  });

  it("leaves the brackets in place around an angle-bracketed destination", async () => {
    const root = await space({ "blog/post.md": "", "blog/my file.png": PNG });
    const markdown = "![Hero](<my file.png>)";
    const { images } = await collect(root, "blog/post.md", "blog", markdown);

    expect(rewriteImageEmbeds(markdown, images, referencesFor(images))).toBe("![Hero](<asset:pub0>)");
  });

  it("leaves an embed as written when its upload produced no reference", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });
    const markdown = "![Hero](hero.png)";
    const { images } = await collect(root, "blog/post.md", "blog", markdown);

    expect(rewriteImageEmbeds(markdown, images, new Map())).toBe(markdown);
  });
});

describe("what the publish reports back", () => {
  it("warns about an embed it left alone and notes one sent from outside", async () => {
    const root = await space({ "blog/post.md": "", "media/hero.png": PNG });
    const markdown = "![Gone](gone.png)\n\n![Hero](../media/hero.png)";
    const { images, skipped } = await collect(root, "blog/post.md", "blog", markdown);

    expect(describeImageNotes(images, skipped)).toEqual([
      { level: "warn", text: 'Left "gone.png" as written: the file is missing.' },
      { level: "info", text: "Published 1 image from outside the site folder: media/hero.png." },
    ]);
  });

  it("says nothing about a page whose images are all its own", async () => {
    const root = await space({ "blog/post.md": "", "blog/hero.png": PNG });
    const { images, skipped } = await collect(root, "blog/post.md", "blog", "![Hero](hero.png)");

    expect(describeImageNotes(images, skipped)).toEqual([]);
  });
});
