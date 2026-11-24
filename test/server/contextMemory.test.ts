import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { forgottenContexts, movedContexts, readContext } from "../../src/server/contextMemory.ts";
import { readContextViews } from "../../src/server/layout.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { isolateConfig, tempDir, tempSpace } from "../support/isolation.ts";

beforeEach(() => {
  isolateConfig();
});

// A space with two projects, each a context, and a Table in one.
function space(): string {
  const root = tempSpace("pragma-contexts-");
  for (const folder of ["a/shots", "b"]) mkdirSync(path.join(root, folder), { recursive: true });
  for (const project of ["a", "b"]) writeFileSync(path.join(root, project, "AGENTS.md"), "---\npragma:\n---\n");
  writeFileSync(path.join(root, "a", "list.table.html"), "");
  return root;
}

// Declares the library `id` and locates it here, read-only, with a folder.
function locate(root: string, id: string): void {
  const folder = tempDir(`pragma-contexts-${id}-`);
  mkdirSync(path.join(folder, "day1"));
  writeFileSync(path.join(root, "_libraries.json"), JSON.stringify({ libraries: [{ id, label: id }] }));
  const config = loadGlobalConfig();
  const spaceId = findSpaceId(config, root);
  const entry = spaceId === undefined ? undefined : config.spaces?.[spaceId];
  if (spaceId === undefined || !entry) throw new Error(`${root} is not registered`);
  saveGlobalConfig({
    ...config,
    spaces: { ...config.spaces, [spaceId]: { ...entry, libraries: { [id]: { path: folder, access: "read-only" } } } },
  });
}

describe("a context", () => {
  it("is the space or a folder of it that is there, never a file or a path out", async () => {
    const root = space();
    expect(await readContext(root, "")).toBe("");
    expect(await readContext(root, "a")).toBe("a");
    expect(await readContext(root, "a/shots")).toBe("a/shots");
    for (const value of ["gone", "a/list.table.html", "../elsewhere", 7, undefined]) {
      expect(await readContext(root, value), String(value)).toBeUndefined();
    }
  });

  // A library is one scope, as the space is at its top.
  it("is a located library's top, never a folder of it, nor a library not located here", async () => {
    const root = space();
    expect(await readContext(root, "lib:footage")).toBeUndefined();
    locate(root, "footage");
    expect(await readContext(root, "lib:footage")).toBe("lib:footage");
    expect(await readContext(root, "lib:footage/day1")).toBeUndefined();
    expect(await readContext(root, "lib:elsewhere")).toBeUndefined();
  });
});

describe("what a context keeps, after a move or a delete", () => {
  const views = { a: { guides: { frames: ["16:9"] } }, "a/shots": { look: { lut: "panchromatic" } }, "": {} };

  it("follows its folder, and only that, its value as it was", () => {
    expect(movedContexts(views, "a", "projects/a")).toEqual({
      "projects/a": views.a,
      "projects/a/shots": views["a/shots"],
      "": {},
    });
    expect(movedContexts(views, "a/shot", "a/takes")).toBeUndefined();
  });

  it("goes with its folder, the others kept", () => {
    expect(forgottenContexts(views, "a/shots")).toEqual({ a: views.a, "": {} });
    expect(forgottenContexts(views, "a")).toEqual({ "": {} });
    expect(forgottenContexts(views, "c")).toBeUndefined();
  });
});

describe("the context view route", () => {
  const routes = (root: string) => spaceRoutes(createServedSpace(root), { ownMachine: true })();
  const read = async (root: string, context: string) =>
    (await routes(root).request(`/api/space/context-view?context=${encodeURIComponent(context)}`)).json();
  const post = (root: string, route: string, body: unknown) =>
    routes(root).request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const guides = { shown: true, frames: ["2.39"], protection: 0.07 };
  const look = { lut: "panchromatic", on: true };

  it("answers none for a context never picked for, and keeps each pick apart", async () => {
    const root = space();
    expect(await read(root, "a")).toEqual({ guides: null, look: null });
    expect((await post(root, "/api/space/context-view", { context: "a", guides })).status).toBe(204);
    expect((await post(root, "/api/space/context-view", { context: "a", look })).status).toBe(204);
    expect(await read(root, "a")).toEqual({ guides, look });
    // Another context, the space's own among them, keeps none.
    expect(await read(root, "b")).toEqual({ guides: null, look: null });
    expect(await read(root, "")).toEqual({ guides: null, look: null });
    expect(await readContextViews(root)).toEqual({ a: { guides, look } });
  });

  it("keeps a located library's picks apart from the space's", async () => {
    const root = space();
    locate(root, "footage");
    expect((await post(root, "/api/space/context-view", { context: "lib:footage", look })).status).toBe(204);
    expect(await read(root, "lib:footage")).toEqual({ guides: null, look });
    expect(await read(root, "")).toEqual({ guides: null, look: null });
  });

  it("refuses a context that is no folder of the space, and guides or a look that are no small object", async () => {
    const root = space();
    for (const context of ["gone", "a/list.table.html", "lib:footage", undefined]) {
      expect((await post(root, "/api/space/context-view", { context, guides })).status, String(context)).toBe(400);
    }
    for (const value of ["2.39", [1], null, { note: "x".repeat(5000) }]) {
      expect((await post(root, "/api/space/context-view", { context: "a", guides: value })).status).toBe(400);
      expect((await post(root, "/api/space/context-view", { context: "a", look: value })).status).toBe(400);
    }
    expect((await routes(root).request("/api/space/context-view")).status).toBe(400);
    // A context deleted since reads as none.
    expect(await read(root, "gone")).toEqual({ guides: null, look: null });
    expect(await readContextViews(root)).toEqual({});
  });

  it("keeps a context's picks through a rename of its folder, and forgets them with a delete", async () => {
    const root = space();
    await post(root, "/api/space/context-view", { context: "a", guides });
    expect((await post(root, "/api/space/move", { from: "a", to: "film" })).status).toBe(200);
    expect(await read(root, "film")).toEqual({ guides, look: null });
    expect((await post(root, "/api/space/delete", { path: "film" })).status).toBe(200);
    expect(await readContextViews(root)).toEqual({});
  });
});
