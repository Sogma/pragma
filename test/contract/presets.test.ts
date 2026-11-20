import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SpacePresetsResponse } from "../../src/protocol/api.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// /api/space/presets over real HTTP, against its own copy of the template
// space, which lists `presets/templates/` for templates.
describe("API contract — presets", () => {
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

  const presetsFile = () => readFile(path.join(testServer.spaceRoot, "_presets.json"), "utf8");

  async function presets(): Promise<SpacePresetsResponse> {
    return (await (await fetch(`${testServer.baseUrl}/api/space/presets`)).json()) as SpacePresetsResponse;
  }

  function change(body: Record<string, string>): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const post = (url: string, body: Record<string, unknown>) =>
    fetch(`${testServer.baseUrl}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists the template space's templates folder with its templates", async () => {
    const [templates] = (await presets()).folders;
    expect(templates).toMatchObject({ kind: "templates", written: "presets/templates/", path: "presets/templates" });
    expect(templates.templates?.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
      "folder presets/templates/Project",
      "file presets/templates/Daily Note.md",
    ]);
  });

  it("lists a folder of LUTs, its folders holding any as groups, one line a folder in the file", async () => {
    await place("looks/warm.cube", "LUT_3D_SIZE 2\n");
    await place("looks/Kodak/2383.cube", "LUT_3D_SIZE 2\n");
    await place("looks/Kodak/notes.md", "Quokka grading notes\n");
    const res = await change({ add: "luts", folder: "looks" });
    expect(res.status).toBe(200);
    const luts = ((await res.json()) as SpacePresetsResponse).folders.find((folder) => folder.kind === "luts");
    expect(luts).toMatchObject({ written: "looks/", path: "looks" });
    expect(luts?.luts).toEqual([
      {
        kind: "group",
        name: "Kodak",
        path: "looks/Kodak",
        entries: [{ kind: "lut", name: "2383.cube", path: "looks/Kodak/2383.cube" }],
      },
      { kind: "lut", name: "warm.cube", path: "looks/warm.cube" },
    ]);
    expect(await presetsFile()).toBe(
      '{\n  "templates": [\n    "presets/templates/"\n  ],\n  "luts": [\n    "looks/"\n  ]\n}\n',
    );
  });

  // Nothing in a listed folder is the space's content, whatever its kind.
  it("leaves a listed folder's files out of a search, unless it is narrowed to them", async () => {
    const search = async (query: string) =>
      (
        (await (await fetch(`${testServer.baseUrl}/api/space/search?${query}`)).json()) as { files: { path: string }[] }
      ).files.map((file) => file.path);
    expect(await search("q=quokka")).toEqual([]);
    expect(await search("q=quokka&dir=looks")).toEqual(["looks/Kodak/notes.md"]);
  });

  it("refuses a folder inside one listed, across another kind's, missing, or none at all", async () => {
    await mkdir(path.join(testServer.spaceRoot, "presets/templates/luts"), { recursive: true });
    const inside = await change({ add: "luts", folder: "looks/Kodak" });
    expect(inside.status).toBe(409);
    expect(await inside.text()).toBe("looks/ already lists these LUTs");
    const across = await change({ add: "luts", folder: "presets/templates/luts" });
    expect(across.status).toBe(409);
    expect(await across.text()).toBe("presets/templates/ is already listed for templates");
    expect((await change({ add: "luts", folder: "nowhere" })).status).toBe(404);
    expect((await change({ add: "luts", folder: "" })).status).toBe(409);
    expect((await change({ add: "styles", folder: "looks" })).status).toBe(400);
  });

  it("shows a folder that's gone, and a library this computer hasn't located, as missing", async () => {
    await writeFile(
      path.join(testServer.spaceRoot, "_presets.json"),
      JSON.stringify({ templates: ["presets/templates/"], luts: ["looks/", "gone/", "lib:film/"] }),
    );
    const luts = (await presets()).folders.filter((folder) => folder.kind === "luts");
    expect(luts.map(({ written, missing }) => `${written} ${missing ?? "found"}`)).toEqual([
      "looks/ found",
      "gone/ folder",
      "lib:film/ library",
    ]);
    expect(luts[2].library).toEqual({ id: "film", label: "film" });
  });

  it("takes a folder out, keeping the rest", async () => {
    const res = await change({ remove: "luts", folder: "gone/" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await presetsFile())).toEqual({
      templates: ["presets/templates/"],
      luts: ["looks/", "lib:film/"],
    });
  });

  it("follows a listed folder that moves, and lets one deleted go", async () => {
    await mkdir(path.join(testServer.spaceRoot, "kit"), { recursive: true });
    expect((await post("/api/space/move", { from: "looks", to: "kit/looks" })).status).toBe(200);
    expect(JSON.parse(await presetsFile()).luts).toEqual(["kit/looks/", "lib:film/"]);

    expect((await post("/api/space/delete", { path: "kit", trash: true })).status).toBe(200);
    expect(JSON.parse(await presetsFile()).luts).toEqual(["lib:film/"]);
  });

  it("removes the file once it lists no folder and holds nothing else", async () => {
    await change({ remove: "luts", folder: "lib:film/" });
    await change({ remove: "templates", folder: "presets/templates/" });
    expect(existsSync(path.join(testServer.spaceRoot, "_presets.json"))).toBe(false);
    expect((await presets()).folders).toEqual([]);
  });

  it("says why a file that won't read lists nothing, and refuses a change until it's fixed", async () => {
    await writeFile(path.join(testServer.spaceRoot, "_presets.json"), "{ not json");
    const answer = await presets();
    expect(answer.folders).toEqual([]);
    expect(answer.problem).toMatch(/^_presets\.json doesn't parse/);
    expect((await change({ add: "luts", folder: "presets" })).status).toBe(409);
  });
});
