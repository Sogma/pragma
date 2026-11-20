// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ModelSetting } from "../../../src/protocol/api.ts";
import type { FlowNodeInstance } from "../../../src/protocol/types.ts";
import type { WiredInputs } from "../../../src/protocol/videoModes.ts";
import { createModelSettings } from "../../../web/flow/modelSettings.ts";
import type { ContextMenuService, MenuOpenOptions } from "../../../web/services/menus.ts";

// A Generate Video's set-once settings on its card: its model rows, then
// what the picked model offers, keeping a value only while it differs from
// the model's default, showing one the model doesn't take until removed, and
// folding so its heading reads as the settings' summary, which the node keeps.

const OFFERED: ModelSetting[] = [
  { name: "mode", kind: "choice", options: ["text-to-video", "reference-to-video", "edit"], required: true },
  { name: "genre", kind: "choice", options: ["auto", "noir"], default: "auto", description: "The film's genre." },
  { name: "generate_audio", kind: "switch", default: true },
  { name: "cfg_scale", kind: "number", min: 0, max: 1, default: 0.5 },
];

function setUp(config: Record<string, unknown> = {}, rows: HTMLElement[] = []) {
  const node: FlowNodeInstance = { id: "v1", type: "generateVideo", position: { x: 0, y: 0 }, config };
  const opened: MenuOpenOptions[] = [];
  const contextMenu = {
    open: (options: MenuOpenOptions) => opened.push(options),
    isOpen: () => false,
    close: () => {},
  } as unknown as ContextMenuService;
  const persist = vi.fn();
  const layoutChanged = vi.fn();
  let list: ModelSetting[] | undefined = OFFERED;
  let wired: WiredInputs = { references: false, clips: false, frames: false };
  const view = createModelSettings(node, {
    contextMenu,
    rows,
    offered: () => list,
    summary: () => "Seedance 2.5 · 720p · 5 s · 16:9",
    details: () => ["model: Seedance 2.5", "duration: 5 s"],
    joined: () => [
      { id: "aspect_ratio", type: "text" },
      { id: "duration", type: "text" },
    ],
    inputs: () => wired,
    persist,
    layoutChanged,
  });
  const offer = (next: ModelSetting[] | undefined) => {
    list = next;
    view.refresh();
  };
  const wire = (next: Partial<WiredInputs>) => {
    wired = { ...wired, ...next };
    view.refresh();
  };
  return { node, view, opened, persist, offer, layoutChanged, wire };
}

const labels = (el: HTMLElement) => [...el.querySelectorAll(".flow-port-label")].map((label) => label.textContent);
const pickerOf = (el: HTMLElement, index: number) =>
  el.querySelectorAll<HTMLButtonElement>("button.flow-picker")[index];

describe("createModelSettings", () => {
  it("reads Model settings open, and its summary folded, and the node keeps the fold", () => {
    const { node, view, persist, layoutChanged } = setUp({ modelSettings: { genre: "noir" } });
    const toggle = view.el.querySelector(".flow-model-settings-toggle") as HTMLButtonElement;
    const line = view.el.querySelector(".flow-model-settings-line") as HTMLElement;
    expect(toggle.textContent).toBe("Model settings");
    toggle.click();
    expect(node.settingsFolded).toBe(true);
    expect(view.el.classList.contains("folded")).toBe(true);
    expect((view.el.querySelector(".flow-model-settings-body") as HTMLElement).hidden).toBe(true);
    expect(toggle.textContent).toBe("Seedance 2.5 · 720p · 5 s · 16:9");
    expect(
      [...line.querySelectorAll<HTMLElement>(".flow-joined-pin.target")].map((pin) => pin.dataset.handleid),
    ).toEqual(["aspect_ratio", "duration"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.dataset.tooltip?.split("\n")).toEqual([
      "model: Seedance 2.5",
      "duration: 5 s",
      "mode: Auto · text-to-video",
      "genre: noir",
      "generate audio: on",
      "cfg scale: 0.5",
    ]);
    toggle.click();
    expect(node).not.toHaveProperty("settingsFolded");
    expect(toggle.textContent).toBe("Model settings");
    expect(toggle.dataset.tooltip).toBe("Fold settings");
    expect(line.querySelector(".flow-joined-pin")).toBeNull();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(layoutChanged).toHaveBeenCalledTimes(2);
  });

  it("lists the node's model rows, then the picked model's settings at their defaults, open", () => {
    const model = document.createElement("div");
    model.className = "flow-port-row model-row";
    const { view } = setUp({}, [model]);
    const header = view.el.querySelector(".flow-model-settings-toggle") as HTMLButtonElement;
    expect(header.getAttribute("aria-label")).toBe("Fold settings: Model settings");
    expect(header.dataset.tooltip).toBe("Fold settings");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(view.el.hidden).toBe(false);
    expect((view.el.querySelector(".flow-model-settings-body") as HTMLElement).firstElementChild).toBe(model);
    expect(labels(view.el)).toEqual(["mode", "genre", "generate audio", "cfg scale"]);
    expect(pickerOf(view.el, 0).getAttribute("aria-label")).toBe("mode: Auto · text-to-video");
    expect(pickerOf(view.el, 1).getAttribute("aria-label")).toBe("genre: auto");
    expect((view.el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((view.el.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("0.5");
  });

  it("keeps a pick only while it differs from the default, and Auto keeps none", () => {
    const { node, view, opened, persist } = setUp();
    pickerOf(view.el, 0).click();
    opened[0].items
      ?.find((item) => item.label === "edit")
      ?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect(node.config.modelSettings).toEqual({ mode: "edit" });
    expect(view.el.querySelector(".flow-model-settings-toggle")?.textContent).toBe("Model settings");

    const audio = view.el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    audio.checked = false;
    audio.dispatchEvent(new Event("change"));
    expect(node.config.modelSettings).toEqual({ mode: "edit", generate_audio: false });

    const scale = view.el.querySelector('input[type="text"]') as HTMLInputElement;
    scale.value = "7";
    scale.dispatchEvent(new Event("change"));
    expect(node.config.modelSettings).toEqual({ mode: "edit", generate_audio: false, cfg_scale: 1 });

    pickerOf(view.el, 0).click();
    opened[1].items
      ?.find((item) => typeof item.label === "string" && item.label.startsWith("Auto"))
      ?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    const again = view.el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    again.checked = true;
    again.dispatchEvent(new Event("change"));
    const back = view.el.querySelector('input[type="text"]') as HTMLInputElement;
    back.value = "0.5";
    back.dispatchEvent(new Event("change"));
    expect(node.config).not.toHaveProperty("modelSettings");
    expect(persist).toHaveBeenCalledTimes(6);
  });

  it("follows the inputs on Auto, hints why a mode won't do, and warns of a picked one that can't take them", () => {
    const { view, opened, wire } = setUp();
    const problem = view.el.querySelector(".flow-model-settings-problem") as HTMLElement;
    expect(problem.hidden).toBe(true);
    wire({ references: true });
    expect(pickerOf(view.el, 0).getAttribute("aria-label")).toBe("mode: Auto · reference-to-video");
    pickerOf(view.el, 0).click();
    const items = opened[0].items ?? [];
    expect(items.map((item) => [item.label, item.detail])).toEqual([
      ["Auto · reference-to-video", undefined],
      ["text-to-video", "takes no references"],
      ["reference-to-video", undefined],
      ["edit", "needs a clip"],
    ]);
    items.find((item) => item.label === "edit")?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect([problem.hidden, problem.textContent]).toEqual([false, 'Mode "edit" needs a clip on a video reference']);
    wire({ clips: true });
    expect(problem.hidden).toBe(true);
  });

  it("shows a kept value the picked model doesn't take as unused, until it is removed", () => {
    const { node, view } = setUp({ modelSettings: { genre: "noir", speedramp: "slowmo" } });
    expect(labels(view.el)).toContain("speedramp");
    const unused = view.el.querySelector(".flow-model-setting.unused") as HTMLElement;
    expect(unused.textContent).toContain("slowmo · not taken by this model");
    const toggle = view.el.querySelector(".flow-model-settings-toggle") as HTMLButtonElement;
    toggle.click();
    expect(toggle.dataset.tooltip?.split("\n")).toContain("speedramp: slowmo (not taken by this model)");
    toggle.click();
    (unused.querySelector("button") as HTMLButtonElement).click();
    expect(node.config.modelSettings).toEqual({ genre: "noir" });
    expect(view.el.querySelector(".flow-model-setting.unused")).toBeNull();
  });

  it("hides while the model offers nothing or isn't known, and follows a new pick", () => {
    const { view, offer } = setUp();
    offer(undefined);
    expect(view.el.hidden).toBe(true);
    offer([]);
    expect(view.el.hidden).toBe(true);
    offer(OFFERED);
    expect(view.el.hidden).toBe(false);
    expect(labels(view.el)).toHaveLength(4);
  });
});
