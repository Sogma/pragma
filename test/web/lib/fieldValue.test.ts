// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFieldValue } from "../../../web/lib/fieldValue.ts";

const display = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

// A locked value as content: no control to tab to, nothing filled in that
// the file doesn't hold.
describe("createFieldValue", () => {
  it("draws text and integers as the text they are", () => {
    expect(createFieldValue("text", "  A locked door  ").textContent).toBe("A locked door");
    expect(createFieldValue("integer", "42").textContent).toBe("42");
  });

  it("draws a select as its value, and a blank one as nothing rather than its first option", () => {
    expect(createFieldValue("select", "queued").textContent).toBe("queued");
    expect(createFieldValue("select", "").textContent).toBe("");
  });

  it("draws a checkbox as a mark that shows only when checked, labelled either way", () => {
    const checked = createFieldValue("checkbox", "true");
    expect(checked.getAttribute("aria-label")).toBe("Checked");
    expect((checked.querySelector(".data-table-value-check") as HTMLElement).hidden).toBe(false);
    const unchecked = createFieldValue("checkbox", "false");
    expect(unchecked.getAttribute("aria-label")).toBe("Not checked");
    expect((unchecked.querySelector(".data-table-value-check") as HTMLElement).hidden).toBe(true);
  });

  it("draws a color as a chip of it carrying its hex, and a value that isn't one as the text it is", () => {
    const color = createFieldValue("color", "#F80");
    const chip = color.querySelector<HTMLElement>(".color-chip");
    expect(chip?.style.background).toBe("rgb(255, 136, 0)");
    expect(chip?.style.color).not.toBe("");
    expect(color.textContent).toBe("#ff8800");
    const unreadable = createFieldValue("color", "teal-ish");
    expect(unreadable.querySelector(".color-chip")).toBeNull();
    expect(unreadable.textContent).toBe("teal-ish");
    expect(createFieldValue("color", "").textContent).toBe("");
  });

  it("draws a timestamp in local time, and one it can't read as written with a tooltip saying so", () => {
    expect(createFieldValue("timestamp", "2026-10-07T12:32:05Z").textContent).toBe(display("2026-10-07T12:32:05Z"));
    const unreadable = createFieldValue("timestamp", "last Tuesday");
    expect(unreadable.textContent).toBe("last Tuesday");
    expect(unreadable.dataset.tooltip).toBe("Not a time Pragma can read, kept as written");
    expect(createFieldValue("timestamp", "").textContent).toBe("");
  });
});
