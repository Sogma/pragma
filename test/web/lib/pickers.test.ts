// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openColorPicker } from "../../../web/lib/colorPicker.ts";
import { openDatePicker } from "../../../web/lib/datePicker.ts";
import { LOGO_COLORS } from "../../../web/lib/logoColors.ts";
import { createTimestampField } from "../../../web/lib/timestampField.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function opener(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
}

const shown = () => [...document.querySelectorAll(".popover")].map((popover) => popover.className);

describe("the pickers", () => {
  it("open one at a time, whatever their kinds", () => {
    openColorPicker({ anchor: opener(), value: "", onPick: () => {} });
    expect(shown()).toEqual(["popover color-picker"]);
    openDatePicker({ anchor: opener(), value: "", onPick: () => {} });
    expect(shown()).toEqual(["popover date-picker"]);
    const field = createTimestampField({ value: "", onChange: () => {} });
    document.body.append(field);
    field.click();
    expect(shown()).toEqual(["popover timestamp-picker"]);
  });

  it("close on a pick and hand focus back to what opened them", () => {
    const anchor = opener();
    const onPick = vi.fn();
    openColorPicker({ anchor, value: "", onPick });
    document.querySelector<HTMLButtonElement>('.color-picker-swatch[aria-label="Red"]')?.click();
    expect(onPick).toHaveBeenCalledWith(LOGO_COLORS.red.toLowerCase());
    expect(shown()).toEqual([]);
    expect(document.activeElement).toBe(anchor);
  });
});

describe("the color picker's first swatch", () => {
  const first = () => document.querySelector<HTMLButtonElement>(".color-picker-swatch") as HTMLButtonElement;

  it("is No color without a fallback, unpressed while a preset is the value", () => {
    openColorPicker({ anchor: opener(), value: LOGO_COLORS.red, onPick: () => {} });
    expect(first().getAttribute("aria-label")).toBe("No color");
    expect(first().classList.contains("is-empty")).toBe(true);
    expect(first().hasAttribute("aria-pressed")).toBe(false);
    expect(document.querySelector('.color-picker-swatch[aria-pressed="true"]')?.getAttribute("aria-label")).toBe("Red");
  });

  it("is Default with a fallback: filled with it, pressed while there's no value, and picking none", () => {
    const onPick = vi.fn();
    openColorPicker({ anchor: opener(), value: "", fallback: "var(--type-image)", onPick });
    expect(first().getAttribute("aria-label")).toBe("Default");
    expect(first().classList.contains("is-empty")).toBe(false);
    expect(first().style.getPropertyValue("--swatch")).toBe("var(--type-image)");
    expect(first().getAttribute("aria-pressed")).toBe("true");
    first().click();
    expect(onPick).toHaveBeenCalledWith("");
  });
});
