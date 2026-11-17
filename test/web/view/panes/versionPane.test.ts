// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryVersionResponse } from "../../../../src/protocol/api.ts";
import type { HistoryVersion, Tab } from "../../../../web/core/apiClient.ts";

const answers = new Map<string, HistoryVersionResponse>();

vi.mock("../../../../web/core/apiClient.ts", () => ({
  fetchHistoryVersion: vi.fn(async (_path: string, id: string) => {
    const answer = answers.get(id);
    if (!answer) throw new Error("404 Not Found");
    return answer;
  }),
}));

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

const { createVersionPane, versionPane } = await import("../../../../web/view/panes/versionPane.ts");

const VERSION: HistoryVersion = {
  id: "v1",
  time: new Date(2026, 10, 1, 14, 30).getTime(),
  source: "flow",
  detail: "flows/tidy.flow.html",
};
const tabFor = (version: HistoryVersion = VERSION): Tab => ({ kind: "version", path: "notes/song.md", version });
const current = { isCurrent: () => true };

function setup() {
  const restore = vi.fn(async (_path: string, _text: string, _gone: boolean) => {});
  const pane = createVersionPane({ restore });
  document.body.replaceChildren(pane.element);
  const buttons = [...(pane.toolbar?.querySelectorAll("button") ?? [])];
  const button = (name: string) => {
    const found = buttons.find((each) => (each.getAttribute("aria-label") ?? each.textContent) === name);
    if (!found) throw new Error(`no ${name} button`);
    return found;
  };
  const lines = (type: "add" | "remove") =>
    [...pane.element.querySelectorAll(`.diff-line-${type} .diff-text`)].map((line) => line.textContent);
  const note = () => pane.element.querySelector(".version-note")?.textContent;
  return { pane, restore, copy: button("Copy text"), restoreButton: button("Restore"), lines, note };
}

beforeEach(() => {
  answers.clear();
  clipboard.writeText.mockClear();
});

describe("the version pane", () => {
  it("asks for the toolbar and the status bar, and nothing else", () => {
    expect(versionPane({ restore: vi.fn() }).chrome).toEqual({
      toolbar: true,
      readingView: false,
      statusbar: true,
      actions: [],
    });
  });

  it("shows what changed since the version: its own lines taken out, the file's put in", async () => {
    answers.set("v1", { content: "kept\nolder line\n", current: "kept\nnewer line\n" });
    const { pane, lines, note } = setup();
    await pane.setInput(tabFor(), current);

    expect(pane.element.querySelector(".version-source")?.textContent).toBe("Flow: tidy");
    expect(note()).toBe("Changes made since this version.");
    expect(lines("remove")).toEqual(["older line"]);
    expect(lines("add")).toEqual(["newer line"]);
  });

  it("restores the version's text into its file, and copies it", async () => {
    answers.set("v1", { content: "older\n", current: "newer\n" });
    const { pane, restore, copy, restoreButton } = setup();
    await pane.setInput(tabFor(), current);

    restoreButton.click();
    expect(restore).toHaveBeenCalledWith("notes/song.md", "older\n", false);
    copy.click();
    expect(clipboard.writeText).toHaveBeenCalledWith("older\n");
  });

  it("brings back a deleted file, whose every line the version holds alone", async () => {
    answers.set("v1", { content: "only line\n" });
    const { pane, restore, restoreButton, lines, note } = setup();
    await pane.setInput(tabFor(), current);

    expect(note()).toBe("The file has been deleted since. Restore brings it back with this text.");
    expect(lines("remove")[0]).toBe("only line");
    expect(lines("add")).toEqual([]);
    restoreButton.click();
    expect(restore).toHaveBeenCalledWith("notes/song.md", "only line\n", true);
  });

  it("draws no diff when the file's text is the version's", async () => {
    answers.set("v1", { content: "same\n", current: "same\n" });
    const { pane, note } = setup();
    await pane.setInput(tabFor(), current);

    expect(note()).toBe("The file's text is the same as this version's.");
    expect(pane.element.querySelector(".diff")).toBeNull();
  });

  it("offers nothing to restore or copy for a version no longer kept, or before its text comes", async () => {
    const { pane, copy, restoreButton, note } = setup();
    expect(copy.disabled && restoreButton.disabled).toBe(true);

    await pane.setInput(tabFor({ ...VERSION, id: "expired" }), current);
    expect(note()).toBe("This version is no longer kept.");
    expect(copy.disabled && restoreButton.disabled).toBe(true);
  });

  it("drops an answer that lands after the tab has moved on", async () => {
    answers.set("v1", { content: "older\n", current: "newer\n" });
    const { pane, restoreButton } = setup();
    await pane.setInput(tabFor(), { isCurrent: () => false });

    expect(pane.element.childElementCount).toBe(0);
    expect(restoreButton.disabled).toBe(true);
  });
});
