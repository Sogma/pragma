import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublisherConnection } from "../../src/protocol/publisher.ts";
import { runPublish } from "../../src/server/publishHandler.ts";
import { revisionOf } from "../../src/server/spaceFiles.ts";

// The whole publish, end to end, against a stand-in for the service: images
// staged and uploaded, the body rewritten to what came back, the file on disk
// left alone. Driven through a publisher this test builds itself, so it can
// never reach a real endpoint configured on the machine running it.

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7d4c3c40000000049454e44ae426082",
  "hex",
);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0x00])]);

interface StagedFile {
  id: string;
  publicId: string;
  filename: string;
  sha256?: string;
  bytes?: Buffer;
}

interface Stub {
  server: Server;
  baseUrl: string;
  staged: StagedFile[];
  documents: Array<Record<string, unknown>>;
  /** How many times bytes actually crossed the wire. */
  uploads: number;
  /** Set to make the next stage call fail, standing in for a service whose
   * limits have moved past what this client believes them to be. */
  rejectStage?: { status: number; code: string; message: string; limitBytes?: number };
  /** Runs before the service answers a document create or update — the
   * window in which an editor save can land on the file being published. */
  beforeDocumentAnswer?: () => Promise<void>;
}

// Deduplicates the way the real service does: a staged digest matching a
// file whose bytes already arrived comes back with no upload target.
async function startStub(): Promise<Stub> {
  const staged: StagedFile[] = [];
  const documents: Array<Record<string, unknown>> = [];
  const stub = { staged, documents, uploads: 0 } as Stub;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://stub");
      const raw = Buffer.concat(chunks);
      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      // The real service rejects unknown fields with 400 instead of dropping
      // them, so a body still carrying the retired `markdown` field is
      // refused here the same way it would be there.
      const acceptsDocumentBody = (body: Record<string, unknown>): boolean => {
        if (typeof body.content === "string" && !("markdown" in body)) return true;
        json(400, { error: { code: "malformed_request", message: "content is required; markdown is not a field" } });
        return false;
      };

      // Stage: reserve a file and hand back where to PUT it.
      if (request.method === "POST" && url.pathname === "/v1/files") {
        if (stub.rejectStage) {
          const { status, code, message, limitBytes } = stub.rejectStage;
          return json(status, { error: { code, message, ...(limitBytes ? { limit_bytes: limitBytes } : {}) } });
        }
        const body = JSON.parse(raw.toString()) as { filename: string; sha256?: string };

        // Only a file whose bytes actually landed can be matched.
        const hit = staged.find((entry) => body.sha256 && entry.sha256 === body.sha256 && entry.bytes);
        if (hit) {
          json(200, {
            id: hit.id,
            public_id: hit.publicId,
            status: "ready",
            sha256: hit.sha256,
            url: `https://cdn.sogma.example/${hit.publicId}/${hit.filename}`,
          });
          return;
        }

        const id = `fle_${staged.length}`;
        const publicId = `pub${staged.length}`;
        staged.push({ id, publicId, filename: body.filename, sha256: body.sha256 });
        json(201, {
          id,
          public_id: publicId,
          status: "pending",
          url: null,
          upload: {
            url: `${stub.baseUrl}/upload/${id}`,
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            expires_at: "2099-01-01T00:00:00Z",
          },
        });
        return;
      }

      // The bytes themselves, which in the real service go to storage.
      if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
        const id = url.pathname.slice("/upload/".length);
        const file = staged.find((entry) => entry.id === id);
        if (file) file.bytes = raw;
        stub.uploads += 1;
        response.writeHead(200).end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/documents") {
        const body = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!acceptsDocumentBody(body)) return;
        documents.push(body);
        const id = `doc_${documents.length}`;
        void (stub.beforeDocumentAnswer?.() ?? Promise.resolve()).then(() =>
          json(201, {
            id,
            url: "https://site.example/post",
            title: body.title,
            visibility: body.visibility,
            updated_at: "2026-01-01T00:00:00Z",
          }),
        );
        return;
      }

      // Publishing a document that already carries an id is an update, which
      // is what a second publish of the same page goes through.
      if (request.method === "PUT" && url.pathname.startsWith("/v1/documents/")) {
        const body = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!acceptsDocumentBody(body)) return;
        // Required on update, `null` included: an omitted parent would read
        // as a move the client never asked for.
        if (!("parent_id" in body)) {
          return json(400, { error: { code: "malformed_request", message: "parent_id is required" } });
        }
        documents.push(body);
        return json(200, {
          id: url.pathname.slice("/v1/documents/".length),
          url: "https://site.example/post",
          title: body.title,
          visibility: body.visibility,
          updated_at: "2026-01-02T00:00:00Z",
        });
      }

      json(404, { error: { code: "not_found", message: url.pathname } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.server = server;
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

let stub: Stub;
const spaces: string[] = [];

beforeEach(async () => {
  stub = await startStub();
});

afterEach(async () => {
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  await Promise.all(spaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function publisher(): PublisherConnection {
  return { id: "stub", label: "Stub", kind: "sogma", baseURL: `${stub.baseUrl}/v1`, apiKey: "sk-test" };
}

async function space(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pragma-publish-flow-"));
  spaces.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const siteFile = JSON.stringify({ id: "ste_1", slug: "blog", name: "Blog" });

describe("publishing a document that embeds images", () => {
  it("uploads the images and sends a body naming where they landed", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\nBefore\n\n![Hero](hero.png)\n\nAfter\n",
      "blog/hero.png": PNG,
    });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(true);
    expect(stub.staged).toHaveLength(1);
    expect(stub.staged[0].bytes?.equals(PNG)).toBe(true);
    expect(stub.documents[0].content).toBe("Before\n\n![Hero](asset:pub0)\n\nAfter\n");
    expect(stub.documents[0].content_format).toBe("markdown");
  });

  it("leaves the document on disk holding its own relative embed", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![Hero](hero.png)\n",
      "blog/hero.png": PNG,
    });

    await runPublish(root, publisher(), "blog/post.md");

    const onDisk = await readFile(path.join(root, "blog/post.md"), "utf8");
    expect(onDisk).toContain("![Hero](hero.png)");
    expect(onDisk).not.toContain("asset:");
    // The frontmatter the publish writes back still lands.
    expect(onDisk).toContain("id: doc_1");
  });

  it("uploads one file for an image embedded twice, and one per distinct image", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![One](hero.png) ![Again](hero.png) ![Other](other.png)\n",
      "blog/hero.png": PNG,
      "blog/other.png": OTHER_PNG,
    });

    await runPublish(root, publisher(), "blog/post.md");

    expect(stub.staged).toHaveLength(2);
    const sent = stub.documents[0].content as string;
    expect(sent).toBe("![One](asset:pub0) ![Again](asset:pub0) ![Other](asset:pub1)\n");
  });

  it("sends the bytes once when the same image is published again", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![Hero](hero.png)\n",
      "blog/hero.png": PNG,
    });

    await runPublish(root, publisher(), "blog/post.md");
    await runPublish(root, publisher(), "blog/post.md");

    // Staged both times, because that is how the site is asked whether it
    // already holds these bytes — but uploaded only on the first answer.
    expect(stub.staged).toHaveLength(1);
    expect(stub.uploads).toBe(1);
    // A matched file is named exactly as a freshly uploaded one is.
    expect(stub.documents[1].content).toBe(stub.documents[0].content);
    expect(stub.documents[1].content).toBe("![Hero](asset:pub0)\n");
    expect(stub.documents[1].content_format).toBe("markdown");
  });

  it("publishes a page with no images without touching the files endpoint", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\nJust words.\n",
    });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(true);
    expect(stub.staged).toEqual([]);
    if (result.ok) expect(result.notes).toEqual([]);
  });

  it("reports an embed it could not upload and still publishes the page", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![Gone](missing.png)\n",
    });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.notes).toEqual([{ level: "warn", text: 'Left "missing.png" as written: the file is missing.' }]);
    expect(stub.documents[0].content).toBe("![Gone](missing.png)\n");
  });

  it("reports the publisher's own cap when it is the one refusing the size", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![Hero](hero.png)\n",
      "blog/hero.png": PNG,
    });
    stub.rejectStage = {
      status: 413,
      code: "payload_too_large",
      message: "'size_bytes' exceeds the 4194304 byte limit for content_type 'image'.",
      limitBytes: 4 * 1024 * 1024,
    };

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(false);
    // The cap reported is the service's, read from `limit_bytes`, not this
    // module's own pre-flight number, which is the one that goes stale.
    if (!result.ok) {
      expect(result.message).toContain("over the 4 MB the publisher accepts for images");
    }
    expect(stub.documents).toEqual([]);
  });

  it("refuses the publish outright when an image is over the size ceiling", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "# A post\n\n![Huge](huge.png)\n",
      "blog/huge.png": Buffer.alloc(10 * 1024 * 1024 + 1),
    });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(false);
    // Nothing is sent when the page cannot go out whole.
    expect(stub.documents).toEqual([]);
    expect(stub.staged).toEqual([]);
  });
});

describe("publishing a document inside a section", () => {
  const post = (heading: string) => `# ${heading}\n\nBody.\n`;
  const sent = () => stub.documents.map(({ slug, parent_id }) => ({ slug, parent_id }));

  it("creates and publishes a missing section index.md first, then parents the document under it", async () => {
    const root = await space({ "blog/_site.json": siteFile, "blog/News/first.md": post("First") });

    const result = await runPublish(root, publisher(), "blog/News/first.md");

    expect(result.ok).toBe(true);
    expect(sent()).toEqual([
      { slug: "news", parent_id: undefined },
      { slug: "first", parent_id: "doc_1" },
    ]);
    const section = await readFile(path.join(root, "blog/News/index.md"), "utf8");
    expect(section).toContain("id: doc_1");
    expect(section).toContain("# News");
  });

  it("publishes every missing level, outermost first", async () => {
    const root = await space({ "blog/_site.json": siteFile, "blog/posts/2026/first.md": post("First") });

    await runPublish(root, publisher(), "blog/posts/2026/first.md");

    expect(sent()).toEqual([
      { slug: "posts", parent_id: undefined },
      { slug: "2026", parent_id: "doc_1" },
      { slug: "first", parent_id: "doc_2" },
    ]);
  });

  it("publishes a section's Index.md in another case, rather than writing a second index beside it", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/posts/Index.md": "# All posts\n\nIntro.\n",
      "blog/posts/first.md": post("First"),
    });

    await runPublish(root, publisher(), "blog/posts/first.md");

    expect((await readdir(path.join(root, "blog/posts"))).sort()).toEqual(["Index.md", "first.md"]);
    expect(stub.documents[0]).toMatchObject({ slug: "posts", title: "All posts" });
    expect(stub.documents[1]).toMatchObject({ slug: "first", parent_id: "doc_1" });
  });

  it("refuses a document under a dot-prefixed folder, sending and writing nothing", async () => {
    const root = await space({ "blog/_site.json": siteFile, "blog/.drafts/first.md": post("First") });

    const result = await runPublish(root, publisher(), "blog/.drafts/first.md");

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(stub.documents).toEqual([]);
    expect(await readFile(path.join(root, "blog/.drafts/first.md"), "utf8")).toBe(post("First"));
  });

  it("publishes an existing unpublished section index.md as written", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/posts/index.md": "# All posts\n\nIntro.\n",
      "blog/posts/first.md": post("First"),
    });

    await runPublish(root, publisher(), "blog/posts/first.md");

    expect(stub.documents[0]).toMatchObject({ slug: "posts", title: "All posts", content: "Intro.\n" });
    expect(stub.documents[1]).toMatchObject({ slug: "first", parent_id: "doc_1" });
  });

  it("titles a page by its display title, as the editor reads the heading", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/one.md": "# The **Forbidden** [draft] #\n\nBody.\n",
      "blog/two.md": "Second\npart\n===\n\nBody.\n",
      "blog/three.md": "## Not a title\n\nBody.\n",
    });

    for (const file of ["one", "two", "three"]) await runPublish(root, publisher(), `blog/${file}.md`);

    expect(stub.documents.map(({ title, content }) => ({ title, content }))).toEqual([
      { title: "The Forbidden [draft]", content: "Body.\n" },
      { title: "Second part", content: "Body.\n" },
      { title: "three", content: "## Not a title\n\nBody.\n" },
    ]);
  });

  it("reuses a section that is already published", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/posts/index.md": "---\nid: doc_posts\n---\n\n# Posts\n",
      "blog/posts/first.md": post("First"),
    });

    await runPublish(root, publisher(), "blog/posts/first.md");

    expect(sent()).toEqual([{ slug: "first", parent_id: "doc_posts" }]);
  });

  it("refuses the document when its section is private", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/posts/index.md": "---\nvisibility: private\n---\n\n# Posts\n",
      "blog/posts/first.md": post("First"),
    });

    const result = await runPublish(root, publisher(), "blog/posts/first.md");

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(stub.documents).toEqual([]);
  });

  it("sends the parent a page already has on every update", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/about.md": "---\nid: doc_about\n---\n\n# About\n",
      "blog/posts/index.md": "---\nid: doc_posts\n---\n\n# Posts\n",
      "blog/posts/first.md": "---\nid: doc_first\n---\n\n# First\n",
    });

    expect((await runPublish(root, publisher(), "blog/about.md")).ok).toBe(true);
    expect((await runPublish(root, publisher(), "blog/posts/first.md")).ok).toBe(true);

    expect(sent()).toEqual([
      { slug: "about", parent_id: null },
      { slug: "first", parent_id: "doc_posts" },
    ]);
  });

  it("moves a published page under the section its file now sits in, publishing that section first", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/Interviews/sasha.md": "---\nid: doc_sasha\n---\n\n# Sasha\n",
    });

    const result = await runPublish(root, publisher(), "blog/Interviews/sasha.md");

    expect(result.ok).toBe(true);
    expect(sent()).toEqual([
      { slug: "interviews", parent_id: undefined },
      { slug: "sasha", parent_id: "doc_1" },
    ]);
  });
});

describe("publishing a document's publication date", () => {
  const sentDates = () => stub.documents.map((body) => ("published_at" in body ? body.published_at : "absent"));

  it("sends `date` as published_at, as written", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/day.md": "---\ndate: 2019-04-02\n---\n\n# Day\n",
      "blog/stamp.md": "---\nid: doc_stamp\ndate: 2019-04-02T09:30:00+02:00\n---\n\n# Stamp\n",
    });

    expect((await runPublish(root, publisher(), "blog/day.md")).ok).toBe(true);
    expect((await runPublish(root, publisher(), "blog/stamp.md")).ok).toBe(true);

    expect(sentDates()).toEqual(["2019-04-02", "2019-04-02T09:30:00+02:00"]);
  });

  it("dates a page on its first push, and writes that date back", async () => {
    const root = await space({ "blog/_site.json": siteFile, "blog/post.md": "# Post\n" });
    const today = new Date();
    const expected = [today.getFullYear(), today.getMonth() + 1, today.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
      .join("-");

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok && result.date).toBe(expected);
    expect(sentDates()).toEqual([expected]);
    expect(await readFile(path.join(root, "blog/post.md"), "utf8")).toContain(`date: ${expected}`);
  });

  it("leaves index pages undated on their first push", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/index.md": "# Home\n",
      "blog/news/index.md": "# News\n",
    });

    expect((await runPublish(root, publisher(), "blog/index.md")).ok).toBe(true);
    expect((await runPublish(root, publisher(), "blog/news/index.md")).ok).toBe(true);

    expect(sentDates()).toEqual(["absent", "absent"]);
    expect(await readFile(path.join(root, "blog/news/index.md"), "utf8")).not.toContain("date:");
  });

  it("keeps an empty date empty on create, and sends null on update when there is none", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/blank.md": '---\ndate: ""\n---\n\n# Blank\n',
      "blog/old.md": "---\nid: doc_old\n---\n\n# Old\n",
      "blog/cleared.md": "---\nid: doc_cleared\ndate:\n---\n\n# Cleared\n",
    });

    for (const file of ["blank", "old", "cleared"]) {
      expect((await runPublish(root, publisher(), `blog/${file}.md`)).ok).toBe(true);
    }

    expect(sentDates()).toEqual(["absent", null, null]);
    expect(await readFile(path.join(root, "blog/old.md"), "utf8")).not.toContain("date:");
  });

  it("refuses a date that isn't text", async () => {
    const root = await space({ "blog/_site.json": siteFile, "blog/post.md": "---\ndate: 2019\n---\n\n# Post\n" });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result.ok).toBe(false);
    expect(stub.documents).toEqual([]);
  });
});

describe("recording a push", () => {
  // The service round trip takes seconds; an editor save landing in it used
  // to be overwritten by a write-back built from the file as first read.
  it("writes back over a save that landed while the service was answering, and keeps it pending", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "---\ndate: 2026-09-01\n---\n\n# Post\n\nfirst draft\n",
    });
    const postPath = path.join(root, "blog/post.md");
    stub.beforeDocumentAnswer = async () => {
      await writeFile(postPath, "---\ndate: 2026-09-01\nupdated: later\n---\n\n# Post\n\ntyped meanwhile\n");
      await writeFile(path.join(root, "blog/_queue.json"), JSON.stringify([{ op: "publish", path: "blog/post.md" }]));
    };

    const result = await runPublish(root, publisher(), "blog/post.md");
    expect(result.ok).toBe(true);

    const written = await readFile(postPath, "utf8");
    expect(written).toContain("typed meanwhile");
    expect(written).toContain("updated: later");
    expect(written).toContain("id: doc_1");
    expect(JSON.parse(await readFile(path.join(root, "blog/_queue.json"), "utf8"))).toEqual([
      { op: "publish", id: "doc_1" },
    ]);
  });

  it("reports every file it wrote back, sections first, each at the revision it left", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/essays/post.md": "# Post\n",
    });

    const result = await runPublish(root, publisher(), "blog/essays/post.md");
    if (!result.ok) throw new Error(result.message);

    expect(result.writeBacks.map((writeBack) => writeBack.path)).toEqual([
      "blog/essays/index.md",
      "blog/essays/post.md",
    ]);
    for (const writeBack of result.writeBacks) {
      expect(writeBack.revision).toBe(revisionOf(await readFile(path.join(root, writeBack.path))));
    }
  });

  it("refuses a document whose frontmatter doesn't parse, naming the error", async () => {
    const post = "---\ntitle: Chapter 1: The Start\n---\n\n# Post\n";
    const root = await space({ "blog/_site.json": siteFile, "blog/post.md": post });

    const result = await runPublish(root, publisher(), "blog/post.md");

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.ok ? "" : result.message).toContain(
      "frontmatter isn't valid YAML (line 2: Nested mappings are not allowed in compact mappings)",
    );
    expect(stub.documents).toEqual([]);
    expect(await readFile(path.join(root, "blog/post.md"), "utf8")).toBe(post);
  });

  it("adds its keys to the block and leaves every other line as written", async () => {
    const post = "---\n# reviewed\ndate: 2026-09-01   # launch\ntags: [essay, draft]\n---\n\n# Post\n";
    const root = await space({ "blog/_site.json": siteFile, "blog/post.md": post });

    expect((await runPublish(root, publisher(), "blog/post.md")).ok).toBe(true);

    expect(await readFile(path.join(root, "blog/post.md"), "utf8")).toBe(
      post.replace("draft]\n", "draft]\nid: doc_1\npushed: 2026-01-01T00:00:00Z\n"),
    );
  });

  it("writes `pushed` and no `url`", async () => {
    const root = await space({
      "blog/_site.json": siteFile,
      "blog/post.md": "---\nid: doc_post\n---\n\n# Post\n",
    });

    expect((await runPublish(root, publisher(), "blog/post.md")).ok).toBe(true);

    const written = await readFile(path.join(root, "blog/post.md"), "utf8");
    expect(written).toContain("pushed: 2026-01-02T00:00:00Z");
    expect(written).not.toContain("url:");
  });
});
