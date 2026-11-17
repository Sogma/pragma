// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DocumentLock } from "../../../src/protocol/api.ts";
import { parseFlowFile } from "../../../src/protocol/flowFile.ts";
import type { FlowEdgeInstance, FlowNodeInstance } from "../../../src/protocol/types.ts";
import type { FlowFileResponse } from "../../../web/core/apiClient.ts";
import { createFlowElements } from "../../../web/flow/flowElements.ts";
import { createFlowView } from "../../../web/flow/xyflowAdapter.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchModelOptions: vi.fn(async () => []),
  fetchImageModelOptions: vi.fn(async () => []),
}));

function node(id: string, type: string, x = 0): FlowNodeInstance {
  return { id, type, typeVersion: "1.0", position: { x, y: 0 }, config: {} };
}

function wire(source: string, sourcePort: string, target: string, targetPort: string): FlowEdgeInstance {
  return { id: `e-${source}-${target}`, source, sourcePort, target, targetPort };
}

function setup(nodes: FlowNodeInstance[], edges: FlowEdgeInstance[], locked?: DocumentLock) {
  const elements = createFlowElements();
  const scheduleSave = vi.fn();
  const contextMenu = { open: vi.fn() };
  const view = createFlowView(elements, {
    scheduleSave,
    contextMenu,
    modelLists: emptyModelLists(),
    onRendered: vi.fn(),
    problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
  } as unknown as Parameters<typeof createFlowView>[1]);
  const file: FlowFileResponse = {
    kind: "flow",
    path: "flows/loose.flow.html",
    revision: "rev-1",
    version: "1.0",
    graph: { nodes, edges },
    capabilities: [],
    grantedCapabilities: [],
    runsUnattended: false,
    locked,
  };
  view.render(file);
  const looseEnds = () => Array.from(elements.viewport.querySelectorAll<HTMLElement>(".flow-loose-end"));
  const lastSave = () => parseFlowFile(scheduleSave.mock.calls.at(-1)?.[1])?.graph;
  return { contextMenu, elements, looseEnds, lastSave };
}

// The row a loose end's pin sits on, from where it was placed. Read back, a
// translate with a zero second argument may come without it.
const rowOf = (end: HTMLElement) => {
  const placed = /translate\(\s*[-\d.]+px(?:,\s*([-\d.]+)px)?\s*\)/.exec(end.style.transform);
  return placed ? Number(placed[1] ?? 0) : Number.NaN;
};

describe("wires: loose ends", () => {
  it("hangs one off the drawn pin of each wire naming a missing node, labelled with that node", () => {
    const { elements, looseEnds } = setup(
      [node("showText-28", "showText")],
      [wire("loadFolderNote-26", "title", "showText-28", "text"), wire("showText-28", "text", "showText-27", "text")],
    );
    const ends = looseEnds();
    expect(ends.map((end) => end.textContent)).toEqual(["loadFolderNote-26 (missing)", "showText-27 (missing)"]);
    expect(ends.map((end) => end.classList.contains("target"))).toEqual([true, false]);
    expect(elements.edgeGroup.querySelectorAll(".edge-path.missing")).toHaveLength(2);
  });

  it("staggers two hanging off one pin so neither covers the other", () => {
    const { looseEnds } = setup(
      [node("showText-1", "showText")],
      [wire("showText-1", "text", "gone-1", "text"), wire("showText-1", "text", "gone-2", "text")],
    );
    const [first, second] = looseEnds().map((end) => end.style.transform);
    expect(first).not.toBe(second);
  });

  it("draws none for a node that is in the file but of a type this build lacks, or with neither end drawn", () => {
    const { elements, looseEnds } = setup(
      [node("showText-1", "showText"), node("future-1", "noSuchType")],
      [wire("showText-1", "text", "future-1", "text"), wire("gone-1", "text", "gone-2", "text")],
    );
    expect(looseEnds()).toHaveLength(0);
    expect(elements.edgeGroup.querySelectorAll(".edge-path")).toHaveLength(0);
  });

  it("disconnects from its right-click menu, leaving the other wires", () => {
    const kept = wire("showText-1", "text", "showText-2", "text");
    const { contextMenu, looseEnds, lastSave } = setup(
      [node("showText-1", "showText"), node("showText-2", "showText")],
      [kept, wire("showText-2", "text", "gone-1", "text")],
    );
    looseEnds()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(contextMenu.open).toHaveBeenCalledOnce();
    const items: { label: string; run?: () => void }[] = contextMenu.open.mock.calls[0][0].items;
    items.find((item) => item.label === "Disconnect")?.run?.();
    expect(lastSave()?.edges).toEqual([kept]);
    expect(looseEnds()).toHaveLength(0);
  });

  it("only disconnects when the pin it hangs from is itself missing, naming no type", () => {
    const { contextMenu, looseEnds } = setup(
      [node("showText-1", "showText")],
      [wire("showText-1", "renamed", "gone-1", "text")],
    );
    const [end] = looseEnds();
    expect(end.classList.contains("disconnect-only")).toBe(true);
    end.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items: { label: string }[] = contextMenu.open.mock.calls[0][0].items;
    expect(items.map((item) => item.label)).toEqual(["Disconnect"]);
  });

  // Facing each other across a gap, their labels would run together.
  it("drops a loose end below another it would cover, whichever pin that one hangs from", () => {
    const { looseEnds } = setup(
      [node("showText-1", "showText"), node("showText-2", "showText", 240)],
      [wire("showText-1", "text", "gone-1", "text"), wire("gone-2", "text", "showText-2", "text")],
    );
    expect(looseEnds().map(rowOf)).toEqual([0, 24]);
  });

  it("leaves loose ends that don't meet on their pins' row", () => {
    const { looseEnds } = setup(
      [node("showText-1", "showText"), node("showText-2", "showText", 1000)],
      [wire("showText-1", "text", "gone-1", "text"), wire("gone-2", "text", "showText-2", "text")],
    );
    expect(looseEnds().map(rowOf)).toEqual([0, 0]);
  });

  it("offers nothing in a locked Flow", () => {
    const { looseEnds } = setup(
      [node("showText-1", "showText")],
      [wire("showText-1", "text", "gone-1", "text")],
      "newer-format",
    );
    const [end] = looseEnds();
    expect(end.classList.contains("inert")).toBe(true);
    expect(end.dataset.tooltip).toBe('This Flow has no node "gone-1".');
  });
});
