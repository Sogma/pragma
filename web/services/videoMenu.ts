// A video player's More options menu: Guides and Looks, then Bookmark or
// Remove from Bookmarks for the clip's file, the items the tree's and a
// tab's menus offer, or a menu a surface registers with more, as the
// preview does with the ways to open it.
//
// The argument names the file twice, as a Bookmarks row's does: `file` for
// the open commands, `bookmark` for the bookmark ones. A command that finds
// no file in it hides its item.
import {
  FILM_FRAMES,
  type FrameChoice,
  type GuideFrame,
  type Guides,
  type GuidesChoice,
  SOCIAL_FRAMES,
} from "../lib/videoGuides.ts";
import { LOOKS, type LutChoice, type LutName } from "../lib/videoLut.ts";
import type { ContextMenuService, MenuItem, MenuTile } from "./menus.ts";
import { videoGuides, videoLut } from "./settings.ts";

// Each frame's glyph: its shape cut from a wider box. 1.77 is 16:9.
const FRAME_GLYPHS: Record<GuideFrame, string> = {
  default: "var(--icon-frame)",
  "1:1": "var(--icon-frame-1-1)",
  "4:5": "var(--icon-frame-4-5)",
  "9:16": "var(--icon-frame-9-16)",
  "1.91:1": "var(--icon-frame-1-91)",
  "16:9": "var(--icon-frame-16-9)",
  "1.33": "var(--icon-frame-1-33)",
  "1.77": "var(--icon-frame-16-9)",
  "1.85": "var(--icon-frame-1-85)",
  "2.39": "var(--icon-frame-2-39)",
};

type SafeArea = "extents" | "action" | "title" | "center" | "social";

const SAFE_AREAS: { key: SafeArea; label: string; glyph: string; tooltip: string }[] = [
  { key: "extents", label: "Extents", glyph: "var(--icon-safe-extents)", tooltip: "The frame's edge" },
  {
    key: "social",
    label: "Social",
    glyph: "var(--icon-safe-social)",
    tooltip: "Social safe, clear of a feed's buttons and captions",
  },
  { key: "action", label: "Action", glyph: "var(--icon-safe-action)", tooltip: "Action safe, 93% of the frame" },
  { key: "title", label: "Title", glyph: "var(--icon-safe-title)", tooltip: "Title safe, 90% of the frame" },
  { key: "center", label: "Center", glyph: "var(--icon-safe-center)", tooltip: "The frame's center" },
];

/** The Guides row every player's More options holds above Bookmark: tiles
 * setting the guides all players share. A pick shows the guides again if G
 * hid them, and the lit frame picked again goes back to Default. */
export function guidesMenuItem(guides: GuidesChoice = videoGuides): MenuItem {
  const change = (patch: Partial<Guides>) => guides.set({ ...guides.get(), ...patch, shown: true });
  const frameTiles = (frames: readonly FrameChoice[]): MenuTile[] =>
    frames.map((frame) => ({
      label: frame.label,
      glyph: FRAME_GLYPHS[frame.id],
      radio: true,
      checked: () => guides.get().frame === frame.id,
      pick: () => change({ frame: guides.get().frame === frame.id ? "default" : frame.id }),
    }));
  const safeTiles = (): MenuTile[] =>
    SAFE_AREAS.map((area) => ({
      label: area.label,
      glyph: area.glyph,
      tooltip: area.tooltip,
      checked: () => guides.get()[area.key],
      pick: () => {
        const next: Guides = { ...guides.get(), shown: true };
        next[area.key] = !next[area.key];
        guides.set(next);
      },
    }));
  return {
    label: "Guides",
    group: "guides",
    tiles: () => [
      { label: "Social media", tiles: frameTiles(SOCIAL_FRAMES) },
      { label: "Broadcast and film", tiles: frameTiles(FILM_FRAMES) },
      { label: "Safe area", tiles: safeTiles() },
    ],
  };
}

/** The Looks row under Guides, in their section: a flyout of the LUTs every
 * player can show its picture through. Picking the one on turns it off and
 * keeps it, for a clip's LOOK badge to turn back on. */
export function lutsMenuItem(lut: LutChoice = videoLut): MenuItem {
  const isOn = (name: LutName) => lut.get().on && lut.get().lut === name;
  return {
    label: "Looks",
    group: "guides",
    submenu: LOOKS.map(({ lut: name, label }) => ({
      label,
      checked: () => isOn(name),
      run: () => lut.set({ lut: name, on: !isOn(name) }),
    })),
  };
}

/** Opens the menu for the clip at `path` under its button, or closes it
 * there: the registered `menu`, or Guides, Looks and the clip's Bookmark
 * items. */
export function videoMoreOptions(
  contextMenu: ContextMenuService,
  path: string,
  menu?: string,
  guides: GuidesChoice = videoGuides,
  lut: LutChoice = videoLut,
): (anchor: HTMLElement) => void {
  return (anchor) => {
    if (contextMenu.isOpen(anchor)) contextMenu.close();
    else {
      const items: MenuItem[] = [
        guidesMenuItem(guides),
        lutsMenuItem(lut),
        { command: "bookmarks.add", group: "bookmark" },
        { command: "bookmarks.remove", group: "bookmark" },
      ];
      contextMenu.open({
        ...(menu === undefined ? { items } : { menu }),
        arg: { file: path, bookmark: path },
        anchor,
        align: "end",
        ariaLabel: "More options",
      });
    }
  };
}
