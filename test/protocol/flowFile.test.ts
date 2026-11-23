import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityDigest, parseFlowFile, readFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { metadataText } from "../../src/protocol/metadata.ts";
import type { FlowFile, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";
import { tempDir } from "../support/isolation.ts";

// Conformance tests for the `.flow.html` format itself (the reader's
// graceful-fallback contract + the serializer's byte-stable shape), same
// spirit as tableFile.test.ts for `.table.html` — assert on the
// read/serialize input/output contract, not on node-html-parser.

async function withTempFile(contents: string, run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = tempDir("pragma-flowfile-test-");
  const filePath = path.join(dir, "test.flow.html");
  await writeFile(filePath, contents, "utf8");
  await run(filePath);
}

describe(".flow.html round-tripping", () => {
  it("parse(serialize(x)) is a fixed point for a graph exercising every optional field", async () => {
    const file: Omit<FlowFile, "html"> = {
      version: "1.0",
      name: "Round-trip test",
      metadata: [
        { key: "description", values: ["Exercises every optional field at once."] },
        { key: "tags", values: ["draft", "studio"] },
      ],
      graph: {
        nodes: [
          {
            id: "n1",
            type: "prompt",
            typeVersion: "1.0",
            position: { x: 40, y: 60 },
            config: { text: 'Special chars: <tag> & "quotes" and a literal </script> too' },
            size: { width: 320.5, height: 180 },
            label: "Custom label",
            comment: "One line for the node's users.",
            color: "#0b6e99",
            collapsed: true,
            settingsFolded: true,
            mode: "disabled",
            appModeSize: { columns: 3, rows: 2 },
          },
          {
            id: "n2",
            type: "showText",
            position: { x: 400, y: 60 },
            config: {},
          },
        ],
        edges: [{ id: "e1", source: "n1", sourcePort: "text", target: "n2", targetPort: "text" }],
        viewport: { x: 10, y: 20, zoom: 0.75 },
        runAppModeSize: { columns: 2, rows: 1 },
      },
    };

    await withTempFile(serializeFlowFile(file), async (filePath) => {
      const firstPass = serializeFlowFile(file);
      const reparsed = await readFlowFile(filePath);
      const secondPass = serializeFlowFile(reparsed);
      expect(secondPass).toBe(firstPass);
      expect(reparsed.version).toBe(file.version);
      expect(reparsed.name).toBe(file.name);
      expect(reparsed.metadata).toEqual(file.metadata);
      expect(reparsed.graph).toEqual(file.graph);
    });
  });

  it("omitted optional fields don't reappear as defaults after a round trip", async () => {
    const file: Omit<FlowFile, "html"> = {
      version: "1.0",
      graph: { nodes: [{ id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {} }], edges: [] },
    };

    await withTempFile(serializeFlowFile(file), async (filePath) => {
      const reparsed = await readFlowFile(filePath);
      expect(reparsed.name).toBeUndefined();
      expect(reparsed.metadata).toEqual([]);
      expect(reparsed.graph.viewport).toBeUndefined();
      const node = reparsed.graph.nodes[0];
      expect(node?.size).toBeUndefined();
      expect(node?.label).toBeUndefined();
      expect(node?.color).toBeUndefined();
      expect(node?.collapsed).toBeUndefined();
      expect(node?.typeVersion).toBeUndefined();
    });
  });

  it("escapes a literal </script> in config text so it round-trips intact", async () => {
    const file: Omit<FlowFile, "html"> = {
      version: "1.0",
      graph: {
        nodes: [{ id: "n1", type: "prompt", position: { x: 0, y: 0 }, config: { text: "before </script> after" } }],
        edges: [],
      },
    };

    const html = serializeFlowFile(file);
    expect(html).not.toContain("</script> after");
    await withTempFile(html, async (filePath) => {
      const reparsed = await readFlowFile(filePath);
      expect(reparsed.graph.nodes[0]?.config.text).toBe("before </script> after");
    });
  });

  it("escapes special characters in the name shown in <title>", async () => {
    const file: Omit<FlowFile, "html"> = {
      version: "1.0",
      name: 'A <flow> & "friends"',
      graph: { nodes: [], edges: [] },
    };

    const html = serializeFlowFile(file);
    expect(html).toContain("<title>A &lt;flow&gt; &amp; &quot;friends&quot;</title>");
    await withTempFile(html, async (filePath) => {
      const reparsed = await readFlowFile(filePath);
      expect(reparsed.name).toBe('A <flow> & "friends"');
    });
  });

  it("escapes special characters in the description written to the metadata block", async () => {
    const file: Omit<FlowFile, "html"> = {
      version: "1.0",
      metadata: [{ key: "description", values: ['Uses <angle> & "quoted" text.'] }],
      graph: { nodes: [], edges: [] },
    };

    const html = serializeFlowFile(file);
    expect(html).toContain("<dd>Uses &lt;angle&gt; &amp; &quot;quoted&quot; text.</dd>");
    await withTempFile(html, async (filePath) => {
      const reparsed = await readFlowFile(filePath);
      expect(metadataText(reparsed.metadata, "description")).toBe('Uses <angle> & "quoted" text.');
    });
  });
});

describe("readFlowFile graceful fallback", () => {
  it("reads a nonexistent file as an empty flow file", async () => {
    const missing = path.join(tmpdir(), "pragma-flowfile-test-does-not-exist", "missing.flow.html");
    const result = await readFlowFile(missing);
    expect(result.html).toBe("");
    expect(result.graph).toEqual({ nodes: [], edges: [] });
  });

  it("reads an empty file as an empty flow file, preserving the raw (empty) html", async () => {
    await withTempFile("", async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.html).toBe("");
      expect(result.graph).toEqual({ nodes: [], edges: [] });
    });
  });

  it("reads whitespace-only content as empty, preserving the raw html", async () => {
    await withTempFile("   \n  ", async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.html).toBe("   \n  ");
      expect(result.graph).toEqual({ nodes: [], edges: [] });
    });
  });

  it('treats html missing data-format="flow" as empty', async () => {
    await withTempFile("<html><body>not a flow file</body></html>", async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.graph).toEqual({ nodes: [], edges: [] });
    });
  });

  it("falls back to empty when the graph script contains malformed JSON", async () => {
    const html = `<html data-format="flow" data-id="flow_x"><head>
      <script type="application/json" data-role="graph">{not valid json</script>
    </head><body></body></html>`;
    await withTempFile(html, async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.graph).toEqual({ nodes: [], edges: [] });
    });
  });

  it("defaults the graph but still reads the title when the graph script is absent", async () => {
    const html = `<html data-format="flow" data-format-version="1.0"><head>
      <title>Present</title>
    </head><body></body></html>`;
    await withTempFile(html, async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.name).toBe("Present");
      expect(result.graph).toEqual({ nodes: [], edges: [] });
    });
  });

  it("defaults the version when the root element declares none", async () => {
    const html = `<html data-format="flow"><head>
      <script type="application/json" data-role="graph">{"nodes":[{"id":"n1","type":"comment","position":{"x":1,"y":2},"config":{}}],"edges":[]}</script>
    </head><body></body></html>`;
    await withTempFile(html, async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(result.version).toBe("1.0");
      expect(result.graph.nodes).toHaveLength(1);
    });
  });

  it("reads no description from a metadata block that has none", async () => {
    const html = `<html data-format="flow" data-id="flow_x"><head><title>No description</title></head><body>
      <dl data-role="metadata"></dl>
    </body></html>`;
    await withTempFile(html, async (filePath) => {
      const result = await readFlowFile(filePath);
      expect(metadataText(result.metadata, "description")).toBeUndefined();
    });
  });
});

// The split a saving caller depends on: blank is a new flow to build,
// unreadable is a file that an empty graph saved back would erase.
describe("parseFlowFile: blank versus unreadable", () => {
  it("reads blank text, or a blank graph block, as an empty graph", () => {
    expect(parseFlowFile("   \n  ")?.graph).toEqual({ nodes: [], edges: [] });
    const blankGraph = `<html data-format="flow"><head>
      <script type="application/json" data-role="graph">  </script>
    </head><body></body></html>`;
    expect(parseFlowFile(blankGraph)?.graph).toEqual({ nodes: [], edges: [] });
  });

  it("is undefined for non-blank text that isn't a flow", () => {
    expect(parseFlowFile("<html><body>not a flow file</body></html>")).toBeUndefined();
  });

  it("is undefined when the graph block isn't JSON, down to one trailing comma", () => {
    const html = `<html data-format="flow"><head>
      <script type="application/json" data-role="graph">{"nodes":[{"id":"n1","type":"comment","position":{"x":0,"y":0},"config":{}},],"edges":[]}</script>
    </head><body></body></html>`;
    expect(parseFlowFile(html)).toBeUndefined();
    expect(parseFlowFile(html.replace("},],", "}],"))?.graph.nodes).toHaveLength(1);
  });
});

describe("readFlowFile per-field parse tolerance", () => {
  async function readGraph(graphJson: string) {
    const html = `<html data-format="flow" data-format-version="1.0" data-id="flow_x"><head>
      <script type="application/json" data-role="graph">${graphJson}</script>
    </head><body></body></html>`;
    let result: Awaited<ReturnType<typeof readFlowFile>> | undefined;
    await withTempFile(html, async (filePath) => {
      result = await readFlowFile(filePath);
    });
    return result!.graph;
  }

  it("skips non-object node entries and nodes missing id or type", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [
          "not an object",
          { id: "", type: "comment", position: { x: 0, y: 0 }, config: {} },
          { id: "ok-missing-type", position: { x: 0, y: 0 }, config: {} },
          { id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("defaults a missing or malformed position to {x: 0, y: 0}", async () => {
    const graph = await readGraph(JSON.stringify({ nodes: [{ id: "n1", type: "comment", config: {} }], edges: [] }));
    expect(graph.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("drops the whole size when width or height isn't a number", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {}, size: { width: "wide", height: 10 } },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes[0]?.size).toBeUndefined();
  });

  it("drops an invalid hex color, and normalizes a valid short hex", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {}, color: "blue" },
          { id: "n2", type: "comment", position: { x: 0, y: 0 }, config: {}, color: "#abc" },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes[0]?.color).toBeUndefined();
    expect(graph.nodes[1]?.color).toBe("#aabbcc");
  });

  // Only "disabled" is a mode: any other value runs the node, as no mode does.
  it("keeps a disabled mode and drops any other", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {}, mode: "disabled" },
          { id: "n2", type: "comment", position: { x: 0, y: 0 }, config: {}, mode: "bypass" },
          { id: "n3", type: "comment", position: { x: 0, y: 0 }, config: {}, mode: true },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes.map((node) => node.mode)).toEqual(["disabled", undefined, undefined]);
  });

  it("treats an empty label as absent", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [{ id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {}, label: "" }],
        edges: [],
      }),
    );
    expect(graph.nodes[0]?.label).toBeUndefined();
  });

  it("treats an empty or blank comment as absent, and one that isn't text too", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "comment", position: { x: 0, y: 0 }, config: {}, comment: "" },
          { id: "n2", type: "comment", position: { x: 0, y: 0 }, config: {}, comment: "  " },
          { id: "n3", type: "comment", position: { x: 0, y: 0 }, config: {}, comment: 7 },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes.map((node) => node.comment)).toEqual([undefined, undefined, undefined]);
  });

  it("drops an edge missing any single required field, all-or-nothing (unlike node defaulting)", async () => {
    const graph = await readGraph(
      JSON.stringify({
        nodes: [],
        edges: [
          { id: "e1", source: "a", sourcePort: "out", target: "b", targetPort: "in" },
          { id: "e2", source: "a", sourcePort: "out", target: "b", targetPort: "" },
          { source: "a", sourcePort: "out", target: "b", targetPort: "in" },
        ],
      }),
    );
    expect(graph.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("keeps an App Mode size only when both counts are whole and positive, and never clamps one", async () => {
    const sizes = [
      { columns: 40, rows: 20 },
      { columns: 0, rows: 1 },
      { columns: 2, rows: -1 },
      { columns: 1.5, rows: 2 },
      { columns: "2", rows: 2 },
      { columns: 2 },
      4,
    ];
    const graph = await readGraph(
      JSON.stringify({
        nodes: sizes.map((appModeSize, index) => ({
          id: `n${index}`,
          type: "comment",
          position: { x: 0, y: 0 },
          config: {},
          appModeSize,
        })),
        edges: [],
        runAppModeSize: { columns: 2, rows: 0 },
      }),
    );
    expect(graph.nodes.map((n) => n.appModeSize)).toEqual([
      { columns: 40, rows: 20 },
      ...sizes.slice(1).map(() => undefined),
    ]);
    expect(graph.runAppModeSize).toBeUndefined();
  });

  it("requires viewport's x, y, and zoom to all be numbers, or drops the whole viewport", async () => {
    const graph = await readGraph(JSON.stringify({ nodes: [], edges: [], viewport: { x: 1, y: 2, zoom: "1" } }));
    expect(graph.viewport).toBeUndefined();
  });
});

// The capability digest is what a flow's grants are pinned to, so what it
// covers *and* what it ignores are both contract: a cosmetic edit must not
// re-prompt, and a behavioural one must.
describe("capabilityDigest", () => {
  const base: FlowGraph = {
    nodes: [
      {
        id: "loadNote-1",
        type: "loadNote",
        position: { x: 10, y: 20 },
        config: { notePath: "journal.md" },
      },
      { id: "showText-1", type: "showText", position: { x: 300, y: 20 }, config: {} },
    ],
    edges: [{ id: "e1", source: "loadNote-1", sourcePort: "raw", target: "showText-1", targetPort: "text" }],
  };

  function withNode(patch: Partial<FlowNodeInstance>): FlowGraph {
    return { ...base, nodes: [{ ...base.nodes[0], ...patch }, base.nodes[1]] };
  }

  it("ignores every cosmetic change", () => {
    const digest = capabilityDigest(base);
    expect(capabilityDigest(withNode({ position: { x: 999, y: -40 } }))).toBe(digest);
    expect(capabilityDigest(withNode({ size: { width: 400, height: 300 } }))).toBe(digest);
    expect(capabilityDigest(withNode({ label: "Renamed" }))).toBe(digest);
    expect(capabilityDigest(withNode({ comment: "Reads the journal." }))).toBe(digest);
    expect(capabilityDigest(withNode({ color: "#ff0000" }))).toBe(digest);
    expect(capabilityDigest(withNode({ collapsed: true }))).toBe(digest);
    expect(capabilityDigest(withNode({ settingsFolded: true }))).toBe(digest);
    expect(capabilityDigest(withNode({ appModeOrder: 3 }))).toBe(digest);
    expect(capabilityDigest(withNode({ appModeSize: { columns: 4, rows: 3 } }))).toBe(digest);
    expect(capabilityDigest({ ...base, viewport: { x: 500, y: 500, zoom: 2 } })).toBe(digest);
    expect(
      capabilityDigest({ ...base, runAppModeOrder: 2, runAppModeSize: { columns: 2, rows: 1 }, appModeActive: true }),
    ).toBe(digest);
  });

  it("ignores node and edge array order, and config key order", () => {
    const digest = capabilityDigest(base);
    expect(capabilityDigest({ ...base, nodes: [base.nodes[1], base.nodes[0]] })).toBe(digest);
    const reordered = withNode({ config: { b: 2, a: 1 } });
    expect(capabilityDigest(reordered)).toBe(capabilityDigest(withNode({ config: { a: 1, b: 2 } })));
  });

  // Enabling a node adds what it asks for, so a grant must not outlive the change unseen.
  it("changes when a node is disabled", () => {
    expect(capabilityDigest(withNode({ mode: "disabled" }))).not.toBe(capabilityDigest(base));
  });

  it("changes when a config value changes — the case a grant must not survive", () => {
    expect(capabilityDigest(withNode({ config: { notePath: "secrets.md" } }))).not.toBe(capabilityDigest(base));
  });

  it("changes when a node is added or removed, or an edge rewired", () => {
    const digest = capabilityDigest(base);
    expect(capabilityDigest({ ...base, nodes: [base.nodes[0]] })).not.toBe(digest);
    expect(
      capabilityDigest({
        ...base,
        nodes: [...base.nodes, { id: "comment-1", type: "comment", position: { x: 0, y: 0 }, config: {} }],
      }),
    ).not.toBe(digest);
    expect(capabilityDigest({ ...base, edges: [] })).not.toBe(digest);
  });

  it("changes when a node's type changes but its id does not", () => {
    expect(capabilityDigest(withNode({ type: "loadImage" }))).not.toBe(capabilityDigest(base));
  });
});
