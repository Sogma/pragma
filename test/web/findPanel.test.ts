// @vitest-environment jsdom
import { getSearchQuery, openSearchPanel, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { FIND_KEYMAP, findOnPage, findPanel } from "../../web/findPanel.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";

polyfillRangeRects();

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function setup(
  doc: string,
  options: { readOnly?: boolean; selection?: { anchor: number; head?: number }; page?: HTMLElement } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  // In the order a document's keymap has them: the card's own keys first.
  const extensions: Extension[] = [
    findPanel(host),
    keymap.of([...FIND_KEYMAP, ...searchKeymap]),
    EditorState.readOnly.of(options.readOnly ?? false),
    options.page ? findOnPage.of(options.page) : [],
  ];
  const view = new EditorView({
    state: EditorState.create({ doc, extensions, selection: options.selection }),
    parent: document.body,
  });
  views.push(view);
  const card = () => host.querySelector<HTMLElement>(".find-card:not(.is-closing)");
  function part<E extends HTMLElement = HTMLElement>(selector: string): E {
    const found = card()?.querySelector<E>(selector);
    if (!found) throw new Error(`the card has no ${selector}`);
    return found;
  }
  const inputs = () => [...(card()?.querySelectorAll<HTMLInputElement>(".find-card-input") ?? [])];
  return {
    view,
    host,
    extensions,
    card,
    part,
    find: () => inputs()[0],
    replace: () => inputs()[1],
    count: () => part(".find-card-count").textContent,
    selection: () => {
      const { from, to } = view.state.selection.main;
      return { from, to };
    },
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

describe("findPanel", () => {
  it("draws its card in the host, not across the editor, and seeds Find from the selection", () => {
    const { view, host, card, find, count } = setup("Flow and flow and FLOW", { selection: { anchor: 0, head: 4 } });
    openSearchPanel(view);

    expect(host.contains(card())).toBe(true);
    expect(view.dom.querySelector(".find-card")).toBeNull();
    expect(find().value).toBe("Flow");
    expect(document.activeElement).toBe(find());
    expect(count()).toBe("1 of 3");
  });

  it("selects the nearest match from the selection on as Find changes, wrapping past the end", () => {
    const { view, find, count, selection } = setup("one two one two", { selection: { anchor: 5 } });
    openSearchPanel(view);

    type(find(), "one");
    expect(selection()).toEqual({ from: 8, to: 11 });
    expect(count()).toBe("2 of 2");

    type(find(), "two");
    expect(selection()).toEqual({ from: 12, to: 15 });

    type(find(), "one");
    expect(selection()).toEqual({ from: 0, to: 3 });
    expect(count()).toBe("1 of 2");

    view.dispatch({ selection: { anchor: 5 } });
    expect(count()).toBe("? of 2");
  });

  it("steps with Enter and Shift+Enter, leaving the caret where it was in Find", () => {
    const { view, find, count } = setup("a1 a2 a3");
    openSearchPanel(view);
    type(find(), "a");
    expect(count()).toBe("1 of 3");

    find().setSelectionRange(1, 1);
    press(find(), "Enter");
    expect(count()).toBe("2 of 3");
    expect([find().selectionStart, find().selectionEnd]).toEqual([1, 1]);

    press(find(), "Enter", { shiftKey: true });
    press(find(), "Enter", { shiftKey: true });
    expect(count()).toBe("3 of 3");
  });

  it("turns the options on by a click or by Alt+C, W and R, and marks them pressed", () => {
    const { view, part, find, count, selection } = setup("Flow flow");
    openSearchPanel(view);
    type(find(), "flow");
    expect(count()).toBe("1 of 2");

    part(".find-card-case").click();
    expect(part(".find-card-case").getAttribute("aria-pressed")).toBe("true");
    expect(selection()).toEqual({ from: 5, to: 9 });
    expect(count()).toBe("1 of 1");

    press(find(), "c", { altKey: true });
    press(find(), "w", { altKey: true });
    press(find(), "r", { altKey: true });
    expect(getSearchQuery(view.state)).toMatchObject({ caseSensitive: false, wholeWord: true, regexp: true });
    expect(part(".find-card-case").getAttribute("aria-pressed")).toBe("false");
    expect(part(".find-card-regex").getAttribute("aria-pressed")).toBe("true");
  });

  it("says when nothing matches, in red, and when the pattern can't be read", () => {
    const { view, part, find, count } = setup("cat");
    openSearchPanel(view);
    expect(count()).toBe("No matches");
    expect(part(".find-card-count").classList.contains("is-missing")).toBe(false);

    type(find(), "dog");
    expect(count()).toBe("No matches");
    expect(part(".find-card-count").classList.contains("is-missing")).toBe(true);
    expect(part<HTMLButtonElement>(".find-card-next").disabled).toBe(true);

    press(find(), "r", { altKey: true });
    type(find(), "(");
    expect(count()).toBe("Invalid pattern");
  });

  it("counts no further than its limit", () => {
    const { view, find, count } = setup("a".repeat(10_050));
    openSearchPanel(view);
    type(find(), "a");
    expect(count()).toBe("1 of 9999+");
  });

  it("shows Replace from the chevron, and replaces the current match or every one", () => {
    const { view, part, find, replace, count } = setup("cat cat cat");
    openSearchPanel(view);
    expect(replace().closest<HTMLElement>(".find-card-field")?.hidden).toBe(true);

    part(".find-card-reveal").click();
    expect(part(".find-card-reveal").getAttribute("aria-expanded")).toBe("true");
    expect(replace().closest<HTMLElement>(".find-card-field")?.hidden).toBe(false);
    expect(document.activeElement).toBe(replace());

    type(find(), "cat");
    type(replace(), "dog");
    press(replace(), "Enter");
    expect(view.state.doc.toString()).toBe("dog cat cat");
    expect(count()).toBe("1 of 2");

    part(".find-card-replace-all").click();
    expect(view.state.doc.toString()).toBe("dog dog dog");
    expect(count()).toBe("No matches");
  });

  it("opens with Replace showing from Ctrl+H in the text, Replace focused once Find has text", () => {
    const { view, part, find, replace } = setup("cat cat", { selection: { anchor: 0, head: 3 } });
    press(view.contentDOM, "h", { ctrlKey: true });

    expect(searchPanelOpen(view.state)).toBe(true);
    expect(find().value).toBe("cat");
    expect(part(".find-card-reveal").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(replace());
  });

  it("offers no Replace in a read-only editor, from the chevron or from Ctrl+H", () => {
    const { view, part, replace } = setup("cat", { readOnly: true });
    press(view.contentDOM, "h", { ctrlKey: true });

    expect(searchPanelOpen(view.state)).toBe(true);
    expect(part(".find-card-reveal").hidden).toBe(true);
    expect(replace().closest<HTMLElement>(".find-card-field")?.hidden).toBe(true);
  });

  it("names each control's key in its tooltip", () => {
    const { view, part } = setup("cat");
    openSearchPanel(view);
    expect(part(".find-card-case").dataset.tooltip).toBe("Match case (Alt + C)");
    expect(part(".find-card-previous").dataset.tooltip).toBe("Previous match (Shift + Enter)");
    expect(part(".find-card-reveal").dataset.tooltip).toBe("Show replace (Ctrl + H)");
    expect(part(".find-card-replace-all").dataset.tooltip).toBe("Replace all (Ctrl + Alt + Enter)");
  });

  it("closes on Escape, the card sliding away inert, and a reopening takes its place at once", () => {
    // jsdom runs no animations, so a card waits on one only with this.
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [{}] });
    try {
      const { view, host, find } = setup("cat");
      openSearchPanel(view);
      press(find(), "Escape");

      expect(searchPanelOpen(view.state)).toBe(false);
      const leaving = host.querySelector<HTMLElement>(".find-card.is-closing");
      expect(leaving?.inert).toBe(true);

      openSearchPanel(view);
      expect(host.querySelectorAll(".find-card")).toHaveLength(1);
      expect(host.querySelector(".find-card")?.classList.contains("is-opening")).toBe(true);
    } finally {
      Reflect.deleteProperty(Element.prototype, "getAnimations");
    }
  });

  it("takes the card at once where nothing animates", () => {
    const { view, host, find } = setup("cat");
    openSearchPanel(view);
    press(find(), "Escape");
    expect(host.querySelector(".find-card")).toBeNull();
  });

  it("searches a page shown in the editor's place by the same keys, the editor's selection left alone", () => {
    const page = document.createElement("div");
    page.innerHTML = "<p>one cat</p><p>two <b>cat</b></p><p>cat three</p>";
    document.body.append(page);
    const { view, find, count, selection } = setup("cat", { page, readOnly: true });
    openSearchPanel(view);
    type(find(), "cat");
    expect(count()).toBe("1 of 3");

    press(find(), "F3");
    expect(count()).toBe("2 of 3");
    press(find(), "F3", { shiftKey: true });
    press(find(), "F3", { shiftKey: true });
    expect(count()).toBe("3 of 3");
    press(find(), "g", { ctrlKey: true });
    expect(count()).toBe("1 of 3");

    press(find(), "Enter", { altKey: true });
    expect(selection()).toEqual({ from: 0, to: 0 });
    find().setSelectionRange(1, 1);
    press(find(), "f", { ctrlKey: true });
    expect([find().selectionStart, find().selectionEnd]).toEqual([0, 3]);
    expect(document.activeElement).toBe(find());
  });

  it("brings back a state with the card open without sliding it in or taking focus", () => {
    const { view, host, extensions, card } = setup("cat");
    openSearchPanel(view);
    const withCard = view.state;
    view.setState(EditorState.create({ doc: "dog", extensions }));
    expect(host.querySelector(".find-card")).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();

    view.setState(withCard);
    expect(card()?.classList.contains("is-opening")).toBe(false);
    expect(card()?.contains(document.activeElement)).toBe(false);
  });
});
