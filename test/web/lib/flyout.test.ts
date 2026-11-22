// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFlyout, positionPopover } from "../../../web/lib/flyout.ts";

// A flyout hears presses a tick after it opens.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const anchor = document.createElement("button");
  const outside = document.createElement("div");
  document.body.append(anchor, outside);
  const panel = document.createElement("div");
  const onClose = vi.fn();
  openFlyout(anchor, panel, onClose);
  await tick();
  return { anchor, outside, panel, onClose };
}

const press = (target: Element, button = 0) =>
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button }));
const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

afterEach(() => {
  document.body.replaceChildren();
});

describe("a flyout", () => {
  it("closes once a press outside ends as a click", async () => {
    const { outside, panel, onClose } = await setup();
    press(outside);
    expect(panel.isConnected).toBe(true);
    click(outside);
    expect(panel.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  // A drag ends with no click, so whatever is dragged in finds it open.
  it("stays open through a press outside that becomes a drag", async () => {
    const { outside, panel } = await setup();
    press(outside);
    panel.dispatchEvent(new Event("drop", { bubbles: true }));
    press(panel);
    click(panel);
    expect(panel.isConnected).toBe(true);
  });

  it("closes at once on a right or middle press outside", async () => {
    for (const button of [1, 2]) {
      const { outside, panel } = await setup();
      press(outside, button);
      expect(panel.isConnected).toBe(false);
    }
  });

  it("stays open for clicks on itself, its anchor or a menu over it", async () => {
    const { anchor, panel } = await setup();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = menu.appendChild(document.createElement("div"));
    document.body.append(menu);
    for (const target of [panel, anchor, item]) {
      press(target);
      click(target);
    }
    expect(panel.isConnected).toBe(true);
  });

  it("leaves a click with no press of its own alone, as the one that opened it", async () => {
    const { outside, panel } = await setup();
    click(outside);
    expect(panel.isConnected).toBe(true);
  });
});

// Every anchored popover sits here: the color, date and timestamp pickers,
// the Add column form and the flyouts.
describe("a popover's place", () => {
  // Where a popover `width` by `height` lands against an anchor's box, in
  // jsdom's 1024 by 768 window.
  function place(anchor: { left: number; top: number; bottom: number }, width: number, height: number) {
    const button = document.createElement("button");
    button.getBoundingClientRect = () => ({ ...anchor, right: anchor.left, width: 0, height: 0 }) as DOMRect;
    const popover = document.createElement("div");
    Object.defineProperties(popover, { offsetWidth: { value: width }, offsetHeight: { value: height } });
    positionPopover(popover, button);
    return [popover.style.left, popover.style.top];
  }

  it("sits 4px below its anchor, their left edges lined up", () => {
    expect(place({ left: 100, top: 50, bottom: 70 }, 200, 100)).toEqual(["100px", "74px"]);
  });

  it("flips above an anchor too near the bottom, and keeps 4px off the top when it fits neither way", () => {
    expect(place({ left: 100, top: 700, bottom: 720 }, 200, 100)).toEqual(["100px", "596px"]);
    expect(place({ left: 100, top: 300, bottom: 320 }, 200, 760)).toEqual(["100px", "4px"]);
  });

  it("keeps 4px off the right edge, and off the left one when it's wider than the window", () => {
    expect(place({ left: 900, top: 50, bottom: 70 }, 200, 100)).toEqual(["820px", "74px"]);
    expect(place({ left: 100, top: 50, bottom: 70 }, 1100, 100)).toEqual(["4px", "74px"]);
  });
});
