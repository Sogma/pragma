// The spaces the page offers to switch to, and the switch itself. The space
// switcher's menu and the menu bar's Switch Space list the same spaces.
import { type fetchSpaceList, postSwitchSpace } from "../core/apiClient.ts";
import type { MenuItem } from "./menus.ts";

// What a menu row needs, flattened out of SpaceRef: one display name, and
// the path a switch names.
export type SpaceEntry = { name: string; path: string; current: boolean };
// hidden: registered spaces the cap left out, which is what "More…" counts.
export type RecentSpaces = { entries: SpaceEntry[]; hidden: number; failed: boolean };

/** The most recently opened spaces (capped in loadConfig.ts), the one this
 * server serves marked current. Deliberately the short list, not the whole
 * registry: this is navigation, and Manage Spaces holds the complete list. */
export async function loadRecentSpaces(fetch: () => ReturnType<typeof fetchSpaceList>): Promise<RecentSpaces> {
  try {
    const { current, recent, spaces } = await fetch();
    const all = recent.some((space) => space.path === current.path) ? recent : [current, ...recent];
    return {
      entries: all.map(({ label, name, path }) => ({ name: label || name, path, current: path === current.path })),
      // Floored at zero: an unregistered served space is prepended to `all`
      // without being in `spaces`, which would otherwise read as -1.
      hidden: Math.max(0, spaces.length - all.length),
      failed: false,
    };
  } catch {
    return { entries: [], hidden: 0, failed: true };
  }
}

/** A row per space, the current one checked; picking one switches to it. */
export function recentSpaceRows(spaces: RecentSpaces): MenuItem[] {
  if (spaces.failed) return [{ label: "Failed to load spaces" }];
  return spaces.entries.map((space) => ({
    command: "space.switch",
    label: space.name,
    arg: space,
    checked: () => space.current,
    group: "spaces",
  }));
}

/** Serves the registered space at `path` and reloads the page onto it. */
export async function switchSpace(path: string): Promise<void> {
  try {
    await postSwitchSpace(path);
    window.location.reload();
  } catch {
    window.alert("Failed to switch space.");
  }
}
