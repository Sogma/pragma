// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FIELD_VALUE_TYPE_OPTIONS } from "../../../src/protocol/types.ts";
import { createFieldPopover, type FieldPopoverValues } from "../../../web/lib/fieldPopover.ts";

function open() {
  const onSubmit = vi.fn<(values: FieldPopoverValues) => void>();
  const { element } = createFieldPopover({
    title: "Add column",
    nameLabel: "Column name",
    typeLabel: "Column type",
    types: FIELD_VALUE_TYPE_OPTIONS,
    onSubmit,
    onCancel: vi.fn(),
  });
  const name = element.querySelector<HTMLInputElement>('input[aria-label="Column name"]') as HTMLInputElement;
  const type = element.querySelector<HTMLSelectElement>("select") as HTMLSelectElement;
  const max = element.querySelector<HTMLInputElement>('input[type="number"]') as HTMLInputElement;
  const submit = element.querySelector<HTMLButtonElement>(".action-button") as HTMLButtonElement;
  const reject = [...element.querySelectorAll<HTMLLabelElement>(".popover-checkbox")].find((label) =>
    label.textContent?.includes("Can be rejected"),
  ) as HTMLLabelElement;
  const pick = (value: string) => {
    type.value = value;
    type.dispatchEvent(new Event("change"));
  };
  const typeName = (value: string) => {
    name.value = value;
    name.dispatchEvent(new Event("input"));
  };
  return { onSubmit, max, reject, submit, pick, typeName };
}

describe("the Add column form for a score", () => {
  it("asks for its max, 5 to start, and whether a value can be rejected, only for a score", () => {
    const form = open();
    expect(form.max.closest("label")?.hidden).toBe(true);
    form.pick("score");
    expect(form.max.closest("label")?.hidden).toBe(false);
    expect(form.max.value).toBe("5");
    expect(form.reject.hidden).toBe(false);
  });

  it("hands back a max other than 5, and reject when ticked", () => {
    const form = open();
    form.typeName("Craft");
    form.pick("score");
    form.submit.click();
    expect(form.onSubmit).toHaveBeenLastCalledWith({ label: "Craft", type: "score" });
    form.max.value = "10";
    form.max.dispatchEvent(new Event("input"));
    (form.reject.querySelector("input") as HTMLInputElement).checked = true;
    form.submit.click();
    expect(form.onSubmit).toHaveBeenLastCalledWith({ label: "Craft", type: "score", max: 10, reject: true });
  });

  it("holds submit until the max is a whole number from 1 to 10", () => {
    const form = open();
    form.typeName("Craft");
    form.pick("score");
    form.max.value = "11";
    form.max.dispatchEvent(new Event("input"));
    expect(form.submit.disabled).toBe(true);
    form.max.value = "3";
    form.max.dispatchEvent(new Event("input"));
    expect(form.submit.disabled).toBe(false);
  });
});
