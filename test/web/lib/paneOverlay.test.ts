// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaneOverlay, type PaneOverlayDeps, swallowRest } from "../../../web/lib/paneOverlay.ts";

afterEach(() => document.body.replaceChildren());

// Five items, the third of which has nothing to show; each is drawn as its
// index, so a test reads which one the stage holds.
function overlay(overrides: Partial<PaneOverlayDeps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const deps = {
    host,
    stem: "thing",
    count: () => 5,
    showable: (index: number) => index !== 2,
    render: vi.fn((index: number) => Object.assign(document.createElement("div"), { textContent: String(index) })),
    release: vi.fn(),
    shown: vi.fn(),
    closing: vi.fn(),
    refocus: vi.fn(),
    ...overrides,
  };
  return { host, deps, overlay: createPaneOverlay(deps) };
}

describe("createPaneOverlay", () => {
  it("lies hidden in the pane's box, its classes the overlay's own beside the caller's", () => {
    const { host, overlay: shown } = overlay();
    expect(shown.element.parentElement).toBe(host);
    expect(shown.element.hidden).toBe(true);
    expect(shown.element.className).toBe("pane-overlay thing");
    expect(shown.stage.className).toBe("pane-overlay-stage thing-stage");
    expect(shown.prev.className).toBe("pane-overlay-nav thing-nav is-prev");
    expect(shown.next.className).toBe("pane-overlay-nav thing-nav is-next");
    expect([shown.prev.tabIndex, shown.next.tabIndex]).toEqual([-1, -1]);
  });

  it("shows an item on its stage, and marks an arrow with nothing past it", () => {
    const { deps, overlay: shown } = overlay();
    shown.show(0);
    expect(shown.element.hidden).toBe(false);
    expect(shown.stage.textContent).toBe("0");
    expect(shown.shownIndex()).toBe(0);
    expect(deps.shown).toHaveBeenCalledWith(0);
    expect(shown.prev.getAttribute("aria-disabled")).toBe("true");
    expect(shown.next.getAttribute("aria-disabled")).toBe("false");
  });

  it("shows nothing for an item with nothing to show", () => {
    const { deps, overlay: shown } = overlay();
    shown.show(2);
    expect(shown.element.hidden).toBe(true);
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("steps past an item with nothing to show, letting the last go first, from its arrows too", () => {
    const { deps, overlay: shown } = overlay();
    shown.show(1);
    shown.step(1);
    expect(shown.stage.textContent).toBe("3");
    expect(deps.release).toHaveBeenCalledTimes(2);
    shown.prev.click();
    expect(shown.stage.textContent).toBe("1");
    shown.next.click();
    shown.next.click();
    expect(shown.stage.textContent).toBe("4");
    expect(shown.next.getAttribute("aria-disabled")).toBe("true");
    shown.step(1);
    expect(shown.stage.textContent).toBe("4");
  });

  it("closes: lets the item go, hides, and puts focus back only when asked", () => {
    const { deps, overlay: shown } = overlay();
    shown.show(0);
    shown.close();
    expect(shown.shownIndex()).toBeUndefined();
    expect(shown.element.hidden).toBe(true);
    expect(shown.stage.childElementCount).toBe(0);
    expect(deps.closing).toHaveBeenCalledTimes(1);
    expect(deps.refocus).toHaveBeenCalledTimes(1);

    shown.show(0);
    shown.close(false);
    expect(deps.refocus).toHaveBeenCalledTimes(1);
    shown.close();
    expect(deps.closing).toHaveBeenCalledTimes(2);
  });

  it("takes a new place for its item when the list changes under it, without drawing it again", () => {
    const { deps, overlay: shown } = overlay();
    shown.show(3);
    shown.moved(4);
    expect(shown.shownIndex()).toBe(4);
    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(shown.next.getAttribute("aria-disabled")).toBe("true");
    shown.step(-1);
    expect(shown.stage.textContent).toBe("3");
  });

  it("leaves the pane's box once disposed, with nothing to put focus back on", () => {
    const { host, deps, overlay: shown } = overlay();
    shown.show(0);
    shown.dispose();
    expect(host.childElementCount).toBe(0);
    expect(deps.release).toHaveBeenCalled();
    expect(deps.refocus).not.toHaveBeenCalled();
  });
});

describe("swallowRest", () => {
  it("takes the rest of a click run, and nothing once a press starts another", () => {
    const button = document.createElement("button");
    const pressed = vi.fn();
    button.addEventListener("click", pressed);
    document.body.append(button);

    swallowRest();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(pressed).not.toHaveBeenCalled();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(pressed).toHaveBeenCalledTimes(2);
  });
});
