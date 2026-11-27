// @vitest-environment jsdom
import type { InternalNodeBase } from "@xyflow/system";
import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { createZones, pairOf, withEnd, type ZoneView } from "../../../web/flow/zones.ts";

const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
  id,
  type,
  position: { x: 0, y: 0 },
  config,
});

// Each node's card where the canvas measured it: x, y, width, height.
function lookupOf(boxes: Record<string, [number, number, number, number]>): Map<string, InternalNodeBase> {
  return new Map(
    Object.entries(boxes).map(([id, [x, y, width, height]]) => [
      id,
      { id, position: { x, y }, measured: { width, height }, data: {} } as unknown as InternalNodeBase,
    ]),
  );
}

const zoneGraph = (rows = false): FlowGraph => ({
  nodes: [
    ...(rows ? [node("rows-1", "loadTableRows", { tablePath: "s.table.html" })] : []),
    node("each-2", "forEach"),
    node("field-3", "getField", { field1Key: "title" }),
    node("end-4", "forEachEnd", { forEach: "each-2" }),
  ],
  edges: [
    ...(rows ? [{ id: "e0", source: "rows-1", sourcePort: "rows", target: "each-2", targetPort: "list" }] : []),
    { id: "e1", source: "each-2", sourcePort: "item", target: "field-3", targetPort: "object" },
    { id: "e2", source: "field-3", sourcePort: "field_1", target: "end-4", targetPort: "value_1" },
  ],
});

function setUp(graph: FlowGraph) {
  const viewport = document.createElement("div");
  let flowPath = "a.flow.html";
  const zones = createZones({
    viewport,
    graph: () => graph,
    nodeLookup: lookupOf({
      "each-2": [100, 200, 190, 100],
      "field-3": [340, 160, 220, 90],
      "end-4": [620, 200, 190, 80],
    }),
    flowPath: () => flowPath,
  });
  zones.render();
  const zone = () => viewport.querySelector(".flow-zone") as HTMLElement;
  const label = () => viewport.querySelector(".flow-zone-label") as HTMLElement;
  return { zones, zone, label, open: (path: string) => (flowPath = path) };
}

const view = (overrides: Partial<ZoneView> = {}): ZoneView => ({
  total: 12,
  shown: 2,
  settled: 2,
  failed: [],
  running: true,
  step: vi.fn(),
  ...overrides,
});

const buttonNamed = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name,
  ) as HTMLButtonElement;

describe("a zone on the canvas", () => {
  it("is drawn under the cards, from its For Each's card to its End's, around the nodes between", () => {
    const { zone } = setUp(zoneGraph());
    expect(zone().parentElement?.className).toBe("flow-zone-layer");
    expect(zone().style.transform).toBe("translate(112px, 116px)");
    expect([zone().style.width, zone().style.height]).toEqual(["686px", "212px"]);
  });

  it("calls its items a Table's rows, and anything else items", () => {
    expect(setUp(zoneGraph()).label().textContent).toBe("For each item");
    expect(setUp(zoneGraph(true)).label().textContent).toBe("For each row");
  });

  it("shows a run's item and progress, and steps between items", () => {
    const { zones, label } = setUp(zoneGraph(true));
    const shown = view();
    zones.show("a.flow.html", "each-2", shown);
    expect(label().querySelector(".flow-zone-status")?.textContent).toBe("Row 3 of 12");
    expect((label().querySelector(".flow-zone-progress-fill") as HTMLElement).style.width).toBe("17%");
    buttonNamed(label(), "Next row").click();
    buttonNamed(label(), "Previous row").click();
    expect(shown.step).toHaveBeenNthCalledWith(1, 3);
    expect(shown.step).toHaveBeenNthCalledWith(2, 1);
  });

  it("counts the failed items once the run is over, and steps to the next one round and round", () => {
    const { zones, label } = setUp(zoneGraph(true));
    const after = view({ running: false, shown: 7, failed: [3, 6], settled: 12 });
    zones.show("a.flow.html", "each-2", after);
    expect(label().querySelector(".flow-zone-progress")).toBeNull();
    const failed = label().querySelector(".flow-zone-failed") as HTMLButtonElement;
    expect(failed.textContent).toBe("2 failed");
    failed.click();
    expect(after.step).toHaveBeenCalledWith(3);
  });

  it("asks on its label after the first generation, answering with the person's choice", () => {
    const { zones, label } = setUp(zoneGraph(true));
    const answer = vi.fn();
    zones.show("a.flow.html", "each-2", view({ shown: 0, settled: 1, ask: { rest: 11, answer } }));
    expect(label().textContent).toBe("For each rowRow 1 doneContinue with 11 moreStop");
    buttonNamed(label(), "Continue with 11 more").click();
    buttonNamed(label(), "Stop").click();
    expect(answer.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps each Flow's views to that Flow", () => {
    const { zones, label, open } = setUp(zoneGraph(true));
    zones.show("b.flow.html", "each-2", view());
    expect(label().textContent).toBe("For each row");
    open("b.flow.html");
    zones.render();
    expect(label().querySelector(".flow-zone-status")?.textContent).toBe("Row 3 of 12");
  });
});

describe("a For Each and its End", () => {
  it("are added together, the End beside the For Each naming it", () => {
    const added = withEnd({ ...node("forEach-1", "forEach"), position: { x: 40, y: 60 } }, () => "forEachEnd-2");
    expect(added.map((each) => [each.id, each.type, each.position, each.config])).toEqual([
      ["forEach-1", "forEach", { x: 40, y: 60 }, {}],
      ["forEachEnd-2", "forEachEnd", { x: 560, y: 60 }, { forEach: "forEach-1" }],
    ]);
    expect(withEnd(node("prompt-1", "prompt"), () => "unused")).toHaveLength(1);
  });

  it("are removed together, from either one", () => {
    const graph = zoneGraph();
    expect([...pairOf(graph, "each-2")]).toEqual(["each-2", "end-4"]);
    expect([...pairOf(graph, "end-4")]).toEqual(["end-4", "each-2"]);
    expect([...pairOf(graph, "field-3")]).toEqual(["field-3"]);
  });
});
