// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOW_NODE_REGISTRY } from "../../../src/protocol/flowNodes.ts";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import { ApiError, type SandboxReadResult } from "../../../web/core/apiClient.ts";
import { type AppModeDeps, createAppMode, placeExposedNode } from "../../../web/flow/appMode.ts";
import type { MenuOpenOptions } from "../../../web/services/menus.ts";
import { drop } from "../support/drag.ts";
import { fakeModelFields } from "../support/fakeModelFields.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A Load Image field's picture zone, beside its chip, which is a drop
// target too.
const pictureZone = (pane: HTMLElement) =>
  pane.querySelector(".flow-node-image-picker > .flow-dropzone:not(.flow-space-drop)") as HTMLElement;
// jsdom lays nothing out, so there is no resize to observe.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function node(type: string, config: Record<string, unknown> = {}, exposed?: string[]): FlowNodeInstance {
  return { id: `${type}-1`, type, position: { x: 0, y: 0 }, config, exposed } as FlowNodeInstance;
}

const table: SandboxReadResult = {
  kind: "table",
  columns: [{ id: "name", label: "Name", type: "text" }],
  rows: [{ values: { name: "A" } }, { values: { name: "B" } }],
};

function setup(nodes: FlowNodeInstance[], overrides: Partial<AppModeDeps> = {}) {
  const graph: FlowGraph = { nodes, edges: [] };
  const opened: MenuOpenOptions[] = [];
  const el = () => document.createElement("div");
  const elements = { pane: el(), hud: el(), canvasToolbar: el(), appModePane: el() };
  document.body.append(elements.appModePane);
  const deps: AppModeDeps = {
    elements,
    graph: () => graph,
    persistGraph: vi.fn(),
    saveGraphNow: vi.fn(async () => true),
    ensureCapability: vi.fn(async () => true),
    read: vi.fn(async () => table),
    pickedImages: new Map(),
    directoryChildren: vi.fn(() => undefined),
    flowPath: () => "story.flow.html",
    modelFields: fakeModelFields(),
    contextMenu: { open: (options) => void opened.push(options), close() {}, isOpen: () => false },
    openChipMenu: vi.fn(),
    regenerate: vi.fn(),
    run: vi.fn(async () => undefined),
    showRuns: vi.fn(),
    remountNodes: vi.fn(),
    loadFile: vi.fn(async () => {
      throw new Error("no files in this test");
    }),
    injectAppletRuntime: vi.fn(() => ""),
    previewResult: vi.fn(),
    ...overrides,
  };
  return { appMode: createAppMode(deps), deps, elements, graph, opened };
}

describe("appMode", () => {
  it("entering swaps the panes and shows the empty notice with nothing exposed; leaving restores them", () => {
    const { appMode, elements, graph } = setup([node("prompt", { text: "hi" })]);
    appMode.setActive(true);
    expect(appMode.isActive()).toBe(true);
    // The graph keeps the Flow's default view: a switch never writes it.
    expect(graph.appModeActive).toBeUndefined();
    expect([elements.pane.hidden, elements.hud.hidden, elements.canvasToolbar.hidden]).toEqual([true, true, true]);
    expect(elements.appModePane.hidden).toBe(false);
    expect(elements.appModePane.querySelector(".flow-app-empty")?.textContent).toMatch(/Nothing exposed yet/);

    appMode.setActive(false);
    expect(appMode.isActive()).toBe(false);
    expect(graph.appModeActive).toBeUndefined();
    expect(elements.pane.hidden).toBe(false);
    expect(elements.appModePane.hidden).toBe(true);
    expect(elements.appModePane.childElementCount).toBe(0);
  });

  it("an exposed checkbox widget is a switch that edits the config; leaving remounts the edited card", () => {
    const toggle = node("toggleText", { true: "true" }, ["true"]);
    const { appMode, deps, elements } = setup([toggle]);
    appMode.setActive(true);
    const section = elements.appModePane.querySelector<HTMLElement>(".flow-app-node");
    expect(section?.dataset.nodeId).toBe("toggleText-1");
    expect(section?.querySelector(".flow-app-node-title")?.textContent).toBe("Toggle");
    const control = section?.querySelector<HTMLButtonElement>(".toggle-switch");
    expect(control?.getAttribute("aria-checked")).toBe("true");

    control?.click();
    expect(toggle.config.true).toBe("false");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);

    appMode.setActive(false);
    expect(deps.remountNodes).toHaveBeenCalledWith(["toggleText-1"]);
    appMode.setActive(true);
    appMode.setActive(false);
    expect(deps.remountNodes).toHaveBeenCalledTimes(1); // nothing edited the second time
  });

  it("a model input is a text-model picker, and a text widget edits in place", async () => {
    const generate = node("generateText", {}, ["model"]);
    const toggle = node("toggleText", { on_true: "yes" }, ["on_true"]);
    const modelFields = fakeModelFields();
    const { appMode, elements } = setup([generate, toggle], { modelFields });
    appMode.setActive(true);
    await tick();
    const [field] = modelFields.fields;
    expect(field.kind).toBe("text");
    expect(elements.appModePane.contains(field.button)).toBe(true);
    field.onPick("m1");
    expect(generate.config.model).toBe("m1");

    const input = elements.appModePane.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe("yes");
    input.value = "no";
    input.dispatchEvent(new Event("input"));
    expect(toggle.config.on_true).toBe("no");
  });

  it("a select widget is the card's picker, keeping a stored value its options lack", () => {
    const generated = node("generateImage", { aspect_ratio: "2.39:1" }, ["aspect_ratio"]);
    const { appMode, deps, elements, opened } = setup([generated]);
    appMode.setActive(true);
    const button = elements.appModePane.querySelector(".flow-config-field button.picker") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("aspect ratio: 2.39:1");

    button.click();
    const items = opened[0].items ?? [];
    expect([items[0].label, items.at(-1)?.label]).toEqual(["1:1", "2.39:1"]);
    items.find((item) => item.label === "16:9")?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect(generated.config.aspect_ratio).toBe("16:9");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
  });

  it("describes an exposed input over its field, and no output", () => {
    // `path` names the output: App Mode matches an exposed id to an output first.
    const resolve = node("resolvePath", { base: "notes/" }, ["base", "path"]);
    const { appMode, elements } = setup([resolve]);
    appMode.setActive(true);
    const description = FLOW_NODE_REGISTRY.resolvePath.inputs.find((port) => port.id === "base")?.description;
    expect(description).toBeTruthy();
    expect(FLOW_NODE_REGISTRY.resolvePath.outputs.find((port) => port.id === "path")?.description).toBeTruthy();
    const input = elements.appModePane.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement;
    expect(input.closest<HTMLElement>(".flow-config-field")?.dataset.tooltip).toBe(description);
    const output = elements.appModePane.querySelector<HTMLElement>(".flow-app-output") as HTMLElement;
    expect(output.querySelector("[data-tooltip]")).toBeNull();
    expect(output.dataset.tooltip).toBeUndefined();
  });

  it("puts Regenerate on the image output of a type that reuses its results, and on no other output", () => {
    const generated = node("generateImage", {}, ["image", "path"]);
    const loaded = node("loadImage", {}, ["image"]);
    const { appMode, deps, elements } = setup([generated, loaded]);
    appMode.setActive(true);
    const regenerate = [...elements.appModePane.querySelectorAll("button")].filter(
      (button) => button.textContent === "Regenerate",
    );
    expect(regenerate).toHaveLength(1);
    expect(regenerate[0].closest(".flow-app-node")?.getAttribute("data-node-id")).toBe("generateImage-1");
    // It asks for another result, so it waits for a first.
    expect(regenerate[0].hidden).toBe(true);
    appMode.showResults({
      outputs: new Map([["generateImage-1", { image: { type: "image", mediaType: "image/png", data: "AAAA" } }]]),
      errors: new Map(),
    });
    expect(regenerate[0].hidden).toBe(false);
    regenerate[0].click();
    expect(deps.regenerate).toHaveBeenCalledWith("generateImage-1");
  });

  it("shows a Generate Video node's exposed path as its clip, with Regenerate for a new take", () => {
    // jsdom plays no media.
    const media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
    ];
    const generated = node("generateVideo", {}, ["path"]);
    const { appMode, elements } = setup([generated]);
    appMode.setActive(true);
    const tile = elements.appModePane.querySelector('[data-node-id="generateVideo-1"]') as HTMLElement;
    const value = tile.querySelector(".flow-app-output-value") as HTMLElement;
    const regenerate = [...tile.querySelectorAll("button")].find(
      (button) => button.textContent === "Regenerate",
    ) as HTMLButtonElement;
    expect(value.textContent).toBe("Not run yet");
    expect(regenerate.hidden).toBe(true);
    expect(regenerate.dataset.tooltip).toBe("A new take, run on this node's last inputs");

    appMode.showResults({
      outputs: new Map([["generateVideo-1", { path: { type: "text", value: "/clips/a.mp4" } }]]),
      errors: new Map(),
    });
    expect(value.classList.contains("has-clip")).toBe(true);
    expect(value.querySelector("video")?.getAttribute("src")).toBe("/api/file/raw?path=clips%2Fa.mp4");
    expect(regenerate.hidden).toBe(false);

    appMode.showResults({ outputs: new Map(), errors: new Map([["generateVideo-1", "Video generation failed"]]) });
    expect(value.className).toBe("flow-app-output-value error");
    expect(value.textContent).toBe("Video generation failed");
    expect(value.querySelector("video")).toBeNull();

    appMode.showResults({
      outputs: new Map(),
      errors: new Map([["generateVideo-1", "No video model."]]),
      needs: new Map([["generateVideo-1", { kind: "defaultModel", output: "video" }]]),
    });
    expect(value.querySelector(".inline-error-message")?.textContent).toBe("No video model.");
    expect(value.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
    for (const spy of media) spy.mockRestore();
  });

  // The picture shown is the run's copy; the preview reads the file it was saved as.
  it("previews a Generate node's file from a click on its picture or its clip, and no loaded picture", () => {
    const media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined),
    ];
    const nodes = [
      node("generateImage", {}, ["image"]),
      node("generateVideo", {}, ["path"]),
      node("loadImage", {}, ["image"]),
    ];
    const { appMode, deps, elements } = setup(nodes);
    appMode.setActive(true);
    const picture = { type: "image", mediaType: "image/png", data: "AAAA" } as const;
    appMode.showResults({
      outputs: new Map([
        ["generateImage-1", { image: picture, path: { type: "text", value: "/art/a-0123456789ab.png" } }],
        ["generateVideo-1", { path: { type: "text", value: "/clips/a.mp4" } }],
        ["loadImage-1", { image: picture }],
      ]),
      errors: new Map(),
    });
    const tile = (id: string) => elements.appModePane.querySelector(`[data-node-id="${id}"]`) as HTMLElement;

    (tile("generateImage-1").querySelector("img") as HTMLImageElement).click();
    expect(deps.previewResult).toHaveBeenLastCalledWith("art/a-0123456789ab.png");

    media[1].mockClear();
    (tile("generateVideo-1").querySelector("video") as HTMLVideoElement).click();
    expect(deps.previewResult).toHaveBeenLastCalledWith("clips/a.mp4");
    expect([media[1].mock.calls.length, media[2].mock.calls.length]).toEqual([1, 0]);

    const loaded = tile("loadImage-1").querySelector("img") as HTMLImageElement;
    expect(loaded.classList.contains("is-previewable")).toBe(false);
    loaded.click();
    expect(deps.previewResult).toHaveBeenCalledTimes(2);
    for (const spy of media) spy.mockRestore();
  });

  it("names each switch for its field, a widget's and a config field's alike", () => {
    const { appMode, elements } = setup([
      node("toggleText", { true: "true" }, ["true", "on_true"]),
      node("generateText", { reuse: "false" }, ["reuse", "text"]),
    ]);
    appMode.setActive(true);
    const name = (nodeId: string) =>
      elements.appModePane.querySelector(`[data-node-id="${nodeId}"] .toggle-switch`)?.getAttribute("aria-label");
    expect([name("toggleText-1"), name("generateText-1")]).toEqual(["true", "Reuse result on repeat"]);
  });

  it("puts Regenerate on a held text node's result once it has one, while it holds, following its switch", () => {
    const generate = node("generateText", { reuse: "false" }, ["reuse", "text"]);
    const { appMode, deps, elements } = setup([generate]);
    appMode.setActive(true);
    const regenerate = [...elements.appModePane.querySelectorAll("button")].find(
      (button) => button.textContent === "Regenerate",
    );
    const toggle = () => elements.appModePane.querySelector<HTMLButtonElement>(".toggle-switch")?.click();
    const reply = {
      outputs: new Map([["generateText-1", { text: { type: "text" as const, value: "r" } }]]),
      errors: new Map(),
    };
    expect(regenerate?.hidden).toBe(true);

    toggle();
    expect(generate.config.reuse).toBe("true");
    expect(regenerate?.hidden).toBe(true); // nothing generated yet
    appMode.showResults(reply);
    expect(regenerate?.hidden).toBe(false);
    regenerate?.click();
    expect(deps.regenerate).toHaveBeenCalledWith("generateText-1");

    appMode.clearResults();
    expect(regenerate?.hidden).toBe(true);
    appMode.showResults(reply);
    toggle();
    expect(regenerate?.hidden).toBe(true);
  });

  it("the Run item sits last, runs the graph while runs go, and counts them, revealing them", () => {
    const { appMode, deps, elements } = setup([node("toggleText", {}, ["true"])]);
    appMode.setRunCount(2);
    appMode.setActive(true);
    const tile = elements.appModePane.querySelector(".flow-app-grid")?.lastElementChild as HTMLElement;
    expect(tile.classList.contains("flow-app-run-item")).toBe(true);
    const run = tile.querySelector(".flow-app-run-button") as HTMLButtonElement;
    const count = tile.querySelector(".flow-run-count") as HTMLButtonElement;
    expect([count.hidden, count.textContent]).toEqual([false, "2 running"]);
    run.click();
    run.click();
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(run.disabled).toBe(false);

    count.click();
    expect(deps.showRuns).toHaveBeenCalledTimes(1);
    appMode.setRunCount(0);
    expect(count.hidden).toBe(true);
  });

  it("output fields show a run's values or its errors, even while the form is hidden", () => {
    const generate = node("generateText", {}, ["text"]);
    const { appMode, elements } = setup([generate]);
    appMode.setActive(true);
    const value = () => elements.appModePane.querySelector(".flow-app-output-value") as HTMLElement;
    expect(value().textContent).toBe("Not run yet");

    appMode.showResults({
      outputs: new Map([["generateText-1", { text: { type: "text", value: "hello" } }]]),
      errors: new Map(),
    });
    expect(value().textContent).toBe("hello");
    expect(value().classList.contains("empty")).toBe(false);

    appMode.showResults({ outputs: new Map(), errors: new Map([["generateText-1", "boom"]]) });
    expect(value().className).toBe("flow-app-output-value error");
    expect(value().textContent).toBe("boom");

    appMode.showResults({
      outputs: new Map(),
      errors: new Map([["generateText-1", "No model selected."]]),
      needs: new Map([["generateText-1", { kind: "defaultModel", output: "text" }]]),
    });
    expect(value().querySelector(".inline-error-message")?.textContent).toBe("No model selected.");
    expect(value().querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
  });

  it("the table-row field reads the table through the gate and fills its dropdown", async () => {
    const load = node("loadRow", { tablePath: "t.table.html" }, ["selectedValue"]);
    const { appMode, deps, elements } = setup([load]);
    appMode.setActive(true);
    await tick();
    await tick();
    // A path from the saved file is never a drag, so the read asks.
    expect(deps.ensureCapability).toHaveBeenCalledWith({ type: "readFile", path: "t.table.html" }, false);
    const select = elements.appModePane.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["A", "B"]);
    expect(elements.appModePane.querySelector(".flow-config-label")?.textContent).toBe("Select Name");
    expect(load.config.selectedValue).toBe("A");
  });

  // The folder's grant covers a pick by matching its parent exactly as
  // written, so a space: folder's picks carry space: too.
  it("an exposed folder pick lists the folder from the tree, read from the Flow's folder", () => {
    const children = vi.fn((dirPath: string) =>
      dirPath === "refs"
        ? [
            { name: "a.md", path: "refs/a.md", type: "file" },
            { name: "b.md", path: "refs/b.md", type: "file" },
          ]
        : undefined,
    ) as unknown as AppModeDeps["directoryChildren"];
    const folder = node("loadFolderNote", { folderPath: "../refs/" }, ["notePath"]);
    const flowPath = () => "projects/story.flow.html";
    const { appMode, elements } = setup([folder], { directoryChildren: children, flowPath });
    appMode.setActive(true);
    const select = elements.appModePane.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["../refs/a.md", "a"],
      ["../refs/b.md", "b"],
    ]);
    expect(folder.config.notePath).toBe("../refs/a.md");
  });

  it("a pick its folder or table no longer has stays, shown missing, and nothing is saved", async () => {
    const children = vi.fn((dirPath: string) =>
      dirPath === "refs" ? [{ name: "a.md", path: "refs/a.md", type: "file" }] : undefined,
    ) as unknown as AppModeDeps["directoryChildren"];
    const folder = node("loadFolderNote", { folderPath: "refs", notePath: "refs/gone.md" }, ["notePath"]);
    const row = {
      ...node("loadRow", { tablePath: "t.table.html", selectedValue: "C" }, ["selectedValue"]),
      id: "row",
    };
    const { appMode, deps, elements } = setup([folder, row], { directoryChildren: children });
    appMode.setActive(true);
    await tick();
    await tick();
    const [folderSelect, rowSelect] = elements.appModePane.querySelectorAll("select");
    expect([...folderSelect.options].map((o) => o.textContent)).toEqual(["gone (missing)", "a"]);
    expect(folderSelect.value).toBe("refs/gone.md");
    expect([...rowSelect.options].map((o) => o.textContent)).toEqual(["C (missing)", "A", "B"]);
    expect(rowSelect.value).toBe("C");
    expect([folder.config.notePath, row.config.selectedValue]).toEqual(["refs/gone.md", "C"]);
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });

  it("an exposed Prompt is a text box and an exposed Choice a dropdown, each editing the node's own value", () => {
    const prompt = node("prompt", { text: "A racing driver" }, ["text"]);
    const choice = { ...node("choice", { options: "Wide\nClose-up" }, ["text"]), id: "choice-1" };
    const { appMode, elements } = setup([prompt, choice]);
    appMode.setActive(true);

    const textarea = elements.appModePane.querySelector('[data-node-id="prompt-1"] textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe("A racing driver");
    textarea.value = "A diver";
    textarea.dispatchEvent(new Event("input"));
    expect(prompt.config.text).toBe("A diver");

    const select = elements.appModePane.querySelector('[data-node-id="choice-1"] select') as HTMLSelectElement;
    expect(select.value).toBe("Wide");
    select.value = "Close-up";
    select.dispatchEvent(new Event("change"));
    expect(choice.config.text).toBe("Close-up");
    // Fields, not results: nothing waits on a run to fill them.
    expect(elements.appModePane.querySelector(".flow-app-output")).toBeNull();
  });

  it("an exposed image picker names its stored file and size in the hover bars", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAAAAAA" };
    const loadImage = node("loadImage", { imagePath: "refs/plate.png" }, ["imagePath"]);
    const { appMode, elements } = setup([loadImage], { read: vi.fn(async () => image) });
    appMode.setActive(true);
    await tick();
    await tick();
    const picker = elements.appModePane.querySelector(".flow-node-image-picker") as HTMLElement;
    expect(picker.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAAAAAA");
    const bars = [...picker.querySelectorAll(".media-hud-bar:last-child > span")].map((cell) => cell.textContent);
    expect(bars).toEqual(["plate.png", "6 B"]);
  });

  // Text another app drops reads as a path too, but nobody picked it from what
  // Pragma shows: only Pragma's own drag skips the prompt, as on the card.
  it("an exposed image picker takes a dropped file as consent only when Pragma's own drag brought it", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const ensureCapability = vi.fn(async () => true);
    const loadImage = node("loadImage", {}, ["imagePath"]);
    const { appMode, elements } = setup([loadImage], { read: vi.fn(async () => image), ensureCapability });
    appMode.setActive(true);
    const zone = pictureZone(elements.appModePane);
    const asked = { type: "readFile", path: "refs/plate.png" };
    drop(zone, "refs/plate.png", true);
    await vi.waitFor(() => expect(ensureCapability).toHaveBeenLastCalledWith(asked, false));
    expect(loadImage.config.imagePath).toBe("refs/plate.png");
    drop(zone, "refs/plate.png");
    await vi.waitFor(() => expect(ensureCapability).toHaveBeenLastCalledWith(asked, true));
  });

  it("an exposed video picker takes a dropped clip as consent only when Pragma's own drag brought it", async () => {
    // jsdom plays no media.
    const media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
    ];
    const ensureCapability = vi.fn(async () => true);
    const loadVideo = node("loadVideo", {}, ["videoPath"]);
    const { appMode, elements } = setup([loadVideo], { ensureCapability });
    appMode.setActive(true);
    const zone = elements.appModePane.querySelector(".flow-space-drop") as HTMLElement;
    const asked = { type: "readFile", path: "clips/take.mp4" };
    drop(zone, "clips/take.mp4", true);
    await vi.waitFor(() => expect(ensureCapability).toHaveBeenLastCalledWith(asked, false));
    expect(loadVideo.config.videoPath).toBe("clips/take.mp4");
    drop(zone, "clips/take.mp4");
    await vi.waitFor(() => expect(ensureCapability).toHaveBeenLastCalledWith(asked, true));
    for (const spy of media) spy.mockRestore();
  });

  it("an exposed image picker says a stored vector image is not a raster image, asking for nothing", async () => {
    const read = vi.fn();
    const ensureCapability = vi.fn(async () => true);
    const loadImage = node("loadImage", { imagePath: "refs/logo.svg" }, ["imagePath"]);
    const { appMode, elements } = setup([loadImage], { read, ensureCapability });
    appMode.setActive(true);
    await tick();
    const zone = pictureZone(elements.appModePane);
    expect(zone.textContent).toBe('"refs/logo.svg" is a vector image, not a raster image');
    expect(ensureCapability).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  // The chip and its states are the card's: a stored image whose file is gone
  // reads as missing, and the picture's place goes back to its prompt.
  it("an exposed image picker shows a stored file that is gone as a missing chip", async () => {
    const read = vi.fn(async () => Promise.reject(new ApiError('No file at "refs/gone.png"', 404)));
    const loadImage = node("loadImage", { imagePath: "refs/gone.png" }, ["imagePath"]);
    const { appMode, elements } = setup([loadImage], { read });
    appMode.setActive(true);
    const chip = elements.appModePane.querySelector(".flow-node-image-picker > .flow-space-drop") as HTMLElement;
    await vi.waitFor(() => expect(chip.classList.contains("missing")).toBe(true));
    expect(pictureZone(elements.appModePane).textContent).toBe("Click or drop an image");
  });

  // Expose is the canvas's, and every field here is exposed already, so a
  // right-click offers only the picture's own actions.
  it("an exposed image picker's right-click offers Choose image and Clear, and no Expose", async () => {
    const image: SandboxReadResult = { kind: "image", mediaType: "image/png", data: "AAAA" };
    const loadImage = node("loadImage", { imagePath: "refs/plate.png" }, ["imagePath"]);
    const { appMode, elements, opened } = setup([loadImage], { read: vi.fn(async () => image) });
    appMode.setActive(true);
    const zone = pictureZone(elements.appModePane);
    await vi.waitFor(() => expect(zone.querySelector(".flow-picture")).not.toBeNull());
    zone.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items = opened.at(-1)?.items ?? [];
    expect(items.map((item) => item.label)).toEqual(["Choose image…", "Clear"]);
    void items[1].run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect([loadImage.config.imagePath, zone.textContent]).toEqual([undefined, "Click or drop an image"]);
  });

  // A Clear draws the card again; here it draws the picker again, in its
  // place, and the card still remounts on leaving.
  it("an exposed video picker's Clear draws the picker again in its place", () => {
    // jsdom plays no media.
    const media = [
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}),
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
    ];
    const loadVideo = node("loadVideo", { videoPath: "clips/take.mp4" }, ["videoPath"]);
    const { appMode, elements, deps } = setup([loadVideo]);
    appMode.setActive(true);
    const field = elements.appModePane.querySelector('[data-node-id="loadVideo-1"] .flow-app-field') as HTMLElement;
    const chip = field.querySelector(".flow-space-drop") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
    expect(deps.openChipMenu).toHaveBeenLastCalledWith(5, 6, { file: "clips/take.mp4" }, expect.any(Function));

    vi.mocked(deps.openChipMenu).mock.calls.at(-1)?.[3]?.();
    expect(loadVideo.config.videoPath).toBeUndefined();
    const redrawn = field.querySelector(".flow-space-drop") as HTMLElement;
    expect(redrawn).not.toBe(chip);
    expect(redrawn.textContent).toBe("Drag a clip from your space here");
    appMode.setActive(false);
    expect(deps.remountNodes).toHaveBeenCalledWith(["loadVideo-1"]);
    for (const spy of media) spy.mockRestore();
  });

  it("shows no card for an unregistered node type or for a node none of whose exposed fields builds", () => {
    const ghost = { ...node("pickImage", { imagePath: "a.png" }, ["imagePath"]), appModeOrder: 0 };
    const stale = { ...node("prompt", { text: "hi" }, ["gone"]), appModeOrder: 1 };
    const { appMode, elements } = setup([ghost, stale, node("toggleText", {}, ["true"])]);
    appMode.setActive(true);
    const cards = [...elements.appModePane.querySelectorAll<HTMLElement>(".flow-app-node")];
    expect(cards.map((card) => card.dataset.nodeId)).toEqual(["toggleText-1"]);

    const { appMode: ghostOnly, elements: ghostElements } = setup([ghost]);
    ghostOnly.setActive(true);
    expect(ghostElements.appModePane.querySelector(".flow-app-empty")).not.toBeNull();
    expect(ghostElements.appModePane.querySelector(".flow-app-run-item")).toBeNull();
  });
});

describe("App Mode tiles", () => {
  afterEach(() => vi.restoreAllMocks());

  // jsdom lays nothing out, so the grid reads as a 1,238px pane: 6 columns.
  function wideGrid() {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("flow-app-grid") ? 1238 : 0;
    });
  }

  function spans(pane: HTMLElement): Record<string, string> {
    const tiles = [...(pane.querySelector(".flow-app-grid")?.children ?? [])] as HTMLElement[];
    return Object.fromEntries(
      tiles.map((tile) => [
        tile.dataset.nodeId ?? "run",
        `${tile.style.getPropertyValue("--tile-columns")}x${tile.style.getPropertyValue("--tile-rows")}`,
      ]),
    );
  }

  it("sizes a tile by what its fields show, unless the file stores a size, and fits it to the grid", () => {
    wideGrid();
    const generate = (id: string, exposed: string[]) => ({ ...node("generateText", {}, exposed), id });
    const { appMode, elements, graph } = setup([
      node("prompt", { text: "hi" }, ["text"]),
      node("choice", { options: "a\nb" }, ["text"]),
      node("loadImage", {}, ["imagePath"]),
      node("toggleText", {}, ["true"]),
      generate("generateText-1", ["text"]),
      generate("generate-2", ["model", "text"]),
      { ...generate("generate-3", ["model"]), appModeSize: { columns: 12, rows: 9 } },
      node("int", {}, ["value", "control", "int"]),
    ]);
    graph.runAppModeSize = { columns: 3, rows: 1 };
    appMode.setActive(true);
    expect(spans(elements.appModePane)).toEqual({
      "prompt-1": "3x2",
      "choice-1": "2x1",
      "loadImage-1": "2x3",
      "toggleText-1": "1x1",
      "generateText-1": "6x3",
      "generate-2": "6x4",
      "generate-3": "6x8",
      "int-1": "2x3",
      run: "3x1",
    });
  });

  it("heads a tile with its type's glyph and its title, edged in the node's colour or its type's", () => {
    const { appMode, elements } = setup([
      { ...node("loadImage", {}, ["imagePath"]), color: "#0b6e99" },
      node("generateText", {}, ["text"]),
      node("prompt", { text: "" }, ["text"]),
    ]);
    appMode.setActive(true);
    const [image, generate, prompt] = [...elements.appModePane.querySelectorAll<HTMLElement>(".flow-app-node")];
    expect(image.dataset.nodeType).toBe("loadImage");
    expect(image.querySelector(".flow-app-node-title > .flow-node-dot")).not.toBeNull();
    expect(image.querySelector(".flow-app-node-name")?.textContent).toBe("Load Image");
    expect(image.style.getPropertyValue("--node-color")).toBe("#0b6e99");
    expect(generate.style.getPropertyValue("--node-color")).toBe("#7c3aed");
    expect(prompt.style.getPropertyValue("--node-color")).toBe("");
  });

  it("titles an unnamed Chart by its columns, and keeps a Chart's own label or the type's when a column is unset", () => {
    const { appMode, elements } = setup([
      node("chart", { x: "Scene", y: "Takes" }, ["rows"]),
      { ...node("chart", { x: "Scene", y: "Minutes" }, ["rows"]), id: "chart-2", label: "Running time" },
      { ...node("chart", { x: "Scene" }, ["rows"]), id: "chart-3" },
    ]);
    appMode.setActive(true);
    const names = [...elements.appModePane.querySelectorAll(".flow-app-node-name")].map((name) => name.textContent);
    expect(names).toEqual(["Takes by Scene", "Running time", "Chart"]);
  });

  it("moves a lone result's copy button into the title, and leaves it by its label beside other fields", () => {
    const { appMode, elements } = setup([
      node("generateText", {}, ["text"]),
      { ...node("generateText", {}, ["model", "text"]), id: "generate-2" },
    ]);
    appMode.setActive(true);
    const [alone, shared] = [...elements.appModePane.querySelectorAll<HTMLElement>(".flow-app-node")];
    expect(alone.querySelector(".flow-app-node-title > .flow-node-textbox-copy")).not.toBeNull();
    expect(shared.querySelector(".flow-app-node-title > .flow-node-textbox-copy")).toBeNull();
    expect(shared.querySelector(".flow-app-output-header > .flow-node-textbox-copy")).not.toBeNull();
  });

  it("makes a tile whose one field is a boolean its switch, flipped from anywhere and lit while on", () => {
    const toggle = node("toggleText", { true: "false" }, ["true"]);
    const { appMode, deps, elements } = setup([toggle]);
    appMode.setActive(true);
    const tile = elements.appModePane.querySelector<HTMLElement>(".flow-app-node") as HTMLElement;
    const control = tile.querySelector<HTMLButtonElement>(".flow-app-node-title > .toggle-switch") as HTMLButtonElement;
    expect(tile.classList.contains("flow-app-toggle")).toBe(true);
    expect(tile.querySelector(".flow-app-node-fields")).toBeNull();
    expect(tile.classList.contains("on")).toBe(false);

    tile.click();
    expect([toggle.config.true, tile.classList.contains("on")]).toEqual(["true", true]);
    control.click(); // once, not again on its way through the tile
    expect([toggle.config.true, tile.classList.contains("on")]).toEqual(["false", false]);
    tile.querySelector<HTMLElement>(".flow-app-node-name")?.click();
    expect([toggle.config.true, tile.classList.contains("on")]).toEqual(["true", true]);
    expect(deps.persistGraph).toHaveBeenCalledTimes(3);
  });
});

// jsdom has no pointer capture and hit-tests nothing; a gesture test brings
// its own.
function stubPointerCapture() {
  for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
    Object.assign(HTMLElement.prototype, { [name]: vi.fn() });
  }
  Object.assign(HTMLElement.prototype, { hasPointerCapture: vi.fn(() => true) });
}

function unstubGestures() {
  vi.restoreAllMocks();
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  Reflect.deleteProperty(document, "elementFromPoint");
}

const pointer = (type: string, on: EventTarget, x: number, y = 40) =>
  on.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }));

const click = (on: Element) => on.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

describe("moving an App Mode tile", () => {
  afterEach(unstubGestures);

  // One row of three 100px tiles, toggle, prompt and Run, and the point under
  // the pointer resolved by that row: jsdom lays nothing out and hit-tests
  // nothing.
  function row() {
    const toggle = node("toggleText", { true: "false" }, ["true"]);
    const prompt = node("prompt", { text: "" }, ["text"]);
    const { appMode, deps, elements, graph } = setup([toggle, prompt]);
    appMode.setActive(true);
    const grid = elements.appModePane.querySelector(".flow-app-grid") as HTMLElement;
    const [toggleTile, promptTile, runTile] = [...grid.children] as HTMLElement[];
    [toggleTile, promptTile, runTile].forEach((tile, index) => {
      tile.getBoundingClientRect = () => ({ left: index * 100, width: 100, top: 0, bottom: 80 }) as DOMRect;
    });
    grid.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, bottom: 80 }) as DOMRect;
    const titleOf = (tile: Element) => (tile.querySelector(".flow-app-node-title") ?? tile) as Element;
    const pointAt = (x: number, y: number): Element =>
      y > 80 ? elements.appModePane : x >= 300 ? grid : titleOf([toggleTile, promptTile, runTile][Math.floor(x / 100)]);
    Object.assign(document, { elementFromPoint: vi.fn(pointAt) });
    stubPointerCapture();
    const order = () => [...grid.children].map((tile) => (tile as HTMLElement).dataset.nodeId ?? "run");
    // Run fills its tile, so a press on the tile lands on it.
    const runButton = runTile.querySelector(".flow-app-run-button") as HTMLButtonElement;
    return { deps, elements, graph, grid, toggle, prompt, toggleTile, promptTile, runTile, runButton, titleOf, order };
  }

  // A press on `handle`, carried to (x, y) and released there, then the
  // click a browser sends after a release.
  function drag(handle: Element, x: number, y = 40) {
    pointer("pointerdown", handle, 0);
    pointer("pointermove", document, 10);
    pointer("pointermove", document, x, y);
    pointer("pointerup", document, x, y);
    click(handle);
  }

  it("moves a tile onto the half of the tile under the pointer, saves once, and clicks nothing", () => {
    const { deps, graph, toggle, prompt, toggleTile, runTile, runButton, order } = row();
    pointer("pointerdown", runButton, 250);
    pointer("pointermove", document, 260);
    pointer("pointermove", document, 10);
    expect(document.querySelector(".flow-app-move-ghost")).not.toBeNull();
    expect(runTile.classList.contains("moving")).toBe(true);
    expect(toggleTile.classList.contains("drop-before")).toBe(true);

    pointer("pointerup", document, 10);
    click(runButton);
    expect(order()).toEqual(["run", "toggleText-1", "prompt-1"]);
    expect([graph.runAppModeOrder, toggle.appModeOrder, prompt.appModeOrder]).toEqual([0, 1, 2]);
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
    expect(deps.run).not.toHaveBeenCalled();
    expect(document.querySelector(".flow-app-move-ghost")).toBeNull();
    expect(toggleTile.classList.contains("drop-before")).toBe(false);
  });

  it("leaves a press that travels under 5px a click", () => {
    const { deps, toggle, toggleTile, runButton } = row();
    pointer("pointerdown", toggleTile, 50);
    pointer("pointermove", document, 53);
    pointer("pointerup", document, 53);
    click(toggleTile);
    expect(toggle.config.true).toBe("true");
    expect(document.querySelector(".flow-app-move-ghost")).toBeNull();

    pointer("pointerdown", runButton, 250);
    pointer("pointerup", document, 250);
    runButton.click();
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("puts a tile last when it drops on the grid's background or below its last row", () => {
    const { toggleTile, promptTile, titleOf, order } = row();
    drag(toggleTile, 350);
    expect(order()).toEqual(["prompt-1", "run", "toggleText-1"]);
    drag(titleOf(promptTile), 150, 300);
    expect(order()).toEqual(["run", "toggleText-1", "prompt-1"]);
  });

  it("cancels a move on Escape, and its release clicks nothing", () => {
    const { deps, toggle, toggleTile, runTile, order } = row();
    pointer("pointerdown", toggleTile, 50);
    pointer("pointermove", document, 150);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".flow-app-move-ghost")).toBeNull();
    pointer("pointermove", document, 250);
    pointer("pointerup", document, 250);
    click(toggleTile);
    expect(order()).toEqual(["toggleText-1", "prompt-1", "run"]);
    expect(toggle.config.true).toBe("false");
    expect(deps.persistGraph).not.toHaveBeenCalled();
    expect(runTile.classList.contains("drop-before")).toBe(false);
  });

  it("never starts a move from a field, only from a title or a one-control tile", () => {
    const { promptTile } = row();
    const textarea = promptTile.querySelector("textarea") as HTMLTextAreaElement;
    pointer("pointerdown", textarea, 150);
    pointer("pointermove", document, 250);
    expect(document.querySelector(".flow-app-move-ghost")).toBeNull();
    pointer("pointerup", document, 250);
  });
});

describe("resizing an App Mode tile", () => {
  afterEach(unstubGestures);

  // A grid `width` px wide, in which every tile's box is the span it shows,
  // in cells of 140 by 80px: jsdom lays nothing out, and reads gaps as 0.
  function sized(nodes: FlowNodeInstance[], width = 1120) {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("flow-app-grid") ? width : 0;
    });
    stubPointerCapture();
    const { appMode, deps, elements, graph } = setup(nodes);
    appMode.setActive(true);
    const board = elements.appModePane.querySelector(".flow-app-board") as HTMLElement;
    const tiles = [...(board.querySelector(".flow-app-grid")?.children ?? [])] as HTMLElement[];
    const span = (tile: HTMLElement) =>
      `${tile.style.getPropertyValue("--tile-columns")}x${tile.style.getPropertyValue("--tile-rows")}`;
    for (const tile of tiles) {
      tile.getBoundingClientRect = () => {
        const [columns, rows] = span(tile).split("x").map(Number);
        return { left: 0, top: 0, width: columns * 140, height: rows * 80 } as DOMRect;
      };
    }
    return { deps, graph, board, tiles, span };
  }

  // Presses `tile`'s grip at its corner and carries it by (dx, dy).
  function pull(tile: HTMLElement, dx: number, dy: number) {
    const { width, height } = tile.getBoundingClientRect();
    pointer("pointerdown", tile.querySelector(".flow-app-tile-grip") as Element, width, height);
    pointer("pointermove", document, width + dx, height + dy);
  }

  it("resizes a tile from its grip in whole cells, live, and saves the size once on release", () => {
    const prompt = node("prompt", { text: "" }, ["text"]);
    const { deps, board, tiles, span } = sized([prompt]);
    const [tile] = tiles;
    pull(tile, 150, 70);
    expect(span(tile)).toBe("4x3");
    expect(tile.querySelector(".flow-app-tile-badge")?.textContent).toBe("4 × 3");
    expect(board.classList.contains("arranging")).toBe(true);
    expect(deps.persistGraph).not.toHaveBeenCalled();

    pointer("pointerup", document, 0);
    expect(prompt.appModeSize).toEqual({ columns: 4, rows: 3 });
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);
    expect(tile.querySelector(".flow-app-tile-badge")).toBeNull();
    expect(board.classList.contains("arranging")).toBe(false);
  });

  it("keeps a tile within the grid's columns and 8 rows, and at least one cell", () => {
    const prompt = node("prompt", { text: "" }, ["text"]);
    const { tiles, span } = sized([prompt]);
    pull(tiles[0], 2000, 2000);
    expect(span(tiles[0])).toBe("6x8");
    pointer("pointermove", document, -2000, -2000);
    expect(span(tiles[0])).toBe("1x1");
    pointer("pointerup", document, 0);
    expect(prompt.appModeSize).toEqual({ columns: 1, rows: 1 });
  });

  it("puts a tile back unsaved on Escape or an unchanged release, and a grip press never clicks", () => {
    const { deps, graph, tiles, span } = sized([node("prompt", { text: "" }, ["text"])]);
    const run = tiles[1];
    pull(run, 300, 0);
    expect(span(run)).toBe("4x1");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(span(run)).toBe("2x1");
    pointer("pointerup", document, 0);
    click(run);

    pull(run, 30, 10);
    pointer("pointerup", document, 0);
    click(run);
    expect(graph.runAppModeSize).toBeUndefined();
    expect(deps.persistGraph).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();

    pull(run, 140, 0);
    pointer("pointerup", document, 0);
    expect(graph.runAppModeSize).toEqual({ columns: 3, rows: 1 });
  });

  it("keeps the dimension a resize left alone, as stored rather than as a narrow grid shows it", () => {
    const prompt = { ...node("prompt", { text: "" }, ["text"]), appModeSize: { columns: 4, rows: 3 } };
    const result = node("generateText", {}, ["text"]);
    const { tiles, span } = sized([prompt, result], 420);
    expect(span(tiles[0])).toBe("2x3");
    pull(tiles[0], 0, 80);
    pointer("pointerup", document, 0);
    expect(prompt.appModeSize).toEqual({ columns: 4, rows: 4 });
    expect(span(tiles[0])).toBe("2x4");

    // A full-row result has no width of its own to keep: it takes the one it shows.
    pull(tiles[1], 0, 80);
    pointer("pointerup", document, 0);
    expect(result.appModeSize).toEqual({ columns: 2, rows: 4 });
  });
});

describe("arranging an App Mode tile from the keyboard", () => {
  afterEach(unstubGestures);

  const key = (on: Element, name: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    on.dispatchEvent(event);
    return event;
  };

  it("moves a focused title's tile a place with Alt+Arrow, and the title keeps its focus", () => {
    const toggle = node("toggleText", {}, ["true"]);
    const prompt = node("prompt", { text: "" }, ["text"]);
    const { appMode, deps, elements, graph } = setup([toggle, prompt]);
    appMode.setActive(true);
    const grid = elements.appModePane.querySelector(".flow-app-grid") as HTMLElement;
    const order = () => [...grid.children].map((tile) => (tile as HTMLElement).dataset.nodeId ?? "run");
    const title = grid.querySelector('[data-node-id="prompt-1"] > .flow-app-node-title') as HTMLElement;
    expect(title.tabIndex).toBe(0);
    title.focus();

    expect(key(title, "ArrowLeft").defaultPrevented).toBe(true);
    expect(order()).toEqual(["prompt-1", "toggleText-1", "run"]);
    expect(document.activeElement).toBe(title);
    key(title, "ArrowUp"); // already first
    key(title, "ArrowDown");
    key(title, "ArrowRight");
    expect(order()).toEqual(["toggleText-1", "run", "prompt-1"]);
    expect([toggle.appModeOrder, graph.runAppModeOrder, prompt.appModeOrder]).toEqual([0, 1, 2]);
    expect(deps.persistGraph).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(title);
  });

  it("resizes a focused tile a cell with Alt+Shift+Arrow, within the grid's columns", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("flow-app-grid") ? 420 : 0; // narrow: 2 columns
    });
    const prompt = node("prompt", { text: "" }, ["text"]);
    const { appMode, deps, elements, graph } = setup([prompt]);
    appMode.setActive(true);
    const tile = elements.appModePane.querySelector(".flow-app-node") as HTMLElement;
    const title = tile.querySelector(".flow-app-node-title") as HTMLElement;
    const span = () => `${tile.style.getPropertyValue("--tile-columns")}x${tile.style.getPropertyValue("--tile-rows")}`;
    key(title, "ArrowRight", { shiftKey: true }); // already the grid's 2 columns
    expect(deps.persistGraph).not.toHaveBeenCalled();
    key(title, "ArrowLeft", { shiftKey: true });
    key(title, "ArrowDown", { shiftKey: true });
    expect(span()).toBe("1x3");
    expect(prompt.appModeSize).toEqual({ columns: 1, rows: 3 });

    const run = elements.appModePane.querySelector(".flow-app-run-item > .flow-app-run-button") as HTMLElement;
    expect(run.getAttribute("aria-keyshortcuts")).toContain("Alt+Shift+ArrowRight");
    key(run, "ArrowUp", { shiftKey: true }); // a row is the least
    key(run, "ArrowLeft", { shiftKey: true });
    expect(graph.runAppModeSize).toEqual({ columns: 1, rows: 1 });
  });

  it("leaves the arrows to a field, and Mod+Alt+Arrow to Back and Forward", () => {
    const { appMode, deps, elements } = setup([node("prompt", { text: "" }, ["text"])]);
    appMode.setActive(true);
    const textarea = elements.appModePane.querySelector("textarea") as HTMLTextAreaElement;
    const title = elements.appModePane.querySelector(".flow-app-node-title") as HTMLElement;
    expect(key(textarea, "ArrowRight").defaultPrevented).toBe(false);
    expect(key(title, "ArrowRight", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(title, "ArrowRight", { metaKey: true }).defaultPrevented).toBe(false);
    expect(key(title, "ArrowRight", { altKey: false }).defaultPrevented).toBe(false);
    expect(deps.persistGraph).not.toHaveBeenCalled();
  });
});

describe("placeExposedNode", () => {
  function orderedGraph() {
    const toggle = { ...node("toggleText", {}, ["true"]), appModeOrder: 0 };
    const show = { ...node("showText", {}, ["text"]), appModeOrder: 2 };
    const graph: FlowGraph = { nodes: [toggle, show], edges: [], runAppModeOrder: 1 };
    return { graph, toggle, show };
  }

  it("puts a newly exposed input just before Run", () => {
    const { graph, toggle, show } = orderedGraph();
    const image = node("loadImage", {}, ["imagePath"]);
    graph.nodes.push(image);
    placeExposedNode(graph, image);
    expect([toggle.appModeOrder, image.appModeOrder, graph.runAppModeOrder, show.appModeOrder]).toEqual([0, 1, 2, 3]);
  });

  it("puts a newly exposed Prompt before Run, as the field it is", () => {
    const { graph, toggle, show } = orderedGraph();
    const prompt = node("prompt", {}, ["text"]);
    graph.nodes.push(prompt);
    placeExposedNode(graph, prompt);
    expect([toggle.appModeOrder, prompt.appModeOrder, graph.runAppModeOrder, show.appModeOrder]).toEqual([0, 1, 2, 3]);
  });

  it("puts a newly exposed output-only node last", () => {
    const { graph, toggle, show } = orderedGraph();
    const generate = node("generateText", {}, ["text"]);
    graph.nodes.push(generate);
    placeExposedNode(graph, generate);
    expect([toggle.appModeOrder, graph.runAppModeOrder, show.appModeOrder, generate.appModeOrder]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("leaves a graph nobody has ordered alone, dropping the node's stale position and size", () => {
    const toggle = node("toggleText", {}, ["true"]);
    const image = { ...node("loadImage", {}, ["imagePath"]), appModeOrder: 0, appModeSize: { columns: 4, rows: 4 } };
    const graph: FlowGraph = { nodes: [toggle, image], edges: [] };
    placeExposedNode(graph, image);
    expect([toggle.appModeOrder, image.appModeOrder, graph.runAppModeOrder]).toEqual([undefined, undefined, undefined]);
    expect(image.appModeSize).toBeUndefined();
  });

  it("ignores an unregistered node's stale position", () => {
    const { graph, toggle } = orderedGraph();
    graph.nodes.push({ ...node("pickImage", {}, ["imagePath"]), appModeOrder: 0 });
    const image = node("loadImage", {}, ["imagePath"]);
    graph.nodes.push(image);
    placeExposedNode(graph, image);
    expect([toggle.appModeOrder, image.appModeOrder, graph.runAppModeOrder]).toEqual([0, 1, 2]);
  });
});

describe("an exposed Int in App Mode", () => {
  it("steps its value with the card's arrows, and picks its control with blank shown as fixed", () => {
    const int = node("int", { value: "4" }, ["value", "control"]);
    const { appMode, deps, elements, opened } = setup([int]);
    appMode.setActive(true);
    const input = elements.appModePane.querySelector<HTMLInputElement>(".flow-int-stepper input");
    expect(input?.value).toBe("4");
    elements.appModePane.querySelector<HTMLButtonElement>('.flow-int-stepper [aria-label="Add 1"]')?.click();
    expect(int.config.value).toBe("5");
    expect(deps.persistGraph).toHaveBeenCalledTimes(1);

    const picker = elements.appModePane.querySelector<HTMLButtonElement>("button.picker");
    expect(picker?.querySelector(".picker-choice.current")?.textContent).toBe("fixed");
    picker?.click();
    expect(opened[0].items?.map((item) => item.label)).toEqual(["fixed", "increment", "decrement", "randomize"]);
  });

  // A run moves a value on under the form's own control: an Int's value
  // after the run, a Generate Image's seed on Regenerate.
  it("shows a value a run moved on, from the node's config", () => {
    const int = node("int", { value: "4" }, ["value"]);
    const image = { ...node("generateImage", { seed: "7" }, ["seed"]), id: "generateImage-2" };
    const { appMode, elements } = setup([int, image]);
    appMode.setActive(true);
    int.config.value = "9";
    image.config.seed = "8";
    appMode.showConfig(["int-1", "generateImage-2"]);
    expect(elements.appModePane.querySelector<HTMLInputElement>(".flow-int-stepper input")?.value).toBe("9");
    const seed = elements.appModePane.querySelector<HTMLInputElement>('[data-node-id="generateImage-2"] input');
    expect(seed?.value).toBe("8");
  });
});

describe("App Mode and a disabled node", () => {
  // Its place in the order stays, so it comes back where it was.
  it("shows no tile for a node a run leaves out, and says so when that is every tile", () => {
    const disabled = { ...node("prompt", { text: "hi" }, ["text"]), mode: "disabled" as const };
    const fed = { ...node("showText", {}, ["text"]), id: "showText-2" };
    const other = { ...node("choice", { options: "a" }, ["text"]), id: "choice-3" };
    const { appMode, elements, graph } = setup([disabled, fed, other]);
    graph.edges.push({ id: "e", source: "prompt-1", sourcePort: "text", target: "showText-2", targetPort: "text" });
    appMode.setActive(true);
    const tiles = () =>
      [...elements.appModePane.querySelectorAll<HTMLElement>(".flow-app-node")].map((t) => t.dataset.nodeId);
    expect(tiles()).toEqual(["choice-3"]);

    appMode.setActive(false);
    graph.nodes.splice(2, 1);
    appMode.setActive(true);
    expect(tiles()).toEqual([]);
    expect(elements.appModePane.querySelector(".flow-app-empty")?.textContent).toMatch(/left out of a run/);
  });
});
