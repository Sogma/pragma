// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { TagDefinition } from "../../../src/protocol/tags.ts";
import { createPill, createTagPill, paintTagPill, paintTagPills, tagPillColors } from "../../../web/lib/tagPill.ts";

const VOCABULARY: TagDefinition[] = [
  { name: "lyrics", color: "#ECB72B" },
  { name: "draft", color: "" },
  { name: "odd", color: "not a color" },
];

function tagPill(name: string): HTMLElement {
  const pill = document.createElement("span");
  pill.dataset.tag = name;
  return pill;
}

describe("createPill", () => {
  it("draws a list value's pill, which is no tag's", () => {
    const pill = createPill("lyrics");
    expect(pill.className).toBe("pill");
    expect(pill.textContent).toBe("lyrics");
    expect(pill.dataset.tag).toBeUndefined();
  });
});

describe("createTagPill", () => {
  it("draws a tag's pill, filled at once from the vocabulary it's given", () => {
    const pill = createTagPill("lyrics", VOCABULARY);
    expect(pill.classList.contains("pill")).toBe(true);
    expect(pill.textContent).toBe("lyrics");
    expect(pill.dataset.tag).toBe("lyrics");
    expect(pill.style.backgroundColor).toBe("rgb(236, 183, 43)");
  });

  it("leaves a pill given no vocabulary plain until it's painted", () => {
    const pill = createTagPill("lyrics");
    expect(pill.classList.contains("has-tag-color")).toBe(false);
    paintTagPill(pill, VOCABULARY);
    expect(pill.classList.contains("has-tag-color")).toBe(true);
  });

  it("shows a value written with its # as the tag it names", () => {
    const pill = createTagPill("#lyrics", VOCABULARY);
    expect(pill.textContent).toBe("lyrics");
    expect(pill.dataset.tag).toBe("lyrics");
    expect(pill.classList.contains("has-tag-color")).toBe(true);
  });

  it("keeps a value that names no tag a plain pill, saying why", () => {
    const pill = createTagPill("two words", VOCABULARY);
    expect(pill.textContent).toBe("two words");
    expect(pill.dataset.tag).toBeUndefined();
    expect(pill.dataset.tooltip).toBe("A tag can't contain spaces, or punctuation other than _ - and /");
  });
});

describe("tagPillColors", () => {
  it("gives a colored tag's fill and the text that reads on it, and nothing for an uncolored one", () => {
    expect(tagPillColors("Lyrics", VOCABULARY)).toEqual({ background: "#ecb72b", color: "#1a1a1a" });
    for (const name of ["draft", "odd", "unlisted"]) expect(tagPillColors(name, VOCABULARY), name).toBeUndefined();
  });
});

describe("paintTagPill", () => {
  it("fills a colored tag's pill, with text chosen to read on it", () => {
    const pill = tagPill("lyrics");
    paintTagPill(pill, VOCABULARY);
    expect(pill.classList.contains("has-tag-color")).toBe(true);
    expect(pill.style.backgroundColor).toBe("rgb(236, 183, 43)");
    expect(pill.style.color).toBe("rgb(26, 26, 26)");
  });

  it("leaves a tag with no color, an unreadable one, or none in the vocabulary plain", () => {
    for (const name of ["draft", "odd", "unlisted"]) {
      const pill = tagPill(name);
      paintTagPill(pill, VOCABULARY);
      expect(pill.classList.contains("has-tag-color"), name).toBe(false);
      expect(pill.style.backgroundColor, name).toBe("");
    }
  });

  it("fills a tag written in another case, from the first entry naming it", () => {
    const pill = tagPill("LYRICS");
    paintTagPill(pill, [...VOCABULARY, { name: "Lyrics", color: "#000000" }]);
    expect(pill.style.backgroundColor).toBe("rgb(236, 183, 43)");
  });

  it("clears a fill the vocabulary no longer gives", () => {
    const pill = tagPill("lyrics");
    paintTagPill(pill, VOCABULARY);
    paintTagPill(pill, []);
    expect(pill.classList.contains("has-tag-color")).toBe(false);
    expect(pill.style.backgroundColor).toBe("");
    expect(pill.style.color).toBe("");
  });
});

describe("paintTagPills", () => {
  it("paints from what's known, then again from a fresh read", async () => {
    let known: readonly TagDefinition[] = [];
    const source = {
      known: () => known,
      read: vi.fn(async () => {
        known = VOCABULARY;
        return known;
      }),
    };
    const root = document.createElement("div");
    const pill = tagPill("lyrics");
    root.append(pill, document.createElement("span"));
    paintTagPills(root, source);
    expect(pill.classList.contains("has-tag-color")).toBe(false);
    await vi.waitFor(() => expect(pill.classList.contains("has-tag-color")).toBe(true));
  });

  it("reads nothing where there is no tag pill", () => {
    const source = { known: () => VOCABULARY, read: vi.fn(async () => VOCABULARY) };
    paintTagPills(document.createElement("div"), source);
    expect(source.read).not.toHaveBeenCalled();
  });
});
