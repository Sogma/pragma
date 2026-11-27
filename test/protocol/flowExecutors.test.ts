import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateVideoRequestBody } from "../../src/protocol/api.ts";
import {
  describeContextSent,
  describeCost,
  describeSpend,
  NODE_EXECUTORS,
  type NodeExecutionContext,
  type PortValue,
  spendEntry,
} from "../../src/protocol/flowExecutors.ts";
import type { FlowCapabilityDeclaration, FlowNodeInstance } from "../../src/protocol/types.ts";

// A 2x2 PNG, so the executor's own dimension decode has real bytes to read.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxEgFGFdFAIAB3+AR+WvKZ6AAAAAElFTkSuQmCC";

const sandboxRead = vi.fn();

// Both environment-specific calls arrive through the context, so there is
// no module to mock and no browser to stand up — the executors themselves are
// isomorphic (src/protocol/flowExecutors.ts).
function context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    flowPath: "picture.flow.html",
    sandbox: {
      read: sandboxRead,
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    },
    decodeImageDimensions: async () => ({ width: 2, height: 2 }),
    pickedImages: new Map(),
    ensureCapability: vi.fn(async () => true),
    beginLlmActivity: vi.fn(),
    endLlmActivity: vi.fn(),
    scopes: async () => new Set<string>(),
    clock: { year: 2026, month: 11, day: 9, hour: 14, minute: 30, second: 5, offset: 60 },
    ...overrides,
  };
}

function loadImageNode(imagePath: string): FlowNodeInstance {
  return { id: "loadImage-1", type: "loadImage", position: { x: 0, y: 0 }, config: { imagePath } };
}

beforeEach(() => {
  sandboxRead.mockReset();
  sandboxRead.mockResolvedValue({ kind: "image", mediaType: "image/png", data: PNG_BASE64 });
});

// The grant a Run asks for has to be the one the saved graph declares, or
// the prompt's Allow records a key the server never checks and every Run
// asks again. Three call sites derive it; this is the one that had drifted.
describe("the Load Image executor's capability", () => {
  async function grantRequestedFor(imagePath: string): Promise<FlowCapabilityDeclaration> {
    const ensureCapability = vi.fn(async (_capability: FlowCapabilityDeclaration) => true);
    await NODE_EXECUTORS.loadImage(loadImageNode(imagePath), {}, context({ ensureCapability }));
    return ensureCapability.mock.calls[0][0];
  }

  it("asks for readFile against the space", async () => {
    expect(await grantRequestedFor("art/portrait.png")).toEqual({ type: "readFile", path: "art/portrait.png" });
  });

  it("asks to read a library's file on its rooted path", async () => {
    expect(await grantRequestedFor("lib:footage/stills/sunset.png")).toEqual({
      type: "readFile",
      path: "lib:footage/stills/sunset.png",
    });
  });

  it("reads the stored path through the broker unchanged, and names the image from it", async () => {
    const outputs = await NODE_EXECUTORS.loadImage(loadImageNode("lib:footage/stills/sunset.png"), {}, context());
    expect(sandboxRead).toHaveBeenCalledWith("flow", "picture.flow.html", "lib:footage/stills/sunset.png");
    expect(outputs.name).toEqual({ type: "text", value: "sunset" });
    expect(outputs.width).toEqual({ type: "number", value: 2 });
    expect(outputs.aspect_ratio).toEqual({ type: "text", value: "1:1" });
  });

  it("gives the image's ratio as the gallery writes it", async () => {
    const outputs = await NODE_EXECUTORS.loadImage(
      loadImageNode("lib:footage/stills/sunset.png"),
      {},
      context({ decodeImageDimensions: async () => ({ width: 1998, height: 1080 }) }),
    );
    expect(outputs.aspect_ratio).toEqual({ type: "text", value: "1.85:1" });
  });

  it("refuses to run on a denied grant rather than reading anyway", async () => {
    const denied = context({ ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.loadImage(loadImageNode("lib:footage/x.png"), {}, denied)).rejects.toThrow(
      /Permission denied/,
    );
    expect(sandboxRead).not.toHaveBeenCalled();
  });
});

// A clip goes on by reference (protocol.md's Ports and types): the run holds
// its facts and digest, and the host reads the bytes only where they're sent.
describe("the Load Video node", () => {
  const CLIP = {
    kind: "video",
    mediaType: "video/mp4",
    digest: "ab".repeat(32),
    width: 1920,
    height: 1080,
    duration: 5,
    frameRate: 25,
    variableFrameRate: false,
  };
  const videoNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "loadVideo-1",
    type: "loadVideo",
    position: { x: 0, y: 0 },
    config,
  });

  beforeEach(() => sandboxRead.mockResolvedValue(CLIP));

  it("hands the clip on by reference, with its facts, from the root", async () => {
    const outputs = await NODE_EXECUTORS.loadVideo(videoNode({ videoPath: "shots/take.mp4" }), {}, context());
    expect(sandboxRead).toHaveBeenCalledWith("flow", "picture.flow.html", "shots/take.mp4");
    const { kind: _kind, ...facts } = CLIP;
    expect(outputs).toEqual({
      video: { type: "video", path: "/shots/take.mp4", ...facts },
      name: { type: "text", value: "take" },
      width: { type: "number", value: 1920 },
      height: { type: "number", value: 1080 },
      aspect_ratio: { type: "text", value: "16:9" },
      duration: { type: "number", value: 5 },
      fps: { type: "number", value: 25 },
      path: { type: "text", value: "/shots/take.mp4" },
    });
  });

  it("asks to read a library's clip on its rooted path, and names it there", async () => {
    const ensureCapability = vi.fn(async (_capability: FlowCapabilityDeclaration) => true);
    const outputs = await NODE_EXECUTORS.loadVideo(
      videoNode({ videoPath: "lib:footage/take.mov" }),
      {},
      context({ ensureCapability }),
    );
    expect(ensureCapability.mock.calls[0][0]).toEqual({ type: "readFile", path: "lib:footage/take.mov" });
    expect(outputs.video).toMatchObject({ type: "video", path: "lib:footage/take.mov" });
  });

  it("takes a wired path in place of the stored one, asking for that file", async () => {
    const ensureCapability = vi.fn(async (_capability: FlowCapabilityDeclaration) => true);
    const wired = { path: { type: "text" as const, value: "shots/other.webm" } };
    const outputs = await NODE_EXECUTORS.loadVideo(
      videoNode({ videoPath: "shots/take.mp4" }),
      wired,
      context({ ensureCapability }),
    );
    expect(ensureCapability.mock.calls[0][0]).toEqual({
      type: "readFile",
      path: "space:shots/other.webm",
      wired: true,
    });
    expect(outputs.path).toEqual({ type: "text", value: "/shots/other.webm" });
  });

  it("leaves out each fact the clip's header doesn't give", async () => {
    sandboxRead.mockResolvedValue({ ...CLIP, width: null, height: null, duration: null, frameRate: null });
    const outputs = await NODE_EXECUTORS.loadVideo(videoNode({ videoPath: "shots/take.mp4" }), {}, context());
    expect(Object.keys(outputs).sort()).toEqual(["name", "path", "video"]);
    expect(outputs.video).toMatchObject({ width: null, duration: null });
  });

  it("fails a path that isn't a clip before anything is asked", async () => {
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.loadVideo(videoNode({ videoPath: "art/still.png" }), {}, context({ ensureCapability })),
    ).rejects.toThrow('"art/still.png" is not a video clip');
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(sandboxRead).not.toHaveBeenCalled();
  });

  it("refuses to read on a denied grant", async () => {
    const denied = context({ ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.loadVideo(videoNode({ videoPath: "shots/take.mp4" }), {}, denied)).rejects.toThrow(
      /Permission denied/,
    );
    expect(sandboxRead).not.toHaveBeenCalled();
  });

  it("fails with nothing picked, unless it's optional, when it gives nothing at all", async () => {
    await expect(NODE_EXECUTORS.loadVideo(videoNode({}), {}, context())).rejects.toThrow(/Drag a clip/);
    expect(await NODE_EXECUTORS.loadVideo(videoNode({ optional: "true" }), {}, context())).toEqual({});
    const emptyWire = { path: { type: "text" as const, value: "" } };
    expect(await NODE_EXECUTORS.loadVideo(videoNode({ optional: "true" }), emptyWire, context())).toEqual({});
  });
});

// A grant to read what the node then refuses would be a prompt for nothing.
describe("Load Image and Load Folder Image refuse a vector image", () => {
  it("fails a stored or wired SVG before anything is asked", async () => {
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.loadImage(loadImageNode("art/logo.svg"), {}, context({ ensureCapability })),
    ).rejects.toThrow('"art/logo.svg" is a vector image, not a raster image');
    const wired = { path: { type: "text" as const, value: "art/logo.svg" } };
    await expect(NODE_EXECUTORS.loadImage(loadImageNode(""), wired, context({ ensureCapability }))).rejects.toThrow(
      /is a vector image, not a raster image/,
    );
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(sandboxRead).not.toHaveBeenCalled();
  });

  it("fails Load Folder Image's selected SVG the same way", async () => {
    const ensureCapability = vi.fn(async () => true);
    const node: FlowNodeInstance = {
      id: "loadFolderImage-1",
      type: "loadFolderImage",
      position: { x: 0, y: 0 },
      config: { folderPath: "art", imagePath: "art/logo.svg" },
    };
    await expect(NODE_EXECUTORS.loadFolderImage(node, {}, context({ ensureCapability }))).rejects.toThrow(
      '"art/logo.svg" is a vector image, not a raster image',
    );
    expect(ensureCapability).not.toHaveBeenCalled();
  });
});

describe("the Load Note executor's outputs", () => {
  function loadNoteNode(notePath: string): FlowNodeInstance {
    return { id: "loadNote-1", type: "loadNote", position: { x: 0, y: 0 }, config: { notePath } };
  }

  async function outputsFor(content: string, notePath = "scenes/opening.md") {
    sandboxRead.mockResolvedValue({ kind: "text", content });
    return NODE_EXECUTORS.loadNote(loadNoteNode(notePath), {}, context());
  }

  it("splits the note into title, properties and body, alongside the raw file", async () => {
    const content = "---\nstatus: draft\ntags: [a, b]\n---\n# Opening\n\nINT. HOUSE\n";
    expect(await outputsFor(content)).toEqual({
      raw: { type: "text", value: content },
      title: { type: "text", value: "Opening" },
      properties: { type: "object", value: { status: "draft", tags: ["a", "b"] } },
      body: { type: "text", value: "INT. HOUSE\n" },
      path: { type: "text", value: "/scenes/opening.md" },
    });
  });

  it("falls back to the file name for the title, and an empty object for properties", async () => {
    const outputs = await outputsFor("Just prose.");
    expect(outputs.title).toEqual({ type: "text", value: "opening" });
    expect(outputs.properties).toEqual({ type: "object", value: {} });
    expect(outputs.body).toEqual({ type: "text", value: "Just prose." });
  });

  // `space:` is the root the path is written from, not part of the name.
  it("names a note or image at the space root by its file name alone", async () => {
    expect((await outputsFor("Just prose.", "space:ideas.md")).title).toEqual({ type: "text", value: "ideas" });
    sandboxRead.mockResolvedValue({ kind: "image", mediaType: "image/png", data: PNG_BASE64 });
    const image = await NODE_EXECUTORS.loadImage(
      { id: "loadImage-1", type: "loadImage", position: { x: 0, y: 0 }, config: { imagePath: "space:door.png" } },
      {},
      context(),
    );
    expect(image.name).toEqual({ type: "text", value: "door" });
  });

  it("still reads a note whose frontmatter is not valid YAML", async () => {
    const outputs = await outputsFor("---\nkey: [unclosed\n---\n# Title\n\nbody");
    expect(outputs.properties).toEqual({ type: "object", value: {} });
    expect(outputs.title).toEqual({ type: "text", value: "Title" });
    expect(outputs.body).toEqual({ type: "text", value: "body" });
  });
});

describe("the document nodes", () => {
  const node = (type: string): FlowNodeInstance => ({ id: `${type}-1`, type, position: { x: 0, y: 0 }, config: {} });
  const bound = (selection: string) => ({
    path: "notes/draft.md",
    hasSelection: selection !== "",
    read: vi.fn(() => ({ content: "---\ntags: [a]\n---\n\n# Draft\n\nFirst line.\n", selection })),
    replaceSelection: vi.fn(),
    showResult: vi.fn(),
  });

  it("Current Document gives the note outputs plus the selection, behind readCurrentDocument", async () => {
    const document = bound("First");
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.currentDocument(
      node("currentDocument"),
      {},
      context({ document, ensureCapability }),
    );

    expect(ensureCapability).toHaveBeenCalledWith({ type: "readCurrentDocument" });
    expect(outputs.title).toEqual({ type: "text", value: "Draft" });
    expect(outputs.properties).toEqual({ type: "object", value: { tags: ["a"] } });
    expect(outputs.body).toEqual({ type: "text", value: "First line.\n" });
    expect(outputs.selection).toEqual({ type: "text", value: "First" });
    expect(outputs.has_selection).toEqual({ type: "boolean", value: true });
  });

  it("Current Document reads nothing when the grant is refused", async () => {
    const document = bound("");
    await expect(
      NODE_EXECUTORS.currentDocument(
        node("currentDocument"),
        {},
        context({ document, ensureCapability: async () => false }),
      ),
    ).rejects.toThrow("Permission denied");
    expect(document.read).not.toHaveBeenCalled();
  });

  it("both fail, naming why, when no document is bound", async () => {
    await expect(NODE_EXECUTORS.currentDocument(node("currentDocument"), {}, context())).rejects.toThrow(
      "Run this flow from a document's Tools tab",
    );
    await expect(
      NODE_EXECUTORS.replaceSelection(node("replaceSelection"), { text: { type: "text", value: "x" } }, context()),
    ).rejects.toThrow("Run this flow from a document's Tools tab");
  });

  it("Replace Selection hands its text to the document, and refuses an unconnected input", async () => {
    const document = bound("First");
    await NODE_EXECUTORS.replaceSelection(
      node("replaceSelection"),
      { text: { type: "text", value: "Opening" } },
      context({ document }),
    );
    expect(document.replaceSelection).toHaveBeenCalledWith(["Opening"]);

    await expect(NODE_EXECUTORS.replaceSelection(node("replaceSelection"), {}, context({ document }))).rejects.toThrow(
      "Nothing is connected",
    );
    expect(document.replaceSelection).toHaveBeenCalledTimes(1);
  });
});

describe("the Generate Options node", () => {
  const optionsNode = (count?: string): FlowNodeInstance => ({
    id: "opts-1",
    type: "generateOptions",
    position: { x: 0, y: 0 },
    config: count === undefined ? {} : { count },
  });
  const prompt = { prompt: { type: "text" as const, value: "Rhyme it" } };

  it("makes the host's options call and outputs the parsed list", async () => {
    const generateOptions = vi.fn(async () => ({ options: ["a", "b"], model: "m" }));
    const outputs = await NODE_EXECUTORS.generateOptions(
      optionsNode(),
      prompt,
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions,
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
      }),
    );
    expect(generateOptions).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({ instruction: "Rhyme it", numOptions: 10 }),
      undefined,
    );
    expect(outputs.options).toEqual({ type: "object", value: ["a", "b"] });
  });

  it("reads its count, capped, and falls back to the default for one it can't read", async () => {
    const counts: number[] = [];
    const generateOptions = vi.fn(async (_kind, _path, body: { numOptions: number }) => {
      counts.push(body.numOptions);
      return { options: [], model: "m" };
    });
    const sandbox = {
      read: sandboxRead,
      write: vi.fn(),
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions,
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    };
    for (const count of ["4", "99", "lots", "0"]) {
      await NODE_EXECUTORS.generateOptions(optionsNode(count), prompt, context({ sandbox }));
    }
    expect(counts).toEqual([4, 20, 10, 10]);
  });
});

describe("Replace Selection's options", () => {
  const replaceNode: FlowNodeInstance = {
    id: "replace-1",
    type: "replaceSelection",
    position: { x: 0, y: 0 },
    config: {},
  };
  const document = () => ({
    path: "song.md",
    hasSelection: true,
    read: vi.fn(),
    replaceSelection: vi.fn(),
    showResult: vi.fn(),
  });

  it("proposes a list as alternatives, and prefers it over text", async () => {
    const bound = document();
    await NODE_EXECUTORS.replaceSelection(
      replaceNode,
      { options: { type: "object", value: ["a", "b"] }, text: { type: "text", value: "c" } },
      context({ document: bound }),
    );
    expect(bound.replaceSelection).toHaveBeenCalledWith(["a", "b"]);
  });

  it("refuses options that aren't a list of text", async () => {
    for (const value of [[], ["a", 2], { a: "b" }, "a"]) {
      await expect(
        NODE_EXECUTORS.replaceSelection(
          replaceNode,
          { options: { type: "object", value } },
          context({ document: document() }),
        ),
      ).rejects.toThrow("isn't a list of text");
    }
  });
});

describe("Current Document's Require a selection", () => {
  const docNode = (requireSelection: boolean): FlowNodeInstance => ({
    id: "doc-1",
    type: "currentDocument",
    position: { x: 0, y: 0 },
    config: requireSelection ? { requireSelection: "true" } : {},
  });
  const unselected = () => ({
    path: "song.md",
    hasSelection: false,
    read: vi.fn(() => ({ content: "a line\n", selection: "" })),
    replaceSelection: vi.fn(),
    showResult: vi.fn(),
  });

  it("refuses a run with nothing selected, before asking for the grant or reading", async () => {
    const bound = unselected();
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.currentDocument(docNode(true), {}, context({ document: bound, ensureCapability })),
    ).rejects.toThrow("Select some text first");
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(bound.read).not.toHaveBeenCalled();
  });

  it("reads as usual without it", async () => {
    const outputs = await NODE_EXECUTORS.currentDocument(docNode(false), {}, context({ document: unselected() }));
    expect(outputs.has_selection).toEqual({ type: "boolean", value: false });
  });
});

describe("the Get Field node", () => {
  const getFieldNode = (config: Record<string, string>): FlowNodeInstance => ({
    id: "getField-1",
    type: "getField",
    position: { x: 0, y: 0 },
    config,
  });
  const record = (value: unknown) => ({ object: { type: "object" as const, value } });
  const run = (key: string, value: unknown) =>
    NODE_EXECUTORS.getField(getFieldNode({ field1Key: key }), record(value), context());

  it("outputs each slot's field as text on that slot's pin, matching keys exactly", async () => {
    const row = { Name: "Clubasic", Voice: "Dry, curious", Rank: 3 };
    const outputs = await NODE_EXECUTORS.getField(
      getFieldNode({ field1Key: "Voice", field3Key: "Rank" }),
      record(row),
      context(),
    );
    expect(outputs).toEqual({
      field_1: { type: "text", value: "Dry, curious" },
      field_3: { type: "text", value: "3" },
    });
    await expect(run("voice", { Voice: "Dry" })).rejects.toThrow('No field "voice" (it has Voice)');
  });

  it("skips a slot with no key, but fails when no slot has one", async () => {
    const outputs = await NODE_EXECUTORS.getField(
      getFieldNode({ field1Key: "", field2Key: "Name" }),
      record({ Name: "A" }),
      context(),
    );
    expect(Object.keys(outputs)).toEqual(["field_2"]);
    await expect(run(" ", { Name: "A" })).rejects.toThrow("Choose a field to read");
  });

  it("fails on a missing field rather than reading it as empty, naming what's there", async () => {
    await expect(run("Tone", { Name: "A", Voice: "B" })).rejects.toThrow('No field "Tone" (it has Name, Voice)');
    await expect(run("Voice", {})).rejects.toThrow('No field "Voice" (its input is empty)');
    // Inherited properties aren't fields.
    await expect(run("toString", { Name: "A" })).rejects.toThrow('No field "toString"');
  });

  it("fails on an input that isn't a record, and on a field that isn't a single value", async () => {
    await expect(run("0", ["a", "b"])).rejects.toThrow("Its object input isn't a record of fields");
    await expect(run("design", { design: { illustrated: "true" } })).rejects.toThrow(
      'Field "design" is a group of fields, not a single value',
    );
    await expect(run("tags", { tags: ["a"] })).rejects.toThrow('Field "tags" is a list, not a single value');
    await expect(NODE_EXECUTORS.getField(getFieldNode({ field1Key: "Voice" }), {}, context())).rejects.toThrow(
      "Nothing is connected to its object input",
    );
  });
});

describe("Load Row's pick", () => {
  const loadRow = (selectedValue: string) =>
    NODE_EXECUTORS.loadRow(
      {
        id: "loadRow-1",
        type: "loadRow",
        position: { x: 0, y: 0 },
        config: { tablePath: "t.table.html", selectedValue },
      },
      {},
      context(),
    );

  beforeEach(() => {
    sandboxRead.mockResolvedValue({
      kind: "table",
      columns: [
        { id: "c1", label: "Scene", type: "text" },
        { id: "c2", label: "Takes", type: "integer" },
      ],
      rows: [{ id: "r1", values: { c1: "One", c2: "3" } }],
    });
  });

  it("gives the picked row, keyed by column label", async () => {
    const outputs = await loadRow("One");
    expect(outputs.row).toEqual({ type: "object", value: { Scene: "One", Takes: "3" } });
    expect(outputs.selected).toEqual({ type: "text", value: "One" });
  });

  it("gives an empty row when nothing is picked", async () => {
    expect((await loadRow("")).row).toEqual({ type: "object", value: {} });
  });

  // An empty row would run every downstream node on nothing, and say nothing.
  it("fails on a pick the table no longer has", async () => {
    await expect(loadRow("Two")).rejects.toThrow('"t.table.html" no longer has a row "Two"');
  });
});

describe("Load Table and Chart", () => {
  const node = (type: string, config: Record<string, string>): FlowNodeInstance => ({
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    config,
  });
  const rows = (value: unknown) => ({ rows: { type: "object" as const, value } });
  const chart = (config: Record<string, string>, value: unknown) =>
    NODE_EXECUTORS.chart(node("chart", config), rows(value), context());

  it("loads every row keyed by column label, as Load Row keys its one row", async () => {
    sandboxRead.mockResolvedValue({
      kind: "table",
      columns: [
        { id: "c1", label: "Scene", type: "text" },
        { id: "c2", label: "Takes", type: "integer" },
      ],
      rows: [
        { id: "r1", values: { c1: "One", c2: "3" } },
        { id: "r2", values: { c1: "Two" } },
      ],
    });
    const outputs = await NODE_EXECUTORS.loadTableRows(
      node("loadTableRows", { tablePath: "takes.table.html" }),
      {},
      context(),
    );
    expect(outputs.rows).toEqual({
      type: "object",
      value: [
        { Scene: "One", Takes: "3" },
        { Scene: "Two", Takes: "" },
      ],
    });
    expect(sandboxRead).toHaveBeenCalledWith("flow", "picture.flow.html", "takes.table.html");
  });

  // A Table names a file from its own folder; a node hands it on from the
  // root, so it names the same file wherever it is wired.
  it("hands on a media or path value from the root, and one that names nothing as written", async () => {
    sandboxRead.mockResolvedValue({
      kind: "table",
      columns: [
        { id: "c1", label: "Still", type: "media" },
        { id: "c2", label: "Refs", type: "path" },
        { id: "c3", label: "Note", type: "text" },
      ],
      rows: [
        { values: { c1: "stills/a%20b.png", c2: "../refs/", c3: "stills/a.png" } },
        { values: { c1: "lib:footage/x.png", c2: "../../../x.md", c3: "" } },
      ],
    });
    const outputs = await NODE_EXECUTORS.loadTableRows(
      node("loadTableRows", { tablePath: "shots/log.table.html" }),
      {},
      context({ flowPath: "film/picture.flow.html" }),
    );
    expect(outputs.rows).toEqual({
      type: "object",
      value: [
        { Still: "/film/shots/stills/a b.png", Refs: "/film/refs/", Note: "stills/a.png" },
        { Still: "lib:footage/x.png", Refs: "../../../x.md", Note: "" },
      ],
    });
  });

  it("hands a picked row's path on from the root", async () => {
    sandboxRead.mockResolvedValue({
      kind: "table",
      columns: [{ id: "c1", label: "Ref", type: "path" }],
      rows: [{ values: { c1: "a.md" } }],
    });
    const picked = await NODE_EXECUTORS.loadRow(
      node("loadRow", { tablePath: "shots/log.table.html", selectedValue: "a.md" }),
      {},
      context({ flowPath: "film/picture.flow.html" }),
    );
    expect(picked).toEqual({
      selected: { type: "text", value: "/film/shots/a.md" },
      row: { type: "object", value: { Ref: "/film/shots/a.md" } },
      path: { type: "text", value: "/film/shots/log.table.html" },
    });
  });

  it("loads no rows, rather than failing, before a table is chosen", async () => {
    const outputs = await NODE_EXECUTORS.loadTableRows(node("loadTableRows", {}), {}, context());
    expect(outputs.rows).toEqual({ type: "object", value: [] });
    expect(sandboxRead).not.toHaveBeenCalled();
  });

  it("passes its rows through once the columns it charts exist", async () => {
    const value = [{ Scene: "One", Takes: "3" }];
    expect(await chart({ x: "Scene", y: "Takes" }, value)).toEqual(rows(value));
    expect(await chart({ x: "Scene", y: "Takes" }, [])).toEqual(rows([]));
  });

  it("fails without a list of rows, or without both columns chosen", async () => {
    await expect(NODE_EXECUTORS.chart(node("chart", { x: "a", y: "b" }), {}, context())).rejects.toThrow(
      "Chart needs a list of rows",
    );
    await expect(chart({ x: "a", y: "b" }, { a: "1" })).rejects.toThrow("Chart needs a list of rows");
    await expect(chart({ x: "a", y: "b" }, ["1"])).rejects.toThrow("Chart needs a list of rows");
    await expect(chart({ x: "Scene" }, [{ Scene: "One" }])).rejects.toThrow("Choose the columns to chart");
  });

  it("fails on a column the rows lack, naming the ones they have", async () => {
    await expect(chart({ x: "Scene", y: "Take" }, [{ Scene: "One", Takes: "3" }])).rejects.toThrow(
      'No column "Take" (it has Scene, Takes)',
    );
  });
});

describe("Show Result", () => {
  const showNode: FlowNodeInstance = { id: "show-1", type: "showResult", position: { x: 0, y: 0 }, config: {} };
  const port = () => ({
    path: "scene.fountain",
    hasSelection: false,
    read: vi.fn(),
    replaceSelection: vi.fn(),
    showResult: vi.fn(),
  });

  it("shows a list a line each under the button, and passes it on as text", async () => {
    const document = port();
    const outputs = await NODE_EXECUTORS.showResult(
      showNode,
      { options: { type: "object", value: ["One summary.", "Another."] } },
      context({ document }),
    );
    expect(document.showResult).toHaveBeenCalledWith(["One summary.", "Another."]);
    expect(outputs).toEqual({ text: { type: "text", value: "One summary.\n\nAnother." } });
  });

  it("passes its text on with no button behind the run, and fails with nothing wired", async () => {
    expect(await NODE_EXECUTORS.showResult(showNode, { text: { type: "text", value: "Done." } }, context())).toEqual({
      text: { type: "text", value: "Done." },
    });
    await expect(NODE_EXECUTORS.showResult(showNode, {}, context())).rejects.toThrow(
      "Nothing is connected to its text or options input",
    );
  });
});

describe("Button", () => {
  const buttonNode = (config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: "button-1",
    type: "button",
    position: { x: 0, y: 0 },
    config,
  });
  const port = (hasSelection = true) => ({
    path: "scenes/scene.fountain",
    hasSelection,
    read: vi.fn(() => ({
      content: "INT. KITCHEN - DAY\n\nLina waits.\n",
      selection: hasSelection ? "Lina waits." : "",
    })),
    replaceSelection: vi.fn(),
    showResult: vi.fn(),
  });

  it("hands on the selection, the whole file and its path, as Current Document reads them", async () => {
    const document = port();
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.button(
      buttonNode(),
      {},
      context({ document, ensureCapability }),
      new Set(["selection"]),
    );
    const read = await NODE_EXECUTORS.currentDocument(buttonNode(), {}, context({ document: port() }));
    expect(outputs).toEqual({ path: read.path, selection: read.selection, raw: read.raw });
    expect(ensureCapability).toHaveBeenCalledWith({ type: "readCurrentDocument" });
  });

  it("asks for nothing and reads nothing while only its path is wired", async () => {
    const document = port();
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.button(
      buttonNode(),
      {},
      context({ document, ensureCapability }),
      new Set(["path"]),
    );
    expect(Object.keys(outputs)).toEqual(["path"]);
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(document.read).not.toHaveBeenCalled();
  });

  it("stops a click with nothing selected under Require a selection, before asking or reading", async () => {
    const document = port(false);
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.button(
        buttonNode({ requireSelection: "true" }),
        {},
        context({ document, ensureCapability }),
        new Set(["selection"]),
      ),
    ).rejects.toThrow("Select some text first");
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(document.read).not.toHaveBeenCalled();
  });

  it("fails with nothing wired from it, and with no document bound", async () => {
    await expect(NODE_EXECUTORS.button(buttonNode(), {}, context({ document: port() }), new Set())).rejects.toThrow(
      "Nothing is wired from it, so a click would run nothing",
    );
    await expect(NODE_EXECUTORS.button(buttonNode(), {}, context(), new Set(["selection"]))).rejects.toThrow(
      "No document to act on",
    );
  });
});

describe("Open to the Side", () => {
  const openNode = (config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: "openToSide-1",
    type: "openToSide",
    position: { x: 0, y: 0 },
    config,
  });
  const wired = (value: string) => ({ path: { type: "text" as const, value } });

  it("opens a wired path, read from the Flow's folder, and asks for nothing", async () => {
    const openToSide = vi.fn(async () => {});
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.openToSide(
      openNode({ documentPath: "space:elsewhere.md" }),
      wired("notes/summary.md"),
      context({ flowPath: "tools/kit.flow.html", openToSide, ensureCapability }),
    );
    expect(openToSide).toHaveBeenCalledWith("tools/notes/summary.md");
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(outputs).toEqual({});
  });

  it("opens the file dragged onto it when nothing is wired", async () => {
    const openToSide = vi.fn(async () => {});
    await NODE_EXECUTORS.openToSide(
      openNode({ documentPath: "space:projects/style-guide.md" }),
      {},
      context({ flowPath: "tools/kit.flow.html", openToSide }),
    );
    expect(openToSide).toHaveBeenCalledWith("projects/style-guide.md");
  });

  it("opens nothing and fails nothing with no one looking", async () => {
    expect(await NODE_EXECUTORS.openToSide(openNode(), {}, context())).toEqual({});
  });

  it("refuses no path, a library's file and a hidden entry, before opening anything", async () => {
    const openToSide = vi.fn(async () => {});
    const run = (inputs: Record<string, { type: "text"; value: string }>) =>
      NODE_EXECUTORS.openToSide(openNode(), inputs, context({ openToSide }));
    await expect(run({})).rejects.toThrow("Nothing to open");
    await expect(run(wired("lib:refs/plate.png"))).rejects.toThrow("is in a library, which this node can't reach");
    await expect(run(wired(".git/config"))).rejects.toThrow("names a hidden entry");
    expect(openToSide).not.toHaveBeenCalled();
  });

  it("fails as the host's open does when nothing is there", async () => {
    const openToSide = vi.fn(async () => {
      throw new Error("Nothing at notes/gone.md to open");
    });
    await expect(
      NODE_EXECUTORS.openToSide(openNode(), wired("notes/gone.md"), context({ openToSide })),
    ).rejects.toThrow("Nothing at notes/gone.md to open");
  });
});

describe("the Choice node", () => {
  const choiceNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "choice-1",
    type: "choice",
    position: { x: 0, y: 0 },
    config,
  });
  const options = "Full body\n  Close-up \n\nClose-up\n";

  it("gives the pick, or the first option when nothing is picked", async () => {
    expect(await NODE_EXECUTORS.choice(choiceNode({ options, text: "Close-up" }), {}, context())).toEqual({
      text: { type: "text", value: "Close-up" },
    });
    expect(await NODE_EXECUTORS.choice(choiceNode({ options }), {}, context())).toEqual({
      text: { type: "text", value: "Full body" },
    });
  });

  it("refuses a pick that isn't one of its options, naming the ones it has", async () => {
    await expect(NODE_EXECUTORS.choice(choiceNode({ options, text: "Wide" }), {}, context())).rejects.toThrow(
      `"Wide" isn't one of this Choice's options: Full body, Close-up`,
    );
  });
});

describe("the Int node", () => {
  const intNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "int-1",
    type: "int",
    position: { x: 0, y: 0 },
    config,
  });

  // The editor moves the value on after the run, never the executor, so a
  // run gives the number the card showed when it began.
  it("gives its value as a number, 0 when blank, and leaves its config as it was", async () => {
    const node = intNode({ value: "-12", control: "increment" });
    expect(await NODE_EXECUTORS.int(node, {}, context())).toEqual({ int: { type: "number", value: -12 } });
    expect(node.config).toEqual({ value: "-12", control: "increment" });
    expect(await NODE_EXECUTORS.int(intNode({}), {}, context())).toEqual({ int: { type: "number", value: 0 } });
  });

  it("fails on a value that isn't a whole number it can hold, naming the range", async () => {
    for (const value of ["2.5", "ten", "9007199254740992"]) {
      await expect(NODE_EXECUTORS.int(intNode({ value }), {}, context())).rejects.toThrow(
        `"${value}" isn't a whole number from -9007199254740991 to 9007199254740991`,
      );
    }
  });
});

describe("Load Image's Optional switch", () => {
  const imageNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "loadImage-1",
    type: "loadImage",
    position: { x: 0, y: 0 },
    config,
  });

  it("gives nothing at all with nothing picked, where an image left unpicked fails", async () => {
    expect(await NODE_EXECUTORS.loadImage(imageNode({ optional: "true" }), {}, context())).toEqual({});
    await expect(NODE_EXECUTORS.loadImage(imageNode({}), {}, context())).rejects.toThrow(
      'No image picked for node "loadImage-1"',
    );
  });

  it("still gives an image that is picked", async () => {
    const pickedImages = new Map([["loadImage-1", { mediaType: "image/png", data: PNG_BASE64, name: "a.png" }]]);
    const outputs = await NODE_EXECUTORS.loadImage(imageNode({ optional: "true" }), {}, context({ pickedImages }));
    expect(outputs.image).toEqual({ type: "image", mediaType: "image/png", data: PNG_BASE64 });
  });
});

// The file a Load node read, handed on from the root as a writer's `path`
// is, so a node wired from it names that file wherever the Flow sits.
describe("a Load node's path", () => {
  const loader = (type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    config,
  });
  const text = (value: string): PortValue => ({ type: "text", value });
  const inFilm = () => context({ flowPath: "film/picture.flow.html" });

  it("names a stored note from the root, a wired one as it resolved, and none as blank", async () => {
    sandboxRead.mockResolvedValue({ kind: "text", content: "# A" });
    const stored = loader("loadNote", { notePath: "scenes/a.md" });
    expect((await NODE_EXECUTORS.loadNote(stored, {}, inFilm())).path).toEqual(text("/film/scenes/a.md"));
    const wired = { path: text("../notes/b.md") };
    expect((await NODE_EXECUTORS.loadNote(stored, wired, inFilm())).path).toEqual(text("/notes/b.md"));
    expect((await NODE_EXECUTORS.loadNote(loader("loadNote"), {}, inFilm())).path).toEqual(text(""));
  });

  it("names a folder loader's pick, not its folder", async () => {
    sandboxRead.mockResolvedValue({ kind: "text", content: "# A" });
    const note = loader("loadFolderNote", { folderPath: "scenes/", notePath: "scenes/a.md" });
    expect((await NODE_EXECUTORS.loadFolderNote(note, {}, inFilm())).path).toEqual(text("/film/scenes/a.md"));
    sandboxRead.mockResolvedValue({ kind: "image", mediaType: "image/png", data: PNG_BASE64 });
    const image = loader("loadFolderImage", { folderPath: "art/", imagePath: "art/a.png" });
    expect((await NODE_EXECUTORS.loadFolderImage(image, {}, inFilm())).path).toEqual(text("/film/art/a.png"));
  });

  it("names a library image in its library, and an image picked from the computer as blank", async () => {
    const stored = loader("loadImage", { imagePath: "lib:footage/stills/sunset.png" });
    expect((await NODE_EXECUTORS.loadImage(stored, {}, context())).path).toEqual(text("lib:footage/stills/sunset.png"));
    const pickedImages = new Map([["loadImage-1", { mediaType: "image/png", data: PNG_BASE64, name: "a.png" }]]);
    expect((await NODE_EXECUTORS.loadImage(loader("loadImage"), {}, context({ pickedImages }))).path).toEqual(text(""));
  });

  it("names the Table its rows came from, and none before one is chosen", async () => {
    sandboxRead.mockResolvedValue({
      kind: "table",
      columns: [{ id: "c1", label: "Scene", type: "text" }],
      rows: [{ id: "r1", values: { c1: "One" } }],
    });
    for (const type of ["loadRow", "loadRandomRow", "loadTableRows"]) {
      const outputs = await NODE_EXECUTORS[type](loader(type, { tablePath: "shots/log.table.html" }), {}, inFilm());
      expect(outputs.path, type).toEqual(text("/film/shots/log.table.html"));
    }
    expect((await NODE_EXECUTORS.loadTableRows(loader("loadTableRows"), {}, inFilm())).path).toEqual(text(""));
  });
});

describe("Write Note", () => {
  const writeNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "writeNote-1",
    type: "writeNote",
    position: { x: 0, y: 0 },
    config,
  });
  const text = { text: { type: "text" as const, value: "# Log\n\nNew line.\n" } };

  it("writes its text over the note, behind writeDocument on that note, and passes the note on", async () => {
    const write = vi.fn(async () => undefined);
    const ensureCapability = vi.fn(async () => true);
    const sandbox = {
      read: sandboxRead,
      write,
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    };
    const outputs = await NODE_EXECUTORS.writeNote(
      writeNode({ notePath: "notes/log.md" }),
      text,
      context({ sandbox, ensureCapability }),
    );
    expect(outputs).toEqual({ path: { type: "text", value: "/notes/log.md" } });
    expect(ensureCapability).toHaveBeenCalledWith({ type: "writeDocument", path: "notes/log.md" });
    expect(write).toHaveBeenCalledWith("flow", "picture.flow.html", "notes/log.md", "# Log\n\nNew line.\n");
  });

  it("writes nothing on a denied grant", async () => {
    const write = vi.fn(async () => undefined);
    const sandbox = {
      read: sandboxRead,
      write,
      addRow: vi.fn(),
      addToNote: vi.fn(),
      generate: vi.fn(),
      generateOptions: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    };
    const denied = context({ sandbox, ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.writeNote(writeNode({ notePath: "notes/log.md" }), text, denied)).rejects.toThrow(
      'Permission denied to write "notes/log.md"',
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("fails, naming why, with no note, a file that isn't a note, or no text", async () => {
    await expect(NODE_EXECUTORS.writeNote(writeNode({}), text, context())).rejects.toThrow(
      "Drag the note to write into onto this node",
    );
    await expect(NODE_EXECUTORS.writeNote(writeNode({ notePath: "plan.table.html" }), text, context())).rejects.toThrow(
      '"plan.table.html" is no longer a markdown note',
    );
    await expect(NODE_EXECUTORS.writeNote(writeNode({ notePath: "notes/log.md" }), {}, context())).rejects.toThrow(
      "Write Note has no text connected",
    );
  });
});

describe("Write Folder Note", () => {
  const folderNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "writeFolderNote-1",
    type: "writeFolderNote",
    position: { x: 0, y: 0 },
    config,
  });
  const writing = (write = vi.fn(async () => undefined)) => ({
    read: sandboxRead,
    write,
    addRow: vi.fn(),
    addToNote: vi.fn(),
    generate: vi.fn(),
    generateOptions: vi.fn(),
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
  });
  const say = (value: string) => ({ type: "text" as const, value });

  it("writes its text as the named note in the folder, behind writeDocument on the folder, and passes it on", async () => {
    const write = vi.fn(async () => undefined);
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.writeFolderNote(
      folderNode({ folderPath: "shots/", name: "Tent" }),
      { text: say("# Shots\n") },
      context({ sandbox: writing(write), ensureCapability }),
    );
    expect(ensureCapability).toHaveBeenCalledWith({ type: "writeDocument", path: "shots/" });
    expect(write).toHaveBeenCalledWith("flow", "picture.flow.html", "space:shots/Tent.md", "# Shots\n");
    expect(outputs).toEqual({ path: say("/shots/Tent.md") });
  });

  it("asks a wired folder's grant as a wired one, and takes a wired name", async () => {
    const write = vi.fn(async () => undefined);
    const ensureCapability = vi.fn(async () => true);
    await NODE_EXECUTORS.writeFolderNote(
      folderNode({ name: "Unused" }),
      { path: say("/film/shots/"), name: say("Tent"), text: say("x") },
      context({ sandbox: writing(write), ensureCapability }),
    );
    expect(ensureCapability).toHaveBeenCalledWith({ type: "writeDocument", path: "space:film/shots", wired: true });
    expect(write).toHaveBeenCalledWith("flow", "picture.flow.html", "space:film/shots/Tent.md", "x");
  });

  it("repairs a name into one file name, so it stays in the folder, and adds .md once", async () => {
    const write = vi.fn(async () => undefined);
    for (const [name, written] of [
      ["Act 1/Tent", "space:shots/Act 1-Tent.md"],
      ["Tent.md", "space:shots/Tent.md"],
      ["../Tent", "space:shots/Tent.md"],
    ]) {
      await NODE_EXECUTORS.writeFolderNote(
        folderNode({ folderPath: "shots/" }),
        { name: say(name), text: say("x") },
        context({ sandbox: writing(write) }),
      );
      expect(write, name).toHaveBeenLastCalledWith("flow", "picture.flow.html", written, "x");
    }
  });

  it("fails, naming why, with no folder, no name, a name nothing is left of, no text, or a denied grant", async () => {
    const write = vi.fn(async () => undefined);
    const run = (config: Record<string, unknown>, inputs: Record<string, PortValue>, allowed = true) =>
      NODE_EXECUTORS.writeFolderNote(
        folderNode(config),
        inputs,
        context({ sandbox: writing(write), ensureCapability: vi.fn(async () => allowed) }),
      );
    await expect(run({ name: "Tent" }, { text: say("x") })).rejects.toThrow(
      "Drag the folder to write into onto this node",
    );
    await expect(run({ folderPath: "shots/" }, { text: say("x") })).rejects.toThrow(
      "Write Folder Note has no name for the note",
    );
    await expect(run({ folderPath: "shots/", name: "???" }, { text: say("x") })).rejects.toThrow(
      '"???" can\'t name a note',
    );
    await expect(run({ folderPath: "shots/", name: "Tent" }, {})).rejects.toThrow(
      "Write Folder Note has no text connected",
    );
    await expect(run({ folderPath: "shots/", name: "Tent" }, { text: say("x") }, false)).rejects.toThrow(
      'Permission denied to write in "shots/"',
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe("Add to Note", () => {
  const addNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "addToNote-1",
    type: "addToNote",
    position: { x: 0, y: 0 },
    config: { notePath: "notes/log.md", ...config },
  });
  const text = { text: { type: "text" as const, value: "- shipped" } };
  const sandboxWith = (addToNote: NodeExecutionContext["sandbox"]["addToNote"]) => ({
    ...context().sandbox,
    addToNote,
  });

  it("hands the host its text and where it goes, behind writeDocument on the note, and passes the note on", async () => {
    const addToNote = vi.fn(async () => undefined);
    const ensureCapability = vi.fn(async () => true);
    const outputs = await NODE_EXECUTORS.addToNote(
      addNode({ affixMode: "prepend" }),
      text,
      context({ sandbox: sandboxWith(addToNote), ensureCapability }),
    );
    expect(outputs).toEqual({ path: { type: "text", value: "/notes/log.md" } });
    expect(ensureCapability).toHaveBeenCalledWith({ type: "writeDocument", path: "notes/log.md" });
    expect(addToNote).toHaveBeenCalledWith("flow", "picture.flow.html", "notes/log.md", "- shipped", "prepend");
  });

  it("appends when its affixMode is blank or unknown", async () => {
    const addToNote = vi.fn(async (..._args: Parameters<NodeExecutionContext["sandbox"]["addToNote"]>) => undefined);
    await NODE_EXECUTORS.addToNote(addNode({}), text, context({ sandbox: sandboxWith(addToNote) }));
    await NODE_EXECUTORS.addToNote(addNode({ affixMode: "after" }), text, context({ sandbox: sandboxWith(addToNote) }));
    expect(addToNote.mock.calls.map((call) => call[4])).toEqual(["append", "append"]);
  });

  it("adds nothing on a denied grant", async () => {
    const addToNote = vi.fn(async () => undefined);
    const denied = context({ sandbox: sandboxWith(addToNote), ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.addToNote(addNode({}), text, denied)).rejects.toThrow(
      'Permission denied to write "notes/log.md"',
    );
    expect(addToNote).not.toHaveBeenCalled();
  });

  it("fails, naming why, with no note, a file that isn't a note, or no text", async () => {
    await expect(NODE_EXECUTORS.addToNote(addNode({ notePath: "" }), text, context())).rejects.toThrow(
      "Drag the note to write into onto this node",
    );
    await expect(NODE_EXECUTORS.addToNote(addNode({ notePath: "plan.table.html" }), text, context())).rejects.toThrow(
      '"plan.table.html" is no longer a markdown note',
    );
    await expect(NODE_EXECUTORS.addToNote(addNode({}), {}, context())).rejects.toThrow(
      "Add to Note has no text connected",
    );
  });
});

describe("Make Object", () => {
  const columns = [
    { id: "prompt", label: "Prompt", type: "text" },
    { id: "image", label: "Image", type: "media" },
    { id: "keep", label: "Keep", type: "checkbox" },
    { id: "width", label: "Width", type: "integer" },
    { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
    { id: "added", label: "Added", type: "timestamp", default: "now" },
  ];
  const objectNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "makeObject-1",
    type: "makeObject",
    position: { x: 0, y: 0 },
    config: { tablePath: "renders/log.table.html", columns, ...config },
  });

  // What the card holds only stands in for a wire; a column given neither is
  // left out, for the Table to fill in from itself when the row is added.
  it("takes a wired value over what the card holds, and leaves a column given neither out", async () => {
    const outputs = await NODE_EXECUTORS.makeObject(
      objectNode({ values: { prompt: "typed on the card", status: "Final", keep: "", width: "640" } }),
      {
        prompt: { type: "text", value: "a red door" },
        image: { type: "text", value: "renders/red-door-1a2b3c.png" },
        keep: { type: "boolean", value: true },
      },
      context(),
    );
    expect(outputs).toEqual({
      object: {
        type: "object",
        value: { prompt: "a red door", image: "renders/red-door-1a2b3c.png", keep: true, width: 640, status: "Final" },
      },
    });
  });

  it("fills the date placeholders in what the card holds, and reads nothing", async () => {
    const read = vi.fn();
    const outputs = await NODE_EXECUTORS.makeObject(
      objectNode({ values: { prompt: "Shot on {{$date:%Y}}", keep: "false" } }),
      {},
      context({ sandbox: { ...context().sandbox, read } }),
    );
    expect(outputs.object).toEqual({ type: "object", value: { prompt: "Shot on 2026", keep: false } });
    expect(read).not.toHaveBeenCalled();
  });

  it("fails on a number typed on the card that isn't a whole one", async () => {
    await expect(NODE_EXECUTORS.makeObject(objectNode({ values: { width: "wide" } }), {}, context())).rejects.toThrow(
      '"Width" isn\'t a whole number',
    );
  });
});

describe("Add Row", () => {
  const rowNode = (config: Record<string, unknown>): FlowNodeInstance => ({
    id: "addRow-1",
    type: "addRow",
    position: { x: 0, y: 0 },
    config: { tablePath: "renders/log.table.html", ...config },
  });
  const sandboxWith = (addRow: NodeExecutionContext["sandbox"]["addRow"]) => ({
    read: sandboxRead,
    write: vi.fn(),
    addRow,
    addToNote: vi.fn(),
    generate: vi.fn(),
    generateOptions: vi.fn(),
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
  });
  const row = (value: unknown) => ({ type: "object" as const, value });

  // Everything wired beats everything typed: a column's pin, then the row's
  // field, then what the card holds; a column given none is left out.
  it("fills a column from its pin, else the row's field, else what the card holds", async () => {
    const addRow = vi.fn(async () => ({ path: "renders/log.table.html" }));
    const columns = [
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "keep", label: "Keep", type: "checkbox" },
      { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
      { id: "day", label: "Day", type: "text" },
      { id: "note", label: "Note", type: "text" },
    ];
    await NODE_EXECUTORS.addRow(
      rowNode({ columns, values: { prompt: "typed", status: "Final", day: "{{$date}}" } }),
      {
        row: row({ prompt: "from the row", keep: false, status: "Draft" }),
        prompt: { type: "text", value: "from the pin" },
        keep: { type: "boolean", value: true },
      },
      context({ sandbox: sandboxWith(addRow) }),
    );
    expect(addRow).toHaveBeenCalledWith("flow", "picture.flow.html", "renders/log.table.html", {
      prompt: "from the pin",
      keep: "true",
      status: "Draft",
      day: "2026-11-09",
    });
  });

  it("sends each field of its row as cell text", async () => {
    const addRow = vi.fn(async () => ({ path: "renders/log.table.html" }));
    const ensureCapability = vi.fn(async () => true);
    const wrote = vi.fn();
    const outputs = await NODE_EXECUTORS.addRow(
      rowNode({}),
      { row: row({ prompt: "a red door", image: "renders/red-door-1a2b3c.png", keep: true, width: 1024, gone: null }) },
      context({ sandbox: sandboxWith(addRow), ensureCapability, wrote }),
    );
    expect(outputs).toEqual({ path: { type: "text", value: "/renders/log.table.html" } });
    expect(ensureCapability).toHaveBeenCalledWith({ type: "writeDocument", path: "renders/log.table.html" });
    expect(addRow).toHaveBeenCalledWith("flow", "picture.flow.html", "renders/log.table.html", {
      prompt: "a red door",
      image: "renders/red-door-1a2b3c.png",
      keep: "true",
      width: "1024",
    });
    expect(wrote).toHaveBeenCalledWith("renders/log.table.html");
  });

  // Read from the Flow's folder, handed on from the root, so it names the
  // Table wherever it is wired. With no row, every column takes a new row's.
  it("passes the Table on from the root, and adds a row of starting values with nothing wired", async () => {
    const addRow = vi.fn(async () => ({ path: "projects/shoot/log.table.html" }));
    const wrote = vi.fn();
    const outputs = await NODE_EXECUTORS.addRow(
      rowNode({ tablePath: "log.table.html" }),
      {},
      context({ sandbox: sandboxWith(addRow), wrote, flowPath: "projects/shoot/picture.flow.html" }),
    );
    expect(outputs).toEqual({ path: { type: "text", value: "/projects/shoot/log.table.html" } });
    expect(addRow).toHaveBeenCalledWith("flow", "projects/shoot/picture.flow.html", "log.table.html", {});
    expect(wrote).toHaveBeenCalledWith("projects/shoot/log.table.html");
  });

  it("adds nothing on a denied grant, or for a row no Table can hold", async () => {
    const addRow = vi.fn();
    const denied = context({ sandbox: sandboxWith(addRow), ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.addRow(rowNode({}), {}, denied)).rejects.toThrow(
      'Permission denied to write "renders/log.table.html"',
    );
    const granted = context({ sandbox: sandboxWith(addRow) });
    await expect(NODE_EXECUTORS.addRow(rowNode({}), { row: row({ tags: ["a"] }) }, granted)).rejects.toThrow(
      'Field "tags" is a list, not a single value',
    );
    expect(addRow).not.toHaveBeenCalled();
  });

  it("fails, naming why, with no Table or a file that isn't one", async () => {
    await expect(NODE_EXECUTORS.addRow(rowNode({ tablePath: "" }), {}, context())).rejects.toThrow(
      "Drag the Table to add rows to onto this node",
    );
    await expect(NODE_EXECUTORS.addRow(rowNode({ tablePath: "notes/log.md" }), {}, context())).rejects.toThrow(
      '"notes/log.md" is no longer a table',
    );
  });
});

describe("the Generate Image node", () => {
  const imageNode = (config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: "gen-1",
    type: "generateImage",
    position: { x: 0, y: 0 },
    config: { outputFolderPath: "art", ...config },
  });
  const prompt = { prompt: { type: "text" as const, value: "a lighthouse" } };
  const answer = {
    image: { mediaType: "image/png", data: PNG_BASE64 },
    path: "art/shot-12-0123456789ab.png",
    model: "higgsfield/soul_2",
    take: 1,
    reused: false,
    warnings: ["aspect_ratio: asked for 16:10, used 3:2"],
    notes: ["quality: used 2k (default for model)"],
    cost: { amount: 0.12, unit: "credits" },
  };

  it("asks for its folder, sends the prompt, references, model, ratio and seed, and reports", async () => {
    const generateImage = vi.fn(async () => answer);
    const ensureCapability = vi.fn(async () => true);
    const report = vi.fn();
    const spent = vi.fn();
    const outputs = await NODE_EXECUTORS.generateImage(
      imageNode({ model: "higgsfield/soul_2", aspect_ratio: "16:10", seed: "7", prefix: "typed" }),
      {
        ...prompt,
        image_2: { type: "image", mediaType: "image/png", data: PNG_BASE64 },
        prefix: { type: "text", value: " shot-12 " },
      },
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage,
          generateVideo: vi.fn(),
        },
        ensureCapability,
        report,
        spent,
      }),
    );

    expect(ensureCapability).toHaveBeenCalledWith({ type: "generateImage", path: "art" });
    expect(generateImage).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      {
        folder: "art",
        prompt: "a lighthouse",
        references: [{ pin: 2, mediaType: "image/png", data: PNG_BASE64 }],
        model: "higgsfield/soul_2",
        aspectRatio: "16:10",
        seed: "7",
        // A wired prefix wins over the widget's, as on every widget input.
        prefix: "shot-12",
      },
      undefined,
    );
    expect(outputs).toEqual({
      image: { type: "image", mediaType: "image/png", data: PNG_BASE64 },
      path: { type: "text", value: `/${answer.path}` },
      file_name: { type: "text", value: "shot-12-0123456789ab" },
    });
    // The card shows what changed of what it sent; the record keeps every note.
    expect(report).toHaveBeenCalledWith("gen-1", ["Spent 0.12 credits.", "aspect_ratio: asked for 16:10, used 3:2"]);
    expect(spent).toHaveBeenCalledWith("gen-1", {
      media: "image",
      model: "higgsfield/soul_2",
      path: answer.path,
      reused: false,
      cost: { amount: 0.12, unit: "credits" },
      notes: ["aspect_ratio: asked for 16:10, used 3:2", "quality: used 2k (default for model)"],
    });
  });

  // The host matches a result already made against the prefix as typed, so
  // the run sends it filled and as typed.
  it("sends a typed prefix filled and as typed", async () => {
    const generateImage = vi.fn(async () => answer);
    await NODE_EXECUTORS.generateImage(
      imageNode({ prefix: "shot_{{$date:%y%m%d}}" }),
      prompt,
      context({ sandbox: { ...context().sandbox, generateImage } }),
    );
    expect(generateImage).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({ prefix: "shot_261109", prefixTyped: "shot_{{$date:%y%m%d}}" }),
      undefined,
    );
  });

  it("sends the take it holds, and on Regenerate asks for a new take and hands back the one it got", async () => {
    const generateImage = vi.fn(async (..._args: unknown[]) => ({ ...answer, take: 4 }));
    const madeTake = vi.fn();
    const sandbox = { ...context().sandbox, generateImage };
    await NODE_EXECUTORS.generateImage(imageNode({ take: "2" }), prompt, context({ sandbox, madeTake }));
    expect(generateImage.mock.lastCall?.[2]).toMatchObject({ take: "2" });
    expect(generateImage.mock.lastCall?.[2]).not.toHaveProperty("newTake");
    expect(madeTake).not.toHaveBeenCalled();

    await NODE_EXECUTORS.generateImage(
      imageNode({ take: "2" }),
      prompt,
      context({ sandbox, madeTake, regenerating: "gen-1" }),
    );
    expect(generateImage.mock.lastCall?.[2]).toMatchObject({ newTake: true });
    expect(generateImage.mock.lastCall?.[2]).not.toHaveProperty("take");
    expect(madeTake).toHaveBeenCalledWith("gen-1", 4);
  });

  it("fails a take that isn't a whole number before asking for its folder", async () => {
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.generateImage(imageNode({ take: "two" }), prompt, context({ ensureCapability })),
    ).rejects.toThrow('Take "two" isn\'t a whole number, such as 2');
    expect(ensureCapability).not.toHaveBeenCalled();
  });

  it("says when a result was found again rather than generated", async () => {
    const report = vi.fn();
    const generateImage = vi.fn(async () => ({ ...answer, reused: true, warnings: [], cost: undefined }));
    await NODE_EXECUTORS.generateImage(
      imageNode(),
      prompt,
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage,
          generateVideo: vi.fn(),
        },
        report,
      }),
    );
    expect(report).toHaveBeenCalledWith("gen-1", [`Reused ${answer.path}: these inputs were generated before.`]);
  });

  it("sends the prompt as typed, with each reference's pin, for the host to spell", async () => {
    const generateImage = vi.fn(async () => answer);
    const face = { type: "image" as const, mediaType: "image/png", data: PNG_BASE64 };
    const outfit = { type: "image" as const, mediaType: "image/jpeg", data: PNG_BASE64 };
    await NODE_EXECUTORS.generateImage(
      imageNode(),
      {
        prompt: { type: "text", value: "The face from @image_2 on the outfit from @image_14, not @image_31." },
        image_2: face,
        image_14: outfit,
      },
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage,
          generateVideo: vi.fn(),
        },
      }),
    );
    expect(generateImage).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({
        prompt: "The face from @image_2 on the outfit from @image_14, not @image_31.",
        references: [
          { pin: 2, mediaType: "image/png", data: PNG_BASE64 },
          { pin: 14, mediaType: "image/jpeg", data: PNG_BASE64 },
        ],
      }),
      undefined,
    );
  });

  it("refuses a mention of an empty image port before asking for the grant", async () => {
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.generateImage(
        imageNode(),
        {
          prompt: { type: "text", value: "Light it like @image_3" },
          image_1: { type: "image", mediaType: "image/png", data: PNG_BASE64 },
        },
        context({ ensureCapability }),
      ),
    ).rejects.toThrow("The prompt names @image_3, but no image is connected to image_3");
    expect(ensureCapability).not.toHaveBeenCalled();
  });

  it("takes a decimal ratio, as Load Image writes one", async () => {
    const generateImage = vi.fn(async () => answer);
    await NODE_EXECUTORS.generateImage(
      imageNode(),
      { ...prompt, aspect_ratio: { type: "text", value: "1.85:1" } },
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate: vi.fn(),
          generateOptions: vi.fn(),
          generateImage,
          generateVideo: vi.fn(),
        },
      }),
    );
    expect(generateImage).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({ aspectRatio: "1.85:1" }),
      undefined,
    );
  });

  it("writes a price as a person reads it", () => {
    expect(describeCost({ amount: 0.12, unit: "credits" })).toBe("0.12 credits");
    expect(describeCost({ amount: 0.1 + 0.2, unit: "credits" })).toBe("0.3 credits");
    expect(describeCost({ amount: 1, unit: "credits" })).toBe("1 credit");
    const image = { media: "image" as const, model: "h/soul_2", path: "art/a.png" };
    expect(describeSpend({ ...image, reused: false, cost: answer.cost })).toBe("Spent 0.12 credits · art/a.png");
    expect(describeSpend({ ...image, reused: true })).toBe("Reused, nothing spent · art/a.png");
    // A video's price is the quote asked before its job.
    const clip = { media: "video" as const, model: "h/seedance1_5", path: "clips/a.mp4", reused: false };
    expect(describeSpend({ ...clip, cost: { amount: 2.4, unit: "credits" } })).toBe("Quoted 2.4 credits · clips/a.mp4");
    expect(spendEntry({ ...clip, cost: { amount: 2.4, unit: "credits" } })).toEqual([
      "VIDEO",
      "Generate Video · h/seedance1_5",
      "Quoted 2.4 credits · clips/a.mp4",
    ]);
    // Every note goes under the price, the ones its card leaves out too.
    const notes = ["duration: asked for 7, used 8 (nearest)", "mode: used omni_reference (a frame came)"];
    expect(spendEntry({ ...clip, cost: { amount: 15, unit: "credits" }, notes })[2]).toBe(
      ["Quoted 15 credits · clips/a.mp4", ...notes].join("\n"),
    );
    expect(spendEntry({ ...image, reused: true })[0]).toBe("IMAGE");
  });

  it("refuses to run without its folder, a prompt, a readable ratio, or the grant", async () => {
    await expect(NODE_EXECUTORS.generateImage(imageNode({ outputFolderPath: "" }), prompt, context())).rejects.toThrow(
      "Drag the folder for results onto this node",
    );
    await expect(NODE_EXECUTORS.generateImage(imageNode(), {}, context())).rejects.toThrow("no prompt connected");
    await expect(NODE_EXECUTORS.generateImage(imageNode({ aspect_ratio: "wide" }), prompt, context())).rejects.toThrow(
      "isn't width:height",
    );
    await expect(
      NODE_EXECUTORS.generateImage(imageNode(), prompt, context({ ensureCapability: vi.fn(async () => false) })),
    ).rejects.toThrow('Permission denied to generate images into "art"');
  });
});

describe("the Generate Text node's images", () => {
  const textNode: FlowNodeInstance = { id: "text-1", type: "generateText", position: { x: 0, y: 0 }, config: {} };
  const picture = { type: "image" as const, mediaType: "image/png", data: PNG_BASE64 };

  it("sends each wired image under its pin's id, past the fifth too", async () => {
    const generate = vi.fn(async () => ({ reply: "Similar.", model: "m" }));
    await NODE_EXECUTORS.generateText(
      textNode,
      { prompt: { type: "text", value: "Compare @image_2 with @image_12" }, image_2: picture, image_12: picture },
      context({
        sandbox: {
          read: sandboxRead,
          write: vi.fn(),
          addRow: vi.fn(),
          addToNote: vi.fn(),
          generate,
          generateOptions: vi.fn(),
          generateImage: vi.fn(),
          generateVideo: vi.fn(),
        },
      }),
    );
    expect(generate).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({
        instruction: "Compare @image_2 with @image_12",
        images: {
          image_2: { mediaType: "image/png", data: PNG_BASE64 },
          image_12: { mediaType: "image/png", data: PNG_BASE64 },
        },
      }),
      undefined,
    );
  });

  it("refuses a prompt naming an empty pin before asking for the grant", async () => {
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.generateText(
        textNode,
        { prompt: { type: "text", value: "Describe @image_3" }, image_1: picture },
        context({ ensureCapability }),
      ),
    ).rejects.toThrow("The prompt names @image_3, but no image is connected to image_3");
    expect(ensureCapability).not.toHaveBeenCalled();
  });
});

// One record of each settled call, for the Console and the run's surface.
describe("a text generation as it settles", () => {
  const textNode: FlowNodeInstance = { id: "text-1", type: "generateText", position: { x: 0, y: 0 }, config: {} };
  const prompt = { prompt: { type: "text" as const, value: "Name a kite." } };
  const withGenerate = (generate: NodeExecutionContext["sandbox"]["generate"]) => ({
    read: sandboxRead,
    write: vi.fn(),
    addRow: vi.fn(),
    addToNote: vi.fn(),
    generate,
    generateOptions: vi.fn(),
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
  });

  it("hands on the host's answer, the indicator lit around the call alone", async () => {
    const generated = vi.fn();
    const run = context({ generated, sandbox: withGenerate(vi.fn(async () => ({ reply: "Hawk", model: "m" }))) });
    vi.mocked(run.beginLlmActivity).mockImplementation(() => expect(generated).not.toHaveBeenCalled());
    await NODE_EXECUTORS.generateText(textNode, prompt, run);
    expect(generated).toHaveBeenCalledWith("text-1", { failed: false, result: { reply: "Hawk", model: "m" } });
    expect(run.beginLlmActivity).toHaveBeenCalledTimes(1);
    expect(run.endLlmActivity).toHaveBeenCalledTimes(1);
  });

  it("hands on what a failed call failed with, and still fails the node", async () => {
    const generated = vi.fn();
    const refused = new Error("The model refused.");
    const run = context({ generated, sandbox: withGenerate(vi.fn(async () => Promise.reject(refused))) });
    await expect(NODE_EXECUTORS.generateText(textNode, prompt, run)).rejects.toBe(refused);
    expect(generated).toHaveBeenCalledWith("text-1", { failed: true, error: refused });
    expect(run.endLlmActivity).toHaveBeenCalledTimes(1);
  });

  it("sends the effort its config names, and none at the model's default", async () => {
    const generate = vi.fn(async (_kind: string, _path: string, _body: { effort?: string }) => ({
      reply: "Hawk",
      model: "m",
    }));
    const run = context({ sandbox: withGenerate(generate) });
    await NODE_EXECUTORS.generateText({ ...textNode, config: { effort: "high" } }, prompt, run);
    await NODE_EXECUTORS.generateText(textNode, prompt, run);
    expect(generate.mock.calls[0][2]).toMatchObject({ effort: "high" });
    expect(generate.mock.calls[1][2]).not.toHaveProperty("effort");
  });

  it("hands on nothing of a call the run stopped", async () => {
    const generated = vi.fn();
    const stop = new AbortController();
    const generate = vi.fn(async () => {
      stop.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const run = context({ generated, signal: stop.signal, sandbox: withGenerate(generate) });
    await expect(NODE_EXECUTORS.generateText(textNode, prompt, run)).rejects.toThrow("aborted");
    expect(generated).not.toHaveBeenCalled();
  });
});

describe("the Generate Video node", () => {
  const videoNode = (config: Record<string, unknown> = {}): FlowNodeInstance => ({
    id: "clip-1",
    type: "generateVideo",
    position: { x: 0, y: 0 },
    config: { outputFolderPath: "clips", ...config },
  });
  const prompt = { prompt: { type: "text" as const, value: "steam rises from the cup" } };
  const frame = { type: "image" as const, mediaType: "image/png", data: PNG_BASE64 };
  const answer = {
    path: "clips/shot-12-0123456789ab.mp4",
    model: "higgsfield/seedance1_5",
    take: 1,
    reused: false,
    resumed: false,
    warnings: ["aspect_ratio: asked for 21:9, used 16:9 (closest supported aspect ratio)"],
    quote: { amount: 2.4, unit: "credits" },
  };
  const sandbox = (generateVideo: NodeExecutionContext["sandbox"]["generateVideo"]) => ({
    read: vi.fn(),
    write: vi.fn(),
    addRow: vi.fn(),
    addToNote: vi.fn(),
    generate: vi.fn(),
    generateOptions: vi.fn(),
    generateImage: vi.fn(),
    generateVideo,
  });

  it("asks for its folder, sends the prompt, frames, model, ratio, resolution, duration and take, and reports", async () => {
    const generateVideo = vi.fn(async () => answer);
    const ensureCapability = vi.fn(async () => true);
    const report = vi.fn();
    const spent = vi.fn();
    const outputs = await NODE_EXECUTORS.generateVideo(
      videoNode({
        model: "higgsfield/seedance1_5",
        aspect_ratio: "21:9",
        resolution: "1080p",
        duration: "4",
        take: "3",
        prefix: "shot-12",
      }),
      { ...prompt, start_frame: frame, end_frame: { ...frame, mediaType: "image/jpeg" } },
      context({ sandbox: sandbox(generateVideo), ensureCapability, report, spent }),
    );

    expect(ensureCapability).toHaveBeenCalledWith({ type: "generateVideo", path: "clips" });
    expect(generateVideo).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      {
        folder: "clips",
        prompt: "steam rises from the cup",
        startFrame: { mediaType: "image/png", data: PNG_BASE64 },
        endFrame: { mediaType: "image/jpeg", data: PNG_BASE64 },
        model: "higgsfield/seedance1_5",
        aspectRatio: "21:9",
        resolution: "1080p",
        duration: "4",
        take: "3",
        prefix: "shot-12",
        prefixTyped: "shot-12",
      },
      undefined,
    );
    // No port carries video: the clip leaves by its path, and its name.
    expect(outputs).toEqual({
      path: { type: "text", value: `/${answer.path}` },
      file_name: { type: "text", value: "shot-12-0123456789ab" },
    });
    expect(report).toHaveBeenCalledWith("clip-1", ["Quoted 2.4 credits.", answer.warnings[0]]);
    expect(spent).toHaveBeenCalledWith("clip-1", {
      media: "video",
      model: "higgsfield/seedance1_5",
      path: answer.path,
      reused: false,
      cost: { amount: 2.4, unit: "credits" },
      notes: answer.warnings,
    });
  });

  it("sends its reference images with their pins, and the prompt as typed", async () => {
    const generateVideo = vi.fn(async () => answer);
    await NODE_EXECUTORS.generateVideo(
      videoNode(),
      { prompt: { type: "text", value: "@image_3 walks past @image_1" }, image_1: frame, image_3: frame },
      context({ sandbox: sandbox(generateVideo) }),
    );
    expect(generateVideo).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({
        prompt: "@image_3 walks past @image_1",
        references: [
          { pin: 1, mediaType: "image/png", data: PNG_BASE64 },
          { pin: 3, mediaType: "image/png", data: PNG_BASE64 },
        ],
      }),
      undefined,
    );
  });

  it("refuses frames beside references, and a mention of an empty pin, before asking for the grant", async () => {
    const ensureCapability = vi.fn(async () => true);
    const run = (inputs: Record<string, PortValue>) =>
      NODE_EXECUTORS.generateVideo(videoNode(), { ...prompt, ...inputs }, context({ ensureCapability }));
    await expect(run({ start_frame: frame, image_1: frame })).rejects.toThrow(
      "Generate Video sends frames or references, not both",
    );
    await expect(run({ prompt: { type: "text", value: "@image_2 at dawn" }, image_1: frame })).rejects.toThrow(
      "The prompt names @image_2, but no image is connected to image_2",
    );
    expect(ensureCapability).not.toHaveBeenCalled();
  });

  it("sends no frame it wasn't given, and says when it collected a clip an earlier run started", async () => {
    const report = vi.fn();
    const generateVideo = vi.fn(async () => ({ ...answer, resumed: true, warnings: [] }));
    await NODE_EXECUTORS.generateVideo(videoNode(), prompt, context({ sandbox: sandbox(generateVideo), report }));
    expect(generateVideo).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({ startFrame: undefined, endFrame: undefined, take: undefined }),
      undefined,
    );
    expect(report).toHaveBeenCalledWith("clip-1", [
      "Collected the clip an earlier run started.",
      "Quoted 2.4 credits.",
    ]);
  });

  it("asks for a new take on Regenerate, whatever take it holds, and hands back the one it got", async () => {
    const generateVideo = vi.fn(async (..._args: unknown[]) => ({ ...answer, take: 7 }));
    const madeTake = vi.fn();
    await NODE_EXECUTORS.generateVideo(
      videoNode({ take: "not a take" }),
      prompt,
      context({ sandbox: sandbox(generateVideo), madeTake, regenerating: "clip-1" }),
    );
    expect(generateVideo.mock.lastCall?.[2]).toMatchObject({ newTake: true });
    expect(generateVideo.mock.lastCall?.[2]).not.toHaveProperty("take");
    expect(madeTake).toHaveBeenCalledWith("clip-1", 7);
  });

  it("sends the node's model settings, and none when it keeps none", async () => {
    const generateVideo = vi.fn(async () => ({ ...answer, warnings: [] }));
    const run = (config: Record<string, unknown>) =>
      NODE_EXECUTORS.generateVideo(videoNode(config), prompt, context({ sandbox: sandbox(generateVideo) }));
    await run({ modelSettings: { mode: "pro", generate_audio: false, cfg_scale: 0.5, junk: { deep: 1 } } });
    await run({});
    const sent = (generateVideo.mock.calls as unknown as Array<[string, string, GenerateVideoRequestBody]>).map(
      ([, , request]) => request,
    );
    expect(sent[0].modelSettings).toEqual({ mode: "pro", generate_audio: false, cfg_scale: 0.5 });
    expect(sent[1]).not.toHaveProperty("modelSettings");
  });

  it("refuses a picked mode its inputs can't take, before asking for anything", async () => {
    const generateVideo = vi.fn(async () => ({ ...answer, warnings: [] }));
    const ensureCapability = vi.fn(async () => true);
    await expect(
      NODE_EXECUTORS.generateVideo(
        videoNode({ modelSettings: { mode: "video_edit" } }),
        prompt,
        context({ sandbox: sandbox(generateVideo), ensureCapability }),
      ),
    ).rejects.toThrow('Mode "video_edit" needs a clip on a video reference');
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(generateVideo).not.toHaveBeenCalled();
  });

  // A blank was the model's own default before these selects lost it.
  it("reads a blank setting, saved or wired, as its preset", async () => {
    const generateVideo = vi.fn(async () => ({ ...answer, warnings: [] }));
    const blank = { type: "text" as const, value: "" };
    await NODE_EXECUTORS.generateVideo(
      videoNode({ aspect_ratio: "", resolution: "" }),
      { ...prompt, duration: blank },
      context({ sandbox: sandbox(generateVideo) }),
    );
    expect(generateVideo).toHaveBeenCalledWith(
      "flow",
      "picture.flow.html",
      expect.objectContaining({ aspectRatio: "1:1", resolution: "480p", duration: "3" }),
      undefined,
    );
  });

  it("says when a clip was found again rather than generated", async () => {
    const report = vi.fn();
    const generateVideo = vi.fn(async () => ({ ...answer, reused: true, warnings: [], quote: undefined }));
    await NODE_EXECUTORS.generateVideo(videoNode(), prompt, context({ sandbox: sandbox(generateVideo), report }));
    expect(report).toHaveBeenCalledWith("clip-1", [`Reused ${answer.path}: these inputs were generated before.`]);
  });

  it("refuses to run without its folder, a prompt, a readable ratio, resolution, duration or take, or the grant", async () => {
    const run = (node: FlowNodeInstance, overrides: Partial<NodeExecutionContext> = {}) =>
      NODE_EXECUTORS.generateVideo(
        node,
        prompt,
        context({ sandbox: sandbox(vi.fn(async () => answer)), ...overrides }),
      );
    await expect(run(videoNode({ outputFolderPath: "" }))).rejects.toThrow(
      "Drag the folder for results onto this node",
    );
    await expect(NODE_EXECUTORS.generateVideo(videoNode(), {}, context())).rejects.toThrow(
      "Generate Video has no prompt connected",
    );
    await expect(run(videoNode({ aspect_ratio: "wide" }))).rejects.toThrow('Aspect ratio "wide" isn\'t width:height');
    await expect(run(videoNode({ resolution: "HD" }))).rejects.toThrow(
      'Resolution "HD" isn\'t a video size, such as 720p',
    );
    await expect(run(videoNode({ duration: "4.5" }))).rejects.toThrow(
      'Duration "4.5" isn\'t a whole number of seconds, such as 5',
    );
    await expect(run(videoNode({ take: "0" }))).rejects.toThrow('Take "0" isn\'t a whole number, such as 2');
    await expect(run(videoNode(), { ensureCapability: async () => false })).rejects.toThrow(
      'Permission denied to generate videos into "clips"',
    );
  });
});

// context()'s clock: Monday 2026-11-09, 14:30:05, an hour east of UTC.
const textOf = (value: string) => ({ type: "text" as const, value });
const nodeOf = (type: string, config: Record<string, unknown>): FlowNodeInstance => ({
  id: `${type}-1`,
  type,
  position: { x: 0, y: 0 },
  config,
});

describe("dates in typed text", () => {
  it("fills a Prompt's text and a text box's, from the run's one reading", async () => {
    expect(
      await NODE_EXECUTORS.prompt(nodeOf("prompt", { text: "Log {{$date}} at {{$date:%H:%M}}" }), {}, context()),
    ).toEqual({
      text: textOf("Log 2026-11-09 at 14:30"),
    });
    const join = nodeOf("joinText", {
      text_1: "{{$date:%A}}",
      text_2: "day {{$date:%-d}}",
      text_3: "{{$Date}}",
      separator: ", ",
    });
    expect(await NODE_EXECUTORS.joinText(join, {}, context())).toEqual({ text: textOf("Monday, day 9, 2026-11-09") });
  });

  it("uses a wired value as it arrives", async () => {
    const join = nodeOf("joinText", { text_1: "{{$date}}", text_2: "", text_3: "", separator: "" });
    expect(await NODE_EXECUTORS.joinText(join, { text_1: textOf("{{$date}}") }, context())).toEqual({
      text: textOf("{{$date}}"),
    });
  });

  it("fills a Generate node's typed prefix, never a wired one", async () => {
    const generateImage = vi.fn(async (..._args: unknown[]) => ({
      image: { mediaType: "image/png", data: PNG_BASE64 },
      path: "art/x.png",
      model: "m",
      take: 1,
      reused: false,
      warnings: [],
    }));
    const run = (inputs: Record<string, ReturnType<typeof textOf>>) =>
      NODE_EXECUTORS.generateImage(
        nodeOf("generateImage", { outputFolderPath: "art", prefix: "{{$date}}_hero" }),
        { prompt: textOf("a lighthouse"), ...inputs },
        context({ sandbox: { ...context().sandbox, generateImage } }),
      );
    await run({});
    expect(generateImage.mock.lastCall?.[2]).toMatchObject({ prefix: "2026-11-09_hero" });
    await run({ prefix: textOf("{{$date}}_wired") });
    expect(generateImage.mock.lastCall?.[2]).toMatchObject({ prefix: "{{$date}}_wired" });
  });

  it("fills a Choice's pick after checking it against the options", async () => {
    const choice = nodeOf("choice", { options: "Wide\nShot on {{$date:%b %-d}}", text: "Shot on {{$date:%b %-d}}" });
    expect(await NODE_EXECUTORS.choice(choice, {}, context())).toEqual({ text: textOf("Shot on Nov 9") });
  });

  it("fills Make Object's typed values, never a wired one", async () => {
    const columns = [
      { id: "day", label: "Day", type: "text" },
      { id: "note", label: "Note", type: "text" },
    ];
    const outputs = await NODE_EXECUTORS.makeObject(
      nodeOf("makeObject", { tablePath: "log.table.html", columns, values: { day: "{{$date}}", note: "typed" } }),
      { note: textOf("{{$date}}") },
      context(),
    );
    expect(outputs.object).toEqual({ type: "object", value: { day: "2026-11-09", note: "{{$date}}" } });
  });
});

describe("Template Variables", () => {
  const slots = (...names: string[]) =>
    nodeOf("templateVariables", Object.fromEntries(names.map((name, i) => [`var${i + 1}Name`, name])));

  // A value a slot puts in is never read for placeholders, whichever slot
  // comes first, and a placeholder no slot or date fills stays as written.
  it("fills slots and dates in one pass", async () => {
    const outputs = await NODE_EXECUTORS.templateVariables(
      slots("a", "b"),
      {
        source: textOf("{{a}} / {{b}} / {{$date:%G-W%V}} / {{missing}}"),
        var_1: textOf("has {{b}} and {{$date}}"),
        var_2: textOf("B"),
      },
      context(),
    );
    expect(outputs).toEqual({ text: textOf("has {{b}} and {{$date}} / B / 2026-W46 / {{missing}}") });
  });

  it("keeps a slot's names apart from the host's: one named date fills {{date}}, never {{$date}}", async () => {
    const outputs = await NODE_EXECUTORS.templateVariables(
      slots("date"),
      { source: textOf("{{date}} vs {{$date}} vs {{$date:%Y}}"), var_1: textOf("yesterday") },
      context(),
    );
    expect(outputs).toEqual({ text: textOf("yesterday vs 2026-11-09 vs 2026") });
  });

  it("gives no slot a name a placeholder marks with $", async () => {
    const outputs = await NODE_EXECUTORS.templateVariables(
      slots("$date"),
      { source: textOf("{{$date}}"), var_1: textOf("taken") },
      context(),
    );
    expect(outputs).toEqual({ text: textOf("2026-11-09") });
  });
});

describe("Number to Text", () => {
  const run = (value: number, digits?: string) =>
    NODE_EXECUTORS.numberToText(
      nodeOf("numberToText", digits === undefined ? {} : { digits }),
      { number: { type: "number", value } },
      context(),
    );

  it("writes the number, a whole one padded with zeros to its digits, the sign in front", async () => {
    expect(await run(7)).toEqual({ text: textOf("7") });
    expect(await run(7, "3")).toEqual({ text: textOf("007") });
    expect(await run(-7, "3")).toEqual({ text: textOf("-007") });
    expect(await run(12345, "3")).toEqual({ text: textOf("12345") });
    expect(await run(1.5, "3")).toEqual({ text: textOf("1.5") });
  });

  it("pads nothing for digits outside 1 to 20, and fails with no number", async () => {
    for (const digits of ["", "0", "21", "two", "-3"]) expect(await run(7, digits)).toEqual({ text: textOf("7") });
    await expect(NODE_EXECUTORS.numberToText(nodeOf("numberToText", { digits: "3" }), {}, context())).rejects.toThrow(
      "Number to Text has no number connected",
    );
  });
});

describe("describeContextSent", () => {
  it("lists what went, then what the model searched for, then each message in the order it came", () => {
    const lines = describeContextSent({
      path: "/story/scene.fountain",
      files: ["/story/AGENTS.md", "/story/notes/arc.md"],
      searches: ["Lina", "the cave"],
      messages: [
        { level: "warn", text: "Left out /story/secret.md: it's private." },
        { level: "info", text: "Cut /story/notes/arc.md to its first 8,000 characters." },
        { level: "warn", text: "Stopped looking after 60 seconds." },
      ],
    });
    expect(lines).toEqual([
      "Sent as context:",
      "/story/AGENTS.md",
      "/story/notes/arc.md",
      'Searched for "Lina", "the cave".',
      "Left out /story/secret.md: it's private.",
      "Cut /story/notes/arc.md to its first 8,000 characters.",
      "Stopped looking after 60 seconds.",
    ]);
  });

  it("says when nothing went, with no search line when there was none", () => {
    expect(describeContextSent({ path: "/top.md", files: [], searches: [], messages: [] })).toEqual([
      "Nothing around /top.md to send as context.",
    ]);
  });
});
