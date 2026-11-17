import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { createFlowProblemReport } from "../../../web/flow/flowProblemReport.ts";

function node(id: string, type: string, extra: Partial<FlowNodeInstance> = {}): FlowNodeInstance {
  return { id, type, position: { x: 0, y: 0 }, config: {}, ...extra } as FlowNodeInstance;
}

const PATH = "flows/a.flow.html";

describe("createFlowProblemReport", () => {
  it("lists each missing file under its node's name, after the graph's own problems, in node order", () => {
    const report = vi.fn();
    const problems = createFlowProblemReport(report);
    const graph: FlowGraph = {
      nodes: [node("show-1", "showText"), node("load-2", "loadNote", { label: "Scene" }), node("load-1", "loadNote")],
      edges: [{ id: "e", source: "show-1", sourcePort: "reply", target: "show-1", targetPort: "text" }],
    };
    problems.opened(PATH, graph);
    expect(report).toHaveBeenLastCalledWith(PATH, [
      'Show Text "show-1": a wire comes out of "reply", a pin it doesn\'t have.',
    ]);

    problems.fileMissing("load-1", 'No file at "flows/a.md"');
    problems.fileMissing("load-2", 'No file at "flows/b.md"');
    expect(report).toHaveBeenLastCalledWith(PATH, [
      'Show Text "show-1": a wire comes out of "reply", a pin it doesn\'t have.',
      'Scene "load-2": No file at "flows/b.md"',
      'Load Note "load-1": No file at "flows/a.md"',
    ]);
  });

  it("forgets a file found again, a removed node's, and every one when the Flow reopens", () => {
    const report = vi.fn();
    const problems = createFlowProblemReport(report);
    const graph: FlowGraph = { nodes: [node("load-1", "loadNote"), node("load-2", "loadNote")], edges: [] };
    problems.opened(PATH, graph);
    problems.fileMissing("load-1", 'No file at "a.md"');
    problems.fileMissing("load-2", 'No file at "b.md"');
    problems.fileMissing("load-2", undefined);
    expect(report).toHaveBeenLastCalledWith(PATH, ['Load Note "load-1": No file at "a.md"']);

    // A node made later under a removed one's id has its own card to check.
    problems.onGraphChange(PATH, { nodes: [node("load-2", "loadNote")], edges: [] });
    expect(report).toHaveBeenLastCalledWith(PATH, []);
    problems.onGraphChange(PATH, graph);
    expect(report).toHaveBeenLastCalledWith(PATH, []);

    problems.fileMissing("load-1", 'No file at "a.md"');
    problems.opened(PATH, graph);
    expect(report).toHaveBeenLastCalledWith(PATH, []);
  });

  it("reports nothing until a Flow has opened", () => {
    const report = vi.fn();
    createFlowProblemReport(report).fileMissing("load-1", 'No file at "a.md"');
    expect(report).not.toHaveBeenCalled();
  });
});
