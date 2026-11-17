// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTabDrag, type TabDragStrip } from "../../../web/view/tabDrag.ts";
import { asStyled } from "../support/styled.ts";

// jsdom lays nothing out, so the row is laid out here: every pill and gap in
// a strip is 100px wide, in DOM order; strip A spans 0..300 and strip B
// 300..600 of a 600px host, 40px tall, whose drag layer starts 6px down.
const STRIP_WIDTH = 300;
const ITEM_WIDTH = 100;
const original = Element.prototype.getBoundingClientRect;
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
}
function layout(this: Element): DOMRect {
  if (this.classList.contains("editor-tab-drag-layer")) return rect(0, 6, 2 * STRIP_WIDTH, 34);
  if (this.classList.contains("editor-group-tabs")) return rect(stripIndex(this) * STRIP_WIDTH, 0, STRIP_WIDTH, 40);
  const strip = this.parentElement;
  if (strip?.classList.contains("editor-group-tabs") && this.matches(".editor-tab, .editor-tab-gap")) {
    const items = [...strip.children].filter((child) => child.matches(".editor-tab, .editor-tab-gap"));
    return rect(stripIndex(strip) * STRIP_WIDTH + items.indexOf(this) * ITEM_WIDTH, 6, ITEM_WIDTH, 34);
  }
  return rect(0, 0, 0, 0);
}
function stripIndex(strip: Element): number {
  return [...(strip.parentElement?.querySelectorAll(":scope > .editor-group-tabs") ?? [])].indexOf(strip);
}

function pill(name: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "editor-tab";
  button.textContent = name;
  const close = document.createElement("button");
  close.className = "editor-tab-close";
  button.append(close);
  return button;
}

function setup(a: string[], b: string[]) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const strips = [a, b].map((names) => {
    const strip = document.createElement("div");
    strip.className = "editor-group-tabs";
    strip.append(...names.map((name) => pill(name)));
    const plus = document.createElement("button");
    plus.className = "editor-group-new-tab";
    strip.append(plus);
    host.append(strip);
    const adapter: TabDragStrip = {
      strip,
      pills: () => [...strip.querySelectorAll<HTMLButtonElement>(":scope > .editor-tab")],
      indexOf: (pill) => adapter.pills().indexOf(pill),
      settle: vi.fn(),
    };
    return adapter;
  });
  const onPress = vi.fn();
  const onDrop = vi.fn();
  const drag = createTabDrag({ host, strips: () => strips, onPress, onDrop });
  const names = (strip: TabDragStrip) => strip.pills().map((pill) => pill.firstChild?.textContent);
  return { host, strips, drag, onPress, onDrop, names };
}

function pointer(type: string, target: Element | Window, x: number, y: number, extra: PointerEventInit = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// A press on the pill named, then moves to each point, a frame after each.
async function carry(from: Element, points: [number, number][]) {
  const start = from.getBoundingClientRect();
  pointer("pointerdown", from, start.left + 50, 20);
  for (const [x, y] of points) {
    pointer("pointermove", window, x, y);
    await frame();
  }
}

describe("createTabDrag", () => {
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = layout;
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = original;
  });

  it("selects on press, lifts past the threshold, and moves the tab where it lands", async () => {
    const { host, strips, onPress, onDrop, names } = setup(["a0", "a1", "a2"], ["b0"]);
    const [a] = strips;
    const lifted = a.pills()[1];
    pointer("pointerdown", lifted, 150, 20);
    expect(onPress).toHaveBeenCalledWith(a, 1);
    pointer("pointermove", window, 152, 20);
    await frame();
    expect(lifted.parentElement).toBe(a.strip);

    pointer("pointermove", window, 260, 20);
    await frame();
    // The pill rides the layer; a held gap keeps its place; a2 has stepped aside.
    expect(lifted.parentElement?.className).toBe("editor-tab-drag-layer");
    expect(lifted.classList.contains("carried")).toBe(true);
    expect(host.classList.contains("tab-dragging")).toBe(true);
    const gap = a.strip.querySelector<HTMLElement>(".editor-tab-gap");
    expect(gap?.previousElementSibling).toBe(a.pills()[0]);
    expect(gap?.style.flex).toBe("0 0 100px");
    expect(a.pills()[1].style.transform).toBe(asStyled("transform", "translate(-100px, 0)"));
    expect(a.settle).toHaveBeenCalled();

    pointer("pointerup", window, 260, 20);
    expect(names(a)).toEqual(["a0", "a2", "a1"]);
    expect(onDrop).toHaveBeenCalledWith({ from: a, index: 1, to: a, at: 2 });
    expect(a.strip.querySelector(".editor-tab-gap")).toBeNull();
    expect(a.pills().every((pill) => pill.style.transform === "")).toBe(true);
    expect(lifted.classList.contains("carried")).toBe(false);
    expect(lifted.style.width).toBe("");
    expect(host.classList.contains("tab-dragging")).toBe(false);
  });

  it("marks the pill after the slot, and only the pills the gap passes move", async () => {
    const { strips, names } = setup(["a0", "a1", "a2", "a3"], []);
    const [a] = strips;
    await carry(a.pills()[0], [[260, 20]]);
    // Over a2's second half: the slot is between a2 and a3.
    const stepped = asStyled("transform", "translate(-100px, 0)");
    expect(a.pills().map((pill) => pill.style.transform)).toEqual([stepped, stepped, ""]);
    expect(a.pills().map((pill) => pill.classList.contains("after-slot"))).toEqual([false, false, true]);
    // Back over a1's first half: the slot is where the tab came from.
    pointer("pointermove", window, 90, 20);
    await frame();
    expect(a.pills().map((pill) => pill.style.transform)).toEqual(["", "", ""]);
    expect(a.pills().map((pill) => pill.classList.contains("after-slot"))).toEqual([true, false, false]);
    pointer("pointerup", window, 90, 20);
    expect(names(a)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(a.strip.querySelector(".after-slot")).toBeNull();
  });

  it("carries a tab into the other strip, opening a gap there and closing its own", async () => {
    const { strips, onDrop, names } = setup(["a0", "a1"], ["b0", "b1"]);
    const [a, b] = strips;
    const lifted = a.pills()[0];
    await carry(lifted, [[480, 20]]);
    expect(a.strip.querySelector(".editor-tab-gap")).toBeNull();
    const gap = b.strip.querySelector<HTMLElement>(".editor-tab-gap");
    expect(gap?.previousElementSibling).toBe(b.pills()[1]);
    expect(b.pills()[1].style.transform).toBe(asStyled("transform", "translate(100px, 0)"));
    expect(b.settle).toHaveBeenCalled();

    pointer("pointerup", window, 480, 20);
    expect(names(a)).toEqual(["a1"]);
    expect(names(b)).toEqual(["b0", "a0", "b1"]);
    expect(onDrop).toHaveBeenCalledWith({ from: a, index: 0, to: b, at: 1 });
  });

  it("follows the pointer straight across the edge the other strip adjoins", async () => {
    const { strips } = setup(["a0", "a1"], ["b0"]);
    const [a] = strips;
    const lifted = a.pills()[1];
    // Past a's right edge but not yet in b: the tab keeps going, held by a.
    await carry(lifted, [[310, 20]]);
    await frame();
    expect(a.strip.querySelector(".editor-tab-gap")).not.toBeNull();
    const x = Number.parseFloat(lifted.style.transform.replace("translate3d(", ""));
    expect(x).toBeGreaterThan(200);
    pointer("pointerup", window, 310, 20);
  });

  it("stops at the end of a row no other strip follows", async () => {
    const { strips, onDrop, names } = setup(["a0"], ["b0", "b1"]);
    const [, b] = strips;
    const lifted = b.pills()[0];
    await carry(lifted, [[700, 20]]);
    await frame();
    // The row's last slot, b1 having stepped aside: 100px before the "+".
    expect(lifted.style.transform).toBe(asStyled("transform", "translate3d(400px, 0px, 0)"));
    pointer("pointerup", window, 700, 20);
    expect(names(b)).toEqual(["b1", "b0"]);
    expect(onDrop).toHaveBeenCalledWith({ from: b, index: 0, to: b, at: 1 });
  });

  it("tears a tab off when pulled from the row, and sends it home when let go", async () => {
    const { strips, onDrop, names } = setup(["a0", "a1", "a2"], ["b0"]);
    const [a] = strips;
    const lifted = a.pills()[1];
    await carry(lifted, [[160, 120]]);
    expect(lifted.classList.contains("floating")).toBe(true);
    expect(a.strip.querySelector(".editor-tab-gap")).toBeNull();
    expect(a.pills().every((pill) => pill.style.transform === "")).toBe(true);

    pointer("pointerup", window, 160, 120);
    expect(names(a)).toEqual(["a0", "a1", "a2"]);
    expect(lifted.classList.contains("floating")).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("sends the tab home on Escape, on the window losing focus, and on release", async () => {
    const { host, strips, drag, onDrop, names } = setup(["a0", "a1"], ["b0"]);
    const [a] = strips;
    await carry(a.pills()[0], [[260, 20]]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(names(a)).toEqual(["a0", "a1"]);
    expect(host.classList.contains("tab-dragging")).toBe(false);
    pointer("pointerup", window, 260, 20);

    await carry(a.pills()[0], [[260, 20]]);
    window.dispatchEvent(new Event("blur"));
    expect(names(a)).toEqual(["a0", "a1"]);
    pointer("pointerup", window, 260, 20);

    await carry(a.pills()[0], [[260, 20]]);
    drag.release(a.strip);
    expect(names(a)).toEqual(["a0", "a1"]);
    expect(a.strip.querySelector(".editor-tab-gap")).toBeNull();
    pointer("pointerup", window, 260, 20);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("picks the tab up from its × too, selecting it only once it lifts", async () => {
    const { host, strips, onPress, onDrop, names } = setup(["a0", "a1", "a2"], ["b0"]);
    const [a] = strips;
    const lifted = a.pills()[0];
    const close = lifted.querySelector(".editor-tab-close") as Element;
    pointer("pointerdown", close, 50, 20);
    expect(onPress).not.toHaveBeenCalled();
    pointer("pointermove", window, 160, 20);
    await frame();
    expect(onPress).toHaveBeenCalledWith(a, 0);
    expect(host.classList.contains("tab-dragging")).toBe(true);
    pointer("pointerup", window, 160, 20);
    expect(names(a)).toEqual(["a1", "a0", "a2"]);
    expect(onDrop).toHaveBeenCalledWith({ from: a, index: 0, to: a, at: 1 });
  });

  it("ignores other buttons and a drag of nothing", async () => {
    const { host, strips, onPress } = setup(["a0", "a1"], ["b0"]);
    const [a] = strips;
    pointer("pointerdown", a.pills()[0], 50, 20, { button: 2 });
    expect(onPress).not.toHaveBeenCalled();
    pointer("pointerdown", a.strip, 250, 20);
    pointer("pointermove", window, 260, 20);
    await frame();
    expect(host.classList.contains("tab-dragging")).toBe(false);
    pointer("pointerup", window, 260, 20);
  });
});
