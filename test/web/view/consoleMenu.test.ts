// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";
import { createModelConsole } from "../../../web/services/modelConsole.ts";
import { wireConsoleMenu } from "../../../web/view/consoleMenu.ts";

// jsdom lays nothing out, so there is nothing to scroll.
Element.prototype.scrollIntoView ??= () => {};

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  writeText.mockClear();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function setup() {
  const consoleEntries = document.createElement("div");
  document.body.appendChild(consoleEntries);
  const modelConsole = createModelConsole({ consoleEntries, activityIndicator: document.createElement("div") });
  const open = vi.fn((_options: MenuOpenOptions) => {});
  wireConsoleMenu({ consoleEntries, contextMenu: { open, close: vi.fn(), isOpen: () => false }, modelConsole });
  return { consoleEntries, modelConsole, open };
}

// Right-clicks `target` and returns the menu's items by label.
function rightClick(target: Element, open: ReturnType<typeof setup>["open"]): Map<string, MenuItem> {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const items = open.mock.lastCall?.[0].items ?? [];
  return new Map(items.map((item) => [item.label as string, item]));
}

function pick(item: MenuItem | undefined): void {
  void item?.run?.({} as never, undefined);
}

describe("the Console's right-click menu", () => {
  it("copies the clicked entry, or every entry", () => {
    const { consoleEntries, modelConsole, open } = setup();
    modelConsole.logEntry("info", "GIT", "Pull", "ok");
    modelConsole.logEntry("error", "GIT", "Push", "rejected");
    const items = rightClick(consoleEntries.querySelectorAll(".console-entry-content")[1], open);
    expect([...items.keys()]).toEqual(["Copy", "Copy All", "Clear Console"]);
    expect(items.get("Clear Console")?.group).not.toBe(items.get("Copy All")?.group);
    pick(items.get("Copy"));
    expect(writeText).toHaveBeenLastCalledWith("[error] GIT  Push\nrejected");
    pick(items.get("Copy All"));
    expect(writeText).toHaveBeenLastCalledWith("GIT  Pull\nok\n\n[error] GIT  Push\nrejected");
  });

  it("copies the selection instead when it touches the clicked entry", () => {
    const { consoleEntries, modelConsole, open } = setup();
    modelConsole.logEntry("info", "LLM", "Generate", "the whole prompt");
    const text = consoleEntries.querySelector(".console-entry-content")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 9);
    window.getSelection()?.addRange(range);
    pick(rightClick(text.parentElement as Element, open).get("Copy"));
    expect(writeText).toHaveBeenLastCalledWith("whole");
  });

  it("ignores a selection in another entry", () => {
    const { consoleEntries, modelConsole, open } = setup();
    modelConsole.logEntry("info", "GIT", "Pull", "first");
    modelConsole.logEntry("info", "GIT", "Push", "second");
    const [first, second] = [...consoleEntries.querySelectorAll(".console-entry-content")];
    const range = document.createRange();
    range.selectNodeContents(first);
    window.getSelection()?.addRange(range);
    pick(rightClick(second, open).get("Copy"));
    expect(writeText).toHaveBeenLastCalledWith("GIT  Push\nsecond");
  });

  it("offers no Copy off an entry, and no Copy All while nothing is logged", () => {
    const { consoleEntries, open } = setup();
    const welcome = document.createElement("div");
    consoleEntries.appendChild(welcome);
    const items = rightClick(welcome, open);
    expect([...items.keys()]).toEqual(["Copy All", "Clear Console"]);
    expect(items.get("Copy All")?.disabled?.({} as never, undefined)).toBe(true);
    expect(items.get("Clear Console")?.disabled?.({} as never, undefined)).toBe(false);
  });

  it("clears every entry and the welcome line, and can't clear an empty Console", () => {
    const { consoleEntries, modelConsole, open } = setup();
    consoleEntries.appendChild(document.createElement("div"));
    modelConsole.logEntry("info", "GIT", "Pull", "ok");
    pick(rightClick(consoleEntries.querySelector(".console-entry") as Element, open).get("Clear Console"));
    expect(consoleEntries.childElementCount).toBe(0);
    const items = rightClick(consoleEntries, open);
    expect(items.get("Clear Console")?.disabled?.({} as never, undefined)).toBe(true);
  });
});
