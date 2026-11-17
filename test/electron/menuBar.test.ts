import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { acceleratorOf, BASE_MENU_BAR, menuBarTemplate } from "../../electron/menuBar.ts";
import type { MenuBarMenu } from "../../src/protocol/api.ts";

const host = (fullScreen = false) => ({ run: vi.fn(), showAbout: vi.fn(), fullScreen });
const submenuOf = (item: MenuItemConstructorOptions) => item.submenu as MenuItemConstructorOptions[];

describe("acceleratorOf", () => {
  it("names the keybinding grammar's modifiers and keys as Electron does", () => {
    expect(acceleratorOf("Meta+Shift+Z")).toBe("Command+Shift+Z");
    expect(acceleratorOf("Meta+Alt+ArrowLeft")).toBe("Command+Option+Left");
    expect(acceleratorOf("Ctrl+Meta+S")).toBe("Control+Command+S");
    expect(acceleratorOf("Meta+Plus")).toBe("Command+Plus");
    expect(acceleratorOf("Meta+,")).toBe("Command+,");
    expect(acceleratorOf("Meta+\\")).toBe("Command+\\");
    expect(acceleratorOf("F2")).toBe("F2");
  });

  it("names nothing for a key or modifier Electron has no name for", () => {
    expect(acceleratorOf("Meta+ƒ")).toBeUndefined();
    expect(acceleratorOf("Hyper+K")).toBeUndefined();
    expect(acceleratorOf("Meta+F25")).toBeUndefined();
  });
});

describe("menuBarTemplate", () => {
  it("draws the base menu bar, with its Edit menu, until a page describes one", () => {
    const template = menuBarTemplate(undefined, host());
    expect(template.map((menu) => menu.label)).toEqual(BASE_MENU_BAR.map((menu) => menu.label));
    const [app, edit, window] = template;
    expect(
      submenuOf(app)
        .filter((item) => item.label)
        .map((item) => item.label),
    ).toEqual(["About Pragma", "Hide Pragma", "Quit Pragma"]);
    expect(submenuOf(edit).map((item) => item.role ?? item.type)).toContain("paste");
    expect(window.role).toBe("window");
  });

  it("hands a command item's pick back with the command and argument the page gave", () => {
    const at = host();
    const menus: MenuBarMenu[] = [
      {
        label: "File",
        items: [
          { label: "Settings…", command: "settings.open", enabled: true, chord: "Meta+," },
          { separator: true },
          { label: "Keyboard Shortcuts", command: "settings.open", arg: "shortcuts", enabled: false },
          { label: "Format Column", command: "editor.toggleFormat", enabled: true, checked: true },
          { label: "Failed to load spaces", enabled: false },
        ],
      },
    ];
    const [settings, separator, shortcuts, format, line] = submenuOf(menuBarTemplate(menus, at)[0]);

    expect(settings).toMatchObject({ label: "Settings…", enabled: true, accelerator: "Command+," });
    expect(separator.type).toBe("separator");
    expect(shortcuts).toMatchObject({ enabled: false });
    expect(shortcuts.accelerator).toBeUndefined();
    expect(format).toMatchObject({ type: "checkbox", checked: true });
    expect(line).toEqual({ label: "Failed to load spaces", enabled: false });

    (shortcuts.click as () => void)();
    expect(at.run).toHaveBeenCalledWith("settings.open", "shortcuts");
  });

  it("draws a role as macOS's own item, with the chord in place of its own", () => {
    const menus = [
      { label: "File", items: [{ role: "close", chord: "Shift+Meta+W" }, { role: "quit" }] },
      { label: "Window", role: "window", items: [{ role: "minimize" }] },
      { label: "Help", role: "help", items: [] },
    ];
    const [file, window, help] = menuBarTemplate(menus, host());
    expect(submenuOf(file)).toEqual([
      { role: "close", accelerator: "Shift+Command+W" },
      { role: "quit", label: "Quit Pragma" },
    ]);
    expect(window.role).toBe("window");
    expect(help.role).toBe("help");
  });

  it("draws About as Pragma's own window, not macOS's panel", () => {
    const at = host();
    const [about] = submenuOf(menuBarTemplate(BASE_MENU_BAR, at)[0]);
    expect(about.role).toBeUndefined();
    expect(about.label).toBe("About Pragma");

    (about.click as () => void)();
    expect(at.showAbout).toHaveBeenCalledOnce();
    expect(at.run).not.toHaveBeenCalled();
  });

  it("says which way the full screen item goes", () => {
    const menus = [{ label: "View", items: [{ role: "togglefullscreen" }] }];
    expect(submenuOf(menuBarTemplate(menus, host(false))[0])[0].label).toBe("Enter Full Screen");
    expect(submenuOf(menuBarTemplate(menus, host(true))[0])[0].label).toBe("Exit Full Screen");
  });

  it("leaves out whatever a page sends that isn't a menu item it may name", () => {
    const menus = [
      {
        label: "File",
        role: "fileMenu",
        items: [{ role: "reload" }, { label: 3 }, null, { label: "Open", command: 7 }],
      },
      { label: "Edit" },
      "Help",
    ];
    const template = menuBarTemplate(menus, host());
    expect(template).toHaveLength(1);
    expect(template[0].role).toBeUndefined();
    expect(submenuOf(template[0])).toEqual([{ label: "Open", enabled: false }]);
  });
});
