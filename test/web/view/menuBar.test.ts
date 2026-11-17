// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuBarItem, MenuBarMenu } from "../../../src/protocol/api.ts";
import type { PragmaElectronBridge } from "../../../web/core/apiClient.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { assistantHidden } from "../../../web/services/settings.ts";
import { wireMenuBar } from "../../../web/view/menuBar.ts";

// Two turns: the spaces load first, and the menus are described a turn later.
const tick = async () => {
  for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const writing = { id: "spc_writing", name: "Writing", path: "/spaces/writing" };
const research = { id: "spc_research", name: "Research", path: "/spaces/research" };

afterEach(() => {
  window.pragmaElectron = undefined;
  vi.unstubAllGlobals();
  assistantHidden.set(false);
});

function setup(platform = "darwin") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ current: writing, spaces: [writing, research], recent: [writing, research] })),
  );
  const commands = createCommands();
  const keybindings = createKeybindings(commands, { mac: true });
  const menus = createMenus(commands);
  const sent: MenuBarMenu[][] = [];
  let picked: ((command: string, arg: unknown) => void) | undefined;
  window.pragmaElectron = {
    platform,
    setMenuBar: vi.fn(async (described: MenuBarMenu[]) => void sent.push(described)),
    onMenuCommand: (callback: (command: string, arg: unknown) => void) => {
      picked = callback;
      return () => undefined;
    },
  } as unknown as PragmaElectronBridge;
  const listen = () => () => undefined;
  const menuBar = wireMenuBar({
    commands,
    menus,
    keybindings,
    context: () => context,
    tabs: { onActivate: listen, onFocus: listen, onGroupClosed: listen, onHistoryChange: listen },
    files: { moveToTrash: { get: () => true } },
  });
  const last = () => sent[sent.length - 1] ?? [];
  const menu = (label: string) => last().find((entry) => entry.label === label)?.items ?? [];
  const pick = (command: string, arg?: unknown) => picked?.(command, arg);
  return { commands, keybindings, menuBar, sent, menu, pick };
}

const shown = (items: MenuBarItem[]) =>
  items.map((item) => ("separator" in item ? "—" : "role" in item ? `(${item.role})` : item.label));

describe("the menu bar", () => {
  it("is wired only in the desktop app on macOS", () => {
    expect(setup("win32").menuBar).toBeUndefined();
    window.pragmaElectron = undefined;
    expect(wireMenuBar({} as Parameters<typeof wireMenuBar>[0])).toBeUndefined();
  });

  it("greys out a command that doesn't apply, and leaves out one nothing registered", async () => {
    const { commands, menu } = setup();
    commands.register({ id: "tree.newNote", label: "New Note", run: vi.fn() });
    commands.register({ id: "tree.newFolder", label: "New Folder", when: () => false, run: vi.fn() });
    commands.register({ id: "tree.delete", label: "Delete", run: vi.fn() });
    await tick();

    const file = menu("File");
    expect(shown(file)).toEqual(["New Note", "New Folder", "—", "Move to Trash", "—", "(close)"]);
    expect(file[0]).toMatchObject({ command: "tree.newNote", enabled: true });
    expect(file[1]).toMatchObject({ command: "tree.newFolder", enabled: false });
    expect(file[5]).toEqual({ role: "close", chord: "Shift+Meta+W" });
  });

  it("shows a command's chord from the registry, and none on an item that passes an argument", async () => {
    const { commands, keybindings, menu } = setup();
    commands.register({ id: "settings.open", label: "Open Settings", run: vi.fn() });
    keybindings.register({ key: "Mod+,", command: "settings.open" });
    await tick();

    expect(menu("Pragma")[2]).toEqual({ label: "Settings…", command: "settings.open", enabled: true, chord: "Meta+," });
    expect(menu("Help")).toEqual([
      { label: "Keyboard Shortcuts", command: "settings.open", arg: "shortcuts", enabled: true },
    ]);
  });

  it("gives Undo to the Flow canvas while it has an edit to undo, and to macOS otherwise", async () => {
    const { commands, keybindings, menuBar, menu } = setup();
    let canvasCanUndo = false;
    commands.register({ id: "flow.undo", label: "Undo", when: () => canvasCanUndo, run: vi.fn() });
    keybindings.register({ key: "Mod+Z", command: "flow.undo" });
    await tick();
    expect(menu("Edit").slice(0, 2)).toEqual([{ role: "undo" }, { role: "redo" }]);

    canvasCanUndo = true;
    menuBar?.sync();
    await tick();
    expect(menu("Edit")[0]).toEqual({ label: "Undo", command: "flow.undo", enabled: true, chord: "Meta+Z" });
  });

  it("names whichever of Bookmark and Remove from Bookmarks applies", async () => {
    const { commands, menuBar, menu } = setup();
    let bookmarked = false;
    commands.register({ id: "bookmarks.add", label: "Bookmark", when: () => !bookmarked, run: vi.fn() });
    commands.register({ id: "bookmarks.remove", label: "Remove from Bookmarks", when: () => bookmarked, run: vi.fn() });
    await tick();
    expect(shown(menu("File"))).toContain("Bookmark");

    bookmarked = true;
    menuBar?.sync();
    await tick();
    expect(shown(menu("File"))).toContain("Remove from Bookmarks");
    expect(shown(menu("File"))).not.toContain("Bookmark");
  });

  it("lists the spaces to switch to, the open one checked", async () => {
    const { commands, menu } = setup();
    commands.register({ id: "space.switch", label: "Switch space", run: vi.fn() });
    await tick();

    const switcher = menu("File").find((item) => "submenu" in item && item.label === "Switch Space");
    expect(switcher && "submenu" in switcher ? switcher.submenu : []).toEqual([
      {
        label: "Writing",
        command: "space.switch",
        arg: { name: "Writing", path: "/spaces/writing", current: true },
        enabled: true,
        checked: true,
      },
      {
        label: "Research",
        command: "space.switch",
        arg: { name: "Research", path: "/spaces/research", current: false },
        enabled: true,
        checked: false,
      },
    ]);
  });

  it("labels the sidebar item for what picking it does", async () => {
    const { commands, menu } = setup();
    commands.register({ id: "sidebar.toggle", label: "Toggle Sidebar", run: vi.fn() });
    await tick();
    expect(shown(menu("View"))).toContain("Hide Sidebar");
  });

  it("labels the assistant item for what picking it does, however the column was closed", async () => {
    const { commands, menu } = setup();
    commands.register({ id: "assistant.toggle", label: "Toggle Assistant", run: vi.fn() });
    await tick();
    expect(shown(menu("View"))).toContain("Hide Assistant");

    assistantHidden.set(true);
    await tick();
    expect(shown(menu("View"))).toContain("Show Assistant");
  });

  it("sends the menus again only when what they show changed", async () => {
    const { commands, menuBar, sent } = setup();
    commands.register({ id: "tree.newNote", label: "New Note", run: vi.fn() });
    await tick();
    const count = sent.length;
    menuBar?.sync();
    await tick();
    expect(sent).toHaveLength(count);

    commands.register({ id: "tree.newFolder", label: "New Folder", run: vi.fn() });
    menuBar?.sync();
    await tick();
    expect(sent).toHaveLength(count + 1);
  });

  it("runs a pick on the focused group with the argument its item named", async () => {
    const { commands, pick } = setup();
    const run = vi.fn();
    commands.register({ id: "space.switch", label: "Switch space", run });
    pick("space.switch", { path: "/spaces/research" });
    await tick();
    expect(run).toHaveBeenCalledWith(context, { path: "/spaces/research" });
  });
});
