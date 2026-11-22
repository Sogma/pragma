import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetPendingPaths,
  movePendingPaths,
  normalizeAssetsFolder,
  parentIndexPath,
  queuePendingDeletes,
  readSiteFile,
  resolveSiteForPath,
  updateSiteFile,
} from "../../src/server/sites.ts";
import { canLockFolders, lockedFolder } from "../support/lockedFolder.ts";

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
const queue = (entries: object[]) => JSON.stringify(entries);
const queueIn = async (root: string, siteDir: string) =>
  JSON.parse(await readFile(path.join(root, siteDir, "_queue.json"), "utf8"));

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

    await updateSiteFile(siteDir, { assetsFolder: "media/images" });
    expect(readSiteFile(siteDir)).toMatchObject({ id: "ste_my-blog", assetsFolder: "media/images" });
    expect((await stat(path.join(siteDir, "media/images"))).isDirectory()).toBe(true);

    await updateSiteFile(siteDir, { assetsFolder: "" });
    expect(JSON.parse(await readFile(path.join(siteDir, "_site.json"), "utf8"))).not.toHaveProperty("assetsFolder");
  });
});

describe("a site's name in _site.json", () => {
  it("is rewritten alone, every other key kept as written", async () => {
    const before = {
      id: "ste_1",
      slug: "my-blog",
      name: "Old",
      assetsFolder: "media",
      publisherId: "sogma",
      later: { kept: true },
    };
    const root = await space({ "my-blog/_site.json": JSON.stringify(before) });

    await updateSiteFile(path.join(root, "my-blog"), { name: "New" });

    expect(JSON.parse(await readFile(path.join(root, "my-blog/_site.json"), "utf8"))).toEqual({
      ...before,
      name: "New",
    });
  });
});

describe("a queued path following a move", () => {
  async function move(root: string, from: string, to: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, to)), { recursive: true });
    await rename(path.join(root, from), path.join(root, to));
    await movePendingPaths(root, from, to);
  }

  it("follows a renamed site folder, in order, leaving id entries as they are", async () => {
    const root = await space({
      "old-name/_site.json": siteFile("old-name"),
      "old-name/draft.md": "# Draft\n",
      "old-name/posts/new.md": "# New\n",
      "old-name/_queue.json": queue([
        { op: "publish", path: "old-name/draft.md" },
        { op: "publish", id: "doc_1" },
        { op: "publish", path: "old-name/posts/new.md" },
      ]),
    });

    await move(root, "old-name", "new-name");

    expect(await queueIn(root, "new-name")).toEqual([
      { op: "publish", path: "new-name/draft.md" },
      { op: "publish", id: "doc_1" },
      { op: "publish", path: "new-name/posts/new.md" },
    ]);
  });

  it("follows a folder moved inside its site, and only what was under it", async () => {
    const root = await space({
      "blog/_site.json": siteFile("blog"),
      "blog/posts/x.md": "# X\n",
      "blog/posts-2/y.md": "# Y\n",
      "blog/_queue.json": queue([
        { op: "publish", path: "blog/posts/x.md" },
        { op: "publish", path: "blog/posts-2/y.md" },
      ]),
    });

    await move(root, "blog/posts", "blog/archive");

    expect(await queueIn(root, "blog")).toEqual([
      { op: "publish", path: "blog/archive/x.md" },
      { op: "publish", path: "blog/posts-2/y.md" },
    ]);
  });

  it("carries a draft moved into another site over to that site's queue", async () => {
    const root = await space({
      "a/_site.json": siteFile("a"),
      "b/_site.json": siteFile("b"),
      "a/d.md": "# D\n",
      "a/_queue.json": queue([{ op: "publish", path: "a/d.md" }]),
    });

    await move(root, "a/d.md", "b/d.md");

    expect(existsSync(path.join(root, "a/_queue.json"))).toBe(false);
    expect(await queueIn(root, "b")).toEqual([{ op: "publish", path: "b/d.md" }]);
  });

  it("drops a draft moved out of every site", async () => {
    const root = await space({
      "a/_site.json": siteFile("a"),
      "a/d.md": "# D\n",
      "a/_queue.json": queue([
        { op: "publish", path: "a/d.md" },
        { op: "publish", id: "doc_1" },
      ]),
    });

    await move(root, "a/d.md", "notes/d.md");

    expect(await queueIn(root, "a")).toEqual([{ op: "publish", id: "doc_1" }]);
  });

  it("follows a site carried inside a moved folder", async () => {
    const root = await space({
      "projects/blog/_site.json": siteFile("blog"),
      "projects/blog/d.md": "# D\n",
      "projects/blog/_queue.json": queue([{ op: "publish", path: "projects/blog/d.md" }]),
    });

    await move(root, "projects", "work");

    expect(await queueIn(root, "work/blog")).toEqual([{ op: "publish", path: "work/blog/d.md" }]);
  });

  it("keeps one entry when a rename lands on a path a stale entry names", async () => {
    const root = await space({
      "s/_site.json": siteFile("s"),
      "s/a.md": "# A\n",
      "s/_queue.json": queue([
        { op: "publish", path: "s/b.md" },
        { op: "publish", path: "s/a.md" },
      ]),
    });

    await move(root, "s/a.md", "s/b.md");

    expect(await queueIn(root, "s")).toEqual([{ op: "publish", path: "s/b.md" }]);
  });
});

describe("unpublishing a deleted folder's notes", () => {
  // Queueing never blocks a delete, so a folder it can't read costs only the
  // notes inside it.
  it.skipIf(!canLockFolders)("queues every note it can read, passing over a folder it can't", async () => {
    const root = await space({
      "s/_site.json": siteFile("s"),
      "s/posts/a.md": "---\nid: doc_a\n---\n# A\n",
      "s/posts/locked/b.md": "---\nid: doc_b\n---\n# B\n",
    });
    const queued = await lockedFolder(path.join(root, "s/posts/locked"), () =>
      queuePendingDeletes(root, path.join(root, "s/posts")),
    );
    expect(queued).toEqual([{ siteDir: "s", id: "doc_a", publisherId: undefined }]);
    expect(await queueIn(root, "s")).toEqual([{ op: "delete", id: "doc_a" }]);
  });
});

describe("a queued path whose page was deleted", () => {
  it("goes, with those under a deleted folder, and nothing else", async () => {
    const root = await space({
      "s/_site.json": siteFile("s"),
      "s/posts/x.md": "# X\n",
      "s/posts-2/y.md": "# Y\n",
      "s/_queue.json": queue([
        { op: "publish", path: "s/posts/x.md" },
        { op: "publish", path: "s/posts-2/y.md" },
        { op: "publish", id: "doc_1" },
      ]),
    });

    await rm(path.join(root, "s/posts"), { recursive: true });
    forgetPendingPaths(root, "s/posts");

    expect(await queueIn(root, "s")).toEqual([
      { op: "publish", path: "s/posts-2/y.md" },
      { op: "publish", id: "doc_1" },
    ]);
  });

  it("takes the queue file along with its last entry", async () => {
    const root = await space({
      "s/_site.json": siteFile("s"),
      "s/draft.md": "# Draft\n",
      "s/_queue.json": queue([{ op: "publish", path: "s/draft.md" }]),
    });

    await rm(path.join(root, "s/draft.md"));
    forgetPendingPaths(root, "s/draft.md");

    expect(existsSync(path.join(root, "s/_queue.json"))).toBe(false);
  });
});
