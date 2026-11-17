// macOS's menu bar in the desktop app: its menus as data, which the main
// process draws (electron/menuBar.ts), handing a pick back as the command its
// item named, run on the focused group as a key press runs one.
//
// Where Pragma's own menus leave out a command that doesn't apply, this one
// greys it out, so every item keeps its place, and it names items in macOS's
// title case.
//
// A chord shown here is always the registry's, sent again whenever it
// changes: on macOS a menu item's shortcut is live, and answers whenever the
// page leaves that key alone.
import type { MenuBarItem, MenuBarMenu, MenuBarRole } from "../../src/protocol/api.ts";
import { fetchSpaceList } from "../core/apiClient.ts";
import { removalLabel } from "../core/paths.ts";
import * as workspace from "../core/workspace.ts";
import { listen } from "../lib/disposable.ts";
import { bookmarks } from "../services/bookmarks.ts";
import type { CommandContext, CommandRegistry } from "../services/commands.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";
import type { MenuItem, MenuRegistry, ResolvedMenuItem } from "../services/menus.ts";
import { assistantHidden, formatColumn, shortcuts, sidebarHidden } from "../services/settings.ts";
import { loadRecentSpaces, type RecentSpaces, recentSpaceRows } from "../services/spaceSwitch.ts";
import type { Tabs } from "../services/tabs.ts";

export interface MenuBarDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  context(): CommandContext;
  /** Whose changes the menus follow, besides the page's own focus, keys and clicks. */
  tabs: Pick<Tabs, "onActivate" | "onFocus" | "onGroupClosed" | "onHistoryChange">;
  /** Settings → Files, whose Move to Trash names the File menu's Delete. */
  files: { moveToTrash: { get(): boolean } };
}

export interface MenuBar {
  /** Describes the menus again, and sends them if what they show changed. */
  sync(): void;
  refreshSpaces(): void;
}

// One of Pragma's commands, as any menu names one, or one of macOS's own
// items by role. With both, the role stands in while the command doesn't
// apply. `chord` is a role's shortcut, in place of its own.
type Row = MenuItem & { role?: MenuBarRole; chord?: string };

interface BarMenu {
  label: string;
  role?: MenuBarMenu["role"];
  rows: Row[];
}

function barMenus(deps: MenuBarDeps, spaces: () => RecentSpaces): BarMenu[] {
  const { commands, files } = deps;
  // Of two commands that apply one at a time, the one that does.
  const applies = (command: string) => (context: CommandContext) => commands.isEnabled(command, context);
  const unless = (command: string) => (context: CommandContext) => !commands.isEnabled(command, context);
  return [
    {
      label: "Pragma",
      rows: [
        { role: "about", group: "about" },
        { command: "settings.open", label: "Settings…", group: "settings" },
        { command: "settings.checkForUpdates", group: "settings" },
        { role: "services", group: "services" },
        { role: "hide", group: "hide" },
        { role: "hideOthers", group: "hide" },
        { role: "unhide", group: "hide" },
        { role: "quit", group: "quit" },
      ],
    },
    {
      label: "File",
      rows: [
        { command: "tree.newNote", group: "new" },
        { command: "tree.newFolder", group: "new" },
        {
          label: "New",
          group: "new",
          submenu: [
            { command: "tree.newTable", label: "Table" },
            { command: "tree.newFlow", label: "Flow" },
            { command: "tree.newClass", label: "Class" },
          ],
        },
        { command: "tab.new", group: "new" },
        { label: "Switch Space", group: "space", submenu: () => recentSpaceRows(spaces()) },
        { command: "space.manage", group: "space" },
        { command: "tree.rename", label: "Rename File…", group: "file" },
        { command: "bookmarks.add", when: unless("bookmarks.remove"), group: "file" },
        { command: "bookmarks.remove", when: applies("bookmarks.remove"), group: "file" },
        { command: "file.showInFolder", group: "file" },
        { command: "tree.delete", label: () => removalLabel(files.moveToTrash.get()), group: "file" },
        { command: "tab.close", label: "Close Tab", group: "close" },
        // Off Mod+W, which closes a tab, as in a browser.
        { role: "close", chord: "Shift+Meta+W", group: "close" },
      ],
    },
    {
      label: "Edit",
      rows: [
        // A Flow canvas keeps its own history, which a field's Undo can't reach.
        { command: "flow.undo", label: "Undo", role: "undo", group: "history" },
        { command: "flow.redo", label: "Redo", role: "redo", group: "history" },
        { role: "cut", group: "clipboard" },
        { role: "copy", group: "clipboard" },
        { role: "paste", group: "clipboard" },
        { role: "pasteAndMatchStyle", group: "clipboard" },
        { role: "delete", group: "clipboard" },
        { role: "selectAll", group: "clipboard" },
        { command: "document.find", group: "find" },
        { command: "document.replace", group: "find" },
      ],
    },
    {
      label: "View",
      rows: [
        {
          command: "editor.toggleReadingView",
          label: "Reading View",
          checked: () => workspace.focusedGroup().readingView,
          group: "mode",
        },
        {
          command: "editor.toggleSourceMode",
          label: "Source Mode",
          checked: () => workspace.focusedGroup().sourceMode,
          group: "mode",
        },
        { command: "editor.toggleFormat", label: "Format Column", checked: () => formatColumn.get(), group: "mode" },
        {
          command: "sidebar.toggle",
          label: () => (sidebarHidden.get() ? "Show Sidebar" : "Hide Sidebar"),
          group: "layout",
        },
        {
          command: "assistant.toggle",
          label: () => (assistantHidden.get() ? "Show Assistant" : "Hide Assistant"),
          group: "layout",
        },
        { command: "editor.split", group: "layout" },
        { command: "editor.focusOtherGroup", group: "layout" },
        { command: "window.zoomIn", group: "zoom" },
        { command: "window.zoomOut", group: "zoom" },
        { command: "window.zoomReset", label: "Actual Size", group: "zoom" },
        { role: "togglefullscreen", group: "window" },
        { role: "toggleDevTools", group: "window" },
      ],
    },
    {
      label: "Go",
      rows: [
        { command: "editor.goBack", label: "Back", group: "history" },
        { command: "editor.goForward", label: "Forward", group: "history" },
        { command: "quickOpen.files", group: "open" },
        { command: "quickOpen.commands", group: "open" },
        { command: "search.focus", group: "open" },
      ],
    },
    {
      label: "Window",
      role: "window",
      rows: [
        { role: "minimize", group: "window" },
        { role: "zoom", group: "window" },
        { role: "front", group: "front" },
      ],
    },
    {
      label: "Help",
      role: "help",
      rows: [{ command: "settings.open", arg: "shortcuts", label: "Keyboard Shortcuts", group: "help" }],
    },
  ];
}

/** Wires the menu bar where the desktop app runs on macOS; undefined elsewhere. */
export function wireMenuBar(deps: MenuBarDeps): MenuBar | undefined {
  const bridge = window.pragmaElectron;
  if (bridge?.platform !== "darwin") return undefined;
  let spaces: RecentSpaces = { entries: [], hidden: 0, failed: false };
  const layout = barMenus(deps, () => spaces);

  const roleItem = ({ role, chord }: Row): MenuBarItem => ({
    role: role as MenuBarRole,
    ...(chord === undefined ? {} : { chord }),
  });

  function describeRow(row: Row, context: CommandContext): MenuBarItem | undefined {
    if (row.command === undefined && row.submenu === undefined && row.role !== undefined) return roleItem(row);
    const [resolved] = deps.menus.resolveItems([row], context, undefined, { keepInapplicable: true });
    if (row.role !== undefined && (resolved === undefined || resolved.disabled)) return roleItem(row);
    return resolved === undefined ? undefined : describeItem(resolved);
  }

  function describeItem(item: ResolvedMenuItem): MenuBarItem {
    if (item.submenu) {
      const children = item.submenu.map((child) => [describeItem(child), child.group] as const);
      return { label: item.label, submenu: separated(children) };
    }
    // A key press passes no argument, so an item carrying one shows no
    // chord. Of several, one holding ⌘ where there is one: a Mac's F keys
    // are its brightness and volume unless fn is held.
    const chords = item.command !== undefined && item.arg === undefined ? deps.keybindings.chordsFor(item.command) : [];
    const chord = chords.findLast((held) => held.split("+").includes("Meta")) ?? chords[chords.length - 1];
    return {
      label: item.label,
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.arg === undefined ? {} : { arg: item.arg }),
      enabled: item.command !== undefined && item.disabled !== true,
      ...(item.checked === undefined ? {} : { checked: item.checked }),
      ...(chord === undefined ? {} : { chord }),
    };
  }

  function describe(): MenuBarMenu[] {
    const context = deps.context();
    return layout.map(({ label, role, rows }) => ({
      label,
      ...(role === undefined ? {} : { role }),
      items: separated(
        rows.flatMap((row) => {
          const item = describeRow(row, context);
          return item === undefined ? [] : [[item, row.group] as const];
        }),
      ),
    }));
  }

  let sent = "";
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    pending = undefined;
    const menus = describe();
    const text = JSON.stringify(menus);
    if (text === sent) return;
    sent = text;
    void bridge.setMenuBar(menus);
  };
  // After the handlers of whatever event asked, and once for a burst.
  function sync(): void {
    if (pending === undefined) pending = setTimeout(flush, 0);
  }
  async function refreshSpaces(): Promise<void> {
    spaces = await loadRecentSpaces(fetchSpaceList);
    sync();
  }

  bridge.onMenuCommand((command, arg) => void deps.commands.run(command, deps.context(), arg).finally(sync));
  // Capturing, so an event a surface stops on its way still counts.
  for (const type of ["focusin", "keyup", "pointerup"]) listen(document, type, sync, true);
  listen(window, "focus", () => void refreshSpaces());
  const { tabs } = deps;
  for (const change of [tabs.onActivate, tabs.onFocus, tabs.onGroupClosed, tabs.onHistoryChange]) change(sync);
  for (const setting of [bookmarks, shortcuts, formatColumn, sidebarHidden, assistantHidden]) setting.subscribe(sync);
  void refreshSpaces();
  return { sync, refreshSpaces: () => void refreshSpaces() };
}

// A separator wherever the group changes, as Pragma's own menus draw one.
function separated(placed: (readonly [MenuBarItem, string | undefined])[]): MenuBarItem[] {
  return placed.flatMap(([item, group], index) =>
    index > 0 && group !== placed[index - 1][1] ? [{ separator: true as const }, item] : [item],
  );
}
