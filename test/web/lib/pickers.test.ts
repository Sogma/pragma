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
