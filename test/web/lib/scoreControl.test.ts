// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FieldDefinition } from "../../../src/protocol/types.ts";
import { createScoreControl } from "../../../web/lib/scoreControl.ts";

const rating: FieldDefinition = { type: "score", reject: true };

function marks(control: HTMLElement): HTMLButtonElement[] {
  return [...control.querySelectorAll<HTMLButtonElement>(".score-mark")];
}

function lit(control: HTMLElement): number {
  return control.querySelectorAll(".score-mark[data-lit]").length;
}

function key(control: HTMLElement, name: string): void {
  control.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

describe("createScoreControl", () => {
  it("draws a mark per step, 5 where the field names no max, lit up to the value", () => {
    const control = createScoreControl({ field: { type: "score" }, value: "3", onChange: vi.fn() });
    expect(marks(control)).toHaveLength(5);
    expect(lit(control)).toBe(3);
    expect(control.querySelector(".score-reject")).toBeNull();
    expect(
      createScoreControl({ field: { type: "score", max: 10 }, value: "", onChange: vi.fn() }).childElementCount,
    ).toBe(11);
  });

  it("puts the reject mark first where the field allows one", () => {
    const control = createScoreControl({ field: rating, value: "-1", onChange: vi.fn() });
    expect(control.firstElementChild?.classList.contains("score-reject")).toBe(true);
    expect(control.hasAttribute("data-rejected")).toBe(true);
    expect(lit(control)).toBe(0);
  });

  it("hands back the step picked, and clears on a second press of the one held", () => {
    const onChange = vi.fn();
    const control = createScoreControl({ field: rating, value: "", onChange });
    marks(control)[3].click();
    expect(lit(control)).toBe(4);
    marks(control)[3].click();
    expect(lit(control)).toBe(0);
    control.querySelector<HTMLButtonElement>(".score-reject")?.click();
    expect(onChange.mock.calls).toEqual([["4"], [""], ["-1"]]);
  });

  it("is a radio group: arrows move the pick, Home and End jump, Delete clears", () => {
    const onChange = vi.fn();
    const control = createScoreControl({ field: rating, value: "", label: "Rating", onChange });
    expect(control.getAttribute("role")).toBe("radiogroup");
    expect(control.getAttribute("aria-label")).toBe("Rating");
    expect(marks(control).map((mark) => mark.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    key(control, "ArrowRight");
    key(control, "ArrowRight");
    key(control, "End");
    key(control, "Home");
    key(control, "Delete");
    expect(onChange.mock.calls).toEqual([["1"], ["2"], ["5"], ["-1"], [""]]);
    expect(marks(control)[1].getAttribute("aria-label")).toBe("2 of 5");
  });

  it("keeps a value that is no score as written beside unlit marks, until a mark is picked", () => {
    const onChange = vi.fn();
    const control = createScoreControl({ field: { type: "score" }, value: "great", onChange });
    const held = control.querySelector<HTMLElement>(".score-held");
    expect(held?.hidden).toBe(false);
    expect(held?.textContent).toBe("great");
    expect(lit(control)).toBe(0);
    marks(control)[1].click();
    expect(held?.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("draws a locked value with nothing to press, named for what it holds", () => {
    const control = createScoreControl({ field: rating, value: "4" });
    expect(control.querySelector("button")).toBeNull();
    expect(control.getAttribute("role")).toBe("img");
    expect(control.getAttribute("aria-label")).toBe("4 of 5");
    expect(createScoreControl({ field: rating, value: "-1" }).getAttribute("aria-label")).toBe("Rejected");
    expect(createScoreControl({ field: rating, value: "" }).getAttribute("aria-label")).toBe("No score");
  });
});
