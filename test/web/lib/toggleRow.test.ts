// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import { bindToggle, createSwitch, toggleSettingRow } from "../../../web/lib/toggleRow.ts";
import type { Setting } from "../../../web/services/settings.ts";

function fakeSetting(initial: boolean): Setting<boolean> & { sets: boolean[] } {
  const value = new Emitter(initial);
  const sets: boolean[] = [];
  return {
    sets,
    get: () => value.get(),
    set(next) {
      sets.push(next);
      value.set(next);
    },
    subscribe: (listener) => value.subscribe(listener),
  };
}

function button(): HTMLButtonElement {
  const el = document.createElement("button");
  document.body.append(el);
  return el;
}

describe("createSwitch", () => {
  it("is named and shows its state; a click flips it and reports the new state", () => {
    const onChange = vi.fn();
    const toggle = createSwitch("Show tags", true, onChange);
    expect([toggle.type, toggle.getAttribute("role"), toggle.getAttribute("aria-label")]).toEqual([
      "button",
      "switch",
      "Show tags",
    ]);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });

  it("leaves the click to the caller when given nothing to report to", () => {
    const toggle = createSwitch("Line numbers");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("bindToggle", () => {
  it("reflects and applies the stored value at startup, without firing onChange", () => {
    const setting = fakeSetting(false);
    const apply = vi.fn();
    const onChange = vi.fn();
    const el = button();
    bindToggle(el, setting, { apply, onChange });
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(false);
    // The trap this guards: a repair that acts on state built up under the
    // old setting (unfolding every open tab, say) must not run at boot,
    // where that state doesn't exist yet.
    expect(onChange).not.toHaveBeenCalled();
    expect(setting.sets).toEqual([]);
  });

  it("a click flips the setting, re-applies, and then fires onChange once with the new value", () => {
    const setting = fakeSetting(true);
    const order: string[] = [];
    const el = button();
    bindToggle(el, setting, {
      apply: (value) => order.push(`apply ${value}`),
      onChange: (value) => order.push(`change ${value}`),
    });
    el.click();
    expect(setting.get()).toBe(false);
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(order).toEqual(["apply true", "apply false", "change false"]);
  });

  // A server-held setting answers after the button is bound, and a refused
  // save flips it back: the button and its effect follow either way, and
  // neither counts as a change the user made.
  it("follows a value that changes after binding, without firing onChange", () => {
    const setting = fakeSetting(true);
    const apply = vi.fn();
    const onChange = vi.fn();
    const el = button();
    bindToggle(el, setting, { apply, onChange });
    setting.set(false);
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(apply).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a control with no effect beyond itself still tracks aria-checked", () => {
    const setting = fakeSetting(false);
    const el = button();
    bindToggle(el, setting);
    expect(el.getAttribute("aria-checked")).toBe("false");
    el.click();
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(setting.get()).toBe(true);
  });
});

describe("toggleSettingRow", () => {
  it("names the row and labels its switch, which follows the setting and flips it", () => {
    const setting = fakeSetting(true);
    const onChange = vi.fn();
    const row = toggleSettingRow({
      title: "Line numbers",
      description: "Show line numbers in the gutter.",
      setting,
      onChange,
    });
    expect(row.querySelector(".field-row-title")?.textContent).toBe("Line numbers");
    expect(row.querySelector(".field-row-description")?.textContent).toBe("Show line numbers in the gutter.");
    const toggle = row.querySelector<HTMLButtonElement>("button.toggle-switch");
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.getAttribute("aria-label")).toBe("Line numbers");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    toggle?.click();
    expect(setting.sets).toEqual([false]);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("shows what it is given in its title's place, its switch keeping the title as its name", () => {
    const shown = document.createElement("span");
    shown.textContent = "projects/heist";
    const row = toggleSettingRow({
      title: "Pragma context",
      shownTitle: shown,
      description: "A context scope keeps related work together.",
      setting: fakeSetting(false),
    });
    expect(row.querySelector(".field-row-title")?.firstChild).toBe(shown);
    expect(row.querySelector(".field-row-title")?.textContent).toBe("projects/heist");
    expect(row.querySelector("button.toggle-switch")?.getAttribute("aria-label")).toBe("Pragma context");
  });
});
