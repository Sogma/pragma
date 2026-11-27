// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLOW_NODE_REGISTRY } from "../../../src/protocol/flowNodes.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance, FlowPort } from "../../../src/protocol/types.ts";
import { ApiError } from "../../../web/core/apiClient.ts";
import { createNodeCards, markLeftOut, type NodeCardDeps } from "../../../web/flow/nodeCard.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuOpenOptions } from "../../../web/services/menus.ts";
import { spellcheck } from "../../../web/services/settings.ts";
import { MEDIA_MENU } from "../../../web/services/videoMenu.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";
import { fakeModelFields } from "../support/fakeModelFields.ts";

polyfillRangeRects();

function node(
  type: string,
  config: Record<string, unknown> = {},
  extra: Partial<FlowNodeInstance> = {},
): FlowNodeInstance {
  return { id: `${type}-1`, type, position: { x: 10, y: 20 }, config, ...extra } as FlowNodeInstance;
}

function setup(edges: FlowEdgeInstance[] = []) {
  const graph: FlowGraph = { nodes: [], edges };
  const modelFields = fakeModelFields();
  const opened: MenuOpenOptions[] = [];
  const deps: NodeCardDeps = {
    graph: () => graph,
    persistGraph: vi.fn(),
    saveGraphNow: vi.fn(async () => true),
    ensureCapability: vi.fn(async () => true),
    read: vi.fn(async () => undefined),
    pickedImages: new Map(),
    directoryChildren: vi.fn(() => undefined),
    flowPath: () => "story.flow.html",
    modelFields,
    contextMenu: { open: (options) => void opened.push(options), close() {}, isOpen: () => false },
    regenerate: vi.fn(),
    zoom: () => 1,
    startConnection: vi.fn(),
    onLayoutChange: vi.fn(),
    menus: {
      openNodeMenu: vi.fn(),
      openHandleMenu: vi.fn(),
      openExposeMenu: vi.fn(),
      openChipMenu: vi.fn(),
      toggleUnusedPins: vi.fn(),
    },
    locked: () => false,
    loadFile: vi.fn(async () => {
      throw new Error("no files in this test");
    }),
    injectAppletRuntime: vi.fn(() => "<p>applet</p>"),
    remount: vi.fn(),
    fileMissing: vi.fn(),
    previewResult: vi.fn(),
    viewContext: () => "projects/film",
  };
  return { cards: createNodeCards(deps), deps, graph, modelFields, opened };
}

const contextMenuOn = (el: Element) =>
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));

describe("an output a For Each zone gives per item", () => {
  it("is offered no Expose, but an old exposure can still be taken back", () => {
    const { cards, deps, graph } = setup([
      { id: "e1", source: "forEach-1", sourcePort: "item", target: "joinText-1", targetPort: "list" },
    ]);
    const field = node("joinText", { separator: ", " });
    graph.nodes.push(node("forEach"), field);
    const label = cards.build(field).querySelector(".flow-node-outputs .flow-port-label") as HTMLElement;
    contextMenuOn(label);
    expect(vi.mocked(deps.menus.openExposeMenu).mock.calls.at(-1)?.[4]).toBeUndefined();

    field.exposed = ["text"];
    contextMenuOn(label);
    expect(vi.mocked(deps.menus.openExposeMenu).mock.calls.at(-1)?.[4]).toEqual(expect.any(Function));
  });
});

describe("For Each End's slots", () => {
  const lists = (el: HTMLElement) =>
    [...el.querySelectorAll(".flow-node-outputs .flow-port-row.output")].map((row) => [
      (row.querySelector(".handle.source") as HTMLElement).dataset.handleid,
      row.querySelector(".flow-port-label")?.textContent,
    ]);

  it("names a slot's pin, and gives its list the name in the plural", () => {
    const { cards, deps } = setup();
    const flowNode = node("forEachEnd", { forEach: "forEach-1", value1Name: "path" });
    const el = cards.build(flowNode);
    expect(lists(el)).toEqual([["list_1", "paths"]]);

    const input = el.querySelector(".flow-variable-name-input") as HTMLInputElement;
    input.value = "text";
    input.dispatchEvent(new Event("input"));
    expect(lists(el)).toEqual([["list_1", "texts"]]);
    expect(flowNode.config.value1Name).toBe("text");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(lists(el)).toEqual([["list_1", "list_1"]]);
  });

  it("grows a slot on both sides with +, and removing it drops its wires in and out", () => {
    const { cards, graph } = setup();
    const flowNode = node("forEachEnd", { forEach: "forEach-1" });
    const el = cards.build(flowNode);
    const named = () => [...el.querySelectorAll(".flow-port-row.has-label")];
    (el.querySelector(".flow-add-variable-button") as HTMLElement).click();
    expect(named()).toHaveLength(2);
    expect(lists(el).map(([id]) => id)).toEqual(["list_1", "list_2"]);

    graph.edges.push(
      { id: "in", source: "p", sourcePort: "text", target: "forEachEnd-1", targetPort: "value_2" },
      { id: "out", source: "forEachEnd-1", sourcePort: "list_2", target: "j", targetPort: "list" },
    );
    (named()[1].querySelector(".flow-remove-variable-button") as HTMLElement).click();
    expect(named()).toHaveLength(1);
    expect(lists(el).map(([id]) => id)).toEqual(["list_1"]);
    expect(graph.edges).toEqual([]);
    expect(flowNode.config.valueSlots).toEqual([]);
  });
});

describe("a Generate node's reference pins", () => {
  const rows = (el: HTMLElement) =>
    [...el.querySelectorAll(".flow-reference-row")].map((row) => row.querySelector(".flow-port-label")?.textContent);
  const add = (el: HTMLElement) => el.querySelector<HTMLElement>(".flow-add-reference") as HTMLElement;
  const wire = (targetPort: string): FlowEdgeInstance => ({
    id: `e-${targetPort}`,
    source: "loadImage-1",
    sourcePort: "image",
    target: "generateImage-1",
    targetPort,
  });

  it("starts with none and adds them one at a time, a Remove leaving a gap the next one fills", () => {
    const { cards } = setup();
    const flowNode = node("generateImage", { outputFolderPath: "art" });
    const el = cards.build(flowNode);
    expect(rows(el)).toEqual([]);
    for (let i = 0; i < 3; i++) add(el).click();
    expect(rows(el)).toEqual(["image_1", "image_2", "image_3"]);
    expect(flowNode.config.imageSlots).toEqual([1, 2, 3]);

    el.querySelectorAll<HTMLElement>(".flow-reference-row .flow-remove-variable-button")[1].click();
    expect(rows(el)).toEqual(["image_1", "image_3"]);
    expect(flowNode.config.imageSlots).toEqual([1, 3]);
    add(el).click();
    expect(rows(el)).toEqual(["image_1", "image_2", "image_3"]);
  });

  it("gives Generate Text and Generate Options the same pins, none at first", () => {
    const { cards } = setup();
    for (const type of ["generateText", "generateOptions"]) {
      const el = cards.build({ ...node(type), id: `${type}-x` });
      expect(rows(el)).toEqual([]);
      add(el).click();
      expect(rows(el)).toEqual(["image_1"]);
    }
  });

  it("shows a wired pin the Flow never listed, so a saved graph opens as it was", () => {
    const { cards } = setup([wire("image_4")]);
    expect(rows(cards.build(node("generateImage")))).toEqual(["image_4"]);
  });

  it("stops at the number the picked model takes, and at the ceiling while the model comes on a wire", () => {
    const { cards, graph, modelFields } = setup();
    modelFields.references.set("gemini/gemini-2.5-flash-image", 2);
    const el = cards.build(node("generateImage", { model: "gemini/gemini-2.5-flash-image" }));
    const addRow = add(el).closest<HTMLElement>(".flow-add-variable-row");
    add(el).click();
    add(el).click();
    expect(addRow?.hidden).toBe(true);
    graph.edges.push({ ...wire("model"), source: "prompt-1", sourcePort: "text" });
    cards.updateInputWidgetVisibility("generateImage-1", "model");
    expect(addRow?.hidden).toBe(false);
  });

  it("names what its one choice adds, and opens a menu when there are several", () => {
    const { cards, opened } = setup();
    const image = cards.build(node("generateImage"));
    expect(add(image).getAttribute("aria-label")).toBe("Add image reference");
    expect(add(image).textContent).toBe("Reference");
    const video = node("generateVideo", { removedFrames: ["end"] });
    const el = cards.build(video);
    expect(add(el).getAttribute("aria-label")).toBe("Add frame or reference");
    expect(add(el).textContent).toBe("Frame or reference");
    add(el).click();
    expect(opened.at(-1)?.items?.map((item) => item.label)).toEqual([
      "End frame",
      "Image reference",
      "Video reference",
    ]);
  });

  it("adds a Generate Video's clips below its images, as many as the model takes", () => {
    const { cards, opened, modelFields } = setup();
    modelFields.references.set("higgsfield/seedance_2_0", 9);
    modelFields.videoCounts.set("higgsfield/seedance_2_0", 1);
    modelFields.frameLists.set("higgsfield/seedance_2_0", []);
    const flowNode = node("generateVideo", { model: "higgsfield/seedance_2_0" });
    const el = cards.build(flowNode);
    const shown = () =>
      [...el.querySelectorAll<HTMLElement>(".flow-reference-row")]
        .filter((row) => !row.hidden)
        .map((row) => row.querySelector(".flow-port-label")?.textContent);
    add(el).click();
    expect(opened.at(-1)?.items?.map((item) => item.label)).toEqual(["Image reference", "Video reference"]);
    opened
      .at(-1)
      ?.items?.find((item) => item.label === "Video reference")
      ?.run?.({} as CommandContext, undefined);
    expect(shown()).toEqual(["video_1"]);
    expect(flowNode.config.videoSlots).toEqual([1]);
    // The model takes one clip, so the "+" adds images alone, above the clips.
    expect(add(el).getAttribute("aria-label")).toBe("Add image reference");
    add(el).click();
    add(el).click();
    expect(shown()).toEqual(["image_1", "image_2", "video_1"]);

    const trash = el.querySelectorAll<HTMLElement>(".flow-reference-row:not([hidden]) .flow-remove-variable-button");
    trash[2].click();
    expect(shown()).toEqual(["image_1", "image_2"]);
    expect(flowNode.config.videoSlots).toEqual([]);
  });

  it("follows the model as a pick or an arriving list redraws its field", () => {
    const { cards, modelFields } = setup();
    modelFields.videoCounts.set("", 0);
    const flowNode = node("generateVideo");
    const el = cards.build(flowNode);
    const addRow = add(el).closest<HTMLElement>(".flow-add-variable-row");
    add(el).click();
    expect(addRow?.hidden).toBe(false);
    modelFields.references.set("higgsfield/seedance_2_0", 1);
    modelFields.videoCounts.set("higgsfield/seedance_2_0", 0);
    const field = modelFields.fields.find((entry) => entry.kind === "video");
    field?.onPick("higgsfield/seedance_2_0");
    field?.onRedraw?.();
    expect(addRow?.hidden).toBe(true);
  });
});

describe("a Generate Video node's frame pins", () => {
  const shown = (el: HTMLElement) =>
    ["start_frame", "end_frame"].filter((id) => {
      const handle = el.querySelector(`.handle[data-handleid="${id}"]`);
      return handle && !(handle.closest(".flow-port-row") as HTMLElement).hidden;
    });
  const frameWire = (targetPort: string): FlowEdgeInstance => ({
    id: `e-${targetPort}`,
    source: "loadImage-1",
    sourcePort: "image",
    target: "generateVideo-1",
    targetPort,
  });

  it("shows both for a model nobody describes, and only what a described model takes", () => {
    const { cards, modelFields } = setup();
    expect(shown(cards.build(node("generateVideo")))).toEqual(["start_frame", "end_frame"]);
    modelFields.frameLists.set("higgsfield/kling_o3_image_reference", []);
    const omni = cards.build({ ...node("generateVideo", { model: "higgsfield/kling_o3_image_reference" }), id: "v2" });
    expect(shown(omni)).toEqual([]);
  });

  it('removes a frame with its wire, and the "+" brings it back', () => {
    const { cards, graph, opened, deps } = setup([frameWire("start_frame")]);
    const flowNode = node("generateVideo");
    const el = cards.build(flowNode);
    const startRow = el.querySelector('.handle[data-handleid="start_frame"]')?.closest(".flow-port-row") as HTMLElement;
    (startRow.querySelector('[aria-label="Remove start frame"]') as HTMLElement).click();

    expect(shown(el)).toEqual(["end_frame"]);
    expect(graph.edges).toEqual([]);
    expect(flowNode.config.removedFrames).toEqual(["start"]);
    expect(deps.persistGraph).toHaveBeenCalled();

    (el.querySelector(".flow-add-reference") as HTMLElement).click();
    const choice = opened.at(-1)?.items?.find((item) => item.label === "Start frame");
    choice?.run?.({} as CommandContext, undefined);
    expect(shown(el)).toEqual(["start_frame", "end_frame"]);
    expect(flowNode.config.removedFrames).toBeUndefined();
  });

  it("shows a wired frame whatever the model takes", () => {
    const { cards, modelFields } = setup([frameWire("end_frame")]);
    modelFields.frameLists.set("higgsfield/kling_o3_image_reference", []);
    const el = cards.build(node("generateVideo", { model: "higgsfield/kling_o3_image_reference" }));
    expect(shown(el)).toEqual(["end_frame"]);
  });
});

describe("nodeCard", () => {
  it("builds a card from the registry: title, input rows with widgets, output rows with handles", () => {
    const { cards } = setup();
    const flowNode = node("toggleText", { true: "true", on_true: "yes" });
    const el = cards.build(flowNode);
    expect(el.className).toBe("flow-node nopan");
    expect(el.dataset.nodeId).toBe("toggleText-1");
    expect(el.dataset.nodeType).toBe("toggleText");
    expect(el.style.width).toBe("240px");
    expect(el.querySelector(".flow-node-name")?.textContent).toBe("Toggle");
    const inputRows = [...el.querySelectorAll(".flow-node-inputs .flow-port-row")];
    expect(inputRows.map((row) => row.querySelector(".flow-port-label")?.textContent)).toEqual([
      "true",
      "on_true",
      "on_false",
      "text",
    ]);
    const checkbox = inputRows[0].querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    expect(inputRows[0].querySelector(".handle.target")?.classList.contains("unconnected")).toBe(true);
    expect(el.querySelector(".flow-node-outputs .handle.source")).not.toBeNull();
    expect(el.querySelector(".flow-node-resize-handle")).not.toBeNull();
  });

  it("a widget edit persists into the config, and the collapse dot toggles the card and reports a layout change", () => {
    const { cards, deps } = setup();
    const flowNode = node("toggleText", { true: "true" });
    const el = cards.build(flowNode);
    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(flowNode.config.true).toBe("false");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);

    (el.querySelector(".flow-node-dot") as HTMLElement).click();
    expect(flowNode.collapsed).toBe(true);
    expect(el.classList.contains("collapsed")).toBe(true);
    expect(el.style.width).toBe("");
    expect(deps.onLayoutChange).toHaveBeenCalledWith("toggleText-1");
  });

  it("a right-click on a title, a handle, or a field label opens the matching menu", () => {
    const edge = { id: "e1", source: "prompt-1", sourcePort: "text", target: "toggleText-1", targetPort: "text" };
    const { cards, deps } = setup([edge]);
    const flowNode = node("toggleText", {});
    const el = cards.build(flowNode);

    contextMenuOn(el.querySelector(".flow-node-title") as Element);
    expect(deps.menus.openNodeMenu).toHaveBeenCalledWith(
      5,
      6,
      "toggleText-1",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    const textRow = [...el.querySelectorAll(".flow-port-row")].find(
      (row) => row.querySelector(".flow-port-label")?.textContent === "text",
    ) as Element;
    contextMenuOn(textRow.querySelector(".handle") as Element);
    expect(deps.menus.openHandleMenu).toHaveBeenCalledWith(5, 6, "text", [edge]);

    contextMenuOn(el.querySelector(".flow-port-label") as Element); // the "true" widget row
    expect(deps.menus.openExposeMenu).toHaveBeenCalledWith(5, 6, "boolean", false, expect.any(Function), []);
    const toggle = (deps.menus.openExposeMenu as ReturnType<typeof vi.fn>).mock.calls[0][4] as () => void;
    toggle();
    expect(flowNode.exposed).toEqual(["true"]);
    expect(el.querySelector(".flow-port-label")?.classList.contains("exposed")).toBe(true);
  });

  it("draws a missing pin for a wire naming a port the node lacks, and drops it with its last wire", () => {
    const into = {
      id: "e1",
      source: "loadImage-1",
      sourcePort: "image",
      target: "generateText-1",
      targetPort: "image1",
    };
    const from = {
      id: "e2",
      source: "generateText-1",
      sourcePort: "reply",
      target: "showText-1",
      targetPort: "text",
    };
    const { cards, deps, graph } = setup([into, from]);
    graph.nodes.push(node("loadImage"), node("showText"));
    const el = cards.build(node("generateText"));

    const input = el.querySelector(".flow-node-inputs .flow-port-row.missing") as HTMLElement;
    expect(input.querySelector(".flow-port-label")?.textContent).toBe("image1 (missing)");
    const pin = input.querySelector(".handle.target") as HTMLElement;
    expect(pin.dataset.handleid).toBe("image1");
    expect(pin.classList.contains("connectable")).toBe(false);
    contextMenuOn(pin);
    expect(deps.menus.openHandleMenu).toHaveBeenCalledWith(5, 6, "image", [into]);

    const output = el.querySelector(".flow-node-outputs .flow-port-row.missing") as HTMLElement;
    expect(output.querySelector(".handle.source")?.getAttribute("data-handleid")).toBe("reply");

    graph.edges = [from];
    cards.updateInputWidgetVisibility("generateText-1", "image1");
    expect(el.querySelector(".flow-node-inputs .flow-port-row.missing")).toBeNull();
    expect(deps.onLayoutChange).toHaveBeenCalledWith("generateText-1");
    expect(el.querySelector(".flow-node-outputs .flow-port-row.missing")).not.toBeNull();
  });

  it("names no type for a missing pin with nothing typed across its wire", () => {
    const wire = { id: "e1", source: "gone-1", sourcePort: "text", target: "generateText-1", targetPort: "image1" };
    const { cards, deps } = setup([wire]);
    contextMenuOn(cards.build(node("generateText")).querySelector(".flow-port-row.missing .handle") as HTMLElement);
    expect(deps.menus.openHandleMenu).toHaveBeenCalledWith(5, 6, null, [wire]);
  });

  it("offers nothing from a locked Flow's missing pin", () => {
    const wire = { id: "e1", source: "gone-1", sourcePort: "text", target: "generateText-1", targetPort: "image1" };
    const { cards, deps } = setup([wire]);
    deps.locked = () => true;
    const row = cards.build(node("generateText")).querySelector(".flow-port-row.missing") as HTMLElement;
    expect(row.dataset.tooltip).toBe('This node has no "image1" pin.');
  });

  it("a node's first Expose in an ordered graph places its App mode card before Run", () => {
    const { cards, deps, graph } = setup();
    const flowNode = node("toggleText", {});
    graph.nodes.push(flowNode);
    graph.runAppModeOrder = 0;
    const el = cards.build(flowNode);
    contextMenuOn(el.querySelector(".flow-port-label") as Element);
    const toggle = (deps.menus.openExposeMenu as ReturnType<typeof vi.fn>).mock.calls[0][4] as () => void;
    toggle();
    expect([flowNode.appModeOrder, graph.runAppModeOrder]).toEqual([0, 1]);
  });

  it("a node's first Expose drops a stale tile size; a further Expose keeps the size", () => {
    const { cards, deps, graph } = setup();
    const hidden = node("toggleText", {}, { appModeSize: { columns: 4, rows: 2 } });
    const shown = node(
      "toggleText",
      {},
      { id: "toggleText-2", exposed: ["on_true"], appModeSize: { columns: 4, rows: 2 } },
    );
    graph.nodes.push(hidden, shown);
    graph.runAppModeOrder = 0;
    for (const flowNode of [hidden, shown])
      contextMenuOn(cards.build(flowNode).querySelector(".flow-port-label") as Element);
    for (const call of (deps.menus.openExposeMenu as ReturnType<typeof vi.fn>).mock.calls) (call[4] as () => void)();
    expect([hidden.appModeSize, shown.appModeSize]).toEqual([undefined, { columns: 4, rows: 2 }]);
    expect(shown.exposed).toEqual(["on_true", "true"]);
  });

  it("gives a card with a height of its own that height as a floor and marks it sized, neither while collapsed", () => {
    const { cards } = setup();
    const sized = node("loadImage", {}, { size: { width: 300, height: 420 } });
    const el = cards.build(sized);
    expect([el.style.height, el.style.minHeight, el.classList.contains("is-sized")]).toEqual(["", "420px", true]);
    const dot = el.querySelector(".flow-node-dot") as HTMLElement;
    dot.click();
    expect([el.style.minHeight, el.classList.contains("is-sized")]).toEqual(["", false]);
    dot.click();
    expect([el.style.minHeight, el.classList.contains("is-sized")]).toEqual(["420px", true]);
    expect(cards.build({ ...node("loadImage"), id: "loadImage-2" }).classList.contains("is-sized")).toBe(false);
  });

  it("saves the height a resized card shows when the drag goes past its content", () => {
    const { cards, deps } = setup();
    const flowNode = node("currentDocument");
    const el = cards.build(flowNode);
    Object.defineProperty(el, "offsetHeight", { value: 260 });
    const handle = el.querySelector(".flow-node-resize-handle") as HTMLElement;
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, clientY: 0 }));
    expect([el.style.height, el.style.minHeight]).toEqual(["", "0px"]);
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(flowNode.size).toEqual({ width: 160, height: 260 });
    expect(deps.persistGraph).toHaveBeenCalled();
  });

  it("a rename through the title menu edits the label in place; Escape cancels", () => {
    const { cards, deps } = setup();
    const flowNode = node("toggleText", {});
    const el = cards.build(flowNode);
    contextMenuOn(el.querySelector(".flow-node-title") as Element);
    const startRename = (deps.menus.openNodeMenu as ReturnType<typeof vi.fn>).mock.calls[0][3] as () => void;
    startRename();
    const input = el.querySelector<HTMLInputElement>(".flow-node-name-input") as HTMLInputElement;
    input.value = "My toggle";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(flowNode.label).toBe("My toggle");
    expect(el.querySelector(".flow-node-name")?.textContent).toBe("My toggle");
  });

  it("shows a node's comment as a caption under the card, and none for a node without one", () => {
    const { cards } = setup();
    const commented = cards.build(node("toggleText", {}, { comment: "The Expand instruction." }));
    const caption = commented.querySelector<HTMLElement>(":scope > .flow-node-comment");
    expect(caption?.textContent).toBe("The Expand instruction.");
    expect(caption?.hidden).toBe(false);

    const plain = cards.build(node("prompt"));
    expect(plain.querySelector<HTMLElement>(".flow-node-comment")?.hidden).toBe(true);
  });

  // The field saves on blur, which needs the card in the document.
  it("edits the comment in the caption's place: Enter saves one line, Escape cancels, empty removes it", () => {
    const { cards, deps } = setup();
    const flowNode = node("toggleText", {});
    const el = cards.build(flowNode);
    document.body.append(el);
    contextMenuOn(el.querySelector(".flow-node-title") as Element);
    const startComment = (deps.menus.openNodeMenu as ReturnType<typeof vi.fn>).mock.calls[0][5] as () => void;
    const caption = el.querySelector(".flow-node-comment") as HTMLElement;
    const edit = (text: string, key: string) => {
      startComment();
      expect(caption.hidden).toBe(true);
      const field = el.querySelector(".flow-node-comment-field textarea") as HTMLTextAreaElement;
      field.value = text;
      field.dispatchEvent(new KeyboardEvent("keydown", { key }));
    };

    edit("  Adds   a detail,\nin the same voice. ", "Enter");
    expect(flowNode.comment).toBe("Adds a detail, in the same voice.");
    expect(caption.textContent).toBe("Adds a detail, in the same voice.");
    expect(caption.hidden).toBe(false);
    expect(el.querySelector(".flow-node-comment-field")).toBeNull();

    edit("Something else", "Escape");
    expect(flowNode.comment).toBe("Adds a detail, in the same voice.");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);

    edit("   ", "Enter");
    expect(flowNode.comment).toBeUndefined();
    expect(caption.hidden).toBe(true);
    expect(deps.persistGraph).toHaveBeenCalledTimes(2);
    el.remove();
  });

  it("shows its type's description over its title, led by the type's name once renamed", () => {
    const { cards, deps } = setup();
    const { label, description } = FLOW_NODE_REGISTRY.loadRow;
    const el = cards.build(node("loadRow"));
    const title = el.querySelector(".flow-node-title") as HTMLElement;
    expect(title.dataset.tooltip).toBe(description);
    expect(title.querySelector<HTMLElement>(".flow-node-collapse")?.dataset.tooltip).toBe("Collapse");

    contextMenuOn(title);
    const startRename = (deps.menus.openNodeMenu as ReturnType<typeof vi.fn>).mock.calls[0][3] as () => void;
    startRename();
    const input = el.querySelector<HTMLInputElement>(".flow-node-name-input") as HTMLInputElement;
    input.value = "Story starter";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(title.dataset.tooltip).toBe(`${label}\n${description}`);

    const renamed = cards.build(node("loadRow", {}, { label: "Story starter" }));
    expect(renamed.querySelector<HTMLElement>(".flow-node-title")?.dataset.tooltip).toBe(`${label}\n${description}`);
  });

  const portDescription = (type: string, id: string) =>
    [...FLOW_NODE_REGISTRY[type].inputs, ...FLOW_NODE_REGISTRY[type].outputs].find((port) => port.id === id)
      ?.description;
  const rowNamed = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll<HTMLElement>(".flow-port-row")].find(
      (row) => row.querySelector(".flow-port-label")?.textContent === name,
    ) as HTMLElement;

  // No built-in model pin or Get Field slot has a description, so a test of
  // where one would show gives the pin one for the test's length.
  function withDescription(port: FlowPort | undefined, run: (description: string) => void): void {
    if (!port) throw new Error("No such port");
    const description = "A description for this test.";
    port.description = description;
    try {
      run(description);
    } finally {
      delete port.description;
    }
  }

  // The dot is left for a value its node holds itself.
  it("describes a pin over its name and its field, never its dot or its row", () => {
    const { cards } = setup();
    const row = rowNamed(cards.build(node("resolvePath")), "base");
    const description = portDescription("resolvePath", "base");
    expect(description).toBeTruthy();
    expect(row.dataset.tooltip).toBeUndefined();
    expect(row.querySelector<HTMLElement>(".handle")?.dataset.tooltip).toBeUndefined();
    for (const part of [".flow-port-label", "input"]) {
      expect(row.querySelector<HTMLElement>(part)?.dataset.tooltip, part).toBe(description);
    }
  });

  it("leaves a path pin's drop target and a model field their own tooltips", () => {
    const { cards } = setup();
    const pathRow = cards.build(node("loadImage")).querySelector(".flow-path-row") as HTMLElement;
    const pathDescription = portDescription("loadImage", "path");
    expect(pathDescription).toBeTruthy();
    expect(pathRow.querySelector<HTMLElement>(".handle")?.dataset.tooltip).toBe(pathDescription);
    expect(pathRow.dataset.tooltip).toBeUndefined();
    expect(pathRow.querySelector<HTMLElement>(".flow-dropzone")?.dataset.tooltip).toBeUndefined();

    withDescription(
      FLOW_NODE_REGISTRY.generateText.inputs.find((port) => port.id === "model"),
      (description) => {
        const modelRow = rowNamed(cards.build(node("generateText")), "model");
        expect(modelRow.querySelector<HTMLElement>(".flow-port-label")?.dataset.tooltip).toBe(description);
        expect((modelRow.lastElementChild as HTMLElement).dataset.tooltip).toBeUndefined();
      },
    );
  });

  // Beside its file, a path pin or a loader's `path` output goes unnamed, so
  // the pin's tooltip names it; the name, shown once wired, keeps the
  // description alone, as a writer's named `path` output does.
  it("names a pin beside its file in the pin's tooltip", () => {
    const { cards } = setup();
    const image = cards.build(node("loadImage"));
    const description = (list: FlowPort[]) => list.find((port) => port.id === "path")?.description;
    const { inputs, outputs } = FLOW_NODE_REGISTRY.loadImage;
    const pin = (el: HTMLElement, kind: string) =>
      el.querySelector<HTMLElement>(`.handle.${kind}[data-handleid="path"]`)?.dataset.tooltip;
    // Its description says it is a path already, so it stands alone.
    expect(pin(image, "target")).toBe("The image's path in the space or library.");
    expect(pin(image, "source")).toBe(`path\n${description(outputs)}`);
    expect(rowNamed(image, "path").querySelector<HTMLElement>(".flow-port-label")?.dataset.tooltip).toBe(
      description(inputs),
    );

    const note = cards.build(node("loadNote"));
    expect(pin(note, "target")).toBe("path");
    expect(pin(note, "source")).toBe("path");

    const write = cards.build(node("writeNote"));
    expect(pin(write, "target")).toBe("path");
    expect(pin(write, "source")).toBeUndefined();
  });

  it("describes a slot's pin over the pin and the field beside it", () => {
    const { cards } = setup();
    const variable = cards.build(node("templateVariables")).querySelector(".flow-port-row.has-label") as HTMLElement;
    const description = portDescription("templateVariables", "var_1");
    expect(description).toBeTruthy();
    expect(variable.querySelector<HTMLElement>(".handle")?.dataset.tooltip).toBeUndefined();
    expect(variable.querySelector<HTMLElement>(".flow-variable-name-input")?.dataset.tooltip).toBe(description);

    withDescription(FLOW_NODE_REGISTRY.getField.outputs[0], (slotDescription) => {
      const field = cards.build(node("getField")).querySelector(".flow-node-outputs .flow-port-row") as HTMLElement;
      expect(field.querySelector<HTMLElement>(".handle")?.dataset.tooltip).toBeUndefined();
      expect((field.firstElementChild as HTMLElement).dataset.tooltip).toBe(slotDescription);
    });
  });

  // A node that holds its own value shows it on the dot that hands it on.
  it("shows a Prompt's text on its dot, on one line and cut to 50 characters", () => {
    const { cards } = setup();
    const dot = (el: HTMLElement) =>
      el.querySelector<HTMLElement>('.handle.source[data-handleid="text"]')?.dataset.tooltip;
    expect(dot(cards.build(node("prompt", { text: "Steam rises" })))).toBe("Steam rises");
    const long = "A red cup on a wooden table,\nsteam rising past a window at dawn, rain outside";
    expect(dot(cards.build({ ...node("prompt", { text: long }), id: "prompt-2" }))).toBe(
      "A red cup on a wooden table, steam rising past a …",
    );
  });

  it("shows an Int's number and a Choice's pick, the first option while none is picked", () => {
    const { cards } = setup();
    const dot = (el: HTMLElement, port: string) =>
      el.querySelector<HTMLElement>(`.handle.source[data-handleid="${port}"]`)?.dataset.tooltip;
    expect(dot(cards.build(node("int", { value: "42" })), "int")).toBe("42");
    expect(dot(cards.build({ ...node("int"), id: "int-2" }), "int")).toBe("0");
    expect(dot(cards.build(node("choice", { options: "Dawn\nDusk" })), "text")).toBe("Dawn");
    expect(dot(cards.build({ ...node("choice", { options: "Dawn\nDusk", text: "Dusk" }), id: "c-2" }), "text")).toBe(
      "Dusk",
    );
  });

  it("leaves the dots of a node that holds no value of its own without a tooltip", () => {
    const { cards } = setup();
    const el = cards.build(node("joinText"));
    expect(el.querySelector<HTMLElement>('.handle.source[data-handleid="text"]')?.dataset.tooltip).toBeUndefined();
  });

  // A new node's prefix is written as the node is made; an older node with
  // none shows the blank a run reads, never the new node's value.
  it("shows an older Generate node's missing prefix as the blank a run reads", () => {
    const { cards } = setup();
    const el = cards.build(node("generateVideo", { outputFolderPath: "clips" }));
    const input = rowNamed(el, "prefix").querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("");
  });

  it("keeps a collapsed card's caption at the width the card has open", () => {
    const { cards } = setup();
    const size = { width: 300, height: 200 };
    const el = cards.build(node("toggleText", {}, { comment: "A note.", collapsed: true, size }));
    expect(el.style.getPropertyValue("--flow-node-open-width")).toBe("300px");

    (el.querySelector(".flow-node-collapse") as HTMLElement).click();
    expect(el.style.getPropertyValue("--flow-node-open-width")).toBe("");
  });

  it("connected ports hide their fallback control and un-fade their pins", () => {
    const { cards, graph } = setup();
    const flowNode = node("toggleText", {});
    const el = cards.build(flowNode);
    const trueRow = el.querySelector(".flow-port-row") as HTMLElement;
    const control = trueRow.querySelector("input") as HTMLInputElement;
    graph.edges.push({ id: "e", source: "x", sourcePort: "out", target: "toggleText-1", targetPort: "true" });
    cards.updateInputWidgetVisibility("toggleText-1", "true");
    expect(control.hidden).toBe(true);
    expect(trueRow.querySelector(".handle")?.classList.contains("unconnected")).toBe(false);

    // The affix select on "text" shows only once that port is wired.
    cards.updateSourceDependents("toggleText-1");
    const affix = [...el.querySelectorAll("select")].pop() as HTMLSelectElement;
    expect(affix.hidden).toBe(true);
    graph.edges.push({ id: "e2", source: "x", sourcePort: "out", target: "toggleText-1", targetPort: "text" });
    cards.updateSourceDependents("toggleText-1");
    expect(affix.hidden).toBe(false);
  });

  // Its text is required, so where it goes is worth setting before a wire.
  it("shows Add to Note's Prepend/Append menu in its text row unwired, opening on Append, beside the note's drop target", () => {
    const { cards, deps } = setup();
    const flowNode = node("addToNote", { notePath: "logs/run.md" });
    const el = cards.build(flowNode);
    const textRow = [...el.querySelectorAll(".flow-node-inputs .flow-port-row")].find(
      (row) => row.querySelector(".flow-port-label")?.textContent === "text",
    );
    const menu = textRow?.querySelector("select") as HTMLSelectElement;
    cards.updateSourceDependents("addToNote-1");
    expect(menu.hidden).toBe(false);
    expect([...menu.options].map((option) => option.textContent)).toEqual(["Prepend", "Append"]);
    expect(menu.value).toBe("append");

    menu.value = "prepend";
    menu.dispatchEvent(new Event("change"));
    expect(flowNode.config.affixMode).toBe("prepend");
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(el.querySelector(".flow-node-config")?.textContent).toContain("run.md");
  });

  it("syncs a card built with its edges in place: fallback hidden, affix shown, output pin un-faded", () => {
    const { cards } = setup([
      { id: "e1", source: "x", sourcePort: "out", target: "toggleText-1", targetPort: "true" },
      { id: "e2", source: "x", sourcePort: "out", target: "toggleText-1", targetPort: "text" },
      { id: "e3", source: "toggleText-1", sourcePort: "text", target: "y", targetPort: "in" },
    ]);
    const flowNode = node("toggleText", {});
    const el = cards.build(flowNode);
    const control = el.querySelector(".flow-port-row input") as HTMLInputElement;
    expect(control.hidden).toBe(false);

    cards.syncWiring(flowNode);
    expect(control.hidden).toBe(true);
    expect(([...el.querySelectorAll("select")].pop() as HTMLSelectElement).hidden).toBe(false);
    expect(el.querySelector(".flow-node-outputs .handle.source")?.classList.contains("unconnected")).toBe(false);
  });

  // The field takes its width from data-text, so the closing braces follow
  // the name as it is typed, and the placeholder while it has none.
  it("writes a template variable's name as its {{name}} placeholder, the field sized to the name", () => {
    const { cards, deps } = setup();
    const flowNode = node("templateVariables", { var1Name: "character" });
    const name = cards.build(flowNode).querySelector(".flow-port-row.has-label .flow-variable-name") as HTMLElement;
    expect(name.tagName).toBe("LABEL");
    expect([...name.children].map((part) => part.className)).toEqual([
      "flow-variable-name-brace",
      "flow-variable-name-field",
      "flow-variable-name-brace",
    ]);
    expect(name.textContent).toBe("{{}}");
    const field = name.querySelector(".flow-variable-name-field") as HTMLElement;
    const input = field.querySelector("input") as HTMLInputElement;
    expect([input.value, field.dataset.text]).toEqual(["character", "character"]);

    input.value = "the place!";
    input.dispatchEvent(new Event("input"));
    expect([input.value, field.dataset.text, flowNode.config.var1Name]).toEqual(["theplace", "theplace", "theplace"]);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(field.dataset.text).toBe("name");
    expect(deps.persistGraph).toHaveBeenCalledTimes(2);
  });

  it("template variable rows grow with + and remove with their trash button, dropping the slot's edges", () => {
    const { cards, deps, graph } = setup();
    const flowNode = node("templateVariables", {});
    const el = cards.build(flowNode);
    const rows = () => [...el.querySelectorAll(".flow-port-row.has-label")];
    expect(rows()).toHaveLength(1);
    (el.querySelector(".flow-add-variable-button") as HTMLElement).click();
    expect(rows()).toHaveLength(2);
    expect(flowNode.config.varSlots).toEqual([2]);
    expect(deps.onLayoutChange).toHaveBeenCalledWith("templateVariables-1");

    graph.edges.push({
      id: "e",
      source: "p",
      sourcePort: "text",
      target: "templateVariables-1",
      targetPort: "var_2",
    });
    (rows()[1].querySelector(".flow-remove-variable-button") as HTMLElement).click();
    expect(rows()).toHaveLength(1);
    expect(graph.edges).toEqual([]);
    expect(flowNode.config.varSlots).toEqual([]);
  });

  it("get field slots are output rows that grow with +, fill from the wired table, and drop their edges on removal", async () => {
    const { cards, deps, graph } = setup();
    const flowNode = node("getField", { field1Key: "voice" });
    const el = cards.build(flowNode);
    const rows = () => [...el.querySelectorAll(".flow-node-outputs .flow-port-row.output")];
    const handleIds = () => rows().map((row) => (row.querySelector(".handle.source") as HTMLElement).dataset.handleid);
    expect(handleIds()).toEqual(["field_1"]);

    (el.querySelector(".flow-add-variable-button") as HTMLElement).click();
    expect(handleIds()).toEqual(["field_1", "field_2"]);
    expect(flowNode.config.fieldSlots).toEqual([2]);

    // An edge into the node re-reads the field list from the wired table.
    graph.nodes.push(node("loadRow", { tablePath: "sites.table.html" }), flowNode);
    graph.edges.push({
      id: "in",
      source: "loadRow-1",
      sourcePort: "row",
      target: "getField-1",
      targetPort: "object",
    });
    vi.mocked(deps.read).mockResolvedValue({
      kind: "table",
      columns: [
        { id: "name", label: "Name", type: "text" },
        { id: "voice", label: "Voice", type: "text" },
      ],
      rows: [],
    });
    cards.updateSourceDependents("getField-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const select = rows()[0].querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["name", "voice"]);
    expect(select.value).toBe("voice");

    graph.edges.push({ id: "out", source: "getField-1", sourcePort: "field_2", target: "j", targetPort: "text_1" });
    flowNode.config.field2Key = "name";
    (rows()[1].querySelector(".flow-remove-variable-button") as HTMLElement).click();
    expect(handleIds()).toEqual(["field_1"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["in"]);
    expect(flowNode.config.field2Key).toBeUndefined();
    expect(flowNode.config.fieldSlots).toEqual([]);
  });

  it("a prompt card edits its text through the textbox; a showText card shows a run's text and errors", () => {
    const { cards, deps } = setup();
    const prompt = node("prompt", { text: "hello" });
    const promptEl = cards.build(prompt);
    const cm = promptEl.querySelector(".cm-content") as HTMLElement;
    expect(cm.textContent).toBe("hello");

    const show = node("showText", {});
    const showEl = cards.build(show);
    const textarea = showEl.querySelector("textarea") as HTMLTextAreaElement;
    cards.showRunResult({
      outputs: new Map([["showText-1", { text: { type: "text", value: "out" } }]]),
      errors: new Map([["showText-1", "bad"]]),
    });
    expect(textarea.value).toBe("out");
    const error = showEl.querySelector(".flow-node-error") as HTMLElement;
    expect(error.textContent).toBe("bad");
    expect(error.hidden).toBe(false);

    cards.clearRunState();
    expect(textarea.value).toBe("");
    expect(error.hidden).toBe(true);

    cards.forget("showText-1");
    cards.showRunResult({
      outputs: new Map([["showText-1", { text: { type: "text", value: "again" } }]]),
      errors: new Map(),
    });
    expect(textarea.value).toBe("");
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });

  // A Button has no output, so its box can only show what its wire brought.
  it("a Button card hands on what a click is made in, and has no text box", () => {
    const { cards } = setup();
    const el = cards.build(node("button", { requireSelection: "true" }, { label: "Tighten" }));
    const pins = [...el.querySelectorAll<HTMLElement>(".flow-node-outputs .handle.source")];
    expect(pins.map((pin) => pin.dataset.handleid)).toEqual(["selection", "raw", "path"]);
    expect(el.querySelector(".flow-node-name")?.textContent).toBe("Tighten");
    expect(el.querySelector("textarea")).toBeNull();
  });

  // The card's read and a run's fail on a gone file with one message, so the
  // card shows it before any run, in the line the run then fills again.
  it("shows a loader's missing file in its error line before a run, as the run does", async () => {
    const { cards, deps } = setup();
    const gone = 'No file at "notes/gone.md"';
    vi.mocked(deps.read).mockRejectedValue(new ApiError(gone, 404));
    const el = cards.build(node("loadNote", { notePath: "notes/gone.md" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const line = el.querySelector(".flow-node-error") as HTMLElement;
    expect([line.hidden, line.textContent]).toEqual([false, gone]);
    expect(el.querySelector(".flow-space-drop")?.classList.contains("missing")).toBe(true);
    // And counted with the Flow's problems, where it can't be missed.
    expect(deps.fileMissing).toHaveBeenCalledWith("loadNote-1", gone);

    cards.clearRunState();
    expect(line.hidden).toBe(true);
    cards.showRunResult({ outputs: new Map(), errors: new Map([["loadNote-1", gone]]) });
    expect([...el.querySelectorAll(".flow-node-error")]).toEqual([line]);
    expect([line.hidden, line.textContent]).toEqual([false, gone]);
  });

  it("links a run's failure to the setting that fixes it, under its message", () => {
    const { cards } = setup();
    const el = cards.build(node("generateText"));
    const need = { kind: "defaultModel", output: "text" } as const;
    const errors = new Map([["generateText-1", "No model selected."]]);
    cards.showRunResult({ outputs: new Map(), errors, needs: new Map([["generateText-1", need]]) });
    const line = el.querySelector(".flow-node-error") as HTMLElement;
    expect(line.querySelector(".inline-error-message")?.textContent).toBe("No model selected.");
    expect(line.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");

    cards.showRunResult({ outputs: new Map(), errors: new Map([["generateText-1", "rate limited"]]) });
    expect([line.textContent, line.querySelector(".setting-link")]).toEqual(["rate limited", null]);
  });
});

describe("a Choice node's card", () => {
  it("picks among its options, and editing the list drops a pick it no longer holds", () => {
    const { cards, deps } = setup();
    const flowNode = node("choice", { options: "Wide\nClose-up", text: "Close-up" });
    const el = cards.build(flowNode);
    const select = el.querySelector(".flow-node-config select") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["Wide", "Close-up"]);
    expect(select.value).toBe("Close-up");

    select.value = "Wide";
    select.dispatchEvent(new Event("change"));
    expect(flowNode.config.text).toBe("Wide");

    const textarea = el.querySelector(".flow-node-config textarea") as HTMLTextAreaElement;
    textarea.value = "Medium\nClose-up";
    textarea.dispatchEvent(new Event("input"));
    expect(flowNode.config).toEqual({ options: "Medium\nClose-up" });
    expect(select.value).toBe("Medium");
    expect(deps.persistGraph).toHaveBeenCalledTimes(2);
  });

  it("exposes its pick from the dropdown, tinting the output pin's label", () => {
    const { cards, deps } = setup();
    const flowNode = node("choice", { options: "Wide" });
    const el = cards.build(flowNode);
    contextMenuOn(el.querySelector(".flow-node-config .flow-config-field") as HTMLElement);
    const toggle = vi.mocked(deps.menus.openExposeMenu).mock.calls[0][4];
    toggle?.();
    expect(flowNode.exposed).toEqual(["text"]);
    const pinLabel = el.querySelector(".flow-node-outputs .flow-port-label") as HTMLElement;
    expect(pinLabel.classList.contains("exposed")).toBe(true);
  });
});

describe("an Int node's card", () => {
  const box = (el: HTMLElement) => el.querySelector(".flow-int-stepper input") as HTMLInputElement;
  const arrow = (el: HTMLElement, label: string) =>
    el.querySelector(`.flow-int-stepper [aria-label="${label}"]`) as HTMLButtonElement;
  const control = (el: HTMLElement) => el.querySelector(".flow-config-field button.picker") as HTMLButtonElement;
  const shown = (button: HTMLButtonElement) => button.querySelector(".picker-choice.current")?.textContent;
  const key = (input: HTMLInputElement, name: string) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, cancelable: true }));
  const type = (input: HTMLInputElement, text: string, leave = false) => {
    input.value = text;
    input.dispatchEvent(new Event("input"));
    if (leave) input.dispatchEvent(new Event("change"));
  };

  it("gives an int pin, and shows a blank value as 0 between arrows that step it, saving each step", () => {
    const { cards, deps } = setup();
    const flowNode = node("int");
    const el = cards.build(flowNode);
    expect([...el.querySelectorAll(".flow-node-outputs .flow-port-label")].map((label) => label.textContent)).toEqual([
      "int",
    ]);
    expect(box(el).value).toBe("0");
    expect(arrow(el, "Add 1").tabIndex).toBe(-1);

    arrow(el, "Add 1").click();
    expect(flowNode.config.value).toBe("1");
    expect(box(el).value).toBe("1");
    arrow(el, "Subtract 1").click();
    arrow(el, "Subtract 1").click();
    expect(flowNode.config.value).toBe("-1");
    expect(box(el).getAttribute("aria-valuenow")).toBe("-1");
    expect(deps.persistGraph).toHaveBeenCalledTimes(3);
  });

  it("steps on ↑ and ↓, keeps digits and a leading minus as typed, and leaves a whole number", () => {
    const { cards } = setup();
    const flowNode = node("int", { value: "7" });
    const input = box(cards.build(flowNode));
    key(input, "ArrowUp");
    expect(flowNode.config.value).toBe("8");
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    expect(flowNode.config.value).toBe("6");

    type(input, "-0a1-2");
    expect([input.value, flowNode.config.value]).toEqual(["-012", "-012"]);
    input.dispatchEvent(new Event("change"));
    expect([input.value, flowNode.config.value]).toEqual(["-12", "-12"]);

    type(input, "-");
    expect(flowNode.config.value).toBe("-");
    input.dispatchEvent(new Event("change"));
    expect([input.value, flowNode.config.value]).toEqual(["0", "0"]);

    type(input, "99999999999999999", true);
    expect(flowNode.config.value).toBe(String(Number.MAX_SAFE_INTEGER));
    key(input, "ArrowUp");
    expect(flowNode.config.value).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it("shows a stored value that isn't a whole number as it is, and steps on from 0", () => {
    const { cards, deps } = setup();
    const flowNode = node("int", { value: "1.5" });
    const el = cards.build(flowNode);
    expect(box(el).value).toBe("1.5");
    expect(deps.persistGraph).not.toHaveBeenCalled();
    arrow(el, "Add 1").click();
    expect(flowNode.config.value).toBe("1");
  });

  it("picks what a run does to the value from fixed, increment, decrement and randomize, blank as fixed", () => {
    const { cards, deps, opened } = setup();
    const flowNode = node("int");
    const button = control(cards.build(flowNode));
    expect(shown(button)).toBe("fixed");
    expect(button.getAttribute("aria-label")).toBe("Control after run: fixed");

    button.click();
    const items = opened[0].items ?? [];
    expect(items.map((item) => item.label)).toEqual(["fixed", "increment", "decrement", "randomize"]);
    items.find((item) => item.label === "increment")?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect(flowNode.config.control).toBe("increment");
    expect(shown(button)).toBe("increment");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
  });

  it("exposes its value as a number, tinting the label in the number pin's colour", () => {
    const { cards, deps } = setup();
    const flowNode = node("int");
    const el = cards.build(flowNode);
    const field = box(el).closest(".flow-config-field") as HTMLElement;
    contextMenuOn(field);
    const [, , portType, exposed, toggle] = vi.mocked(deps.menus.openExposeMenu).mock.calls[0];
    expect([portType, exposed]).toEqual(["number", false]);
    toggle?.();
    expect(flowNode.exposed).toEqual(["value"]);
    const label = field.querySelector(".flow-config-label") as HTMLElement;
    expect(label.classList.contains("exposed") && label.classList.contains("type-number")).toBe(true);
  });
});

describe("an Applet node's card", () => {
  const stage = {
    kind: "applet",
    path: "studio/stage.applet.html",
    revision: "r1",
    manifest: {
      id: "applet_stage",
      version: "1.0",
      meta: { name: "3D Stage" },
      ports: {
        inputs: [],
        outputs: [
          { id: "description", type: "text", label: "Description" },
          { id: "frame", type: "image", label: "Frame" },
        ],
      },
    },
    html: "<p>stage</p>",
    contentHash: "hash-2",
    imports: [],
  } as const;

  async function mounted(config: Record<string, unknown>) {
    const { cards, deps } = setup();
    deps.loadFile = vi.fn(async () => structuredClone(stage)) as unknown as NodeCardDeps["loadFile"];
    const applet = node("applet", config);
    const el = cards.build(applet);
    document.body.append(el);
    await vi.waitFor(() => expect(el.querySelector("iframe")).not.toBeNull());
    return { applet, el, deps, frame: el.querySelector("iframe") as HTMLIFrameElement };
  }

  it("shows its Applet's description over its title, and saves each port's for its pin", async () => {
    const { cards, deps } = setup();
    const file = structuredClone(stage) as unknown as {
      manifest: { meta: { description?: string }; ports: { outputs: { description?: string }[] } };
    };
    file.manifest.meta.description = "Block a shot: a camera, a figure and a light.";
    file.manifest.ports.outputs[1].description = "The camera's view.";
    deps.loadFile = vi.fn(async () => file) as unknown as NodeCardDeps["loadFile"];
    const applet = node("applet", { appletPath: "studio/stage.applet.html" }, { label: "Blocking" });
    const el = cards.build(applet);
    document.body.append(el);
    const title = el.querySelector(".flow-node-title") as HTMLElement;
    expect(title.dataset.tooltip).toBe(`Applet\n${FLOW_NODE_REGISTRY.applet.description}`);

    await vi.waitFor(() => expect(title.dataset.tooltip).toBe("Applet\nBlock a shot: a camera, a figure and a light."));
    const rebuilt = cards.build(applet);
    const frame = [...rebuilt.querySelectorAll<HTMLElement>(".flow-node-outputs .flow-port-row")].find(
      (row) => row.querySelector(".flow-port-label")?.textContent === "frame",
    );
    expect(frame?.querySelector<HTMLElement>(".flow-port-label")?.dataset.tooltip).toBe("The camera's view.");
  });

  it("draws its pins from the ports its config records, named by their ids", () => {
    const { cards } = setup();
    const el = cards.build(
      node("applet", {
        appletPath: "studio/stage.applet.html",
        ports: { inputs: [], outputs: [{ id: "frame", type: "image", label: "Frame" }] },
      }),
    );
    const labels = [...el.querySelectorAll(".flow-node-outputs .flow-port-label")].map((label) => label.textContent);
    expect(labels).toEqual(["frame"]);
  });

  it("puts the Applet's file below its frame", async () => {
    const { el } = await mounted({ appletPath: "studio/stage.applet.html" });
    const content = el.querySelector(".flow-applet-content") as HTMLElement;
    expect([...content.children].map((child) => child.className)).toEqual(["flow-applet", "flow-node-config"]);
  });

  it("records the file's hash, ports and name, and rebuilds the card when its pins change", async () => {
    const { applet, deps, frame } = await mounted({ appletPath: "studio/stage.applet.html", appletHash: "hash-1" });
    expect(applet.config.appletHash).toBe("hash-2");
    expect(applet.config.ports).toEqual(stage.manifest.ports);
    expect(applet.label).toBe("3D Stage");
    expect(deps.remount).toHaveBeenCalledWith("applet-1");
    expect(deps.injectAppletRuntime).toHaveBeenCalledWith(stage.html, stage.manifest, [], undefined);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("saves what its frame reports, checked against its ports, and ignores any other frame", async () => {
    const { applet, deps, frame } = await mounted({ appletPath: "studio/stage.applet.html" });
    const report = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent("message", { data, source }));

    report({
      source: "pragma-applet",
      type: "outputs",
      outputs: { description: "Wide shot", frame: "data:image/jpeg;base64,AAAA" },
    });
    expect(applet.config.outputs).toEqual({
      description: { type: "text", value: "Wide shot" },
      frame: { type: "image", mediaType: "image/jpeg", data: "AAAA" },
    });
    report({ source: "pragma-applet", type: "state", value: { lens: 35 } });
    expect(applet.config.state).toEqual({ lens: 35 });
    expect(deps.persistGraph).toHaveBeenCalled();

    report({ source: "pragma-applet", type: "outputs", outputs: { shot: "x" } });
    expect(applet.config.outputs).toEqual(
      expect.objectContaining({ description: { type: "text", value: "Wide shot" } }),
    );
    expect(frame.closest(".flow-applet")?.textContent).toContain('No output port "shot" (it has description, frame');

    report({ source: "pragma-applet", type: "state", value: { lens: 85 } }, window);
    expect(applet.config.state).toEqual({ lens: 35 });
  });

  it("a Generate Image card takes a results folder, picks image models, and shows its last result", async () => {
    const { cards, deps, modelFields } = setup();
    deps.directoryChildren = vi.fn((dir: string) => (dir === "art" ? [] : undefined));
    const flowNode = node("generateImage", { outputFolderPath: "art" });
    const el = cards.build(flowNode);

    expect(el.querySelector(".flow-space-drop")?.getAttribute("data-tooltip")).toBe("art");
    // Its model input is an image-model picker, in the input's own row,
    // saving the pick to the node.
    const field = modelFields.fields.find((entry) => entry.kind === "image");
    expect(field?.button.closest(".flow-port-row.has-widget")).not.toBeNull();
    expect(field?.button.classList.contains("nodrag")).toBe(true);
    expect(field?.value()).toBe("");
    field?.onPick("higgsfield/soul_2");
    expect(flowNode.config.model).toBe("higgsfield/soul_2");
    expect(field?.value()).toBe("higgsfield/soul_2");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);

    const preview = el.querySelector<HTMLImageElement>(".flow-node-image-result") as HTMLImageElement;
    const regenerate = [...el.querySelectorAll("button")].find((button) => button.textContent === "Regenerate");
    expect([preview.hidden, regenerate?.hidden]).toEqual([true, true]);
    expect(regenerate?.classList.contains("flow-regenerate")).toBe(true);
    const picture = { type: "image", mediaType: "image/png", data: "AAAA" } as const;
    const saved = { type: "text", value: "/art/a-0123456789ab.png" } as const;
    cards.showRunResult({
      outputs: new Map([[flowNode.id, { image: picture, path: saved }]]),
      errors: new Map(),
      reports: new Map([[flowNode.id, ["Reused art/a-0123456789ab.png: these inputs were generated before."]]]),
    });
    expect(preview.hidden).toBe(false);
    expect(preview.src).toBe("data:image/png;base64,AAAA");
    expect(el.querySelector(".flow-node-report")?.textContent).toContain("Reused art/a-0123456789ab.png");
    // The picture is the run's copy; a click previews the file it was saved as.
    preview.click();
    expect(deps.previewResult).toHaveBeenCalledWith("art/a-0123456789ab.png");

    expect(regenerate?.hidden).toBe(false);
    regenerate?.click();
    expect(deps.regenerate).toHaveBeenCalledWith(flowNode.id);
  });

  it("a Generate Video card takes a results folder, picks video models, and plays its last clip", () => {
    // jsdom plays no media.
    const media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
    ];
    const { cards, deps, modelFields, opened } = setup();
    const flowNode = node("generateVideo", { outputFolderPath: "clips" });
    const el = cards.build(flowNode);

    expect(el.querySelector(".flow-space-drop")?.getAttribute("data-tooltip")).toBe("clips");
    const field = modelFields.fields.find((entry) => entry.kind === "video");
    field?.onPick("higgsfield/seedance1_5");
    expect(flowNode.config.model).toBe("higgsfield/seedance1_5");

    const frame = el.querySelector<HTMLElement>(".flow-node-video-result") as HTMLElement;
    const regenerate = [...el.querySelectorAll("button")].find((button) => button.textContent === "Regenerate");
    expect([frame.hidden, regenerate?.hidden]).toEqual([true, true]);
    expect(regenerate?.dataset.tooltip).toBe("A new take, run on this node's last inputs");
    expect(el.querySelector(".flow-node-image-result")).toBeNull();

    // No port carries video: the card plays the file its path names.
    cards.showRunResult({
      outputs: new Map([[flowNode.id, { path: { type: "text", value: "/clips/steam-0123456789ab.mp4" } }]]),
      errors: new Map(),
      reports: new Map([[flowNode.id, ["Quoted 2.4 credits."]]]),
    });
    expect(frame.hidden).toBe(false);
    expect(frame.classList.contains("nodrag")).toBe(true);
    expect(frame.querySelector("video")?.getAttribute("src")).toBe("/api/file/raw?path=clips%2Fsteam-0123456789ab.mp4");
    expect(frame.querySelector(".video-player")).not.toBeNull();
    expect(frame.querySelector(".video-lut")).toBeNull();
    expect(frame.querySelector(".video-guides")).toBeNull();
    expect(el.querySelector(".flow-node-report")?.textContent).toBe("Quoted 2.4 credits.");
    expect(regenerate?.hidden).toBe(false);
    // A click on the picture previews the file, the card's copy paused.
    media[1].mockClear();
    frame.querySelector("video")?.click();
    expect(media[1]).toHaveBeenCalledTimes(1);
    expect(deps.previewResult).toHaveBeenCalledWith("clips/steam-0123456789ab.mp4");
    // Its ⋮ opens the menu the preview's does, ways to open the file
    // included, less Looks and Guides: the card shows neither.
    frame.querySelector<HTMLButtonElement>(".video-player-more")?.click();
    expect(opened.at(-1)).toMatchObject({
      menu: MEDIA_MENU,
      arg: {
        file: "clips/steam-0123456789ab.mp4",
        bookmark: "clips/steam-0123456789ab.mp4",
        looks: false,
        guides: false,
      },
    });

    cards.clearRunState();
    expect(frame.hidden).toBe(true);
    expect(frame.querySelector("video")?.hasAttribute("src")).toBe(false);
    expect(frame.querySelector(".video-player")).toBeNull();
    for (const spy of media) spy.mockRestore();
  });
});

describe("a Generate Video card's model settings", () => {
  it("groups the model rows under the toggle, then the settings the picked model offers once its list says", () => {
    const { cards, modelFields } = setup();
    const card = cards.build(node("generateVideo", { model: "higgsfield/kling_4_0_flash" }));
    const section = card.querySelector(".flow-model-settings") as HTMLElement;
    const groupLabels = () =>
      [...section.querySelectorAll(".flow-model-settings-body > .flow-port-row > .flow-port-label")].map(
        (label) => label.textContent,
      );
    expect(groupLabels()).toEqual(["model", "aspect_ratio", "resolution", "duration"]);

    modelFields.settingLists.set("higgsfield/kling_4_0_flash", [
      { name: "mode", kind: "choice", options: ["text-to-video", "video-edit"], default: "text-to-video" },
    ]);
    for (const field of modelFields.fields) field.onRedraw?.();
    expect(groupLabels()).toEqual(["model", "aspect_ratio", "resolution", "duration", "mode"]);
    const row = section.querySelector(".flow-model-setting") as HTMLElement;
    expect(row.classList.contains("flow-port-row")).toBe(true);
    expect(row.querySelector(".handle")).toBeNull();
    expect(row.querySelector(".flow-port-label")?.textContent).toBe("mode");
  });

  it("draws the prefix after the model settings, above the folder, and leaves a Generate Image's in its inputs", () => {
    const { cards } = setup();
    const prefixOf = (card: HTMLElement) =>
      [...card.querySelectorAll(".flow-port-row")].find(
        (row) => row.querySelector(".flow-port-label")?.textContent === "prefix",
      ) as HTMLElement;
    const video = cards.build(node("generateVideo"));
    const settings = video.querySelector(".flow-model-settings") as HTMLElement;
    const prefix = prefixOf(video);
    expect(prefix.closest(".flow-node-content")).not.toBeNull();
    expect(settings.compareDocumentPosition(prefix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prefix.querySelector(".handle.target")).not.toBeNull();
    expect(prefixOf(cards.build(node("generateImage"))).closest(".flow-node-inputs")?.parentElement?.className).toBe(
      "flow-node-body",
    );
  });

  it("folds to a summary of the model and its settings, naming a wired one", () => {
    const { cards } = setup([
      { id: "e1", source: "t-1", sourcePort: "text", target: "generateVideo-1", targetPort: "aspect_ratio" },
    ]);
    const card = cards.build(
      node(
        "generateVideo",
        { model: "higgsfield/seedance_2_5", resolution: "720p", duration: "5" },
        { settingsFolded: true },
      ),
    );
    const section = card.querySelector(".flow-model-settings") as HTMLElement;
    expect(section.classList.contains("folded")).toBe(true);
    expect(section.querySelector(".flow-model-settings-label")?.textContent).toBe(
      "seedance_2_5 · 720p · 5 s · aspect ratio wired",
    );
    expect((section.querySelector(".flow-model-settings-body") as HTMLElement).hidden).toBe(true);
    expect((section.querySelector(".flow-model-settings-toggle") as HTMLElement).dataset.tooltip?.split("\n")).toEqual([
      "model: seedance_2_5",
      "aspect ratio: wired",
      "resolution: 720p",
      "duration: 5 s",
    ]);
  });

  it("stacks the folded rows' wires on the heading, and a collapsed card's on its title", () => {
    const { cards } = setup([
      { id: "e1", source: "t-1", sourcePort: "text", target: "generateVideo-1", targetPort: "aspect_ratio" },
      { id: "e2", source: "t-2", sourcePort: "text", target: "generateVideo-1", targetPort: "prompt" },
      { id: "e3", source: "generateVideo-1", sourcePort: "path", target: "s-1", targetPort: "text" },
    ]);
    const folded = cards.build(node("generateVideo", {}, { settingsFolded: true }));
    expect(folded.querySelector(".flow-node-title .flow-joined-pin")).toBeNull();
    const collapsed = cards.build(node("generateVideo", {}, { settingsFolded: true, collapsed: true }));
    const ids = (root: Element, selector: string) =>
      [...root.querySelectorAll<HTMLElement>(selector)].map((pin) => pin.dataset.handleid);
    expect(ids(folded, ".flow-model-settings-line .flow-joined-pin")).toEqual(["aspect_ratio"]);
    const title = collapsed.querySelector(".flow-node-title") as HTMLElement;
    expect(ids(title, ".flow-joined-pin.target")).toEqual(["prompt", "aspect_ratio"]);
    expect(ids(title, ".flow-joined-pin.source")).toEqual(["path"]);
  });

  it("offers the node's sizes and the model's own, naming what the model sends for one it doesn't list", () => {
    const { cards, modelFields, opened } = setup();
    const card = cards.build(node("generateVideo", { model: "higgsfield/gemini_omni_flash_1_2", resolution: "480p" }));
    const picker = () =>
      [...card.querySelectorAll<HTMLElement>(".flow-port-row")]
        .find((row) => row.querySelector(".flow-port-label")?.textContent === "resolution")
        ?.querySelector("button.flow-picker") as HTMLButtonElement;
    modelFields.resolutionLists.set("higgsfield/gemini_omni_flash_1_2", ["360p", "720p", "1080p", "4k"]);
    for (const field of modelFields.fields) field.onRedraw?.();
    picker().click();
    expect((opened.at(-1)?.items ?? []).map((item) => [item.label, item.detail])).toEqual([
      ["360p", undefined],
      ["480p", "sends 360p"],
      ["720p", undefined],
      ["1080p", undefined],
      ["4K", undefined],
    ]);
    expect(picker().getAttribute("aria-label")).toBe("resolution: 480p");
  });

  it("isn't on a Generate Image card", () => {
    const { cards } = setup();
    expect(cards.build(node("generateImage")).querySelector(".flow-model-settings")).toBeNull();
  });
});

describe("a select widget on the card", () => {
  const aspectRatio = (el: HTMLElement) =>
    [...el.querySelectorAll(".flow-port-row.has-widget")]
      .find((row) => row.querySelector(".flow-port-label")?.textContent === "aspect_ratio")
      ?.querySelector("button.picker") as HTMLButtonElement;
  const shown = (button: HTMLButtonElement) => button.querySelector(".picker-choice.current")?.textContent;
  const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

  it("is the app's picker over its options, a blank showing its preset, saving a pick to the node", () => {
    const { cards, deps, opened } = setup();
    const flowNode = node("generateImage", { aspect_ratio: "" });
    const button = aspectRatio(cards.build(flowNode));

    expect(button.classList.contains("nodrag")).toBe(true);
    expect(shown(button)).toBe("1:1");
    expect(button.getAttribute("aria-label")).toBe("aspect ratio: 1:1");
    button.click();
    const items = opened[0].items ?? [];
    expect(items.slice(0, 3).map((item) => item.label)).toEqual(["1:1", "16:9", "9:16"]);
    items.find((item) => item.label === "9:16")?.run?.(context, undefined);
    expect(flowNode.config.aspect_ratio).toBe("9:16");
    expect(shown(button)).toBe("9:16");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
  });

  it("keeps a stored value its options lack, shown as it is", () => {
    const { cards, deps, opened } = setup();
    const flowNode = node("generateImage", { aspect_ratio: "2.39:1" });
    const button = aspectRatio(cards.build(flowNode));

    expect(shown(button)).toBe("2.39:1");
    button.click();
    expect(opened[0].items?.at(-1)?.label).toBe("2.39:1");
    expect(flowNode.config.aspect_ratio).toBe("2.39:1");
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });
});

describe("a Make Object node's card", () => {
  const columns = [
    { id: "prompt", label: "Prompt", type: "text" },
    { id: "image", label: "Image", type: "media" },
    { id: "keep", label: "Keep", type: "checkbox" },
    { id: "status", label: "Status", type: "select", options: ["Draft", "Final"] },
    { id: "added", label: "Added", type: "timestamp", default: "now" },
    { id: "due", label: "Due", type: "timestamp" },
  ];
  const table = {
    kind: "table",
    path: "renders/log.table.html",
    revision: "r1",
    id: "tbl_log",
    version: "1.0",
    name: "Log",
    columns,
    rows: [{ values: {} }, { values: {} }],
  };
  const reading = (deps: NodeCardDeps) => {
    deps.loadFile = vi.fn(async () => structuredClone(table)) as unknown as NodeCardDeps["loadFile"];
  };

  it("gives each column a pin, and a control for what its field gets with nothing wired", () => {
    const { cards } = setup();
    const el = cards.build(node("makeObject", { tablePath: "space:renders/log.table.html", columns }));
    const rows = [...el.querySelectorAll(".flow-node-inputs .flow-port-row")];
    expect(rows.map((row) => row.querySelector(".flow-port-label")?.textContent)).toEqual([
      "Prompt",
      "Image",
      "Keep",
      "Status",
      "Added",
      "Due",
    ]);
    expect(rows[0].querySelector('input[type="text"]')).not.toBeNull();
    expect(rows[1].classList.contains("has-widget")).toBe(false); // a media column takes only a wire
    expect(rows[2].querySelector('input[type="checkbox"]')).not.toBeNull();
    const status = rows[3].querySelector("select") as HTMLSelectElement;
    expect([...status.options].map((option) => option.value)).toEqual(["Draft", "Final"]);
    expect(rows[4].querySelector(".flow-port-hint")?.textContent).toBe("time added");
    expect(rows[5].classList.contains("has-widget")).toBe(false);
    expect(rows.every((row) => row.querySelector(".handle")?.classList.contains("unconnected"))).toBe(true);
  });

  // A row object keys a field by the id, which the label needn't match.
  it("shows a column pin's id over its name, on Add Row as on Make Object", () => {
    const { cards } = setup();
    const own = [
      { id: "due_date", label: "Due date", type: "timestamp" },
      { id: "prompt", label: "Prompt", type: "text" },
    ];
    for (const type of ["makeObject", "addRow"]) {
      const el = cards.build(node(type, { tablePath: "renders/log.table.html", columns: own }));
      const names = [...el.querySelectorAll<HTMLElement>(".flow-node-inputs .flow-port-label")].filter((label) =>
        own.some((column) => column.label === label.textContent),
      );
      expect(names.map((label) => [label.textContent, label.dataset.tooltip])).toEqual([
        ["Due date", "due_date"],
        ["Prompt", "prompt"],
      ]);
    }
  });

  // A column's id is whatever its Table says, "columns" included.
  it("keeps what's typed under values, apart from the node's own keys, and hides it once wired", () => {
    const { cards, deps, graph } = setup();
    const own = [{ id: "columns", label: "Columns", type: "text" }];
    const flowNode = node("makeObject", { tablePath: "renders/log.table.html", columns: own });
    const el = cards.build(flowNode);
    const input = el.querySelector('.flow-node-inputs input[type="text"]') as HTMLInputElement;
    input.value = "three";
    input.dispatchEvent(new Event("input"));
    expect(flowNode.config.values).toEqual({ columns: "three" });
    expect(flowNode.config.columns).toEqual(own);
    expect(deps.persistGraph).toHaveBeenCalled();

    graph.edges.push({ id: "e", source: "p", sourcePort: "text", target: "makeObject-1", targetPort: "columns" });
    cards.updateInputWidgetVisibility("makeObject-1", "columns");
    expect(input.hidden).toBe(true);
  });

  it("reads its Table on every build, records the columns, and drops the wires of one the Table lost", async () => {
    const { cards, deps, graph } = setup([
      { id: "e1", source: "p", sourcePort: "text", target: "makeObject-1", targetPort: "prompt" },
      { id: "e2", source: "p", sourcePort: "text", target: "makeObject-1", targetPort: "gone" },
      { id: "e3", source: "p", sourcePort: "text", target: "other-1", targetPort: "gone" },
    ]);
    reading(deps);
    const saved = [
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "gone", label: "Gone", type: "text" },
    ];
    const flowNode = node("makeObject", { tablePath: "renders/log.table.html", columns: saved });
    const el = cards.build(flowNode);
    await vi.waitFor(() => expect(deps.remount).toHaveBeenCalledWith("makeObject-1"));
    expect(deps.loadFile).toHaveBeenCalledWith("renders/log.table.html");
    expect(flowNode.config.columns).toEqual(columns);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["e1", "e3"]);
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(el.querySelector(".flow-node-detail")?.textContent).toBe("6 columns · 2 rows");
  });

  it("finds nothing to change in a Table that is as recorded", async () => {
    const { cards, deps } = setup();
    reading(deps);
    const el = cards.build(node("makeObject", { tablePath: "renders/log.table.html", columns }));
    await vi.waitFor(() => expect(el.querySelector(".flow-node-detail")?.textContent).toBe("6 columns · 2 rows"));
    expect(deps.remount).not.toHaveBeenCalled();
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });

  // Another Table's columns are other columns: what was typed for these goes.
  it("starts over on a different Table, and refuses a file that isn't one", () => {
    const { cards, deps } = setup();
    const flowNode = node("makeObject", { tablePath: "renders/log.table.html", columns, values: { prompt: "x" } });
    const el = cards.build(flowNode);
    const drop = (path: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => path, files: [] } });
      el.querySelector(".flow-space-drop")?.dispatchEvent(event);
    };
    drop("notes/log.md");
    expect(el.querySelector(".flow-space-drop")?.textContent).toBe("Not a table: notes/log.md");
    expect(deps.remount).not.toHaveBeenCalled();

    drop("other/shots.table.html");
    expect(flowNode.config).toEqual({ tablePath: "other/shots.table.html" });
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(deps.remount).toHaveBeenCalledWith("makeObject-1");
  });

  it("reads the same Table again when it is dropped again, keeping what was typed for it", () => {
    const { cards, deps } = setup();
    const config = { tablePath: "space:renders/log.table.html", columns, values: { prompt: "x" } };
    const flowNode = node("makeObject", structuredClone(config));
    const el = cards.build(flowNode);
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => "renders/log.table.html", files: [] } });
    el.querySelector(".flow-space-drop")?.dispatchEvent(event);
    expect(flowNode.config).toEqual(config);
    expect(deps.persistGraph).not.toHaveBeenCalled();
    expect(deps.remount).toHaveBeenCalledWith("makeObject-1");
  });

  // A gone Table reads as an empty one. Taken for a Table whose columns all
  // went, it would take every wire into the node with it.
  const gone = (deps: NodeCardDeps) => {
    deps.loadFile = vi.fn(async () => ({
      ...structuredClone(table),
      columns: [],
      rows: [],
      missing: true,
    })) as unknown as NodeCardDeps["loadFile"];
  };

  // Its run never reads the Table, so a gone one fails nothing: the card only
  // says so, and keeps what it recorded for when the Table is back.
  it("keeps its columns and wires for a Table that isn't there, and says so without failing", async () => {
    const wire = { id: "e1", source: "p", sourcePort: "text", target: "makeObject-1", targetPort: "prompt" };
    const { cards, deps, graph } = setup([wire]);
    gone(deps);
    const flowNode = node("makeObject", { tablePath: "space:renders/log.table.html", columns });
    const el = cards.build(flowNode);
    await vi.waitFor(() =>
      expect(el.querySelector(".flow-node-detail")?.textContent).toBe(
        'No table at "renders/log.table.html". Its columns are kept.',
      ),
    );
    expect(el.querySelector(".flow-node-error")).toBeNull();
    expect(el.querySelector(".flow-space-drop")?.classList.contains("missing")).toBe(false);
    expect(deps.fileMissing).not.toHaveBeenCalledWith("makeObject-1", expect.any(String));
    expect(flowNode.config.columns).toEqual(columns);
    expect(graph.edges).toEqual([wire]);
    expect(deps.persistGraph).not.toHaveBeenCalled();
    expect(deps.remount).not.toHaveBeenCalled();
  });
});

describe("an Add Row node's card", () => {
  const table = {
    kind: "table",
    path: "renders/log.table.html",
    revision: "r1",
    id: "tbl_log",
    version: "1.0",
    name: "Log",
    columns: [{ id: "note", label: "Note", type: "text" }],
    rows: [{ values: {} }, { values: {} }, { values: {} }],
  };
  const reading = (deps: NodeCardDeps, missing = false) => {
    deps.loadFile = vi.fn(async () => ({
      ...structuredClone(table),
      ...(missing ? { columns: [], rows: [], missing: true } : {}),
    })) as unknown as NodeCardDeps["loadFile"];
  };

  // The Table is only where the row goes, so its path pin sits beside its
  // chip as every node's does, and the row arrives whole on one pin.
  it("puts its path pin beside the Table's chip, and takes the row on one object pin", async () => {
    const { cards, deps } = setup();
    reading(deps);
    const el = cards.build(node("addRow", { tablePath: "space:renders/log.table.html" }));
    const pin = el.querySelector('.handle.target[data-handleid="path"]') as HTMLElement;
    expect(pin.closest(".flow-path-row")?.querySelector(".flow-space-drop")).not.toBeNull();
    const rows = [...el.querySelectorAll(".flow-node-inputs .flow-port-row")];
    expect(rows.map((row) => row.querySelector(".flow-port-label")?.textContent)).toEqual(["row"]);
    expect(rows[0].querySelector('.handle[data-handleid="row"]')).not.toBeNull();
    await vi.waitFor(() => expect(el.querySelector(".flow-node-detail")?.textContent).toBe("1 column · 3 rows"));
    expect(deps.loadFile).toHaveBeenCalledWith("space:renders/log.table.html");
  });

  it("marks a gone Table missing as its run would fail, unless a wire names another", async () => {
    const lone = setup();
    reading(lone.deps, true);
    const el = lone.cards.build(node("addRow", { tablePath: "space:renders/log.table.html" }));
    await vi.waitFor(() =>
      expect(el.querySelector(".flow-node-error")?.textContent).toBe('No table at "renders/log.table.html"'),
    );
    expect(el.querySelector(".flow-space-drop")?.classList.contains("missing")).toBe(true);
    expect(lone.deps.fileMissing).toHaveBeenCalledWith("addRow-1", 'No table at "renders/log.table.html"');

    const wired = setup([{ id: "e1", source: "r", sourcePort: "path", target: "addRow-1", targetPort: "path" }]);
    reading(wired.deps, true);
    const wiredEl = wired.cards.build(node("addRow", { tablePath: "space:renders/log.table.html" }));
    await vi.waitFor(() => expect(wired.deps.loadFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wiredEl.querySelector(".flow-node-error")).toBeNull();
    expect(wired.deps.fileMissing).not.toHaveBeenCalledWith("addRow-1", expect.any(String));
  });

  // Another Table's columns are other pins: what was typed for these goes.
  it("starts over on a dropped Table, and refuses a file that isn't one", async () => {
    const { cards, deps } = setup();
    reading(deps);
    const flowNode = node("addRow", {
      tablePath: "renders/log.table.html",
      columns: table.columns,
      values: { note: "x" },
    });
    const el = cards.build(flowNode);
    const drop = (path: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => path, files: [] } });
      el.querySelector(".flow-space-drop")?.dispatchEvent(event);
    };
    drop("notes/log.md");
    expect(el.querySelector(".flow-space-drop")?.textContent).toBe("Not a table: notes/log.md");
    expect(deps.persistGraph).not.toHaveBeenCalled();

    drop("other/shots.table.html");
    expect(flowNode.config).toEqual({ tablePath: "other/shots.table.html" });
    expect(deps.persistGraph).toHaveBeenCalled();
    expect(deps.remount).toHaveBeenCalledWith("addRow-1");
  });

  it("gives a pin per column of the Table in its chip, below the row, with a control for what its cell gets", () => {
    const { cards } = setup();
    const columns = [
      { id: "prompt", label: "Prompt", type: "text" },
      { id: "keep", label: "Keep", type: "checkbox" },
      { id: "path", label: "Path", type: "path" },
    ];
    const el = cards.build(node("addRow", { tablePath: "space:renders/log.table.html", columns }));
    const rows = [...el.querySelectorAll(".flow-node-inputs .flow-port-row")];
    expect(rows.map((each) => each.querySelector(".flow-port-label")?.textContent)).toEqual(["row", "Prompt", "Keep"]);
    expect(rows[1].querySelector('input[type="text"]')).not.toBeNull();
    expect(rows[2].querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(el.querySelector(".flow-path-picker")?.classList.contains("gives-columns")).toBe(true);
  });

  // The chip still gives the pins, so it stays while a wire picks the Table
  // the row goes to, and says which it now does.
  it("keeps its Table showing while it gives pins and a wire names where the row goes", async () => {
    const wire = { id: "e1", source: "r", sourcePort: "path", target: "addRow-1", targetPort: "path" };
    const { cards, deps } = setup([wire]);
    reading(deps);
    const flowNode = node("addRow", { tablePath: "space:renders/log.table.html", columns: table.columns });
    const el = cards.build(flowNode);
    cards.syncWiring(flowNode);
    const picker = el.querySelector(".flow-path-picker") as HTMLElement;
    expect([picker.classList.contains("wired"), picker.classList.contains("gives-columns")]).toEqual([true, true]);
    await vi.waitFor(() =>
      expect(el.querySelector(".flow-node-detail")?.textContent).toBe("Sets the columns. The wire picks the Table."),
    );
  });

  it("drops the wires of a column its Table lost, never its path's or its row's", async () => {
    const wires = [
      { id: "e1", source: "r", sourcePort: "path", target: "addRow-1", targetPort: "path" },
      { id: "e2", source: "m", sourcePort: "object", target: "addRow-1", targetPort: "row" },
      { id: "e3", source: "p", sourcePort: "text", target: "addRow-1", targetPort: "note" },
      { id: "e4", source: "p", sourcePort: "text", target: "addRow-1", targetPort: "gone" },
    ];
    const { cards, deps, graph } = setup(wires);
    reading(deps);
    const saved = [...table.columns, { id: "gone", label: "Gone", type: "text" }];
    const flowNode = node("addRow", { tablePath: "space:renders/log.table.html", columns: saved });
    cards.build(flowNode);
    await vi.waitFor(() => expect(deps.remount).toHaveBeenCalledWith("addRow-1"));
    expect(flowNode.config.columns).toEqual(table.columns);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["e1", "e2", "e3"]);
  });
});

// A wire into a path pin wins over the dragged path, so the pin sits beside
// the drop target holding the dragged one. While a wire is there the picker
// shows only the pin, named, and the dragged path comes back when it goes.
// What shows is the stylesheet's, keyed on the picker's `wired` class.
describe("a node's path pin", () => {
  it("sits left of the drop target, and marks its picker wired while a wire is in it", () => {
    const wire = {
      id: "e1",
      source: "resolve-1",
      sourcePort: "path",
      target: "loadNote-1",
      targetPort: "path",
    };
    const { cards, deps, graph } = setup();
    const flowNode = node("loadNote", { notePath: "space:notes/a.md" });
    const el = cards.build(flowNode);
    const pin = el.querySelector('.handle.target[data-handleid="path"]') as HTMLElement;
    const target = el.querySelector(".flow-space-drop") as HTMLElement;
    const row = pin.parentElement as HTMLElement;
    const picker = row.parentElement as HTMLElement;
    expect(el.querySelector(".flow-node-inputs .flow-port-row")).toBeNull();
    expect(row.classList.contains("flow-path-row")).toBe(true);
    // The `path` output's own row ends it.
    expect([...row.children].map((child) => child.className.split(" ")[0])).toEqual([
      "handle",
      "flow-port-label",
      "flow-dropzone",
      "flow-port-row",
    ]);
    expect(row.querySelector(".flow-port-label")?.textContent).toBe("path");
    expect(row.children[2]).toBe(target);
    expect(picker.classList.contains("flow-path-picker")).toBe(true);
    expect(pin.classList.contains("unconnected")).toBe(true);
    expect(picker.classList.contains("wired")).toBe(false);

    // The pin moves as the picker empties, so the card is measured again.
    graph.edges.push(wire);
    cards.updateInputWidgetVisibility("loadNote-1", "path");
    expect(pin.classList.contains("unconnected")).toBe(false);
    expect(picker.classList.contains("wired")).toBe(true);
    expect(deps.onLayoutChange).toHaveBeenCalledTimes(1);
    cards.updateInputWidgetVisibility("loadNote-1", "path");
    expect(deps.onLayoutChange).toHaveBeenCalledTimes(1);

    graph.edges.length = 0;
    cards.updateInputWidgetVisibility("loadNote-1", "path");
    expect(picker.classList.contains("wired")).toBe(false);
    expect(deps.onLayoutChange).toHaveBeenCalledTimes(2);
    expect(flowNode.config.notePath).toBe("space:notes/a.md");
  });

  // Load Image's file is named by its chip, over the picture, so its pins
  // sit level with the chip as on every Load node.
  it("sits on Load Image's chip, above its picture", () => {
    const { cards } = setup();
    const el = cards.build(node("loadImage", { imagePath: "space:art/a.png" }));
    const row = el.querySelector(".flow-path-row") as HTMLElement;
    const zone = el.querySelector(".flow-dropzone:not(.flow-space-drop)") as HTMLElement;
    expect(row.querySelector(":scope > .flow-space-drop")).not.toBeNull();
    expect(row.nextElementSibling).toBe(zone);
    expect(el.querySelector(".flow-node-content button")).toBeNull();
  });

  it("sits beside a drop target on every node with one", () => {
    const { cards } = setup();
    for (const definition of Object.values(FLOW_NODE_REGISTRY)) {
      if (!definition.pathInput) continue;
      const el = cards.build(node(definition.type));
      const pin = el.querySelector(`.handle.target[data-handleid="${definition.pathInput.portId}"]`);
      const beside = pin?.closest(".flow-path-row")?.querySelector(".flow-dropzone") ?? null;
      expect(beside, definition.type).not.toBeNull();
    }
  });

  // The Table only says where the row goes, so a wire hides it as it hides
  // any node's file.
  it("hides Add Row's Table while a wire names the one it adds to", () => {
    const wire = { id: "e1", source: "resolve-1", sourcePort: "path", target: "addRow-1", targetPort: "path" };
    const { cards, graph } = setup();
    const flowNode = node("addRow", { tablePath: "space:renders/log.table.html" });
    const el = cards.build(flowNode);
    const picker = el.querySelector(".flow-path-picker") as HTMLElement;
    expect(picker.classList.contains("wired")).toBe(false);
    graph.edges.push(wire);
    cards.updateInputWidgetVisibility("addRow-1", "path");
    expect(picker.classList.contains("wired")).toBe(true);
  });
});

// A Load node hands on the file it read, so its `path` output sits right of
// that file: in the path pin's row where there is one, and after a folder
// loader's pick, never its folder. What shows is the stylesheet's.
describe("a Load node's path output", () => {
  const LOADERS = [
    "loadRow",
    "loadRandomRow",
    "loadTableRows",
    "loadNote",
    "loadFolderNote",
    "loadImage",
    "loadFolderImage",
  ];

  it("sits right of the file it hands on, out of the outputs", () => {
    const { cards } = setup();
    for (const type of LOADERS) {
      const el = cards.build(node(type));
      const pin = el.querySelector('.handle.source[data-handleid="path"]') as HTMLElement;
      const outputRow = pin.parentElement as HTMLElement;
      const fileRow = outputRow.parentElement as HTMLElement;
      expect(fileRow.classList.contains("flow-path-row"), type).toBe(true);
      expect(fileRow.lastElementChild, type).toBe(outputRow);
      expect(outputRow.previousElementSibling?.matches(".flow-dropzone, select"), type).toBe(true);
      const pathPin = fileRow.querySelector(':scope > .handle.target[data-handleid="path"]');
      expect(pathPin !== null, type).toBe(FLOW_NODE_REGISTRY[type].pathInput !== undefined);
      expect(el.querySelector('.flow-node-outputs [data-handleid="path"]'), type).toBeNull();
    }
    const folder = cards.build(node("loadFolderNote"));
    const pick = folder.querySelector('.handle.source[data-handleid="path"]')?.closest(".flow-path-row");
    expect(pick?.querySelector("select")).not.toBeNull();
    expect(pick?.querySelector(".flow-space-drop")).toBeNull();
  });

  it("stays among a writer's outputs", () => {
    const { cards } = setup();
    for (const type of ["writeNote", "addToNote", "addRow"]) {
      const el = cards.build(node(type));
      expect(el.querySelector('.flow-node-outputs .handle.source[data-handleid="path"]'), type).not.toBeNull();
    }
  });

  it("fades and wakes with its own wires, apart from the path pin's", () => {
    const wire = { id: "e1", source: "loadNote-1", sourcePort: "path", target: "show-1", targetPort: "text" };
    const { cards, graph } = setup();
    const el = cards.build(node("loadNote"));
    const output = el.querySelector('.handle.source[data-handleid="path"]') as HTMLElement;
    const input = el.querySelector('.handle.target[data-handleid="path"]') as HTMLElement;
    graph.edges.push(wire);
    cards.updateOutputHandleVisibility("loadNote-1", "path");
    expect(output.classList.contains("unconnected")).toBe(false);
    expect(input.classList.contains("unconnected")).toBe(true);
  });
});

describe("nodeCard Reuse result on repeat", () => {
  // The switch, and under it the held view: the held output with its label
  // and note, then Regenerate.
  function heldParts(el: HTMLElement) {
    const toggle = [...el.querySelectorAll<HTMLElement>(".flow-config-field.checkbox")].find(
      (field) => field.textContent === "Reuse result on repeat",
    );
    const held = el.querySelector<HTMLElement>(".flow-node-held");
    const result = held?.querySelector<HTMLElement>(".flow-config-field");
    const regenerate = [...(held?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Regenerate",
    );
    return {
      checkbox: toggle?.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      toggle,
      held,
      result,
      regenerate,
      label: result?.querySelector("label"),
      text: result?.querySelector("textarea"),
      note: result?.querySelector("p"),
    };
  }

  const reply = (id: string, value: string) => new Map([[id, { text: { type: "text" as const, value } }]]);

  it("shows the held output and Regenerate once a run gives a result, while the switch is on", () => {
    const { cards, deps } = setup();
    const flowNode = node("generateText");
    const el = cards.build(flowNode);
    const { checkbox, toggle, held, regenerate, label, text, note } = heldParts(el);
    expect(toggle?.dataset.tooltip).toBe("Reuse the last result generated when its inputs and settings repeat.");
    expect(held?.hidden).toBe(true);

    (checkbox as HTMLInputElement).checked = true;
    checkbox?.dispatchEvent(new Event("change"));
    expect(flowNode.config.reuse).toBe("true");
    // Nothing to show or regenerate yet.
    expect(held?.hidden).toBe(true);
    expect(deps.onLayoutChange).toHaveBeenCalledWith(flowNode.id);

    cards.showRunResult({ outputs: reply(flowNode.id, "the reply"), errors: new Map() });
    expect(held?.hidden).toBe(false);
    expect([label?.textContent, text?.value]).toEqual(["Last result", "the reply"]);

    // A run's start leaves it in place; the run's result replaces it.
    cards.clearRunState();
    expect([held?.hidden, text?.value]).toEqual([false, "the reply"]);
    cards.showRunResult({
      outputs: reply(flowNode.id, "the reply"),
      errors: new Map(),
      reports: new Map([[flowNode.id, ["Held: its inputs and settings repeated."]]]),
    });
    expect(note?.textContent).toBe("Held: its inputs and settings repeated.");
    // The shared button, which the stylesheet draws with its die.
    expect(regenerate?.classList.contains("flow-regenerate")).toBe(true);
    expect(regenerate?.dataset.tooltip).toBe("A new result, run on this node's last inputs");
    regenerate?.click();
    expect(deps.regenerate).toHaveBeenCalledWith(flowNode.id);

    cards.showRunResult({ outputs: new Map(), errors: new Map([[flowNode.id, "the model refused"]]) });
    expect(held?.hidden).toBe(true);
  });

  // A run fills the view while the switch hides it.
  it("shows a result an earlier run gave as soon as the switch goes on", () => {
    const { cards } = setup();
    const flowNode = node("generateText");
    const el = cards.build(flowNode);
    cards.showRunResult({ outputs: reply(flowNode.id, "already here"), errors: new Map() });
    const { checkbox, held, text } = heldParts(el);
    (checkbox as HTMLInputElement).checked = true;
    checkbox?.dispatchEvent(new Event("change"));
    expect([held?.hidden, text?.value]).toEqual([false, "already here"]);
  });

  it("shows a held list one entry a line", () => {
    const { cards } = setup();
    const flowNode = node("generateOptions", { reuse: "true" });
    const el = cards.build(flowNode);
    cards.showRunResult({
      outputs: new Map([[flowNode.id, { options: { type: "object", value: ["one", "two"] } }]]),
      errors: new Map(),
    });
    expect(heldParts(el).text?.value).toBe("one\ntwo");
  });
});

describe("nodeCard context pin", () => {
  it("hides Reuse result on repeat and the held result while the pin is wired, and shows what a run sent", () => {
    const { cards, graph } = setup();
    const flowNode = node("generateText", { reuse: "true" });
    graph.nodes.push(flowNode);
    const el = cards.build(flowNode);
    cards.syncWiring(flowNode);
    const toggle = [...el.querySelectorAll<HTMLElement>(".flow-config-field.checkbox")].find(
      (field) => field.textContent === "Reuse result on repeat",
    );
    const held = el.querySelector<HTMLElement>(".flow-node-held");
    const report = el.querySelector<HTMLElement>(".flow-node-config > .flow-node-report");
    const outputs = new Map([[flowNode.id, { text: { type: "text" as const, value: "Shot 1" } }]]);
    cards.showRunResult({ outputs, errors: new Map() });
    expect([toggle?.hidden, held?.hidden, report?.hidden]).toEqual([false, false, true]);

    graph.edges.push({ id: "e1", source: "go", sourcePort: "path", target: flowNode.id, targetPort: "context" });
    cards.updateSourceDependents(flowNode.id);
    expect([toggle?.hidden, held?.hidden]).toEqual([true, true]);
    const sent = ["Sent as context:", "/projects/story/README.md"];
    cards.showRunResult({ outputs, errors: new Map(), reports: new Map([[flowNode.id, sent]]) });
    expect([report?.hidden, report?.textContent]).toEqual([false, "Sent as context:\n/projects/story/README.md"]);

    graph.edges.length = 0;
    cards.updateSourceDependents(flowNode.id);
    expect([toggle?.hidden, held?.hidden, report?.hidden]).toEqual([false, false, true]);
  });
});

describe("nodeCard spellcheck", () => {
  afterEach(() => spellcheck.set(true));

  const content = (el: Element) => el.querySelector(".cm-content") as HTMLElement;

  it("checks Prompt's and Note's text while Spellcheck is on, never a mention or a variable", () => {
    const { cards } = setup();
    const prompt = cards.build(node("prompt", { text: "Show @image_1 and @image_12 to {{reader}} plainly" }));
    const note = cards.build(node("comment", { text: "A reminder" }));
    expect(content(prompt).getAttribute("spellcheck")).toBe("true");
    expect(content(note).getAttribute("spellcheck")).toBe("true");
    const names = prompt.querySelectorAll(".cm-image-mention, .cm-variable-mention");
    expect([...names].map((name) => [name.textContent, name.getAttribute("spellcheck")])).toEqual([
      ["@image_1", "false"],
      ["@image_12", "false"],
      ["{{reader}}", "false"],
    ]);

    spellcheck.set(false);
    expect(content(prompt).getAttribute("spellcheck")).toBe("false");
    expect(content(note).getAttribute("spellcheck")).toBe("false");
  });

  // An editor whose card is gone would otherwise go on hearing every change.
  it("lets go of the setting when its card goes", () => {
    const { cards } = setup();
    const prompt = cards.build(node("prompt", { text: "hello" }));
    cards.forget("prompt-1");
    expect(prompt.querySelector(".cm-editor")).toBeNull();
    const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
    spellcheck.set(false);
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });
});

describe("a disabled node's card", () => {
  it("is greyed and tagged as built, and marked again as what a run leaves out changes", () => {
    const { cards } = setup();
    const card = cards.build(node("prompt", {}, { mode: "disabled" }));
    expect(card.classList.contains("disabled")).toBe(true);
    expect(card.querySelector(".flow-node-title .flow-node-disabled-tag")?.textContent).toBe("Disabled");

    const fed = cards.build({ ...node("showText"), id: "showText-2" });
    const all = new Map<string, HTMLElement>([
      ["prompt-1", card],
      ["showText-2", fed],
    ]);
    markLeftOut(
      all,
      new Map([
        ["prompt-1", "prompt-1"],
        ["showText-2", "prompt-1"],
      ]),
    );
    expect([card.classList.contains("disabled"), fed.classList.contains("skipped")]).toEqual([true, true]);
    markLeftOut(all, new Map());
    expect([card.classList.contains("disabled"), fed.classList.contains("skipped")]).toEqual([false, false]);
  });

  // No failure, so muted, and gone with the next run's clearing.
  it("says why a run skipped a node it feeds, apart from an error", () => {
    const { cards, graph } = setup();
    const disabled = node("generateText", {}, { mode: "disabled", label: "Rewrite" });
    const fed = { ...node("showText"), id: "showText-2" };
    graph.nodes.push(disabled, fed);
    const card = cards.build(fed);
    cards.showRunResult({
      outputs: new Map(),
      errors: new Map(),
      skipped: new Map([["showText-2", "generateText-1"]]),
    });
    const line = card.querySelector(".flow-node-skipped") as HTMLElement;
    expect([line.hidden, line.textContent]).toEqual([false, "Skipped: Rewrite is disabled"]);
    cards.clearRunState();
    expect(line.hidden).toBe(true);
  });
});

describe("the placeholders a card offers", () => {
  const offered = () =>
    [...document.querySelectorAll(".placeholder-suggestions .placeholder-suggestion-text")].map(
      (row) => row.textContent,
    );
  const begin = (field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    field.value = text;
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  afterEach(() => {
    for (const list of document.querySelectorAll(".placeholder-suggestions")) list.remove();
  });

  it("offers the dates in a text box a run fills them in, and saves a pick as typing would", () => {
    const { cards, deps } = setup();
    const flowNode = node("writeFolderNote", { folderPath: "shots/" });
    const el = cards.build(flowNode);
    document.body.appendChild(el);
    const name = el.querySelector<HTMLInputElement>(".flow-port-row input.form-input") as HTMLInputElement;
    begin(name, "Shots {{");
    expect(offered()[0]).toBe("{{$date}}");
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(name.value).toBe("Shots {{$date}}");
    expect(flowNode.config.name).toBe("Shots {{$date}}");
    expect(deps.persistGraph).toHaveBeenCalled();
    el.remove();
  });

  it("offers them in a Choice's options too", () => {
    const { cards } = setup();
    const choice = cards.build(node("choice"));
    document.body.appendChild(choice);
    begin(choice.querySelector("textarea") as HTMLTextAreaElement, "{{");
    expect(offered()).toContain("{{$date:%Y}}");
    choice.remove();
  });
});

describe("a node's color", () => {
  const color = (el: HTMLElement) => el.style.getPropertyValue("--node-color");
  const firstSwatch = () => document.querySelector<HTMLButtonElement>(".color-picker-swatch") as HTMLButtonElement;
  const openColor = (deps: NodeCardDeps, el: HTMLElement) => {
    contextMenuOn(el.querySelector(".flow-node-title") as Element);
    ((deps.menus.openNodeMenu as ReturnType<typeof vi.fn>).mock.calls[0][4] as () => void)();
  };
  // jsdom plays no media, and a Load Video card holds a player.
  let media: { mockRestore(): void }[] = [];
  beforeEach(() => {
    media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const spy of media) spy.mockRestore();
    document.body.replaceChildren();
  });

  it("is its default with none of its own: the Table kind's on a node naming a Table, AI's violet, none for the rest", () => {
    const { cards } = setup();
    expect(color(cards.build(node("generateImage", { outputFolderPath: "art" })))).toBe("#7c3aed");
    for (const type of ["loadRow", "loadRandomRow", "loadTableRows", "makeObject", "addRow"]) {
      const el = cards.build(node(type));
      expect(color(el)).toBe("var(--kind-table)");
      expect(el.classList.contains("tinted")).toBe(true);
    }
    for (const plain of [
      node("loadImage"),
      node("loadFolderImage"),
      node("loadVideo"),
      node("applet"),
      node("prompt", { text: "" }),
      node("int"),
      node("getField"),
    ]) {
      const el = cards.build(plain);
      expect(color(el)).toBe("");
      expect(el.classList.contains("tinted")).toBe(false);
    }
  });

  it("is its own when it has one, whatever its category", () => {
    const { cards } = setup();
    const el = cards.build(node("loadVideo", {}, { color: "#0db14c" }));
    expect(color(el)).toBe("#0db14c");
    expect(el.classList.contains("tinted")).toBe(true);
  });

  it("goes back to its category's from the picker's Default swatch, saving none of its own", () => {
    const { cards, deps } = setup();
    const flowNode = node("generateImage", { outputFolderPath: "art" }, { color: "#0db14c" });
    const el = cards.build(flowNode);
    document.body.append(el);
    openColor(deps, el);
    expect(firstSwatch().getAttribute("aria-label")).toBe("Default");
    expect(firstSwatch().style.getPropertyValue("--swatch")).toBe("#7c3aed");
    firstSwatch().click();
    expect(flowNode.color).toBeUndefined();
    expect(color(el)).toBe("#7c3aed");
    expect(el.classList.contains("tinted")).toBe(true);
    expect(deps.persistGraph).toHaveBeenCalled();
  });

  it("clears to plain from No color on a node whose category has no color", () => {
    const { cards, deps } = setup();
    const flowNode = node("loadImage", {}, { color: "#0db14c" });
    const el = cards.build(flowNode);
    document.body.append(el);
    openColor(deps, el);
    expect(firstSwatch().getAttribute("aria-label")).toBe("No color");
    firstSwatch().click();
    expect(flowNode.color).toBeUndefined();
    expect(color(el)).toBe("");
    expect(el.classList.contains("tinted")).toBe(false);
  });
});

// What a card hiding its unused pins keeps: a wire, a required pin, an
// exposed field, and a field off a new node's value.
describe("a card hiding its unused pins", () => {
  const rowOf = (card: HTMLElement, portId: string, side: "target" | "source" = "target") =>
    (card.querySelector(`.handle.${side}[data-handleid="${portId}"]`) as HTMLElement).closest(
      ".flow-port-row",
    ) as HTMLElement;
  const unused = (el: Element) => el.classList.contains("unused");
  const wire = (target: string, targetPort: string): FlowEdgeInstance => ({
    id: `e-${target}-${targetPort}`,
    source: "prompt-9",
    sourcePort: "text",
    target,
    targetPort,
  });

  it("marks unwired outputs and optional pins, never a wired, required or exposed one", () => {
    const { cards } = setup([wire("generateText-1", "context")]);
    const wired = cards.build(node("generateText", {}, { exposed: ["text"] }));
    expect(unused(rowOf(wired, "prompt"))).toBe(false);
    expect(unused(rowOf(wired, "context"))).toBe(false);
    expect(unused(rowOf(wired, "text", "source"))).toBe(false);
    const bare = cards.build({ ...node("generateText"), id: "generateText-2" });
    expect(unused(rowOf(bare, "context"))).toBe(true);
    expect(unused(rowOf(bare, "text", "source"))).toBe(true);
    const shown = cards.build(node("showText"));
    expect(unused(rowOf(shown, "text"))).toBe(false);
  });

  it("marks a field only while it holds a new node's value, a model's with its effort", () => {
    const { cards } = setup();
    const video = cards.build(
      node("generateVideo", { aspect_ratio: "1:1", resolution: "720p", duration: "3", prefix: "{{$date:%y%m%d}}" }),
    );
    expect(["model", "aspect_ratio", "resolution", "duration", "prefix"].map((id) => unused(rowOf(video, id)))).toEqual(
      [true, true, false, true, true],
    );
    const join = cards.build(node("joinText", { text_1: "", text_2: "draft", text_3: "", separator: "" }));
    expect(["text_1", "text_2", "text_3", "separator"].map((id) => unused(rowOf(join, id)))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const text = cards.build(node("generateText", { effort: "high" }));
    expect(unused(rowOf(text, "model"))).toBe(false);
  });

  it("takes a group whose every row goes, and a + adding pins that would go", () => {
    const { cards } = setup();
    const settings = (card: HTMLElement) => card.querySelector(".flow-model-settings") as HTMLElement;
    expect(unused(settings(cards.build(node("generateVideo"))))).toBe(true);
    const folded = cards.build({ ...node("generateVideo", {}, { settingsFolded: true }), id: "generateVideo-2" });
    expect(unused(settings(folded))).toBe(false);
    const set = cards.build({ ...node("generateVideo", { resolution: "720p" }), id: "generateVideo-3" });
    expect(unused(settings(set))).toBe(false);
    const add = (card: HTMLElement) => card.querySelector(".flow-add-variable-row") as HTMLElement;
    expect(unused(add(cards.build(node("generateText"))))).toBe(true);
    expect(unused(add(cards.build(node("templateVariables"))))).toBe(false);
  });

  it("takes a path pin alone, leaving the file beside it", () => {
    const { cards } = setup();
    const card = cards.build(node("loadNote", { notePath: "space:notes/a.md" }));
    const pin = card.querySelector('.handle.target[data-handleid="path"]') as HTMLElement;
    expect(unused(pin)).toBe(true);
    expect(unused(pin.closest(".flow-path-row") as HTMLElement)).toBe(false);
  });

  it("counts what it hides in its title while its node hides them, a click there showing them", () => {
    const { cards, deps } = setup();
    const flowNode = node("showText", {}, { unusedPinsHidden: true });
    const card = cards.build(flowNode);
    const count = card.querySelector(".flow-node-title .flow-node-unused-count") as HTMLButtonElement;
    expect(card.classList.contains("unused-pins-hidden")).toBe(true);
    expect([count.hidden, count.textContent, count.dataset.tooltip]).toEqual([
      false,
      "1",
      "1 unused pin hidden. Click to show it.",
    ]);
    count.click();
    expect(deps.menus.toggleUnusedPins).toHaveBeenCalledWith("showText-1");

    delete flowNode.unusedPinsHidden;
    cards.syncUnusedPins("showText-1");
    expect(card.classList.contains("unused-pins-hidden")).toBe(false);
    expect(count.hidden).toBe(true);
    expect(deps.onLayoutChange).toHaveBeenCalledWith("showText-1");
  });

  it("marks again as wires and values change, measuring the card while it hides them", () => {
    const { cards, deps, graph } = setup();
    const flowNode = node(
      "joinText",
      { text_1: "", text_2: "draft", text_3: "", separator: ", " },
      { unusedPinsHidden: true },
    );
    const card = cards.build(flowNode);
    graph.edges.push(wire("joinText-1", "text_1"));
    cards.updateInputWidgetVisibility("joinText-1", "text_1");
    expect(unused(rowOf(card, "text_1"))).toBe(false);
    expect(deps.onLayoutChange).toHaveBeenCalledTimes(1);

    const field = rowOf(card, "text_2").querySelector("input") as HTMLInputElement;
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(flowNode.config.text_2).toBe("");
    expect(unused(rowOf(card, "text_2"))).toBe(true);
    expect(card.querySelector(".flow-node-unused-count")?.textContent).toBe("5");
  });

  // A field being edited stays until focus leaves it, so the card is measured then.
  it("measures the card once focus has left one of its fields", async () => {
    const { cards, deps } = setup();
    const card = cards.build(node("joinText", {}, { unusedPinsHidden: true }));
    card.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(deps.onLayoutChange).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.onLayoutChange).toHaveBeenCalledWith("joinText-1");
  });
});
