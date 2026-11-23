import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { capabilityDigest, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { parseRootedPath } from "../../src/protocol/rootedPath.ts";
import { serializeTableFile } from "../../src/protocol/tableHtml.ts";
import { grantCapability } from "../../src/server/grants.ts";
import { PathAccessError } from "../../src/server/rootedFiles.ts";
import {
  declaresCapability,
  findReadCapability,
  performSandboxAddRow,
  performSandboxAddToNote,
  performSandboxRead,
  performSandboxWrite,
  readSandboxDocument,
  readSandboxTarget,
  SandboxRequestError,
} from "../../src/server/sandbox.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";
import { isoVideo, trackHeader } from "../support/videoFixtures.ts";

const manifestScript = (manifest: object) =>
  `<script type="application/json" data-role="manifest">${JSON.stringify(manifest)}</script>`;

const APPLET = `<!DOCTYPE html><html><head>${manifestScript({ id: "applet_a", version: "1.0" })}</head><body></body></html>`;

const FLOW = `<!DOCTYPE html><html data-format="flow" data-format-version="1.0" data-id="flow_f"><head><script type="application/json" data-role="graph">${JSON.stringify(
  {
    nodes: [
      { id: "n1", type: "loadFolderNote", position: { x: 0, y: 0 }, config: { folderPath: "notes", notePath: "" } },
      { id: "n2", type: "generateText", position: { x: 0, y: 0 }, config: {} },
      { id: "n3", type: "writeNote", position: { x: 0, y: 0 }, config: { notePath: "out.md" } },
    ],
    edges: [],
  },
)}</script></head><body></body></html>`;

const LIBRARY_FLOW = `<!DOCTYPE html><html data-format="flow" data-format-version="1.0" data-id="flow_lib"><head><script type="application/json" data-role="graph">${JSON.stringify(
  {
    nodes: [
      {
        id: "n1",
        type: "loadImage",
        position: { x: 0, y: 0 },
        config: { imagePath: "lib:footage/sunset.png" },
      },
    ],
    edges: [],
  },
)}</script></head><body></body></html>`;

const TABLE = readFileSync(
  path.resolve(import.meta.dirname, "../../templates/space/projects/getting-started/writing-prompts.table.html"),
  "utf8",
);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A 1920x1080 clip, five seconds long at 25 frames a second.
const CLIP = isoVideo({ tkhd: trackHeader(1920, 1080), movie: [600, 3000] });
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let space: string;
let library: string;
let configDir: string;

beforeEach(() => {
  space = tempDir("pragma-sandbox-");
  library = tempDir("pragma-sandbox-library-");
  // A library's folder sits in the config, so this points PRAGMA_CONFIG_DIR
  // at a throwaway directory rather than reading the developer's own.
  configDir = isolateConfig();
  giveSpaceLibraries(configDir, space, [{ id: "footage", label: "Footage", path: library, access: "read-only" }]);
  writeFileSync(path.join(library, "sunset.png"), PNG);
  writeFileSync(path.join(library, "notes.md"), "# In the library\n");
  writeFileSync(path.join(space, "lib.flow.html"), LIBRARY_FLOW);
  writeFileSync(path.join(space, "a.applet.html"), APPLET);
  writeFileSync(path.join(space, "f.flow.html"), FLOW);
  writeFileSync(path.join(space, "t.table.html"), TABLE);
  writeFileSync(path.join(space, "p.png"), PNG);
  mkdirSync(path.join(space, "notes"));
  writeFileSync(path.join(space, "notes", "a.md"), "# A\n");
});

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SandboxRequestError ? error.status : undefined;
  }
}

describe("sandbox documents", () => {
  // A flow's capabilities come from its graph, and so does the hash its
  // grants pin to — the capability digest, not the raw file.
  it("resolves a flow to its grant subject and declared keys", async () => {
    const flow = await readSandboxDocument(space, "flow", "f.flow.html");
    expect(flow.subject).toEqual({
      path: "f.flow.html",
      contentHash: capabilityDigest((await readFlowFile(path.join(space, "f.flow.html"))).graph),
    });
    expect(flow.capabilities.map((c) => c.key).sort()).toEqual([
      "generateText",
      "readFile:space:notes",
      "writeDocument:space:out.md",
    ]);
    expect(flow.label).toBe("This flow");
  });

  // An Applet declares nothing, so no request is ever made for one.
  it("refuses an unknown kind, an Applet, a missing path, and a kind the path doesn't match", async () => {
    expect(await statusOf(readSandboxDocument(space, "widget", "f.flow.html"))).toBe(400);
    expect(await statusOf(readSandboxDocument(space, "applet", "a.applet.html"))).toBe(400);
    expect(await statusOf(readSandboxDocument(space, "flow", undefined))).toBe(400);
    expect(await statusOf(readSandboxDocument(space, "flow", "a.applet.html"))).toBe(400);
  });

  it("a read matches the exact declared path, or a declared folder's direct children", async () => {
    const flow = await readSandboxDocument(space, "flow", "f.flow.html");
    const find = (target: string) => findReadCapability(flow, parseRootedPath(target));
    expect(find("notes/b.md")?.key).toBe("readFile:space:notes");
    expect(find("notes/deep/c.md")).toBeUndefined(); // flat containment only
    expect(find("out.md")).toBeUndefined(); // a writeDocument is not a read
  });

  it("a read comes back parsed by the target's kind", async () => {
    const table = await readSandboxTarget(space, "t.table.html");
    expect(table.kind).toBe("table");
    if (table.kind === "table") expect(table.columns.length).toBeGreaterThan(0);

    const image = await readSandboxTarget(space, "p.png");
    expect(image).toEqual({ kind: "image", mediaType: "image/png", data: PNG.toString("base64") });

    expect(await readSandboxTarget(space, "notes/a.md")).toEqual({ kind: "text", content: "# A\n" });
  });

  // A clip goes on by reference (protocol.md's Ports and types): its bytes
  // are read only by whoever sends them.
  it("reads a clip as its facts and digest, never its bytes", async () => {
    writeFileSync(path.join(space, "clip.mp4"), CLIP);
    expect(await readSandboxTarget(space, "clip.mp4")).toEqual({
      kind: "video",
      mediaType: "video/mp4",
      digest: sha256(CLIP),
      width: 1920,
      height: 1080,
      duration: 5,
      frameRate: 25,
      variableFrameRate: false,
    });
  });

  it("fails a clip whose header can't be read, naming it", async () => {
    writeFileSync(path.join(space, "broken.mp4"), Buffer.from("not a clip at all"));
    await expect(readSandboxTarget(space, "broken.mp4")).rejects.toThrow(/"broken\.mp4": Could not read/);
    expect(await statusOf(readSandboxTarget(space, "broken.mp4"))).toBe(400);
  });

  // A vector image is not a raster image (protocol.md): it reads as the text it is.
  it("reads a vector image as text, and refuses one in a library", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"/>';
    writeFileSync(path.join(space, "logo.svg"), svg);
    writeFileSync(path.join(library, "logo.svg"), svg);
    expect(await readSandboxTarget(space, "logo.svg")).toEqual({ kind: "text", content: svg });
    await expect(readSandboxTarget(space, "lib:footage/logo.svg")).rejects.toThrow(/Only raster images/);
  });

  it("a missing target is a 404 naming the stored path, not the disk's", async () => {
    for (const [target, noun] of [
      ["notes/gone.md", "file"],
      ["gone.png", "file"],
      ["gone.table.html", "table"],
    ]) {
      await expect(readSandboxTarget(space, target)).rejects.toThrow(`No ${noun} at "${target}"`);
      expect(await statusOf(readSandboxTarget(space, target))).toBe(404);
    }
  });

  // Only a file that isn't there fails a read: a blank one is a new document,
  // and one this build can't parse still reads as empty.
  it("a blank or unparseable Table reads as an empty one", async () => {
    writeFileSync(path.join(space, "blank.table.html"), "");
    writeFileSync(path.join(space, "junk.table.html"), "<p>not a table</p>");
    expect(await readSandboxTarget(space, "blank.table.html")).toEqual({ kind: "table", columns: [], rows: [] });
    expect(await readSandboxTarget(space, "junk.table.html")).toEqual({ kind: "table", columns: [], rows: [] });
  });

  // What a Flow reads can go on to a model, through its Generate nodes.
  it("refuses a private Table, as it refuses a private note", async () => {
    const block = '<dl data-role="metadata"><dt>visibility</dt><dd>private</dd></dl>';
    writeFileSync(path.join(space, "secret.table.html"), `<html data-format="table"><body>${block}</body></html>`);
    writeFileSync(path.join(space, "secret.md"), "---\nvisibility: private\n---\nhidden\n");
    for (const target of ["secret.table.html", "secret.md"]) {
      await expect(readSandboxTarget(space, target)).rejects.toThrow(/visibility: private/);
    }
  });

  it("a write needs the target declared and granted, then writes the content as given", async () => {
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    const flow = await readSandboxDocument(space, "flow", "f.flow.html");
    expect(await statusOf(performSandboxWrite(space, flow, "notes/a.md", "x"))).toBe(400);
    expect(await statusOf(performSandboxWrite(space, flow, "out.md", "x"))).toBe(403);

    await grantCapability(space, flow.subject, "writeDocument:space:out.md");
    await performSandboxWrite(space, flow, "out.md", "# Out\n\nWritten.\n");
    expect(readFileSync(path.join(space, "out.md"), "utf8")).toBe("# Out\n\nWritten.\n");
  });
});

describe("reading a library", () => {
  it("derives a readFile key on the library's address from a Load Image node pointing at a library", async () => {
    const flow = await readSandboxDocument(space, "flow", "lib.flow.html");
    expect(flow.capabilities.map((c) => c.key)).toEqual(["readFile:lib:footage/sunset.png"]);
  });

  it("matches that declaration by its address, root included", async () => {
    const flow = await readSandboxDocument(space, "flow", "lib.flow.html");
    const find = (target: string) => findReadCapability(flow, parseRootedPath(target));
    expect(find("lib:footage/sunset.png")?.key).toBe("readFile:lib:footage/sunset.png");
    // The same filename without the prefix is a different file in a
    // different root, and must not ride in on the library's grant.
    expect(find("sunset.png")).toBeUndefined();
  });

  it("reads the image out of the library's own root, not a space folder named after the prefix", async () => {
    expect(await readSandboxTarget(space, "lib:footage/sunset.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
  });

  it("reads a clip out of a library, as Load Video may name one", async () => {
    writeFileSync(path.join(library, "take.mov"), CLIP);
    expect(await readSandboxTarget(space, "lib:footage/take.mov")).toMatchObject({
      kind: "video",
      mediaType: "video/quicktime",
      digest: sha256(CLIP),
    });
  });

  it("refuses a library path that isn't an image, rather than reading it as text", async () => {
    await expect(readSandboxTarget(space, "lib:footage/notes.md")).rejects.toThrow(/Only raster images/);
  });

  it("refuses a library nobody registered, and a path escaping the one that is", async () => {
    await expect(readSandboxTarget(space, "lib:missing/x.png")).rejects.toBeInstanceOf(PathAccessError);
    await expect(readSandboxTarget(space, "lib:footage/../x.png")).rejects.toThrow();
  });
});

describe("adding a row", () => {
  // A Flow in a folder of its own, naming one Table by its address, as a
  // drag does, and one by its bare name beside the Flow, as a hand edit can.
  const ROW_FLOW = serializeFlowFile({
    version: "1.0",
    name: "Rows",
    graph: {
      nodes: [
        { id: "a", type: "addRow", position: { x: 0, y: 0 }, config: { tablePath: "space:renders/log.table.html" } },
        { id: "b", type: "addRow", position: { x: 0, y: 0 }, config: { tablePath: "beside.table.html" } },
      ],
      edges: [],
    },
  });
  const LOG = serializeTableFile({
    version: "1.0",
    name: "Log",
    metadata: [
      { key: "created", values: ["2026-01-01"] },
      { key: "modified", values: ["2026-01-02"] },
    ],
    columns: [
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "image", label: "Image", type: "media" },
      { id: "keep", label: "Keep", type: "checkbox" },
      { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
      { id: "added", label: "Added", type: "timestamp", default: "now" },
      { id: "due", label: "Due", type: "timestamp" },
    ],
    rows: [{ values: { prompt: "first", image: "", keep: "false", status: "Final", added: "", due: "" } }],
  });
  const logPath = () => path.join(space, "renders", "log.table.html");

  beforeEach(async () => {
    mkdirSync(path.join(space, "projects"));
    mkdirSync(path.join(space, "renders"));
    writeFileSync(path.join(space, "projects", "rows.flow.html"), ROW_FLOW);
    writeFileSync(logPath(), LOG);
    writeFileSync(path.join(space, "projects", "beside.table.html"), LOG);
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    const flow = await readSandboxDocument(space, "flow", "projects/rows.flow.html");
    await grantCapability(space, flow.subject, "writeDocument:space:renders/log.table.html");
    await grantCapability(space, flow.subject, "writeDocument:space:projects/beside.table.html");
  });

  const rowFlow = () => readSandboxDocument(space, "flow", "projects/rows.flow.html");
  const lastRow = () =>
    readFileSync(logPath(), "utf8")
      .match(/<tr><td>.*<\/tr>/g)
      ?.at(-1);

  it("needs the Table declared and granted", async () => {
    const flow = await readSandboxDocument(space, "flow", "f.flow.html");
    expect(await statusOf(performSandboxAddRow(space, flow, "space:renders/log.table.html", {}))).toBe(400);
    await grantCapability(space, flow.subject, "writeDocument:space:out.md");
    // Declared, but a note: a row needs a Table.
    expect(await statusOf(performSandboxAddRow(space, flow, "out.md", {}))).toBe(400);

    const fresh = await rowFlow();
    writeFileSync(
      path.join(space, "projects", "rows.flow.html"),
      ROW_FLOW.replace('"tablePath":"beside.table.html"', '"tablePath":"other.table.html"'),
    );
    const changed = await rowFlow();
    expect(changed.subject.contentHash).not.toBe(fresh.subject.contentHash);
    expect(await statusOf(performSandboxAddRow(space, changed, "space:renders/log.table.html", {}))).toBe(403);
  });

  it("fills a column given nothing as a new row: the time added where asked, a select's first option, no tick", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:32:05.250Z"), toFake: ["Date"] });
    try {
      const result = await performSandboxAddRow(space, await rowFlow(), "space:renders/log.table.html", {
        prompt: "a red door",
      });
      expect(result).toEqual({ path: "renders/log.table.html" });
      expect(lastRow()).toBe(
        "<tr><td>a red door</td><td></td><td>false</td><td>Draft</td><td>2026-10-07T12:32:05Z</td><td></td></tr>",
      );
      const written = readFileSync(logPath(), "utf8");
      expect(written).toContain("<dt>created</dt><dd>2026-01-01</dd>");
      expect(written).toContain("<dt>modified</dt><dd>2026-10-07</dd>");
    } finally {
      vi.useRealTimers();
    }
  });

  // A diff of the append is one row wide: everything else is re-serialized
  // byte for byte.
  it("leaves the rest of the Table as it was", async () => {
    await performSandboxAddRow(space, await rowFlow(), "space:renders/log.table.html", { prompt: "second" });
    const before = LOG.split("\n").filter((line) => !line.includes("<dd>2026-01-02</dd>"));
    const after = readFileSync(logPath(), "utf8").split("\n");
    expect(after.filter((line) => !before.includes(line))).toEqual([
      expect.stringContaining("<dt>modified</dt>"),
      expect.stringContaining("<td>second</td>"),
    ]);
  });

  // A Flow names a file from its own folder, a media cell from the Table's.
  it("re-spells a media path from the Table's folder, and a library's as it is", async () => {
    const add = async (image: string) => {
      await performSandboxAddRow(space, await rowFlow(), "space:renders/log.table.html", { image });
      return lastRow()?.split("</td><td>")[1];
    };
    expect(await add("space:renders/red-door-1a2b3c.png")).toBe("red-door-1a2b3c.png");
    expect(await add("../renders/red-door-1a2b3c.png")).toBe("red-door-1a2b3c.png");
    expect(await add("door.png")).toBe("../projects/door.png");
    expect(await add("lib:footage/sunset.png")).toBe("lib:footage/sunset.png");
    expect(await add("")).toBe("");
    expect(
      await statusOf(
        performSandboxAddRow(space, await rowFlow(), "space:renders/log.table.html", { image: "x:y/z.png" }),
      ),
    ).toBe(400);
  });

  it("writes a path cell from the Table's folder by the scope rule, a folder keeping its slash", async () => {
    const refs = path.join(space, "renders", "refs.table.html");
    writeFileSync(
      refs,
      serializeTableFile({ version: "1.0", columns: [{ id: "ref", label: "Ref", type: "path" }], rows: [] }),
    );
    writeFileSync(
      path.join(space, "projects", "refs.flow.html"),
      serializeFlowFile({
        version: "1.0",
        name: "Refs",
        graph: {
          nodes: [
            {
              id: "a",
              type: "addRow",
              position: { x: 0, y: 0 },
              config: { tablePath: "../renders/refs.table.html" },
            },
          ],
          edges: [],
        },
      }),
    );
    const flow = await readSandboxDocument(space, "flow", "projects/refs.flow.html");
    await grantCapability(space, flow.subject, "writeDocument:space:renders/refs.table.html");
    const add = async (ref: string) => {
      await performSandboxAddRow(space, flow, "../renders/refs.table.html", { ref });
      return readFileSync(refs, "utf8")
        .match(/<tr><td>(.*)<\/td><\/tr>/g)
        ?.at(-1);
    };

    expect(await add("notes/")).toBe("<tr><td>../projects/notes/</td></tr>");
    // A scope over the Table's folder, which the path leaves: from the root.
    writeFileSync(path.join(space, "renders", "AGENTS.md"), "---\npragma: {}\n---\n");
    expect(await add("notes/a.md")).toBe("<tr><td>/projects/notes/a.md</td></tr>");
  });

  it("finds a bare Table name beside the Flow, and answers with its path from the space root", async () => {
    const result = await performSandboxAddRow(space, await rowFlow(), "beside.table.html", { prompt: "beside" });
    expect(result).toEqual({ path: "projects/beside.table.html" });
    expect(readFileSync(path.join(space, "projects", "beside.table.html"), "utf8")).toContain("<td>beside</td>");
  });

  it("refuses, writing nothing, a column the Table lacks or a Table it can't fully read", async () => {
    const flow = await rowFlow();
    expect(await statusOf(performSandboxAddRow(space, flow, "space:renders/log.table.html", { gone: "x" }))).toBe(400);
    expect(readFileSync(logPath(), "utf8")).toBe(LOG);

    const newer = LOG.replace('data-format-version="1.0"', 'data-format-version="2.0"');
    writeFileSync(logPath(), newer);
    expect(await statusOf(performSandboxAddRow(space, flow, "space:renders/log.table.html", {}))).toBe(400);
    expect(readFileSync(logPath(), "utf8")).toBe(newer);

    writeFileSync(logPath(), "<p>not a table</p>");
    expect(await statusOf(performSandboxAddRow(space, flow, "space:renders/log.table.html", {}))).toBe(400);
    rmSync(logPath());
    expect(await statusOf(performSandboxAddRow(space, flow, "space:renders/log.table.html", {}))).toBe(400);
  });

  it("names a gone Table by its path from the space root, as a loader's read does", async () => {
    rmSync(path.join(space, "projects", "beside.table.html"));
    await expect(performSandboxAddRow(space, await rowFlow(), "beside.table.html", {})).rejects.toThrow(
      'No table at "projects/beside.table.html"',
    );
  });
});

describe("adding to a note", () => {
  // One note named by its address, as a drag does, and a Table the same Flow
  // may write, to show a granted write is still no way to add text to one.
  const NOTE_FLOW = serializeFlowFile({
    version: "1.0",
    name: "Log",
    graph: {
      nodes: [
        { id: "a", type: "addToNote", position: { x: 0, y: 0 }, config: { notePath: "space:logs/run.md" } },
        { id: "b", type: "addRow", position: { x: 0, y: 0 }, config: { tablePath: "space:t.table.html" } },
      ],
      edges: [],
    },
  });
  const notePath = () => path.join(space, "logs", "run.md");
  const noteFlow = () => readSandboxDocument(space, "flow", "projects/log.flow.html");

  beforeEach(async () => {
    mkdirSync(path.join(space, "projects"));
    mkdirSync(path.join(space, "logs"));
    writeFileSync(path.join(space, "projects", "log.flow.html"), NOTE_FLOW);
    writeFileSync(notePath(), "---\ntags: [log]\n---\n\n# Run log\n\n- first\n");
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    const flow = await noteFlow();
    await grantCapability(space, flow.subject, "writeDocument:space:logs/run.md");
    await grantCapability(space, flow.subject, "writeDocument:space:t.table.html");
  });

  it("needs the note declared and granted, and a note rather than any granted file", async () => {
    const other = await readSandboxDocument(space, "flow", "f.flow.html");
    expect(await statusOf(performSandboxAddToNote(space, other, "space:logs/run.md", "x", "append"))).toBe(400);
    expect(await statusOf(performSandboxAddToNote(space, other, "out.md", "x", "append"))).toBe(403);
    expect(await statusOf(performSandboxAddToNote(space, await noteFlow(), "space:t.table.html", "x", "append"))).toBe(
      400,
    );
    expect(readFileSync(path.join(space, "t.table.html"), "utf8")).toBe(TABLE);
  });

  it("appends at the end and prepends where the body starts, keeping every byte it held", async () => {
    const flow = await noteFlow();
    await performSandboxAddToNote(space, flow, "space:logs/run.md", "- last", "append");
    await performSandboxAddToNote(space, flow, "space:logs/run.md", "- zeroth", "prepend");
    expect(readFileSync(notePath(), "utf8")).toBe("---\ntags: [log]\n---\n\n# Run log\n\n- zeroth\n- first\n- last\n");
  });

  it("refuses a gone note by its path from the space root, rather than writing a new one", async () => {
    rmSync(notePath());
    await expect(performSandboxAddToNote(space, await noteFlow(), "space:logs/run.md", "x", "append")).rejects.toThrow(
      'No file at "logs/run.md"',
    );
    expect(() => readFileSync(notePath(), "utf8")).toThrow();
  });

  it("writes nothing for an empty text", async () => {
    await performSandboxAddToNote(space, await noteFlow(), "space:logs/run.md", "", "append");
    expect(readFileSync(notePath(), "utf8")).toBe("---\ntags: [log]\n---\n\n# Run log\n\n- first\n");
  });

  it("owes a site's note the queue entry and updated stamp a granted write does", async () => {
    writeFileSync(path.join(space, "logs", "_site.json"), JSON.stringify({ id: "ste_log", slug: "log", name: "L" }));
    await performSandboxAddToNote(space, await noteFlow(), "space:logs/run.md", "- second", "append");
    expect(JSON.parse(readFileSync(path.join(space, "logs", "_queue.json"), "utf8"))).toEqual([
      { op: "publish", path: "logs/run.md" },
    ]);
    const note = readFileSync(notePath(), "utf8");
    expect(note).toMatch(/^updated: /m);
    expect(note).toMatch(/- first\n- second\n$/);
  });
});

// A Flow in a folder reads a bare name as the file beside it, so an entry at
// the space root is named with space: — the case a bare name can't express.
describe("a Flow in a folder naming the space root", () => {
  const NESTED = "projects/a/nested.flow.html";

  beforeEach(async () => {
    mkdirSync(path.join(space, "projects", "a"), { recursive: true });
    mkdirSync(path.join(space, "refs"));
    writeFileSync(path.join(space, "refs", "a.md"), "# Ref\n");
    writeFileSync(path.join(space, "notes.md"), "# Root note\n");
    writeFileSync(
      path.join(space, NESTED),
      serializeFlowFile({
        version: "1.0",
        name: "Nested",
        graph: {
          nodes: [
            { id: "load", type: "loadRow", position: { x: 0, y: 0 }, config: { tablePath: "space:t.table.html" } },
            { id: "write", type: "writeNote", position: { x: 0, y: 0 }, config: { notePath: "space:notes.md" } },
            { id: "add", type: "addRow", position: { x: 0, y: 0 }, config: { tablePath: "space:t.table.html" } },
            {
              id: "folder",
              type: "loadFolderNote",
              position: { x: 0, y: 0 },
              config: { folderPath: "space:refs", notePath: "space:refs/a.md" },
            },
          ],
          edges: [],
        },
      }),
    );
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    const flow = await readSandboxDocument(space, "flow", NESTED);
    for (const key of [
      "readFile:space:t.table.html",
      "writeDocument:space:notes.md",
      "writeDocument:space:t.table.html",
      "readFile:space:refs",
    ]) {
      await grantCapability(space, flow.subject, key);
    }
  });

  it("reads, writes and adds to the root's files, not ones beside the Flow", async () => {
    const flow = await readSandboxDocument(space, "flow", NESTED);
    const table = await performSandboxRead(space, flow, "space:t.table.html");
    expect(table.kind === "table" && table.columns.length).toBeGreaterThan(0);

    await performSandboxWrite(space, flow, "space:notes.md", "# Written\n");
    expect(readFileSync(path.join(space, "notes.md"), "utf8")).toBe("# Written\n");
    expect(() => readFileSync(path.join(space, "projects", "a", "notes.md"))).toThrow();

    const columnId = table.kind === "table" ? table.columns[0].id : "";
    const added = await performSandboxAddRow(space, flow, "space:t.table.html", { [columnId]: "from a folder" });
    expect(added).toEqual({ path: "t.table.html" });
    expect(readFileSync(path.join(space, "t.table.html"), "utf8")).toContain("<td>from a folder</td>");
  });

  // A folder's grant matches a child by comparing addresses.
  it("covers a folder's own children, however the read spells the path", async () => {
    const flow = await readSandboxDocument(space, "flow", NESTED);
    for (const target of ["space:refs/a.md", "/refs/a.md", "../../refs/a.md"]) {
      expect(await performSandboxRead(space, flow, target), target).toEqual({ kind: "text", content: "# Ref\n" });
    }
    // Beside the Flow: another folder, which nothing declares.
    expect(await statusOf(performSandboxRead(space, flow, "refs/a.md"))).toBe(400);
  });
});

// A path a wire chose is no declaration: the graph only says a pin may bring
// one. Each file it names is its own key, granted by a person or not at all.
describe("a path a wire chose", () => {
  const WIRED = "projects/wired.flow.html";
  const wiredFlow = (edges: { target: string; targetPort: string }[]) =>
    serializeFlowFile({
      version: "1.0",
      name: "Wired",
      graph: {
        nodes: [
          { id: "src", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" } },
          { id: "load", type: "loadNote", position: { x: 0, y: 0 }, config: {} },
          { id: "write", type: "writeNote", position: { x: 0, y: 0 }, config: {} },
          {
            id: "row",
            type: "addRow",
            position: { x: 0, y: 0 },
            config: { columns: [{ id: "note", type: "text", label: "Note" }] },
          },
        ],
        edges: edges.map((edge, i) => ({ id: `e${i}`, source: "src", sourcePort: "text", ...edge })),
      },
    });
  const doc = () => readSandboxDocument(space, "flow", WIRED);

  beforeEach(() => {
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    mkdirSync(path.join(space, "projects"), { recursive: true });
    writeFileSync(path.join(space, "t2.table.html"), TABLE);
  });

  it("is allowed only through a pin with a wire into it", async () => {
    writeFileSync(path.join(space, WIRED), wiredFlow([]));
    const unwired = await doc();
    expect([...unwired.wired]).toEqual([]);
    expect(declaresCapability(unwired, "readFile:space:notes/a.md")).toBe(false);
    expect(await statusOf(performSandboxRead(space, unwired, "space:notes/a.md"))).toBe(400);

    writeFileSync(path.join(space, WIRED), wiredFlow([{ target: "load", targetPort: "path" }]));
    const wired = await doc();
    expect([...wired.wired]).toEqual(["read"]);
    expect(declaresCapability(wired, "readFile:space:notes/a.md")).toBe(true);
    expect(declaresCapability(wired, "writeDocument:space:notes/a.md")).toBe(false);
  });

  it("reads the one file a person allowed, and no other", async () => {
    writeFileSync(path.join(space, WIRED), wiredFlow([{ target: "load", targetPort: "path" }]));
    const flow = await doc();
    expect(await statusOf(performSandboxRead(space, flow, "space:notes/a.md"))).toBe(403);

    await grantCapability(space, flow.subject, "readFile:space:notes/a.md");
    expect(await performSandboxRead(space, flow, "space:notes/a.md")).toEqual({ kind: "text", content: "# A\n" });
    expect(await statusOf(performSandboxRead(space, flow, "space:t.table.html"))).toBe(403);
  });

  it("keys any spelling of a path by its address, and never reaches a hidden entry", async () => {
    writeFileSync(path.join(space, WIRED), wiredFlow([{ target: "load", targetPort: "path" }]));
    const flow = await doc();
    await grantCapability(space, flow.subject, "readFile:space:notes/a.md");
    for (const target of ["space:notes/a.md", "/notes/a.md", "../notes/a.md"]) {
      expect(await performSandboxRead(space, flow, target), target).toEqual({ kind: "text", content: "# A\n" });
    }
    // From the Flow's folder, another file, which nobody allowed.
    expect(await statusOf(performSandboxRead(space, flow, "notes/a.md"))).toBe(403);
    for (const target of ["space:notes/../notes/a.md", "space:.env", "../.env"]) {
      expect(await statusOf(performSandboxRead(space, flow, target)), target).toBe(400);
    }
    for (const key of ["readFile:notes/a.md", "readFile:../notes/a.md", "readFile:space:.env"]) {
      expect(declaresCapability(flow, key), key).toBe(false);
    }
  });

  it("writes a note and adds a row only where a person allowed each one", async () => {
    writeFileSync(
      path.join(space, WIRED),
      wiredFlow([
        { target: "write", targetPort: "path" },
        { target: "row", targetPort: "table_path" },
      ]),
    );
    const flow = await doc();
    expect([...flow.wired]).toEqual(["write"]);
    expect(await statusOf(performSandboxWrite(space, flow, "space:projects/new.md", "x"))).toBe(403);
    expect(await statusOf(performSandboxRead(space, flow, "space:notes/a.md"))).toBe(400);

    await grantCapability(space, flow.subject, "writeDocument:space:projects/new.md");
    await performSandboxWrite(space, flow, "space:projects/new.md", "# New\n");
    expect(readFileSync(path.join(space, "projects", "new.md"), "utf8")).toBe("# New\n");

    expect(await statusOf(performSandboxAddRow(space, flow, "space:t2.table.html", {}))).toBe(403);
    await grantCapability(space, flow.subject, "writeDocument:space:t2.table.html");
    expect(await performSandboxAddRow(space, flow, "space:t2.table.html", {})).toEqual({ path: "t2.table.html" });
  });
});

describe("writing into a folder", () => {
  const FOLDER_FLOW = "projects/folder.flow.html";
  const folderFlow = (config: Record<string, unknown>, wired = false) =>
    serializeFlowFile({
      version: "1.0",
      name: "Folder",
      graph: {
        nodes: [
          { id: "src", type: "prompt", position: { x: 0, y: 0 }, config: { text: "x" } },
          { id: "write", type: "writeFolderNote", position: { x: 0, y: 0 }, config },
        ],
        edges: wired ? [{ id: "e0", source: "src", sourcePort: "text", target: "write", targetPort: "path" }] : [],
      },
    });
  const doc = () => readSandboxDocument(space, "flow", FOLDER_FLOW);
  const shot = (name: string) => readFileSync(path.join(space, "projects", "shots", name), "utf8");

  beforeEach(() => {
    saveGlobalConfig(rememberSpace(loadGlobalConfig(), space));
    mkdirSync(path.join(space, "projects", "shots", "old"), { recursive: true });
  });

  it("writes any note directly in a granted folder, and none below it or beside it", async () => {
    writeFileSync(path.join(space, FOLDER_FLOW), folderFlow({ folderPath: "shots/" }));
    const flow = await doc();
    expect(await statusOf(performSandboxWrite(space, flow, "shots/Tent.md", "x"))).toBe(403);

    await grantCapability(space, flow.subject, "writeDocument:space:projects/shots");
    await performSandboxWrite(space, flow, "shots/Tent.md", "# Tent\n");
    await performSandboxWrite(space, flow, "space:projects/shots/Ice.md", "# Ice\n");
    expect([shot("Tent.md"), shot("Ice.md")]).toEqual(["# Tent\n", "# Ice\n"]);
    expect(await statusOf(performSandboxWrite(space, flow, "shots/old/Tent.md", "x"))).toBe(400);
    expect(await statusOf(performSandboxWrite(space, flow, "Tent.md", "x"))).toBe(400);
  });

  it("asks a wired folder's grant once for the folder, only while a wire reaches the pin", async () => {
    writeFileSync(path.join(space, FOLDER_FLOW), folderFlow({}));
    expect(declaresCapability(await doc(), "writeDocument:space:projects/shots")).toBe(false);

    writeFileSync(path.join(space, FOLDER_FLOW), folderFlow({}, true));
    const flow = await doc();
    expect(declaresCapability(flow, "writeDocument:space:projects/shots")).toBe(true);
    expect(await statusOf(performSandboxWrite(space, flow, "space:projects/shots/Tent.md", "x"))).toBe(403);

    await grantCapability(space, flow.subject, "writeDocument:space:projects/shots");
    await performSandboxWrite(space, flow, "space:projects/shots/Tent.md", "# Tent\n");
    await performSandboxWrite(space, flow, "space:projects/shots/Ice.md", "# Ice\n");
    expect([shot("Tent.md"), shot("Ice.md")]).toEqual(["# Tent\n", "# Ice\n"]);
    expect(await statusOf(performSandboxWrite(space, flow, "space:projects/shots/old/Tent.md", "x"))).toBe(403);
  });

  it("refuses a folder that isn't there rather than making it", async () => {
    writeFileSync(path.join(space, FOLDER_FLOW), folderFlow({ folderPath: "drafts/" }));
    const flow = await doc();
    await grantCapability(space, flow.subject, "writeDocument:space:projects/drafts");
    await expect(performSandboxWrite(space, flow, "drafts/Tent.md", "x")).rejects.toThrow(
      '"/projects/drafts/" isn\'t a folder',
    );
    expect(existsSync(path.join(space, "projects", "drafts"))).toBe(false);
  });
});
