import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeAssetsFolder,
  parentIndexPath,
  readSiteFile,
  resolveSiteForPath,
  writeSiteAssetsFolder,
} from "../../src/server/sites.ts";

// Site resolution over a real directory, since both resolvers read
// `_site.json` and ancestor `index.md` frontmatter off disk.
const spaces: string[] = [];

afterEach(async () => {
  await Promise.all(spaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function space(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pragma-sites-test-"));
  spaces.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const siteFile = (name: string) => JSON.stringify({ id: `ste_${name}`, slug: name, name });

describe("resolving which site a document belongs to", () => {
  it("finds the site a document sits directly inside", async () => {
    const root = await space({ "my-blog/_site.json": siteFile("my-blog"), "my-blog/about.md": "# About\n" });

    expect(resolveSiteForPath(root, "my-blog/about.md")).toMatchObject({ siteDir: "my-blog" });
  });

  it("finds it from any depth under the site", async () => {
    const root = await space({
      "my-blog/_site.json": siteFile("my-blog"),
      "my-blog/posts/2026/first.md": "# First\n",
    });

    expect(resolveSiteForPath(root, "my-blog/posts/2026/first.md")).toMatchObject({ siteDir: "my-blog" });
  });

  it("resolves a site at the space root", async () => {
    const root = await space({ "_site.json": siteFile("root"), "about.md": "# About\n" });

    expect(resolveSiteForPath(root, "about.md")).toMatchObject({ siteDir: "" });
  });

  it("picks the nearest site when one is nested in another", async () => {
    const root = await space({
      "outer/_site.json": siteFile("outer"),
      "outer/inner/_site.json": siteFile("inner"),
      "outer/inner/about.md": "# About\n",
    });

    expect(resolveSiteForPath(root, "outer/inner/about.md")).toMatchObject({ siteDir: "outer/inner" });
  });

  it("resolves nothing for a document outside every site", async () => {
    const root = await space({ "my-blog/_site.json": siteFile("my-blog"), "notes/draft.md": "# Draft\n" });

    expect(resolveSiteForPath(root, "notes/draft.md")).toBeUndefined();
  });

  it("resolves nothing for a document one level above the site", async () => {
    const root = await space({ "my-blog/_site.json": siteFile("my-blog"), "outline.md": "# Outline\n" });

    expect(resolveSiteForPath(root, "outline.md")).toBeUndefined();
  });
});

describe("resolving a document's parent section", () => {
  it("gives a document directly under the site root no parent", () => {
    // The trap the site-root check exists for: taking the home page as
    // parent would publish this at /index/about.
    expect(parentIndexPath("my-blog/about.md", "my-blog")).toBeUndefined();
  });

  it("gives a top-level section's own index.md no parent", () => {
    expect(parentIndexPath("my-blog/posts/index.md", "my-blog")).toBeUndefined();
  });

  it("gives a leaf its own folder's index.md", () => {
    expect(parentIndexPath("my-blog/posts/first.md", "my-blog")).toBe("my-blog/posts/index.md");
  });

  it("sends a section's own index.md one level further up", () => {
    expect(parentIndexPath("my-blog/posts/2026/index.md", "my-blog")).toBe("my-blog/posts/index.md");
  });

  it("treats the space root as the site root when the site sits there", () => {
    // siteDir is "" here while path.dirname bottoms out at "." — both are
    // the site root, so neither of these is a section.
    expect(parentIndexPath("about.md", "")).toBeUndefined();
    expect(parentIndexPath("posts/index.md", "")).toBeUndefined();
    expect(parentIndexPath("posts/first.md", "")).toBe("posts/index.md");
  });
});

describe("a site's assets folder", () => {
  it("normalizes what was typed into a site-relative path", () => {
    expect(normalizeAssetsFolder(" /media\\images/ ")).toEqual({ ok: true, folder: "media/images" });
    expect(normalizeAssetsFolder("  ")).toEqual({ ok: true, folder: "" });
  });

  it("refuses a folder above the site or a hidden one", () => {
    expect(normalizeAssetsFolder("../shared").ok).toBe(false);
    expect(normalizeAssetsFolder("media/.cache").ok).toBe(false);
  });

  it("is written into _site.json beside the other keys, and the folder created", async () => {
    const root = await space({ "my-blog/_site.json": siteFile("my-blog") });
    const siteDir = path.join(root, "my-blog");

    await writeSiteAssetsFolder(siteDir, "media/images");
    expect(readSiteFile(siteDir)).toMatchObject({ id: "ste_my-blog", assetsFolder: "media/images" });
    expect((await stat(path.join(siteDir, "media/images"))).isDirectory()).toBe(true);

    await writeSiteAssetsFolder(siteDir, "");
    expect(JSON.parse(await readFile(path.join(siteDir, "_site.json"), "utf8"))).not.toHaveProperty("assetsFolder");
  });
});
