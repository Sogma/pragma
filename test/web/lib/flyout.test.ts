// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFlyout, positionPopover, registerFlyoutEscape } from "../../../web/lib/flyout.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";

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

describe("one popover at a time", () => {
  it("closes the open popover when another opens", async () => {
    const first = await setup();
    const second = await setup();
    expect(first.panel.isConnected).toBe(false);
    expect(first.onClose).toHaveBeenCalledOnce();
    expect(second.panel.isConnected).toBe(true);
  });
});

describe("a popover's Escape", () => {
  const context = (): CommandContext => ({ tab: {} as CommandContext["tab"], pane: undefined });
  const pressEscape = (target: Element) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  function dispatcher() {
    const commands = createCommands();
    const keybindings = createKeybindings(commands);
    registerFlyoutEscape(commands, keybindings);
    return { commands, keybindings, attached: keybindings.attach(document, context) };
  }

  it("closes it with focus on its anchor or in a field of its own", async () => {
    const { attached } = dispatcher();
    const first = await setup();
    first.anchor.focus();
    pressEscape(first.anchor);
    expect(first.panel.isConnected).toBe(false);

    const second = await setup();
    const field = document.createElement("input");
    second.panel.append(field);
    field.focus();
    pressEscape(field);
    expect(second.panel.isConnected).toBe(false);
    attached.dispose();
  });

  // A dialog's Escape weighs 200 and a menu's 100: whichever is open over a
  // popover takes the key before it.
  it("leaves the key to a surface over it that claims Escape first", async () => {
    const { commands, keybindings, attached } = dispatcher();
    const closeMenu = vi.fn();
    commands.register({ id: "test.menu", label: "Close menu", run: closeMenu });
    keybindings.register({ key: "Escape", command: "test.menu", weight: 100 });
    const { anchor, panel } = await setup();
    pressEscape(anchor);
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(panel.isConnected).toBe(true);
    attached.dispose();
  });
});

describe("focus leaving a popover", () => {
  it("closes it once focus lands outside", async () => {
    const { outside, panel, onClose } = await setup();
    const elsewhere = document.createElement("button");
    outside.append(elsewhere);
    elsewhere.focus();
    expect(panel.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves it open for focus on itself, its anchor, a menu or a modal dialog", async () => {
    const { anchor, panel } = await setup();
    const focusIn = (host: HTMLElement) => {
      const button = document.createElement("button");
      host.append(button);
      if (!host.isConnected) document.body.append(host);
      button.focus();
    };
    focusIn(panel);
    anchor.focus();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    focusIn(menu);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    focusIn(dialog);
    expect(panel.isConnected).toBe(true);
  });
});
