// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagDefinition } from "../../../src/protocol/tags.ts";
import { attachTagSuggestions, type TagSource } from "../../../web/lib/tagSuggestions.ts";

const VOCABULARY: TagDefinition[] = [
  { name: "threads", color: "#ad1a72" },
  { name: "art", color: "" },
  { name: "screenplay", color: "#e03e3e" },
  { name: "thinking", color: "" },
];

function setup(options: { applied?: string[]; known?: TagDefinition[]; used?: string[] } = {}) {
  const input = document.createElement("input");
  document.body.appendChild(input);
  let known = options.known ?? VOCABULARY;
  const source: TagSource = {
    known: () => known,
    read: vi.fn(async () => {
      known = VOCABULARY;
      return known;
    }),
    used: () => options.used ?? [],
  };
  const onPick = vi.fn();
  const suggestions = attachTagSuggestions(input, { source, applied: () => options.applied ?? [], onPick });
  return { input, source, onPick, suggestions };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".tag-suggestions [role=option]")];
const names = () => rows().map((row) => row.querySelector(".tag-suggestion-name")?.textContent);

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

function press(input: HTMLInputElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
  document.body.replaceChildren();
});

describe("tag suggestions — the list", () => {
  it("lists the vocabulary on focus, alphabetically, leaving out the tags already applied", () => {
    const { input, suggestions } = setup({ applied: ["art"] });
    input.focus();
    expect(names()).toEqual(["screenplay", "thinking", "threads"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(suggestions.highlighted()).toBeUndefined();
  });

  it("lists the tags documents carry beside the declared ones, each tag once in any case", () => {
    const { input } = setup({ applied: ["ART"], used: ["moth", "Thinking"] });
    input.focus();
    expect(names()).toEqual(["moth", "screenplay", "thinking", "threads"]);
  });

  it("narrows to names holding what's typed, case aside, the ones it begins first", () => {
    const { input } = setup();
    input.focus();
    type(input, "T");
    expect(names()).toEqual(["thinking", "threads", "art"]);
  });

  it("shows each tag's color beside its name, and nothing more", () => {
    const { input } = setup();
    input.focus();
    const screenplay = rows().find((row) => row.textContent?.startsWith("screenplay"));
    const swatch = screenplay?.querySelector<HTMLElement>(".tag-suggestion-swatch");
    expect(swatch?.style.getPropertyValue("--swatch")).toBe("#e03e3e");
    expect(screenplay?.textContent).toBe("screenplay");
    expect(screenplay?.dataset.tooltip).toBeUndefined();
  });

  it("closes when nothing matches, on blur, and when another input's list opens", () => {
    const { input } = setup();
    input.focus();
    type(input, "zzz");
    expect(rows()).toHaveLength(0);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    type(input, "");
    expect(rows()).toHaveLength(4);

    const other = setup();
    other.input.focus();
    expect(document.querySelectorAll(".tag-suggestions")).toHaveLength(1);
    other.input.blur();
    expect(document.querySelector(".tag-suggestions")).toBeNull();
  });

  it("redraws from a fresh read of the vocabulary", async () => {
    const { input, source } = setup({ known: [] });
    input.focus();
    expect(rows()).toHaveLength(0);
    await vi.waitFor(() => expect(rows()).toHaveLength(4));
    expect(source.read).toHaveBeenCalledTimes(1);
  });
});

describe("tag suggestions — picking", () => {
  it("highlights a match the typed text begins, never one it only sits inside", () => {
    const { input, suggestions } = setup();
    input.focus();
    type(input, "scr");
    expect(suggestions.highlighted()).toBe("screenplay");
    expect(input.getAttribute("aria-activedescendant")).toBe(rows()[0].id);
    type(input, "ink");
    expect(names()).toEqual(["thinking"]);
    expect(suggestions.highlighted()).toBeUndefined();
  });

  it("moves the highlight with the arrows, through a stop for the typed text", () => {
    const { input, suggestions } = setup({ applied: ["art", "thinking"] });
    input.focus();
    expect(press(input, "ArrowDown").defaultPrevented).toBe(true);
    expect(suggestions.highlighted()).toBe("screenplay");
    press(input, "ArrowDown");
    expect(suggestions.highlighted()).toBe("threads");
    press(input, "ArrowDown");
    expect(suggestions.highlighted()).toBeUndefined();
    press(input, "ArrowUp");
    expect(suggestions.highlighted()).toBe("threads");
    expect(rows()[1].classList.contains("highlighted")).toBe(true);
  });

  it("moves the highlight with the pointer", () => {
    const { input, suggestions } = setup();
    input.focus();
    rows()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(suggestions.highlighted()).toBe("thinking");
  });

  it("picks a clicked row without taking focus from the input", () => {
    const { input, onPick } = setup();
    input.focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    rows()[1].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    rows()[1].click();
    expect(onPick).toHaveBeenCalledWith("screenplay");
  });

  // The dialog's Escape runs from the document and skips a handled key.
  it("takes Escape only while the list is open", () => {
    const { input, suggestions } = setup();
    input.focus();
    type(input, "scr");
    expect(press(input, "Escape").defaultPrevented).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(suggestions.highlighted()).toBeUndefined();
    expect(press(input, "Escape").defaultPrevented).toBe(false);
    press(input, "ArrowDown");
    expect(names()).toEqual(["screenplay"]);
  });
});

describe("tag suggestions — adding to Tags", () => {
  function declaring(declare = vi.fn(async (_name: string) => {})) {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const source: TagSource = { known: () => VOCABULARY, read: async () => VOCABULARY, declare };
    const onPick = vi.fn();
    const suggestions = attachTagSuggestions(input, { source, applied: () => [], onPick });
    return { input, onPick, declare, suggestions };
  }
  const addRow = () => document.querySelector<HTMLElement>(".tag-suggestions .tag-suggestion-add");

  it("offers to add typed text no tag matches, as the last row", () => {
    const { input } = declaring();
    input.focus();
    expect(addRow()).toBeNull();
    type(input, "th");
    expect(names().filter(Boolean)).toEqual(["thinking", "threads"]);
    expect(addRow()?.textContent).toBe("Add “th” to Tags");
    expect(rows().at(-1)).toBe(addRow());
    expect(addRow()?.classList.contains("menu-item-separated")).toBe(true);

    type(input, "brand-new");
    expect(rows()).toEqual([addRow()]);
    expect(addRow()?.classList.contains("menu-item-separated")).toBe(false);
  });

  it("reads a typed # as no part of the name, and offers to add nothing that names no tag", () => {
    const { input } = declaring();
    input.focus();
    type(input, "#scr");
    expect(names().filter(Boolean)).toEqual(["screenplay"]);
    type(input, "#brand-new");
    expect(addRow()?.textContent).toBe("Add “brand-new” to Tags");
    type(input, "brand new");
    expect(document.querySelector(".tag-suggestions")).toBeNull();
    type(input, "2024");
    expect(addRow()).toBeNull();
  });

  it("never offers a tag the vocabulary holds in another case", () => {
    const { input } = declaring();
    input.focus();
    type(input, "Screenplay");
    expect(addRow()).toBeNull();
  });

  it("offers nothing to add without a way to add it", () => {
    const { input } = setup();
    input.focus();
    type(input, "brand new");
    expect(document.querySelector(".tag-suggestions")).toBeNull();
  });

  it("applies the tag and adds it to Tags when clicked", () => {
    const { input, onPick, declare } = declaring();
    input.focus();
    type(input, "brand-new");
    addRow()?.click();
    expect(onPick).toHaveBeenCalledWith("brand-new");
    expect(declare).toHaveBeenCalledWith("brand-new");
    expect(document.querySelector(".tag-suggestions")).toBeNull();
  });

  // The input's own Enter handler, attached after the list's, would add the
  // typed text a second time and never add it to Tags.
  it("takes Enter on the row itself, ahead of the input's own handler", () => {
    const { input, onPick, declare, suggestions } = declaring();
    const later = vi.fn();
    input.addEventListener("keydown", later);
    input.focus();
    type(input, "th");
    // Up from the first match is the typed text, and up again wraps to the
    // last row.
    press(input, "ArrowUp");
    press(input, "ArrowUp");
    expect(addRow()?.classList.contains("highlighted")).toBe(true);
    expect(suggestions.highlighted()).toBeUndefined();

    later.mockClear();
    expect(press(input, "Enter").defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith("th");
    expect(declare).toHaveBeenCalledWith("th");
  });

  it("keeps the tag applied when adding it to Tags is refused, and says why", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { input, onPick } = declaring(vi.fn(async () => Promise.reject(new Error("_tags.json doesn't parse"))));
    input.focus();
    type(input, "brand-new");
    addRow()?.click();
    expect(onPick).toHaveBeenCalledWith("brand-new");
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("_tags.json doesn't parse"));
    alert.mockRestore();
  });
});
