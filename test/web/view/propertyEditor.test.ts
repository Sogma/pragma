// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagDefinition } from "../../../src/protocol/tags.ts";
import type { TableColumn } from "../../../src/protocol/types.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService } from "../../../web/services/menus.ts";
import { createPropertyEditor } from "../../../web/view/propertyEditor.ts";

function fakeContextMenu() {
  return {
    open: vi.fn<ContextMenuService["open"]>(),
    close: vi.fn<ContextMenuService["close"]>(),
    isOpen: vi.fn<ContextMenuService["isOpen"]>(() => false),
  };
}

function setup(data: Record<string, unknown>) {
  const container = document.createElement("div");
  const onChange = vi.fn();
  const onStructuralChange = vi.fn();
  const contextMenu = fakeContextMenu();
  const editor = createPropertyEditor(container, data, onChange, { onStructuralChange, contextMenu });
  return { container, editor, onChange, onStructuralChange, data, contextMenu };
}

function menuButton(container: HTMLElement, key: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `.property-editor-row[data-key="${key}"] .property-menu-button`,
  );
  if (!found) throw new Error(`no menu button for ${key}`);
  return found;
}

// Picks Remove from the menu the last click opened.
function pickRemove(contextMenu: ReturnType<typeof fakeContextMenu>): void {
  const remove = contextMenu.open.mock.calls.at(-1)?.[0].items?.find((item) => item.label === "Remove");
  if (!remove?.run) throw new Error("no Remove item");
  void remove.run({} as CommandContext, undefined);
}

describe("render — basic rows", () => {
  it("renders one row per key plus an Add-property button", () => {
    const { container, editor } = setup({ title: "Hello", count: 5 });
    editor.render();
    expect(container.querySelectorAll(".property-editor-row")).toHaveLength(2);
    expect(container.querySelector(".data-table-add-row")?.textContent).toBe("+ Add property");
  });

  it("renders an array value as tag pills plus an add-tag input", () => {
    const { container, editor } = setup({ tags: ["a", "b"] });
    editor.render();
    expect(container.querySelectorAll(".property-editor-pill")).toHaveLength(2);
    expect(container.querySelector(".property-editor-tag-input")).not.toBeNull();
  });
});

describe("scalar editing", () => {
  function valueField(container: HTMLElement, key: string): HTMLTextAreaElement {
    const found = container.querySelector<HTMLTextAreaElement>(
      `.property-editor-row[data-key="${key}"] .wrapping-field-input`,
    );
    if (!found) throw new Error(`no field for ${key}`);
    return found;
  }

  function type(field: HTMLTextAreaElement, value: string): void {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("coerces a numeric string into a real number on input", () => {
    const { container, editor, onChange, data } = setup({ count: 1 });
    editor.render();
    type(valueField(container, "count"), "42");
    expect(data.count).toBe(42);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("turns the row's icon to the value's new type as it is typed", () => {
    const { container, editor } = setup({ count: "a" });
    editor.render();
    const icon = () => container.querySelector<HTMLElement>('.property-editor-row[data-key="count"] .property-icon');
    expect(icon()?.dataset.valueType).toBe("text");
    type(valueField(container, "count"), "42");
    expect(icon()?.dataset.valueType).toBe("number");
  });

  it("keeps a number typed as text, for a file that holds only text", () => {
    const container = document.createElement("div");
    const data: Record<string, unknown> = { count: "1" };
    const editor = createPropertyEditor(container, data, vi.fn(), { contextMenu: fakeContextMenu(), textValues: true });
    editor.render();
    type(valueField(container, "count"), "42");
    expect(data.count).toBe("42");
    expect(container.querySelector<HTMLElement>(".property-icon")?.dataset.valueType).toBe("text");
  });

  it("keeps arbitrary text as a string, on one line", () => {
    const { container, editor, data } = setup({ title: "old" });
    editor.render();
    type(valueField(container, "title"), "new\ntitle");
    expect(data.title).toBe("new title");
  });

  it("edits text in a wrapping field named for its key, and keeps the date's own input", () => {
    const { container, editor } = setup({ title: "Hello", date: "2026-01-01" });
    editor.render();
    expect(valueField(container, "title").getAttribute("aria-label")).toBe("title");
    const dateRow = container.querySelector('.property-editor-row[data-key="date"]');
    expect(dateRow?.querySelector("input.property-editor-value-input")).not.toBeNull();
    expect(dateRow?.querySelector(".wrapping-field")).toBeNull();
  });

  it("takes an edit back on Escape, restoring the value as it was", () => {
    const { container, editor, data } = setup({ count: 1 });
    document.body.appendChild(container); // focus() is a no-op on a detached element
    editor.render();
    const field = valueField(container, "count");
    field.focus();
    type(field, "42");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(data.count).toBe(1);
    expect(field.value).toBe("1");
    container.remove();
  });

  it("saves nothing for a value it only opened, line breaks and all", () => {
    const { container, editor, onChange, data } = setup({ summary: "one\ntwo" });
    document.body.appendChild(container);
    editor.render();
    const field = valueField(container, "summary");
    field.focus();
    field.blur();
    expect(onChange).not.toHaveBeenCalled();
    expect(data.summary).toBe("one\ntwo");
    container.remove();
  });
});

describe("tag pills", () => {
  it("adding a tag via Enter appends it without duplicating", () => {
    const { container, editor, onChange, data } = setup({ tags: ["a"] });
    editor.render();
    const addInput = container.querySelector(".property-editor-tag-input") as HTMLInputElement;
    addInput.value = "b";
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(data.tags).toEqual(["a", "b"]);
    expect(onChange).toHaveBeenCalled();
  });

  it("counts a tag applied in another case as applied", () => {
    const { container, editor, data } = setup({ tags: ["draft"] });
    editor.render();
    const addInput = container.querySelector(".property-editor-tag-input") as HTMLInputElement;
    addInput.value = "Draft";
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(data.tags).toEqual(["draft"]);
  });

  it("adds a typed tag by its name, without its #, and counts one written with it as applied", () => {
    const { container, editor, data } = setup({ tags: ["#draft"] });
    editor.render();
    const addInput = () => container.querySelector(".property-editor-tag-input") as HTMLInputElement;
    addInput().value = "#Draft";
    addInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(data.tags).toEqual(["#draft"]);
    addInput().value = "#rewrite";
    addInput().dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true }));
    expect(data.tags).toEqual(["#draft", "rewrite"]);
  });

  it("refuses a typed tag that names no tag, saying why, and leaves it in the field", () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { container, editor, onChange, data } = setup({ tags: ["a"] });
    editor.render();
    const addInput = container.querySelector(".property-editor-tag-input") as HTMLInputElement;
    addInput.value = "two words";
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(alert).toHaveBeenCalledWith("A tag can't contain spaces, or punctuation other than _ - and /");
    expect(data.tags).toEqual(["a"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(addInput.value).toBe("two words");
    alert.mockRestore();
  });

  it("takes any text in a list that holds no tags", () => {
    const { container, editor, data } = setup({ aliases: ["a"] });
    editor.render();
    const addInput = container.querySelector(".property-editor-tag-input") as HTMLInputElement;
    addInput.value = "two words";
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(data.aliases).toEqual(["a", "two words"]);
  });

  it("shows a value written with its # as its tag, and one naming no tag as a plain pill", () => {
    const { container, editor } = setup({ tags: ["#draft", "two words"] });
    editor.render();
    const pills = [...container.querySelectorAll<HTMLElement>(".property-editor-pill")];
    expect(pills.map((pill) => pill.dataset.tag)).toEqual(["draft", undefined]);
    expect(pills[1].querySelector(".pill-label")?.textContent).toBe("two words");
  });

  it("removing a pill splices it out of the array", () => {
    const { container, editor, data } = setup({ tags: ["a", "b"] });
    editor.render();
    const removeButtons = container.querySelectorAll<HTMLButtonElement>(".property-editor-pill-remove");
    removeButtons[0].click();
    expect(data.tags).toEqual(["b"]);
  });

  it("migrates a non-empty scalar tags value to a one-item array on first render", () => {
    const { container, editor, data } = setup({ tags: "poetry" });
    editor.render();
    expect(data.tags).toEqual(["poetry"]);
    expect(container.querySelectorAll(".property-editor-pill")).toHaveLength(1);
  });
});

describe("addProperty", () => {
  it("adds a blank property named 'property', focused for rename", () => {
    const { container, editor, data, onStructuralChange } = setup({});
    document.body.appendChild(container); // focus() is a no-op on a detached element
    const row = editor.addProperty();
    expect(data.property).toBe("");
    expect(onStructuralChange).toHaveBeenCalledTimes(1);
    const keyInput = container.querySelector<HTMLInputElement>(".property-editor-key");
    expect(document.activeElement).toBe(keyInput);
    expect(row).toBe(keyInput?.closest(".property-editor-row"));
    container.remove();
  });

  // The row appears beside the button that was clicked: an expected place.
  it("doesn't flash a row added from its own button", () => {
    const { container, editor } = setup({});
    editor.render();
    container.querySelector<HTMLButtonElement>(".data-table-add-row")?.click();
    expect(container.querySelector(".property-editor-row")).not.toBeNull();
    expect(container.querySelector(".flash")).toBeNull();
  });

  it("suffixes on collision: 'property 2', 'property 3', ...", () => {
    const { editor, data } = setup({ property: "", "property 2": "" });
    editor.addProperty();
    expect(data["property 3"]).toBe("");
  });
});

describe("rename", () => {
  it("renames a key on blur, preserving its value and position", () => {
    const { container, editor, data, onChange } = setup({ a: 1, b: 2 });
    editor.render();
    const keyInputs = container.querySelectorAll<HTMLInputElement>(".property-editor-key");
    keyInputs[0].value = "renamed";
    keyInputs[0].dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(Object.keys(data)).toEqual(["renamed", "b"]);
    expect(data.renamed).toBe(1);
    expect(onChange).toHaveBeenCalled();
  });

  it("reverts to the original name when the new name collides with an existing key", () => {
    const { container, editor, data } = setup({ a: 1, b: 2 });
    editor.render();
    const keyInputs = container.querySelectorAll<HTMLInputElement>(".property-editor-key");
    keyInputs[0].value = "b";
    keyInputs[0].dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(Object.keys(data)).toEqual(["a", "b"]);
  });

  it("reverts to the original name when the new name is a read-only key, even one not there yet", () => {
    const container = document.createElement("div");
    const data: Record<string, unknown> = { a: "1" };
    const onChange = vi.fn();
    const editor = createPropertyEditor(container, data, onChange, {
      contextMenu: fakeContextMenu(),
      readOnlyKeys: ["created", "modified"],
    });
    editor.render();
    const keyInput = container.querySelector<HTMLInputElement>("input.property-editor-key");
    if (!keyInput) throw new Error("no key input");
    keyInput.value = "modified";
    keyInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(Object.keys(data)).toEqual(["a"]);
    expect(keyInput.value).toBe("a");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("read-only keys", () => {
  it("shows a read-only key's value as text, with no field to edit, name to change or menu", () => {
    const container = document.createElement("div");
    const data: Record<string, unknown> = { description: "Models.", created: "2026-08-08" };
    const contextMenu = fakeContextMenu();
    createPropertyEditor(container, data, vi.fn(), { contextMenu, readOnlyKeys: ["created", "modified"] }).render();

    const row = container.querySelector('.property-editor-row[data-key="created"]');
    expect(row?.querySelector(".property-editor-value-readonly")?.textContent).toBe("2026-08-08");
    expect(row?.querySelector("input, textarea, button")).toBeNull();
    expect(row?.querySelector(".property-editor-key-fixed")?.textContent).toBe("created");
    const editable = container.querySelector('.property-editor-row[data-key="description"]');
    expect(editable?.querySelector("textarea")).not.toBeNull();
    expect(editable?.querySelector(".property-menu-button")).not.toBeNull();
  });

  it("gives a key's field and a read-only value their whole text as a tooltip once cut", () => {
    const container = document.createElement("div");
    const data: Record<string, unknown> = { description: "Models.", created: "2026-08-08" };
    const contextMenu = fakeContextMenu();
    createPropertyEditor(container, data, vi.fn(), { contextMenu, readOnlyKeys: ["created"] }).render();
    const cut = (selector: string) => container.querySelector<HTMLElement>(selector)?.dataset.tooltipOverflow;
    expect(cut('.property-editor-row[data-key="description"] input.property-editor-key')).toBe("");
    expect(cut('.property-editor-row[data-key="description"] textarea')).toBe("");
    expect(cut(".property-editor-value-readonly")).toBe("");
  });
});

describe("remove", () => {
  it("removes a property from its icon's menu, in red, and calls onStructuralChange", () => {
    const { container, editor, data, onStructuralChange, contextMenu } = setup({ a: 1, b: 2 });
    editor.render();
    const button = menuButton(container, "a");
    expect(button.getAttribute("aria-label")).toBe("Property options for a");
    expect(button.dataset.tooltip).toBe("Property options");
    button.click();
    const options = contextMenu.open.mock.calls[0][0];
    expect(options.anchor).toBe(button);
    expect(options.items?.map(({ label, danger }) => ({ label, danger }))).toEqual([{ label: "Remove", danger: true }]);
    pickRemove(contextMenu);
    expect(data).toEqual({ b: 2 });
    expect(onStructuralChange).toHaveBeenCalledTimes(1);
  });

  it("opens the same menu on a right-click, and a click while it is open closes it", () => {
    const { container, editor, contextMenu } = setup({ a: 1 });
    editor.render();
    const button = menuButton(container, "a");
    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    button.dispatchEvent(rightClick);
    expect(rightClick.defaultPrevented).toBe(true);
    expect(contextMenu.open.mock.calls[0][0].anchor).toBe(button);
    contextMenu.isOpen.mockReturnValue(true);
    button.click();
    expect(contextMenu.close).toHaveBeenCalledTimes(1);
    expect(contextMenu.open).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the row in the removed one's place, else the one before, else Add property", () => {
    const { container, editor, contextMenu } = setup({ a: 1, b: 2, c: 3 });
    document.body.appendChild(container); // focus() is a no-op on a detached element
    editor.render();
    menuButton(container, "a").click();
    pickRemove(contextMenu);
    expect(document.activeElement).toBe(menuButton(container, "b"));
    menuButton(container, "c").click();
    pickRemove(contextMenu);
    expect(document.activeElement).toBe(menuButton(container, "b"));
    menuButton(container, "b").click();
    pickRemove(contextMenu);
    expect(document.activeElement).toBe(container.querySelector(".data-table-add-row"));
    container.remove();
  });
});

describe("move", () => {
  // jsdom has no pointer capture and lays nothing out: each row is given
  // 24px of height on a 30px pitch, so row i's middle is at 30i + 12. A box
  // stays with its row as the row moves, as jsdom can't lay it out afresh.
  function laidOut(data: Record<string, unknown>) {
    const editor = setup(data);
    document.body.appendChild(editor.container);
    editor.editor.render();
    editor.container.querySelectorAll<HTMLElement>(".property-editor-row").forEach((row, i) => {
      row.getBoundingClientRect = () =>
        ({ left: 0, top: i * 30, bottom: i * 30 + 24, width: 200, height: 24 }) as DOMRect;
    });
    return editor;
  }
  const order = (data: Record<string, unknown>) => Object.keys(data);
  const shown = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>(".property-editor > .property-editor-row")].map(
      (row) => row.dataset.key,
    );
  const pointer = (type: string, on: EventTarget, y: number) =>
    on.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: y, pointerId: 1 }));
  const click = (on: Element) => on.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  afterEach(() => {
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    document.body.replaceChildren();
  });
  function stubPointerCapture() {
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
  }

  it("moves a property with Alt+Up and Alt+Down on its icon, keeping focus there", () => {
    const { container, editor, data, onChange } = setup({ a: 1, b: 2, c: 3 });
    document.body.appendChild(container);
    editor.render();
    const press = (key: string, init: KeyboardEventInit) =>
      menuButton(container, key).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );

    press("a", { key: "ArrowDown", altKey: true });
    expect(order(data)).toEqual(["b", "a", "c"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(menuButton(container, "a"));

    press("b", { key: "ArrowUp", altKey: true });
    press("a", { key: "ArrowDown" });
    press("a", { key: "ArrowDown", altKey: true, ctrlKey: true });
    expect(order(data)).toEqual(["b", "a", "c"]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("lifts a dragged row under the pointer, moves its place as it goes, and the release opens no menu", () => {
    stubPointerCapture();
    const { container, data, onChange, contextMenu } = laidOut({ a: 1, b: 2, c: 3 });
    const handle = menuButton(container, "c");
    pointer("pointerdown", handle, 72);
    pointer("pointermove", document, 60);
    pointer("pointermove", document, 5);
    const ghost = container.querySelector<HTMLElement>(".property-editor-drag-ghost");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.querySelector<HTMLInputElement>("input.property-editor-key")?.value).toBe("c");
    expect(shown(container)).toEqual(["c", "a", "b"]);
    expect(container.querySelector('.property-editor-row[data-key="c"]')?.classList).toContain("dragging");
    expect(order(data)).toEqual(["a", "b", "c"]);
    pointer("pointerup", document, 5);
    click(handle);

    expect(order(data)).toEqual(["c", "a", "b"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".property-editor-drag-ghost")).toBeNull();
    expect(contextMenu.open).not.toHaveBeenCalled();
  });

  it("lifts nothing when there is only one property to move", () => {
    stubPointerCapture();
    const { container } = laidOut({ a: 1 });
    pointer("pointerdown", menuButton(container, "a"), 12);
    pointer("pointermove", document, 80);
    expect(container.querySelector(".property-editor-drag-ghost")).toBeNull();
    pointer("pointerup", document, 80);
  });

  it("treats a press that stays put as the click that opens the menu", () => {
    stubPointerCapture();
    const { container, data, contextMenu } = laidOut({ a: 1, b: 2 });
    const handle = menuButton(container, "a");
    pointer("pointerdown", handle, 12);
    pointer("pointermove", document, 14);
    pointer("pointerup", document, 14);
    click(handle);
    expect(order(data)).toEqual(["a", "b"]);
    expect(contextMenu.open).toHaveBeenCalledTimes(1);
  });

  it("puts a dragged property back on Escape, and still opens nothing on release", () => {
    stubPointerCapture();
    const { container, data, onChange, contextMenu } = laidOut({ a: 1, b: 2, c: 3 });
    const handle = menuButton(container, "a");
    pointer("pointerdown", handle, 12);
    pointer("pointermove", document, 80);
    expect(shown(container)).toEqual(["b", "c", "a"]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(shown(container)).toEqual(["a", "b", "c"]);
    expect(container.querySelector(".property-editor-drag-ghost")).toBeNull();
    pointer("pointerup", document, 80);
    click(handle);
    expect(order(data)).toEqual(["a", "b", "c"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(contextMenu.open).not.toHaveBeenCalled();
  });
});

describe("icons", () => {
  it("gives `pragma` the scope mark in an AGENTS.md, and elsewhere its value's type", () => {
    const iconFor = (path: string) => {
      const container = document.createElement("div");
      createPropertyEditor(container, { pragma: null }, vi.fn(), { path, contextMenu: fakeContextMenu() }).render();
      return container.querySelector<HTMLElement>(".property-editor-row .property-icon")?.dataset;
    };
    expect(iconFor("notes/AGENTS.md")?.knownKey).toBe("pragma");
    expect(iconFor("notes/a.md")?.valueType).toBe("text");
  });

  it("puts the icon before the key, in one cell, inside its menu button where the row can be removed", () => {
    const fixed = document.createElement("div");
    const readOnly = { contextMenu: fakeContextMenu(), readOnlyKeys: ["created"] };
    createPropertyEditor(fixed, { created: "2026-01-01" }, vi.fn(), readOnly).render();
    const fixedCell = fixed.querySelector(".property-editor-key-cell");
    expect([...(fixedCell?.children ?? [])].map((child) => child.className)).toEqual([
      "property-icon",
      "property-editor-key property-editor-key-fixed",
    ]);

    const open = setup({ a: "x" });
    open.editor.render();
    const button = open.container.querySelector(".property-editor-key-cell")?.firstElementChild;
    expect(button?.className).toBe("icon-button property-menu-button");
    expect(button?.firstElementChild?.className).toBe("property-icon");
  });
});

describe("tag suggestions", () => {
  const VOCABULARY: TagDefinition[] = [
    { name: "screenplay", color: "#e03e3e" },
    { name: "lyrics", color: "" },
  ];

  function setupWithTags(data: Record<string, unknown>) {
    const container = document.createElement("div");
    document.body.appendChild(container); // focus() is a no-op on a detached element
    const tags = { known: () => VOCABULARY, read: async () => VOCABULARY };
    const editor = createPropertyEditor(container, data, vi.fn(), { tags, contextMenu: fakeContextMenu() });
    editor.render();
    const input = (key: string) => {
      const found = container.querySelector<HTMLInputElement>(
        `.property-editor-row[data-key="${key}"] .property-editor-tag-input`,
      );
      if (!found) throw new Error(`no add input for ${key}`);
      return found;
    };
    const names = () => [...document.querySelectorAll(".tag-suggestion-name")].map((name) => name.textContent);
    const pill = (key: string, item: string) => {
      const pills = container.querySelectorAll<HTMLElement>(
        `.property-editor-row[data-key="${key}"] .property-editor-pill`,
      );
      const found = [...pills].find((candidate) => candidate.firstElementChild?.textContent === item);
      if (!found) throw new Error(`no ${item} pill under ${key}`);
      return found;
    };
    return { input, names, pill };
  }

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.replaceChildren();
  });

  it("adds the highlighted suggestion on Enter, in place of the typed text", () => {
    const data: Record<string, unknown> = { tags: [] };
    const { input } = setupWithTags(data);
    const tagInput = input("tags");
    tagInput.focus();
    tagInput.value = "scr";
    tagInput.dispatchEvent(new Event("input"));
    tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(data.tags).toEqual(["screenplay"]);
  });

  it("adds a clicked suggestion, then offers the rest from the rebuilt input", () => {
    const data: Record<string, unknown> = { tags: [] };
    const { input, names } = setupWithTags(data);
    input("tags").focus();
    expect(names()).toEqual(["lyrics", "screenplay"]);
    document.querySelectorAll<HTMLElement>(".tag-suggestions [role=option]")[1].click();
    expect(data.tags).toEqual(["screenplay"]);
    expect(document.activeElement).toBe(input("tags"));
    expect(names()).toEqual(["lyrics"]);
  });

  it("offers the vocabulary on the tags key alone", () => {
    const { input, names } = setupWithTags({ characters: ["Lina"] });
    input("characters").focus();
    expect(names()).toEqual([]);
  });

  it("fills a tag's pill with its color, leaving uncolored, unknown and other keys' pills plain", () => {
    const { pill } = setupWithTags({ tags: ["screenplay", "lyrics", "unlisted"], characters: ["screenplay"] });
    expect(pill("tags", "screenplay").classList.contains("has-tag-color")).toBe(true);
    expect(pill("tags", "screenplay").style.backgroundColor).toBe("rgb(224, 62, 62)");
    expect(pill("tags", "screenplay").style.color).not.toBe("");
    for (const plain of [pill("tags", "lyrics"), pill("tags", "unlisted"), pill("characters", "screenplay")]) {
      expect(plain.classList.contains("has-tag-color")).toBe(false);
      expect(plain.style.backgroundColor).toBe("");
    }
  });

  it("paints the pills again once the vocabulary is read afresh", async () => {
    let known: readonly TagDefinition[] = [];
    const read = async () => {
      known = VOCABULARY;
      return known;
    };
    const container = document.createElement("div");
    createPropertyEditor(container, { tags: ["screenplay"] }, vi.fn(), {
      tags: { known: () => known, read },
      contextMenu: fakeContextMenu(),
    }).render();
    const pill = container.querySelector<HTMLElement>('[data-tag="screenplay"]');
    expect(pill?.classList.contains("has-tag-color")).toBe(false);
    await vi.waitFor(() => expect(pill?.classList.contains("has-tag-color")).toBe(true));
  });
});

describe("a context's pragma row", () => {
  function contextSetup(data: Record<string, unknown>) {
    const container = document.createElement("div");
    const contextMenu = fakeContextMenu();
    const card = document.createElement("div");
    card.className = "context-settings-card";
    const context = { card: vi.fn(() => card), open: vi.fn() };
    const editor = createPropertyEditor(container, data, vi.fn(), { contextMenu, context, path: "film/AGENTS.md" });
    editor.render();
    return { container, contextMenu, context, card };
  }

  // A field would flatten the block into a string the moment it was typed in.
  it("shows the context's card under the row, read-only, and no field of its own", () => {
    const { container, context, card } = contextSetup({ pragma: { screenplay: { world: "world/" } } });
    const row = container.querySelector('.property-editor-row[data-key="pragma"]');
    expect(row?.querySelector(".property-editor-value")?.children).toHaveLength(0);
    expect(row?.nextElementSibling).toBe(card);
    expect(context.card).toHaveBeenCalledWith({ pragma: { screenplay: { world: "world/" } } });
  });

  it("offers the Context dialog above Remove in the row's menu", () => {
    const { container, contextMenu, context } = contextSetup({ pragma: "" });
    menuButton(container, "pragma").click();
    const items = contextMenu.open.mock.calls.at(-1)?.[0].items ?? [];
    expect(items.map((item) => item.label)).toEqual(["Context…", "Remove"]);
    void items[0]?.run?.({} as CommandContext, undefined);
    expect(context.open).toHaveBeenCalled();
  });

  it("leaves every other key as it was", () => {
    const { container } = contextSetup({ pragma: "", title: "Forbidden" });
    expect(container.querySelector('.property-editor-row[data-key="title"] .wrapping-field-input')).not.toBeNull();
  });
});

describe("a key a Class types", () => {
  const fields: TableColumn[] = [
    { id: "rating", type: "score", label: "Rating", reject: true },
    { id: "status", type: "select", label: "Status", options: ["draft", "final"] },
    { id: "summary", type: "text", label: "Summary" },
    { id: "tags", type: "select", label: "Tags", options: ["a"] },
  ];

  function typedSetup(data: Record<string, unknown>) {
    const container = document.createElement("div");
    const onChange = vi.fn();
    createPropertyEditor(container, data, onChange, { contextMenu: fakeContextMenu(), fields }).render();
    const row = (key: string) => container.querySelector(`.property-editor-row[data-key="${key}"]`) as HTMLElement;
    return { row, onChange, data };
  }

  it("draws its value with the field's control, and its icon with the field's type", () => {
    const { row } = typedSetup({ rating: 3, status: "final" });
    expect(row("rating").querySelectorAll(".score-mark[data-lit]")).toHaveLength(3);
    expect(row("rating").querySelector<HTMLElement>(".property-icon")?.dataset.fieldType).toBe("score");
    expect(row("status").querySelector<HTMLSelectElement>("select")?.value).toBe("final");
  });

  it("saves a value as the field stores it, and a cleared one as blank, keeping its row", () => {
    const { row, data, onChange } = typedSetup({ rating: "" });
    const marks = row("rating").querySelectorAll<HTMLButtonElement>(".score-mark");
    marks[3].click();
    expect(data.rating).toBe(4);
    marks[3].click();
    expect(data.rating).toBe("");
    row("rating").querySelector<HTMLButtonElement>(".score-reject")?.click();
    expect(data.rating).toBe(-1);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("draws by the value's shape a value that isn't the field's, text, and tags", () => {
    const { row } = typedSetup({ rating: 9, summary: "Long.", tags: ["a"] });
    expect(row("rating").querySelector(".score")).toBeNull();
    expect(row("rating").querySelector<HTMLElement>(".property-icon")?.dataset.valueType).toBe("number");
    expect(row("summary").querySelector(".wrapping-field-input")).not.toBeNull();
    expect(row("tags").querySelector(".property-editor-tag-input")).not.toBeNull();
  });
});
