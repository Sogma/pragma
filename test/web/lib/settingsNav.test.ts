// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { must } from "../../../web/lib/dom.ts";
import { settingsNav } from "../../../web/lib/settingsNav.ts";

function navOf(categories: string[]) {
  document.body.innerHTML = `<nav class="settings-nav">${categories
    .map(
      (category) =>
        `<button type="button" class="settings-nav-item" data-settings-category="${category}">${category}</button>`,
    )
    .join("")}</nav>`;
  const element = must<HTMLElement>(".settings-nav");
  const show = vi.fn();
  const nav = settingsNav(element, show);
  const item = (category: string) => nav.item(category) as HTMLButtonElement;
  const ringed = () => element.classList.contains("keyboard-cursor");
  return { element, show, nav, item, ringed };
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe("settingsNav", () => {
  it("moves focus with ↑ and ↓, stops at either end, and shows nothing", () => {
    const { item, show } = navOf(["general", "editor", "models"]);
    item("general").focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(item("editor"));
    press("ArrowDown");
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item("models"));
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement).toBe(item("general"));
    expect(show).not.toHaveBeenCalled();
  });

  it("shows an item's category on its click, which Enter and Space send", () => {
    const { item, show } = navOf(["general", "editor"]);
    item("editor").click();
    expect(show).toHaveBeenCalledWith("editor");
  });

  it("rings the focused item from an arrow key until a category shows or a pointer presses", () => {
    const { element, item, ringed } = navOf(["general", "editor"]);
    item("general").focus();
    item("general").click();
    expect(ringed()).toBe(false);

    press("ArrowDown");
    expect(ringed()).toBe(true);
    item("editor").click();
    expect(ringed()).toBe(false);

    press("ArrowUp");
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(ringed()).toBe(false);
  });

  it("leaves a modified arrow to the app's shortcuts", () => {
    const { item } = navOf(["general", "editor"]);
    item("general").focus();
    expect(press("ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
    expect(press("ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(item("general"));
  });

  it("marks only the category showing", () => {
    const { nav, item } = navOf(["general", "editor", "models"]);
    nav.select("editor");
    nav.select("models");
    expect(item("general").classList.contains("active")).toBe(false);
    expect(item("editor").classList.contains("active")).toBe(false);
    expect(item("models").classList.contains("active")).toBe(true);
  });
});
