// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileResponse, FlowFileResponse } from "../../../src/protocol/api.ts";
import type { FlowGraph } from "../../../src/protocol/types.ts";
import { editProposal, pendingChanges } from "../../../web/editProposal.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import type { DocumentAccess } from "../../../web/services/documentAccess.ts";
import { createToolkitRunner } from "../../../web/view/toolkitRunner.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

beforeEach(() => {
  document.body.replaceChildren();
});

function flowFile(graph: FlowGraph): FlowFileResponse {
  return {
    kind: "flow",
    path: "tools/p.flow.html",
    revision: "r1",
    version: "1.0",
    name: "P",
    graph,
    capabilities: [{ type: "readCurrentDocument" }],
    grantedCapabilities: ["readCurrentDocument"],
    runsUnattended: false,
  };
}

// A Button feeding Replace Selection the selection with "hi " before it,
// through a Show Text exposed so the run has a result to show.
const replacing = flowFile({
  nodes: [
    { id: "go", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Say hi" },
    { id: "say", type: "joinText", position: { x: 150, y: 0 }, config: { text_1: "hi ", separator: "" } },
    { id: "see", type: "showText", position: { x: 300, y: 0 }, config: {}, exposed: ["text"] },
    { id: "put", type: "replaceSelection", position: { x: 450, y: 0 }, config: {} },
  ],
  edges: [
    { id: "e1", source: "go", sourcePort: "selection", target: "say", targetPort: "text_2" },
    { id: "e2", source: "say", sourcePort: "text", target: "see", targetPort: "text" },
    { id: "e3", source: "see", sourcePort: "text", target: "put", targetPort: "text" },
  ],
});

function setup() {
  const deps = {
    dialog: createDialogService(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    grant: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    loadFile: vi.fn<(path: string) => Promise<FileResponse>>(),
    modelConsole: { logLlmCall: vi.fn(), beginLlmActivity: vi.fn(), endLlmActivity: vi.fn() },
    notices: { begin: vi.fn(), add: vi.fn() },
  };
  const runner = createToolkitRunner(deps);
  const view = new EditorView({
    state: EditorState.create({ doc: "hello", extensions: [editProposal({ barHost: document.body })] }),
    parent: document.body,
  });
  const access = {
    assertAccessible: vi.fn(),
    snapshot: vi.fn(() => ({ content: "hello", text: "hello", from: 0, to: 5 })),
    editor: vi.fn(() => view),
  } as unknown as DocumentAccess;
  const invocation = {
    flow: { path: "tools/p.flow.html", name: "P" },
    path: "n.md",
    source: { kind: "text" as const, access },
    openToSide: vi.fn(async () => {}),
  };
  return { runner, deps, view, invocation };
}

describe("createToolkitRunner", () => {
  it("runs the action, reading the flow fresh, and shows what it exposes", async () => {
    const { runner, deps, view, invocation } = setup();
    deps.loadFile.mockResolvedValueOnce(replacing);

    const shown = await runner.start(invocation, "go").done;

    expect(deps.loadFile).toHaveBeenCalledWith("tools/p.flow.html");
    expect(shown).toEqual({ lines: ["Show Text · text: hi hello"], warnings: [] });
    // The proposal is drawn as what changes: "hi " before the selection.
    expect(pendingChanges(view.state).map((change) => change.insert)).toEqual(["hi "]);
  });

  it("shows what a Show Result node shows, ahead of what the flow exposes", async () => {
    const { runner, deps, view, invocation } = setup();
    deps.loadFile.mockResolvedValueOnce(
      flowFile({
        nodes: [
          { id: "go", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Summary" },
          { id: "see", type: "showText", position: { x: 150, y: 0 }, config: {}, exposed: ["text"] },
          { id: "show", type: "showResult", position: { x: 300, y: 0 }, config: {} },
        ],
        edges: [
          { id: "e1", source: "go", sourcePort: "selection", target: "see", targetPort: "text" },
          { id: "e2", source: "see", sourcePort: "text", target: "show", targetPort: "text" },
        ],
      }),
    );

    const shown = await runner.start(invocation, "go").done;

    expect(shown).toEqual({ lines: ["hello", "Show Text · text: hello"], warnings: [] });
    expect(pendingChanges(view.state)).toEqual([]);
  });

  it("shows a receipt under the button, and proposes nothing", async () => {
    const { runner, deps, view, invocation } = setup();
    deps.loadFile.mockResolvedValueOnce(
      flowFile({
        nodes: [
          { id: "go", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Save idea" },
          { id: "say", type: "joinText", position: { x: 150, y: 0 }, config: { text_1: "Saved: ", separator: "" } },
          { id: "show", type: "showResult", position: { x: 300, y: 0 }, config: {} },
        ],
        edges: [
          { id: "e1", source: "go", sourcePort: "selection", target: "say", targetPort: "text_2" },
          { id: "e2", source: "say", sourcePort: "text", target: "show", targetPort: "text" },
        ],
      }),
    );

    const shown = await runner.start(invocation, "go").done;

    expect(shown).toEqual({ lines: ["Saved: hello"], warnings: [] });
    expect(pendingChanges(view.state)).toEqual([]);
  });

  it("a tab switch stops it before anything is proposed", async () => {
    const { runner, deps, view, invocation } = setup();
    let load: (file: FileResponse) => void = () => {};
    deps.loadFile.mockReturnValueOnce(new Promise<FileResponse>((resolve) => (load = resolve)));

    const run = runner.start(invocation, "go");
    run.stop("The document changed");
    load(replacing);

    await expect(run.done).rejects.toThrow("The document changed");
    expect(pendingChanges(view.state)).toEqual([]);
  });

  // Each run asks through a broker of its own, so a second click neither
  // stops the first run nor answers its prompts.
  it("runs a second click beside the first, and stops only the run told to", async () => {
    const { runner, deps, invocation } = setup();
    const showing = flowFile({
      nodes: [
        { id: "go", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Summary" },
        { id: "show", type: "showResult", position: { x: 150, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "go", sourcePort: "selection", target: "show", targetPort: "text" }],
    });
    const loads: ((file: FileResponse) => void)[] = [];
    deps.loadFile.mockImplementation(() => new Promise<FileResponse>((resolve) => loads.push(resolve)));
    const first = runner.start(invocation, "go");
    const second = runner.start(invocation, "go");
    loads[1](showing);
    expect(await second.done).toEqual({ lines: ["hello"], warnings: [] });
    loads[0](showing);
    expect(await first.done).toEqual({ lines: ["hello"], warnings: [] });

    const kept = runner.start(invocation, "go");
    const stopped = runner.start(invocation, "go");
    stopped.stop("The run was cancelled");
    loads[3](showing);
    await expect(stopped.done).rejects.toThrow("The run was cancelled");
    runner.dispose();
    loads[2](showing);
    await expect(kept.done).rejects.toThrow("The toolkit runner was disposed");
  });
});
