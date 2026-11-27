import { describe, expect, it, vi } from "vitest";
import type { GenerateOptionsRequestBody, GenerateRequestBody } from "../../src/protocol/api.ts";
import { NODE_EXECUTORS, type NodeExecutionContext, type PortValue } from "../../src/protocol/flowExecutors.ts";
import {
  FLOW_NODE_REGISTRY,
  flowPermissionRows,
  nodePorts,
  wiredCapability,
  wiredCapabilityOfKey,
  wiredPathAccess,
} from "../../src/protocol/flowNodes.ts";
import type { FlowCapabilityDeclaration, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";

// A path on a wire is read as a link is, from the Flow's folder, and asked
// for as the file it names: the executors resolve it, the host grants it.

const sandboxRead = vi.fn();
const sandboxWrite = vi.fn();
const sandboxAddRow = vi.fn();
const sandboxAddToNote = vi.fn();

function context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    flowPath: "tools/lyrics.flow.html",
    sandbox: {
      read: sandboxRead,
      write: sandboxWrite,
      addRow: sandboxAddRow,
      addToNote: sandboxAddToNote,
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

function node(type: string, config: Record<string, unknown> = {}): FlowNodeInstance {
  return { id: `${type}-1`, type, position: { x: 0, y: 0 }, config };
}

const text = (value: string): PortValue => ({ type: "text", value });

function asked(ensureCapability: ReturnType<typeof vi.fn>): FlowCapabilityDeclaration[] {
  return ensureCapability.mock.calls.map((call) => call[0]);
}

describe("a path wired into a loader", () => {
  it("reads from the Flow's folder, and asks for the file by its address, marked as wired", async () => {
    sandboxRead.mockResolvedValue({ kind: "text", content: "Hello" });
    const ensureCapability = vi.fn(async () => true);

    await NODE_EXECUTORS.loadNote(
      node("loadNote"),
      { path: text("../world/places.md") },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "readFile", path: "space:world/places.md", wired: true }]);
    expect(sandboxRead).toHaveBeenCalledWith("flow", "tools/lyrics.flow.html", "space:world/places.md");
  });

  it("wins over the path the node holds from a drag", async () => {
    sandboxRead.mockResolvedValue({ kind: "text", content: "Hello" });
    const ensureCapability = vi.fn(async () => true);

    await NODE_EXECUTORS.loadNote(
      node("loadNote", { notePath: "space:notes/dragged.md" }),
      { path: text("beside.md") },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "readFile", path: "space:tools/beside.md", wired: true }]);
  });

  it("asks exactly as before when nothing is wired", async () => {
    sandboxRead.mockResolvedValue({ kind: "text", content: "Hello" });
    const ensureCapability = vi.fn(async () => true);

    await NODE_EXECUTORS.loadNote(
      node("loadNote", { notePath: "space:notes/dragged.md" }),
      {},
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "readFile", path: "space:notes/dragged.md" }]);
    expect(sandboxRead).toHaveBeenCalledWith("flow", "tools/lyrics.flow.html", "space:notes/dragged.md");
  });

  it("takes a connected empty path for no path, not for the dragged one", async () => {
    const ensureCapability = vi.fn(async () => true);

    const outputs = await NODE_EXECUTORS.loadNote(
      node("loadNote", { notePath: "space:notes/dragged.md" }),
      { path: text("  ") },
      context({ ensureCapability }),
    );

    expect(outputs.raw).toEqual(text(""));
    expect(ensureCapability).not.toHaveBeenCalled();
  });

  it("does not read when the grant is refused", async () => {
    sandboxRead.mockClear();
    const refuse = context({ ensureCapability: vi.fn(async () => false) });
    await expect(NODE_EXECUTORS.loadNote(node("loadNote"), { path: text("a.md") }, refuse)).rejects.toThrow(
      /Permission denied to read "space:tools\/a\.md"/,
    );
    expect(sandboxRead).not.toHaveBeenCalled();
  });

  it("refuses a path that leads nowhere, before asking for anything", async () => {
    const ensureCapability = vi.fn(async () => true);
    const run = (path: string) =>
      NODE_EXECUTORS.loadNote(node("loadNote"), { path: text(path) }, context({ ensureCapability }));

    await expect(run("foo:bar.md")).rejects.toThrow(/isn.t a path Pragma can read/);
    await expect(run("space:.env")).rejects.toThrow(/hidden/);
    await expect(run("../.git/config")).rejects.toThrow(/hidden/);
    await expect(run("lib:footage/notes.md")).rejects.toThrow(/library/);
    await expect(run("readme.txt")).rejects.toThrow(/no longer a markdown note/);
    expect(ensureCapability).not.toHaveBeenCalled();
  });

  it("lets Load Image name a library's file, asking to read that address", async () => {
    sandboxRead.mockResolvedValue({ kind: "image", mediaType: "image/png", data: "AAAA" });
    const ensureCapability = vi.fn(async () => true);

    const outputs = await NODE_EXECUTORS.loadImage(
      node("loadImage", { imagePath: "space:art/dragged.png" }),
      { path: text("lib:footage/stills/sunset.png") },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "readFile", path: "lib:footage/stills/sunset.png", wired: true }]);
    expect(outputs.name).toEqual(text("sunset"));
  });

  it("gives Load Image nothing at all, when optional and its wire is empty, whatever the computer picked", async () => {
    const pickedImages = new Map([["loadImage-1", { mediaType: "image/png", data: "AAAA", name: "x.png" }]]);

    const outputs = await NODE_EXECUTORS.loadImage(
      node("loadImage", { optional: "true" }),
      { path: text("") },
      context({ pickedImages }),
    );

    expect(outputs).toEqual({});
  });

  it("reads a Table by the same rule, a path or an address", async () => {
    sandboxRead.mockResolvedValueOnce({
      kind: "table",
      columns: [{ id: "name", label: "Name", type: "text" }],
      rows: [{ values: { name: "Ada" } }],
    });
    const ensureCapability = vi.fn(async () => true);

    const outputs = await NODE_EXECUTORS.loadTableRows(
      node("loadTableRows"),
      { path: text("cast.table.html") },
      context({ ensureCapability }),
    );

    expect(outputs.rows).toEqual({ type: "object", value: [{ Name: "Ada" }] });
    expect(asked(ensureCapability)).toEqual([{ type: "readFile", path: "space:tools/cast.table.html", wired: true }]);

    sandboxRead.mockResolvedValueOnce({ kind: "table", columns: [], rows: [] });
    await NODE_EXECUTORS.loadTableRows(
      node("loadTableRows"),
      { path: text("space:cast.table.html") },
      context({ ensureCapability }),
    );
    expect(asked(ensureCapability).at(-1)).toEqual({
      type: "readFile",
      path: "space:cast.table.html",
      wired: true,
    });
  });
});

describe("a path wired into a writer", () => {
  it("writes to the file it names, asking for writeDocument on that one address", async () => {
    sandboxWrite.mockClear();
    const ensureCapability = vi.fn(async () => true);

    await NODE_EXECUTORS.writeNote(
      node("writeNote"),
      { path: text("./out/scene.md"), text: text("INT. HOUSE") },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "writeDocument", path: "space:tools/out/scene.md", wired: true }]);
    expect(sandboxWrite).toHaveBeenCalledWith(
      "flow",
      "tools/lyrics.flow.html",
      "space:tools/out/scene.md",
      "INT. HOUSE",
    );
  });

  it("says what is missing when the wire is empty", async () => {
    await expect(
      NODE_EXECUTORS.writeNote(node("writeNote"), { path: text(""), text: text("x") }, context()),
    ).rejects.toThrow(/Nothing reached its path input/);
  });

  it("adds to the note it names, asking for writeDocument on that one address", async () => {
    sandboxAddToNote.mockClear();
    const ensureCapability = vi.fn(async () => true);

    await NODE_EXECUTORS.addToNote(
      node("addToNote", { notePath: "space:tools/elsewhere.md", affixMode: "prepend" }),
      { path: text("./out/log.md"), text: text("- shipped") },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([{ type: "writeDocument", path: "space:tools/out/log.md", wired: true }]);
    expect(sandboxAddToNote).toHaveBeenCalledWith(
      "flow",
      "tools/lyrics.flow.html",
      "space:tools/out/log.md",
      "- shipped",
      "prepend",
    );
  });

  it("adds its row to the Table it names, in place of the dragged one", async () => {
    sandboxAddRow.mockResolvedValue({ path: "projects/log.table.html" });
    const ensureCapability = vi.fn(async () => true);
    const addRow = node("addRow", { tablePath: "space:projects/other.table.html" });

    await NODE_EXECUTORS.addRow(
      addRow,
      { path: text("../projects/log.table.html"), row: { type: "object", value: { note: "hello" } } },
      context({ ensureCapability }),
    );

    expect(asked(ensureCapability)).toEqual([
      { type: "writeDocument", path: "space:projects/log.table.html", wired: true },
    ]);
    expect(sandboxAddRow).toHaveBeenCalledWith("flow", "tools/lyrics.flow.html", "space:projects/log.table.html", {
      note: "hello",
    });
  });
});

describe("Resolve Path", () => {
  const resolve = (inputs: Record<string, PortValue>, config: Record<string, unknown> = {}, scopes: string[] = []) =>
    NODE_EXECUTORS.resolvePath(node("resolvePath", config), inputs, context({ scopes: async () => new Set(scopes) }));
  const asLink = { type: "boolean" as const, value: true };

  it("reads a path from the folder of the document `base` names, and gives it from the root", async () => {
    const outputs = await resolve({ base: text("/projects/test/lyric.md"), path: text("renders/") });
    expect(outputs.path).toEqual(text("/projects/test/renders/"));
    expect(
      (await resolve({ base: text("space:projects/movie/scene.md"), path: text("cast.table.html") })).path,
    ).toEqual(text("/projects/movie/cast.table.html"));
  });

  it("reads `base` itself as any wired path is read, from this Flow's folder", async () => {
    expect((await resolve({ base: text("drafts/a.md"), path: text("b.md") })).path).toEqual(text("/tools/drafts/b.md"));
  });

  it("takes a `base` ending in `/` as that folder itself", async () => {
    expect((await resolve({ base: text("/projects/test/"), path: text("x.md") })).path).toEqual(
      text("/projects/test/x.md"),
    );
  });

  it("climbs with `..`, and names nothing past the root", async () => {
    const base = text("/projects/movie/scene.md");
    expect((await resolve({ base, path: text("../world/places.md") })).path).toEqual(text("/projects/world/places.md"));
    await expect(resolve({ base, path: text("../../../x.md") })).rejects.toThrow(/climbs above its root/);
  });

  it("is relative to this Flow with `base` blank, and names a library file outright", async () => {
    expect((await resolve({ path: text("notes.md") })).path).toEqual(text("/tools/notes.md"));
    expect((await resolve({ base: text("lib:footage/shots/a.png"), path: text("b.png") })).path).toEqual(
      text("lib:footage/shots/b.png"),
    );
  });

  // The note a Write Note will make reads the image from its own folder.
  it("writes the path as a link inside `base` would, with `as_link`", async () => {
    const inputs = {
      base: text("/projects/test/shots/shot-1.md"),
      path: text("/projects/test/renders/my shot.png"),
      as_link: asLink,
    };
    expect((await resolve(inputs)).path).toEqual(text("../renders/my%20shot.png"));
    expect((await resolve(inputs, {}, ["projects/test/shots"])).path).toEqual(
      text("/projects/test/renders/my%20shot.png"),
    );
  });

  it("writes a link to a library file outright, and refuses one out of a library", async () => {
    expect(
      (await resolve({ base: text("/notes/a.md"), path: text("lib:footage/a.png"), as_link: asLink })).path,
    ).toEqual(text("lib:footage/a.png"));
    await expect(
      resolve({ base: text("lib:footage/a.md"), path: text("space:notes/b.md"), as_link: asLink }),
    ).rejects.toThrow(/library/);
  });

  it("takes its inputs from the node's fallbacks when nothing is wired", async () => {
    const outputs = await resolve({}, { base: "/projects/movie/scene.md", path: "cast.table.html" });
    expect(outputs.path).toEqual(text("/projects/movie/cast.table.html"));
    const linked = await resolve(
      {},
      { base: "/projects/movie/scene.md", path: "/projects/movie/cast.table.html", as_link: "true" },
    );
    expect(linked.path).toEqual(text("cast.table.html"));
  });

  it("fails on a missing path or one that leads nowhere", async () => {
    await expect(resolve({ path: text(" ") })).rejects.toThrow(/no path to resolve/);
    await expect(resolve({ path: text("foo:bar") })).rejects.toThrow(/isn.t a path Pragma can read/);
    await expect(resolve({ base: text("foo:bar"), path: text("a.md") })).rejects.toThrow();
  });

  it("declares no capability", () => {
    expect(FLOW_NODE_REGISTRY.resolvePath.capabilityFor).toBeUndefined();
  });
});

describe("Current Document's path", () => {
  it("is the bound document's path from the root", async () => {
    const document = {
      path: "projects/movie/scene.md",
      hasSelection: false,
      read: () => ({ content: "# Scene", selection: "" }),
      replaceSelection: vi.fn(),
      showResult: vi.fn(),
    };
    const outputs = await NODE_EXECUTORS.currentDocument(node("currentDocument"), {}, context({ document }));
    expect(outputs.path).toEqual(text("/projects/movie/scene.md"));
  });
});

describe("the pins", () => {
  it("are one optional text input named path on every path-taking node", () => {
    const pins = Object.values(FLOW_NODE_REGISTRY)
      .filter((definition) => definition.pathInput)
      .map((definition) => [definition.type, definition.pathInput?.portId, definition.pathInput?.configKey]);
    expect(pins).toEqual([
      ["loadRandomRow", "path", "tablePath"],
      ["loadTableRows", "path", "tablePath"],
      ["addRow", "path", "tablePath"],
      ["loadNote", "path", "notePath"],
      ["loadImage", "path", "imagePath"],
      ["loadVideo", "path", "videoPath"],
      ["writeNote", "path", "notePath"],
      ["addToNote", "path", "notePath"],
      ["writeFolderNote", "path", "folderPath"],
      ["openToSide", "path", "documentPath"],
    ]);
    for (const definition of Object.values(FLOW_NODE_REGISTRY)) {
      if (!definition.pathInput) continue;
      const port = nodePorts(node(definition.type)).inputs.find((p) => p.id === definition.pathInput?.portId);
      expect(port, definition.type).toMatchObject({
        id: definition.pathInput.portId,
        label: definition.pathInput.portId,
        type: "text",
        required: false,
      });
    }
  });
});

describe("wired path access", () => {
  const edge = (target: string, targetPort: string) => ({
    id: `${target}-${targetPort}`,
    source: "src",
    sourcePort: "path",
    target,
    targetPort,
  });
  function graph(...edges: FlowGraph["edges"]): FlowGraph {
    return {
      nodes: [node("loadNote"), node("writeNote"), node("loadImage")].map((n) => ({ ...n, id: n.type })),
      edges,
    };
  }

  it("is what a graph's wired pins can ask for, and nothing while no wire reaches one", () => {
    expect([...wiredPathAccess(graph())]).toEqual([]);
    expect([...wiredPathAccess(graph(edge("loadNote", "path")))]).toEqual(["read"]);
    expect([...wiredPathAccess(graph(edge("writeNote", "path")))]).toEqual(["write"]);
    expect([...wiredPathAccess(graph(edge("loadNote", "path"), edge("writeNote", "path")))].sort()).toEqual([
      "read",
      "write",
    ]);
    expect([...wiredPathAccess(graph(edge("loadNote", "text")))]).toEqual([]);
  });

  it("allows an address in its one spelling, as the capability its access picks", () => {
    const read = new Set(["read" as const]);
    const both = new Set(["read" as const, "write" as const]);
    expect(wiredCapability(read, "read", "space:a/x.md")).toEqual({ type: "readFile", path: "space:a/x.md" });
    expect(wiredCapability(read, "read", "lib:footage/x.png")).toEqual({
      type: "readFile",
      path: "lib:footage/x.png",
    });
    expect(wiredCapability(both, "write", "space:a/x.md")).toEqual({ type: "writeDocument", path: "space:a/x.md" });
  });

  it("refuses what no wire may ask for", () => {
    const read = new Set(["read" as const]);
    expect(wiredCapability(read, "write", "space:a/x.md")).toBeUndefined();
    expect(wiredCapability(new Set(), "read", "space:a/x.md")).toBeUndefined();
    expect(wiredCapability(read, "read", "a/x.md")).toBeUndefined();
    expect(wiredCapability(read, "read", "space:a/../x.md")).toBeUndefined();
    expect(wiredCapability(read, "read", "space:.git/config")).toBeUndefined();
  });

  it("recognizes a granted key only where a wire could use it now", () => {
    const read = new Set(["read" as const]);
    expect(wiredCapabilityOfKey(read, "readFile:space:a/x.md")).toEqual({
      type: "readFile",
      path: "space:a/x.md",
    });
    expect(wiredCapabilityOfKey(read, "readFile:lib:footage/x.png")).toEqual({
      type: "readFile",
      path: "lib:footage/x.png",
    });
    expect(wiredCapabilityOfKey(read, "writeDocument:space:a/x.md")).toBeUndefined();
    expect(wiredCapabilityOfKey(read, "generateText")).toBeUndefined();
    expect(wiredCapabilityOfKey(read, "readFile:a/x.md")).toBeUndefined();
  });

  it("lists the granted wired paths after the declared capabilities, once each", () => {
    const g: FlowGraph = {
      nodes: [
        { ...node("loadNote", { notePath: "space:a/x.md" }), id: "load" },
        { ...node("writeNote"), id: "write" },
      ],
      edges: [edge("load", "path")],
    };
    const rows = flowPermissionRows(
      g,
      ["readFile:space:a/x.md", "readFile:space:b/y.md", "writeDocument:space:b/y.md"],
      "flows/f.flow.html",
    );
    expect(rows).toEqual([
      { type: "readFile", path: "space:a/x.md" },
      { type: "readFile", path: "space:b/y.md", wired: true },
    ]);
  });

  it("lists a declared path once however its node spells it, its grant on the declared row", () => {
    const g: FlowGraph = {
      nodes: [
        { ...node("loadNote", { notePath: "../a/x.md" }), id: "load" },
        { ...node("writeNote"), id: "write" },
      ],
      edges: [edge("load", "path")],
    };
    expect(flowPermissionRows(g, ["readFile:space:a/x.md"], "flows/f.flow.html")).toEqual([
      { type: "readFile", path: "space:a/x.md" },
    ]);
  });
});

describe("a path wired into a generation's context", () => {
  const contextEdge = { id: "src-context", source: "src", sourcePort: "path", target: "gen", targetPort: "context" };
  function generations(...edges: FlowGraph["edges"]): FlowGraph {
    return {
      nodes: [
        { ...node("generateText"), id: "gen" },
        { ...node("generateOptions"), id: "options" },
      ],
      edges,
    };
  }
  const scene = "/projects/forbidden/story/screenplay/scene.fountain";
  const scopes = async () => new Set(["projects/forbidden", "projects/forbidden/story"]);
  const sent = { path: scene, files: ["/projects/forbidden/story/README.md"], searches: [], messages: [] };

  it("lets a graph ask for a context only while a wire reaches the pin", () => {
    expect([...wiredPathAccess(generations())]).toEqual([]);
    expect([...wiredPathAccess(generations(contextEdge))]).toEqual(["context"]);
    expect([...wiredPathAccess(generations({ ...contextEdge, target: "options" }))]).toEqual(["context"]);
  });

  it("asks for a scope's folder in the space, never one in a library", () => {
    const access = new Set(["context" as const]);
    expect(wiredCapability(access, "context", "space:projects/story")).toEqual({
      type: "searchContext",
      path: "space:projects/story",
    });
    expect(wiredCapability(access, "context", "space:")).toEqual({ type: "searchContext", path: "space:" });
    expect(wiredCapability(access, "context", "lib:footage/takes")).toBeUndefined();
    expect(wiredCapability(new Set(["read" as const]), "context", "space:projects/story")).toBeUndefined();
    expect(wiredCapabilityOfKey(access, "searchContext:space:projects/story")).toEqual({
      type: "searchContext",
      path: "space:projects/story",
    });
    expect(wiredCapabilityOfKey(access, "searchContext:projects/story")).toBeUndefined();
  });

  it("lists a granted scope as the scope, not as a path from a connected node", () => {
    const rows = flowPermissionRows(
      generations(contextEdge),
      ["generateText", "searchContext:space:projects/story"],
      "tools/f.flow.html",
    );
    expect(rows).toEqual([{ type: "generateText" }, { type: "searchContext", path: "space:projects/story" }]);
  });

  it("asks for the scope the path sits in, sends the path's address and hands on what went", async () => {
    const ensureCapability = vi.fn(async () => true);
    const generated = vi.fn();
    const generate = vi.fn(async (_kind: string, _path: string, _body: GenerateRequestBody) => ({
      reply: "Shot 1",
      model: "m",
      context: sent,
    }));
    const run = context({ ensureCapability, generated, scopes });
    run.sandbox.generate = generate;

    const outputs = await NODE_EXECUTORS.generateText(
      node("generateText"),
      { prompt: text("List the shots."), context: text(scene) },
      run,
    );

    expect(asked(ensureCapability)).toEqual([
      { type: "generateText" },
      { type: "searchContext", path: "space:projects/forbidden/story" },
    ]);
    expect(generate.mock.calls[0][2]).toEqual({
      instruction: "List the shots.",
      values: {},
      images: {},
      context: "space:projects/forbidden/story/screenplay/scene.fountain",
    });
    expect(generated).toHaveBeenCalledWith("generateText-1", {
      failed: false,
      result: { reply: "Shot 1", model: "m", context: sent },
    });
    expect(outputs).toEqual({ text: text("Shot 1") });
  });

  it("reads the path from the Flow's folder, and one in no inner scope asks for the space's own", async () => {
    const ensureCapability = vi.fn(async () => true);
    const run = context({ ensureCapability, scopes });
    const generateOptions = vi.fn(async (_kind: string, _path: string, _body: GenerateOptionsRequestBody) => ({
      options: ["a"],
      model: "m",
    }));
    run.sandbox.generateOptions = generateOptions;

    await NODE_EXECUTORS.generateOptions(
      node("generateOptions"),
      { prompt: text("Two titles."), context: text("notes/a.md") },
      run,
    );

    expect(asked(ensureCapability).at(-1)).toEqual({ type: "searchContext", path: "space:" });
    expect(generateOptions.mock.calls[0][2].context).toBe("space:tools/notes/a.md");
  });

  it("fails before asking for a scope when the wire brings no path or a library's", async () => {
    for (const [path, message] of [
      ["  ", /carries no path/],
      ["lib:footage/x.md", /in a library/],
    ] as const) {
      const ensureCapability = vi.fn(async () => true);
      await expect(
        NODE_EXECUTORS.generateText(
          node("generateText"),
          { prompt: text("Go."), context: text(path) },
          context({ ensureCapability, scopes }),
        ),
      ).rejects.toThrow(message);
      expect(asked(ensureCapability)).toEqual([{ type: "generateText" }]);
    }
  });

  it("fails, naming the folder, when the scope isn't allowed", async () => {
    const ensureCapability = vi.fn(
      async (capability: FlowCapabilityDeclaration) => capability.type !== "searchContext",
    );
    const run = context({ ensureCapability, scopes });
    await expect(
      NODE_EXECUTORS.generateText(node("generateText"), { prompt: text("Go."), context: text(scene) }, run),
    ).rejects.toThrow('Permission denied to send files from "/projects/forbidden/story/"');
    expect(run.sandbox.generate).not.toHaveBeenCalled();
  });
});
