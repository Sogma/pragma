// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cursorRing } from "../../../web/lib/cursorRing.ts";

beforeEach(() => {
  document.body.replaceChildren();
});

const pointerDown = (target: HTMLElement) => target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

// jsdom counts every focus as the keyboard's, so a focus here stands for a
// Tab; the browsers' own answer is checked in the running app.
describe("cursorRing", () => {
  it("shows on a keyboard focus of the list and hides on a pointer press", () => {
    const list = document.createElement("ul");
    list.tabIndex = 0;
    document.body.append(list);
    cursorRing(list);

    list.focus();
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
    pointerDown(list);
    expect(list.classList.contains("keyboard-cursor")).toBe(false);
  });

  it("counts focus on the items when they take it themselves", () => {
    const list = document.createElement("nav");
    const items = ["a", "b"].map((name) => {
      const item = document.createElement("button");
      item.textContent = name;
      return item;
    });
    list.append(...items);
    document.body.append(list);
    cursorRing(list, items);

    items[1].focus();
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
    pointerDown(items[0]);
    expect(list.classList.contains("keyboard-cursor")).toBe(false);
  });

  it("leaves showing and hiding to the list's own keys otherwise", () => {
    const list = document.createElement("ul");
    document.body.append(list);
    const ring = cursorRing(list);

    ring.show();
    expect(list.classList.contains("keyboard-cursor")).toBe(true);
    ring.hide();
    expect(list.classList.contains("keyboard-cursor")).toBe(false);
  });
});
