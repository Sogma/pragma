// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceTagChangeRequestBody, SpaceTagsResponse } from "../../../../src/protocol/api.ts";
import type { TagDefinition } from "../../../../src/protocol/tags.ts";
import type { TagVocabulary } from "../../../../web/core/tagVocabulary.ts";
import type { ContextMenuService, MenuItem, MenuOpenOptions } from "../../../../web/services/menus.ts";
import { createTagsSection } from "../../../../web/view/sidebar/tags.ts";

const tag = (name: string, color = ""): TagDefinition => ({ name, color });

// A vocabulary over an answer the test sets, changed as the server would.
function vocabulary(initial: SpaceTagsResponse) {
  let answer = initial;
  const listeners = new Set<(answer: SpaceTagsResponse) => void>();
  const settle = (next: SpaceTagsResponse) => {
    answer = next;
    for (const listener of listeners) listener(answer);
  };
  const change = vi.fn(async (request: SpaceTagChangeRequestBody) => {
    const others = answer.tags.filter((entry) => entry.name !== request.name);
    const current = answer.tags.find((entry) => entry.name === request.name) ?? tag(request.name);
    settle({
      tags: request.remove ? others : [...others, { ...current, color: request.color ?? current.color }],
    });
  });
  const tags: TagVocabulary = {
    known: () => answer.tags,
    problem: () => answer.problem,
    read: vi.fn(async () => answer.tags),
    change,
    declare: (name) => change({ name }),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(answer);
      return () => listeners.delete(listener);
    },
  };
  return { tags, change, settle };
}

function menu() {
  const opened: MenuOpenOptions[] = [];
  const contextMenu: ContextMenuService = {
    open: vi.fn((options: MenuOpenOptions) => void opened.push(options)),
    close: vi.fn(),
    isOpen: vi.fn(() => false),
  };
  const last = () => opened.at(-1) as MenuOpenOptions;
  const item = (label: string) => last().items?.find((entry) => entry.label === label) as MenuItem;
  return { contextMenu, opened, last, item };
}

async function shown(answer: SpaceTagsResponse) {
  const vocab = vocabulary(answer);
  const menus = menu();
  const section = createTagsSection({ tags: vocab.tags, contextMenu: menus.contextMenu });
  document.body.append(section.body, ...section.actions);
  section.refresh();
  await vi.waitFor(() => expect(vocab.tags.read).toHaveBeenCalled());
  await Promise.resolve();
  const rows = () => [...section.body.querySelectorAll<HTMLElement>(".tags-section-row")];
  const rowOf = (name: string) => rows().find((row) => row.dataset.tagName === name) as HTMLElement;
  const empty = section.body.querySelector(".stack-section-message") as HTMLElement;
  const add = section.actions[0] as HTMLButtonElement;
  return { section, ...vocab, ...menus, rows, rowOf, empty, add };
}

const rightClick = (row: HTMLElement) =>
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 6 }));

const run = async (item: MenuItem) => {
  await item.run?.({} as never, undefined);
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("createTagsSection", () => {
  it("hands the panel its body and an Add tag action, and draws nothing before a read", () => {
    const vocab = vocabulary({ tags: [tag("art")] });
    const section = createTagsSection({ tags: vocab.tags, contextMenu: menu().contextMenu });
    expect(section.actions.map((action) => action.getAttribute("aria-label"))).toEqual(["Add tag"]);
    expect(section.body.querySelector<HTMLElement>(".stack-section-message")?.hidden).toBe(true);
    expect(section.body.querySelectorAll(".tags-section-row")).toHaveLength(0);
    expect(vocab.tags.read).not.toHaveBeenCalled();
  });

  it("lists each declared tag once, alphabetically, as its pill", async () => {
    const { rows } = await shown({
      tags: [tag("screenplay", "#e03e3e"), tag("art"), tag("Lyrics", "#ecb72b"), tag("ART", "#000000")],
    });
    expect(rows().map((row) => row.dataset.tagName)).toEqual(["art", "Lyrics", "screenplay"]);

    const [art, lyrics] = rows();
    const pill = lyrics.querySelector<HTMLElement>(".tags-section-pill");
    expect(pill?.dataset.tag).toBe("Lyrics");
    expect(pill?.style.background).not.toBe("");
    // The first entry is the tag's, in any case, so a later one lends it no color.
    expect(art.querySelector<HTMLElement>(".tags-section-pill")?.style.background).toBe("");
  });

  it("counts the tags it lists in the header, and shows none for none or a file that doesn't read", async () => {
    const { section, settle } = await shown({ tags: [tag("art"), tag("draft"), tag("art", "#000000")] });
    const counts: string[] = [];
    section.showCountIn((text) => counts.push(text));
    expect(counts.at(-1)).toBe("2");

    settle({ tags: [tag("art"), tag("draft"), tag("music")] });
    expect(counts.at(-1)).toBe("3");
    settle({ tags: [] });
    expect(counts.at(-1)).toBe("");
    settle({ tags: [tag("art")], problem: "_tags.json doesn't parse" });
    expect(counts.at(-1)).toBe("");
  });

  it("says so when the space declares no tags", async () => {
    const { empty, rows } = await shown({ tags: [] });
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("No tags in this space yet.");
    expect(rows()).toHaveLength(0);
  });

  it("shows why a file that doesn't read declares nothing, and offers no changes", async () => {
    const { empty, add, rows } = await shown({ tags: [], problem: "_tags.json doesn't parse: bad comma" });
    expect(empty.textContent).toBe("_tags.json doesn't parse: bad comma");
    expect(add.hidden).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it("offers a tag's color and removal from its context menu, and draws no menu button", async () => {
    const { rowOf, last, item, change } = await shown({ tags: [tag("lyrics", "#ecb72b"), tag("art")] });
    expect(rowOf("art").querySelector("button")).toBeNull();

    rightClick(rowOf("lyrics"));
    expect(last().at).toEqual({ x: 5, y: 6 });
    expect(last().items?.map((entry) => entry.label)).toEqual(["Color…", "Remove from Tags"]);

    rightClick(rowOf("art"));
    await run(item("Remove from Tags"));
    expect(change).toHaveBeenLastCalledWith({ name: "art", remove: true });
  });

  it("picks a color in the shared picker", async () => {
    const { rowOf, item, change } = await shown({ tags: [tag("art")] });
    rightClick(rowOf("art"));
    await run(item("Color…"));
    const swatch = document.querySelector<HTMLButtonElement>('.color-picker-swatch[aria-label="Red"]');
    expect(swatch).not.toBeNull();
    swatch?.click();
    expect(change).toHaveBeenCalledWith({ name: "art", color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });

  it("adds a tag typed into the name field atop the list", async () => {
    const { add, section, change, rows, empty } = await shown({ tags: [] });
    add.click();
    expect(empty.hidden).toBe(true);
    const input = section.body.querySelector<HTMLInputElement>(".tags-section-new input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = "  worldbuilding ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith({ name: "worldbuilding" }));
    expect(section.body.querySelector(".tags-section-new")).toBeNull();
    expect(rows().map((row) => row.dataset.tagName)).toEqual(["worldbuilding"]);
  });

  it("shows a tag already listed rather than adding a second spelling", async () => {
    const { add, section, change, rowOf } = await shown({ tags: [tag("draft")] });
    add.click();
    const input = section.body.querySelector<HTMLInputElement>(".tags-section-new input") as HTMLInputElement;
    input.value = "Draft";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(change).not.toHaveBeenCalled();
    expect(rowOf("draft").classList.contains("flash")).toBe(true);
  });

  it("adds a name typed with its # by the name alone, and refuses one that names no tag, saying why", async () => {
    const { add, section, change } = await shown({ tags: [] });
    const nameField = () => section.body.querySelector<HTMLInputElement>(".tags-section-new input") as HTMLInputElement;
    add.click();
    nameField().value = "#lyrics";
    nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith({ name: "lyrics" }));

    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    add.click();
    nameField().value = "2024";
    nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(alert).toHaveBeenCalledWith("A tag can't be only digits");
    expect(change).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it("drops the name field on Escape", async () => {
    const { add, section, change, empty } = await shown({ tags: [] });
    add.click();
    const input = section.body.querySelector<HTMLInputElement>(".tags-section-new input") as HTMLInputElement;
    input.value = "art";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(section.body.querySelector(".tags-section-new")).toBeNull();
    expect(empty.hidden).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it("follows a tag declared elsewhere, and reports a refused change", async () => {
    const { settle, rows, rowOf, item, change } = await shown({ tags: [tag("art")] });
    settle({ tags: [tag("art"), tag("music")] });
    expect(rows().map((row) => row.dataset.tagName)).toEqual(["art", "music"]);

    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    change.mockRejectedValueOnce(new Error("_tags.json doesn't parse. Fix the file, then try again."));
    rightClick(rowOf("art"));
    await run(item("Remove from Tags"));
    expect(alert).toHaveBeenCalledWith("_tags.json doesn't parse. Fix the file, then try again.");
    alert.mockRestore();
  });
});
