import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWrittenPaths, WRITTEN_HEADER } from "../../src/protocol/api.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// A write's response names what it changed in a listing, which the page tells
// its views at once (src/server/writtenPaths.ts), however the route writes:
// each resolves its target through the one resolver. A save to a file already
// there names nothing, so a note's autosave has no tree read again.
describe("API contract — written entries", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
    await mkdir(path.join(testServer.spaceRoot, "written"));
  });

  afterAll(async () => {
    await testServer.close();
  });

  const named = (response: Response) => readWrittenPaths(response.headers.get(WRITTEN_HEADER));
  const post = (route: string, body: unknown) =>
    fetch(`${testServer.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("names the folder a create or an upload writes into, both ends of a move, and an entry deleted", async () => {
    const created = await post("/api/space/create", { parentPath: "written", name: "a.md", type: "file" });
    expect(created.status).toBe(200);
    expect(named(created)).toEqual(["written"]);

    const uploaded = await fetch(`${testServer.baseUrl}/api/space/upload?dir=written&name=b.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(uploaded.status).toBe(200);
    expect(named(uploaded)).toEqual(["written"]);

    const moved = await post("/api/space/move", { from: "written/a.md", to: "written/c.md" });
    expect(moved.status).toBe(200);
    expect(named(moved).sort()).toEqual(["written/a.md", "written/c.md"]);

    const deleted = await post("/api/space/delete", { path: "written/c.md" });
    expect(deleted.status).toBe(200);
    expect(named(deleted)).toEqual(["written/c.md"]);
  });

  it("names the space's top folder as an empty path", async () => {
    const created = await post("/api/space/create", { parentPath: "", name: "top.md", type: "file" });
    expect(created.status).toBe(200);
    expect(named(created)).toEqual([""]);
  });

  it("names nothing for a save to a file already there, nor for a read", async () => {
    const saved = await fetch(`${testServer.baseUrl}/api/file?path=README.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Saved again\n" }),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.has(WRITTEN_HEADER)).toBe(false);

    const read = await fetch(`${testServer.baseUrl}/api/file?path=README.md`);
    expect(read.headers.has(WRITTEN_HEADER)).toBe(false);
  });
});
