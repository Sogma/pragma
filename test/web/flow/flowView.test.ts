// @vitest-environment jsdom
import { XYHandle } from "@xyflow/system";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { parseFlowFile } from "../../../src/protocol/flowFile.ts";
import { FLOW_NODE_REGISTRY } from "../../../src/protocol/flowNodes.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { type FlowFileResponse, sandboxGenerate, sandboxGenerateImage } from "../../../web/core/apiClient.ts";
import { createFlowElements } from "../../../web/flow/flowElements.ts";
import { registerFlowKeys } from "../../../web/flow/flowKeys.ts";
import { createFlowView } from "../../../web/flow/xyflowAdapter.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { emptyModelLists } from "../support/emptyModelLists.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchModelOptions: vi.fn(async () => []),
  fetchImageModelOptions: vi.fn(async () => []),
  sandboxGenerate: vi.fn(async () => ({ reply: "a reply", model: "test/text" })),
  sandboxGenerateImage: vi.fn(async () => ({
    image: { mediaType: "image/png", data: "" },
    path: "out/result.png",
    model: "test/image",
    reused: false,
    warnings: [],
  })),
  // The one Table the opening cases below read.
  sandboxRead: vi.fn(async () => ({
    kind: "table",
    columns: [{ id: "n", label: "N", type: "integer" }],
    rows: [{ values: { n: "1" } }],
  })),
}));

// The folders the opening cases below name, as the space tree lists them.
vi.mock("../../../web/core/spaceTree.ts", async (importOriginal) => {
  const folders: Record<string, { name: string; path: string; type: "file" }[]> = {
    notes: [{ name: "a.md", path: "notes/a.md", type: "file" }],
    stills: [{ name: "a.png", path: "stills/a.png", type: "file" }],
  };
  return { ...(await importOriginal<object>()), findDirectoryChildren: (dirPath: string) => folders[dirPath] };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// jsdom lays nothing out, so there is no resize to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function file(): FlowFileResponse {
  return {
    kind: "flow",
    path: "flows/sized.flow.html",
    revision: "rev-1",
    version: "1.0",
    graph: {
      nodes: [
        {
          id: "comment-1",
          type: "comment",
          typeVersion: "1.0",
          position: { x: 0, y: 0 },
          config: { text: "Brief" },
          size: { width: 300, height: 200 },
          label: "Brief",
          color: "#0b6e99",
          appModeOrder: 1,
          appModeSize: { columns: 3, rows: 2 },
        },
      ],
      edges: [],
      runAppModeOrder: 0,
      runAppModeSize: { columns: 2, rows: 1 },
    },
    capabilities: [],
    grantedCapabilities: [],
    runsUnattended: false,
  };
}

function setup() {
  const elements = createFlowElements();
  const scheduleSave = vi.fn();
  const contextMenu = { open: vi.fn() };
  const view = createFlowView(elements, {
    scheduleSave,
    contextMenu,
    modelLists: emptyModelLists(),
    onRendered: vi.fn(),
    onAppModeChange: vi.fn(),
    problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
  } as unknown as Parameters<typeof createFlowView>[1]);
  view.render(file());
  const lastSave = () => parseFlowFile(scheduleSave.mock.calls.at(-1)?.[1])?.graph;
  return { contextMenu, elements, lastSave, scheduleSave, view };
}

describe("flowView", () => {
  // The view rebuilds its live graph from the file it renders, so a field it
  // fails to carry shows for the session and is gone from the next save.
  it("saves the App mode layout of the file it rendered", () => {
    const { lastSave, view } = setup();
    view.setMetadata([]); // saves without editing the graph
    const saved = lastSave();
    expect([saved?.runAppModeOrder, saved?.runAppModeSize]).toEqual([0, { columns: 2, rows: 1 }]);
    expect(saved?.nodes[0]?.appModeSize).toEqual({ columns: 3, rows: 2 });
  });

  it("writes the metadata block with the next autosave, and never over a locked flow", () => {
    const { scheduleSave, view } = setup();
    const savedMetadata = () => parseFlowFile(scheduleSave.mock.calls.at(-1)?.[1])?.metadata;
    const metadata = [
      { key: "description", values: ["Sizes the brief."] },
      { key: "tags", values: ["brief", "draft"] },
    ];
    view.setMetadata(metadata);
    expect(savedMetadata()).toEqual(metadata);
    view.setMetadata([]);
    expect(savedMetadata()).toEqual([]);

    view.render({ ...file(), locked: "newer-format" });
    const saves = scheduleSave.mock.calls.length;
    view.setMetadata(metadata);
    expect(scheduleSave.mock.calls.length).toBe(saves);
  });

  it("a clone carries every field of its source but its id and position", () => {
    const { contextMenu, elements, lastSave } = setup();
    const title = elements.pane.querySelector(".flow-node-title") as HTMLElement;
    title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items: { label: string; run?: () => void }[] = contextMenu.open.mock.calls[0][0].items;
    items.find((item) => item.label === "Clone")?.run?.();
    const [source, clone] = lastSave()?.nodes ?? [];
    expect(clone).toEqual({ ...source, id: "comment-2", position: { x: 30, y: 30 } });
  });
});

function promptNode(text: string): FlowNodeInstance {
  return { id: "prompt-1", type: "prompt", typeVersion: "1.0", position: { x: 0, y: 0 }, config: { text } };
}

function imageFlow(prompt: string): FlowFileResponse {
  const image: FlowNodeInstance = {
    id: "generateImage-2",
    type: "generateImage",
    typeVersion: "1.0",
    position: { x: 300, y: 0 },
    config: { outputFolderPath: "out" },
  };
  const wire: FlowEdgeInstance = {
    id: "e1",
    source: "prompt-1",
    sourcePort: "text",
    target: "generateImage-2",
    targetPort: "prompt",
  };
  return flowFile("flows/image.flow.html", [promptNode(prompt), image], [wire]);
}

function flowFile(path: string, nodes: FlowNodeInstance[], edges: FlowEdgeInstance[] = []): FlowFileResponse {
  return {
    kind: "flow",
    path,
    revision: "rev-1",
    version: "1.0",
    graph: { nodes, edges },
    capabilities: [],
    grantedCapabilities: ["generateImage:space:flows/out", "generateText"],
    runsUnattended: false,
  };
}

function heldFlow(prompt: string): FlowFileResponse {
  const generate: FlowNodeInstance = {
    id: "generate-2",
    type: "generateText",
    typeVersion: "1.0",
    position: { x: 300, y: 0 },
    config: { reuse: "true" },
  };
  const wire: FlowEdgeInstance = {
    id: "e1",
    source: "prompt-1",
    sourcePort: "text",
    target: "generate-2",
    targetPort: "prompt",
  };
  return flowFile("flows/held.flow.html", [promptNode(prompt), generate], [wire]);
}

function runnableView() {
  const elements = createFlowElements();
  const onRunsChange = vi.fn();
  const openToSide = vi.fn(async (_path: string) => {});
  const view = createFlowView(elements, {
    scheduleSave: vi.fn(),
    saveNow: vi.fn(async () => true),
    contextMenu: { open: vi.fn() },
    modelLists: emptyModelLists(),
    onRendered: vi.fn(),
    onAppModeChange: vi.fn(),
    problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
    onRunsChange,
    showRuns: vi.fn(),
    modelConsole: { beginLlmActivity: vi.fn(), endLlmActivity: vi.fn(), logLlmCall: vi.fn() },
    spent: vi.fn(),
    documentWritten: vi.fn(),
    openToSide,
  } as unknown as Parameters<typeof createFlowView>[1]);
  // Clicks the Generate Image card's Regenerate and resolves the prompt its
  // image call was sent, once the run has ended.
  async function regenerate(): Promise<string | undefined> {
    const reports = onRunsChange.mock.calls.length;
    const button = [...elements.pane.querySelectorAll("button")].find((b) => b.textContent === "Regenerate");
    button?.click();
    await vi.waitFor(() => {
      expect(onRunsChange.mock.calls.length).toBeGreaterThan(reports);
      expect(onRunsChange.mock.calls.at(-1)?.[0]).toEqual([]);
    });
    return vi.mocked(sandboxGenerateImage).mock.calls.at(-1)?.[2].prompt;
  }
  return { view, regenerate, elements, openToSide };
}

// Your view, the canvas's place and the App mode switch, is only reported:
// the file keeps the Flow's default view, which a person sets on purpose
// (docs/protocol.md, Graph shape).
describe("flowView default view", () => {
  function viewportView() {
    const elements = createFlowElements();
    const scheduleSave = vi.fn();
    const saveNow = vi.fn(async (_path: string, _content: string) => true);
    const onViewportChange = vi.fn();
    const onAppModeChange = vi.fn();
    const view = createFlowView(elements, {
      scheduleSave,
      saveNow,
      contextMenu: { open: vi.fn() },
      modelLists: emptyModelLists(),
      onRendered: vi.fn(),
      onAppModeChange,
      onViewportChange,
      problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
    } as unknown as Parameters<typeof createFlowView>[1]);
    // The toolbar's zoom slider: a d3-zoom gesture that ends at once.
    const zoomTo = async (percent: number) => {
      elements.canvasToolbarZoomSlider.value = String(percent);
      elements.canvasToolbarZoomSlider.dispatchEvent(new Event("input"));
      await tick();
    };
    const lastSaved = (save: typeof scheduleSave | typeof saveNow) =>
      parseFlowFile(save.mock.calls.at(-1)?.[1] as string)?.graph;
    return { elements, lastSaved, onAppModeChange, onViewportChange, saveNow, scheduleSave, view, zoomTo };
  }

  it("reports a zoom and an App mode switch without saving, and an edit keeps the file's view", async () => {
    const { lastSaved, onAppModeChange, onViewportChange, scheduleSave, view, zoomTo } = viewportView();
    view.render(file());
    await zoomTo(150);
    view.toggleAppMode();
    expect(onViewportChange).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, zoom: 1.5 });
    expect(onAppModeChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(scheduleSave).not.toHaveBeenCalled();

    view.setMetadata([{ key: "description", values: ["Sizes the brief."] }]);
    expect(lastSaved(scheduleSave)?.viewport).toBeUndefined();
    expect(lastSaved(scheduleSave)?.appModeActive).toBeUndefined();
  });

  it("opens in the view it's handed over the file's, reporting none for the open", async () => {
    const { elements, lastSaved, onAppModeChange, onViewportChange, scheduleSave, view } = viewportView();
    const opened = file();
    opened.graph.viewport = { x: 10, y: 20, zoom: 1 };
    view.render(opened, { viewport: { x: -30, y: 40, zoom: 0.5 }, appMode: true });
    await tick();
    expect(elements.viewport.style.transform).toBe("translate(-30px, 40px) scale(0.5)");
    expect(view.isAppModeActive()).toBe(true);
    expect([onViewportChange, onAppModeChange].map((hook) => hook.mock.calls.length)).toEqual([0, 0]);

    view.setMetadata([]);
    expect(lastSaved(scheduleSave)?.viewport).toEqual({ x: 10, y: 20, zoom: 1 });
    expect(lastSaved(scheduleSave)?.appModeActive).toBeUndefined();
  });

  it("makes the view shown the default in one awaited save, and then has nothing to set", async () => {
    const { lastSaved, saveNow, view, zoomTo } = viewportView();
    view.render(file());
    expect(view.defaultViewDiffers()).toBe(false);
    await zoomTo(150);
    view.toggleAppMode();
    expect(view.defaultViewDiffers()).toBe(true);

    expect(await view.setDefaultView()).toBe(true);
    expect([lastSaved(saveNow)?.viewport, lastSaved(saveNow)?.appModeActive]).toEqual([
      { x: 0, y: 0, zoom: 1.5 },
      true,
    ]);
    expect(view.defaultViewDiffers()).toBe(false);

    // Back on the canvas, the flag goes rather than reading false.
    view.toggleAppMode();
    await view.setDefaultView();
    expect(saveNow.mock.calls.at(-1)?.[1]).not.toContain("appModeActive");
    expect(saveNow).toHaveBeenCalledTimes(2);
  });

  it("offers nothing to set on a locked Flow", async () => {
    const { saveNow, view } = viewportView();
    view.render({ ...file(), locked: "newer-format" }, { viewport: { x: 5, y: 5, zoom: 1 }, appMode: true });
    expect(view.defaultViewDiffers()).toBe(false);
    expect(await view.setDefaultView()).toBe(false);
    expect(saveNow).not.toHaveBeenCalled();
  });
});

describe("flowView Open to the Side", () => {
  it("opens the file a canvas run names beside the Flow's group", async () => {
    const { view, openToSide } = runnableView();
    const open: FlowNodeInstance = {
      id: "openToSide-1",
      type: "openToSide",
      position: { x: 0, y: 0 },
      config: { documentPath: "space:notes/summary.md" },
    };
    view.render(flowFile("flows/open.flow.html", [open]));
    await view.run();
    expect(openToSide).toHaveBeenCalledWith("notes/summary.md");
  });
});

describe("flowView Regenerate", () => {
  // One view shows every Flow its group opens, and node ids repeat across
  // Flows: every Flow's first Prompt is prompt-1.
  it("never runs on another Flow's outputs under the same node id", async () => {
    const { view, regenerate } = runnableView();
    view.render(flowFile("flows/other.flow.html", [promptNode("from the other Flow")]));
    await view.run();
    view.render(imageFlow("from this Flow"));
    expect(await regenerate()).toBe("from this Flow");
  });

  // Every tab switch renders the Flow afresh, and Regenerate after one still
  // runs on what the last run fed the node, not on the Prompt as it now reads.
  it("runs on its own Flow's last outputs after a tab switch", async () => {
    const { view, regenerate } = runnableView();
    view.render(imageFlow("as run"));
    await view.run();
    view.render(flowFile("flows/other.flow.html", [promptNode("from the other Flow")]));
    view.render(imageFlow("edited since"));
    expect(await regenerate()).toBe("as run");
  });
});

describe("flowView Reuse result on repeat", () => {
  // The memory outlives a tab switch, and only a change in what the node
  // receives sends it to the model again.
  it("asks the model once while a held node's inputs repeat, and again when they change", async () => {
    const calls = () => vi.mocked(sandboxGenerate).mock.calls.length;
    const before = calls();
    const { view } = runnableView();
    view.render(heldFlow("a brief"));
    await view.run();
    await view.run();
    expect(calls()).toBe(before + 1);

    view.render(flowFile("flows/other.flow.html", [promptNode("elsewhere")]));
    view.render(heldFlow("a brief"));
    await view.run();
    expect(calls()).toBe(before + 1);

    view.render(heldFlow("another brief"));
    await view.run();
    expect(calls()).toBe(before + 2);
  });

  // Regenerate asks for a new reply though the inputs repeat, and the next
  // Run holds that one. Only a type that finds its own results takes a seed.
  it("Regenerate on a held node asks the model again, and the next Run holds the new reply", async () => {
    const calls = () => vi.mocked(sandboxGenerate).mock.calls.length;
    const { view, regenerate } = runnableView();
    const file = heldFlow("a brief");
    view.render(file);
    await view.run();
    const before = calls();
    await regenerate();
    expect(calls()).toBe(before + 1);
    expect(file.graph.nodes[1].config.seed).toBeUndefined();

    await view.run();
    expect(calls()).toBe(before + 1);
  });
});

type OpenCase = { type: string; config: Record<string, unknown>; exposed?: string[]; appMode: boolean; saves: boolean };

// Each node type first and a marker after it, so a save composed while the
// cards are built shows whether it held the whole graph. An empty pick, or a
// stale weight column, makes the card save as it's built, and its App mode
// field too when the pick is exposed: those cases test a save mid-open.
describe("opening a Flow", () => {
  const savingPicks = [
    { type: "loadFolderNote", config: { folderPath: "../notes/" }, exposed: ["notePath"] },
    { type: "loadFolderImage", config: { folderPath: "../stills/" }, exposed: ["imagePath"] },
    { type: "loadRow", config: { tablePath: "t.table.html" }, exposed: ["selectedValue"] },
    { type: "loadRandomRow", config: { tablePath: "t.table.html", weightColumn: "gone" } },
  ];
  const cases: OpenCase[] = [
    ...Object.keys(FLOW_NODE_REGISTRY).map((type) => ({ type, config: {}, appMode: false, saves: false })),
    ...savingPicks.flatMap((pick) => [false, true].map((appMode) => ({ ...pick, appMode, saves: true }))),
  ];

  it.each(cases)("never saves fewer nodes than it holds: $type, App mode $appMode", async (open) => {
    const elements = createFlowElements();
    const scheduleSave = vi.fn();
    const saveNow = vi.fn(async () => true);
    const view = createFlowView(elements, {
      scheduleSave,
      saveNow,
      contextMenu: { open: vi.fn() },
      modelLists: emptyModelLists(),
      onRendered: vi.fn(),
      onAppModeChange: vi.fn(),
      problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
    } as unknown as Parameters<typeof createFlowView>[1]);
    const first: FlowNodeInstance = {
      id: `${open.type}-1`,
      type: open.type,
      position: { x: 0, y: 0 },
      // A card repairs its pick in place, so each case gets its own copy.
      config: structuredClone(open.config),
      exposed: open.exposed,
    };
    const marker: FlowNodeInstance = { id: "showObject-9", type: "showObject", position: { x: 400, y: 0 }, config: {} };
    const flow = flowFile("flows/open.flow.html", [first, marker]);
    flow.graph.appModeActive = open.appMode;
    flow.grantedCapabilities = ["readFile:space:flows/t.table.html"];
    view.render(flow);
    for (let i = 0; i < 3; i++) await tick();

    const saved = [...scheduleSave.mock.calls, ...saveNow.mock.calls].map(([, content]) =>
      parseFlowFile(content as string)?.graph.nodes.map((node) => node.id),
    );
    if (open.saves) expect(saved.length).toBeGreaterThan(0);
    for (const ids of saved) expect(ids).toEqual([first.id, marker.id]);
    expect(elements.lockNotice.hidden).toBe(true);
  });
});

function guardedView(nodes: FlowNodeInstance[]) {
  const elements = createFlowElements();
  const scheduleSave = vi.fn();
  const onGraphChange = vi.fn();
  const contextMenu = { open: vi.fn() };
  const view = createFlowView(elements, {
    scheduleSave,
    contextMenu,
    modelLists: emptyModelLists(),
    dialog: { confirm: vi.fn(async () => true) },
    onRendered: vi.fn(),
    onAppModeChange: vi.fn(),
    problems: { onGraphChange, fileMissing: vi.fn() },
  } as unknown as Parameters<typeof createFlowView>[1]);
  view.render(flowFile("flows/guard.flow.html", nodes));
  const savedIds = () => parseFlowFile(scheduleSave.mock.calls.at(-1)?.[1])?.graph.nodes.map((node) => node.id);
  // The live graph the view last reported, for taking a node out behind its back.
  const liveGraph = () => onGraphChange.mock.calls.at(-1)?.[1] as FlowGraph;
  // Runs an item of the menu on the index-th node's title.
  const runNodeMenuItem = (index: number, label: string) => {
    const title = elements.pane.querySelectorAll(".flow-node-title")[index];
    title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items: { label: string; run?: () => void }[] = contextMenu.open.mock.calls.at(-1)?.[0].items;
    items.find((item) => item.label === label)?.run?.();
  };
  return { elements, liveGraph, runNodeMenuItem, savedIds, scheduleSave, view };
}

const commentNode = (id: string): FlowNodeInstance => ({
  id,
  type: "comment",
  position: { x: 0, y: 0 },
  config: { text: id },
});

// Whatever took a node out of the graph, a save without it deletes it from
// the file. Only Remove and Undo may.
describe("flowView saves", () => {
  it("refuses a save missing a node Remove didn't take out, and says so on the canvas", () => {
    const { elements, liveGraph, scheduleSave, view } = guardedView([
      commentNode("comment-1"),
      commentNode("comment-2"),
    ]);
    view.setMetadata([]);
    liveGraph().nodes.pop();
    view.setMetadata([]);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(elements.lockNotice.hidden).toBe(false);
    expect(elements.lockNotice.textContent).toContain("deleted 1 node");
  });

  it("saves without a node Remove took out", async () => {
    const { elements, runNodeMenuItem, savedIds } = guardedView([commentNode("comment-1"), commentNode("comment-2")]);
    runNodeMenuItem(1, "Remove");
    await tick();
    expect(savedIds()).toEqual(["comment-1"]);
    expect(elements.lockNotice.hidden).toBe(true);
  });

  it("keeps a node added since the file opened once a save has held it", () => {
    const { elements, liveGraph, runNodeMenuItem, savedIds, view } = guardedView([commentNode("comment-1")]);
    runNodeMenuItem(0, "Clone");
    expect(savedIds()).toEqual(["comment-1", "comment-2"]);
    liveGraph().nodes.pop();
    view.setMetadata([]);
    expect(savedIds()).toEqual(["comment-1", "comment-2"]);
    expect(elements.lockNotice.hidden).toBe(false);
  });
});

// A Flow on the page, with the canvas's keys bound as the app binds them.
function keyedView(nodes: FlowNodeInstance[], edges: FlowEdgeInstance[] = []) {
  const elements = createFlowElements();
  document.body.append(elements.root);
  const scheduleSave = vi.fn();
  const contextMenu = { open: vi.fn() };
  const view = createFlowView(elements, {
    scheduleSave,
    saveNow: vi.fn(async () => true),
    contextMenu,
    modelLists: emptyModelLists(),
    onRendered: vi.fn(),
    onAppModeChange: vi.fn(),
    problems: { onGraphChange: vi.fn(), fileMissing: vi.fn() },
    onRunsChange: vi.fn(),
    showRuns: vi.fn(),
    modelConsole: { beginLlmActivity: vi.fn(), endLlmActivity: vi.fn(), logLlmCall: vi.fn() },
    spent: vi.fn(),
    documentWritten: vi.fn(),
  } as unknown as Parameters<typeof createFlowView>[1]);
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const context = (): CommandContext => ({ tab: { kind: "empty" }, pane: undefined });
  const attached = keybindings.attach(document, context);
  registerFlowKeys(commands, keybindings, () => view);
  onTestFinished(() => {
    attached.dispose();
    view.clear();
    elements.root.remove();
  });
  view.render(flowFile("flows/keys.flow.html", nodes, edges));

  const card = (id: string) => elements.pane.querySelector<HTMLElement>(`.flow-node[data-node-id="${id}"]`);
  // A press on a card selects it, and the canvas takes the keyboard. The
  // right button, since a left press starts a drag, which needs the event's
  // window and jsdom takes none.
  const click = (target: Element) => {
    for (const type of ["pointerdown", "mousedown"])
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 2 }));
    elements.pane.focus();
  };
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  const type = (input: HTMLInputElement, value: string) => {
    input.focus();
    press(value.at(-1) ?? "Backspace");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const saved = () => parseFlowFile(scheduleSave.mock.calls.at(-1)?.[1])?.graph;
  const savedIds = () => saved()?.nodes.map((node) => node.id);
  return { card, click, contextMenu, elements, press, saved, savedIds, type, view };
}

const joinNode = (id: string, x = 0): FlowNodeInstance => ({ id, type: "joinText", position: { x, y: 0 }, config: {} });
const showNode = (id: string): FlowNodeInstance => ({ id, type: "showText", position: { x: 400, y: 0 }, config: {} });
const joinToShow: FlowEdgeInstance = {
  id: "e1",
  source: "joinText-1",
  sourcePort: "text",
  target: "showText-2",
  targetPort: "text",
};

describe("flowView keys", () => {
  it("removes the selected node on Delete, and Undo and Redo take it back and again", () => {
    const { card, click, press, saved, savedIds } = keyedView(
      [joinNode("joinText-1"), showNode("showText-2")],
      [joinToShow],
    );
    click(card("showText-2") as HTMLElement);
    press("Delete");
    expect(savedIds()).toEqual(["joinText-1"]);
    expect(saved()?.edges).toEqual([]);
    expect(card("showText-2")).toBeNull();

    press("z", { ctrlKey: true });
    expect(savedIds()).toEqual(["joinText-1", "showText-2"]);
    expect(saved()?.edges).toEqual([joinToShow]);
    expect(card("showText-2")).not.toBeNull();

    press("Z", { ctrlKey: true, shiftKey: true });
    expect(savedIds()).toEqual(["joinText-1"]);
    press("z", { ctrlKey: true });
    press("y", { ctrlKey: true });
    expect(savedIds()).toEqual(["joinText-1"]);
  });

  // A Mac's Delete key sends Backspace.
  it("removes the selected node on Backspace", () => {
    const { card, click, press, savedIds } = keyedView([joinNode("joinText-1"), showNode("showText-2")]);
    click(card("joinText-1") as HTMLElement);
    press("Backspace");
    expect(savedIds()).toEqual(["showText-2"]);
  });

  it("leaves Delete and Ctrl+Z to a card's text field while it has focus", () => {
    const { card, click, elements, press, saved, type, view } = keyedView([joinNode("joinText-1")]);
    click(card("joinText-1") as HTMLElement);
    const input = card("joinText-1")?.querySelector<HTMLInputElement>("input.form-input") as HTMLInputElement;
    type(input, "a");
    press("Delete");
    expect(card("joinText-1")).not.toBeNull();
    expect(view.canEdit("undo")).toBe(false);
    press("z", { ctrlKey: true });
    expect(saved()?.nodes[0].config.text_1).toBe("a");

    elements.pane.focus();
    press("z", { ctrlKey: true });
    expect(saved()?.nodes[0].config.text_1).toBeUndefined();
  });

  // Run results and an Applet's live frame are the card's, so a card whose
  // node the Undo leaves alone is never built again.
  it("builds again only the card whose node the Undo changes", () => {
    const { card, click, elements, press, saved, type } = keyedView([
      joinNode("joinText-1"),
      joinNode("joinText-2", 300),
    ]);
    const [first, second] = [card("joinText-1"), card("joinText-2")];
    click(first as HTMLElement);
    type(first?.querySelector("input.form-input") as HTMLInputElement, "typed");
    elements.pane.focus();
    press("z", { ctrlKey: true });
    expect(saved()?.nodes[0].config.text_1).toBeUndefined();
    expect(card("joinText-1")).not.toBe(first);
    expect(card("joinText-2")).toBe(second);
  });

  it("keeps a Flow's history through a tab switch", () => {
    const { card, click, elements, press, saved, savedIds, view } = keyedView([
      joinNode("joinText-1"),
      showNode("showText-2"),
    ]);
    click(card("showText-2") as HTMLElement);
    press("Delete");
    const graph = saved() as FlowGraph;
    view.render(flowFile("flows/other.flow.html", [joinNode("joinText-1")]));
    view.render(flowFile("flows/keys.flow.html", graph.nodes, graph.edges));
    elements.pane.focus();
    press("z", { ctrlKey: true });
    expect(savedIds()).toEqual(["joinText-1", "showText-2"]);
  });

  it("saves an Undo that takes out a node it added", () => {
    const { card, click, contextMenu, elements, press, savedIds } = keyedView([joinNode("joinText-1")]);
    const title = card("joinText-1")?.querySelector(".flow-node-title") as HTMLElement;
    click(title);
    title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items: { label: string; run?: () => void }[] = contextMenu.open.mock.calls[0][0].items;
    items.find((item) => item.label === "Clone")?.run?.();
    expect(savedIds()).toEqual(["joinText-1", "joinText-2"]);
    elements.pane.focus();
    press("z", { ctrlKey: true });
    expect(savedIds()).toEqual(["joinText-1"]);
    expect(elements.lockNotice.hidden).toBe(true);
  });

  // A pane shows one Flow after another: the last one's selection isn't
  // this one's, even where a node has the same id.
  it("selects nothing in a Flow just opened", () => {
    const { card, click, view } = keyedView([joinNode("joinText-1")]);
    click(card("joinText-1") as HTMLElement);
    view.render(flowFile("flows/other.flow.html", [joinNode("joinText-1")]));
    expect(view.canEdit("remove")).toBe(false);
    expect(view.selectedNode()).toBeUndefined();
    expect(card("joinText-1")?.classList.contains("selected")).toBe(false);
  });

  // What the copilot is told of: the canvas's selection, which a press
  // outside the canvas, such as in the chat, leaves alone.
  it("reports the selected node until Escape or a press on empty canvas, and none in App mode", () => {
    const { card, click, elements, view } = keyedView([joinNode("joinText-1"), showNode("showText-2")]);
    expect(view.selectedNode()).toBeUndefined();
    click(card("showText-2") as HTMLElement);
    expect(view.selectedNode()).toBe("showText-2");
    click(document.body);
    expect(view.selectedNode()).toBe("showText-2");

    view.toggleAppMode();
    expect(view.selectedNode()).toBeUndefined();
    view.toggleAppMode();
    expect(view.selectedNode()).toBe("showText-2");

    view.dismissTransient();
    expect(view.selectedNode()).toBeUndefined();
    click(card("joinText-1") as HTMLElement);
    click(elements.pane);
    expect(view.selectedNode()).toBeUndefined();
  });

  it("takes no keys in App mode or on a locked Flow", () => {
    const { card, click, view } = keyedView([joinNode("joinText-1")]);
    click(card("joinText-1") as HTMLElement);
    expect(view.canEdit("remove")).toBe(true);
    view.toggleAppMode();
    expect(view.canEdit("remove")).toBe(false);
    view.toggleAppMode();

    const locked = flowFile("flows/keys.flow.html", [joinNode("joinText-1")]);
    locked.locked = "newer-format";
    view.render(locked);
    click(card("joinText-1") as HTMLElement);
    expect(view.canEdit("remove")).toBe(false);
  });
});

describe("flowView Int", () => {
  const intNode = (id: string, config: Record<string, unknown>, exposed?: string[]): FlowNodeInstance => ({
    id,
    type: "int",
    position: { x: 0, y: 0 },
    config,
    ...(exposed ? { exposed } : {}),
  });
  const box = (root: ParentNode) => root.querySelector<HTMLInputElement>(".flow-int-stepper input")?.value;

  // Moved on after the run, so the run gave 5. Undo takes back a person's
  // edits, not what a run moved, as with Regenerate's seed.
  it("moves the value on once a run has used it, saved and shown on the card, as no Undo step", async () => {
    const { card, elements, saved, view } = keyedView([intNode("int-1", { value: "5", control: "increment" })]);
    await view.run();
    expect(saved()?.nodes[0].config).toEqual({ value: "6", control: "increment" });
    expect(box(card("int-1") as HTMLElement)).toBe("6");
    elements.pane.focus();
    expect(view.canEdit("undo")).toBe(false);
  });

  it("leaves a fixed value, and one the run failed on", async () => {
    const fixed = intNode("int-1", { value: "5", control: "fixed" });
    const failed = intNode("int-2", { value: "five", control: "increment" });
    const { card, view } = keyedView([fixed, failed]);
    await view.run();
    expect([fixed.config.value, failed.config.value]).toEqual(["5", "five"]);
    expect(card("int-2")?.querySelector(".flow-node-error")?.textContent).toMatch(/"five" isn't a whole number/);
  });

  it("shows the moved value in App mode when the run started there", async () => {
    const { elements, view } = keyedView([intNode("int-1", { value: "1", control: "decrement" }, ["value"])]);
    view.toggleAppMode();
    expect(box(elements.appModePane)).toBe("1");
    await view.run();
    expect(box(elements.appModePane)).toBe("0");
  });
});

describe("flowView Disable", () => {
  const prompt = (id: string, x = 0): FlowNodeInstance => ({
    id,
    type: "prompt",
    position: { x, y: 0 },
    config: { text: "hi" },
  });
  const wire = (source: string, target: string): FlowEdgeInstance => ({
    id: `${source}>${target}`,
    source,
    sourcePort: "text",
    target,
    targetPort: "text",
  });

  // A person's edit, so saved and one Undo step; the card greys, a card it
  // feeds dims, and every wire touching either dashes.
  it("disables the selected node on Mod+M, marks what a run leaves out, and Undo takes it back", () => {
    const { card, click, elements, press, saved } = keyedView(
      [prompt("prompt-1"), showNode("showText-2")],
      [wire("prompt-1", "showText-2")],
    );
    click(card("prompt-1") as HTMLElement);
    press("m", { ctrlKey: true });
    expect(saved()?.nodes[0].mode).toBe("disabled");
    expect(card("prompt-1")?.classList.contains("disabled")).toBe(true);
    expect(card("prompt-1")?.querySelector(".flow-node-disabled-tag")?.textContent).toBe("Disabled");
    expect(card("showText-2")?.classList.contains("skipped")).toBe(true);
    expect(elements.edgeGroup.querySelector(".edge-path")?.classList.contains("left-out")).toBe(true);

    elements.pane.focus();
    press("z", { ctrlKey: true });
    expect(saved()?.nodes[0].mode).toBeUndefined();
    expect(card("prompt-1")?.classList.contains("disabled")).toBe(false);
    expect(card("showText-2")?.classList.contains("skipped")).toBe(false);
    expect(elements.edgeGroup.querySelector(".edge-path")?.classList.contains("left-out")).toBe(false);
  });

  it("runs what a disabled node leaves alone, and tells a skipped card why", async () => {
    const disabled = { ...prompt("prompt-1"), mode: "disabled" as const };
    const { card, view } = keyedView(
      [
        disabled,
        showNode("showText-2"),
        prompt("prompt-3", 600),
        { ...showNode("showText-4"), position: { x: 900, y: 0 } },
      ],
      [wire("prompt-1", "showText-2"), wire("prompt-3", "showText-4")],
    );
    await view.run();
    expect(card("showText-2")?.querySelector(".flow-node-skipped")?.textContent).toBe("Skipped: Prompt is disabled");
    expect(card("showText-4")?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("hi");
  });
});

describe("flowView Regenerate on a disabled node", () => {
  // It would run nothing, so it moves nothing on and asks for nothing.
  it("leaves the seed as it was and makes no image call", async () => {
    const calls = () => vi.mocked(sandboxGenerateImage).mock.calls.length;
    const { view, elements } = runnableView();
    const file = imageFlow("a fox");
    view.render(file);
    await view.run();
    const before = calls();
    file.graph.nodes[1].mode = "disabled";
    file.graph.nodes[1].config.seed = "7";
    view.render(file);
    const button = [...elements.pane.querySelectorAll("button")].find((b) => b.textContent === "Regenerate");
    expect(button).toBeDefined();
    button?.click();
    await tick();
    expect(file.graph.nodes[1].config.seed).toBe("7");
    expect(calls()).toBe(before);
  });
});

describe("flowView wiring", () => {
  // Generate Image's output back into the Join Text that writes its prompt:
  // each would wait on the other, so neither could run.
  it("refuses a wire that would close a loop, and no other", () => {
    const pointerDown = vi.spyOn(XYHandle, "onPointerDown").mockImplementation(() => {});
    onTestFinished(() => pointerDown.mockRestore());
    const { view, elements } = runnableView();
    const file = imageFlow("a fox");
    file.graph.nodes.push({ id: "joinText-3", type: "joinText", position: { x: 150, y: 0 }, config: {} });
    file.graph.edges = [
      { id: "e1", source: "prompt-1", sourcePort: "text", target: "joinText-3", targetPort: "text_1" },
      { id: "e2", source: "joinText-3", sourcePort: "text", target: "generateImage-2", targetPort: "prompt" },
    ];
    view.render(file);
    const pin = elements.pane.querySelector('[data-id="null-generateImage-2-file_name-source"]');
    pin?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const accepts = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
      pointerDown.mock.calls[0]?.[1].isValidConnection?.({ source, sourceHandle, target, targetHandle });
    expect(accepts("generateImage-2", "file_name", "joinText-3", "text_2")).toBe(false);
    expect(accepts("joinText-3", "text", "joinText-3", "text_2")).toBe(false);
    expect(accepts("prompt-1", "text", "joinText-3", "text_2")).toBe(true);
  });
});
