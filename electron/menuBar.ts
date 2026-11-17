// macOS's menu bar as Electron's template, from the menus the main window's
// page describes (web/view/menuBar.ts). The main process only draws them: a
// command item's pick goes back to the page as its command and argument, and
// a role is one of macOS's own items, About aside. The description comes
// from a renderer, so each item is checked, and a malformed one left out.
import type { MenuItemConstructorOptions } from "electron";
import type { MenuBarMenu, MenuBarRole } from "../src/protocol/api.ts";

const ROLES: Record<MenuBarRole, true> = {
  about: true,
  services: true,
  hide: true,
  hideOthers: true,
  unhide: true,
  quit: true,
  undo: true,
  redo: true,
  cut: true,
  copy: true,
  paste: true,
  pasteAndMatchStyle: true,
  delete: true,
  selectAll: true,
  close: true,
  togglefullscreen: true,
  toggleDevTools: true,
  minimize: true,
  zoom: true,
  front: true,
};

// Electron names these after app.name, which is package.json's lowercase
// "pragma" and names the user data folder too, so it can't change.
const NAMED_ROLES: Partial<Record<MenuBarRole, string>> = {
  hide: "Hide Pragma",
  quit: "Quit Pragma",
};

const SEPARATOR = { separator: true } as const;

/** The menu bar before the main window's page has described its own, and
 * once that window is gone: the welcome window's. Without an Edit menu,
 * macOS gives no field Cut, Copy, Paste or Undo, not even on their keys. */
export const BASE_MENU_BAR: MenuBarMenu[] = [
  {
    label: "Pragma",
    items: [
      { role: "about" },
      SEPARATOR,
      { role: "services" },
      SEPARATOR,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      SEPARATOR,
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    items: [
      { role: "undo" },
      { role: "redo" },
      SEPARATOR,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
  { label: "Window", role: "window", items: [{ role: "minimize" }, { role: "zoom" }, SEPARATOR, { role: "front" }] },
];

const MODIFIERS: Record<string, string> = { Ctrl: "Control", Alt: "Option", Shift: "Shift", Meta: "Command" };
const KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Plus: "Plus",
  Space: "Space",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** A canonical chord (web/services/keybindings.ts) as an Electron
 * accelerator, or undefined for a key Electron can't name. */
export function acceleratorOf(chord: string): string | undefined {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const name = KEYS[key] ?? (/^(F([1-9]|1\d|2[0-4])|[!-~])$/.test(key) ? key : undefined);
  if (name === undefined || !parts.every((part) => Object.hasOwn(MODIFIERS, part))) return undefined;
  return [...parts.map((part) => MODIFIERS[part]), name].join("+");
}

export interface MenuBarHost {
  // Sends a command item's pick back to the page.
  run(command: string, arg: unknown): void;
  showAbout(): void;
  fullScreen: boolean;
}

/** The template for `menus`, the page's description, or the base menu bar
 * when there is none. */
export function menuBarTemplate(menus: unknown, host: MenuBarHost): MenuItemConstructorOptions[] {
  const described: unknown[] = Array.isArray(menus) ? menus : BASE_MENU_BAR;
  return described.flatMap((menu): MenuItemConstructorOptions[] => {
    if (!isRecord(menu) || typeof menu.label !== "string" || !Array.isArray(menu.items)) return [];
    const role: MenuBarMenu["role"] = menu.role === "window" || menu.role === "help" ? menu.role : undefined;
    return [{ label: menu.label, ...(role === undefined ? {} : { role }), submenu: templateItems(menu.items, host) }];
  });
}

function templateItems(items: unknown[], host: MenuBarHost): MenuItemConstructorOptions[] {
  return items.flatMap((item): MenuItemConstructorOptions[] => {
    if (!isRecord(item)) return [];
    if (item.separator === true) return [{ type: "separator" }];
    const accelerator = typeof item.chord === "string" ? acceleratorOf(item.chord) : undefined;
    const shortcut = accelerator === undefined ? {} : { accelerator };
    if (typeof item.role === "string" && Object.hasOwn(ROLES, item.role)) {
      const role = item.role as MenuBarRole;
      // Pragma's own window (aboutWindow.ts), not macOS's panel, which shows
      // only the app's icon over a plain-text name, none of it selectable.
      if (role === "about") return [{ label: "About Pragma", click: () => host.showAbout() }];
      const label = role === "togglefullscreen" ? fullScreenLabel(host.fullScreen) : NAMED_ROLES[role];
      return [{ role, ...(label === undefined ? {} : { label }), ...shortcut }];
    }
    if (typeof item.label !== "string") return [];
    if (Array.isArray(item.submenu)) return [{ label: item.label, submenu: templateItems(item.submenu, host) }];
    if (typeof item.command !== "string") return [{ label: item.label, enabled: false }];
    const { command, arg } = item;
    const check = typeof item.checked === "boolean" ? { type: "checkbox" as const, checked: item.checked } : {};
    return [
      { label: item.label, enabled: item.enabled === true, ...check, ...shortcut, click: () => host.run(command, arg) },
    ];
  });
}

// macOS retitles its own full screen item as the window changes, but
// Electron's role keeps whatever label it was given, so the label says which
// way it goes and main.ts rebuilds the menu bar on each change.
function fullScreenLabel(fullScreen: boolean): string {
  return fullScreen ? "Exit Full Screen" : "Enter Full Screen";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
