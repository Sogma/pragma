// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryVersionResponse } from "../../../../src/protocol/api.ts";
import type { HistoryVersion, Tab } from "../../../../web/core/apiClient.ts";
import { dateTimeLabel } from "../../../../web/lib/dateText.ts";

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
  const scopes = () => [...pane.element.querySelectorAll<HTMLButtonElement>(".version-scope")];
  const scope = (label: string) => {
    const found = scopes().find((each) => each.textContent === label);
    if (!found) throw new Error(`no ${label} switch`);
    return found;
  };
  const pressed = () => scopes().find((each) => each.getAttribute("aria-pressed") === "true")?.textContent;
  return {
    pane,
    restore,
    copy: button("Copy the text before this change"),
    restoreButton: button("Restore"),
    lines,
    note,
    scopes,
    scope,
    pressed,
  };
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

  it("shows the change that replaced the version, headed by who made it and when", async () => {
    answers.set("v1", { content: "kept\nolder line\n", next: "kept\nnext line\n", current: "kept\nnewer line\n" });
    const { pane, lines, note, pressed } = setup();
    await pane.setInput(tabFor(), current);

    expect(pane.element.querySelector(".version-who")?.textContent).toBe("Flow: tidy");
    expect(pane.element.querySelector(".version-when")?.textContent).toBe(dateTimeLabel(VERSION.time));
    expect(pressed()).toBe("This change");
    expect(note()).toBeUndefined();
    expect(lines("remove")).toEqual(["older line"]);
    expect(lines("add")).toEqual(["next line"]);
  });

  it("switches to everything changed since, and back, keeping the switch it was clicked on", async () => {
    answers.set("v1", { content: "kept\nolder line\n", next: "kept\nnext line\n", current: "kept\nnewer line\n" });
    const { pane, lines, scope, pressed } = setup();
    await pane.setInput(tabFor(), current);

    const since = scope("Since then");
    since.click();
    expect(pressed()).toBe("Since then");
    expect(lines("add")).toEqual(["newer line"]);
    expect(pane.element.contains(since)).toBe(true);

    scope("This change").click();
    expect(pressed()).toBe("This change");
    expect(lines("add")).toEqual(["next line"]);
  });

  it("shows the newest version's change against the file, with nothing to switch between", async () => {
    answers.set("v1", { content: "kept\nolder line\n", current: "kept\nnewer line\n" });
    const { pane, lines, scopes } = setup();
    await pane.setInput(tabFor(), current);

    expect(scopes()).toEqual([]);
    expect(lines("remove")).toEqual(["older line"]);
    expect(lines("add")).toEqual(["newer line"]);
  });

  it("opens each version on its change, whichever comparison the last one showed", async () => {
    answers.set("v1", { content: "a\n", next: "b\n", current: "c\n" });
    answers.set("v2", { content: "x\n", next: "y\n", current: "z\n" });
    const { pane, scope, pressed, lines } = setup();
    await pane.setInput(tabFor(), current);
    scope("Since then").click();

    await pane.setInput(tabFor({ ...VERSION, id: "v2" }), current);
    expect(pressed()).toBe("This change");
    expect(lines("add")).toEqual(["y"]);
  });

  it("restores the version's text into its file, and copies it", async () => {
    answers.set("v1", { content: "older\n", current: "newer\n" });
    const { pane, restore, copy, restoreButton } = setup();
    await pane.setInput(tabFor(), current);

    expect(restoreButton.dataset.tooltip).toBe("Put back the text before this change");
    restoreButton.click();
    expect(restore).toHaveBeenCalledWith("notes/song.md", "older\n", false);
    copy.click();
    expect(clipboard.writeText).toHaveBeenCalledWith("older\n");
  });

  it("brings back a deleted file, whose every line the version holds alone", async () => {
    answers.set("v1", { content: "only line\n" });
    const { pane, restore, restoreButton, lines, note, scopes } = setup();
    await pane.setInput(tabFor(), current);

    expect(scopes()).toEqual([]);
    expect(note()).toBe("The file has been deleted since. Restore brings it back with this text.");
    expect(lines("remove")[0]).toBe("only line");
    expect(lines("add")).toEqual([]);
    restoreButton.click();
    expect(restore).toHaveBeenCalledWith("notes/song.md", "only line\n", true);
  });

  it("still shows an older change of a deleted file, and says it's gone since", async () => {
    answers.set("v1", { content: "older\n", next: "newer\n" });
    const { pane, lines, note, scope } = setup();
    await pane.setInput(tabFor(), current);

    expect(note()).toBeUndefined();
    expect(lines("add")).toEqual(["newer"]);
    scope("Since then").click();
    expect(note()).toBe("The file has been deleted since. Restore brings it back with this text.");
  });

  it("draws no diff when the change left the text as it was, or the file holds the version's text", async () => {
    answers.set("v1", { content: "same\n", current: "same\n" });
    const { pane, note } = setup();
    await pane.setInput(tabFor(), current);
    expect(note()).toBe("This change left the text as it was.");
    expect(pane.element.querySelector(".diff")).toBeNull();

    answers.set("v2", { content: "same\n", next: "other\n", current: "same\n" });
    const other = setup();
    await other.pane.setInput(tabFor({ ...VERSION, id: "v2" }), current);
    other.scope("Since then").click();
    expect(other.note()).toBe("The file's text is the same as this version's.");
    expect(other.pane.element.querySelector(".diff")).toBeNull();
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
