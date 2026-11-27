// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPY_PATH,
  COPY_PRAGMA_URL,
  COPY_SYSTEM_PATH,
  copyPathItem,
  installCopyPath,
} from "../../../web/lib/copyPath.ts";
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
    expect(menu()?.querySelector(".has-submenu")?.firstChild?.textContent).toBe("Copy path");
    expect(rows()).toEqual(["from space folder", "from system root"]);

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

describe("Copy path in an entry's menu", () => {
  const onDisk = () => vi.fn(async (path: string): Promise<string> => `/home/you/space/${path}`);
  function setup(systemPath = onDisk(), spaceName?: () => Promise<string>) {
    const commands = createCommands();
    const menus = createMenus(commands);
    const installed = installCopyPath({ commands, menus, menu: { open: vi.fn() }, systemPath, spaceName });
    menus.register("entry", [copyPathItem({ group: "copy" })]);
    const items = (arg: unknown) => menus.resolve("entry", context, arg);
    return { commands, menus, items, installed, systemPath };
  }

  it("is a flyout: the path from the space's folder, and from the system root", async () => {
    const { commands, items, installed, systemPath } = setup();
    const resolved = items({ node: { type: "directory", path: "projects" } });
    expect(resolved.map((item) => [item.label, item.command])).toEqual([["Copy path", undefined]]);
    const [fromSpace, fromSystem] = resolved[0].submenu ?? [];
    expect([fromSpace.label, fromSystem.label]).toEqual(["from space folder", "from system root"]);

    await commands.run(COPY_PATH, context, fromSpace.arg);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("projects");
    await commands.run(COPY_SYSTEM_PATH, context, fromSystem.arg);
    expect(systemPath).toHaveBeenCalledWith("projects");
    expect(clipboard.writeText).toHaveBeenLastCalledWith("/home/you/space/projects");
    // A tree's empty area names no entry.
    expect(items({ node: null })).toEqual([]);
    installed.dispose();
  });

  it("names a library's entry from the library's folder, by its rooted path", async () => {
    const { commands, items, installed, systemPath } = setup();
    const [flyout] = items({
      root: { library: "personas" },
      node: { type: "file", path: "lib:personas/Lina/tester.png" },
    });
    const [fromLibrary, fromSystem] = flyout.submenu ?? [];
    expect(fromLibrary.label).toBe("from library folder");

    await commands.run(COPY_PATH, context, fromLibrary.arg);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("lib:personas/Lina/tester.png");
    await commands.run(COPY_SYSTEM_PATH, context, fromSystem.arg);
    expect(systemPath).toHaveBeenCalledWith("lib:personas/Lina/tester.png");
    installed.dispose();
  });

  it("copies nothing from the system root when the server refuses the path", async () => {
    const systemPath = vi.fn(async (_path: string): Promise<string> => Promise.reject(new Error("No library")));
    const { commands, installed } = setup(systemPath);
    await commands.run(COPY_SYSTEM_PATH, context, { file: "lib:gone/a.md" });
    expect(systemPath).toHaveBeenCalledWith("lib:gone/a.md");
    expect(clipboard.writeText).not.toHaveBeenCalled();
    installed.dispose();
  });

  // Only the desktop app opens a Pragma link, so only it hands over the
  // space's name the row needs.
  it("leads with the entry's Pragma link in the desktop app", async () => {
    const { commands, items, installed } = setup(onDisk(), async () => "My Notes");
    const rows = (arg: unknown) => items(arg)[0].submenu ?? [];
    const file = rows({ node: { type: "file", path: "projects/My Draft.md" } });
    expect(file.map((row) => row.label)).toEqual(["as Pragma URL", "from space folder", "from system root"]);

    await commands.run(COPY_PRAGMA_URL, context, file[0].arg);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("pragma://My%20Notes/projects/My%20Draft.md");
    await commands.run(COPY_PRAGMA_URL, context, rows({ folder: "projects" })[0].arg);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("pragma://My%20Notes/projects/");
    const library = { root: { library: "personas" }, node: { type: "file", path: "lib:personas/Lina/tester.png" } };
    await commands.run(COPY_PRAGMA_URL, context, rows(library)[0].arg);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("pragma://My%20Notes/lib:personas/Lina/tester.png");
    installed.dispose();
  });

  it("offers no Pragma link in the browser, and copies none when the space's name can't be read", async () => {
    const browser = setup();
    expect(browser.items({ file: "a.md" })[0].submenu?.map((row) => row.label)).toEqual([
      "from space folder",
      "from system root",
    ]);
    browser.installed.dispose();

    const unread = setup(onDisk(), async () => Promise.reject(new Error("Failed to load space info")));
    await unread.commands.run(COPY_PRAGMA_URL, context, { file: "a.md" });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    unread.installed.dispose();
  });

  it("gives a path chip the same flyout", () => {
    const { menus, installed } = setup();
    const [flyout, ...rest] = menus.resolve("pathChip", context, { file: "notes/a.md" });
    expect(rest).toEqual([]);
    expect([flyout.label, flyout.command]).toEqual(["Copy path", undefined]);
    expect(flyout.submenu?.map((row) => [row.label, row.command])).toEqual([
      ["from space folder", COPY_PATH],
      ["from system root", COPY_SYSTEM_PATH],
    ]);
    installed.dispose();
  });
});
