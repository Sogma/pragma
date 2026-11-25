import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { readWrittenPaths, WRITTEN_HEADER } from "../../src/protocol/api.ts";
import { nameWrites, recordWrite } from "../../src/server/writtenPaths.ts";
import { tempDir } from "../support/isolation.ts";

// A response names what its request changed in a listing: an entry made, one
// gone, a folder written into; never a file only saved again, nor anything
// for a request that failed.
let root: string;

beforeEach(() => {
  root = tempDir("pragma-written-");
  mkdirSync(path.join(root, "notes"));
  writeFileSync(path.join(root, "notes", "a.md"), "a");
});

function app(handle: () => void, status = 200) {
  const routes = new Hono();
  routes.use(nameWrites);
  routes.post("/write", (c) => {
    handle();
    return c.json({}, status as 200);
  });
  return routes;
}

const written = async (routes: Hono) => {
  const response = await routes.request("/write", { method: "POST" });
  return readWrittenPaths(response.headers.get(WRITTEN_HEADER));
};

describe("nameWrites", () => {
  it("names an entry made, one removed and a folder written into", async () => {
    const made = app(() => {
      recordWrite("notes/b.md", path.join(root, "notes", "b.md"));
      writeFileSync(path.join(root, "notes", "b.md"), "b");
    });
    expect(await written(made)).toEqual(["notes/b.md"]);

    const removed = app(() => {
      recordWrite("notes/a.md", path.join(root, "notes", "a.md"));
      rmSync(path.join(root, "notes", "a.md"));
    });
    expect(await written(removed)).toEqual(["notes/a.md"]);

    const into = app(() => recordWrite("lib:refs/Tests", path.join(root, "notes")));
    expect(await written(into)).toEqual(["lib:refs/Tests"]);
  });

  it("names nothing for a file only saved again, nor for a request that failed", async () => {
    const saved = app(() => {
      recordWrite("notes/a.md", path.join(root, "notes", "a.md"));
      writeFileSync(path.join(root, "notes", "a.md"), "a, again");
    });
    expect(await written(saved)).toEqual([]);

    const failed = app(() => {
      recordWrite("notes/c.md", path.join(root, "notes", "c.md"));
      writeFileSync(path.join(root, "notes", "c.md"), "c");
    }, 500);
    expect(await written(failed)).toEqual([]);
  });

  it("encodes a name a header couldn't carry, and reads it back whole", async () => {
    const odd = "notes/été, 2.md";
    const made = app(() => {
      recordWrite(odd, path.join(root, "notes", "été, 2.md"));
      writeFileSync(path.join(root, "notes", "été, 2.md"), "x");
    });
    expect(await written(made)).toEqual([odd]);
  });

  it("records nothing outside a request", () => {
    expect(() => recordWrite("notes/d.md", path.join(root, "notes", "d.md"))).not.toThrow();
  });
});
