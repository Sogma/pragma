// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPickerButton, setPickerName, wireChoicePicker } from "../../../web/lib/picker.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createContextMenu } from "../../../web/view/contextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

beforeEach(() => {
  document.body.replaceChildren();
});

function setup() {
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const contextMenu = createContextMenu({
    commands,
    menus: createMenus(commands),
    keybindings,
    context: () => context,
  });
  const button = document.createElement("button");
  document.body.append(button);
  const pick = vi.fn();
  const picker = wireChoicePicker(
    button,
    [
      { value: "system", label: "System Default" },
      { value: "light", label: "Light" },
    ],
    { role: "Color scheme", contextMenu, pick },
  );
  const menu = () => document.querySelector<HTMLElement>(".context-menu");
  const row = (label: string) =>
    [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) => item.textContent === label);
  return { button, picker, pick, menu, row };
}

describe("createPickerButton", () => {
  it("builds a button with a name slot and a chevron, and names a value in it", () => {
    const button = createPickerButton("extra");
    expect(button.className).toBe("picker extra");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("true");
    expect([...button.children].map((part) => part.className)).toEqual(["picker-name", "picker-chevron"]);
    setPickerName(button, "Courier Prime");
    expect(button.querySelector(".picker-name")?.textContent).toBe("Courier Prime");
  });
});

describe("wireChoicePicker", () => {
  it("stacks every choice's name in the button, showing the first until told otherwise", () => {
    const { button, picker } = setup();
    const names = [...button.querySelectorAll(".picker-name > .picker-choice")];
    expect(names.map((name) => name.textContent)).toEqual(["System Default", "Light"]);
    expect(names.map((name) => name.classList.contains("current"))).toEqual([true, false]);
    expect(button.getAttribute("aria-label")).toBe("Color scheme: System Default");
    picker.show("light");
    expect(picker.value).toBe("light");
    expect(names.map((name) => name.classList.contains("current"))).toEqual([false, true]);
    expect(button.getAttribute("aria-label")).toBe("Color scheme: Light");
  });

  it("opens its menu under the button, the value shown checked, and a pick names the choice and runs", () => {
    const { button, picker, pick, menu, row } = setup();
    picker.show("light");
    button.click();
    expect(menu()?.getAttribute("aria-label")).toBe("Color scheme");
    expect(menu()?.classList.contains("picker-menu")).toBe(true);
    expect(row("Light")?.getAttribute("aria-checked")).toBe("true");
    expect(row("System Default")?.getAttribute("aria-checked")).toBe("false");
    row("System Default")?.click();
    expect(menu()).toBeNull();
    expect(picker.value).toBe("system");
    expect(pick).toHaveBeenCalledWith("system");
  });

  it("opens its menu on ↓ or ↑, on the value picked, leaving an open one's keys to the menu", () => {
    const { button, picker, menu } = setup();
    picker.show("light");
    const key = (name: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
      button.dispatchEvent(event);
      return event;
    };
    expect(key("ArrowDown", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(menu()?.querySelector(".highlighted")?.textContent).toBe("Light");
    expect(key("ArrowUp").defaultPrevented).toBe(false);
    expect(menu()).not.toBeNull();
    button.click();
    expect(menu()).toBeNull();
    key("ArrowUp");
    expect(menu()).not.toBeNull();
  });

  it("closes its menu on a second click, and names a value shown from elsewhere without a pick", () => {
    const { button, picker, pick, menu } = setup();
    button.click();
    expect(menu()).not.toBeNull();
    button.click();
    expect(menu()).toBeNull();
    picker.show("light");
    expect(pick).not.toHaveBeenCalled();
  });
});
