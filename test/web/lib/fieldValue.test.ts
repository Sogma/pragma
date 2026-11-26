// @vitest-environment jsdom
import { describe, expect, it, type Mock, vi } from "vitest";
import type { TableColumn } from "../../../src/protocol/types.ts";
import { type CellControls, createCell, createFieldValue } from "../../../web/lib/fieldValue.ts";

const display = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

const column = (id: string, type: TableColumn["type"], options?: string[]): TableColumn => ({
  id,
  type,
  label: id,
  ...(options ? { options } : {}),
});

function controls(): {
  media: Mock<CellControls["media"]>;
  path: Mock<CellControls["path"]>;
  pickColor: Mock<CellControls["pickColor"]>;
} {
  return {
    media: vi.fn<CellControls["media"]>(() => document.createElement("figure")),
    path: vi.fn<CellControls["path"]>(() => document.createElement("a")),
    pickColor: vi.fn<CellControls["pickColor"]>(),
  };
}

// A locked value as content: no control to tab to, nothing filled in that
// the file doesn't hold.
describe("createFieldValue", () => {
  it("draws text and integers as the text they are", () => {
    expect(createFieldValue({ type: "text" }, "  A locked door  ").textContent).toBe("A locked door");
    expect(createFieldValue({ type: "integer" }, "42").textContent).toBe("42");
  });

  it("draws a select as its value, and a blank one as nothing rather than its first option", () => {
    expect(createFieldValue({ type: "select", options: ["queued", "done"] }, "queued").textContent).toBe("queued");
    expect(createFieldValue({ type: "select", options: ["queued", "done"] }, "").textContent).toBe("");
  });

  it("draws a checkbox as a mark that shows only when checked, labelled either way", () => {
    const checked = createFieldValue({ type: "checkbox" }, "true");
    expect(checked.getAttribute("aria-label")).toBe("Checked");
    expect((checked.querySelector(".data-table-value-check") as HTMLElement).hidden).toBe(false);
    const unchecked = createFieldValue({ type: "checkbox" }, "false");
    expect(unchecked.getAttribute("aria-label")).toBe("Not checked");
    expect((unchecked.querySelector(".data-table-value-check") as HTMLElement).hidden).toBe(true);
  });

  it("draws a color as a chip of it carrying its hex, and a value that isn't one as the text it is", () => {
    const color = createFieldValue({ type: "color" }, "#F80");
    const chip = color.querySelector<HTMLElement>(".color-chip");
    expect(chip?.style.background).toBe("rgb(255, 136, 0)");
    expect(chip?.style.color).not.toBe("");
    expect(color.textContent).toBe("#ff8800");
    const unreadable = createFieldValue({ type: "color" }, "teal-ish");
    expect(unreadable.querySelector(".color-chip")).toBeNull();
    expect(unreadable.textContent).toBe("teal-ish");
    expect(createFieldValue({ type: "color" }, "").textContent).toBe("");
  });

  it("draws a timestamp in local time, and one it can't read as written with a tooltip saying so", () => {
    expect(createFieldValue({ type: "timestamp" }, "2026-10-07T12:32:05Z").textContent).toBe(
      display("2026-10-07T12:32:05Z"),
    );
    const unreadable = createFieldValue({ type: "timestamp" }, "last Tuesday");
    expect(unreadable.textContent).toBe("last Tuesday");
    expect(unreadable.dataset.tooltip).toBe("Not a time Pragma can read, kept as written");
    expect(createFieldValue({ type: "timestamp" }, "").textContent).toBe("");
  });
});

describe("createCell", () => {
  it("shows a locked value as content, but a media or path value always as its slot", () => {
    const given = controls();
    expect(createCell(column("n", "integer"), "3", vi.fn(), true, given).textContent).toBe("3");
    const onChange = vi.fn();
    createCell(column("frame", "media"), "a.png", onChange, true, given);
    expect(given.media).toHaveBeenCalledWith(expect.objectContaining({ id: "frame" }), "a.png", true, onChange);
    createCell(column("ref", "path"), "notes/", onChange, true, given);
    expect(given.path).toHaveBeenCalledWith("notes/", true, onChange);
  });

  it("hands back each editor's value as text", () => {
    const onChange = vi.fn();
    const select = createCell(column("s", "select", ["a", "b"]), "a", onChange, false, controls()) as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new Event("change"));
    const box = createCell(column("c", "checkbox"), "false", onChange, false, controls()) as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    const text = createCell(column("t", "integer"), "1", onChange, false, controls()) as HTMLInputElement;
    expect(text.type).toBe("number");
    text.value = "2";
    text.dispatchEvent(new Event("input"));
    expect(onChange.mock.calls).toEqual([["b"], ["true"], ["2"]]);
  });

  it("picks a color from the value it holds now, not the one it was drawn with", () => {
    const given = controls();
    const onChange = vi.fn();
    const button = createCell(column("hue", "color"), "#112233", onChange, false, given);
    button.click();
    given.pickColor.mock.calls[0][2]("#445566");
    button.click();
    expect(given.pickColor.mock.calls[1][1]).toBe("#445566");
    expect(onChange).toHaveBeenCalledWith("#445566");
  });
});
