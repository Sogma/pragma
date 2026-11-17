// The space switcher — the menu behind the space name atop the tree: the
// short recents list (services/spaceSwitch.ts) and the "More…" overflow
// signal. The full registry, and every action on it, belongs to
// manageSpaces.ts.
import type { fetchSpaceList } from "../core/apiClient.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { MenuItem, MenuRegistry } from "../services/menus.ts";
import { loadRecentSpaces, type RecentSpaces, recentSpaceRows, type SpaceEntry } from "../services/spaceSwitch.ts";
import type { ContextMenu } from "./contextMenu.ts";

export interface SpaceSwitcherDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  contextMenu: ContextMenu;
  // The space name element the menu hangs off, and its click target.
  anchor: HTMLElement;
  fetchSpaceList(): ReturnType<typeof fetchSpaceList>;
  switchSpace(path: string): Promise<void>;
}

export interface SpaceSwitcher {
  // The same menu at a point, for a right-click away from the space name:
  // the Space view's rail icon.
  openAt(at: { x: number; y: number }): void;
}

export function createSpaceSwitcher(deps: SpaceSwitcherDeps): SpaceSwitcher {
  const { commands, menus, contextMenu, anchor } = deps;

  commands.register({
    id: "space.switch",
    label: "Switch space",
    run: (_, space: SpaceEntry) => {
      if (!space.current) void deps.switchSpace(space.path);
    },
  });

  menus.register("space", (_, arg) => {
    const { hidden } = arg as RecentSpaces;
    // The only thing that says this list is truncated: "Manage Spaces…"
    // below is always present, so its presence reports nothing. This appears
    // only on overflow, counting the spaces *not* shown above.
    const more: MenuItem[] = hidden
      ? [{ command: "space.manage", label: "More…", detail: String(hidden), group: "spaces" }]
      : [];
    return [...recentSpaceRows(arg as RecentSpaces), ...more, { command: "space.manage", group: "manage" }];
  });

  // Fetched fresh on every open, so it can't show a stale list after a
  // switch made elsewhere.
  async function showSpaceMenu(place: { anchor: HTMLElement } | { at: { x: number; y: number } }): Promise<void> {
    const arg = await loadRecentSpaces(deps.fetchSpaceList);
    contextMenu.open({ menu: "space", arg, ...place, ariaLabel: "Spaces" });
  }

  anchor.addEventListener("click", () => {
    if (contextMenu.isOpen(anchor)) contextMenu.close();
    else void showSpaceMenu({ anchor });
  });
  // The same menu, but only the click toggles: a right-click never closes it.
  anchor.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!contextMenu.isOpen(anchor)) void showSpaceMenu({ anchor });
  });

  return { openAt: (at) => void showSpaceMenu({ at }) };
}
