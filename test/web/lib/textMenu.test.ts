// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Misspelling } from "../../../src/protocol/api.ts";
import { installTextMenu } from "../../../web/lib/textMenu.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";
import { polyfillRangeRects } from "../support/codemirrorJsdom.ts";

polyfillRangeRects();

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const clipboard = {
  writeText: vi.fn(async (_text: string) => undefined),
  readText: vi.fn(async () => "pasted"),
};
Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

let opened: MenuOpenOptions[];
let uninstall: () => void;
let execCommand: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  // jsdom computes no user-select, so an element states its own in
  // data-select, and the body stands for the interface's `none`.
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (element: Element) =>
      ({
        userSelect: (element as HTMLElement).dataset?.select ?? (element === document.body ? "none" : "auto"),
      }) as unknown as CSSStyleDeclaration,
  );
  execCommand = vi.fn(() => true);
  document.execCommand = execCommand as unknown as Document["execCommand"];
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  clipboard.readText.mockReset().mockResolvedValue("pasted");
  opened = [];
  const installed = installTextMenu({ open: (options) => void opened.push(options) });
  uninstall = () => installed.dispose();
});

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete window.pragmaElectron;
});

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  target.dispatchEvent(event);
  return event;
}

function items(): MenuItem[] {
  const last = opened.at(-1);
  if (!last?.items) throw new Error("no menu opened");
  return last.items;
}

const labels = () => items().map((item) => item.label);
const unavailable = () =>
  items()
    .filter((item) => item.disabled?.(context, undefined))
    .map((item) => item.label);

async function pick(label: string): Promise<void> {
  await items()
    .find((item) => item.label === label)
    ?.run?.(context, undefined);
  await tick();
}

function select(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("text menu", () => {
  it("under pragma dev, leaves the interface's own words to the browser's menu", () => {
    vi.stubEnv("DEV", true);
    html("<div><span>Rename…</span></div>");
    const event = rightClick(document.querySelector("span") as Element);
    expect(opened).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("in a build, cancels the browser's menu where no menu of Pragma's opens", () => {
    vi.stubEnv("DEV", false);
    html('<div><span>Rename…</span></div><div data-select="text"><img alt=""></div>');
    expect(rightClick(document.querySelector("span") as Element).defaultPrevented).toBe(true);
    expect(rightClick(document.querySelector("img") as Element).defaultPrevented).toBe(true);
    expect(opened).toEqual([]);
  });

  it("in the desktop app, leaves that right-click to the app's own process", () => {
    vi.stubEnv("DEV", false);
    window.pragmaElectron = {} as NonNullable<Window["pragmaElectron"]>;
    html("<div><span>Rename…</span></div>");
    expect(rightClick(document.querySelector("span") as Element).defaultPrevented).toBe(false);
  });

  // A page can't read the browser's suggestions, so the only menu with them
  // is the browser's own.
  it("in a browser, leaves text it checks to the browser's own menu", () => {
    html('<textarea data-select="text">teh cat</textarea><input data-select="text" type="search" value="teh">');
    for (const field of document.querySelectorAll("textarea, input")) {
      expect(rightClick(field).defaultPrevented).toBe(false);
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: "teh cat",
        extensions: EditorView.contentAttributes.of({ spellcheck: "true" }),
      }),
      parent: document.body,
    });
    view.contentDOM.dataset.select = "text";
    expect(rightClick(view.contentDOM.querySelector(".cm-line") as Element).defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
    view.destroy();
  });

  it("keeps its own menu in a browser where nothing is checked", () => {
    html(
      '<input data-select="text" type="url" value="https://example.com">' +
        '<input data-select="text" readonly value="teh">' +
        '<div spellcheck="false"><textarea data-select="text">teh</textarea></div>',
    );
    for (const field of document.querySelectorAll("textarea, input")) {
      expect(rightClick(field).defaultPrevented).toBe(true);
    }
    expect(opened).toHaveLength(3);
  });

  it("lets a nearer menu take the right-click", () => {
    html('<div data-select="text"><a href="#">a link</a></div>');
    const link = document.querySelector("a") as Element;
    link.addEventListener("contextmenu", (event) => event.preventDefault());
    rightClick(link);
    expect(opened).toEqual([]);
  });

  it("offers Copy and Select All on read-only text, Copy only for a selection in it", async () => {
    html(
      '<div data-select="text" id="reading"><p>The locked door</p></div><div data-select="text" id="chat"><p>Cut it</p></div>',
    );
    const reading = document.querySelector("#reading p") as Element;
    const event = rightClick(reading);
    expect(event.defaultPrevented).toBe(true);
    expect(opened[0]).toMatchObject({ at: { x: 30, y: 40 }, ariaLabel: "Text" });
    expect(labels()).toEqual(["Copy", "Select All"]);
    expect(items().map((item) => item.group)).toEqual(["clipboard", "select"]);
    expect(unavailable()).toEqual(["Copy"]);

    select(reading.firstChild as Node, 4, 10);
    rightClick(reading);
    expect(unavailable()).toEqual([]);
    await pick("Copy");
    expect(clipboard.writeText).toHaveBeenCalledWith("locked");

    // A selection elsewhere is not this text's to copy.
    rightClick(document.querySelector("#chat p") as Element);
    expect(unavailable()).toEqual(["Copy"]);
    await pick("Select All");
    expect(window.getSelection()?.toString()).toBe("Cut it");
  });

  // Opening the text menu closes the menu the value sits in, so Select All
  // would have nothing on screen to select.
  it("offers Copy alone on a value inside a menu", async () => {
    html('<div role="menu"><div><span data-select="all">generateImage-3</span></div></div>');
    const value = document.querySelector("[data-select]") as Element;
    select(value.firstChild as Node, 0, 15);
    rightClick(value);
    expect(labels()).toEqual(["Copy"]);
    await pick("Copy");
    expect(clipboard.writeText).toHaveBeenCalledWith("generateImage-3");
  });

  it("leaves an image in readable text, and a checkbox, to the browser", () => {
    html('<div data-select="text"><img alt=""><input type="checkbox" data-select="text"></div>');
    rightClick(document.querySelector("img") as Element);
    rightClick(document.querySelector("input") as Element);
    expect(opened).toEqual([]);
  });

  // Spellcheck off: a browser keeps its own menu on a field it checks.
  it("edits a text field through the browser, so its own undo holds the edit", async () => {
    html('<input data-select="text" spellcheck="false" value="hello world">');
    const field = document.querySelector("input") as HTMLInputElement;
    field.setSelectionRange(0, 5);
    rightClick(field);
    expect(labels()).toEqual(["Cut", "Copy", "Paste", "Select All"]);
    expect(unavailable()).toEqual([]);

    await pick("Cut");
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).toHaveBeenCalledWith("delete");

    await pick("Paste");
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted");

    field.setSelectionRange(3, 3);
    rightClick(field);
    expect(unavailable()).toEqual(["Cut", "Copy"]);
    await pick("Select All");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);

    field.readOnly = true;
    rightClick(field);
    expect(labels()).toEqual(["Copy", "Select All"]);
  });

  it("edits an editor through its own state", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "one two three", selection: { anchor: 4, head: 7 } }),
      parent: document.body,
    });
    view.contentDOM.dataset.select = "text";
    const line = view.contentDOM.querySelector(".cm-line") as Element;
    rightClick(line);
    expect(labels()).toEqual(["Cut", "Copy", "Paste", "Select All"]);

    await pick("Cut");
    expect(clipboard.writeText).toHaveBeenCalledWith("two");
    expect(view.state.doc.toString()).toBe("one  three");

    await pick("Paste");
    expect(view.state.doc.toString()).toBe("one pasted three");

    rightClick(line);
    await pick("Select All");
    expect(view.state.selection.main).toMatchObject({ from: 0, to: view.state.doc.length });
    view.destroy();
  });

  it("offers a read-only editor Copy and Select All", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "INT. KITCHEN - NIGHT",
        extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      }),
      parent: document.body,
    });
    view.contentDOM.dataset.select = "text";
    rightClick(view.contentDOM.querySelector(".cm-line") as Element);
    expect(labels()).toEqual(["Copy", "Select All"]);
    view.destroy();
  });

  it("keeps the text when the clipboard refuses a Cut", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    const view = new EditorView({
      state: EditorState.create({ doc: "keep me", selection: { anchor: 0, head: 4 } }),
      parent: document.body,
    });
    view.contentDOM.dataset.select = "text";
    rightClick(view.contentDOM.querySelector(".cm-line") as Element);
    await pick("Cut");
    expect(view.state.doc.toString()).toBe("keep me");
    view.destroy();
  });
});

describe("text menu spelling, in the desktop app", () => {
  let misspelling: Misspelling | null;
  let speller: {
    misspellingAtMenu: Mock<() => Promise<Misspelling | null>>;
    replaceMisspelling: Mock<(word: string) => Promise<void>>;
    addToDictionary: Mock<(word: string) => Promise<void>>;
  };

  beforeEach(() => {
    misspelling = { word: "teh", suggestions: ["the", "tea"] };
    speller = {
      misspellingAtMenu: vi.fn(async () => misspelling),
      replaceMisspelling: vi.fn(async () => undefined),
      addToDictionary: vi.fn(async () => undefined),
    };
    window.pragmaElectron = speller as unknown as NonNullable<Window["pragmaElectron"]>;
  });

  function editor(checked: boolean): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: "teh cat",
        extensions: checked ? EditorView.contentAttributes.of({ spellcheck: "true" }) : [],
      }),
      parent: document.body,
    });
    view.contentDOM.dataset.select = "text";
    return view;
  }

  // Chromium names the word only for a right-click left uncancelled, and the
  // question must go out during the right-click to arrive before its report.
  it("asks during the right-click, leaves it uncancelled, and puts the suggestions first", async () => {
    html('<textarea data-select="text">teh cat</textarea>');
    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    const event = rightClick(field);
    expect(speller.misspellingAtMenu).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);

    await tick();
    expect(labels()).toEqual(["the", "tea", "Add to Dictionary", "Cut", "Copy", "Paste", "Select All"]);
    expect(items().map((item) => item.group)).toEqual([
      "spelling",
      "spelling",
      "dictionary",
      "clipboard",
      "clipboard",
      "clipboard",
      "select",
    ]);

    await pick("tea");
    expect(speller.replaceMisspelling).toHaveBeenCalledWith("tea");
    expect(document.activeElement).toBe(field);

    rightClick(field);
    await tick();
    await pick("Add to Dictionary");
    expect(speller.addToDictionary).toHaveBeenCalledWith("teh");
  });

  it("says so when the dictionary has no suggestion, and adds nothing for a word spelled right", async () => {
    html('<textarea data-select="text">qzxv</textarea>');
    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    misspelling = { word: "qzxv", suggestions: [] };
    rightClick(field);
    await tick();
    expect(labels()).toEqual(["No suggestions", "Add to Dictionary", "Cut", "Copy", "Paste", "Select All"]);
    expect(unavailable()).toContain("No suggestions");

    misspelling = null;
    rightClick(field);
    await tick();
    expect(labels()).toEqual(["Cut", "Copy", "Paste", "Select All"]);
  });

  it("opens the plain menu at once, without asking, where nothing is checked", () => {
    html(
      '<textarea data-select="text" spellcheck="false">teh</textarea><input data-select="text" readonly value="teh">' +
        '<input data-select="text" type="email" value="teh@example.com">',
    );
    for (const field of document.querySelectorAll("textarea, input")) {
      expect(rightClick(field).defaultPrevented).toBe(true);
    }
    expect(opened).toHaveLength(3);
    expect(speller.misspellingAtMenu).not.toHaveBeenCalled();
  });

  it("asks in an editor only while it is checked", async () => {
    const unchecked = editor(false);
    expect(rightClick(unchecked.contentDOM.querySelector(".cm-line") as Element).defaultPrevented).toBe(true);
    expect(speller.misspellingAtMenu).not.toHaveBeenCalled();

    const checked = editor(true);
    rightClick(checked.contentDOM.querySelector(".cm-line") as Element);
    expect(speller.misspellingAtMenu).toHaveBeenCalledTimes(1);
    await tick();
    expect(labels().slice(0, 3)).toEqual(["the", "tea", "Add to Dictionary"]);
    unchecked.destroy();
    checked.destroy();
  });
});
