import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// The space's bookmarks over HTTP: the list read whole, one bookmark changed
// per request against the file as it stands, and every move and delete the
// server makes keeping them on their entries.
describe("API contract — bookmarks", () => {
  let testServer: TestServer;
  const bookmarksFile = () => path.join(testServer.spaceRoot, ".pragma", "bookmarks.json");
  const post = (route: string, body: unknown) =>
    fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const change = (body: unknown) => post("/api/space/bookmarks", body);
  const read = async () => (await fetch(`${testServer.baseUrl}/api/space/bookmarks`)).json();

  beforeAll(async () => {
    testServer = await startTestServer();
    await mkdir(path.join(testServer.spaceRoot, "notes"), { recursive: true });
  });

  afterAll(async () => {
    await testServer.close();
  });

  beforeEach(async () => {
    await writeFile(path.join(testServer.spaceRoot, "notes", "a.md"), "# A\n");
    await writeFile(path.join(testServer.spaceRoot, "notes", "b.md"), "# B\n");
    if (existsSync(bookmarksFile())) await writeFile(bookmarksFile(), '{ "bookmarks": [] }');
  });

  it("holds none in the template space", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/space/bookmarks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bookmarks: [] });
  });

  it("adds, moves and removes one bookmark per request", async () => {
    expect((await change({ add: "notes/a.md" })).status).toBe(200);
    expect(await (await change({ add: "notes/" })).json()).toEqual({
      bookmarks: [
        { path: "notes/a.md", type: "file" },
        { path: "notes", type: "directory" },
      ],
    });
    const moved = await (await change({ move: "notes", before: "notes/a.md" })).json();
    expect(moved.bookmarks.map((bookmark: { path: string }) => bookmark.path)).toEqual(["notes", "notes/a.md"]);
    expect(await (await change({ remove: "notes" })).json()).toEqual({
      bookmarks: [{ path: "notes/a.md", type: "file" }],
    });
    expect(await readFile(bookmarksFile(), "utf8")).toBe('{\n  "bookmarks": [\n    { "path": "notes/a.md" }\n  ]\n}\n');
  });

  it("refuses a change that isn't one", async () => {
    const refusals = [
      [{}, "a change must add, remove or move one bookmark"],
      [{ add: "notes/a.md", remove: "notes/a.md" }, "a change must add, remove or move one bookmark"],
      [{ add: 3 }, "add must be a path in the space or a library"],
      [{ add: ".trash/a.md" }, "add must be a path in the space or a library"],
      [{ remove: "../a.md" }, "remove must be a path in the space or a library"],
      [{ move: "notes/a.md", before: "" }, "before must be a path in the space or a library"],
    ] as const;
    for (const [body, message] of refusals) {
      const res = await change(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).toBe(message);
    }
    const missing = await change({ add: "notes/gone.md" });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found: notes/gone.md");
    expect((await fetch(`${testServer.baseUrl}/api/space/bookmarks`, { method: "PUT" })).status).toBe(405);
  });

  // The file sits under a dot, where no path a request carries may write.
  it("is out of reach of the file routes and the tree", async () => {
    await change({ add: "notes/a.md" });
    const put = await fetch(`${testServer.baseUrl}/api/file?path=.pragma/bookmarks.json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "{}" }),
    });
    expect(put.status).toBe(403);
    expect(await (await fetch(`${testServer.baseUrl}/api/space/tree`)).text()).not.toContain(".pragma");
  });

  it("follows a move, of the entry or of a folder holding it", async () => {
    await change({ add: "notes/a.md" });
    await change({ add: "notes/b.md" });
    expect((await post("/api/space/move", { from: "notes/a.md", to: "notes/renamed.md" })).status).toBe(200);
    expect((await post("/api/space/move", { from: "notes", to: "archive" })).status).toBe(200);
    expect(await read()).toEqual({
      bookmarks: [
        { path: "archive/renamed.md", type: "file" },
        { path: "archive/b.md", type: "file" },
      ],
    });
    await post("/api/space/move", { from: "archive", to: "notes" });
    await post("/api/space/move", { from: "notes/renamed.md", to: "notes/a.md" });
  });

  it("goes with a deleted entry, trashed or not", async () => {
    await change({ add: "notes/a.md" });
    await change({ add: "notes/b.md" });
    expect((await post("/api/space/delete", { path: "notes/a.md" })).status).toBe(200);
    expect((await post("/api/space/delete", { path: "notes/b.md", trash: false })).status).toBe(200);
    expect(await read()).toEqual({ bookmarks: [] });
  });

  it("keeps a bookmark whose entry went some other way, shown as missing", async () => {
    await writeFile(path.join(testServer.spaceRoot, "notes", "outside.md"), "");
    await change({ add: "notes/outside.md" });
    await rm(path.join(testServer.spaceRoot, "notes", "outside.md"));
    expect(await read()).toEqual({ bookmarks: [{ path: "notes/outside.md" }] });
  });

  // A hand edit gone wrong must survive until someone fixes it.
  it("reports a file that doesn't read, and never writes over it", async () => {
    await mkdir(path.dirname(bookmarksFile()), { recursive: true });
    await writeFile(bookmarksFile(), '{ "bookmarks": [ { "path": "notes/a.md" }, ] }');
    const answer = await read();
    expect(answer.bookmarks).toEqual([]);
    expect(answer.problem).toMatch(/^\.pragma\/bookmarks\.json doesn't parse: /);
    const refused = await change({ add: "notes/b.md" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/Fix the file, then try again\.$/);
    expect((await post("/api/space/move", { from: "notes/a.md", to: "notes/c.md" })).status).toBe(200);
    expect(await readFile(bookmarksFile(), "utf8")).toBe('{ "bookmarks": [ { "path": "notes/a.md" }, ] }');
    await post("/api/space/move", { from: "notes/c.md", to: "notes/a.md" });
    await writeFile(bookmarksFile(), '{ "bookmarks": [] }');
  });
});
