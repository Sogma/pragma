import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import {
  forgottenFrameFolders,
  frameFolderFor,
  movedFrameFolders,
  rememberFrameFolder,
} from "../../src/server/frameFolders.ts";
import { readFrameFolders } from "../../src/server/layout.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { isolateConfig, tempDir, tempSpace } from "../support/isolation.ts";

beforeEach(() => {
  isolateConfig();
});

// A space with two projects, each a context, and a clip outside both.
function space(): string {
  const root = tempSpace("pragma-frames-");
  for (const folder of ["a/shots", "a/stills", "b/shots", "b/stills", "loose"]) {
    mkdirSync(path.join(root, folder), { recursive: true });
  }
  for (const project of ["a", "b"]) writeFileSync(path.join(root, project, "AGENTS.md"), "---\npragma:\n---\n");
  for (const clip of ["a/shots/one.mp4", "a/shots/two.mp4", "b/shots/three.mp4", "loose/four.mp4"]) {
    writeFileSync(path.join(root, clip), "clip");
  }
  return root;
}

// Declares the library `id` and locates it here with `access`.
function locate(root: string, id: string, access: "read-only" | "read-write"): string {
  const folder = tempDir(`pragma-frames-${id}-`);
  writeFileSync(path.join(root, "_libraries.json"), JSON.stringify({ libraries: [{ id, label: id }] }));
  const config = loadGlobalConfig();
  const spaceId = findSpaceId(config, root);
  if (spaceId === undefined) throw new Error(`${root} is not registered`);
  const entry = config.spaces?.[spaceId];
  if (!entry) throw new Error(`${root} has no entry`);
  saveGlobalConfig({
    ...config,
    spaces: { ...config.spaces, [spaceId]: { ...entry, libraries: { [id]: { path: folder, access } } } },
  });
  return folder;
}

describe("the folder a frame saves to by default", () => {
  it("is beside the clip until a folder is picked for its context", async () => {
    const root = space();
    expect(await frameFolderFor(root, "a/shots/one.mp4", "a")).toBe("a/shots");
    expect(await frameFolderFor(root, "loose/four.mp4", "")).toBe("loose");
  });

  it("is the folder picked last for any clip seen in the same context, and only there", async () => {
    const root = space();
    await rememberFrameFolder(root, "a", "a/stills");
    expect(await frameFolderFor(root, "a/shots/two.mp4", "a")).toBe("a/stills");
    // Another project keeps its own, and the space its.
    expect(await frameFolderFor(root, "b/shots/three.mp4", "b")).toBe("b/shots");
    expect(await frameFolderFor(root, "loose/four.mp4", "")).toBe("loose");

    await rememberFrameFolder(root, "", "b/stills");
    expect(await frameFolderFor(root, "loose/four.mp4", "")).toBe("b/stills");
    expect(await frameFolderFor(root, "a/shots/one.mp4", "a")).toBe("a/stills");
    expect(await readFrameFolders(root)).toEqual({ a: "a/stills", "": "b/stills" });
  });

  // The context is where the clip is seen, not where it lives: another
  // project's clip in this project's Table saves where this project's go.
  it("follows the context a clip is seen in, wherever the clip lives", async () => {
    const root = space();
    await rememberFrameFolder(root, "a", "a/stills");
    expect(await frameFolderFor(root, "b/shots/three.mp4", "a")).toBe("a/stills");
    // A context naming no folder remembers nothing.
    expect(await frameFolderFor(root, "b/shots/three.mp4", undefined)).toBe("b/shots");
  });

  it("passes over a remembered folder that is gone", async () => {
    const root = space();
    await rememberFrameFolder(root, "a", "a/stills");
    await rm(path.join(root, "a", "stills"), { recursive: true });
    expect(await frameFolderFor(root, "a/shots/one.mp4", "a")).toBe("a/shots");
  });

  it("is the space's top folder for a clip in a read-only library, until one is picked", async () => {
    const root = space();
    const footage = locate(root, "footage", "read-only");
    writeFileSync(path.join(footage, "take.mp4"), "clip");
    expect(await frameFolderFor(root, "lib:footage/take.mp4", "lib:footage")).toBe("");

    // Seen in its own tab, the clip is in its library's context.
    await rememberFrameFolder(root, "lib:footage", "a/stills");
    expect(await frameFolderFor(root, "lib:footage/take.mp4", "lib:footage")).toBe("a/stills");
    expect(await readFrameFolders(root)).toEqual({ "lib:footage": "a/stills" });
  });

  it("is beside a clip in a library Pragma may write to", async () => {
    const root = space();
    const renders = locate(root, "renders", "read-write");
    mkdirSync(path.join(renders, "day1"));
    writeFileSync(path.join(renders, "day1", "take.mp4"), "clip");
    expect(await frameFolderFor(root, "lib:renders/day1/take.mp4", "lib:renders")).toBe("lib:renders/day1");
  });
});

describe("a remembered folder after a move or a delete", () => {
  it("follows its folder and its context's, and nothing else", () => {
    const folders = { a: "a/stills", "": "b/stills", "lib:footage": "a/stills/picks" };
    expect(movedFrameFolders(folders, "a/stills", "a/frames")).toEqual({
      a: "a/frames",
      "": "b/stills",
      "lib:footage": "a/frames/picks",
    });
    expect(movedFrameFolders(folders, "a", "projects/a")).toEqual({
      "projects/a": "projects/a/stills",
      "": "b/stills",
      "lib:footage": "projects/a/stills/picks",
    });
    expect(movedFrameFolders(folders, "a/still", "a/frames")).toBeUndefined();
  });

  it("goes with its folder or its context's, the others kept", () => {
    const folders = { a: "a/stills", "": "b/stills", "lib:footage": "a/stills/picks" };
    expect(forgottenFrameFolders(folders, "a/stills")).toEqual({ "": "b/stills" });
    expect(forgottenFrameFolders(folders, "b")).toEqual({ a: "a/stills", "lib:footage": "a/stills/picks" });
    expect(forgottenFrameFolders(folders, "c")).toBeUndefined();
  });
});

describe("the frame folder route", () => {
  const routes = (root: string) => spaceRoutes(createServedSpace(root), { ownMachine: true })();
  const read = async (root: string, clip: string, context: string) => {
    const query = `clip=${encodeURIComponent(clip)}&context=${encodeURIComponent(context)}`;
    const response = await routes(root).request(`/api/space/frame-folder?${query}`);
    return (await response.json()).folder;
  };
  const post = (root: string, route: string, body: unknown) =>
    routes(root).request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers the default, and remembers a folder for the context", async () => {
    const root = space();
    expect(await read(root, "a/shots/one.mp4", "a")).toBe("a/shots");
    const saved = await post(root, "/api/space/frame-folder", { context: "a", folder: "a/stills" });
    expect(saved.status).toBe(204);
    expect(await read(root, "a/shots/two.mp4", "a")).toBe("a/stills");
    // A context deleted since answers as one with nothing remembered.
    expect(await read(root, "a/shots/two.mp4", "gone")).toBe("a/shots");
  });

  it("refuses a folder Pragma can't write to, and a missing or unknown context or folder", async () => {
    const root = space();
    locate(root, "footage", "read-only");
    const refused = await post(root, "/api/space/frame-folder", { context: "a", folder: "lib:footage" });
    expect(refused.status).toBe(403);
    expect((await post(root, "/api/space/frame-folder", { folder: "a/stills" })).status).toBe(400);
    expect((await post(root, "/api/space/frame-folder", { context: "a" })).status).toBe(400);
    // A context is the space, a folder of it or a library's top, never a file
    // or a library's folder.
    for (const context of ["gone", "a/AGENTS.md", "lib:footage/day1", "lib:elsewhere"]) {
      expect((await post(root, "/api/space/frame-folder", { context, folder: "a/stills" })).status).toBe(400);
    }
    expect((await routes(root).request("/api/space/frame-folder")).status).toBe(400);
    expect(await readFrameFolders(root)).toEqual({});
  });

  it("keeps a remembered folder through a rename, and forgets it with a delete", async () => {
    const root = space();
    await post(root, "/api/space/frame-folder", { context: "a", folder: "a/stills" });
    expect((await post(root, "/api/space/move", { from: "a/stills", to: "a/frames" })).status).toBe(200);
    expect(await read(root, "a/shots/one.mp4", "a")).toBe("a/frames");
    expect((await post(root, "/api/space/delete", { path: "a/frames" })).status).toBe(200);
    expect(await readFrameFolders(root)).toEqual({});
    expect(await read(root, "a/shots/one.mp4", "a")).toBe("a/shots");
  });
});
