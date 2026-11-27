import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setCredentialHost } from "../../src/config/credentials.ts";
import type {
  ApiSettingsResponse,
  ClipFactsResponse,
  FlowFileResponse,
  FolderListingResponse,
  LibraryEntry,
  SpaceInfoResponse,
  SpaceLibrariesResponse,
  SpaceRef,
  SpaceTreeNode,
  SystemPathResponse,
  TableFileResponse,
  ThumbnailUsageResponse,
} from "../../src/protocol/api.ts";
import type { ClassRow } from "../../src/protocol/class.ts";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { parseFrontmatter } from "../../src/protocol/frontmatter.ts";
import { localDayAfter } from "../../src/protocol/localDay.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import { createLaunchTokenAuth, LAUNCH_TOKEN_COOKIE } from "../../src/server/launchTokenAuth.ts";
import { tempDir } from "../support/isolation.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";
import { isoVideo, visualEntry } from "../support/videoFixtures.ts";

// Never parsed by anything under test: the server types a PDF by its
// extension and passes the bytes through.
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");

// An extended WebP's header and nothing after it: the thumbnail route reads
// a stored image's type and size, never its pixels.
function webpHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

// Black-box HTTP contract tests for the shared route layer (src/server/routes.ts).
// Deliberately never import route handlers or the dispatcher directly —
// every assertion here goes over real HTTP against a running server, so a
// transport swap changes only test/support/testServer.ts, never this file.
describe("API contract", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("GET /api/space/info returns the space's name and folder", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/info`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: path.basename(testServer.spaceRoot), path: testServer.spaceRoot });
  });

  // The space registry routes. Testable at all because startTestServer points
  // PRAGMA_CONFIG_DIR at a throwaway directory — these read and write the
  // install-global config, which would otherwise be the developer's own.
  describe("space registry", () => {
    async function listSpaces(): Promise<{ current: SpaceRef; spaces: SpaceRef[]; recent: SpaceRef[] }> {
      return (await (await fetch(`${testServer.baseUrl}/api/space/list`)).json()) as {
        current: SpaceRef;
        spaces: SpaceRef[];
        recent: SpaceRef[];
      };
    }

    async function postJson(route: string, body: unknown): Promise<Response> {
      return fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("GET /api/space/list reports the served space with its registry id", async () => {
      const { current } = await listSpaces();
      expect(current.path).toBe(testServer.spaceRoot);
      expect(current.id).toMatch(/^spc_[0-9a-f]{8}$/);
    });

    // The registry, not the recents list: a space that has aged past
    // MAX_RECENT_SPACES still has approvals keyed to its id, so Manage Spaces
    // must still be able to list, and act on, every one of them.
    it("GET /api/space/list returns every registered space, recents or not", async () => {
      const { current, spaces, recent } = await listSpaces();
      expect(spaces.map((space) => space.id)).toContain(current.id);
      expect(recent.every((entry) => spaces.some((space) => space.id === entry.id))).toBe(true);
      const names = spaces.map((space) => space.label || space.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("POST /api/space/label renames without changing the id", async () => {
      const before = (await listSpaces()).current;
      expect((await postJson("/api/space/label", { id: before.id, label: "Renamed" })).status).toBe(204);

      const after = (await listSpaces()).current;
      expect(after.label).toBe("Renamed");
      expect(after.id).toBe(before.id);

      // An empty label clears it rather than storing "".
      expect((await postJson("/api/space/label", { id: before.id, label: "  " })).status).toBe(204);
      expect((await listSpaces()).current.label).toBeUndefined();
    });

    it("GET /api/space/info carries the served space's label", async () => {
      const { id } = (await listSpaces()).current;
      const info = async () =>
        (await (await fetch(`${testServer.baseUrl}/api/space/info`)).json()) as SpaceInfoResponse;

      expect((await postJson("/api/space/label", { id, label: "Shown" })).status).toBe(204);
      expect(await info()).toEqual({ name: expect.any(String), label: "Shown", path: testServer.spaceRoot });

      expect((await postJson("/api/space/label", { id, label: "" })).status).toBe(204);
      expect((await info()).label).toBeUndefined();
    });

    it("POST /api/space/label rejects an unknown space and a wrong method", async () => {
      expect((await postJson("/api/space/label", { id: "spc_deadbeef", label: "x" })).status).toBe(400);
      expect((await fetch(`${testServer.baseUrl}/api/space/label`)).status).toBe(405);
    });

    it("POST /api/space/forget refuses the current space", async () => {
      const { current } = await listSpaces();
      expect((await postJson("/api/space/forget", { id: current.id })).status).toBe(400);
      expect((await listSpaces()).current.id).toBe(current.id);
    });

    it("POST /api/space/grants/reset rejects an unknown space", async () => {
      expect((await postJson("/api/space/grants/reset", { id: "spc_deadbeef" })).status).toBe(400);
    });

    it("POST /api/space/trust records trust, and git refuses with 403 until it does", async () => {
      const { current } = await listSpaces();
      expect(current.trusted).toBeUndefined();
      expect((await postJson("/api/git/commit", { message: "x" })).status).toBe(403);

      expect((await postJson("/api/space/trust", { id: current.id, trusted: true })).status).toBe(204);
      expect((await listSpaces()).current.trusted).toBe(true);
      expect((await postJson("/api/space/trust", { id: current.id, trusted: false })).status).toBe(204);
      expect((await listSpaces()).current.trusted).toBe(false);
    });

    it("POST /api/space/trust rejects an unknown space, a non-boolean, and a wrong method", async () => {
      const { current } = await listSpaces();
      expect((await postJson("/api/space/trust", { id: "spc_deadbeef", trusted: true })).status).toBe(400);
      expect((await postJson("/api/space/trust", { id: current.id, trusted: "yes" })).status).toBe(400);
      expect((await fetch(`${testServer.baseUrl}/api/space/trust`)).status).toBe(405);
    });

    // The test server, like the production server unless its host says
    // otherwise, serves other devices, so it switches to no space at all.
    it("POST /api/space/switch is refused on a server for other devices", async () => {
      const res = await postJson("/api/space/switch", { path: "/etc" });
      expect(res.status).toBe(501);
      expect(await res.text()).toBe("Space switching is not available in this mode");
    });
  });

  // Settings → API Access. These live on the app's own cookie-authed surface:
  // the SPA manages the agent endpoint, but can never reach it.
  describe("agent API settings", () => {
    async function postJson(route: string, body: unknown): Promise<Response> {
      return fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const settings = async () =>
      (await (await fetch(`${testServer.baseUrl}/api/api-settings`)).json()) as ApiSettingsResponse;

    it("is off until someone says otherwise", async () => {
      const current = await settings();
      expect(current.enabled).toBe(false);
      expect(current.tokens).toEqual([]);
    });

    it("saves the switches and refuses an impossible port", async () => {
      expect((await postJson("/api/api-settings", { enabled: true, port: 4400 })).status).toBe(204);
      expect(await settings()).toMatchObject({ enabled: true, port: 4400 });
      expect((await postJson("/api/api-settings", { port: 99999 })).status).toBe(400);
    });

    it("returns a token once, then only ever its metadata", async () => {
      const created = (await (
        await postJson("/api/api-tokens", { label: "Claude Code", access: "read-only" })
      ).json()) as {
        token: { id: string; label: string };
        secret: string;
      };
      expect(created.secret).toMatch(/^pragma_[0-9a-f]{64}$/);

      const listed = (await settings()).tokens;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ label: "Claude Code", access: "read-only" });
      // The secret is never readable again — only its hash was stored.
      expect(JSON.stringify(listed)).not.toContain(created.secret);
      expect(JSON.stringify(listed)).not.toContain("hash");
    });

    it("revokes one token without touching the others", async () => {
      const first = (await (await postJson("/api/api-tokens", { label: "One", access: "read-only" })).json()) as {
        token: { id: string };
      };
      await postJson("/api/api-tokens", { label: "Two", access: "read-only" });

      expect((await postJson("/api/api-tokens/delete", { id: first.token.id })).status).toBe(204);
      // Every test here shares one server, so assert on these two rather than
      // on the whole list.
      const labels = (await settings()).tokens.map((token) => token.label);
      expect(labels).not.toContain("One");
      expect(labels).toContain("Two");
      expect((await postJson("/api/api-tokens/delete", { id: first.token.id })).status).toBe(400);
    });

    it("refuses an unnamed token and a wrong method", async () => {
      expect((await postJson("/api/api-tokens", { label: "  ", access: "read-only" })).status).toBe(400);
      expect((await fetch(`${testServer.baseUrl}/api/api-tokens`)).status).toBe(405);
    });
  });

  it("GET /api/applet/info returns pragma's version and its changelog entry", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/applet/info`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toEqual(expect.any(String));
    expect(body.releaseNotesUrl).toBe(`https://pragma.sogma.com/changelog#desktop-v${body.version}`);
  });

  it("GET /api/space/tree lists the fixture space's real files", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/tree`);
    expect(res.status).toBe(200);
    const tree = await res.text();
    expect(tree).toContain("README.md");
    expect(tree).toContain("getting-started");
  });

  it("GET /api/space/search groups matching lines by file, includes private documents, and scopes to a folder", async () => {
    await mkdir(path.join(testServer.spaceRoot, "search-fixture/inner"), { recursive: true });
    await writeFile(
      path.join(testServer.spaceRoot, "search-fixture/a.md"),
      "Zebrafinch one\nnothing\nzebrafinch two\n",
    );
    await writeFile(
      path.join(testServer.spaceRoot, "search-fixture/inner/b.md"),
      "---\nvisibility: private\n---\nA zebrafinch here\n",
    );
    const search = async (query: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/space/search?${query}`)).json()) as {
        files: { path: string; matches: { line: number; text: string }[] }[];
        truncated: boolean;
      };

    expect(await search("q=ZEBRAFINCH")).toEqual({
      // Tree order: a folder's subfolders before its files.
      files: [
        { path: "search-fixture/inner/b.md", matches: [{ line: 4, text: "A zebrafinch here" }] },
        {
          path: "search-fixture/a.md",
          matches: [
            { line: 1, text: "Zebrafinch one" },
            { line: 3, text: "zebrafinch two" },
          ],
        },
      ],
      truncated: false,
    });
    expect((await search("q=zebrafinch&dir=search-fixture/inner")).files.map((file) => file.path)).toEqual([
      "search-fixture/inner/b.md",
    ]);
    expect(await search("q=%20")).toEqual({ files: [], truncated: false });
    await rm(path.join(testServer.spaceRoot, "search-fixture"), { recursive: true });
  });

  it("GET /api/file/backlinks lists the notes linking to a document, private ones included", async () => {
    await mkdir(path.join(testServer.spaceRoot, "backlinks-fixture/inner"), { recursive: true });
    await writeFile(path.join(testServer.spaceRoot, "backlinks-fixture/plan.md"), "# Plan\n");
    await writeFile(
      path.join(testServer.spaceRoot, "backlinks-fixture/inner/a.md"),
      "---\nvisibility: private\n---\n\nSee [the plan](../plan.md).\n",
    );
    const backlinksOf = (query: string) => fetch(`${testServer.baseUrl}/api/file/backlinks${query}`);

    const res = await backlinksOf(`?path=${encodeURIComponent("backlinks-fixture/plan.md")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      backlinks: [
        {
          path: "backlinks-fixture/inner/a.md",
          mentions: [{ line: 5, text: "See [the plan](../plan.md).", at: 15, length: 10 }],
        },
      ],
    });
    expect((await backlinksOf("")).status).toBe(400);
    await rm(path.join(testServer.spaceRoot, "backlinks-fixture"), { recursive: true });
  });

  it("GET /api/space/search keeps the documents carrying a tag: term's tag, in any case or nested under it", async () => {
    const dir = path.join(testServer.spaceRoot, "tag-search");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.md"), "---\ntags: [Moth]\n---\n\nThe #moth/luna lamp\n`#moth` in code\n");
    await writeFile(path.join(dir, "b.md"), "A moth lamp, untagged\n");
    await writeFile(path.join(dir, "c.md"), "#mothball lamp\n");
    await mkdir(path.join(testServer.spaceRoot, "presets", "templates"), { recursive: true });
    await writeFile(path.join(testServer.spaceRoot, "presets", "templates", "moth.md"), "#moth\n");
    const search = async (q: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/space/search?q=${encodeURIComponent(q)}`)).json()) as {
        files: { path: string; matches: unknown[] }[];
      };
    try {
      expect((await search("tag:#MOTH")).files).toEqual([
        {
          path: "tag-search/a.md",
          matches: [
            { label: "tags", text: "Moth" },
            { line: 5, text: "The #moth/luna lamp" },
          ],
        },
      ]);
      expect((await search("tag:moth/luna lamp")).files).toEqual([
        { path: "tag-search/a.md", matches: [{ line: 5, text: "The #moth/luna lamp" }] },
      ]);
      expect((await search("tag:moth tag:mothball")).files).toEqual([]);
      expect((await search("tag:moth lantern")).files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
      await rm(path.join(testServer.spaceRoot, "presets", "templates", "moth.md"));
    }
  });

  it("GET /api/space/search matches a Table by its values, labelled by column, never by its markup", async () => {
    const search = async (q: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/space/search?q=${encodeURIComponent(q)}`)).json()) as {
        files: { path: string; matches: ({ line: number } | { label: string })[] }[];
      };
    const table = "projects/getting-started/writing-prompts.table.html";
    const hits = (await search("locked door")).files.find((file) => file.path === table)?.matches;
    expect(hits).toEqual([{ label: "Prompt", text: "A locked door with no key" }]);
    // Every .html document has a <title> and a data-type: none of it is content.
    const markup = (await search("data-type")).files.map((file) => file.path);
    expect(markup.filter((path) => /\.(table|class|flow)\.html$/.test(path))).toEqual([]);
  });

  it("GET /api/space/search matches a Class by its own words, never by its markup", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "search-me.class.html"),
      serializeClassFile({
        version: "1.0",
        name: "Storyboard",
        metadata: [
          { key: "description", values: ["Every shot, framed."] },
          { key: "tags", values: ["previs", "boards"] },
        ],
        filter: [],
        fields: [{ id: "frame", type: "media", label: "Keyframe" }],
        views: [{ name: "Unframed", layout: "list", filter: [] }],
        links: [],
      }),
      "utf8",
    );
    const search = async (q: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/space/search?q=${encodeURIComponent(q)}`)).json()) as {
        files: { path: string; matches: unknown[] }[];
      };
    const matchesIn = async (q: string) =>
      (await search(q)).files.find((file) => file.path === "search-me.class.html")?.matches;
    expect(await matchesIn("keyframe")).toEqual([{ label: "Field", text: "Keyframe" }]);
    expect(await matchesIn("unframed")).toEqual([{ label: "View", text: "Unframed" }]);
    expect(await matchesIn("framed.")).toEqual([{ label: "Description", text: "Every shot, framed." }]);
    expect(await matchesIn("previs")).toEqual([{ label: "tags", text: "previs" }]);
    expect(await matchesIn("data-role")).toBeUndefined();
  });

  it("GET /api/file reads a plain markdown document", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=README.md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("text");
    expect(body.content).toContain("This is a Pragma space");
  });

  it("PUT /api/file writes a document, and a following GET reflects it", async () => {
    const putRes = await fetch(`${testServer.baseUrl}/api/file?path=README.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Edited by the contract test\n" }),
    });
    expect(putRes.status).toBe(200);
    const { revision } = await putRes.json();

    const getRes = await fetch(`${testServer.baseUrl}/api/file?path=README.md`);
    const body = await getRes.json();
    expect(body.content).toBe("# Edited by the contract test\n");
    expect(body.revision).toBe(revision);
  });

  it("PUT /api/file refuses a save whose base revision is no longer on disk, and writes nothing", async () => {
    const put = (content: string, baseRevision?: string) =>
      fetch(`${testServer.baseUrl}/api/file?path=README.md`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, baseRevision }),
      });
    const { revision: base } = await (await fetch(`${testServer.baseUrl}/api/file?path=README.md`)).json();

    const first = await put("# Theirs\n", base);
    expect(first.status).toBe(200);
    const { revision: theirs } = await first.json();
    expect(theirs).not.toBe(base);

    expect((await put("# Mine, from the stale copy\n", base)).status).toBe(409);
    const after = await (await fetch(`${testServer.baseUrl}/api/file?path=README.md`)).json();
    expect(after.content).toBe("# Theirs\n");
    expect(after.revision).toBe(theirs);

    // No base is an unconditional write.
    expect((await put("# Mine anyway\n")).status).toBe(200);
  });

  it("GET /api/file reads a .table.html document as kind: table", async () => {
    const res = await fetch(
      `${testServer.baseUrl}/api/file?path=${encodeURIComponent("projects/getting-started/writing-prompts.table.html")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("table");
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.missing).toBeUndefined();
  });

  // Read as a new, empty Table either way; only the one that isn't there says
  // so, for a caller that syncs from its columns.
  it("GET /api/file reads a Table that isn't there as empty and marked missing, and a blank one as empty only", async () => {
    await writeFile(path.join(testServer.spaceRoot, "blank.table.html"), "", "utf8");
    const read = async (name: string) =>
      (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(name)}`)).json();
    const gone = await read("gone.table.html");
    expect([gone.kind, gone.columns, gone.rows, gone.missing]).toEqual(["table", [], [], true]);
    const blank = await read("blank.table.html");
    expect([blank.kind, blank.columns, blank.missing]).toEqual(["table", [], undefined]);
  });

  it("GET /api/file reads a .class.html document as kind: class, its definition and no rows", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "read.class.html"),
      serializeClassFile({
        version: "1.0",
        name: "Shots",
        filter: [
          { property: "file.folder", test: "within", values: ["."] },
          { property: "tags", test: "has", values: ["shot"] },
        ],
        fields: [{ id: "status", type: "select", label: "Status", options: ["draft", "shot"] }],
        views: [{ name: "Board", layout: "cards", groupBy: "status", filter: [] }],
        links: [],
      }),
      "utf8",
    );
    const res = await fetch(`${testServer.baseUrl}/api/file?path=read.class.html`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      kind: "class",
      path: "read.class.html",
      name: "Shots",
      filter: [
        { property: "file.folder", test: "within", values: ["."] },
        { property: "tags", test: "has", values: ["shot"] },
      ],
      fields: [{ id: "status", type: "select", label: "Status", options: ["draft", "shot"] }],
      views: [{ name: "Board", layout: "cards", groupBy: "status", filter: [] }],
    });
    expect(body.locked).toBeUndefined();
    expect(body.rows).toBeUndefined();
  });

  // docs/protocol.md's "Reading and write protection" rule, over the wire: the three
  // formats pragma serializes tell the client when it must not save over a
  // file, so the host locks the document instead. Read still succeeds either
  // way — leniency is the point.
  it("GET /api/file locks a Table, Class or Flow whose format major is newer than this build writes", async () => {
    const cases = [
      [
        "newer.table.html",
        '<!DOCTYPE html>\n<html data-format="table" data-format-version="99.0" data-id="tbl_new">\n<head><title>From the future</title></head>\n<body><table data-role="data"><thead><tr><th data-field="a" data-type="text">A</th></tr></thead><tbody><tr><td>one</td></tr></tbody></table></body>\n</html>\n',
      ],
      [
        "newer.class.html",
        '<!DOCTYPE html>\n<html data-format="class" data-format-version="99.0" data-id="col_new">\n<head><title>From the future</title></head>\n<body></body>\n</html>\n',
      ],
      [
        "newer.flow.html",
        '<!DOCTYPE html>\n<html data-format="flow" data-format-version="99.0" data-id="flow_new">\n<head><title>From the future</title><script type="application/json" data-role="graph">{"nodes":[{"id":"n1","type":"comment","position":{"x":0,"y":0},"config":{}}],"edges":[]}</script></head>\n<body></body>\n</html>\n',
      ],
    ];

    for (const [name, content] of cases) {
      await writeFile(path.join(testServer.spaceRoot, name), content, "utf8");
      const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(name)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.locked, name).toBe("newer-format");
      expect(body.version, name).toBe("99.0");
    }
  });

  // Sent as an empty document, which is exactly what the next edit would
  // otherwise have saved over the file.
  it("GET /api/file locks a non-blank Table, Class or Flow it can't parse", async () => {
    const cases = [
      [
        "no-format.table.html",
        '<!DOCTYPE html>\n<html data-format-version="1.0" data-id="tbl_bad">\n<head><title>No format</title></head>\n<body><table data-role="data"><thead><tr><th data-field="a" data-type="text">A</th></tr></thead><tbody><tr><td>one</td></tr></tbody></table></body>\n</html>\n',
      ],
      [
        "no-format.class.html",
        '<!DOCTYPE html>\n<html data-format-version="1.0" data-id="col_bad">\n<head><title>No format</title></head>\n<body></body>\n</html>\n',
      ],
      [
        "trailing-comma.flow.html",
        '<!DOCTYPE html>\n<html data-format="flow" data-format-version="1.0" data-id="flow_bad">\n<head><title>Trailing comma</title><script type="application/json" data-role="graph">{"nodes":[{"id":"n1","type":"comment","position":{"x":0,"y":0},"config":{}},],"edges":[]}</script></head>\n<body></body>\n</html>\n',
      ],
    ];

    for (const [name, content] of cases) {
      await writeFile(path.join(testServer.spaceRoot, name), content, "utf8");
      const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(name)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.locked, name).toBe("unreadable");
    }
  });

  it("GET /api/file leaves a document at this build's major, or a blank new one, unlocked", async () => {
    await writeFile(path.join(testServer.spaceRoot, "blank.flow.html"), "", "utf8");
    for (const name of ["projects/getting-started/writing-prompts.table.html", "blank.flow.html"]) {
      const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(name)}`);
      const body = await res.json();
      expect(body.locked, name).toBeUndefined();
    }
  });

  it("GET/POST /api/space/site/settings and POST /api/space/site/image 400 with no path", async () => {
    // Deliberately no deeper coverage here — past this guard the route
    // reaches a real configured-publisher check, which would risk a real
    // Sogma call on a machine with one set up. The schema flattening and
    // merge-patch building are covered in test/protocol/settingsSchema.
    const read = await fetch(`${testServer.baseUrl}/api/space/site/settings`);
    expect(read.status).toBe(400);

    const write = await fetch(`${testServer.baseUrl}/api/space/site/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(write.status).toBe(400);

    const image = await fetch(`${testServer.baseUrl}/api/space/site/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "blog" }),
    });
    expect(image.status).toBe(400);
  });

  // A Save that changes only the assets folder never resolves a publisher,
  // so this is the one Save a test can make without risking a real call.
  it("POST /api/space/site/settings saves an assets folder alone without the publisher", async () => {
    const siteDir = path.join(testServer.spaceRoot, "assets-site");
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_1", slug: "assets-site", name: "A" }));
    const post = (body: unknown) =>
      fetch(`${testServer.baseUrl}/api/space/site/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const saved = await post({ path: "assets-site", edits: {}, assetsFolder: "/media/" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ siteName: "A", assetsFolder: "media" });
    expect(JSON.parse(await readFile(path.join(siteDir, "_site.json"), "utf8")).assetsFolder).toBe("media");

    const outside = await post({ path: "assets-site", edits: {}, assetsFolder: "../up" });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ field: "assetsFolder" });
    expect((await post({ path: "assets-site", edits: {}, name: 7 })).status).toBe(400);
    expect((await post({ path: "projects", edits: {}, assetsFolder: "media" })).status).toBe(404);
  });

  it("GET /api/space/sites lists the space's sites, and any other method is a 405", async () => {
    const siteDir = path.join(testServer.spaceRoot, "listed-site");
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_2", slug: "listed", name: "Listed" }));
    try {
      const sites = (await (await fetch(`${testServer.baseUrl}/api/space/sites`)).json()) as { path: string }[];
      expect(sites.map((site) => site.path)).toContain("listed-site");
      expect((await fetch(`${testServer.baseUrl}/api/space/sites`, { method: "POST" })).status).toBe(405);
    } finally {
      await rm(siteDir, { recursive: true, force: true });
    }
  });

  // An Applet's manifest no longer has capabilities; one that still lists
  // them reads as such, for the client to refuse.
  it("GET /api/file reads a .applet.html document as kind: applet", async () => {
    const manifest = (extra: object) =>
      `<script type="application/json" data-role="manifest">${JSON.stringify({ id: "applet_hi", version: "1.0", ...extra })}</script>`;
    await writeFile(
      path.join(testServer.spaceRoot, "hi.applet.html"),
      `<!DOCTYPE html><html><head>${manifest({})}</head></html>`,
    );
    await writeFile(
      path.join(testServer.spaceRoot, "old.applet.html"),
      `<!DOCTYPE html><html><head>${manifest({ capabilities: [{ type: "generate" }] })}</head></html>`,
    );
    const read = async (file: string) =>
      (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(file)}`)).json();

    const body = await read("hi.applet.html");
    expect(body.kind).toBe("applet");
    expect(body.manifest).toEqual({ version: "1.0" });
    expect(body.html).toContain("applet_hi");
    expect(body.contentHash).toEqual(expect.any(String));
    expect(body.imports).toEqual([]);
    expect(Object.keys(body).sort()).toEqual([
      "contentHash",
      "html",
      "imports",
      "kind",
      "manifest",
      "path",
      "revision",
    ]);

    expect((await read("old.applet.html")).manifest.declaresCapabilities).toBe(true);
  });

  it("GET /api/file without a path query param is a 400", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/file`);
    expect(res.status).toBe(400);
  });

  // A traversal is refused while the path is being parsed, before any root
  // is consulted — so it reads as the client error it is rather than as a
  // server failure.
  // What sits under a dot can hold credentials wider than the space, a
  // remote's token in `.git/config` above all, so it reads as missing.
  it("finds nothing at a hidden path, whatever route reads it", async () => {
    await mkdir(path.join(testServer.spaceRoot, ".git"), { recursive: true });
    await writeFile(path.join(testServer.spaceRoot, ".git", "config"), "url = https://user:secret@example.com/x\n");
    for (const route of ["/api/file", "/api/file/info", "/api/file/sha256"]) {
      const res = await fetch(`${testServer.baseUrl}${route}?path=${encodeURIComponent(".git/config")}`);
      expect(res.status, route).toBe(404);
      expect(await res.text(), route).not.toContain("secret");
    }
  });

  it("rejects a path that escapes the space", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent("../../etc/passwd")}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("..");
  });

  it("an unknown /api route is a 404", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("GET on a POST-only route is a 405", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/git/commit`);
    expect(res.status).toBe(405);
  });

  it("keeps other sites from framing the app or any file it serves", async () => {
    for (const pathname of ["/", "/index.html"]) {
      const res = await fetch(`${testServer.baseUrl}${pathname}`);
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    }
  });

  it("rejects a cross-origin request", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/info`, {
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an Origin of another scheme, and a request a browser marks as another site's", async () => {
    const { port } = new URL(testServer.baseUrl);
    const statusOf = (headers: Record<string, string>) =>
      new Promise<number | undefined>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/space/info", headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await statusOf({ origin: `https://127.0.0.1:${port}` })).toBe(403);
    expect(await statusOf({ "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await statusOf({ "sec-fetch-site": "same-site" })).toBe(403);
    expect(await statusOf({ origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" })).toBe(200);
  });

  // DNS rebinding: the page's own domain now resolves to 127.0.0.1, so Origin
  // and Host agree and only the Host name gives it away. fetch() can't set
  // Host, hence node:http.
  it("refuses a non-loopback Host, even with a matching Origin", async () => {
    const { port } = new URL(testServer.baseUrl);
    for (const pathname of ["/api/space/info", "/"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: pathname,
            headers: { host: `evil.example.com:${port}`, origin: `http://evil.example.com:${port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    }
  });
});

// POST /api/space/delete's soft-delete path (src/server/spaceFiles.ts) — a
// separate describe/testServer from "API contract" above so these deletes
// never touch a space another test's assertions depend on.
describe("API contract — space delete", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function createEntry(
    name: string,
    type: "file" | "directory",
    options: { parentPath?: string; content?: string } = {},
  ): Promise<void> {
    const res = await fetch(`${testServer.baseUrl}/api/space/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type, ...options }),
    });
    expect(res.status).toBe(200);
  }

  async function deleteEntry(relativePath: string, trash?: boolean): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(trash === undefined ? { path: relativePath } : { path: relativePath, trash }),
    });
  }

  it("trash: true moves the file into .trash instead of deleting it", async () => {
    await createEntry("delete-test.md", "file", { content: "soft-deleted" });

    const res = await deleteEntry("delete-test.md", true);
    expect(res.status).toBe(200);

    expect(existsSync(path.join(testServer.spaceRoot, "delete-test.md"))).toBe(false);
    const trashedPath = path.join(testServer.spaceRoot, ".trash", "delete-test.md");
    expect(existsSync(trashedPath)).toBe(true);
    expect(await readFile(trashedPath, "utf8")).toBe("soft-deleted");
  });

  it("trash: false permanently deletes the file — nothing ends up in .trash", async () => {
    await createEntry("delete-test-permanent.md", "file");

    const res = await deleteEntry("delete-test-permanent.md", false);
    expect(res.status).toBe(200);

    expect(existsSync(path.join(testServer.spaceRoot, "delete-test-permanent.md"))).toBe(false);
    expect(existsSync(path.join(testServer.spaceRoot, ".trash", "delete-test-permanent.md"))).toBe(false);
  });

  it("omitting trash defaults to the soft-delete path", async () => {
    await createEntry("delete-test-default.md", "file");

    const res = await deleteEntry("delete-test-default.md");
    expect(res.status).toBe(200);

    expect(existsSync(path.join(testServer.spaceRoot, ".trash", "delete-test-default.md"))).toBe(true);
  });

  it("a name collision in .trash gets a numeric suffix instead of overwriting", async () => {
    await createEntry("delete-test-collision.md", "file", { content: "first" });
    expect((await deleteEntry("delete-test-collision.md", true)).status).toBe(200);

    await createEntry("delete-test-collision.md", "file", { content: "second" });
    expect((await deleteEntry("delete-test-collision.md", true)).status).toBe(200);

    const trashDir = path.join(testServer.spaceRoot, ".trash");
    expect(await readFile(path.join(trashDir, "delete-test-collision.md"), "utf8")).toBe("first");
    expect(await readFile(path.join(trashDir, "delete-test-collision 2.md"), "utf8")).toBe("second");
  });

  it("a .trash name that differs only by Unicode normalization gets a suffix too", async () => {
    await createEntry("delete-test-cafe\u0301.md", "file", { content: "first" });
    expect((await deleteEntry("delete-test-cafe\u0301.md", true)).status).toBe(200);

    await createEntry("delete-test-caf\u00e9.md", "file", { content: "second" });
    expect((await deleteEntry("delete-test-caf\u00e9.md", true)).status).toBe(200);

    const trashDir = path.join(testServer.spaceRoot, ".trash");
    expect(await readFile(path.join(trashDir, "delete-test-cafe\u0301.md"), "utf8")).toBe("first");
    expect(await readFile(path.join(trashDir, "delete-test-caf\u00e9 2.md"), "utf8")).toBe("second");
  });

  it("a colliding table keeps its compound extension — the suffix goes before .table.html", async () => {
    await createEntry("delete-test-collision.table.html", "file", { content: "first table" });
    expect((await deleteEntry("delete-test-collision.table.html", true)).status).toBe(200);

    await createEntry("delete-test-collision.table.html", "file", { content: "second table" });
    expect((await deleteEntry("delete-test-collision.table.html", true)).status).toBe(200);

    const trashDir = path.join(testServer.spaceRoot, ".trash");
    expect(await readFile(path.join(trashDir, "delete-test-collision.table.html"), "utf8")).toBe("first table");
    // Not "delete-test-collision.table 2.html" — that name no longer ends in
    // .table.html, so the recovered file would stop being a table document.
    expect(await readFile(path.join(trashDir, "delete-test-collision 2.table.html"), "utf8")).toBe("second table");
  });

  it("a folder moved to .trash keeps its contents", async () => {
    await createEntry("delete-test-folder", "directory");
    await createEntry("inner.md", "file", { parentPath: "delete-test-folder", content: "nested" });

    const res = await deleteEntry("delete-test-folder", true);
    expect(res.status).toBe(200);

    expect(existsSync(path.join(testServer.spaceRoot, "delete-test-folder"))).toBe(false);
    const nestedPath = path.join(testServer.spaceRoot, ".trash", "delete-test-folder", "inner.md");
    expect(await readFile(nestedPath, "utf8")).toBe("nested");
  });

  // A page never published is queued by its path, which names nothing once
  // the page is deleted, so the entry has to go with it.
  it("deleting a never-published page drops its queued path", async () => {
    const siteDir = path.join(testServer.spaceRoot, "delete-site");
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_delete", slug: "delete", name: "D" }));
    const saved = await fetch(`${testServer.baseUrl}/api/file?path=delete-site/draft.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Draft\n" }),
    });
    expect(saved.status).toBe(200);
    expect(existsSync(path.join(siteDir, "_queue.json"))).toBe(true);

    const res = await deleteEntry("delete-site/draft.md");

    expect(res.status).toBe(200);
    expect(existsSync(path.join(siteDir, "_queue.json"))).toBe(false);
  });
});

describe("API contract — trash", () => {
  let testServer: TestServer;
  let trashDir: string;

  beforeAll(async () => {
    testServer = await startTestServer();
    trashDir = path.join(testServer.spaceRoot, ".trash");
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function post(route: string, body?: unknown): Promise<Response> {
    return fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function listTrash(): Promise<{ name: string; type: string }[]> {
    const res = await fetch(`${testServer.baseUrl}/api/space/trash`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: { name: string; type: string }[] }).entries;
  }

  it("lists nothing before anything was deleted", async () => {
    expect(await listTrash()).toEqual([]);
  });

  it("lists what Delete moved there, folders first, dot entries hidden", async () => {
    await writeFile(path.join(testServer.spaceRoot, "b-note.md"), "b");
    await writeFile(path.join(testServer.spaceRoot, "a-note.md"), "a");
    await mkdir(path.join(testServer.spaceRoot, "z-folder"));
    for (const entry of ["b-note.md", "a-note.md", "z-folder"]) {
      expect((await post("/api/space/delete", { path: entry })).status).toBe(200);
    }
    await writeFile(path.join(trashDir, ".DS_Store"), "");

    expect(await listTrash()).toEqual([
      { name: "z-folder", type: "directory" },
      { name: "a-note.md", type: "file" },
      { name: "b-note.md", type: "file" },
    ]);
  });

  it("deletes one entry for good, by its bare name", async () => {
    expect((await post("/api/space/trash/delete", { name: "a-note.md" })).status).toBe(204);
    expect(existsSync(path.join(trashDir, "a-note.md"))).toBe(false);
    expect((await listTrash()).map((entry) => entry.name)).toEqual(["z-folder", "b-note.md"]);
  });

  it("refuses anything but one listed entry's name", async () => {
    await writeFile(path.join(testServer.spaceRoot, "kept.md"), "kept");
    for (const name of ["../kept.md", "z-folder/inner", ".DS_Store", "..", "", 42]) {
      expect((await post("/api/space/trash/delete", { name })).status).toBe(400);
    }
    expect((await post("/api/space/trash/delete", { name: "missing.md" })).status).toBe(404);
    expect(existsSync(path.join(testServer.spaceRoot, "kept.md"))).toBe(true);
    expect(existsSync(path.join(trashDir, ".DS_Store"))).toBe(true);
  });

  describe("moving an entry out", () => {
    const move = (body: unknown) => post("/api/space/trash/move", body);
    const inSpace = (...segments: string[]) => path.join(testServer.spaceRoot, ...segments);

    it("lands it in a space folder under its own name, and says where", async () => {
      await mkdir(inSpace("restored"));
      const res = await move({ name: "b-note.md", dir: "restored" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ path: "restored/b-note.md" });
      expect(await readFile(inSpace("restored", "b-note.md"), "utf8")).toBe("b");
      expect((await listTrash()).map((entry) => entry.name)).toEqual(["z-folder"]);
    });

    it("lands a folder, contents and all, at the top level", async () => {
      expect(await (await move({ name: "z-folder", dir: "" })).json()).toEqual({ path: "z-folder" });
      expect(existsSync(inSpace("z-folder"))).toBe(true);
      expect(await listTrash()).toEqual([]);
    });

    // A Trash row can't be renamed, so the drop can't ask for another name.
    it("steps around a name already taken where it lands", async () => {
      await writeFile(inSpace("taken.md"), "here first");
      await writeFile(path.join(trashDir, "taken.md"), "from the trash");
      expect(await (await move({ name: "taken.md", dir: "" })).json()).toEqual({ path: "taken 2.md" });
      expect(await readFile(inSpace("taken.md"), "utf8")).toBe("here first");
      expect(await readFile(inSpace("taken 2.md"), "utf8")).toBe("from the trash");
    });

    // The delete took the pages down, so an id kept would aim the next
    // publish at a page that is gone.
    it("drops a note's publish state, in a folder's notes too", async () => {
      const published = "---\ntitle: Kept\nid: doc-1\npushed: 2026-10-01T09:00:00.000Z\n---\nBody\n";
      await writeFile(path.join(trashDir, "published.md"), published);
      await mkdir(path.join(trashDir, "site", "inner"), { recursive: true });
      await writeFile(path.join(trashDir, "site", "inner", "page.md"), published);
      await writeFile(path.join(trashDir, "site", "_site.json"), '{"id":"site-1"}');
      expect((await move({ name: "published.md", dir: "restored" })).status).toBe(200);
      expect((await move({ name: "site", dir: "restored" })).status).toBe(200);

      for (const note of [inSpace("restored", "published.md"), inSpace("restored", "site", "inner", "page.md")]) {
        expect(parseFrontmatter(await readFile(note, "utf8"))).toEqual({ data: { title: "Kept" }, body: "Body\n" });
      }
      expect(await readFile(inSpace("restored", "site", "_site.json"), "utf8")).toBe('{"id":"site-1"}');
    });

    it("refuses anything but one listed entry's name", async () => {
      await writeFile(path.join(trashDir, ".hidden.md"), "hidden");
      for (const name of ["../kept.md", "site/inner", ".hidden.md", "..", "", 42]) {
        expect((await move({ name, dir: "" })).status).toBe(400);
      }
      expect((await move({ name: "missing.md", dir: "" })).status).toBe(404);
      expect(existsSync(inSpace(".hidden.md"))).toBe(false);
    });

    it("refuses a link, which would bring what it points at into the space", async () => {
      await symlink(inSpace("kept.md"), path.join(trashDir, "a-link.md"));
      expect((await move({ name: "a-link.md", dir: "" })).status).toBe(403);
      expect(existsSync(inSpace("a-link.md"))).toBe(false);
    });

    it("lands only in a folder of the space that is there", async () => {
      await writeFile(path.join(trashDir, "stays.md"), "stays");
      const libraryRoot = tempDir("pragma-test-library-");
      const configPath = path.join(testServer.configDir, "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      giveSpaceLibraries(testServer.configDir, testServer.spaceRoot, [
        { id: "lib", label: "Lib", path: libraryRoot, access: "read-write" },
      ]);
      try {
        expect((await move({ name: "stays.md" })).status).toBe(400);
        expect((await move({ name: "stays.md", dir: "no-such-folder" })).status).toBe(404);
        expect((await move({ name: "stays.md", dir: "kept.md" })).status).toBe(404);
        expect((await move({ name: "stays.md", dir: "../outside" })).status).toBe(400);
        expect((await move({ name: "stays.md", dir: ".trash" })).status).toBe(403);
        expect((await move({ name: "stays.md", dir: "lib:lib" })).status).toBe(400);
        expect(await readdir(libraryRoot)).toEqual([]);
        expect(existsSync(path.join(trashDir, "stays.md"))).toBe(true);
      } finally {
        await writeFile(configPath, JSON.stringify(config), "utf8");
        await rm(path.join(testServer.spaceRoot, "_libraries.json"), { force: true });
      }
    });
  });

  it("empties the whole trash, hidden entries included", async () => {
    expect((await post("/api/space/trash/empty")).status).toBe(204);
    expect(existsSync(trashDir)).toBe(false);
    expect(await listTrash()).toEqual([]);
    // Emptying an absent trash is not an error.
    expect((await post("/api/space/trash/empty")).status).toBe(204);
  });

  describe("trash setting", () => {
    const setting = async () =>
      (await (await fetch(`${testServer.baseUrl}/api/trash-settings`)).json()) as { moveToTrash: boolean };
    const stored = async () =>
      (JSON.parse(await readFile(path.join(testServer.configDir, "config.json"), "utf8")) as { moveToTrash?: boolean })
        .moveToTrash;

    it("offers the trash until someone says otherwise", async () => {
      expect(await setting()).toEqual({ moveToTrash: true });
    });

    it("keeps an off in config.json, and on as the absent default", async () => {
      expect((await post("/api/trash-settings", { moveToTrash: false })).status).toBe(204);
      expect(await setting()).toEqual({ moveToTrash: false });
      expect(await stored()).toBe(false);

      expect((await post("/api/trash-settings", { moveToTrash: true })).status).toBe(204);
      expect(await setting()).toEqual({ moveToTrash: true });
      expect(await stored()).toBeUndefined();
    });

    it("refuses anything but true or false", async () => {
      for (const body of [{}, { moveToTrash: "false" }, { moveToTrash: 0 }]) {
        expect((await post("/api/trash-settings", body)).status).toBe(400);
      }
      expect(await setting()).toEqual({ moveToTrash: true });
    });

    // The setting only words the confirmation; the request carries what was
    // confirmed, and a missing choice is still a trash.
    it("never decides a delete: the request's own choice does", async () => {
      expect((await post("/api/trash-settings", { moveToTrash: false })).status).toBe(204);
      await writeFile(path.join(testServer.spaceRoot, "kept-anyway.md"), "x");
      expect((await post("/api/space/delete", { path: "kept-anyway.md" })).status).toBe(200);
      expect(existsSync(path.join(trashDir, "kept-anyway.md"))).toBe(true);
      expect((await post("/api/trash-settings", { moveToTrash: true })).status).toBe(204);
      expect((await post("/api/space/trash/delete", { name: "kept-anyway.md" })).status).toBe(204);
    });
  });

  it("answers 405 to the wrong method", async () => {
    expect((await fetch(`${testServer.baseUrl}/api/trash-settings`, { method: "PUT" })).status).toBe(405);
    expect((await post("/api/space/trash")).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/space/trash/delete`)).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/space/trash/move`)).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/space/trash/empty`)).status).toBe(405);
  });
});

describe("API contract — every file type", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
    await mkdir(path.join(testServer.spaceRoot, "data"), { recursive: true });
    for (const name of ["budget.csv", "notes.md", "_tags.json", ".hidden.txt"]) {
      await writeFile(path.join(testServer.spaceRoot, "data", name), "x");
    }
  });

  afterAll(async () => {
    await testServer.close();
  });

  const post = (route: string, body: unknown) =>
    fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const setting = async () =>
    (await (await fetch(`${testServer.baseUrl}/api/file-type-settings`)).json()) as { showAllFileTypes: boolean };
  const stored = async () =>
    (
      JSON.parse(await readFile(path.join(testServer.configDir, "config.json"), "utf8")) as {
        showAllFileTypes?: boolean;
      }
    ).showAllFileTypes;
  const treeNames = async () => {
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    return tree.find((node) => node.name === "data")?.children?.map((node) => node.name);
  };
  const folderNames = async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/folder?path=data`);
    return ((await res.json()) as { entries: { name: string }[] }).entries.map((entry) => entry.name);
  };

  it("lists only files Pragma opens until someone asks for every type", async () => {
    expect(await setting()).toEqual({ showAllFileTypes: false });
    expect(await treeNames()).toEqual(["notes.md"]);
    expect(await folderNames()).toEqual(["notes.md"]);
  });

  it("lists every other file then, an underscore's included but never a dotfile, and keeps the choice in config.json", async () => {
    expect((await post("/api/file-type-settings", { showAllFileTypes: true })).status).toBe(204);
    expect(await setting()).toEqual({ showAllFileTypes: true });
    expect(await stored()).toBe(true);
    expect(await treeNames()).toEqual(["_tags.json", "budget.csv", "notes.md"]);
    expect(await folderNames()).toEqual(["_tags.json", "budget.csv", "notes.md"]);
    // A manual order names what the listing shows, so one with the files is accepted.
    const order = ["notes.md", "budget.csv", "_tags.json"];
    expect((await post("/api/space/order", { dir: "data", order })).status).toBe(204);

    expect((await post("/api/file-type-settings", { showAllFileTypes: false })).status).toBe(204);
    expect(await stored()).toBeUndefined();
    expect(await treeNames()).toEqual(["notes.md"]);
  });

  it("refuses anything but true or false, and other methods", async () => {
    for (const body of [{}, { showAllFileTypes: "true" }, { showAllFileTypes: 1 }]) {
      expect((await post("/api/file-type-settings", body)).status).toBe(400);
    }
    expect((await fetch(`${testServer.baseUrl}/api/file-type-settings`, { method: "PUT" })).status).toBe(405);
  });
});

describe("API contract — auth checkpoint", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer({ authorize: () => false });
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("an AuthCheck that denies blocks every /api/* request with 401", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/info`);
    expect(res.status).toBe(401);
  });
});

// The desktop target's gate: only the window holding this launch's cookie
// gets in, and with no login page a miss is a 401, never a redirect loop.
describe("API contract — launch token", () => {
  let testServer: TestServer;
  let token: string;

  beforeAll(async () => {
    const launch = createLaunchTokenAuth();
    token = launch.token;
    testServer = await startTestServer(launch.auth);
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("serves a request carrying this launch's token", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/info`, {
      headers: { cookie: `${LAUNCH_TOKEN_COOKIE}=${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a missing or wrong token on API and static requests alike", async () => {
    const other = createLaunchTokenAuth().token;
    for (const pathname of ["/api/space/info", "/"]) {
      for (const headers of [{}, { cookie: `${LAUNCH_TOKEN_COOKIE}=${other}` }] as Record<string, string>[]) {
        const res = await fetch(`${testServer.baseUrl}${pathname}`, { headers, redirect: "manual" });
        expect(res.status).toBe(401);
      }
    }
  });
});

// The sandbox broker's one route family, exercised for every kind it
// serves. The template space ships an applet and a flow; an applet that
// writes is added to the throwaway copy.
describe("API contract — sandbox broker", () => {
  let testServer: TestServer;
  const flow = "projects/getting-started/story-expander.flow.html";
  const table = "writing-prompts.table.html"; // document-relative, as the flow declares it
  const tableKey = "readFile:space:projects/getting-started/writing-prompts.table.html";

  // A Flow whose one capability is a Write Note's writeDocument on `notePath`,
  // plus a Generate when asked for.
  const writerFlow = (notePath: string, withGenerate = false) =>
    serializeFlowFile({
      version: "1.0",
      name: "Writer",
      graph: {
        nodes: [
          { id: "w", type: "writeNote", position: { x: 0, y: 0 }, config: { notePath } },
          ...(withGenerate ? [{ id: "g", type: "generateText", position: { x: 0, y: 200 }, config: {} }] : []),
        ],
        edges: [],
      },
    });

  beforeAll(async () => {
    testServer = await startTestServer();
    await writeFile(path.join(testServer.spaceRoot, "writer.flow.html"), writerFlow("written.md"));
    await writeFile(path.join(testServer.spaceRoot, "hi.applet.html"), "<!DOCTYPE html><html></html>");
  });

  afterAll(async () => {
    await testServer.close();
  });

  function post(route: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/sandbox/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // An Applet declares nothing, so it is no kind a request can name.
  it("refuses a non-POST, an unknown kind, an Applet, and a kind the path doesn't match", async () => {
    expect((await fetch(`${testServer.baseUrl}/api/sandbox/read`)).status).toBe(405);
    expect((await post("grant", { kind: "widget", path: flow, capabilityKey: "generateText" })).status).toBe(400);
    expect(
      (await post("grant", { kind: "applet", path: "hi.applet.html", capabilityKey: "generateText" })).status,
    ).toBe(400);
    expect((await post("grant", { kind: "flow", path: "hi.applet.html", capabilityKey: "generateText" })).status).toBe(
      400,
    );
  });

  it("a read needs a declared, granted readFile, comes back parsed, and stops when revoked", async () => {
    expect((await post("read", { kind: "flow", path: flow, targetPath: "README.md" })).status).toBe(400);
    expect((await post("read", { kind: "flow", path: flow, targetPath: table })).status).toBe(403);
    expect((await post("grant", { kind: "flow", path: flow, capabilityKey: tableKey })).status).toBe(204);
    const res = await post("read", { kind: "flow", path: flow, targetPath: table });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("table");
    expect(body.columns.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeGreaterThan(0);

    expect((await post("revoke", { kind: "flow", path: flow, capabilityKey: tableKey })).status).toBe(204);
    expect((await post("read", { kind: "flow", path: flow, targetPath: table })).status).toBe(403);
  });

  // The copy's document-relative readFile names a different file from its own
  // folder, under another key, so the original's approval can't reach it.
  it("keys an approval by the file's path, not its id or the request's spelling", async () => {
    const copy = "elsewhere/story-expander.flow.html";
    await mkdir(path.join(testServer.spaceRoot, "elsewhere"), { recursive: true });
    await writeFile(path.join(testServer.spaceRoot, copy), await readFile(path.join(testServer.spaceRoot, flow)));
    const respelled = "./projects/getting-started/../getting-started/story-expander.flow.html";

    expect((await post("grant", { kind: "flow", path: flow, capabilityKey: tableKey })).status).toBe(204);
    expect((await post("read", { kind: "flow", path: copy, targetPath: table })).status).toBe(403);
    expect((await post("read", { kind: "flow", path: respelled, targetPath: table })).status).toBe(200);

    expect((await post("revoke", { kind: "flow", path: flow, capabilityKey: tableKey })).status).toBe(204);
  });

  it("grant and revoke accept only what the flow declares; generate is gated the same way", async () => {
    expect((await post("grant", { kind: "flow", path: flow, capabilityKey: "readFile:x" })).status).toBe(400);
    expect((await post("grant", { kind: "flow", path: flow, capabilityKey: "readCurrentDocument" })).status).toBe(400);
    expect((await post("grant", { kind: "flow", path: flow, capabilityKey: "generateText" })).status).toBe(204);
    expect((await post("revoke", { kind: "flow", path: flow, capabilityKey: "generateText" })).status).toBe(204);

    // Declared but not granted, and not declared at all — neither reaches a model.
    expect((await post("generate", { kind: "flow", path: flow, instruction: "x" })).status).toBe(403);
    expect((await post("generate-options", { kind: "flow", path: flow, instruction: "x" })).status).toBe(403);
    expect((await post("generate", { kind: "flow", path: "writer.flow.html", instruction: "x" })).status).toBe(400);
  });

  it("a write lands on disk through a granted writeDocument", async () => {
    const write = { kind: "flow", path: "writer.flow.html", targetPath: "written.md", content: "written by a flow\n" };
    expect((await post("write", { ...write, targetPath: "other.md" })).status).toBe(400);
    expect((await post("write", write)).status).toBe(403);
    expect(
      (await post("grant", { kind: "flow", path: "writer.flow.html", capabilityKey: "writeDocument:space:written.md" }))
        .status,
    ).toBe(204);
    expect((await post("write", write)).status).toBe(204);
    expect(await readFile(path.join(testServer.spaceRoot, "written.md"), "utf8")).toBe(write.content);
  });

  // The cells arrive whole: one that isn't text refuses the row outright.
  it("a row lands in a Table through a granted writeDocument, every cell text", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "rows.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Rows",
        graph: {
          nodes: [{ id: "a", type: "addRow", position: { x: 0, y: 0 }, config: { tablePath: "rows.table.html" } }],
          edges: [],
        },
      }),
    );
    await writeFile(
      path.join(testServer.spaceRoot, "rows.table.html"),
      serializeTableFile({
        version: "1.0",
        name: "Rows",
        columns: [{ id: "note", label: "Note", type: "text" }],
        rows: [],
      }),
    );
    const add = { kind: "flow", path: "rows.flow.html", targetPath: "rows.table.html", values: { note: "hello" } };
    expect((await post("add-row", { ...add, targetPath: "other.table.html" })).status).toBe(400);
    expect((await post("add-row", add)).status).toBe(403);
    const grant = { kind: "flow", path: "rows.flow.html", capabilityKey: "writeDocument:space:rows.table.html" };
    expect((await post("grant", grant)).status).toBe(204);
    expect((await post("add-row", { ...add, values: { note: 3 } })).status).toBe(400);
    expect((await post("add-row", { ...add, values: ["hello"] })).status).toBe(400);
    const res = await post("add-row", add);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "rows.table.html" });
    expect(await readFile(path.join(testServer.spaceRoot, "rows.table.html"), "utf8")).toContain(
      "<tr><td>hello</td></tr>",
    );
  });

  // The place is the host's to find, so the request names only the mode, and
  // a mode it doesn't know is refused rather than guessed at.
  it("text lands in a note through a granted writeDocument, where affixMode says", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "log.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Log",
        graph: {
          nodes: [{ id: "a", type: "addToNote", position: { x: 0, y: 0 }, config: { notePath: "log.md" } }],
          edges: [],
        },
      }),
    );
    await writeFile(path.join(testServer.spaceRoot, "log.md"), "# Log\n\n- first\n");
    const add = { kind: "flow", path: "log.flow.html", targetPath: "log.md", text: "- second", affixMode: "append" };
    expect((await post("add-to-note", { ...add, targetPath: "other.md" })).status).toBe(400);
    expect((await post("add-to-note", add)).status).toBe(403);
    const grant = { kind: "flow", path: "log.flow.html", capabilityKey: "writeDocument:space:log.md" };
    expect((await post("grant", grant)).status).toBe(204);
    expect((await post("add-to-note", { ...add, text: 3 })).status).toBe(400);
    expect((await post("add-to-note", { ...add, affixMode: "after" })).status).toBe(400);
    expect((await post("add-to-note", add)).status).toBe(204);
    expect((await post("add-to-note", { ...add, text: "- zeroth", affixMode: "prepend" })).status).toBe(204);
    expect(await readFile(path.join(testServer.spaceRoot, "log.md"), "utf8")).toBe(
      "# Log\n\n- zeroth\n- first\n- second\n",
    );
  });

  // A granted write is a change to the document like any other, so it owes
  // the site the same bookkeeping an editor save does — the queue is what
  // the site has locally that the service doesn't, however the change got
  // there.
  it("a write into a site queues the republish and stamps updated", async () => {
    const siteDir = path.join(testServer.spaceRoot, "broker-site");
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_broker", slug: "broker", name: "B" }));
    await writeFile(path.join(siteDir, "page.md"), "---\nid: doc_broker\n---\n\n# Page\n", "utf8");
    await writeFile(path.join(testServer.spaceRoot, "site-writer.flow.html"), writerFlow("broker-site/page.md"));

    const document = { kind: "flow", path: "site-writer.flow.html" };
    expect(
      (await post("grant", { ...document, capabilityKey: "writeDocument:space:broker-site/page.md" })).status,
    ).toBe(204);
    expect(
      (
        await post("write", {
          ...document,
          targetPath: "broker-site/page.md",
          content: "---\nid: doc_broker\n---\n\n# Page\n\nRewritten.\n",
        })
      ).status,
    ).toBe(204);

    expect(JSON.parse(await readFile(path.join(siteDir, "_queue.json"), "utf8"))).toEqual([
      { op: "publish", id: "doc_broker" },
    ]);
    expect(await readFile(path.join(siteDir, "page.md"), "utf8")).toMatch(/^updated: /m);
  });

  // Grants pin the flow's capability digest: a graph that came to declare
  // more, edited outside the app, asks again for everything.
  it("a flow edited to declare more after a grant needs granting again", async () => {
    const write = { kind: "flow", path: "writer.flow.html", targetPath: "written.md", content: "again\n" };
    expect((await post("write", write)).status).toBe(204);
    await writeFile(path.join(testServer.spaceRoot, "writer.flow.html"), writerFlow("written.md", true));
    expect((await post("write", write)).status).toBe(403);
    expect(
      (await post("grant", { kind: "flow", path: "writer.flow.html", capabilityKey: "writeDocument:space:written.md" }))
        .status,
    ).toBe(204);
    expect((await post("write", write)).status).toBe(204);
  });
});

// Libraries (docs/architecture.md's Space identity and state ownership). Neither
// invariant here is visible from the library routes alone. The library routes
// never write into a library's folder — the two writes they offer change the
// registry entry.
//
// No *other* route can be talked into writing into a registered library
// unless its entry says read-write. A read-only permission rests on this, so
// it's asserted against a real library folder outside the space rather than
// assumed from the absence of a write route.
describe("API contract — libraries", () => {
  let testServer: TestServer;
  let libraryRoot: string;
  let libraryPath: string;
  let imageBytes: Buffer;
  let videoBytes: Buffer;

  beforeAll(async () => {
    testServer = await startTestServer();
    libraryRoot = await mkdtemp(path.join(tmpdir(), "pragma-test-library-"));
    libraryPath = path.join(libraryRoot, "note.md");
    await writeFile(libraryPath, "original\n", "utf8");
    // A real 1x1 PNG: the raw-file route serves bytes and sets a media type
    // from the extension, so the fixture has to be openable as an image.
    imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await mkdir(path.join(libraryRoot, "stills"), { recursive: true });
    await writeFile(path.join(libraryRoot, "stills", "frame.png"), imageBytes);
    // Never decoded by anything under test — the route serves bytes and
    // names a type from the extension — so a recognizable byte ladder is a
    // better fixture than a real clip, and every range assertion below can
    // say which bytes it expected.
    videoBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    await writeFile(path.join(libraryRoot, "takes", "take.mp4"), videoBytes).catch(async () => {
      await mkdir(path.join(libraryRoot, "takes"), { recursive: true });
      await writeFile(path.join(libraryRoot, "takes", "take.mp4"), videoBytes);
    });
    await writeFile(path.join(testServer.spaceRoot, "clip.mp4"), videoBytes);
    await writeFile(path.join(libraryRoot, "paper.pdf"), PDF_BYTES);
    await writeFile(path.join(testServer.spaceRoot, "paper.pdf"), PDF_BYTES);
    // One of every kind, to pin down what the phase filter lists.
    for (const name of ["shots.table.html", "grade.flow.html", "tool.applet.html"]) {
      await writeFile(path.join(libraryRoot, name), "", "utf8");
    }
    // A folder holding nothing this phase lists, to pin down pruning.
    await mkdir(path.join(libraryRoot, "graphs"), { recursive: true });
    await writeFile(path.join(libraryRoot, "graphs", "b.flow.html"), "", "utf8");
    await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
  });

  // Declared in the space, each folder on the space's entry in the test
  // server's throwaway config: merged, not replaced, since startTestServer
  // registered the space there and grants key off the id it minted.
  async function registerLibraries(libraries: LibraryEntry[]): Promise<void> {
    giveSpaceLibraries(testServer.configDir, testServer.spaceRoot, libraries);
  }

  afterAll(async () => {
    await testServer.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("lists registered libraries and walks one rooted at its own path", async () => {
    const list = await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json();
    expect(list).toEqual({
      libraries: [{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only", missing: false }],
    });

    // Paths come back relative to the library's own root, not the space's.
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree`)).json()) as SpaceTreeNode[];
    const stills = tree.find((node) => node.name === "stills");
    expect(stills?.path).toBe("stills");
    expect(stills?.children).toEqual([{ name: "frame.png", path: "stills/frame.png", type: "file" }]);
  });

  // A path-free write: an id and a string, as the label's route is.
  it("describes a library in the space's file, a blank description taking it away", async () => {
    const describe = (id: string, body: unknown) =>
      fetch(`${testServer.baseUrl}/api/space/libraries/${id}/description`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const listed = async () => (await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json()).libraries;

    expect((await describe("lib", { description: "  Stills and clips  " })).status).toBe(204);
    expect((await listed())[0].description).toBe("Stills and clips");
    expect((await describe("lib", { description: 1 })).status).toBe(400);
    expect((await describe("nope", { description: "x" })).status).toBe(404);
    expect((await describe("lib", { description: "" })).status).toBe(204);
    expect((await listed())[0]).not.toHaveProperty("description");
  });

  // The Libraries panel lists a library a folder at a time: one folder's
  // own entries, its subfolders unlisted until they are asked for.
  it("lists one folder's own entries, paths still from the library's root", async () => {
    const listed = async (query: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree?${query}`)).json()) as SpaceTreeNode[];

    expect(await listed("dir=stills&depth=1")).toEqual([{ name: "frame.png", path: "stills/frame.png", type: "file" }]);
    const top = await listed("depth=1");
    expect(top.find((node) => node.name === "stills")).toEqual({ name: "stills", path: "stills", type: "directory" });
  });

  it("refuses a folder outside the library, under a dot, or not there", async () => {
    const status = async (dir: string) =>
      (await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree?depth=1&dir=${encodeURIComponent(dir)}`)).status;

    expect(await status("../escape")).toBeGreaterThanOrEqual(400);
    expect(await status(".hidden")).toBe(404);
    expect(await status("nowhere")).toBe(404);
    expect(await status("note.md")).toBe(400);
  });

  // Equal versions mean nothing changed; the tree carries the version it was
  // read at, so a client knows which changes its copy already reflects.
  it("names each tree's version, and the space's tree carries its own", async () => {
    const tree = await fetch(`${testServer.baseUrl}/api/space/tree`);
    const read = tree.headers.get("X-Pragma-Changes");
    expect(read).toBeTruthy();
    const changes = (await (await fetch(`${testServer.baseUrl}/api/space/changes?library=lib`)).json()) as {
      space: string;
      library?: string;
    };
    expect(changes.space).toBe(read);
    expect(changes.library).toBeTruthy();
    // A library's listing carries its own version the same way.
    const listing = await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree?depth=1`);
    expect(listing.headers.get("X-Pragma-Changes")).toBe(changes.library);

    expect((await fetch(`${testServer.baseUrl}/api/space/changes?library=nope`)).status).toBe(404);
  });

  // What a client compares against the revision its open copy was read at.
  it("answers each named file's revision as a read does: null once it's gone, nothing for a root it can't read", async () => {
    const followed = path.join(testServer.spaceRoot, "followed.md");
    const files = async (...paths: string[]) => {
      const query = paths.map((each) => `file=${encodeURIComponent(each)}`).join("&");
      const response = await fetch(`${testServer.baseUrl}/api/space/changes?${query}`);
      return ((await response.json()) as { files?: Record<string, string | null> }).files;
    };
    const revisionRead = async (filePath: string) => {
      const response = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(filePath)}`);
      return ((await response.json()) as { revision: string }).revision;
    };

    await writeFile(followed, "one", "utf8");
    try {
      expect(await files("followed.md", "lib:lib/note.md", "gone.md", "lib:nope/x.md")).toEqual({
        "followed.md": await revisionRead("followed.md"),
        "lib:lib/note.md": await revisionRead("lib:lib/note.md"),
        "gone.md": null,
      });

      await writeFile(followed, "two words", "utf8");
      expect((await files("followed.md"))?.["followed.md"]).toBe(await revisionRead("followed.md"));

      await rm(followed);
      expect(await files("followed.md")).toEqual({ "followed.md": null });
    } finally {
      await rm(followed, { force: true });
    }
  });

  it("moves the space's version when a file appears in it", async () => {
    const version = async () =>
      ((await (await fetch(`${testServer.baseUrl}/api/space/changes`)).json()) as { space: string }).space;
    const before = await version();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(testServer.spaceRoot, "appeared.md"), "", "utf8");
    try {
      await vi.waitFor(async () => expect(await version()).not.toBe(before), { timeout: 3000, interval: 50 });
    } finally {
      await rm(path.join(testServer.spaceRoot, "appeared.md"), { force: true });
    }
  });

  // The first phase lists only kinds whose pane can render them read-only:
  // flows and applets have no reading view.
  it("lists only the kinds it can show read-only", async () => {
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree`)).json()) as SpaceTreeNode[];
    const names = tree.map((node) => node.name).sort();

    expect(names).toContain("note.md");
    expect(names).toContain("shots.table.html");
    expect(names).toContain("stills");

    expect(names).not.toContain("grade.flow.html");
    expect(names).not.toContain("tool.applet.html");
    // A folder whose every child was filtered out is dropped, rather than
    // showing as a row that opens onto nothing.
    expect(names).not.toContain("graphs");
  });

  // A folder made through a writable library's tree starts empty, and has to
  // survive the re-read that follows or it vanishes before anything goes in.
  it("keeps empty folders in a writable library, and prunes them in a read-only one", async () => {
    await mkdir(path.join(libraryRoot, "fresh"), { recursive: true });
    const names = async () =>
      ((await (await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree`)).json()) as SpaceTreeNode[]).map(
        (node) => node.name,
      );
    try {
      expect(await names()).not.toContain("fresh");
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-write" }]);
      const writable = await names();
      expect(writable).toContain("fresh");
      expect(writable).toContain("graphs");
    } finally {
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
      await rm(path.join(libraryRoot, "fresh"), { recursive: true, force: true });
    }
  });

  // The space tree keeps listing everything — the filter is the library
  // walk's, not a narrowing of what a space shows.
  it("still lists every kind in the space's own tree", async () => {
    await writeFile(path.join(testServer.spaceRoot, "tool.applet.html"), "", "utf8");
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    const kinds = JSON.stringify(tree);
    expect(kinds).toMatch(/\.applet\.html/);
  });

  it("reads a library document, without the space's toolkit machinery", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent("lib:lib/note.md")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; path: string; content: string; toolkits: unknown[] };
    expect(body.kind).toBe("text");
    expect(body.path).toBe("lib:lib/note.md");
    expect(body.content).toBe("original\n");
    // Toolkits come from the space's own Classes, which never hold a
    // library's document.
    expect(body.toolkits).toEqual([]);
  });

  // /api/file/raw is the first route to take a rooted path (lib:<id>/…), so
  // these cover both halves of that: a library image really is served, and a
  // bare path still means the space exactly as before.
  it("serves a library image through the raw-file route", async () => {
    const res = await fetch(
      `${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/stills/frame.png")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(imageBytes)).toBe(true);

    const head = await fetch(
      `${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/stills/frame.png")}`,
      {
        method: "HEAD",
      },
    );
    expect(head.headers.get("content-length")).toBe(String(imageBytes.length));
  });

  it("sandboxes every raw file, so a space SVG opened as a page can't script the app or load anything", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "payload.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/space/tree")</script></svg>',
    );
    await writeFile(path.join(testServer.spaceRoot, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const raw = (name: string) => `${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent(name)}`;
    const vectorImagePolicy = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

    const whole = await fetch(raw("payload.svg"));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/svg+xml");
    expect(whole.headers.get("content-security-policy")).toBe(vectorImagePolicy);

    const partial = await fetch(raw("payload.svg"), { headers: { range: "bytes=0-9" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-security-policy")).toBe(vectorImagePolicy);

    // No other kind can request anything by itself, so the sandbox is all it gets.
    expect((await fetch(raw("photo.png"))).headers.get("content-security-policy")).toBe("sandbox");
  });

  it("answers a rooted path that names no library, or escapes one", async () => {
    const unknown = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:nope/x.png")}`);
    expect(unknown.status).toBe(404);

    // Rejected while parsing, before any root is consulted.
    const traversal = await fetch(
      `${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/../../etc/passwd")}`,
    );
    expect(traversal.status).toBe(400);

    const unknownScheme = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("ftp:x/y.png")}`);
    expect(unknownScheme.status).toBe(400);
  });

  // A library exists for media too heavy to sit in a space, so a video has
  // to be listed by the walk that decides what a library shows at all.
  it("lists a video in both a library's tree and the space's own", async () => {
    const library = (await (
      await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree`)
    ).json()) as SpaceTreeNode[];
    const takes = library.find((node) => node.name === "takes");
    expect(takes?.children).toEqual([{ name: "take.mp4", path: "takes/take.mp4", type: "file" }]);

    const space = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    expect(space.map((node) => node.name)).toContain("clip.mp4");
  });

  // Range support is what separates a player that seeks from one that
  // downloads a take before it starts. Asserted against the route rather
  // than the parser because the headers are the contract, not the maths.
  it("serves a video whole, and answers a byte range with just that window", async () => {
    const url = `${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/takes/take.mp4")}`;

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("content-length")).toBe("256");
    // Advertised before anything is asked for: it is how a player learns it
    // may seek at all.
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await whole.arrayBuffer()).equals(videoBytes)).toBe(true);

    const window = await fetch(url, { headers: { range: "bytes=10-19" } });
    expect(window.status).toBe(206);
    expect(window.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(window.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await window.arrayBuffer()).equals(videoBytes.subarray(10, 20))).toBe(true);

    // An open end runs to the last byte; a suffix asks for the tail, which
    // is how a player finds an MP4's index.
    const openEnded = await fetch(url, { headers: { range: "bytes=250-" } });
    expect(openEnded.headers.get("content-range")).toBe("bytes 250-255/256");
    expect(Buffer.from(await openEnded.arrayBuffer()).equals(videoBytes.subarray(250))).toBe(true);

    const tail = await fetch(url, { headers: { range: "bytes=-6" } });
    expect(tail.headers.get("content-range")).toBe("bytes 250-255/256");
    expect(Buffer.from(await tail.arrayBuffer()).equals(videoBytes.subarray(250))).toBe(true);

    // Past the end is the one case that owes a 416; a range this server
    // does not understand is answered with the whole file instead.
    const beyond = await fetch(url, { headers: { range: "bytes=500-600" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */256");

    const multipart = await fetch(url, { headers: { range: "bytes=0-9, 20-29" } });
    expect(multipart.status).toBe(200);
    expect(multipart.headers.get("content-length")).toBe("256");

    const head = await fetch(url, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("256");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  // The route names a type from the extension and never sniffs the bytes,
  // so a container no browser decodes is refused by name rather than served
  // as something a player would choke on.
  // A restored tab or an embed may name a file that has since gone: the
  // file's state, not the server's failure.
  it("answers 404 for a media file that is not there", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/takes/gone.mp4")}`);
    expect(res.status).toBe(404);
    const head = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("gone.png")}`, {
      method: "HEAD",
    });
    expect(head.status).toBe(404);
  });

  it("hashes any file's whole bytes, in a library or the space, and refuses a folder", async () => {
    for (const [target, bytes] of [
      ["lib:lib/takes/take.mp4", videoBytes],
      ["lib:lib/stills/frame.png", imageBytes],
      ["clip.mp4", videoBytes],
    ] as const) {
      const res = await fetch(`${testServer.baseUrl}/api/file/sha256?path=${encodeURIComponent(target)}`);
      expect(res.status, target).toBe(200);
      expect(await res.json(), target).toEqual({ sha256: createHash("sha256").update(bytes).digest("hex") });
    }

    const text = await fetch(`${testServer.baseUrl}/api/file/sha256?path=${encodeURIComponent("lib:lib/note.md")}`);
    expect(await text.json()).toEqual({
      sha256: createHash("sha256")
        .update(await readFile(libraryPath))
        .digest("hex"),
    });

    const gone = await fetch(`${testServer.baseUrl}/api/file/sha256?path=${encodeURIComponent("gone.png")}`);
    expect(gone.status).toBe(404);
    const folder = await fetch(`${testServer.baseUrl}/api/file/sha256?path=${encodeURIComponent("lib:lib/takes")}`);
    expect(folder.status).toBe(400);
    const escaping = await fetch(
      `${testServer.baseUrl}/api/file/sha256?path=${encodeURIComponent("lib:lib/../../etc/passwd")}`,
    );
    expect(escaping.ok).toBe(false);
  });

  it("reads a raster image's pixel format from its header, and refuses what has none", async () => {
    const format = async (target: string) =>
      fetch(`${testServer.baseUrl}/api/file/pixel-format?path=${encodeURIComponent(target)}`);

    const still = await format("lib:lib/stills/frame.png");
    expect(still.status).toBe(200);
    expect(await still.json()).toEqual({ colorModel: "rgb", alpha: true, bitDepth: 8, sourceType: null });

    // Read by its signature, as a browser reads it: a JPEG saved as .png
    // reads as the JPEG it is.
    const frame = Buffer.alloc(19);
    frame.set([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
    const named = Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xda, 0x00, 0x02])]);
    await writeFile(path.join(testServer.spaceRoot, "photo.png"), named);
    expect(await (await format("photo.png")).json()).toEqual({
      colorModel: "rgb",
      alpha: false,
      bitDepth: 8,
      sourceType: null,
    });

    // A vector and a video have no pixel format; a damaged header has one
    // this can't read, which is not the same as the file being gone.
    await writeFile(path.join(testServer.spaceRoot, "logo.svg"), "<svg/>");
    expect((await format("logo.svg")).status).toBe(400);
    expect((await format("clip.mp4")).status).toBe(400);
    await writeFile(path.join(testServer.spaceRoot, "broken.png"), "not a png");
    expect((await format("broken.png")).status).toBe(422);
    expect((await format("gone.png")).status).toBe(404);
    expect((await format("lib:lib/../../etc/passwd")).ok).toBe(false);
  });

  it("reads a video's codec and frame rate from its header, and refuses what isn't one", async () => {
    const format = async (target: string) =>
      fetch(`${testServer.baseUrl}/api/file/video-format?path=${encodeURIComponent(target)}`);

    await writeFile(path.join(testServer.spaceRoot, "take.mov"), isoVideo({ codec: "apch", dataBefore: 4096 }));
    const take = await format("take.mov");
    expect(take.status).toBe(200);
    // The whole of what the header says, for the video pane's Info: ProRes 422's
    // depth from its flavor, the audio track the fixture carries.
    expect(await take.json()).toEqual({
      codec: "ProRes 422 HQ",
      frameRate: 25,
      variableFrameRate: false,
      bitDepth: 10,
      hdr: null,
      alpha: false,
      audio: { codec: "AAC", channels: null },
      startTimecode: null,
      width: null,
      height: null,
      duration: null,
    });

    expect((await format("lib:lib/stills/frame.png")).status).toBe(400);
    // The byte-ladder clip has no container header at all.
    expect((await format("clip.mp4")).status).toBe(422);
    expect((await format("gone.mp4")).status).toBe(404);
    expect((await format("lib:lib/../../etc/passwd")).ok).toBe(false);
  });

  // The gallery's listing. A read, so a read-only library lists like any
  // folder; and one folder only, so a folder holding nothing listable stays
  // rather than being walked to find that out.
  it("lists one folder's own entries with their size, time and version", async () => {
    const list = async (target: string) =>
      fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent(target)}`);
    const gallery = path.join(libraryRoot, "gallery");
    await mkdir(path.join(gallery, "sub"), { recursive: true });
    await writeFile(path.join(gallery, "b.png"), imageBytes);
    await writeFile(path.join(gallery, "a.md"), "note\n", "utf8");
    await writeFile(path.join(gallery, ".hidden.png"), imageBytes);
    await writeFile(path.join(gallery, "graph.flow.html"), "", "utf8");
    await symlink(path.join(libraryRoot, "stills", "frame.png"), path.join(gallery, "linked.png"));
    try {
      const listed = await list("lib:lib/gallery");
      expect(listed.status).toBe(200);
      const { entries } = (await listed.json()) as FolderListingResponse;
      expect(entries.map((entry) => entry.name)).toEqual(["sub", "a.md", "b.png"]);
      expect(entries[2]).toEqual({
        name: "b.png",
        path: "lib:lib/gallery/b.png",
        type: "file",
        size: imageBytes.length,
        modified: expect.any(String),
        version: expect.stringMatching(/^\d+-\d+$/),
        thumbnail: false,
      });
      expect(entries[0]).toMatchObject({ path: "lib:lib/gallery/sub", type: "directory", size: 0 });

      const space = await list("");
      expect(space.status).toBe(200);
      expect(((await space.json()) as FolderListingResponse).entries.some((entry) => entry.path === "clip.mp4")).toBe(
        true,
      );

      expect((await list("lib:lib/gallery/b.png")).status).toBe(400);
      expect((await list("lib:lib/nowhere")).status).toBe(404);
      expect((await list("lib:lib/../../etc")).ok).toBe(false);
      const posted = await fetch(`${testServer.baseUrl}/api/space/folder?path=`, { method: "POST" });
      expect(posted.status).toBe(405);
    } finally {
      await rm(gallery, { recursive: true, force: true });
    }
  });

  // How a folder's gallery lists on this install is host state, in any
  // root: a read-only library takes a sort, nothing in it changes, and its
  // tree keeps listing it by name.
  it("lists a folder in the sort this install picked for it", async () => {
    const list = async (target: string) =>
      (await (
        await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent(target)}`)
      ).json()) as FolderListingResponse;
    const pick = (dir: string, sort: unknown, arrangement?: unknown) =>
      fetch(`${testServer.baseUrl}/api/space/local-sort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir, sort, arrangement }),
      });
    const sorted = path.join(libraryRoot, "sorted");
    await mkdir(path.join(sorted, "sub"), { recursive: true });
    await writeFile(path.join(sorted, "a.md"), "note\n", "utf8");
    await writeFile(path.join(sorted, "b.png"), imageBytes);
    const before = (await readdir(libraryRoot, { recursive: true })).sort();
    try {
      expect((await pick("lib:lib/sorted", { by: "name", order: "desc" })).status).toBe(204);
      const listed = await list("lib:lib/sorted");
      expect(listed.entries.map((entry) => entry.name)).toEqual(["sub", "b.png", "a.md"]);
      expect(listed.order).toEqual({
        default: { by: "name", order: "asc" },
        local: { by: "name", order: "desc" },
      });
      const rows = (await (
        await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree?depth=1&dir=sorted`)
      ).json()) as SpaceTreeNode[];
      expect(rows.map((node) => node.name)).toEqual(["sub", "a.md", "b.png"]);
      expect((await readdir(libraryRoot, { recursive: true })).sort()).toEqual(before);

      expect((await pick("lib:lib/sorted", null)).status).toBe(204);
      expect((await list("lib:lib/sorted")).order).toEqual({ default: { by: "name", order: "asc" } });

      expect((await pick("lib:lib/sorted", { by: "colour" })).status).toBe(400);
      expect((await pick("lib:lib/sorted", null, "a.md")).status).toBe(400);
      expect((await pick("lib:lib/sorted/a.md", null)).status).toBe(400);
      expect((await pick("lib:lib/nowhere", null)).status).toBe(404);
      expect((await pick("lib:lib/../../etc", null)).ok).toBe(false);
    } finally {
      await rm(sorted, { recursive: true, force: true });
    }
  });

  // A folder's layout is host state beside its sort, in any root. While it
  // shows cards, its listing says so and carries each entry's description,
  // or a note's opening where it has none.
  it("lists a folder as cards, with what each entry says of itself, once this install picks cards", async () => {
    const list = async (target: string) =>
      (await (
        await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent(target)}`)
      ).json()) as FolderListingResponse;
    const lay = (dir: string, layout: unknown) =>
      fetch(`${testServer.baseUrl}/api/space/folder-layout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir, layout }),
      });
    const carded = path.join(testServer.spaceRoot, "carded");
    await mkdir(path.join(carded, "act"), { recursive: true });
    await writeFile(path.join(carded, "act", "README.md"), "---\ndescription: The first act.\n---\n", "utf8");
    await writeFile(path.join(carded, "open.fountain"), "= A door opens.\n\nINT. ROOM - DAY\n", "utf8");
    await writeFile(path.join(carded, "lina.md"), "---\ndescription: The lead.\n---\n# Lina\n\nShe asks.\n", "utf8");
    await writeFile(path.join(carded, "notes.md"), "# Notes\n\nThe door was **never** locked.\n", "utf8");
    await writeFile(path.join(carded, "still.png"), imageBytes);
    try {
      const tiles = await list("carded");
      expect(tiles.layout).toBeUndefined();
      expect(tiles.entries.some((entry) => entry.description !== undefined || entry.excerpt !== undefined)).toBe(false);

      expect((await lay("carded", "cards")).status).toBe(204);
      const cards = await list("carded");
      expect(cards.layout).toBe("cards");
      expect(cards.entries.map((entry) => [entry.name, entry.description, entry.excerpt])).toEqual([
        ["act", "The first act.", undefined],
        ["lina.md", "The lead.", undefined],
        ["notes.md", undefined, "The door was never locked."],
        ["open.fountain", "A door opens.", undefined],
        ["still.png", undefined, undefined],
      ]);

      // A sort picked here keeps the folder's layout.
      const sorted = await fetch(`${testServer.baseUrl}/api/space/local-sort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: "carded", sort: { by: "name", order: "desc" } }),
      });
      expect(sorted.status).toBe(204);
      expect((await list("carded")).layout).toBe("cards");

      expect((await lay("carded", "tiles")).status).toBe(204);
      expect((await list("carded")).layout).toBeUndefined();

      expect((await lay("lib:lib/stills", "cards")).status).toBe(204);
      expect((await list("lib:lib/stills")).layout).toBe("cards");
      expect((await lay("lib:lib/stills", "tiles")).status).toBe(204);

      expect((await lay("carded", "list")).status).toBe(400);
      expect((await lay("carded/open.fountain", "cards")).status).toBe(400);
      expect((await lay("nowhere", "cards")).status).toBe(404);
      expect((await lay("../etc", "cards")).ok).toBe(false);
    } finally {
      await rm(carded, { recursive: true, force: true });
    }
  });

  // A Table's layout is host state too, in any root: picking one never
  // writes the file, and picking the one the file names keeps nothing. It
  // follows a move and goes with a delete.
  it("opens a Table in the layout this install picked, through a move, until it is deleted", async () => {
    const open = async (target: string) =>
      (await (
        await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(target)}`)
      ).json()) as TableFileResponse;
    const post = (route: string, body: unknown) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const lay = (target: string, layout: unknown) => post("/api/space/table-layout", { path: target, layout });
    const table = (layout?: "cards") =>
      serializeTableFile({
        version: "1.0",
        name: "Shots",
        columns: [{ id: "take", label: "Take", type: "text" }],
        rows: [{ values: { take: "BR2-001" } }],
        layout,
      });
    const laid = path.join(testServer.spaceRoot, "laid");
    await mkdir(laid);
    await writeFile(path.join(laid, "shots.table.html"), table(), "utf8");
    await writeFile(path.join(laid, "board.table.html"), table("cards"), "utf8");
    try {
      expect((await open("laid/shots.table.html")).localLayout).toBeUndefined();
      expect((await lay("laid/shots.table.html", "cards")).status).toBe(204);
      expect((await open("laid/shots.table.html")).localLayout).toBe("cards");
      expect(await readFile(path.join(laid, "shots.table.html"), "utf8")).toBe(table());

      expect((await lay("laid/board.table.html", "list")).status).toBe(204);
      expect((await open("laid/board.table.html")).localLayout).toBe("list");
      expect((await lay("laid/board.table.html", "cards")).status).toBe(204);
      expect((await open("laid/board.table.html")).localLayout).toBeUndefined();

      const moved = await post("/api/space/move", { from: "laid/shots.table.html", to: "laid/takes.table.html" });
      expect(moved.status).toBe(200);
      expect((await open("laid/takes.table.html")).localLayout).toBe("cards");
      expect((await post("/api/space/delete", { path: "laid/takes.table.html" })).status).toBe(200);
      await writeFile(path.join(laid, "takes.table.html"), table(), "utf8");
      expect((await open("laid/takes.table.html")).localLayout).toBeUndefined();

      const libraryTable = await readFile(path.join(libraryRoot, "shots.table.html"), "utf8");
      expect((await lay("lib:lib/shots.table.html", "cards")).status).toBe(204);
      expect((await open("lib:lib/shots.table.html")).localLayout).toBe("cards");
      expect((await lay("lib:lib/shots.table.html", "list")).status).toBe(204);
      expect((await open("lib:lib/shots.table.html")).localLayout).toBeUndefined();
      expect(await readFile(path.join(libraryRoot, "shots.table.html"), "utf8")).toBe(libraryTable);

      expect((await lay("laid/board.table.html", "tiles")).status).toBe(400);
      expect((await lay("laid", "cards")).status).toBe(400);
      expect((await lay("laid/gone.table.html", "cards")).status).toBe(404);
      expect((await lay("../etc/x.table.html", "cards")).ok).toBe(false);
    } finally {
      await rm(laid, { recursive: true, force: true });
    }
  });

  // Only a space's Table, and an id as the rule spells one: the Flows are
  // listed first, and written only when the change is applied.
  it("changes a Table column's id in the Flows naming it, listing them first", async () => {
    const change = (body: unknown) =>
      fetch(`${testServer.baseUrl}/api/space/table-column-id`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const dir = path.join(testServer.spaceRoot, "ids");
    await mkdir(dir);
    const flow = path.join(dir, "log.flow.html");
    await writeFile(
      path.join(dir, "shots.table.html"),
      serializeTableFile({ version: "1.0", columns: [{ id: "take", label: "Take", type: "text" }], rows: [] }),
      "utf8",
    );
    await writeFile(
      flow,
      serializeFlowFile({
        version: "1.0",
        name: "Log",
        graph: {
          nodes: [
            {
              id: "fields",
              type: "makeObject",
              position: { x: 0, y: 0 },
              config: { tablePath: "shots.table.html", columns: [{ id: "take", label: "Take", type: "text" }] },
            },
          ],
          edges: [],
        },
      }),
      "utf8",
    );
    try {
      const body = { path: "ids/shots.table.html", from: "take", to: "shot" };
      const listed = await change({ ...body, apply: false });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ flows: ["ids/log.flow.html"] });
      expect(await readFile(flow, "utf8")).toContain('"id":"take"');

      expect((await change({ ...body, to: "Shot Size", apply: false })).status).toBe(400);
      expect((await change({ ...body, to: "", apply: false })).status).toBe(400);
      expect((await change({ ...body, path: "ids/log.flow.html", apply: false })).status).toBe(400);

      const applied = await change({ ...body, apply: true });
      expect(await applied.json()).toEqual({ flows: ["ids/log.flow.html"] });
      expect(await readFile(flow, "utf8")).toContain('"id":"shot"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Whether a Flow shows App mode is host state too, in any root: switching
  // never writes the file, and the view the file opens in keeps nothing. It
  // follows a move and goes with a delete.
  it("opens a Flow in the App mode this install picked, through a move, until it is deleted", async () => {
    const open = async (target: string) =>
      (await (
        await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(target)}`)
      ).json()) as FlowFileResponse;
    const post = (route: string, body: unknown) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const switchTo = (target: string, appMode: unknown) => post("/api/space/flow-app-mode", { path: target, appMode });
    const flow = (appModeActive?: true) =>
      serializeFlowFile({ version: "1.0", name: "Brief", graph: { nodes: [], edges: [], appModeActive } });
    const moded = path.join(testServer.spaceRoot, "moded");
    await mkdir(moded);
    await writeFile(path.join(moded, "brief.flow.html"), flow(), "utf8");
    await writeFile(path.join(moded, "form.flow.html"), flow(true), "utf8");
    try {
      expect((await open("moded/brief.flow.html")).localAppMode).toBeUndefined();
      expect((await switchTo("moded/brief.flow.html", true)).status).toBe(204);
      expect((await open("moded/brief.flow.html")).localAppMode).toBe(true);
      expect(await readFile(path.join(moded, "brief.flow.html"), "utf8")).toBe(flow());

      expect((await switchTo("moded/form.flow.html", false)).status).toBe(204);
      expect((await open("moded/form.flow.html")).localAppMode).toBe(false);
      expect((await switchTo("moded/form.flow.html", true)).status).toBe(204);
      expect((await open("moded/form.flow.html")).localAppMode).toBeUndefined();

      const moved = await post("/api/space/move", { from: "moded/brief.flow.html", to: "moded/draft.flow.html" });
      expect(moved.status).toBe(200);
      expect((await open("moded/draft.flow.html")).localAppMode).toBe(true);
      expect((await post("/api/space/delete", { path: "moded/draft.flow.html" })).status).toBe(200);
      await writeFile(path.join(moded, "draft.flow.html"), flow(), "utf8");
      expect((await open("moded/draft.flow.html")).localAppMode).toBeUndefined();

      expect((await switchTo("moded/form.flow.html", "yes")).status).toBe(400);
      expect((await switchTo("moded", true)).status).toBe(400);
      expect((await switchTo("moded/gone.flow.html", true)).status).toBe(404);
      expect((await switchTo("../etc/x.flow.html", true)).ok).toBe(false);
    } finally {
      await rm(moded, { recursive: true, force: true });
    }
  });

  // The tree lists a folder in its own order: a drag there writes its
  // `_structure.json`, and a sort picked for its gallery shows only there.
  it("arranges a space folder in its tree, and keeps a renamed entry's place", async () => {
    const scenes = path.join(testServer.spaceRoot, "arranged");
    await mkdir(scenes);
    for (const name of ["a.md", "b.md", "c.md"]) await writeFile(path.join(scenes, name), "", "utf8");
    const post = (route: string, body: unknown) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const children = async () => {
      const tree = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
      return tree.find((node) => node.path === "arranged")?.children?.map((child) => child.name);
    };
    try {
      expect((await post("/api/space/order", { dir: "arranged", order: ["c.md", "a.md", "b.md"] })).status).toBe(204);
      expect(await children()).toEqual(["c.md", "a.md", "b.md"]);
      expect(existsSync(path.join(scenes, "_structure.json"))).toBe(true);

      const gallery = await post("/api/space/local-sort", { dir: "arranged", sort: { by: "name", order: "desc" } });
      expect(gallery.status).toBe(204);
      expect(await children()).toEqual(["c.md", "a.md", "b.md"]);

      expect((await post("/api/space/move", { from: "arranged/a.md", to: "arranged/z.md" })).status).toBe(200);
      expect(await children()).toEqual(["c.md", "z.md", "b.md"]);
    } finally {
      await rm(scenes, { recursive: true, force: true });
    }
  });

  // Thumbnails are host state: one stored for a read-only library's file
  // lands in the install's cache, and the library is left as it was.
  it("keeps a client-rendered thumbnail outside the library and serves it back", async () => {
    const target = "lib:lib/stills/frame.png";
    const url = (rooted: string, query = "") =>
      `${testServer.baseUrl}/api/file/thumbnail?path=${encodeURIComponent(rooted)}${query}`;
    const listedNow = async () => {
      const listed = await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent("lib:lib/stills")}`);
      return ((await listed.json()) as FolderListingResponse).entries[0];
    };
    const versionNow = async () => (await listedNow()).version;
    // What the browser that made it decoded of the file: its size, here at
    // ten times the thumbnail's, and a video's duration.
    const put = (bytes: Buffer, version: string, rooted = target, facts = "&width=640&height=480") =>
      fetch(url(rooted, `&version=${encodeURIComponent(version)}${facts}`), {
        method: "PUT",
        body: new Uint8Array(bytes),
      });
    const before = (await readdir(libraryRoot, { recursive: true })).sort();

    expect((await fetch(url(target))).status).toBe(404);
    expect((await listedNow()).thumbnail).toBe(false);
    expect((await listedNow()).width).toBeUndefined();
    const version = await versionNow();
    expect((await put(webpHeader(64, 48), version)).status).toBe(204);
    expect(await listedNow()).toMatchObject({ thumbnail: true, width: 640, height: 480 });
    // With it, what the host read of the picture's header: its pixels, and no
    // source type here.
    expect((await listedNow()).picture).toEqual({
      sourceType: null,
      pixels: { colorModel: "rgb", alpha: true, bitDepth: 8 },
    });

    const served = await fetch(url(target));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(webpHeader(64, 48));
    const etag = served.headers.get("etag") ?? "";
    expect((await fetch(url(target), { headers: { "if-none-match": etag } })).status).toBe(304);

    expect((await readdir(libraryRoot, { recursive: true })).sort()).toEqual(before);
    expect(existsSync(path.join(testServer.configDir, "cache", "thumbnails"))).toBe(true);

    // Rendered from bytes that have since changed, too large, or not an
    // image at all; a file with no thumbnail kind; a version that isn't one.
    expect((await put(webpHeader(64, 48), "1-2")).status).toBe(409);
    expect((await put(webpHeader(1024, 10), version, target, "&width=1024&height=10")).status).toBe(422);
    // Facts missing or malformed, and facts of another shape than the
    // thumbnail's: a portrait claim for a landscape picture.
    expect((await put(webpHeader(64, 48), version, target, "")).status).toBe(400);
    expect((await put(webpHeader(64, 48), version, target, "&width=640&height=480&duration=soon")).status).toBe(400);
    expect((await put(webpHeader(64, 48), version, target, "&width=480&height=640")).status).toBe(422);
    expect((await put(Buffer.from("not an image"), version)).status).toBe(422);
    expect((await put(webpHeader(8, 8), version, "lib:lib/note.md")).status).toBe(400);
    expect((await put(webpHeader(8, 8), version, "lib:lib/paper.pdf")).status).toBe(400);
    expect((await put(webpHeader(8, 8), "latest")).status).toBe(400);
    expect((await fetch(url(target), { method: "POST" })).status).toBe(405);
    expect((await fetch(url("lib:lib/../../etc/passwd"))).ok).toBe(false);

    // A changed file has no thumbnail until one is made from it.
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(libraryRoot, "stills", "frame.png"), later, later);
    expect((await fetch(url(target))).status).toBe(404);
    expect((await listedNow()).thumbnail).toBe(false);
    expect((await put(webpHeader(32, 32), await versionNow(), target, "&width=32&height=32")).status).toBe(204);
    expect((await fetch(url(target))).status).toBe(200);
    expect(await listedNow()).toMatchObject({ width: 32, height: 32 });

    const take = async () => {
      const listed = await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent("lib:lib/takes")}`);
      return ((await listed.json()) as FolderListingResponse).entries[0];
    };
    const clip = "&width=1920&height=1080&duration=12.5";
    expect((await put(webpHeader(512, 288), (await take()).version, "lib:lib/takes/take.mp4", clip)).status).toBe(204);
    expect(await take()).toMatchObject({ thumbnail: true, width: 1920, height: 1080, duration: 12.5 });
    // A header that doesn't read leaves the clip's details unknown, the thumbnail kept.
    expect((await take()).clip).toMatchObject({ codec: null, frameRate: null, bitDepth: null, audio: null });
  });

  // A clip no browser here decodes: its header's facts stand in for a
  // thumbnail, kept in the install's cache and listed with its entry.
  it("keeps a clip's header facts in place of a thumbnail the browser couldn't make", async () => {
    const folder = path.join(libraryRoot, "prores");
    await mkdir(folder, { recursive: true });
    const clipBytes = isoVideo({
      entry: visualEntry("ap4x", { width: 1188, height: 2112 }),
      timescale: 30_000,
      runs: [[804, 1001]],
      movie: [600, 16_080],
      timecode: { frame: 108_000, fps: 30 },
    });
    await writeFile(path.join(folder, "take.mov"), clipBytes);
    try {
      const listed = async (rooted: string) => {
        const response = await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent(rooted)}`);
        return ((await response.json()) as FolderListingResponse).entries[0];
      };
      const facts = (rooted: string, version: string, method = "POST") =>
        fetch(
          `${testServer.baseUrl}/api/file/thumbnail-facts?path=${encodeURIComponent(rooted)}&version=${encodeURIComponent(version)}`,
          { method },
        );
      const before = await listed("lib:lib/prores");
      expect(before).toMatchObject({ thumbnail: false });
      expect(before.clip).toBeUndefined();

      const answered = await facts("lib:lib/prores/take.mov", before.version);
      expect(answered.status).toBe(200);
      const body = (await answered.json()) as ClipFactsResponse;
      expect(body).toMatchObject({
        width: 1188,
        height: 2112,
        duration: 26.8,
        clip: { codec: "ProRes 4444 XQ", bitDepth: 12, hdr: null, alpha: false, startTimecode: "01:00:00:00" },
      });
      expect(body.clip.frameRate).toBeCloseTo(29.97, 2);
      expect(await listed("lib:lib/prores")).toMatchObject({
        thumbnail: false,
        width: 1188,
        height: 2112,
        clip: body.clip,
      });
      const thumbnail = `${testServer.baseUrl}/api/file/thumbnail?path=${encodeURIComponent("lib:lib/prores/take.mov")}`;
      expect((await fetch(thumbnail)).status).toBe(404);

      // A changed file, a picture, a header that doesn't read, a read.
      expect((await facts("lib:lib/prores/take.mov", "1-2")).status).toBe(409);
      expect((await facts("lib:lib/stills/frame.png", "1-2")).status).toBe(400);
      expect((await facts("lib:lib/takes/take.mp4", (await listed("lib:lib/takes")).version)).status).toBe(422);
      expect((await facts("lib:lib/prores/take.mov", before.version, "GET")).status).toBe(405);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("measures the install's thumbnails and clears them, to be made again", async () => {
    const usage = async () =>
      (await (await fetch(`${testServer.baseUrl}/api/thumbnails`)).json()) as ThumbnailUsageResponse;
    const before = await usage();
    expect(before.count).toBeGreaterThanOrEqual(2);
    expect(before.bytes).toBeGreaterThan(0);

    expect((await fetch(`${testServer.baseUrl}/api/thumbnails/clear`)).status).toBe(405);
    expect((await fetch(`${testServer.baseUrl}/api/thumbnails/clear`, { method: "POST" })).status).toBe(204);
    expect(await usage()).toEqual({ bytes: 0, count: 0 });
    const stills = await fetch(`${testServer.baseUrl}/api/space/folder?path=${encodeURIComponent("lib:lib/stills")}`);
    expect(((await stills.json()) as FolderListingResponse).entries[0]).toMatchObject({ thumbnail: false });
  });

  it("reports name, folder on disk, size and modified time for any entry, file or folder", async () => {
    const info = async (target: string) =>
      fetch(`${testServer.baseUrl}/api/file/info?path=${encodeURIComponent(target)}`);

    const video = await info("lib:lib/takes/take.mp4");
    expect(video.status).toBe(200);
    const body = await video.json();
    expect(body).toMatchObject({
      kind: "file",
      name: "take.mp4",
      size: videoBytes.length,
      systemFolder: path.join(libraryRoot, "takes"),
    });
    expect(Number.isNaN(Date.parse(body.modified))).toBe(false);

    // Not media-only, unlike the raw and hash routes.
    expect(await (await info("lib:lib/note.md")).json()).toMatchObject({ kind: "file" });
    expect(await (await info("lib:lib/takes")).json()).toMatchObject({ kind: "directory", name: "takes" });
    expect(await (await info("clip.mp4")).json()).toMatchObject({
      name: "clip.mp4",
      systemFolder: testServer.spaceRoot,
    });

    // A root's own folder, which its gallery shows.
    for (const [target, root] of [
      ["", testServer.spaceRoot],
      ["lib:lib", libraryRoot],
    ]) {
      expect(await (await info(target)).json(), target).toMatchObject({
        kind: "directory",
        name: path.basename(root),
        systemFolder: path.dirname(root),
      });
    }

    expect((await fetch(`${testServer.baseUrl}/api/file/info`)).status).toBe(400);
    expect((await info("gone.md")).status).toBe(404);
    expect((await info("lib:lib/../../etc/passwd")).ok).toBe(false);
  });

  // Copy path's "from system root" answers for a path with nothing at it, as
  // a chip naming a missing file needs; never for one no root holds.
  it("names where a space or library path sits on disk, whether or not anything is there", async () => {
    const systemPath = async (target: string) => {
      const response = await fetch(`${testServer.baseUrl}/api/file/system-path?path=${encodeURIComponent(target)}`);
      return response.ok ? ((await response.json()) as SystemPathResponse).systemPath : response.status;
    };

    expect(await systemPath("clip.mp4")).toBe(path.join(testServer.spaceRoot, "clip.mp4"));
    expect(await systemPath("lib:lib/takes/take.mp4")).toBe(path.join(libraryRoot, "takes", "take.mp4"));
    expect(await systemPath("lib:lib/takes")).toBe(path.join(libraryRoot, "takes"));
    expect(await systemPath("gone/missing.md")).toBe(path.join(testServer.spaceRoot, "gone", "missing.md"));

    expect((await fetch(`${testServer.baseUrl}/api/file/system-path`)).status).toBe(400);
    expect(await systemPath("lib:nope/a.md")).toBe(404);
    expect(await systemPath(".hidden/a.md")).toBe(404);
    expect(await systemPath("lib:lib/../../etc/passwd")).not.toBeTypeOf("string");
  });

  // The PDF pane hands these bytes to PDF.js in a frame of its own, so the
  // route answers them like any other media: typed by extension, and under
  // the same sandbox a page opened from it gets.
  it("serves a PDF from the space and from a library, and lists it in both", async () => {
    for (const target of ["paper.pdf", "lib:lib/paper.pdf"]) {
      const res = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent(target)}`);
      expect(res.status, target).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
    }
    const library = (await (
      await fetch(`${testServer.baseUrl}/api/space/libraries/lib/tree`)
    ).json()) as SpaceTreeNode[];
    expect(library.map((node) => node.name)).toContain("paper.pdf");
    const space = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    expect(space.map((node) => node.name)).toContain("paper.pdf");
  });

  it("refuses a media format it does not recognize", async () => {
    await writeFile(path.join(libraryRoot, "takes", "take.mkv"), videoBytes);
    const res = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("lib:lib/takes/take.mkv")}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not a recognized image, video, PDF or LUT file");
  });

  // Reading a video as text would build a gigabyte-scale string only to
  // throw it away, and an image would come back mangled. The route refuses
  // both rather than trying.
  it("refuses to read media as text", async () => {
    for (const target of ["clip.mp4", "lib:lib/stills/frame.png", "paper.pdf", "lib:lib/paper.pdf"]) {
      const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(target)}`);
      expect(res.status, target).toBe(400);
      expect(await res.text()).toContain("can't be read as text");
    }
  });

  it("reports a Table's own layout", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "cards.table.html"),
      `<!DOCTYPE html>\n<html data-format="table" data-format-version="1.0" data-id="tbl_cards001"><head><meta charset="utf-8"><title>Cards</title></head><body><dl data-role="metadata"></dl><table data-role="data" data-layout="cards"><thead><tr><th data-field="take" data-type="text">Take</th></tr></thead><tbody><tr><td>one</td></tr></tbody></table></body></html>\n`,
      "utf8",
    );
    const res = await fetch(`${testServer.baseUrl}/api/file?path=cards.table.html`);
    expect(res.status).toBe(200);
    expect((await res.json()).layout).toBe("cards");
  });

  it("an unknown library id is a 404", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/libraries/nope/tree`);
    expect(res.status).toBe(404);
  });

  // The registry's two path-free writes are routes on the same footing as
  // /api/space/label and /api/space/forget: an id already registered plus
  // a value from a closed set, never a filesystem path.
  it("changes a library's access, which the write doorway then honours", async () => {
    const url = `${testServer.baseUrl}/api/space/libraries/lib/access`;
    const setPermission = (body: string) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const putNote = () =>
      fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent("lib:lib/note.md")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "original\n" }),
      });
    try {
      expect((await setPermission(JSON.stringify({ access: "read-write" }))).status).toBe(204);
      const list = ((await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json()) as SpaceLibrariesResponse)
        .libraries;
      expect(list.map((entry) => [entry.id, entry.access])).toEqual([["lib", "read-write"]]);
      // The same rooted write the read-only test below sees refused.
      expect((await putNote()).ok).toBe(true);

      expect((await setPermission(JSON.stringify({ access: "rw" }))).status).toBe(400);
      expect((await setPermission(JSON.stringify({}))).status).toBe(400);
      expect((await fetch(url, { method: "GET" })).status).toBe(405);
      const unknown = await fetch(`${testServer.baseUrl}/api/space/libraries/nope/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access: "read-write" }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      expect((await setPermission(JSON.stringify({ access: "read-only" }))).status).toBe(204);
    }
    expect((await putNote()).status).toBe(403);
    expect(await readFile(libraryPath, "utf8")).toBe("original\n");
  });

  // The third path-free write: an id and a string. Only the name changes,
  // and a blank one goes back to the folder's own.
  it("renames a library, and a blank name restores the folder's", async () => {
    const url = `${testServer.baseUrl}/api/space/libraries/lib/label`;
    const rename = (body: string) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const names = async () =>
      (
        (await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json()) as SpaceLibrariesResponse
      ).libraries.map((entry) => [entry.id, entry.label]);
    try {
      expect((await rename(JSON.stringify({ label: "  Archive " }))).status).toBe(204);
      expect(await names()).toEqual([["lib", "Archive"]]);
      expect((await rename(JSON.stringify({ label: "" }))).status).toBe(204);
      expect(await names()).toEqual([["lib", path.basename(libraryRoot)]]);

      expect((await rename(JSON.stringify({}))).status).toBe(400);
      expect((await fetch(url, { method: "GET" })).status).toBe(405);
      const unknown = await fetch(`${testServer.baseUrl}/api/space/libraries/nope/label`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Archive" }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
    }
  });

  it("removes a library from the registry and leaves its folder alone", async () => {
    const spareRoot = tempDir("pragma-test-library-spare-");
    try {
      await registerLibraries([
        { id: "lib", label: "Lib", path: libraryRoot, access: "read-only" },
        { id: "spare", label: "Spare", path: spareRoot, access: "read-only" },
      ]);
      const res = await fetch(`${testServer.baseUrl}/api/space/libraries/spare`, { method: "DELETE" });
      expect(res.status).toBe(204);
      const list = ((await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json()) as SpaceLibrariesResponse)
        .libraries;
      expect(list.map((entry) => entry.id)).toEqual(["lib"]);
      expect(existsSync(spareRoot)).toBe(true);

      expect((await fetch(`${testServer.baseUrl}/api/space/libraries/spare`, { method: "DELETE" })).status).toBe(404);
      expect((await fetch(`${testServer.baseUrl}/api/space/libraries/lib`, { method: "POST" })).status).toBe(405);
    } finally {
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
    }
  });

  // A library root sits outside the space, so only the host can tell whether
  // it is still there — and a space carried to another machine (or an
  // unplugged drive) makes that the normal case, not an edge one. The row
  // still lists, carrying the flag the panel degrades on.
  it("reports a library whose root is gone rather than dropping or failing it", async () => {
    const registered: LibraryEntry[] = [
      { id: "lib", label: "Lib", path: libraryRoot, access: "read-only" },
      {
        id: "gone",
        label: "Gone",
        path: path.join(tmpdir(), "pragma-test-library-does-not-exist"),
        access: "read-only",
      },
    ];
    await registerLibraries(registered);
    try {
      const list = ((await (await fetch(`${testServer.baseUrl}/api/space/libraries`)).json()) as SpaceLibrariesResponse)
        .libraries;
      expect(list.map((entry) => [entry.id, entry.missing])).toEqual([
        ["lib", false],
        ["gone", true],
      ]);
    } finally {
      await registerLibraries([registered[0]]);
    }
  });

  // The declaration travels with the space and the folder doesn't, so a space
  // opened where nobody has located a library lists it with no path, and
  // nothing reaches through it until someone does.
  it("lists a library the space declares that this computer hasn't located", async () => {
    const declared = path.join(testServer.spaceRoot, "_libraries.json");
    await writeFile(
      declared,
      JSON.stringify({
        libraries: [
          { id: "lib", label: "Lib" },
          { id: "elsewhere", label: "Elsewhere" },
        ],
      }),
    );
    try {
      const { libraries } = (await (
        await fetch(`${testServer.baseUrl}/api/space/libraries`)
      ).json()) as SpaceLibrariesResponse;
      expect(libraries.at(-1)).toEqual({ id: "elsewhere", label: "Elsewhere", access: "read-only", missing: true });
      expect((await fetch(`${testServer.baseUrl}/api/space/libraries/elsewhere/tree`)).status).toBe(404);
      expect((await fetch(`${testServer.baseUrl}/api/file?path=lib:elsewhere/note.md`)).status).toBe(404);
      const widen = await fetch(`${testServer.baseUrl}/api/space/libraries/elsewhere/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access: "read-write" }),
      });
      expect(widen.status).toBe(409);
    } finally {
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
    }
  });

  it("says why a _libraries.json that doesn't parse declares nothing, and never writes over it", async () => {
    const declared = path.join(testServer.spaceRoot, "_libraries.json");
    await writeFile(declared, "{ not json");
    try {
      const answer = (await (
        await fetch(`${testServer.baseUrl}/api/space/libraries`)
      ).json()) as SpaceLibrariesResponse;
      expect(answer.libraries).toEqual([]);
      expect(answer.problem).toMatch(/^_libraries\.json doesn't parse/);
      const rename = await fetch(`${testServer.baseUrl}/api/space/libraries/lib/label`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Archive" }),
      });
      expect(rename.status).toBe(409);
      expect((await fetch(`${testServer.baseUrl}/api/space/libraries/lib`, { method: "DELETE" })).status).toBe(409);
      expect(await readFile(declared, "utf8")).toBe("{ not json");
    } finally {
      await registerLibraries([{ id: "lib", label: "Lib", path: libraryRoot, access: "read-only" }]);
    }
  });

  it("refuses every method but GET on the library routes", async () => {
    for (const url of [
      `${testServer.baseUrl}/api/space/libraries`,
      `${testServer.baseUrl}/api/space/libraries/lib/tree`,
    ]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await fetch(url, { method, body: method === "DELETE" ? undefined : "{}" });
        expect(res.status, `${method} ${url}`).toBe(405);
      }
    }
  });

  // The write routes don't know libraries exist; they only confine to the space.
  // These assert that stays sufficient — an absolute library path and a
  // relative one traversing out of the space into the same folder are both
  // refused, by /api/file's write branch and by the entry routes.
  it("refuses to write into a read-only library through any write route", async () => {
    const escaping = path.relative(testServer.spaceRoot, libraryPath).split(path.sep).join("/");
    expect(escaping.startsWith("..")).toBe(true);

    // The refusal that matters: a correctly rooted path, named the way a
    // client is meant to name it, turned down on the library's permission
    // rather than on the path being malformed.
    const rooted = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent("lib:lib/note.md")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "overwritten" }),
    });
    expect(rooted.status).toBe(403);
    expect(await rooted.text()).toContain("read-only");

    // ...and the same file named as an escape, or by absolute path, never
    // parses at all.
    for (const target of [libraryPath, escaping]) {
      const put = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(target)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "overwritten" }),
      });
      expect(put.status, `PUT ${target}`).toBe(400);

      const del = await fetch(`${testServer.baseUrl}/api/space/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      expect(del.status, `delete ${target}`).toBe(400);

      const create = await fetch(`${testServer.baseUrl}/api/space/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "file", name: "planted.md", parentPath: target }),
      });
      expect(create.status, `create under ${target}`).toBe(400);
    }

    // And the rooted spelling, which parses perfectly and is refused on the
    // permission instead — the check that actually governs. Every write
    // route, so a refusal can't flatten to a 500 in one of them unnoticed.
    const rootedMove = await fetch(`${testServer.baseUrl}/api/space/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "lib:lib/note.md", to: "lib:lib/renamed.md" }),
    });
    expect(rootedMove.status).toBe(403);
    expect(await rootedMove.text()).toContain("read-only");
    const rootedUpload = await fetch(
      `${testServer.baseUrl}/api/space/upload?dir=${encodeURIComponent("lib:lib")}&name=take.mp4`,
      { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array(16) },
    );
    expect(rootedUpload.status).toBe(403);
    const rootedDelete = await fetch(`${testServer.baseUrl}/api/space/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "lib:lib/note.md" }),
    });
    expect(rootedDelete.status).toBe(403);
    const rootedCreate = await fetch(`${testServer.baseUrl}/api/space/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "file", name: "planted.md", parentPath: "lib:lib" }),
    });
    expect(rootedCreate.status).toBe(403);
    expect(await rootedCreate.text()).toContain("read-only");

    expect(await readFile(libraryPath, "utf8")).toBe("original\n");
    expect(existsSync(path.join(libraryRoot, "planted.md"))).toBe(false);
  });

  // The other half of the same field: with read-write, the ordinary entry
  // routes work inside a library exactly as they do in the space — and the
  // space's own per-folder machinery still does not follow them there.
  describe("a read-write library", () => {
    const asJson = (url: string, body: unknown, method = "POST") =>
      fetch(`${testServer.baseUrl}${url}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const setPermission = (permission: string) => asJson("/api/space/libraries/lib/access", { access: permission });

    beforeAll(async () => {
      expect((await setPermission("read-write")).status).toBe(204);
    });

    afterAll(async () => {
      expect((await setPermission("read-only")).status).toBe(204);
      await rm(path.join(libraryRoot, ".trash"), { recursive: true, force: true });
    });

    // Every path a write route hands back has to be valid input to the next
    // one, which the bare space spelling would not be: it would name a
    // different file, or none.
    it("creates, writes, renames and deletes, answering in rooted paths", async () => {
      const created = await asJson("/api/space/create", { type: "file", name: "scratch", parentPath: "lib:lib" });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({ path: "lib:lib/scratch.md", type: "file" });

      const written = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent("lib:lib/scratch.md")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "written into a library\n" }),
      });
      expect(written.ok).toBe(true);
      expect(await readFile(path.join(libraryRoot, "scratch.md"), "utf8")).toBe("written into a library\n");

      const moved = await asJson("/api/space/move", { from: "lib:lib/scratch.md", to: "lib:lib/stills/moved.md" });
      expect(moved.status).toBe(200);
      // A library has no binder manifest and no published copies, so a move
      // there reports the rename and nothing else.
      expect(await moved.json()).toEqual({ path: "lib:lib/stills/moved.md", rewritten: [], warnings: [] });
      expect(existsSync(path.join(libraryRoot, "stills", "moved.md"))).toBe(true);

      const deleted = await asJson("/api/space/delete", { path: "lib:lib/stills/moved.md" });
      expect(deleted.status).toBe(200);
      expect((await deleted.json()).path).toBe("lib:lib/stills/moved.md");
      // Into the library's own trash, not the space's: a rename across
      // devices would fail, and this is where someone would look for it.
      expect(existsSync(path.join(libraryRoot, ".trash", "moved.md"))).toBe(true);
      expect(existsSync(path.join(testServer.spaceRoot, ".trash", "moved.md"))).toBe(false);
    });

    // Carrying an entry between roots is a copy, over a boundary the two may
    // not share a device across — and it would strand every `lib:` reference
    // already written to it.
    it("refuses a move that changes root, in either direction", async () => {
      await asJson("/api/space/create", { type: "file", name: "stay.md", parentPath: "lib:lib" });
      const out = await asJson("/api/space/move", { from: "lib:lib/stay.md", to: "escaped.md" });
      expect(out.status).toBe(400);
      expect(await out.text()).toContain("one root");
      expect(existsSync(path.join(libraryRoot, "stay.md"))).toBe(true);
      expect(existsSync(path.join(testServer.spaceRoot, "escaped.md"))).toBe(false);

      await asJson("/api/space/create", { type: "file", name: "inbound.md" });
      const inbound = await asJson("/api/space/move", { from: "inbound.md", to: "lib:lib/inbound.md" });
      expect(inbound.status).toBe(400);
      expect(existsSync(path.join(testServer.spaceRoot, "inbound.md"))).toBe(true);
    });

    // The refusal that never flips: `_structure.json` and `_properties.json`
    // are space files by definition, so a library is turned down here even
    // while it is writable.
    it("still has no binder order or folder sort", async () => {
      for (const [url, body, method] of [
        ["/api/space/order", { dir: "lib:lib", order: [] }, "POST"],
        ["/api/space/sort", { dir: "lib:lib", sort: { by: "name", order: "desc" } }, "POST"],
      ] as const) {
        const res = await asJson(url, body, method);
        expect(res.status, `${method} ${url}`).toBe(400);
        expect(await res.text()).toContain("space folders only");
      }
      expect(existsSync(path.join(libraryRoot, "_structure.json"))).toBe(false);
      expect(existsSync(path.join(libraryRoot, "_properties.json"))).toBe(false);
    });

    // What sits under a dot is a repo's `.git` or a root's own state, and
    // the tree never offers it — so nothing pragma draws can ask, and a
    // request that does is refused whichever root it names.
    it("never writes under a hidden segment, in the library or the space", async () => {
      for (const target of ["lib:lib/.git/config", "lib:lib/.trash/x.md", ".pragma/planted.md"]) {
        const put = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(target)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "planted" }),
        });
        expect(put.status, `PUT ${target}`).toBe(403);
      }
      const create = await asJson("/api/space/create", { type: "directory", name: "x", parentPath: "lib:lib/.trash" });
      expect(create.status).toBe(403);
      expect(existsSync(path.join(libraryRoot, ".git"))).toBe(false);
      expect(existsSync(path.join(testServer.spaceRoot, ".pragma", "planted.md"))).toBe(false);
    });

    // The gesture the feature exists for: a take dropped into a library.
    it("takes a dropped video, into the library's own tree", async () => {
      const res = await fetch(
        `${testServer.baseUrl}/api/space/upload?dir=${encodeURIComponent("lib:lib/stills")}&name=take.mp4`,
        { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array(1024) },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ path: "lib:lib/stills/take.mp4", name: "take.mp4" });
      expect(existsSync(path.join(libraryRoot, "stills", "take.mp4"))).toBe(true);
    });

    it("refuses to delete the library root itself", async () => {
      const res = await asJson("/api/space/delete", { path: "lib:lib" });
      expect(res.status).toBe(400);
      expect(existsSync(libraryRoot)).toBe(true);
    });
  });

  // The copilot's refusals a setting fixes, each naming what it needs so the
  // panel can link to that setting. None reaches a provider: no model fails
  // before resolution, and a keyless provider is refused by the seam before
  // any request is built.
  it("POST /api/chat with no model is a 400 needing a default text model", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/chat?folderPath=`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: [], message: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ need: { kind: "defaultModel", output: "text" } });
  });

  // Reaching the model check means the view parsed: a Flow is a context of
  // its own, naming no view is a turn with no file open, not a 400, and the
  // other group's tab takes the same parameters under a `beside` prefix.
  it("POST /api/chat accepts a Flow's view, no view at all, and a tab beside", async () => {
    for (const query of ["?flowPath=a.flow.html", "", "?path=a.md&besideTablePath=b.table.html"]) {
      const res = await fetch(`${testServer.baseUrl}/api/chat${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history: [], message: "hi" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ need: { kind: "defaultModel", output: "text" } });
    }
  });

  it("POST /api/chat on a keyless provider is a 401 naming it as what needs a key", async () => {
    const post = (route: string, body: Record<string, unknown>) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Saved while the environment holds its key, then asked for once it doesn't.
    vi.stubEnv("ANTHROPIC_API_KEY", "from-env");
    try {
      expect((await post("/api/providers", { id: "anthropic", kind: "anthropic" })).status).toBe(204);
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const res = await post("/api/chat?folderPath=", {
        history: [],
        message: "hi",
        model: "anthropic/claude-sonnet-5",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.need).toEqual({ kind: "providerKey", provider: "anthropic" });
      expect(body.message).toContain('"anthropic"');
    } finally {
      vi.unstubAllEnvs();
      await post("/api/providers/delete", { id: "anthropic" });
    }
  });

  // Refused before any request: run without the level, the reply would read
  // as made at the effort the writer picked.
  it("POST /api/chat with an effort level its model doesn't take is a 400 naming both", async () => {
    const post = (route: string, body: Record<string, unknown>) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const local = { id: "nolevels", kind: "openai", baseURL: "http://127.0.0.1:9/v1", textModels: ["qwen"] };
    expect((await post("/api/providers", local)).status).toBe(204);
    try {
      const res = await post("/api/chat?folderPath=", {
        history: [],
        message: "hi",
        model: "nolevels/qwen",
        effort: "high",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Model "qwen" takes no "high" effort level.');
    } finally {
      await post("/api/providers/delete", { id: "nolevels" });
    }
  });

  it("POST /api/chat naming a provider that isn't configured is a 400 needing a provider for the model", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/chat?folderPath=`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: [], message: "hi", model: "anthropic/claude-sonnet-5" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      need: { kind: "provider", model: "anthropic/claude-sonnet-5" },
      message: expect.stringContaining('No provider "anthropic" is configured'),
    });
  });

  // The MCP server list. The test server is the production adapter with the
  // host flag at its default (off), so it doubles as the remote-access
  // target's posture: servers save and connect, but nothing signs in here.
  it("GET /api/mcp-servers starts empty and reports sign-in off", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/mcp-servers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      servers: [],
      store: { kind: "plain-files", encrypted: false, available: true },
      signInAllowed: false,
    });
  });

  it("POST /api/mcp-servers saves a server, stores its token apart, and lists it", async () => {
    const save = await fetch(`${testServer.baseUrl}/api/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "linear", label: "Linear", url: "http://x/mcp", apiKey: "tok", copilot: true }),
    });
    expect(save.status).toBe(204);

    const list = await fetch(`${testServer.baseUrl}/api/mcp-servers`);
    const body = await list.json();
    expect(body.servers).toEqual([
      {
        id: "linear",
        label: "Linear",
        url: "http://x/mcp",
        keySource: "stored",
        signIn: { state: "signed-out" },
        copilot: true,
        flows: false,
        flowsAvailable: false,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("tok");

    const del = await fetch(`${testServer.baseUrl}/api/mcp-servers/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "linear" }),
    });
    expect(del.status).toBe(204);
    expect((await (await fetch(`${testServer.baseUrl}/api/mcp-servers`)).json()).servers).toEqual([]);
  });

  it("POST /api/mcp-servers refuses a server with no URL", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nowhere" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/needs a "url"/);
  });

  it("POST /api/mcp-servers switches Flows on by default only where a node can use the server", async () => {
    const save = (body: Record<string, unknown>) =>
      fetch(`${testServer.baseUrl}/api/mcp-servers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await save({ id: "higgsfield", url: "https://mcp.higgsfield.ai/mcp" });
    await save({ id: "other", url: "https://mcp.other.test/mcp" });

    const { servers } = await (await fetch(`${testServer.baseUrl}/api/mcp-servers`)).json();
    const byId = Object.fromEntries(servers.map((row: { id: string }) => [row.id, row]));
    expect(byId.higgsfield).toMatchObject({ flows: true, flowsAvailable: true, copilot: false });
    expect(byId.other).toMatchObject({ flows: false, flowsAvailable: false, copilot: false });
  });

  it("POST /api/mcp-servers keeps a server's URL fixed once added", async () => {
    const save = (body: Record<string, unknown>) =>
      fetch(`${testServer.baseUrl}/api/mcp-servers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await save({ id: "fixed", url: "http://a.test/mcp" })).status).toBe(204);

    const moved = await save({ id: "fixed", url: "http://b.test/mcp" });
    expect(moved.status).toBe(400);
    expect((await moved.json()).message).toMatch(/URL can't change/);
    expect((await save({ id: "fixed", url: "http://a.test/mcp", label: "Renamed" })).status).toBe(204);
  });

  it("refuses to start a sign-in where the host isn't the writer's own machine", async () => {
    await fetch(`${testServer.baseUrl}/api/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "remote", url: "http://127.0.0.1:9/mcp" }),
    });
    const start = await fetch(`${testServer.baseUrl}/api/mcp-servers/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "remote" }),
    });
    expect(start.status).toBe(400);
    expect((await start.json()).message).toMatch(
      /needs `pragma start` without `--external-url` on the machine this host runs on/,
    );

    const status = await fetch(`${testServer.baseUrl}/api/mcp-servers/sign-in?id=remote`);
    expect(await status.json()).toEqual({ state: "signed-out" });
    const unknown = await fetch(`${testServer.baseUrl}/api/mcp-servers/sign-in?id=nope`);
    expect(unknown.status).toBe(404);
  });

  it("POST /api/mcp-servers/connect answers 502 for a server that can't be reached", async () => {
    await fetch(`${testServer.baseUrl}/api/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dead", url: "http://127.0.0.1:9/mcp" }),
    });
    const res = await fetch(`${testServer.baseUrl}/api/mcp-servers/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dead" }),
    });
    expect(res.status).toBe(502);
    expect(typeof (await res.json()).message).toBe("string");

    const unknown = await fetch(`${testServer.baseUrl}/api/mcp-servers/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nope" }),
    });
    expect(unknown.status).toBe(404);
  });
});

// POST /api/space/move's _structure.json bookkeeping (src/server/structure.ts)
// — its own testServer, same reasoning as the delete block above.
describe("API contract — space move", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function createEntry(name: string, type: "file" | "directory", parentPath?: string): Promise<void> {
    const res = await fetch(`${testServer.baseUrl}/api/space/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parentPath === undefined ? { name, type } : { name, type, parentPath }),
    });
    expect(res.status).toBe(200);
  }

  async function moveEntry(from: string, to: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  }

  // An entry may carry keys beyond `name`: it still reads, and the file's
  // next write drops them.
  type Order = Array<{ name: string } & Record<string, unknown>>;

  async function writeOrder(dir: string, order: Order): Promise<void> {
    await writeFile(path.join(testServer.spaceRoot, dir, "_structure.json"), `${JSON.stringify({ order }, null, 2)}\n`);
  }

  async function readOrder(dir: string): Promise<Order> {
    const raw = await readFile(path.join(testServer.spaceRoot, dir, "_structure.json"), "utf8");
    return (JSON.parse(raw) as { order: Order }).order;
  }

  async function children(dir: string): Promise<SpaceTreeNode[]> {
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    return tree.find((node) => node.path === dir)?.children ?? [];
  }

  it("a card's text is the entry's own description, never its manifest's", async () => {
    await createEntry("described", "directory");
    await createEntry("act-one", "directory", "described");
    await createEntry("act-two", "directory", "described");
    const dir = path.join(testServer.spaceRoot, "described");
    await writeFile(path.join(dir, "act-one", "README.md"), "---\ndescription: The first act.\n---\n# Act one\n");
    await writeFile(path.join(dir, "lina.md"), "---\ndescription: The investigator.\n---\n# Lina\n");
    await writeFile(path.join(dir, "scene.fountain"), "INT. ROOM - DAY\n\n= A door opens.\n");
    await writeFile(
      path.join(dir, "polish.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Polish",
        metadata: [{ key: "description", values: ["Tightens a line."] }],
        graph: { nodes: [], edges: [] },
      }),
    );
    await writeFile(
      path.join(dir, "cast.table.html"),
      serializeTableFile({
        version: "1.0",
        name: "Cast",
        metadata: [{ key: "description", values: ["Who plays whom."] }],
        columns: [],
        rows: [],
      }),
    );
    await writeFile(
      path.join(dir, "stage.applet.html"),
      '<!DOCTYPE html><html><head><script type="application/json" data-role="manifest">' +
        '{"id":"applet_1","version":"1.0","meta":{"name":"Stage","description":"Blocks a shot."}}' +
        "</script></head><body></body></html>",
    );
    await writeFile(path.join(dir, "sky.png"), "");
    await writeOrder("described", [
      { id: "lina", name: "lina.md", synopsis: "stale manifest text" },
      { id: "sky", name: "sky.png", synopsis: "A pale sky." },
      { id: "act-two", name: "act-two", synopsis: "stale manifest text" },
    ]);

    expect(Object.fromEntries((await children("described")).map((node) => [node.name, node.description]))).toEqual({
      "act-one": "The first act.",
      "act-two": undefined,
      "cast.table.html": "Who plays whom.",
      "lina.md": "The investigator.",
      "polish.flow.html": "Tightens a line.",
      "scene.fountain": "A door opens.",
      "sky.png": undefined,
      "stage.applet.html": "Blocks a shot.",
    });

    const descriptionOf = (relative: string) =>
      fetch(`${testServer.baseUrl}/api/file/description?path=${encodeURIComponent(relative)}`);
    expect(await (await descriptionOf("described/polish.flow.html")).json()).toEqual({
      description: "Tightens a line.",
    });
    expect(await (await descriptionOf("described/act-one")).json()).toEqual({ description: "The first act." });
    expect(await (await descriptionOf("described/sky.png")).json()).toEqual({});
    expect((await descriptionOf("described/missing.md")).status).toBe(404);
  });

  it("a move between directories leaves the old order and follows the new one's listed entries", async () => {
    await createEntry("move-src", "directory");
    await createEntry("move-dst", "directory");
    await createEntry("a.md", "file", "move-src");
    await createEntry("b.md", "file", "move-src");
    await createEntry("x.md", "file", "move-dst");
    await createEntry("y.md", "file", "move-dst");
    await writeOrder("move-src", [{ name: "b.md" }, { name: "a.md" }]);
    await writeOrder("move-dst", [{ name: "y.md" }, { name: "x.md" }]);

    const res = await moveEntry("move-src/b.md", "move-dst/b.md");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "move-dst/b.md" });

    expect(await readOrder("move-src")).toEqual([{ name: "a.md" }]);
    expect(await readOrder("move-dst")).toEqual([{ name: "y.md" }, { name: "x.md" }]);
    expect((await children("move-dst")).map((node) => node.name)).toEqual(["y.md", "x.md", "b.md"]);
  });

  it("a move into a directory without a manifest drops the source entry and creates no manifest", async () => {
    await createEntry("move-src-2", "directory");
    await createEntry("move-plain", "directory");
    await createEntry("b.md", "file", "move-src-2");
    await writeOrder("move-src-2", [{ id: "b", name: "b.md", synopsis: "second" }]);

    expect((await moveEntry("move-src-2/b.md", "move-plain/b.md")).status).toBe(200);

    expect(await readOrder("move-src-2")).toEqual([]);
    expect(existsSync(path.join(testServer.spaceRoot, "move-plain", "_structure.json"))).toBe(false);
  });

  it("a stale destination entry under the moved name places the moved entry there", async () => {
    await createEntry("move-src-3", "directory");
    await createEntry("move-dst-3", "directory");
    await createEntry("b.md", "file", "move-src-3");
    await createEntry("x.md", "file", "move-dst-3");
    await writeOrder("move-src-3", [{ name: "b.md" }]);
    await writeOrder("move-dst-3", [{ name: "b.md" }, { name: "x.md" }]);

    expect((await moveEntry("move-src-3/b.md", "move-dst-3/b.md")).status).toBe(200);

    expect(await readOrder("move-dst-3")).toEqual([{ name: "b.md" }, { name: "x.md" }]);
    expect((await children("move-dst-3")).map((node) => node.name)).toEqual(["b.md", "x.md"]);
  });

  it("a same-directory rename keeps the entry's position, rewriting the order as names alone", async () => {
    await createEntry("move-rename", "directory");
    await createEntry("a.md", "file", "move-rename");
    await createEntry("b.md", "file", "move-rename");
    await writeOrder("move-rename", [
      { id: "b", name: "b.md", synopsis: "second", label: "B" },
      { id: "a", name: "a.md" },
    ]);

    expect((await moveEntry("move-rename/b.md", "move-rename/c.md")).status).toBe(200);

    expect(await readOrder("move-rename")).toEqual([{ name: "c.md" }, { name: "a.md" }]);
  });
});

// GET /api/space/class — the notes a Class holds, read from their
// own frontmatter.
describe("API contract — space class", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function place(relative: string, content: string): Promise<void> {
    const absolute = path.join(testServer.spaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  // A Class whose Folder rule names `folders`, each written from its scope,
  // the space's here unless a test makes one, with the folders below them
  // when `within`; none reads the whole space.
  const classFile = (
    folders: string[],
    filter: { property: string; test: string; values: string[] }[] = [],
    within = false,
  ) =>
    serializeClassFile({
      version: "1.0",
      filter: [
        ...(folders.length > 0 ? [{ property: "file.folder", test: within ? "within" : "is", values: folders }] : []),
        ...filter,
      ],
      fields: [],
      views: [],
      links: [],
    });

  async function rows(target: string): Promise<ClassRow[]> {
    const res = await fetch(`${testServer.baseUrl}/api/space/class?path=${encodeURIComponent(target)}`);
    expect(res.status).toBe(200);
    return (await res.json()).rows;
  }

  // A row's own facts: what it is, its size and when it last changed.
  const facts = (kind: string) => ({
    kind,
    size: expect.any(Number),
    modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    folder: expect.any(String),
  });

  it("holds its folder's notes and index.md folders, in the folder's order, kept by its filter", async () => {
    await place(
      "col/shots/shots.class.html",
      classFile(["col/shots"], [{ property: "tags", test: "has", values: ["shot"] }]),
    );
    await place("col/shots/b.md", "---\ntags: [shot]\nstatus: draft\n---\n\n# Wide\n");
    await place("col/shots/a.md", "---\ntags: [shot]\n---\nNo heading.\n");
    await place("col/shots/c.md", "---\ntags: [other]\n---\n");
    await place("col/shots/README.md", "---\ntags: [shot]\n---\n# About\n");
    await place("col/shots/index.md", "---\ntags: [shot]\n---\n");
    await place("col/shots/scene-1/index.md", "---\ntags: [shot]\n---\n# Scene one\n");
    await mkdir(path.join(testServer.spaceRoot, "col/shots/frames"), { recursive: true });

    expect(await rows("col/shots/shots.class.html")).toEqual([
      {
        path: "col/shots/scene-1/index.md",
        name: "scene-1",
        title: "Scene one",
        ...facts("note"),
        properties: { tags: ["shot"] },
      },
      { path: "col/shots/a.md", name: "a.md", title: "a", ...facts("note"), properties: { tags: ["shot"] } },
      {
        path: "col/shots/b.md",
        name: "b.md",
        title: "Wide",
        ...facts("note"),
        properties: { tags: ["shot"], status: "draft" },
      },
    ]);
  });

  // `this.file.folder` names the folder the Class file is in, whatever its
  // scope, below the scope's top or not.
  it("holds its own folder's notes for this.file.folder, and below it for within", async () => {
    await place("col/own/a/c.class.html", classFile(["this.file.folder"]));
    await place("col/own/a/one.md", "# One\n");
    await place("col/own/a/deep/two.md", "# Two\n");
    await place("col/own/three.md", "# Three\n");
    await place("col/own/b/c.class.html", classFile(["this.file.folder"], [], true));
    await place("col/own/b/four.md", "# Four\n");
    await place("col/own/b/deep/five.md", "# Five\n");
    const paths = async (target: string) => (await rows(target)).map((row) => row.path).sort();

    expect(await paths("col/own/a/c.class.html")).toEqual(["col/own/a/one.md"]);
    expect(await paths("col/own/b/c.class.html")).toEqual(["col/own/b/deep/five.md", "col/own/b/four.md"]);
  });

  // docs/protocol.md's Classes: a note's tags are one list, so a `#tag` in
  // its text makes it a row as its frontmatter's would.
  it("holds a note by a tag written in its text, in any case, for a has on tags", async () => {
    await place(
      "col/inline/inline.class.html",
      classFile(["col/inline"], [{ property: "tags", test: "has", values: ["Shot"] }]),
    );
    await place("col/inline/a.md", "A wide #SHOT of the bay.\n");
    await place("col/inline/b.md", "`#shot` in code only.\n");
    await place("col/inline/c.md", "---\ntags: [shot]\n---\n");

    const held = await rows("col/inline/inline.class.html");
    expect(held.map((row) => [row.path, row.inlineTags])).toEqual([
      ["col/inline/a.md", ["SHOT"]],
      ["col/inline/c.md", undefined],
    ]);
  });

  it("reads several folders in name order, and skips one that names none", async () => {
    await place("col/multi/m.class.html", classFile(["col/one", "/col/two", "col/multi/missing"]));
    await place("col/one/z.md", "# Z\n");
    await place("col/two/m.md", "# M\n");

    expect((await rows("col/multi/m.class.html")).map((row) => row.path)).toEqual(["col/two/m.md", "col/one/z.md"]);
  });

  it("reads within a folder depth-first, each folder in its own order", async () => {
    await place("col/tree/tree.class.html", classFile(["col/tree"], [], true));
    await place("col/tree/README.md", "# About\n");
    await place("col/tree/opening.md", "# Opening\n");
    await place("col/tree/act-1/index.md", "# Act one\n");
    await place("col/tree/act-1/README.md", "# About act one\n");
    await place("col/tree/act-1/scene-1/index.md", "# Scene one\n");
    await place("col/tree/act-1/scene-1/shot.md", "# Shot\n");
    await place("col/tree/act-1/scene-2/shot.md", "# Shot\n");
    await place("col/tree/act-1/.drafts/hidden.md", "# Hidden\n");
    const order = [
      { id: "s2", name: "scene-2" },
      { id: "s1", name: "scene-1" },
    ];
    await place("col/tree/act-1/_structure.json", JSON.stringify({ order }));

    expect((await rows("col/tree/tree.class.html")).map((row) => row.path)).toEqual([
      "col/tree/act-1/index.md",
      "col/tree/act-1/scene-2/shot.md",
      "col/tree/act-1/scene-1/index.md",
      "col/tree/act-1/scene-1/shot.md",
      "col/tree/opening.md",
    ]);
  });

  it("lists a note whose frontmatter doesn't parse with no values and the reason", async () => {
    await place("col/broken/broken.class.html", classFile(["col/broken"]));
    await place("col/broken/bad.md", "---\ntags: [shot\n---\n# Bad\n");

    expect(await rows("col/broken/broken.class.html")).toEqual([
      {
        path: "col/broken/bad.md",
        name: "bad.md",
        title: "Bad",
        ...facts("note"),
        properties: {},
        error: expect.stringMatching(/^line \d+: /),
      },
    ]);
  });

  it("lists a file reached through two folders once", async () => {
    await place(
      "col/twice/twice.class.html",
      classFile(["col/twice", "col/twice/inner", "/col/twice/inner/"], [], true),
    );
    await place("col/twice/inner/b.md", "# B\n");
    await place("col/twice/a.md", "# A\n");

    expect((await rows("col/twice/twice.class.html")).map((row) => row.path)).toEqual([
      "col/twice/a.md",
      "col/twice/inner/b.md",
    ]);
  });

  it("holds screenplays and media beside notes, each with its own values, never a Table or Flow", async () => {
    await place("col/kinds/kinds.class.html", classFile(["col/kinds"]));
    await place("col/kinds/a.md", "---\nstatus: draft\n---\n# A note\n");
    await place("col/kinds/c.fountain", "Title: Brick\nDraft Date: 1/1/26\n\nEXT. PATIO - DAY\n");
    await place("col/kinds/d.png", "not really a png");
    await place("col/kinds/e.pdf", PDF_BYTES.toString("latin1"));
    await place("col/kinds/f.table.html", "");
    await place("col/kinds/g.flow.html", "");
    await place("col/kinds/h.txt", "plain");

    const held = await rows("col/kinds/kinds.class.html");
    expect(held.map(({ name, kind, title, properties }) => ({ name, kind, title, properties }))).toEqual([
      { name: "a.md", kind: "note", title: "A note", properties: { status: "draft" } },
      {
        name: "c.fountain",
        kind: "screenplay",
        title: "Brick",
        properties: { title: "Brick", "draft date": "1/1/26" },
      },
      { name: "d.png", kind: "image", title: "d", properties: {} },
      { name: "e.pdf", kind: "pdf", title: "e", properties: {} },
    ]);
    expect(held[2]).toMatchObject({ ...facts("image"), size: "not really a png".length });
  });

  it("writes each row's folder from the Class's scope, and filters Folder by * for any one folder", async () => {
    await place("col/music/AGENTS.md", "---\npragma:\n---\n# Music\n");
    const lyrics = [{ property: "file.folder", test: "is", values: ["*/lyrics"] }];
    await place("col/music/classes/lyrics.class.html", classFile([], lyrics));
    await place("col/music/top.md", "# Top\n");
    await place("col/music/album-1/lyrics/a.md", "# A\n");
    await place("col/music/album-2/demos/c.md", "# C\n");
    await place("col/music/album-2/lyrics/b.md", "# B\n");
    await place("col/music/album-2/old/lyrics/d.md", "# D\n");

    expect((await rows("col/music/classes/lyrics.class.html")).map((row) => [row.path, row.folder])).toEqual([
      ["col/music/album-1/lyrics/a.md", "album-1/lyrics"],
      ["col/music/album-2/lyrics/b.md", "album-2/lyrics"],
    ]);

    // The scope's own folder is `.`, and a folder outside it is written from the root.
    await place("col/elsewhere/e.md", "# E\n");
    await place("col/music/classes/all.class.html", classFile(["/col/elsewhere", "."]));
    const all = await rows("col/music/classes/all.class.html");
    expect(all.find((row) => row.path === "col/music/top.md")?.folder).toBe(".");
    expect(all.find((row) => row.path === "col/elsewhere/e.md")?.folder).toBe("/col/elsewhere");
  });

  it("answers 404 for a Class that isn't there", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/class?path=col/none.class.html`);
    expect(res.status).toBe(404);
  });

  // As the tree does: a sort picked for the folder's gallery shows only there.
  it("keeps the folder's own order, as a drag arranged it", async () => {
    await place("col/arranged/arranged.class.html", classFile(["col/arranged"]));
    await place("col/arranged/a.md", "# A\n");
    await place("col/arranged/b.md", "# B\n");
    await place("col/arranged/c.md", "# C\n");
    const post = (route: string, body: unknown) =>
      fetch(`${testServer.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const order = ["c.md", "arranged.class.html", "a.md", "b.md"];
    expect((await post("/api/space/order", { dir: "col/arranged", order })).status).toBe(204);
    const gallery = await post("/api/space/local-sort", { dir: "col/arranged", sort: { by: "name", order: "desc" } });
    expect(gallery.status).toBe(204);

    expect((await rows("col/arranged/arranged.class.html")).map((row) => row.path)).toEqual([
      "col/arranged/c.md",
      "col/arranged/a.md",
      "col/arranged/b.md",
    ]);
  });

  // ?dir: what a Class made in a folder starts from.
  it("gives a folder's own rows, for a Class made there", async () => {
    await place("col/fresh/b.md", "---\nstatus: draft\n---\n# B\n");
    await place("col/fresh/a.md", "---\ndone: true\n---\n# A\n");
    await place("col/fresh/README.md", "---\nstatus: about\n---\n");
    const res = await fetch(`${testServer.baseUrl}/api/space/class?dir=${encodeURIComponent("col/fresh")}`);
    expect(res.status).toBe(200);
    const { rows: held } = (await res.json()) as { rows: { path: string; properties: unknown }[] };
    expect(held.map((row) => [row.path, row.properties])).toEqual([
      ["col/fresh/a.md", { done: true }],
      ["col/fresh/b.md", { status: "draft" }],
    ]);

    expect((await fetch(`${testServer.baseUrl}/api/space/class?dir=col/fresh/a.md`)).status).toBe(400);
    expect((await fetch(`${testServer.baseUrl}/api/space/class?dir=col/none`)).status).toBe(404);
  });
});

// POST /api/space/duplicate — its own space, because the step-around names
// it hands back depend on what else is in the folder.
describe("API contract — space duplicate", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function place(relative: string, content: string): Promise<void> {
    const absolute = path.join(testServer.spaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  async function duplicate(relative: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: relative }),
    });
  }

  const read = (relative: string) => readFile(path.join(testServer.spaceRoot, relative), "utf8");

  it("writes a byte-identical copy beside the original, suffixed before the whole extension", async () => {
    await place("dup/inventory.table.html", "<table></table>\n");

    const first = await duplicate("dup/inventory.table.html");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ path: "dup/inventory 2.table.html", type: "file" });
    expect(await read("dup/inventory 2.table.html")).toBe("<table></table>\n");

    expect(await (await duplicate("dup/inventory.table.html")).json()).toMatchObject({
      path: "dup/inventory 3.table.html",
    });
  });

  it("refuses a folder, and a path that isn't there", async () => {
    await mkdir(path.join(testServer.spaceRoot, "dup-folder"), { recursive: true });
    expect((await duplicate("dup-folder")).status).toBe(400);
    expect((await duplicate("dup/missing.md")).status).toBe(404);
  });

  // Keeping `id` would make the copy's first publish update the original's
  // page on the service.
  it("drops a site document's id and pushed, keeping every other line as written", async () => {
    await place("dup-site/_site.json", JSON.stringify({ id: "ste_dup", slug: "dup", name: "Dup" }));
    const post =
      "---\n# kept\ncreated: 2026-09-01T00:00:00.000Z\nid: doc_original\ndate: 2026-09-02   # launch\npushed: 2026-09-03T00:00:00.000Z\n---\n\n# Post\n\nText\n";
    await place("dup-site/post.md", post);

    const res = await duplicate("dup-site/post.md");
    expect(await res.json()).toMatchObject({ path: "dup-site/post 2.md" });

    const copy = await read("dup-site/post 2.md");
    expect(copy).toBe(post.replace("id: doc_original\n", "").replace("\npushed: 2026-09-03T00:00:00.000Z", ""));
    expect(parseFrontmatter(copy).data).toEqual({ created: "2026-09-01T00:00:00.000Z", date: "2026-09-02" });
    expect(await read("dup-site/post.md")).toContain("id: doc_original");
  });

  it("copies a markdown document outside any site as it stands", async () => {
    const original = "---\nid: my-own-id\n---\n\n# Note\n";
    await place("dup/note.md", original);

    await duplicate("dup/note.md");
    expect(await read("dup/note 2.md")).toBe(original);
  });

  it("places the copy right after the original in a manually sorted folder", async () => {
    await place("dup-sorted/a.md", "a");
    await place("dup-sorted/b.md", "b");
    await place(
      "dup-sorted/_structure.json",
      JSON.stringify({
        order: [
          { id: "b", name: "b.md" },
          { id: "a", name: "a.md", synopsis: "first" },
        ],
      }),
    );

    await duplicate("dup-sorted/b.md");
    await duplicate("dup-sorted/a.md");

    const { order } = JSON.parse(await read("dup-sorted/_structure.json")) as { order: unknown[] };
    expect(order).toEqual([{ name: "b.md" }, { name: "b 2.md" }, { name: "a.md" }, { name: "a 2.md" }]);
  });
});

// A flow's grants are pinned to its capability digest, so the contract worth
// pinning down is which writes carry a grant forward and which strand it:
// pragma's own save remaps, a write behind pragma's back does not.
describe("flow grants across a save", () => {
  let testServer: TestServer;
  const FLOW = "projects/getting-started/story-expander.flow.html";
  const CAPABILITY = "readFile:space:projects/getting-started/writing-prompts.table.html";

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function readFlow(): Promise<{ granted: string[]; raw: string }> {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(FLOW)}`);
    const body = await res.json();
    return {
      granted: body.grantedCapabilities,
      raw: await readFile(path.join(testServer.spaceRoot, FLOW), "utf8"),
    };
  }

  async function putFlow(raw: string): Promise<number> {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(FLOW)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: raw }),
    });
    return res.status;
  }

  it("grants, then survives a cosmetic save, a behavioural save, and not an outside write", async () => {
    expect((await readFlow()).granted).toEqual([]);

    const grant = await fetch(`${testServer.baseUrl}/api/sandbox/grant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "flow", path: FLOW, capabilityKey: CAPABILITY }),
    });
    expect(grant.status).toBe(204);
    expect((await readFlow()).granted).toEqual([CAPABILITY]);

    // Dragging a node: the file changes, the digest does not.
    const moved = (await readFlow()).raw.replace('"x":40,"y":120', '"x":420,"y":120');
    expect(moved).not.toBe((await readFlow()).raw);
    expect(await putFlow(moved)).toBe(200);
    expect((await readFlow()).granted).toEqual([CAPABILITY]);

    // Editing a widget through pragma: the digest changes, and the save
    // carries the grant onto the new one rather than re-prompting.
    const edited = (await readFlow()).raw.replace("A locked door with no key", "A key with no locked door");
    expect(await putFlow(edited)).toBe(200);
    expect((await readFlow()).granted).toEqual([CAPABILITY]);

    // The same edit made behind pragma's back strands the grant: no save
    // ran, so nothing remapped the digest it is pinned to.
    const outside = (await readFlow()).raw.replace("A key with no locked door", "Something else entirely");
    await writeFile(path.join(testServer.spaceRoot, FLOW), outside, "utf8");
    expect((await readFlow()).granted).toEqual([]);
  });
});

// A flow's leave to run unattended is given only through this route, so it
// is where a last day arrives: one naming no day, or a day gone, is refused
// rather than stored.
describe("a flow's unattended leave", () => {
  let testServer: TestServer;
  const FLOW = "projects/getting-started/story-expander.flow.html";

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  const setLeave = (body: Record<string, unknown>) =>
    fetch(`${testServer.baseUrl}/api/sandbox/unattended`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "flow", path: FLOW, ...body }),
    });

  async function standing(): Promise<{ runsUnattended: boolean; unattendedUntil?: string }> {
    const res = await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(FLOW)}`);
    const body = await res.json();
    return { runsUnattended: body.runsUnattended, unattendedUntil: body.unattendedUntil };
  }

  it("is given until a last day or until revoked, and withdrawn", async () => {
    const until = localDayAfter(new Date(), 30);
    expect((await setLeave({ allowed: true, until })).status).toBe(204);
    expect(await standing()).toEqual({ runsUnattended: true, unattendedUntil: until });

    expect((await setLeave({ allowed: true })).status).toBe(204);
    expect(await standing()).toEqual({ runsUnattended: true });

    expect((await setLeave({ allowed: false })).status).toBe(204);
    expect(await standing()).toEqual({ runsUnattended: false });
  });

  it("refuses a last day that names no day, or one already gone", async () => {
    const malformed = await setLeave({ allowed: true, until: "2026-02-30" });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe("until must be a day, as YYYY-MM-DD");

    const gone = await setLeave({ allowed: true, until: "2020-01-31" });
    expect(gone.status).toBe(400);
    expect(await gone.text()).toBe("2020-01-31 has already passed");
    expect(await standing()).toEqual({ runsUnattended: false });
  });
});

// POST /api/space/upload — the one write route carrying raw bytes rather than
// a JSON envelope. Its own space, because the assertions here count what ends
// up in a folder and a stray file from another test would change the answer.
describe("API contract — space upload", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  // A one-pixel PNG: real bytes, so a write that silently re-encoded them as
  // text would show up as a changed length rather than passing.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  async function upload(dir: string, name: string, body: BodyInit = new Uint8Array(PNG)): Promise<Response> {
    const query = `dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`;
    return fetch(`${testServer.baseUrl}/api/space/upload?${query}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body,
    });
  }

  it("writes the bytes into the named folder and reports the path", async () => {
    await mkdir(path.join(testServer.spaceRoot, "shots"), { recursive: true });

    const res = await upload("shots", "cover.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "shots/cover.png", name: "cover.png" });

    const written = await readFile(path.join(testServer.spaceRoot, "shots", "cover.png"));
    expect(written.equals(PNG)).toBe(true);
  });

  // The gesture behind this route has no undo a user would think to reach
  // for, so a second file of the same name is written beside the first.
  it("steps around an existing name instead of overwriting it", async () => {
    await upload("", "twice.png");
    const second = await upload("", "twice.png");

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ path: "twice 2.png", name: "twice 2.png" });
    expect(existsSync(path.join(testServer.spaceRoot, "twice.png"))).toBe(true);
  });

  // Same rule as a typed name, repaired rather than refused because nobody
  // typed this one: a name that only folds onto an existing sibling is taken.
  it("steps around a name that differs from an existing one only by case", async () => {
    await upload("", "Folded.png");
    const second = await upload("", "folded.png");

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ path: "folded 2.png", name: "folded 2.png" });
    expect(existsSync(path.join(testServer.spaceRoot, "Folded.png"))).toBe(true);
  });

  it("steps around a name that differs from an existing one only by Unicode normalization", async () => {
    await upload("", "cre\u0300me.png");
    const second = await upload("", "cr\u00e8me.png");

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ path: "cr\u00e8me 2.png", name: "cr\u00e8me 2.png" });
    expect(existsSync(path.join(testServer.spaceRoot, "cre\u0300me.png"))).toBe(true);
  });

  it("refuses a name that isn't an image, a video, a PDF or a LUT", async () => {
    const res = await upload("", "payload.sh");
    expect(res.status).toBe(415);
    expect(existsSync(path.join(testServer.spaceRoot, "payload.sh"))).toBe(false);
  });

  it("takes a dropped LUT, which the raw-file route serves back as plain text", async () => {
    const cube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    const res = await upload("", "Print.CUBE", cube);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "Print.CUBE", name: "Print.CUBE" });

    const raw = await fetch(`${testServer.baseUrl}/api/file/raw?path=${encodeURIComponent("Print.CUBE")}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/plain");
    expect(await raw.text()).toBe(cube);
  });

  it("takes a dropped PDF", async () => {
    const res = await upload("", "dropped.pdf", new Uint8Array(PDF_BYTES));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "dropped.pdf", name: "dropped.pdf" });
    expect(existsSync(path.join(testServer.spaceRoot, "dropped.pdf"))).toBe(true);
  });

  // The route streams: a file well past what the old in-memory cap allowed
  // lands byte for byte, and the temp file it travelled through is gone.
  it("streams a video larger than any cap it used to have", async () => {
    const take = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < take.length; i += 4096) take.writeUInt32LE(i, i);
    const res = await fetch(`${testServer.baseUrl}/api/space/upload?dir=&name=take.mp4`, {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: new Uint8Array(take),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "take.mp4", name: "take.mp4" });
    expect((await readFile(path.join(testServer.spaceRoot, "take.mp4"))).equals(take)).toBe(true);
    expect((await readdir(testServer.spaceRoot)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  // A drop that is cancelled or cut off must not leave a truncated file a
  // tree would list as if it were whole, nor a temp file beside it.
  it("leaves nothing behind when the body is cut off", async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.error(new Error("connection dropped"));
      },
    });
    await fetch(`${testServer.baseUrl}/api/space/upload?dir=&name=cut.mp4`, {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: cut,
      // @ts-expect-error — required by undici for a streamed request body
      duplex: "half",
    }).catch(() => undefined);
    await vi.waitFor(async () => {
      const entries = await readdir(testServer.spaceRoot);
      expect(entries.filter((entry) => entry.includes("cut.mp4"))).toEqual([]);
    });
  });

  it("refuses an empty body", async () => {
    expect((await upload("", "blank.png", "")).status).toBe(400);
  });

  it("never escapes the space, whatever the name or folder says", async () => {
    expect((await upload("", "../escaped.png")).status).toBe(200);
    expect(existsSync(path.join(testServer.spaceRoot, "..", "escaped.png"))).toBe(false);
    expect(existsSync(path.join(testServer.spaceRoot, "escaped.png"))).toBe(true);

    // A `..` segment never parses at all now that every write resolves
    // through the rooted doorway, so this is a refusal naming the path
    // rather than a failure falling out of the filesystem.
    expect((await upload("../..", "outside.png")).status).toBe(400);
    expect((await upload("", ".hidden.png")).status).toBe(200);
    expect(existsSync(path.join(testServer.spaceRoot, "hidden.png"))).toBe(true);
  });

  it("404s on a folder that isn't there and 405s on a GET", async () => {
    expect((await upload("nope", "cover.png")).status).toBe(404);
    expect((await fetch(`${testServer.baseUrl}/api/space/upload?dir=&name=a.png`)).status).toBe(405);
  });
});

// The entry-name rule (docs/protocol.md's "Entry names"), across the routes
// that mint a name. The split under test is where the name came from, not
// which route it reached: typed names are refused, dragged ones repaired.
describe("API contract — entry names", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function create(name: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type: "file" }),
    });
  }

  async function move(from: string, to: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  }

  it("refuses a typed name Windows would reject, and says which rule it broke", async () => {
    const res = await create("a<b>.md");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/can't contain/);
    expect(existsSync(path.join(testServer.spaceRoot, "a<b>.md"))).toBe(false);
  });

  it("refuses a typed name the tree would then hide", async () => {
    const res = await create(".hidden.md");
    expect(res.status).toBe(400);
    expect(existsSync(path.join(testServer.spaceRoot, ".hidden.md"))).toBe(false);
  });

  // `..drafts.md` is not an escape — resolving it is fine — but it is still a
  // leading-dot name the tree would hide, so the two rules reach the same
  // verdict here for entirely different reasons.
  it("refuses a leading-dot name for hiding, not for escaping", async () => {
    const res = await create("..drafts.md");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/start with a dot/);
  });

  // A dot inside a title is not an extension: the name still has to land
  // as something the tree lists, while a kind typed out stays as typed.
  it("makes a note of a dotted title rather than a file the tree hides", async () => {
    const res = await create("Version 1.2 notes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "Version 1.2 notes.md", type: "file" });

    expect((await create("scene.fountain")).status).toBe(200);
    expect(existsSync(path.join(testServer.spaceRoot, "scene.fountain"))).toBe(true);
  });

  // A rename is a typed name too, and was the one route that judged the
  // destination's containment without ever judging its name.
  it("refuses a rename into an illegal name, leaving the original alone", async () => {
    expect((await create("renameable.md")).status).toBe(200);

    const res = await move("renameable.md", "a|b.md");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/can't contain/);
    expect(existsSync(path.join(testServer.spaceRoot, "renameable.md"))).toBe(true);
  });

  // Only the destination's last segment is judged by the name grammar: the
  // folders above it are already on disk, and re-judging them would refuse
  // a legal rename over a name the writer isn't touching. A *hidden* folder
  // is a different rule — a location nothing pragma writes under — and is
  // refused on that ground, not on its name.
  it("judges the new name, not the directories it is moving into", async () => {
    await mkdir(path.join(testServer.spaceRoot, "odd|name"), { recursive: true });
    expect((await create("movable.md")).status).toBe(200);

    expect((await move("movable.md", "odd|name/movable.md")).status).toBe(200);
    expect(existsSync(path.join(testServer.spaceRoot, "odd|name", "movable.md"))).toBe(true);

    await mkdir(path.join(testServer.spaceRoot, "..archive"), { recursive: true });
    const hidden = await move("odd|name/movable.md", "..archive/movable.md");
    expect(hidden.status).toBe(403);
    expect(await hidden.text()).toContain("Hidden");
    expect(existsSync(path.join(testServer.spaceRoot, "odd|name", "movable.md"))).toBe(true);
  });

  // macOS and Windows fold two names that differ only by case onto one
  // file, so a space holding both can't be checked out there. The rule
  // holds on every platform, including the ones whose filesystem would
  // allow it — hence a 409 here rather than a filesystem error.
  it("refuses a typed name that differs from a sibling only by case", async () => {
    expect((await create("Folded.md")).status).toBe(200);

    const res = await create("folded.md");
    expect(res.status).toBe(409);
    expect(existsSync(path.join(testServer.spaceRoot, "Folded.md"))).toBe(true);
  });

  it("refuses a rename onto a sibling that differs only by case", async () => {
    expect((await create("keeper.md")).status).toBe(200);
    expect((await create("mover.md")).status).toBe(200);

    expect((await move("mover.md", "KEEPER.md")).status).toBe(409);
    expect(existsSync(path.join(testServer.spaceRoot, "mover.md"))).toBe(true);
  });

  // `é` typed is one code point; from Finder it is often `e` plus a
  // combining accent. macOS stores both as one file, so a rename that missed
  // the match would replace the sibling instead of failing.
  it("refuses a typed name that differs from a sibling only by Unicode normalization", async () => {
    expect((await create("cafe\u0301.md")).status).toBe(200);

    expect((await create("caf\u00e9.md")).status).toBe(409);
    expect(await readdir(testServer.spaceRoot)).not.toContain("caf\u00e9.md");
  });

  it("refuses a rename onto a sibling that differs only by Unicode normalization", async () => {
    expect((await create("r\u00e9sum\u00e9.md")).status).toBe(200);
    expect((await create("draft.md")).status).toBe(200);

    expect((await move("draft.md", "re\u0301sume\u0301.md")).status).toBe(409);
    expect(existsSync(path.join(testServer.spaceRoot, "draft.md"))).toBe(true);
  });

  it("still refuses a rename onto a sibling's exact name", async () => {
    expect((await create("taken.md")).status).toBe(200);
    expect((await create("taker.md")).status).toBe(200);

    expect((await move("taker.md", "taken.md")).status).toBe(409);
    expect(existsSync(path.join(testServer.spaceRoot, "taker.md"))).toBe(true);
  });

  // An entry is never its own collision, or a badly-cased name could never
  // be fixed. On a case-sensitive filesystem this is an ordinary rename, so
  // only a macOS or Windows run exercises the identity check behind it.
  it("allows a rename that changes only an entry's own casing", async () => {
    expect((await create("casing.md")).status).toBe(200);

    expect((await move("casing.md", "Casing.md")).status).toBe(200);
    expect(await readdir(testServer.spaceRoot)).toContain("Casing.md");
  });

  it("allows a rename that changes only an entry's own Unicode normalization", async () => {
    expect((await create("nai\u0308ve.md")).status).toBe(200);

    expect((await move("nai\u0308ve.md", "na\u00efve.md")).status).toBe(200);
    const entries = await readdir(testServer.spaceRoot);
    expect(entries).toContain("na\u00efve.md");
    expect(entries).not.toContain("nai\u0308ve.md");
  });

  // Making a space takes a folder, which only the desktop app's picker and
  // the command line may choose: no route creates one, so a device the
  // remote-access target serves can't make folders on the host.
  it("has no route that creates a space", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes" }),
    });
    expect(res.status).toBe(404);
  });

  // Where a published page sits on the service follows its folder, so a move
  // leaves the published copy out of date even when the name is unchanged.
  it("moving a published page into another folder queues its republish", async () => {
    const siteDir = path.join(testServer.spaceRoot, "move-site");
    await mkdir(path.join(siteDir, "news"), { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_move", slug: "move", name: "M" }));
    await writeFile(path.join(siteDir, "post.md"), "---\nid: doc_post\n---\n\n# Post\n", "utf8");

    const res = await fetch(`${testServer.baseUrl}/api/space/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "move-site/post.md", to: "move-site/news/post.md" }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(await readFile(path.join(siteDir, "_queue.json"), "utf8"))).toEqual([
      { op: "publish", id: "doc_post" },
    ]);
  });

  // A page never published is queued by its path, which starts with the
  // site's folder, so renaming that folder has to carry the entry along.
  it("renaming a site's folder carries a never-published page's queued path", async () => {
    const siteDir = path.join(testServer.spaceRoot, "named-site");
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "_site.json"), JSON.stringify({ id: "ste_named", slug: "named", name: "N" }));
    const saved = await fetch(`${testServer.baseUrl}/api/file?path=named-site/draft.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Draft\n" }),
    });
    expect(saved.status).toBe(200);

    const res = await fetch(`${testServer.baseUrl}/api/space/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "named-site", to: "renamed-site" }),
    });

    expect(res.status).toBe(200);
    const queuePath = path.join(testServer.spaceRoot, "renamed-site", "_queue.json");
    expect(JSON.parse(await readFile(queuePath, "utf8"))).toEqual([{ op: "publish", path: "renamed-site/draft.md" }]);
  });
});

describe("API contract — folder order", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
    await writeDoc("blog/b-old.md", "date: 2026-01-01");
    await writeDoc("blog/a-new.md", "date: 2026-06-01\ntitle: New");
    await writeDoc("blog/c-undated.md", "title: Undated");
    await writeDoc("blog/m-folder/index.md", "date: 2026-03-01");
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function post(route: string, body: unknown): Promise<Response> {
    return fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function folder(dir: string): Promise<SpaceTreeNode> {
    const tree = (await (await fetch(`${testServer.baseUrl}/api/space/tree`)).json()) as SpaceTreeNode[];
    const node = tree.find((entry) => entry.path === dir);
    if (!node) throw new Error(`no ${dir} in the tree`);
    return node;
  }

  const names = async (dir: string) => (await folder(dir)).children?.map((child) => child.name);

  async function writeDoc(relative: string, frontmatter: string): Promise<void> {
    const absolute = path.join(testServer.spaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `---\n${frontmatter}\n---\n\nBody.\n`);
  }

  it("orders a folder by a frontmatter property, a folder by its index.md, undated last", async () => {
    expect(await names("blog")).toEqual(["m-folder", "a-new.md", "b-old.md", "c-undated.md"]);

    const byDate = { by: "property", property: "date", order: "desc" };
    expect((await post("/api/space/sort", { dir: "blog", sort: byDate })).status).toBe(204);
    expect(await names("blog")).toEqual(["a-new.md", "m-folder", "b-old.md", "c-undated.md"]);
    const node = await folder("blog");
    expect(node.sort).toEqual(byDate);
    expect(node.sortable).toBe(false);
    expect(node.children?.find((child) => child.name === "b-old.md")?.sortValue).toBe(Date.UTC(2026, 0, 1));
  });

  it("sees an edit made outside pragma on the next read", async () => {
    await writeDoc("blog/b-old.md", "date: 2027-01-01");
    expect(await names("blog")).toEqual(["b-old.md", "a-new.md", "m-folder", "c-undated.md"]);
    await writeDoc("blog/b-old.md", "date: 2026-01-01");
  });

  it("suggests the keys that hold a sortable value, most used first", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/sort-keys?dir=blog`);
    expect(await res.json()).toEqual({ keys: ["date", "title"] });
  });

  it("keeps whatever else the folder's file holds when the rule is written", async () => {
    const file = path.join(testServer.spaceRoot, "blog/_properties.json");
    const byDate = { by: "property", property: "date", order: "desc" };
    await writeFile(file, JSON.stringify({ tags: ["posts"], sort: byDate }));
    expect((await post("/api/space/sort", { dir: "blog", sort: byDate })).status).toBe(204);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ tags: ["posts"], sort: byDate });
  });

  it("switching to manual keeps the current order, and switching away keeps the manifest", async () => {
    const order = await names("blog");
    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "manual" }, order })).status).toBe(204);
    expect(await names("blog")).toEqual(order);
    expect((await folder("blog")).sortable).toBe(true);

    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "name", order: "asc" } })).status).toBe(204);
    expect(await names("blog")).toEqual(["m-folder", "a-new.md", "b-old.md", "c-undated.md"]);
    expect(existsSync(path.join(testServer.spaceRoot, "blog/_structure.json"))).toBe(true);

    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "manual" } })).status).toBe(204);
    expect(await names("blog")).toEqual(order);
  });

  // Every sort but manual is a rule, so the manifest stays to come back to.
  it("keeps a size or date sort as a rule, leaving the manifest as it was", async () => {
    const manifest = await readFile(path.join(testServer.spaceRoot, "blog/_structure.json"), "utf8");
    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "size", order: "asc" } })).status).toBe(204);
    expect(await names("blog")).toEqual(["m-folder", "c-undated.md", "b-old.md", "a-new.md"]);
    expect((await folder("blog")).sort).toEqual({ by: "size", order: "asc" });
    expect(await readFile(path.join(testServer.spaceRoot, "blog/_structure.json"), "utf8")).toBe(manifest);
    const properties = JSON.parse(await readFile(path.join(testServer.spaceRoot, "blog/_properties.json"), "utf8"));
    expect(properties.sort).toEqual({ by: "size", order: "asc" });

    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "created", order: "desc" } })).status).toBe(204);
    expect((await folder("blog")).sort).toEqual({ by: "created", order: "desc" });
    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "manual" } })).status).toBe(204);
  });

  it("refuses an unknown rule or a form before `by`, and a manual order that isn't the folder's entries", async () => {
    expect((await post("/api/space/sort", { dir: "blog", sort: "name" })).status).toBe(400);
    expect((await post("/api/space/sort", { dir: "blog", sort: { property: "date", order: "desc" } })).status).toBe(
      400,
    );
    expect((await post("/api/space/sort", { dir: "blog", sort: { by: "date" } })).status).toBe(400);
    await writeDoc("fresh/a.md", "date: 2026-01-01");
    expect((await post("/api/space/sort", { dir: "fresh", sort: { by: "manual" }, order: ["nope.md"] })).status).toBe(
      400,
    );
  });

  it("ignores a stored sort in a form before `by`, as if absent", async () => {
    await writeDoc("legacy/a.md", "date: 2026-01-01");
    await writeDoc("legacy/b.md", "date: 2026-06-01");
    await writeFile(
      path.join(testServer.spaceRoot, "legacy/_properties.json"),
      JSON.stringify({ sort: { property: "date", order: "desc" } }),
    );
    expect(await names("legacy")).toEqual(["a.md", "b.md"]);
    expect((await folder("legacy")).sort).toBeUndefined();
  });
});

describe("API contract — toolkits", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
    const root = testServer.spaceRoot;
    await mkdir(path.join(root, "tools"), { recursive: true });
    // A tag names no toolkit, whatever an old entry still holds.
    await writeFile(
      path.join(root, "_tags.json"),
      JSON.stringify({ tags: [{ name: "redo" }, { name: "helper", toolkit: "/tools/polish.flow.html" }] }),
    );
    await writeFile(
      path.join(root, "tools", "rewrite.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Rewrite",
        graph: {
          nodes: [
            { id: "expand", type: "button", position: { x: 0, y: 200 }, config: {}, label: "Expand" },
            { id: "tighten", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Tighten" },
            { id: "put-a", type: "replaceSelection", position: { x: 400, y: 0 }, config: {} },
            { id: "put-b", type: "replaceSelection", position: { x: 400, y: 200 }, config: {} },
          ],
          edges: [
            { id: "e-a", source: "tighten", sourcePort: "selection", target: "put-a", targetPort: "text" },
            { id: "e-b", source: "expand", sourcePort: "selection", target: "put-b", targetPort: "text" },
          ],
        },
      }),
    );
    await writeFile(path.join(root, "draft.md"), "---\ntags: [redo]\n---\n\nSome text.\n");
    await writeFile(path.join(root, "helped.md"), "---\ntags: [helper]\n---\n\nSome text.\n");
    // A Class over the whole space holding what is tagged redo, linking a
    // Flow and one that isn't there. The template space's own Class holds
    // what is tagged rewrite, so this one's tag is another.
    await writeFile(
      path.join(root, "drafts.class.html"),
      serializeClassFile({
        version: "1.0",
        filter: [{ property: "tags", test: "has", values: ["redo"] }],
        fields: [
          { id: "rating", type: "score", label: "Rating" },
          { id: "status", type: "select", label: "Status", options: ["draft", "final"] },
          { id: "file.modified", type: "timestamp", label: "Modified" },
        ],
        views: [],
        links: ["tools/rewrite.flow.html", "tools/missing.flow.html"],
      }),
    );

    // A Class over a scope's lyrics folders, linking its rows two Flows, one
    // the drafts Class's too, a template and a guide; and a template Class
    // that would hold every note. Written before any read, since the space's
    // Classes are kept until it changes.
    await writeFile(
      path.join(root, "tools", "polish.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Polish",
        graph: {
          nodes: [{ id: "polish", type: "replaceSelection", position: { x: 0, y: 0 }, config: {}, label: "Polish" }],
          edges: [],
        },
      }),
    );
    await mkdir(path.join(root, "songs", "tools"), { recursive: true });
    await mkdir(path.join(root, "songs", "chico", "lyrics", "moon"), { recursive: true });
    await mkdir(path.join(root, "songs", "chico", "notes"), { recursive: true });
    await writeFile(path.join(root, "songs", "AGENTS.md"), "---\npragma:\n---\n\nSongs.\n");
    await writeFile(
      path.join(root, "songs", "tools", "lyrics.class.html"),
      serializeClassFile({
        version: "1.0",
        filter: [{ property: "file.folder", test: "is", values: ["*/lyrics"] }],
        fields: [
          { id: "rating", type: "score", label: "Stars" },
          { id: "status", type: "select", label: "Status", options: ["final"] },
        ],
        views: [],
        links: [
          "../../tools/polish.flow.html",
          "/presets/templates/song.md",
          "../voice.md",
          "../../tools/rewrite.flow.html",
          "../gone.md",
        ],
      }),
    );
    await writeFile(path.join(root, "songs", "voice.md"), "# Voice\n\nShort lines.\n");
    await writeFile(path.join(root, "songs", "chico", "lyrics", "sun.md"), "---\ntags: [redo]\n---\n\nVerse.\n");
    await writeFile(path.join(root, "songs", "chico", "lyrics", "moon", "index.md"), "# Moon\n");
    await writeFile(path.join(root, "songs", "chico", "notes", "idea.md"), "An idea.\n");
    await mkdir(path.join(root, "presets", "templates"), { recursive: true });
    await writeFile(path.join(root, "presets", "templates", "song.md"), "# {{$title}}\n");
    await writeFile(
      path.join(root, "presets", "templates", "everything.class.html"),
      serializeClassFile({
        version: "1.0",
        filter: [],
        fields: [],
        views: [],
        links: ["/tools/polish.flow.html"],
      }),
    );
    // A Class in another folder holding the screenplays of one it names,
    // though they have no tags of their own.
    await writeFile(
      path.join(root, "tools", "screenplay.class.html"),
      serializeClassFile({
        version: "1.0",
        filter: [{ property: "file.folder", test: "is", values: ["scenes"] }],
        fields: [],
        views: [],
        links: ["polish.flow.html"],
      }),
    );
    await mkdir(path.join(root, "scenes", "act-2"), { recursive: true });
    await writeFile(path.join(root, "scenes", "one.fountain"), "INT. ROOM - DAY\n");
    await writeFile(path.join(root, "scenes", "act-2", "two.fountain"), "EXT. ROAD - NIGHT\n");
    // A Class holding its own folder's screenplays by extension, the rule and
    // the file spelling it in different cases.
    await mkdir(path.join(root, "reels"), { recursive: true });
    await writeFile(
      path.join(root, "reels", "reels.class.html"),
      serializeClassFile({
        version: "1.0",
        filter: [
          { property: "file.folder", test: "is", values: ["this.file.folder"] },
          { property: "file.ext", test: "is", values: [".Fountain"] },
        ],
        fields: [],
        views: [],
        links: ["../tools/rewrite.flow.html"],
      }),
    );
    await writeFile(path.join(root, "reels", "cut.FOUNTAIN"), "INT. EDIT BAY - NIGHT\n");
    await writeFile(path.join(root, "reels", "cut.md"), "Notes on the cut.\n");
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("gives a Table the toolkits its own links name, dropping a Flow that isn't there", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "tools", "shots.table.html"),
      serializeTableFile({
        version: "1.0",
        columns: [{ id: "title", type: "text", label: "Title" }],
        rows: [],
        links: ["rewrite.flow.html", "missing.flow.html"],
      }),
    );
    const body = await (await fetch(`${testServer.baseUrl}/api/file?path=tools/shots.table.html`)).json();
    expect(body.links).toEqual(["rewrite.flow.html", "missing.flow.html"]);
    expect(
      body.toolkits.map((toolkit: { path: string; classPath: string }) => [toolkit.path, toolkit.classPath]),
    ).toEqual([["tools/rewrite.flow.html", "tools/shots.table.html"]]);
    expect(body.toolkits[0].actions.map((action: { label: string }) => action.label)).toEqual(["Tighten", "Expand"]);
  });

  // Its tags can't be read, but it has to open for the writer to fix it.
  it("opens a document whose frontmatter doesn't parse, with no toolkits", async () => {
    const broken = "---\ntags: [rewrite]\ntitle: Chapter 1: The Start\n---\n\nSome text.\n";
    await writeFile(path.join(testServer.spaceRoot, "broken.md"), broken);

    const res = await fetch(`${testServer.baseUrl}/api/file?path=broken.md`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe(broken);
    expect(body.toolkits).toEqual([]);
  });

  it("resolves a Flow toolkit to its Buttons, naming its Class, and drops a Flow that isn't there", async () => {
    const body = await (await fetch(`${testServer.baseUrl}/api/file?path=draft.md`)).json();

    expect(body.toolkits.map((toolkit: { path: string }) => toolkit.path)).toEqual(["tools/rewrite.flow.html"]);
    expect(body.toolkits[0]).toEqual({
      classPath: "drafts.class.html",
      path: "tools/rewrite.flow.html",
      name: "Rewrite",
      actions: [
        { nodeId: "tighten", label: "Tighten", nodeType: "replaceSelection" },
        { nodeId: "expand", label: "Expand", nodeType: "replaceSelection" },
      ],
    });
  });

  it("gives each row of a Class its Flows, the Classes in path order, and a Flow two give once", async () => {
    const toolkits = async (docPath: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(docPath)}`)).json()).toolkits.map(
        (toolkit: { classPath: string; path: string }) => [toolkit.classPath, toolkit.path],
      );

    expect(await toolkits("songs/chico/lyrics/sun.md")).toEqual([
      ["drafts.class.html", "tools/rewrite.flow.html"],
      ["songs/tools/lyrics.class.html", "tools/polish.flow.html"],
    ]);
    // A folder's row is its index.md, held by the folder above it.
    expect(await toolkits("songs/chico/lyrics/moon/index.md")).toEqual([
      ["songs/tools/lyrics.class.html", "tools/polish.flow.html"],
      ["songs/tools/lyrics.class.html", "tools/rewrite.flow.html"],
    ]);
    expect(await toolkits("songs/chico/notes/idea.md")).toEqual([]);
    // The template Class reads the whole space, yet gives nothing, and a tag
    // gives nothing of its own.
    expect(await toolkits("draft.md")).toEqual([["drafts.class.html", "tools/rewrite.flow.html"]]);
    expect(await toolkits("helped.md")).toEqual([]);
  });

  it("gives a Class's Flows to what its folder rule holds, and not the folders below", async () => {
    const toolkits = async (docPath: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(docPath)}`)).json()).toolkits.map(
        (toolkit: { classPath?: string; path: string }) => [toolkit.classPath, toolkit.path],
      );

    expect(await toolkits("scenes/one.fountain")).toEqual([["tools/screenplay.class.html", "tools/polish.flow.html"]]);
    expect(await toolkits("scenes/act-2/two.fountain")).toEqual([]);
  });

  it("gives a Class's Flows to the files its extension rule names, and no other kind", async () => {
    const toolkits = async (docPath: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(docPath)}`)).json()).toolkits.map(
        (toolkit: { classPath: string; path: string }) => [toolkit.classPath, toolkit.path],
      );

    expect(await toolkits("reels/cut.FOUNTAIN")).toEqual([["reels/reels.class.html", "tools/rewrite.flow.html"]]);
    expect(await toolkits("reels/cut.md")).toEqual([]);
  });

  it("lists in a row's Links tab what its Class links it to that is neither a Flow nor a template", async () => {
    const classLinks = async (docPath: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(docPath)}`)).json()).classLinks;

    expect(await classLinks("songs/chico/lyrics/sun.md")).toEqual([
      { classPath: "songs/tools/lyrics.class.html", name: "lyrics", paths: ["songs/voice.md"] },
    ]);
    expect(await classLinks("songs/chico/notes/idea.md")).toEqual([]);
  });

  it("types a row's properties by the fields its Classes give them, and no key two define differently", async () => {
    const fields = async (docPath: string) =>
      (await (await fetch(`${testServer.baseUrl}/api/file?path=${encodeURIComponent(docPath)}`)).json()).fields;

    expect(await fields("draft.md")).toEqual([
      { id: "rating", type: "score", label: "Rating" },
      { id: "status", type: "select", label: "Status", options: ["draft", "final"] },
    ]);
    // The lyrics Class scores it alike under another label, and offers
    // other options.
    expect(await fields("songs/chico/lyrics/sun.md")).toEqual([{ id: "rating", type: "score", label: "Rating" }]);
    expect(await fields("songs/chico/notes/idea.md")).toEqual([]);
  });

  it("derives readCurrentDocument from a Current Document node, and nothing for Replace Selection", async () => {
    const grant = (capabilityKey: string) =>
      fetch(`${testServer.baseUrl}/api/sandbox/grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "flow", path: "tools/rewrite.flow.html", capabilityKey }),
      });
    expect((await grant("readCurrentDocument")).status).toBe(204);
    expect((await grant("replaceSelection")).status).toBe(400);
  });
});

// The template space's tags example, untouched: the suite above writes its own
// _tags.json over the template's, so it can't notice the shipped example going
// stale.
describe("API contract — template space toolkits", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("gives the tagged sample document the rewrite Flow's buttons, through the Rewrite Class", async () => {
    const body = await (
      await fetch(`${testServer.baseUrl}/api/file?path=projects/getting-started/sample-scene.md`)
    ).json();

    expect(
      body.toolkits.map((toolkit: { classPath: string; path: string }) => [toolkit.classPath, toolkit.path]),
    ).toEqual([
      ["projects/getting-started/rewrite.class.html", "projects/getting-started/rewrite-selection.flow.html"],
    ]);
    expect(body.toolkits[0].actions.map((action: { label: string }) => action.label).sort()).toEqual([
      "Expand",
      "Save summary",
      "Tighten",
    ]);
    // Each button carries its node's color, so a host can fill it.
    const colors = Object.fromEntries(
      body.toolkits[0].actions.map((action: { label: string; color?: string }) => [action.label, action.color]),
    );
    expect(colors).toEqual({ Tighten: "#0189d2", Expand: "#0db14c", "Save summary": "#f3701f" });
  });

  it("gives the tagged brochure both translation toolkits' buttons, in the Class's link order", async () => {
    const body = await (await fetch(`${testServer.baseUrl}/api/file?path=projects/translation/brochure.md`)).json();

    const classPath = "projects/translation/jobs.class.html";
    expect(
      body.toolkits.map((toolkit: { classPath: string; path: string }) => [toolkit.classPath, toolkit.path]),
    ).toEqual([
      [classPath, "projects/translation/tools/translate.flow.html"],
      [classPath, "projects/translation/tools/review.flow.html"],
    ]);
    expect(
      body.toolkits.map((toolkit: { actions: { label: string }[] }) => toolkit.actions.map((action) => action.label)),
    ).toEqual([
      ["Translate", "Alternatives"],
      ["Back-translate", "Check terms", "Query client"],
    ]);
  });
});

// docs/protocol.md's Tags → Declared tags: the whole list read, one tag
// changed per request against the file as it stands.
describe("API contract — tags", () => {
  let testServer: TestServer;
  const tagsFile = () => path.join(testServer.spaceRoot, "_tags.json");
  const change = (body: unknown) =>
    fetch(`${testServer.baseUrl}/api/space/tags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const names = (answer: { tags: { name: string }[] }) => answer.tags.map((tag) => tag.name);

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  it("reads the template space's tags", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/tags`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tags: [
        { name: "rewrite", color: "#0189d2" },
        { name: "draft", color: "#9b9a97" },
        { name: "translate", color: "#0db14c" },
      ],
      used: [],
    });
  });

  it("answers the tags documents carry that none declares, each once, templates left out", async () => {
    const dir = path.join(testServer.spaceRoot, "used-tags");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.md"), "---\ntags: [Night, DRAFT]\n---\n\n#rain and #Night\n");
    await writeFile(path.join(dir, "b.md"), "#night falls, #Rain/heavy\n");
    await writeFile(path.join(dir, "c.md"), "#night\n");
    await mkdir(path.join(testServer.spaceRoot, "presets", "templates"), { recursive: true });
    await writeFile(path.join(testServer.spaceRoot, "presets", "templates", "t.md"), "#template-only\n");
    try {
      const answer = (await (await fetch(`${testServer.baseUrl}/api/space/tags`)).json()) as { used: string[] };
      // DRAFT is the declared draft; Night is written as most documents write it.
      expect(answer.used.sort()).toEqual(["Rain/heavy", "night", "rain"]);
    } finally {
      await rm(dir, { recursive: true });
      await rm(path.join(testServer.spaceRoot, "presets", "templates", "t.md"));
    }
  });

  it("declares a tag, then sets and clears its color, writing one line per tag", async () => {
    const declared = await change({ name: " art " });
    expect(declared.status).toBe(200);
    expect(names(await declared.json())).toEqual(["rewrite", "draft", "translate", "art"]);

    expect((await change({ name: "art", color: "#E03E3E" })).status).toBe(200);
    const written = await readFile(tagsFile(), "utf8");
    expect(written.split("\n")).toContain('    { "name": "art", "color": "#e03e3e" }');

    const cleared = await (await change({ name: "art", color: "" })).json();
    expect(cleared.tags.at(-1)).toEqual({ name: "art", color: "" });
    expect(await readFile(tagsFile(), "utf8")).toContain('    { "name": "art" }\n');

    expect(names(await (await change({ name: "art", remove: true })).json())).toEqual([
      "rewrite",
      "draft",
      "translate",
    ]);
  });

  it("keeps the keys it doesn't read, in the file and in each entry", async () => {
    await writeFile(
      tagsFile(),
      JSON.stringify({ $comment: "mine", tags: [{ name: "draft", color: "#9b9a97", owner: "alice" }] }),
    );
    expect((await change({ name: "draft", color: "#0db14c" })).status).toBe(200);
    expect(JSON.parse(await readFile(tagsFile(), "utf8"))).toEqual({
      $comment: "mine",
      tags: [{ name: "draft", color: "#0db14c", owner: "alice" }],
    });
  });

  it("leaves no file once the last tag is removed and nothing else is in it", async () => {
    await writeFile(tagsFile(), JSON.stringify({ tags: [{ name: "draft" }] }));
    // The template space's notes carry all three tags, which no file now declares.
    const undeclared = { tags: [], used: ["draft", "rewrite", "translate"] };
    expect(await (await change({ name: "draft", remove: true })).json()).toEqual(undeclared);
    expect(existsSync(tagsFile())).toBe(false);
    expect(await (await fetch(`${testServer.baseUrl}/api/space/tags`)).json()).toEqual(undeclared);
  });

  it("declares a name sent with its # by the name alone", async () => {
    await writeFile(tagsFile(), JSON.stringify({ tags: [{ name: "draft" }] }));
    expect(names(await (await change({ name: "#art" })).json())).toEqual(["draft", "art"]);
    expect(await readFile(tagsFile(), "utf8")).toContain('    { "name": "art" }\n');
    expect(names(await (await change({ name: "Art", remove: true })).json())).toEqual(["draft"]);
  });

  it("refuses a change that isn't one", async () => {
    const refusals = [
      [{}, "A tag needs a name"],
      [{ name: "  " }, "A tag needs a name"],
      [{ name: "two words" }, "A tag can't contain spaces, or punctuation other than _ - and /"],
      [{ name: "2024" }, "A tag can't be only digits"],
      [{ name: "x", color: "red" }, "color must be a hex color, or empty"],
      [{ name: "x", remove: "yes" }, "remove must be true"],
    ] as const;
    for (const [body, message] of refusals) {
      const res = await change(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).toBe(message);
    }
    expect((await fetch(`${testServer.baseUrl}/api/space/tags`, { method: "PUT" })).status).toBe(405);
  });

  // A hand edit gone wrong must survive until someone fixes it: a write
  // would replace it with the one tag being changed.
  it("reports a file that doesn't read, and never writes over it", async () => {
    await writeFile(tagsFile(), '{ "tags": [ { "name": "draft" }, ] }');
    const read = (await (await fetch(`${testServer.baseUrl}/api/space/tags`)).json()) as { tags: []; problem: string };
    expect(read.tags).toEqual([]);
    expect(read.problem).toMatch(/^_tags\.json doesn't parse: /);

    const refused = await change({ name: "art" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/Fix the file, then try again\.$/);
    expect(await readFile(tagsFile(), "utf8")).toBe('{ "tags": [ { "name": "draft" }, ] }');

    await writeFile(tagsFile(), JSON.stringify({ tags: "draft" }));
    expect((await (await fetch(`${testServer.baseUrl}/api/space/tags`)).json()).problem).toBe(
      "_tags.json holds no list of tags",
    );
    expect((await change({ name: "art" })).status).toBe(409);
  });
});

// A provider's image models sit beside its text models: Generate Image's
// picker lists them, no text picker does. Providers and MCP servers share
// one id namespace, since an image model ref may name either.
describe("API contract — model providers", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  const post = (route: string, body: Record<string, unknown>) =>
    fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("offers a provider's image models to Generate Image and to no text picker", async () => {
    // A local endpoint saves without a key, so nothing here reaches a network.
    const local = {
      id: "local",
      kind: "openai",
      label: "Local",
      baseURL: "http://127.0.0.1:9/v1",
      textModels: ["qwen"],
    };
    expect((await post("/api/providers", local)).status).toBe(204);
    expect((await post("/api/providers", { id: "local", imageModels: ["gpt-image-1"] })).status).toBe(204);

    const { providers } = await (await fetch(`${testServer.baseUrl}/api/providers`)).json();
    expect(providers.find((row: { id: string }) => row.id === "local")).toMatchObject({
      textModels: ["qwen"],
      imageModels: ["gpt-image-1"],
    });
    const text = await (await fetch(`${testServer.baseUrl}/api/models`)).json();
    expect(text.models.map((model: { id: string }) => model.id)).not.toContain("local/gpt-image-1");
    const images = await (await fetch(`${testServer.baseUrl}/api/image-models`)).json();
    // With what the model support file says it takes, whoever serves it.
    expect(images.models).toEqual([
      {
        id: "local/gpt-image-1",
        label: "gpt-image-1 (Local)",
        provider: "local",
        model: "gpt-image-1",
        references: { image: 16 },
      },
    ]);
    // Its own endpoint, so no vendor's mark.
    expect(images.providers).toEqual([{ id: "local", label: "Local" }]);
  });

  it("saves Settings' default image model, refusing one no run could use, and clears it with None", async () => {
    const pics = { id: "pics", kind: "openai", label: "Pics", baseURL: "http://127.0.0.1:9/v1" };
    expect((await post("/api/providers", pics)).status).toBe(204);
    expect((await post("/api/providers", { id: "pics", imageModels: ["gpt-image-1"] })).status).toBe(204);
    const defaultImageModel = async () =>
      (await (await fetch(`${testServer.baseUrl}/api/image-models`)).json()).defaultModel;

    expect((await post("/api/image-models/default", { model: "pics/gpt-image-1" })).status).toBe(204);
    expect(await defaultImageModel()).toBe("pics/gpt-image-1");

    const unknown = await post("/api/image-models/default", { model: "nowhere/gpt-image-1" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toBe(
      'No provider "nowhere" is configured for image model "nowhere/gpt-image-1".',
    );
    expect((await post("/api/image-models/default", { model: "gpt-image-1" })).status).toBe(400);
    expect((await post("/api/image-models/default", {})).status).toBe(400);
    expect((await fetch(`${testServer.baseUrl}/api/image-models/default`)).status).toBe(405);
    expect(await defaultImageModel()).toBe("pics/gpt-image-1");

    expect((await post("/api/image-models/default", { model: "" })).status).toBe(204);
    expect(await defaultImageModel()).toBeNull();
  });

  // A chat that names no model runs on the saved text default: asking it for
  // an effort its default doesn't take is refused naming that model, which
  // no request reaches. With None, the same turn has no model at all.
  it("saves Settings' default text model, which a turn naming none runs on, and clears it with None", async () => {
    const local = {
      id: "deflocal",
      kind: "openai",
      label: "Def",
      baseURL: "http://127.0.0.1:9/v1",
      textModels: ["qwen"],
    };
    expect((await post("/api/providers", local)).status).toBe(204);
    const defaultModel = async () => (await (await fetch(`${testServer.baseUrl}/api/models`)).json()).defaultModel;
    const turn = () => post("/api/chat?folderPath=", { history: [], message: "hi", effort: "high" });

    expect((await post("/api/models/default", { model: "deflocal/qwen" })).status).toBe(204);
    expect(await defaultModel()).toBe("deflocal/qwen");
    const onDefault = await turn();
    expect(onDefault.status).toBe(400);
    expect(await onDefault.text()).toBe('Model "qwen" takes no "high" effort level.');

    const unknown = await post("/api/models/default", { model: "nowhere/qwen" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toBe(
      'No provider "nowhere" is configured for model "nowhere/qwen". Add it in Settings → AI Models.',
    );
    expect(await defaultModel()).toBe("deflocal/qwen");

    expect((await post("/api/models/default", { model: "" })).status).toBe(204);
    expect(await defaultModel()).toBeNull();
    const onNone = await turn();
    expect(onNone.status).toBe(400);
    expect(await onNone.json()).toMatchObject({ need: { kind: "defaultModel", output: "text" } });
  });

  it("keeps a provider and an MCP server off each other's ids", async () => {
    const server = await post("/api/mcp-servers", { id: "local", url: "https://mcp.local.test/mcp" });
    expect(server.status).toBe(400);
    expect((await server.json()).message).toBe('A model provider already has the id "local".');

    expect((await post("/api/mcp-servers", { id: "tools", url: "https://mcp.tools.test/mcp" })).status).toBe(204);
    const provider = await post("/api/providers", { id: "tools", kind: "openai", baseURL: "http://127.0.0.1:9/v1" });
    expect(provider.status).toBe(400);
    expect((await provider.json()).message).toBe('An MCP server already has the id "tools".');
  });

  // A ChatGPT plan signs in, so it is added with no key, refuses one, and
  // never falls back to the OpenAI key in the environment. This test server
  // is not the writer's own machine, so it offers no sign-in.
  it("adds a ChatGPT plan without a key and reports its sign-in, which this host can't start", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-the-environment");
    setCredentialHost("remote");
    try {
      const plan = { id: "chatgpt", kind: "chatgpt", label: "ChatGPT plan", textModels: ["gpt-6.1-sol"] };
      expect((await post("/api/providers", { ...plan, apiKey: "sk-typed" })).status).toBe(400);
      expect((await post("/api/providers", { ...plan, baseURL: "https://elsewhere.test/v1" })).status).toBe(204);

      const listed = await (await fetch(`${testServer.baseUrl}/api/providers`)).json();
      expect(listed.signInAllowed).toBe(false);
      expect(listed.providers.find((row: { id: string }) => row.id === "chatgpt")).toMatchObject({
        kind: "chatgpt",
        vendor: "chatgpt",
        baseURL: "",
        keySource: "none",
        signIn: { state: "signed-out" },
      });
      expect(await (await fetch(`${testServer.baseUrl}/api/providers/sign-in?id=chatgpt`)).json()).toEqual({
        state: "signed-out",
      });

      const start = await post("/api/providers/sign-in", { id: "chatgpt" });
      expect(start.status).toBe(400);
      expect((await start.json()).message).toMatch(
        /needs `pragma start` without `--external-url` on the machine this host runs on/,
      );

      const turn = await post("/api/chat?folderPath=", { history: [], message: "hi", model: "chatgpt/gpt-6.1-sol" });
      expect(turn.status).toBe(401);
      expect(await turn.json()).toEqual({
        message:
          "Sign in to ChatGPT again from `pragma start` without `--external-url` on the machine this host runs on, as the account it runs as.",
        need: { kind: "providerKey", provider: "chatgpt" },
      });

      expect(await (await post("/api/providers/sign-out", { id: "chatgpt" })).json()).toEqual({ revoked: true });
      expect((await post("/api/providers/delete", { id: "chatgpt" })).status).toBe(204);
    } finally {
      setCredentialHost("terminal");
      vi.unstubAllEnvs();
    }
  });

  it("refuses a new Gemini entry with no key anywhere", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    try {
      const res = await post("/api/providers", { id: "gemini", kind: "google", label: "Gemini" });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("Enter an API key for this provider.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A picker groups the text models by provider, and shows a vendor's mark
  // and offers effort levels only for the entry that talks to that
  // vendor's own endpoint.
  it("names each text model's provider, and a vendor and its levels only for an entry with no baseURL", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    try {
      const vendor = { id: "anthropic", kind: "anthropic", label: "Anthropic", textModels: ["claude-sonnet-5"] };
      expect((await post("/api/providers", vendor)).status).toBe(204);
      const sameApi = {
        id: "lan",
        kind: "openai",
        label: "LAN",
        baseURL: "http://127.0.0.1:9/v1",
        textModels: ["gpt-oss"],
      };
      expect((await post("/api/providers", sameApi)).status).toBe(204);

      const body = await (await fetch(`${testServer.baseUrl}/api/models`)).json();
      expect(body.models).toContainEqual({
        id: "anthropic/claude-sonnet-5",
        label: "claude-sonnet-5 (Anthropic)",
        provider: "anthropic",
        model: "claude-sonnet-5",
        effortLevels: ["low", "medium", "high", "xhigh"],
      });
      expect(body.models).toContainEqual({
        id: "lan/gpt-oss",
        label: "gpt-oss (LAN)",
        provider: "lan",
        model: "gpt-oss",
      });
      expect(body.providers).toContainEqual({ id: "anthropic", label: "Anthropic", vendor: "anthropic" });
      expect(body.providers).toContainEqual({ id: "lan", label: "LAN" });

      // Settings' provider rows carry the same answer.
      const { providers } = await (await fetch(`${testServer.baseUrl}/api/providers`)).json();
      const vendors = Object.fromEntries(providers.map((row: { id: string; vendor?: string }) => [row.id, row.vendor]));
      expect([vendors.anthropic, vendors.lan]).toEqual(["anthropic", undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
