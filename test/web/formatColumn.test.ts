// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormatColumn } from "../../web/formatColumn.ts";
import { installTooltips } from "../../web/lib/tooltip.ts";
import type { FormatActions, FormatContext } from "../../web/services/formats.ts";
import type { Setting } from "../../web/services/settings.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";
import { memorySetting } from "./support/editorLayout.ts";
import { fakeContextMenu } from "./support/fakeContextMenu.ts";
import { testFormats } from "./support/formats.ts";

polyfillRangeRects();

const format = testFormats().get("note");
const actions = format.actions as FormatActions;
const context: FormatContext = { path: () => "a.md", openPath: vi.fn(), searchTag: vi.fn() };

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

// A note's editor with the caret at `|`, and a column for it. `room` is how
// far down the pane goes, against jsdom's column top of 0, and `extra` how
// many tools past the usual ones the column holds.
function setup(marked: string, room = 1000, extra: Setting<number> = memorySetting(0)) {
  const doc = marked.replace("|", "");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(marked.indexOf("|")),
    extensions: format.extensions(context),
  });
  ensureSyntaxTree(state, doc.length);
  const editor = new EditorView({ state, parent: document.body });
  view = editor;
  const contextMenu = fakeContextMenu();
  let sourceMode = false;
  const close = vi.fn();
  // The pane shows the title in its bar outside Source mode.
  const toTitle = vi.fn(() => !sourceMode);
  const column = createFormatColumn({
    contextMenu,
    shortcutFor: (command) => (command === "format.bold" ? "Ctrl + B" : undefined),
    sourceMode: {
      isOn: () => sourceMode,
      toggle: () => {
        sourceMode = !sourceMode;
      },
    },
    bottom: () => room,
    extra,
    close,
    toTitle,
  });
  document.body.append(column.element);
  const shown = () =>
    [...column.element.children]
      .filter((node) => !(node as HTMLElement).hidden && !node.classList.contains("format-column-handle"))
      .map((node) => (node.classList.contains("format-column-line") ? "|" : node.getAttribute("aria-label")));
  const button = (label: string) => {
    const found = column.element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  };
  const show = (slide = false) => column.show({ view: editor, actions }, slide);
  return { editor, column, contextMenu, shown, button, show, extra, close, toTitle, sourceMode: () => sourceMode };
}

// Each button showing in the column 30px tall, as jsdom lays out nothing.
function buttonHeights(element: HTMLElement): void {
  Object.defineProperty(element, "offsetHeight", {
    get: () => 30 * [...element.querySelectorAll<HTMLElement>("button")].filter((each) => !each.hidden).length,
  });
}

// A drag on the column's foot, the pointer moving to each of `ys` and let go.
function drag(element: HTMLElement, ys: number[]): void {
  const handle = element.querySelector(".format-column-handle");
  if (!handle) throw new Error("no handle");
  handle.dispatchEvent(new MouseEvent("mousedown"));
  for (const clientY of ys) document.dispatchEvent(new MouseEvent("mousemove", { clientY }));
  document.dispatchEvent(new MouseEvent("mouseup"));
}

const USUAL = [
  "Formatting",
  "|",
  "Bold",
  "Italic",
  "Code",
  "|",
  "Link",
  "|",
  "Clear formatting",
  "|",
  "Source mode",
  "|",
  "Close",
];
// The usual tools and two a drag brings in, below them.
const GROWN = [
  "Formatting",
  "|",
  "Bold",
  "Italic",
  "Code",
  "|",
  "Link",
  "|",
  "Strikethrough",
  "Highlight",
  "|",
  "Clear formatting",
  "|",
  "Source mode",
  "|",
  "Close",
];
// The usual tools less the two lowest, Clear formatting and Source mode still
// above Close.
const SHORTENED = ["Formatting", "|", "Bold", "Italic", "|", "Clear formatting", "|", "Source mode", "|", "Close"];

describe("formatColumn", () => {
  it("draws the format's usual tools in their groups, then Source mode and Close, hidden until shown", () => {
    const { column, shown, show, button } = setup("plain |text");
    expect(column.element.hidden).toBe(true);
    show();
    expect(shown()).toEqual(USUAL);
    // A note's Source mode is Markdown's mark, the glyph its format names.
    const glyph = button("Source mode").querySelector<HTMLElement>(".format-column-glyph");
    expect(glyph?.style.getPropertyValue("--format-glyph")).toBe("var(--icon-markdown-source-mode)");
    column.show(undefined, false);
    expect(column.element.hidden).toBe(true);
  });

  it("holds as many tools past the usual ones as the setting asks, below them", () => {
    const { shown, show } = setup("plain |text", 1000, memorySetting(2));
    show();
    expect(shown()).toEqual(GROWN);
  });

  it("holds every tool at most, and below the usual ones sends them back from the bottom", () => {
    const { shown, show, extra } = setup("plain |text", 1000, memorySetting(10));
    show();
    expect(shown()).toEqual([
      "Formatting",
      "|",
      "Bold",
      "Italic",
      "Code",
      "|",
      "Link",
      "|",
      "Strikethrough",
      "Highlight",
      "|",
      "Superscript",
      "Subscript",
      "|",
      "Bullet list",
      "Numbered list",
      "Task list",
      "|",
      "Quote",
      "Code block",
      "|",
      "Comment",
      "|",
      "Clear formatting",
      "|",
      "Source mode",
      "|",
      "Close",
    ]);
    extra.set(-2);
    expect(shown()).toEqual(SHORTENED);
  });

  it("keeps Clear formatting and Source mode above Close until every other tool has gone", () => {
    const { shown, show, extra } = setup("te|xt");
    show();
    extra.set(-1);
    expect(shown()).toEqual([
      "Formatting",
      "|",
      "Bold",
      "Italic",
      "Code",
      "|",
      "Clear formatting",
      "|",
      "Source mode",
      "|",
      "Close",
    ]);
    extra.set(-4);
    expect(shown()).toEqual(["Formatting", "|", "Clear formatting", "|", "Source mode", "|", "Close"]);
    // A pane too short even for them sends the lower one first.
    extra.set(-5);
    expect(shown()).toEqual(["Formatting", "|", "Clear formatting", "|", "Close"]);
  });

  it("turns itself off from Close", () => {
    const { button, show, close } = setup("plain |text", 1000, memorySetting(9));
    show();
    button("Close").click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("presses what the selection is in, and draws the picker as the caret's kind of line", () => {
    const { button, show } = setup("## A **bo|ld** word");
    show();
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
    expect(button("Italic").getAttribute("aria-pressed")).toBe("false");
    const glyph = button("Formatting").querySelector<HTMLElement>(".format-column-glyph");
    expect(glyph?.style.getPropertyValue("--format-glyph")).toBe("var(--icon-heading-2)");
  });

  it("applies a button's action to the text and redraws on update", () => {
    const { editor, column, button, show } = setup("one tw|o");
    show();
    button("Bold").click();
    expect(editor.state.doc.toString()).toBe("one **two**");
    column.update();
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles the group's Source mode from its own button, pressed while it is on", () => {
    const { column, button, show, sourceMode } = setup("te|xt");
    show();
    button("Source mode").click();
    expect(sourceMode()).toBe(true);
    column.update();
    expect(button("Source mode").getAttribute("aria-pressed")).toBe("true");
  });

  it("names a button's key in its tooltip where one runs it, every tooltip beside its button", () => {
    const { column, button, show } = setup("te|xt");
    show();
    expect(button("Bold").dataset.tooltip).toBe("Bold (Ctrl + B)");
    expect(button("Italic").dataset.tooltip).toBeUndefined();
    const sides = [...column.element.querySelectorAll<HTMLElement>("button")].map((each) => each.dataset.tooltipSide);
    expect(new Set(sides)).toEqual(new Set(["left"]));
  });

  it("opens its picker's menu beside the column, every kind and then every tool in the column's order", () => {
    const { editor, contextMenu, button, show } = setup("- it|em");
    show();
    button("Formatting").click();
    expect(contextMenu.opened[0]).toMatchObject({ beside: true, picker: true });
    expect(contextMenu.labels()).toEqual([
      ...actions.lines.map((line) => line.label),
      "Bold",
      "Italic",
      "Code",
      "Link",
      "Strikethrough",
      "Highlight",
      "Superscript",
      "Subscript",
      "Comment",
      "Clear formatting",
    ]);
    const row = (label: string) => contextMenu.rows().find((each) => each.label === label);
    expect(row("Bullet list")?.checked?.({ tab: { kind: "empty" }, pane: undefined }, undefined)).toBe(true);
    // A mark is on or off by itself, where the kinds are one choice.
    expect(row("Bold")?.toggle).toBe(true);
    expect(row("Bullet list")?.toggle).toBeUndefined();
    contextMenu.pick("Bold");
    expect(editor.state.doc.toString()).toBe("- **item**");
  });

  it("leaves a line alone when the picker's current kind is picked, and turns it into another", () => {
    const { editor, contextMenu, button, show } = setup("## Ti|tle");
    show();
    button("Formatting").click();
    contextMenu.pick("Heading 2");
    expect(editor.state.doc.toString()).toBe("## Title");
    button("Formatting").click();
    contextMenu.pick("Text");
    expect(editor.state.doc.toString()).toBe("Title");
  });

  it("sends Heading 1 to the title where the pane shows one, leaving the line, and writes it in Source mode", () => {
    const { editor, contextMenu, button, show, toTitle } = setup("a li|ne");
    show();
    button("Formatting").click();
    contextMenu.pick("Heading 1");
    expect(toTitle).toHaveBeenCalledTimes(1);
    expect(editor.state.doc.toString()).toBe("a line");
    button("Source mode").click();
    button("Formatting").click();
    contextMenu.pick("Heading 1");
    expect(editor.state.doc.toString()).toBe("# a line");
  });

  it("sends buttons out from the bottom while the pane is too short for them, its picker's menu still holding them", () => {
    // Room for six buttons of the column's eight.
    const { column, contextMenu, shown, button, show } = setup("te|xt", 16 + 180);
    buttonHeights(column.element);
    show();
    expect(shown()).toEqual(SHORTENED);
    button("Formatting").click();
    expect(contextMenu.labels()).toEqual(expect.arrayContaining(["Code", "Link"]));
  });

  it("brings a tool in as a drag on its foot passes half its height, and keeps the count", () => {
    const { column, shown, show, extra } = setup("te|xt");
    buttonHeights(column.element);
    show();
    // Six tools, the picker and Close: 240px, the next step 270px.
    drag(column.element, [254]);
    expect(shown()).toEqual(USUAL);
    expect(extra.get()).toBe(0);
    drag(column.element, [256, 300]);
    expect(shown()).toEqual(GROWN);
    expect(extra.get()).toBe(2);
  });

  it("sends tools back on a drag up, the last in first, then the usual ones from the bottom", () => {
    const { column, shown, show, extra } = setup("te|xt", 1000, memorySetting(1));
    buttonHeights(column.element);
    show();
    expect(shown()).toContain("Strikethrough");
    drag(column.element, [180]);
    expect(shown()).toEqual(SHORTENED);
    expect(extra.get()).toBe(-2);
  });

  it("stops a drag where the pane runs out of room", () => {
    // Room for the picker, seven tools and Close.
    const { column, shown, show, extra } = setup("te|xt", 16 + 270);
    buttonHeights(column.element);
    show();
    drag(column.element, [600]);
    expect(shown()).toContain("Strikethrough");
    expect(shown()).not.toContain("Highlight");
    expect(extra.get()).toBe(1);
  });

  it("follows a count another group's drag left", () => {
    const { shown, show, extra } = setup("te|xt");
    show();
    extra.set(1);
    expect(shown()).toContain("Strikethrough");
  });

  it("names each tool a drag brings in, until the drag ends", () => {
    const tips = installTooltips();
    try {
      const { column, show } = setup("te|xt");
      buttonHeights(column.element);
      show();
      const tip = document.getElementById("tooltip") as HTMLElement;
      const handle = column.element.querySelector(".format-column-handle") as HTMLElement;
      handle.dispatchEvent(new MouseEvent("mousedown"));
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 270 }));
      expect(tip.hidden).toBe(false);
      expect(tip.textContent).toBe("Strikethrough");
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 300 }));
      expect(tip.textContent).toBe("Highlight");
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(tip.hidden).toBe(true);
    } finally {
      tips.dispose();
    }
  });

  it("slides in when shown by a toggle, and out when hidden by one", () => {
    const { column, show } = setup("te|xt");
    show(true);
    expect(column.element.classList.contains("is-opening")).toBe(true);
    // jsdom runs no animation, so the slide out ends at once.
    column.show(undefined, true);
    expect(column.element.hidden).toBe(true);
    show(false);
    expect(column.element.hidden).toBe(false);
    expect(column.element.classList.contains("is-opening")).toBe(false);
  });
});

describe("formatColumn on a screenplay", () => {
  const script = testFormats().get("screenplay");
  const scriptActions = script.actions as FormatActions;
  const nowhere = { tab: { kind: "empty" as const }, pane: undefined };

  // A screenplay's editor with the caret at `|`, and a column for it.
  function scriptColumn(marked: string, extra = memorySetting(0)) {
    const doc = marked.replace("|", "");
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(marked.indexOf("|")),
      extensions: script.extensions({ ...context, path: () => "scene.fountain" }),
    });
    ensureSyntaxTree(state, doc.length);
    const editor = new EditorView({ state, parent: document.body });
    view = editor;
    const contextMenu = fakeContextMenu();
    const column = createFormatColumn({
      contextMenu,
      shortcutFor: () => undefined,
      sourceMode: { isOn: () => false, toggle: vi.fn() },
      bottom: () => 1000,
      extra,
      close: vi.fn(),
      toTitle: () => false,
    });
    document.body.append(column.element);
    column.show({ view: editor, actions: scriptActions }, false);
    const shown = () =>
      [...column.element.children]
        .filter((node) => !(node as HTMLElement).hidden && !node.classList.contains("format-column-handle"))
        .map((node) => (node.classList.contains("format-column-line") ? "|" : node.getAttribute("aria-label")));
    const button = (label: string) => {
      const found = column.element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      if (!found) throw new Error(`no ${label} button`);
      return found;
    };
    return { column, contextMenu, shown, button };
  }

  it("holds style, then what never prints, and ends in Clear formatting and Source mode above Close", () => {
    const { shown, button } = scriptColumn("Snow fa|lls.");
    const glyph = button("Source mode").querySelector<HTMLElement>(".format-column-glyph");
    expect(glyph?.style.getPropertyValue("--format-glyph")).toBe("var(--icon-source-mode)");
    expect(shown()).toEqual([
      "Formatting",
      "|",
      "Bold",
      "Italic",
      "Underline",
      "Centered",
      "|",
      "Synopsis",
      "Script note",
      "|",
      "Clear formatting",
      "|",
      "Source mode",
      "|",
      "Close",
    ]);
  });

  it("lists its kinds, then its tools in the column's order, and brings the kinds in as buttons after Script note", () => {
    const extra = memorySetting(0);
    const { shown, button, contextMenu } = scriptColumn("Snow fa|lls.", extra);
    button("Formatting").click();
    expect(contextMenu.labels()).toEqual([
      "Scene heading",
      "Action",
      "Character",
      "Transition",
      "Bold",
      "Italic",
      "Underline",
      "Centered",
      "Synopsis",
      "Script note",
      "Clear formatting",
    ]);
    extra.set(4);
    expect(shown()).toEqual([
      "Formatting",
      "|",
      "Bold",
      "Italic",
      "Underline",
      "Centered",
      "|",
      "Synopsis",
      "Script note",
      "|",
      "Scene heading",
      "Action",
      "Character",
      "Transition",
      "|",
      "Clear formatting",
      "|",
      "Source mode",
      "|",
      "Close",
    ]);
  });

  it("sends Note, then Synopsis, out as it shrinks, keeping Clear formatting and Source mode", () => {
    const extra = memorySetting(0);
    const { shown } = scriptColumn("Snow fa|lls.", extra);
    extra.set(-2);
    expect(shown()).toEqual([
      "Formatting",
      "|",
      "Bold",
      "Italic",
      "Underline",
      "Centered",
      "|",
      "Clear formatting",
      "|",
      "Source mode",
      "|",
      "Close",
    ]);
  });

  it("lists the kinds typing doesn't make, its glyph still showing a speech's", () => {
    const kinds = ["Scene heading", "Action", "Character", "Transition"];
    const inSpeech = scriptColumn("\nMARA\nHel|lo?");
    const glyph = inSpeech.button("Formatting").querySelector<HTMLElement>(".format-column-glyph");
    expect(glyph?.style.getPropertyValue("--format-glyph")).toBe("var(--icon-message-circle)");
    inSpeech.button("Formatting").click();
    expect(inSpeech.contextMenu.labels().slice(0, 4)).toEqual(kinds);
    expect(inSpeech.contextMenu.labels()).not.toContain("Dialogue");
    expect(inSpeech.contextMenu.labels()).not.toContain("Parenthetical");

    const outside = scriptColumn("\nSnow fa|lls.");
    outside.button("Formatting").click();
    expect(outside.contextMenu.labels().slice(0, 4)).toEqual(kinds);
    const action = outside.contextMenu.rows().find((row) => row.label === "Action");
    expect(action?.checked?.(nowhere, undefined)).toBe(true);
  });

  it("greys its tools and its picker on a line they can't change", () => {
    const { button } = scriptColumn("/* cut| this */");
    expect(button("Bold").disabled).toBe(true);
    expect(button("Script note").disabled).toBe(true);
    expect(button("Formatting").disabled).toBe(true);
    expect(button("Source mode").disabled).toBe(false);
  });
});
