// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Disposable } from "../../../web/lib/disposable.ts";
import { installTooltips, TOOLTIP_DELAY_MS } from "../../../web/lib/tooltip.ts";

let installed: Disposable;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  document.body.replaceChildren();
  installed = installTooltips();
});

afterEach(() => {
  installed.dispose();
  vi.useRealTimers();
});

function hinted(text: string): HTMLElement {
  const el = document.createElement("button");
  el.dataset.tooltip = text;
  document.body.append(el);
  return el;
}

function over(el: Element, init: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", ...init }));
}

function shown(): string | null {
  const tip = document.querySelector<HTMLElement>(".tooltip");
  return tip && !tip.hidden ? tip.textContent : null;
}

function cutOff(el: HTMLElement, cut: boolean): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: cut ? 200 : 100 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
}

describe("installTooltips", () => {
  it("shows an element's data-tooltip after the hover delay, not before", () => {
    over(hinted("Flow"));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(shown()).toBe("Flow");
  });

  it("skips the delay while one is showing and just after it closes, not later", () => {
    const [a, b, c, d] = ["A", "B", "C", "D"].map(hinted);
    const plain = document.createElement("div");
    document.body.append(plain);

    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    over(b);
    expect(shown()).toBe("B");

    over(plain);
    expect(shown()).toBeNull();
    over(c);
    expect(shown()).toBe("C");

    over(plain);
    vi.advanceTimersByTime(1000);
    over(d);
    expect(shown()).toBeNull();
  });

  it("fades in after the delay, and appears without a fade when it follows another closely", () => {
    const [a, b] = ["A", "B"].map(hinted);
    const plain = document.createElement("div");
    document.body.append(plain);
    const instant = () => document.querySelector(".tooltip")?.classList.contains("is-instant");

    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(instant()).toBe(false);

    over(plain);
    over(b);
    expect(shown()).toBe("B");
    expect(instant()).toBe(true);
  });

  it("waits the delay for each hint in a data-tooltip-wait list, while one outside still follows on", () => {
    const list = document.createElement("ul");
    list.dataset.tooltipWait = "";
    document.body.append(list);
    const [a, b] = ["A", "B"].map((text) => {
      const row = document.createElement("li");
      row.dataset.tooltip = text;
      list.append(row);
      return row;
    });
    const icon = hinted("C");

    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    over(b);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("B");

    over(icon);
    expect(shown()).toBe("C");
  });

  it("shows an overflow element's text only while it is cut off, else the hint around it", () => {
    const row = hinted("Site: Blog");
    const name = document.createElement("span");
    name.dataset.tooltipOverflow = "";
    name.textContent = "a-very-long-site-folder";
    row.append(name);

    cutOff(name, false);
    over(name);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("Site: Blog");

    over(document.body);
    vi.advanceTimersByTime(1000);
    cutOff(name, true);
    over(name);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("a-very-long-site-folder");
  });

  it("shows a cut-off field's value, but not while it is being typed in", () => {
    const field = document.createElement("textarea");
    field.dataset.tooltipOverflow = "";
    field.value = "A song about leaving the city at night";
    document.body.append(field);
    cutOff(field, true);

    over(field);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("A song about leaving the city at night");

    over(document.body);
    vi.advanceTimersByTime(1000);
    field.focus();
    over(field);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
  });

  it("closes on a click and stays closed over that element until the pointer moves to another", () => {
    const [a, b] = ["A", "B"].map(hinted);
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(shown()).toBeNull();

    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();

    over(b);
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("A");
  });

  it("ignores touch, and a hover with a button held", () => {
    const a = hinted("A");
    over(a, { pointerType: "touch" });
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
    over(a, { buttons: 1 });
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
  });

  it("follows a change to its element's text, and closes when the element is removed", async () => {
    const a = hinted("Saving…");
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    a.dataset.tooltip = "Saved";
    await Promise.resolve();
    expect(shown()).toBe("Saved");

    a.remove();
    await Promise.resolve();
    expect(shown()).toBeNull();
  });

  it("describes its element while showing, leaving an existing description alone", () => {
    const [a, b] = ["A", "B"].map(hinted);
    b.setAttribute("aria-describedby", "help");

    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(a.getAttribute("aria-describedby")).toBe("tooltip");
    over(b);
    expect(a.hasAttribute("aria-describedby")).toBe(false);
    expect(b.getAttribute("aria-describedby")).toBe("help");
  });

  it("shows an icon button's accessible name, unless a data-tooltip says otherwise", () => {
    const named = document.createElement("button");
    named.className = "icon-button";
    named.setAttribute("aria-label", "Clear Console");
    const overridden = named.cloneNode() as HTMLElement;
    overridden.dataset.tooltip = "Reset to default";
    const plain = document.createElement("button");
    plain.setAttribute("aria-label", "Console");
    document.body.append(named, overridden, plain);

    over(named);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBe("Clear Console");
    over(overridden);
    expect(shown()).toBe("Reset to default");
    over(plain);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shown()).toBeNull();
  });

  it("follows a change to an icon button's name, and doesn't describe it with its own name", async () => {
    const button = document.createElement("button");
    button.className = "icon-button";
    button.setAttribute("aria-label", "Switch to reading view");
    document.body.append(button);

    over(button);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    button.setAttribute("aria-label", "Switch to editing");
    await Promise.resolve();
    expect(shown()).toBe("Switch to editing");
  });

  it("shows at once on keyboard focus, and not for a click's focus", () => {
    const a = hinted("A");
    // jsdom matches :focus-visible on every focus, so each case sets it.
    let keyboard = false;
    vi.spyOn(a, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? keyboard : Element.prototype.matches.call(a, selector),
    );
    a.focus();
    expect(shown()).toBeNull();
    a.blur();

    keyboard = true;
    a.focus();
    expect(shown()).toBe("A");
    a.blur();
    expect(shown()).toBeNull();
  });

  it("sits below its element, above where it would leave the window, inside the side edges", () => {
    const a = hinted("A");
    const tip = document.querySelector<HTMLElement>(".tooltip");
    if (!tip) throw new Error("no tooltip element");
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 100 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 20 });

    a.getBoundingClientRect = () => new DOMRect(0, 100, 20, 20);
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect([tip.style.left, tip.style.top]).toEqual(["8px", "126px"]);

    over(document.body);
    a.getBoundingClientRect = () => new DOMRect(500, window.innerHeight - 20, 20, 20);
    over(a);
    expect([tip.style.left, tip.style.top]).toEqual(["460px", `${window.innerHeight - 46}px`]);
  });

  it("sits beside an element that asks for the side, and below it where the side has no room", () => {
    const a = hinted("Search");
    a.dataset.tooltipSide = "right";
    const tip = document.querySelector<HTMLElement>(".tooltip");
    if (!tip) throw new Error("no tooltip element");
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 100 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 20 });

    a.getBoundingClientRect = () => new DOMRect(0, 100, 40, 40);
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect([tip.style.left, tip.style.top]).toEqual(["46px", "110px"]);

    over(document.body);
    a.getBoundingClientRect = () => new DOMRect(window.innerWidth - 40, 100, 40, 40);
    over(a);
    expect([tip.style.left, tip.style.top]).toEqual([`${window.innerWidth - 108}px`, "146px"]);
  });

  it("sits on the left of an element that asks for that side, and below it where the left has no room", () => {
    const a = hinted("Bold");
    a.dataset.tooltipSide = "left";
    const tip = document.querySelector<HTMLElement>(".tooltip");
    if (!tip) throw new Error("no tooltip element");
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 100 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 20 });

    a.getBoundingClientRect = () => new DOMRect(500, 100, 28, 28);
    over(a);
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect([tip.style.left, tip.style.top]).toEqual(["394px", "104px"]);

    over(document.body);
    a.getBoundingClientRect = () => new DOMRect(50, 100, 28, 28);
    over(a);
    expect([tip.style.left, tip.style.top]).toEqual(["14px", "134px"]);
  });
});
