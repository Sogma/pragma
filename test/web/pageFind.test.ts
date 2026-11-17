// @vitest-environment jsdom
import { SearchQuery } from "@codemirror/search";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finder } from "../../web/findCard.ts";
import { createPageFind, createPageFinder, selectedText } from "../../web/pageFind.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";

polyfillRangeRects();

// The browser's highlight registry, which jsdom lacks: a highlight is a set
// of ranges, the registry a map of them by name.
const registry = new Map<string, Set<AbstractRange>>();
vi.stubGlobal("Highlight", class extends Set<AbstractRange> {});
vi.stubGlobal("CSS", { highlights: registry, escape: (text: string) => text });

const marked = (name: string) => [...(registry.get(name) ?? [])].map((range) => (range as Range).toString());

const finders: Finder[] = [];
afterEach(() => {
  for (const finder of finders.splice(0)) finder.dispose();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function page(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function finderOn(root: HTMLElement, changed = vi.fn()) {
  const finder = createPageFinder({ root, values: () => [root], card: () => undefined, changed });
  finders.push(finder);
  return finder;
}

const query = (search: string, options: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) =>
  new SearchQuery({ search, ...options });

function totalOf(finder: Finder, search: string, options = {}): number {
  finder.search(query(search, options));
  return finder.count().total;
}

describe("createPageFinder", () => {
  it("reads the page as it is drawn: through inline marks, never from one block or cell into the next", () => {
    const finder = finderOn(
      page("<p>a <b>bold</b>   word</p><p>next one</p><table><tr><td>left</td><td>right</td></tr></table>"),
    );
    expect(totalOf(finder, "bold word")).toBe(1);
    expect(totalOf(finder, "word next")).toBe(0);
    expect(totalOf(finder, "left right")).toBe(0);
    expect(totalOf(finder, "left")).toBe(1);
  });

  it("keeps a <pre>'s spaces as written, and skips what is hidden", () => {
    const finder = finderOn(page('<pre>a  b</pre><p hidden>a  b</p><span aria-hidden="true">a b</span>'));
    expect(totalOf(finder, "a  b")).toBe(1);
    expect(totalOf(finder, "a b")).toBe(0);
  });

  it("reads its options as the editor's find does", () => {
    const finder = finderOn(page("<p>Flow flow flows</p>"));
    expect(totalOf(finder, "flow")).toBe(3);
    expect(totalOf(finder, "flow", { caseSensitive: true })).toBe(2);
    expect(totalOf(finder, "flow", { wholeWord: true })).toBe(2);
    expect(totalOf(finder, "fl.ws", { regexp: true })).toBe(1);
  });

  it("marks every match and the current one apart, stepping round from either end", () => {
    const finder = finderOn(page("<p>cat <em>cat</em></p><p>cat</p>"));
    finder.search(query("cat"));
    expect(finder.count()).toEqual({ total: 3, current: -1, capped: false });
    expect(marked("find-match")).toEqual(["cat", "cat", "cat"]);

    finder.fromView();
    expect(finder.count().current).toBe(0);
    expect(marked("find-current")).toEqual(["cat"]);
    expect(marked("find-match")).toHaveLength(2);

    finder.step(true);
    expect(finder.count().current).toBe(2);
    finder.step(false);
    expect(finder.count().current).toBe(0);

    finder.dispose();
    expect(marked("find-match")).toEqual([]);
    expect(marked("find-current")).toEqual([]);
  });

  it("fills a field holding a match whole, the current one apart, and reads a select by its option", () => {
    const root = page(
      '<input value="red apple"><select><option>green</option><option selected>red</option></select><input type="checkbox">',
    );
    const [text, select] = [root.querySelector("input"), root.querySelector("select")];
    const finder = finderOn(root);
    finder.search(query("red"));
    expect(finder.count().total).toBe(2);
    expect([text?.dataset.find, select?.dataset.find]).toEqual(["match", "match"]);

    finder.fromView();
    expect([text?.dataset.find, select?.dataset.find]).toEqual(["current", "match"]);
    expect(totalOf(finder, "green")).toBe(0);

    finder.dispose();
    expect(root.querySelector("[data-find]")).toBeNull();
  });

  it("searches again as the page changes, a field typed in or the markup redrawn", async () => {
    const root = page('<input value="one"><p>one</p>');
    const changed = vi.fn();
    const finder = finderOn(root, changed);
    finder.search(query("one"));
    finder.fromView();
    expect(finder.count()).toMatchObject({ total: 2, current: 0 });

    const input = root.querySelector("input");
    if (!input) throw new Error("no input");
    input.value = "two";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(finder.count()).toMatchObject({ total: 1, current: 0 });
    expect(changed).toHaveBeenCalledTimes(1);

    root.querySelector("p")?.append(" and one more");
    await Promise.resolve();
    expect(finder.count()).toMatchObject({ total: 2, current: 0 });
  });

  it("keeps the current match where it was as the query grows", () => {
    const finder = finderOn(page("<p>fl flow flo</p>"));
    finder.search(query("fl"));
    finder.fromView();
    finder.step(false);
    expect(finder.count()).toMatchObject({ total: 3, current: 1 });

    finder.search(query("flo"));
    expect(finder.count()).toMatchObject({ total: 2, current: 0 });
    expect(marked("find-current")).toEqual(["flo"]);
  });

  it("counts no further than its limit", () => {
    const finder = finderOn(page(`<p>${"a ".repeat(10_050)}</p>`));
    finder.search(query("a"));
    expect(finder.count()).toEqual({ total: 9_999, current: -1, capped: true });
  });
});

describe("selectedText", () => {
  it("takes the page's selection inside the root, on one line and at most 100 characters", () => {
    const root = page("<p>first</p><p>second</p>");
    const outside = page("<p>elsewhere</p>");
    const select = (from: Node, to: Node = from) => {
      const range = document.createRange();
      range.setStart(from, 0);
      range.setEnd(to, to.childNodes.length || (to.textContent ?? "").length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    const [first, second] = root.querySelectorAll("p");
    select(first);
    expect(selectedText(root)).toBe("first");
    select(outside.querySelector("p") as Node);
    expect(selectedText(root)).toBeUndefined();
    first.textContent = "x".repeat(101);
    select(first);
    expect(selectedText(root)).toBeUndefined();
    first.textContent = "first";
    select(first, second);
    expect(selectedText(root)).toBeUndefined();
  });

  it("takes a focused field's own selection", () => {
    const root = page('<input value="red apple">');
    const input = root.querySelector("input");
    input?.focus();
    input?.setSelectionRange(4, 9);
    expect(selectedText(root)).toBe("apple");
  });
});

describe("createPageFind", () => {
  function setup(html: string) {
    const root = page(html);
    const find = createPageFind({ root, values: (from) => [...from.querySelectorAll<HTMLElement>("td")] });
    document.body.append(find.host);
    const card = () => find.host.querySelector<HTMLElement>(".find-card:not(.is-closing)");
    function part<E extends HTMLElement = HTMLElement>(selector: string): E {
      const found = card()?.querySelector<E>(selector);
      if (!found) throw new Error(`the card has no ${selector}`);
      return found;
    }
    const field = () => part<HTMLInputElement>(".find-card-input");
    return {
      root,
      find,
      card,
      part,
      field,
      count: () => part(".find-card-count").textContent,
      type(value: string) {
        field().value = value;
        field().dispatchEvent(new Event("input"));
      },
      press(key: string, init: KeyboardEventInit = {}) {
        field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      },
    };
  }

  it("opens with Find alone, holding a focused field's selection, the first match current", () => {
    const { root, find, card, part, field, count } = setup(
      '<table><thead><tr><th>red</th></tr></thead><tbody><tr><td><input value="red apple"></td><td>red</td></tr></tbody></table>',
    );
    const input = root.querySelector("input");
    input?.focus();
    input?.setSelectionRange(0, 3);

    find.open();
    expect(find.isOpen()).toBe(true);
    expect(card()?.classList.contains("is-opening")).toBe(true);
    expect(part(".find-card-reveal").hidden).toBe(true);
    expect(
      part<HTMLInputElement>(".find-card-input:not([main-field])").closest<HTMLElement>(".find-card-field")?.hidden,
    ).toBe(true);
    expect(field().value).toBe("red");
    expect(document.activeElement).toBe(field());
    expect(count()).toBe("1 of 2");
    expect(input?.dataset.find).toBe("current");
  });

  it("steps with Enter, Shift+Enter, F3 and Ctrl+G, and turns its options on by Alt+C, W and R", () => {
    const { find, part, type, press, count } = setup("<table><tr><td>Cat</td><td>cat</td><td>cats</td></tr></table>");
    find.open();
    type("cat");
    expect(count()).toBe("1 of 3");
    press("Enter");
    expect(count()).toBe("2 of 3");
    press("Enter", { shiftKey: true });
    press("F3", { shiftKey: true });
    expect(count()).toBe("3 of 3");
    press("g", { ctrlKey: true });
    expect(count()).toBe("1 of 3");

    press("c", { altKey: true });
    expect(part(".find-card-case").getAttribute("aria-pressed")).toBe("true");
    expect(count()).toBe("1 of 2");
    press("w", { altKey: true });
    expect(count()).toBe("1 of 1");
    part(".find-card-word").click();
    press("r", { altKey: true });
    type("ca.s");
    expect(count()).toBe("1 of 1");
  });

  it("closes on Escape, giving focus back to the field it was opened from", () => {
    const { root, find, press } = setup('<table><tr><td><input value="one"></td></tr></table>');
    const input = root.querySelector("input");
    input?.focus();
    find.open();
    press("Escape");
    expect(find.isOpen()).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input?.dataset.find).toBeUndefined();
  });

  it("keeps each file's card and query apart, an open one back without sliding in or taking focus", () => {
    const { find, card, field, type } = setup("<table><tr><td>one</td></tr></table>");
    find.show("a.table.html");
    find.open();
    type("one");

    find.show("b.table.html");
    expect(find.isOpen()).toBe(false);
    expect(card()).toBeNull();
    find.open();
    expect(field().value).toBe("");
    find.close();

    (document.activeElement as HTMLElement | null)?.blur();
    find.show("a.table.html");
    expect(find.isOpen()).toBe(true);
    expect(field().value).toBe("one");
    expect(card()?.classList.contains("is-opening")).toBe(false);
    expect(card()?.contains(document.activeElement)).toBe(false);
  });
});
