// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWrappingField, type WrappingFieldOptions } from "../../../web/lib/wrappingField.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function setup(value: string, saves: WrappingFieldOptions["saves"], placeholder?: string) {
  const save = vi.fn();
  const element = createWrappingField({ value, label: "Status", placeholder, saves, save });
  document.body.append(element);
  const field = element.querySelector("textarea");
  const copy = element.querySelector<HTMLElement>(".wrapping-field-copy");
  if (!field || !copy) throw new Error("no field or copy");
  return { element, field, copy, save };
}

function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input"));
}

function press(field: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

describe("createWrappingField", () => {
  it("is a quiet, labeled field under a copy of its text that ends in the pencil", () => {
    const { field, copy } = setup("Draft", "end", "Add a status");
    expect(field.classList).toContain("form-input-quiet");
    expect(field.getAttribute("aria-label")).toBe("Status");
    expect(field.dataset.tooltipOverflow).toBe("");
    expect(field.placeholder).toBe("Add a status");
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.lastElementChild?.classList).toContain("wrapping-field-pencil");
    expect(copy.dataset.text).toBe("Draft");
    expect(copy.textContent).toBe("");
    expect(setup("", "end", "Add a status").copy.dataset.text).toBe("Add a status");
  });

  it("saves once an edit ends, as one trimmed line, and the copy catches up only then", () => {
    const { field, copy, save } = setup("Draft", "end");
    field.focus();
    type(field, "  In\nreview  ");
    expect(save).not.toHaveBeenCalled();
    expect(copy.dataset.text).toBe("Draft");

    expect(press(field, "Enter").defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledWith("In review");
    expect(field.value).toBe("In review");
    expect(copy.dataset.text).toBe("In review");
  });

  it("saves each change as it is typed, once per change", () => {
    const { field, copy, save } = setup("Draft", "typing");
    field.focus();
    type(field, "In\nreview");
    type(field, "In review ");
    expect(save.mock.calls).toEqual([["In review"]]);
    expect(copy.dataset.text).toBe("Draft");

    field.blur();
    expect(save).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("In review");
    expect(copy.dataset.text).toBe("In review");
  });

  it("takes an edit back on Escape, saving the text it started from where typing saved", () => {
    const ended = setup("Draft", "end");
    ended.field.focus();
    type(ended.field, "Done");
    press(ended.field, "Escape");
    expect(ended.field.value).toBe("Draft");
    expect(ended.save).not.toHaveBeenCalled();

    const typed = setup("Line one\nline two", "typing");
    typed.field.focus();
    type(typed.field, "Done");
    press(typed.field, "Escape");
    expect(typed.field.value).toBe("Line one\nline two");
    expect(typed.save.mock.calls).toEqual([["Done"], ["Line one\nline two"]]);
  });

  it("leaves a value it only opened as it was, and Enter to a composition in progress", () => {
    const { field, save } = setup("Line one\nline two", "end");
    field.focus();
    expect(press(field, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    field.blur();
    expect(field.value).toBe("Line one\nline two");
    expect(save).not.toHaveBeenCalled();
  });
});
