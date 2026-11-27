// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { FlowGraph } from "../../../src/protocol/types.ts";
import { brokerCapability, flowBrokerCapabilities } from "../../../web/flow/flowPermissions.ts";
import { capabilityPrompt } from "../../../web/services/capabilityBroker.ts";

// The prompt's sentence, its line break as a newline, and the path its label
// names in full.
function asked(capability: Parameters<typeof capabilityPrompt>[1]) {
  const [message] = capabilityPrompt({ name: "Lyrics", path: "tools/lyrics.flow.html" }, capability).message;
  const lines = message.cloneNode(true) as HTMLElement;
  for (const br of lines.querySelectorAll("br")) br.replaceWith("\n");
  return { text: lines.textContent, path: message.querySelector<HTMLElement>(".path-label")?.dataset.tooltip };
}

// What a person is asked, and what Permissions lists: a path a wire chose is
// asked for by the one file it names, and says it came from a wire.
describe("a Flow's capabilities in the broker's terms", () => {
  const FLOW = "tools/lyrics.flow.html";

  it("asks for a wired path by its file, naming where the path came from", () => {
    const wired = brokerCapability({ type: "writeDocument", path: "space:projects/out/scene.md", wired: true }, FLOW);
    expect(wired).toEqual({
      key: "writeDocument:space:projects/out/scene.md",
      type: "writeDocument",
      path: "space:projects/out/scene.md",
      description: "a path from a connected node",
    });
    expect(asked(wired)).toEqual({
      text: "Grant Lyrics permission to write:\nprojects/out/scene.md (a path from a connected node)",
      path: "projects/out/scene.md",
    });
  });

  it("asks for a dragged path by its address, its root left out of the prompt", () => {
    const dragged = brokerCapability({ type: "readFile", path: "space:tags.table.html" }, FLOW);
    expect(dragged).toEqual({
      key: "readFile:space:tags.table.html",
      type: "readFile",
      path: "space:tags.table.html",
    });
    expect(asked(dragged).path).toBe("tags.table.html");
    expect(asked(brokerCapability({ type: "readFile", path: "lib:footage/a.png" }, FLOW))).toEqual({
      text: "Grant Lyrics permission to read from a library:\nfootage/a.png",
      path: "lib:footage/a.png",
    });
  });

  it("asks for a path its node writes from the Flow's folder by the file it names", () => {
    const relative = brokerCapability({ type: "readFile", path: "../notes/my%20log.md" }, FLOW);
    expect(relative).toEqual({
      key: "readFile:space:notes/my log.md",
      type: "readFile",
      path: "space:notes/my log.md",
    });
    expect(asked(relative).path).toBe("notes/my log.md");
    expect(() => brokerCapability({ type: "readFile", path: "../../x.md" }, FLOW)).toThrow("climbs above its root");
  });

  it("lists the granted wired paths after what the graph derives", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "where", type: "prompt", position: { x: 0, y: 0 }, config: { text: "a.md" } },
        { id: "load", type: "loadNote", position: { x: 0, y: 0 }, config: {} },
        { id: "gen", type: "generateText", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "where", sourcePort: "text", target: "load", targetPort: "path" }],
    };
    const granted = new Set(["generateText", "readFile:space:tools/a.md", "writeDocument:space:tools/a.md"]);
    expect(flowBrokerCapabilities(graph, granted, FLOW)).toEqual([
      { key: "generateText", type: "generateText" },
      {
        key: "readFile:space:tools/a.md",
        type: "readFile",
        path: "space:tools/a.md",
        description: "a path from a connected node",
      },
    ]);
  });
});
