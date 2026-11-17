// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPathLabel } from "../../../web/lib/pathLabel.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { type ContextMenu, createContextMenu } from "../../../web/view/contextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const names = (id: string) => new Map([["personas", "Personas"]]).get(id);

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

let contextMenu: ContextMenu;

beforeEach(() => {
  document.body.replaceChildren();
  clipboard.writeText.mockClear();
  // jsdom computes no user-select, so an element states its own in
  // data-select, and the body stands for the interface's `none`.
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (element: Element) =>
      ({
        userSelect: (element as HTMLElement).dataset?.select ?? (element === document.body ? "none" : "auto"),
      }) as unknown as CSSStyleDeclaration,
  );
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: false });
  const menus = createMenus(commands);
  contextMenu = createContextMenu({ commands, menus, keybindings, context: () => context });
});

afterEach(() => {
  contextMenu.dispose();
  vi.restoreAllMocks();
});

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  target.dispatchEvent(event);
  return event;
}

const menu = () => document.querySelector<HTMLElement>(".context-menu");
const rows = () => [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].map((row) => row.textContent);

// A note in the chat: text that selects, with a path chip in it.
function note(...parts: (string | Node)[]): HTMLElement {
  const element = document.createElement("p");
  element.dataset.select = "text";
  element.append(...parts);
  document.body.append(element);
  return element;
}

describe("a path chip's right-click", () => {
  it("copies the chip's whole path, however little of it shows, ahead of the text menu", async () => {
    const chip = createPathLabel("notes/drafts/act-one/a.md", names, { compact: true, after: "." });
    note("Applied edit to ", chip);

    const event = rightClick(chip.querySelector(".path-label-name") as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.getAttribute("aria-label")).toBe("File");
    expect(rows()).toEqual(["Copy path"]);

    menu()?.querySelector<HTMLElement>("[role=menuitem]")?.click();
    await tick();
    expect(clipboard.writeText).toHaveBeenCalledWith("notes/drafts/act-one/a.md");
  });

  it("names a folder as a folder, and a library's entry by its rooted path", async () => {
    note(createPathLabel("notes/drafts", names, { type: "directory" }));
    rightClick(document.querySelector(".path-label") as Element);
    expect(menu()?.getAttribute("aria-label")).toBe("Folder");
    menu()?.querySelector<HTMLElement>("[role=menuitem]")?.click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("notes/drafts");

    document.body.replaceChildren();
    note(createPathLabel("lib:personas/Lina/tester.png", names));
    rightClick(document.querySelector(".path-label") as Element);
    menu()?.querySelector<HTMLElement>("[role=menuitem]")?.click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("lib:personas/Lina/tester.png");
  });

  // A standalone label is a value, such as a dialog's title, not a chip; a
  // chip whose surface took the right-click, as the Flow canvas does, keeps
  // that surface's menu.
  it("leaves a standalone label, and a right-click something nearer took", () => {
    const value = createPathLabel("notes", names, { type: "directory", standalone: true });
    document.body.append(value);
    expect(rightClick(value).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();

    const taken = createPathLabel("notes/a.md", names);
    const surface = document.createElement("div");
    surface.append(taken);
    surface.addEventListener("contextmenu", (event) => event.preventDefault());
    document.body.append(surface);
    rightClick(taken);
    expect(menu()).toBeNull();
  });
});
