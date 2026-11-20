// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ModelSetting } from "../../../src/protocol/api.ts";
import type { FlowNodeInstance } from "../../../src/protocol/types.ts";
import { createModelSettings } from "../../../web/flow/modelSettings.ts";
import type { ContextMenuService, MenuOpenOptions } from "../../../web/services/menus.ts";

// A Generate Video's model settings on its card: a folded section of what
// the picked model offers, keeping a value only while it differs from the
// model's default, and showing one the model doesn't take until removed.

const OFFERED: ModelSetting[] = [
  { name: "mode", kind: "choice", options: ["text-to-video", "reference-to-video", "edit"], required: true },
  { name: "genre", kind: "choice", options: ["auto", "noir"], default: "auto", description: "The film's genre." },
  { name: "generate_audio", kind: "switch", default: true },
  { name: "cfg_scale", kind: "number", min: 0, max: 1, default: 0.5 },
];

function setUp(config: Record<string, unknown> = {}) {
  const node: FlowNodeInstance = { id: "v1", type: "generateVideo", position: { x: 0, y: 0 }, config };
  const opened: MenuOpenOptions[] = [];
  const contextMenu = {
    open: (options: MenuOpenOptions) => opened.push(options),
    isOpen: () => false,
    close: () => {},
  } as unknown as ContextMenuService;
  const persist = vi.fn();
  let list: ModelSetting[] | undefined = OFFERED;
  const view = createModelSettings(node, { contextMenu, offered: () => list, persist });
  const offer = (next: ModelSetting[] | undefined) => {
    list = next;
    view.refresh();
  };
  return { node, view, opened, persist, offer };
}

const labels = (el: HTMLElement) => [...el.querySelectorAll(".flow-config-label")].map((label) => label.textContent);
const pickerOf = (el: HTMLElement, index: number) =>
  el.querySelectorAll<HTMLButtonElement>("button.flow-picker")[index];

describe("createModelSettings", () => {
  it("lists the picked model's settings folded under one header, at their defaults", () => {
    const { view } = setUp();
    const header = view.el.querySelector(".flow-model-settings-header") as HTMLButtonElement;
    const body = view.el.querySelector(".flow-model-settings-body") as HTMLElement;
    expect(view.el.hidden).toBe(false);
    expect(body.hidden).toBe(true);
    header.click();
    expect(body.hidden).toBe(false);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(labels(view.el)).toEqual(["mode", "genre", "generate audio", "cfg scale"]);
    expect(pickerOf(view.el, 0).getAttribute("aria-label")).toBe("mode: Auto");
    expect(pickerOf(view.el, 1).getAttribute("aria-label")).toBe("genre: auto");
    expect((view.el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((view.el.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("0.5");
    expect(view.el.querySelector(".flow-model-settings-count")?.textContent).toBe("");
  });

  it("keeps a pick only while it differs from the default, and Auto keeps none", () => {
    const { node, view, opened, persist } = setUp();
    pickerOf(view.el, 0).click();
    opened[0].items
      ?.find((item) => item.label === "edit")
      ?.run?.({ tab: { kind: "empty" }, pane: undefined }, undefined);
    expect(node.config.modelSettings).toEqual({ mode: "edit" });
    expect(view.el.querySelector(".flow-model-settings-count")?.textContent).toBe("1 set");

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
      ?.find((item) => item.label === "Auto")
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

  it("shows a kept value the picked model doesn't take as unused, until it is removed", () => {
    const { node, view } = setUp({ modelSettings: { genre: "noir", speedramp: "slowmo" } });
    expect(labels(view.el)).toContain("speedramp");
    const unused = view.el.querySelector(".flow-model-setting-unused") as HTMLElement;
    expect(unused.textContent).toContain("slowmo · not taken by this model");
    (unused.querySelector("button") as HTMLButtonElement).click();
    expect(node.config.modelSettings).toEqual({ genre: "noir" });
    expect(view.el.querySelector(".flow-model-setting-unused")).toBeNull();
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
