// The More options menu of a media file, the one every ⋮ over a clip or a
// still opens: in the preview, the video and image tabs and a Flow's clips.
// One registered menu, so no surface's list drifts from another's: the ways
// to open the file, Guides and Looks, then Bookmark or Remove from Bookmarks.
//
// The argument names the file twice, as a Bookmarks row's does: `file` for
// the open commands, `bookmark` for the bookmark ones. A command that finds
// no file in it hides its item. `looks: false` comes from a viewer with no
// LOOK badge, whose picture shows no look, and leaves Looks out.
import { vectorImageMediaTypeForPath } from "../../src/protocol/types.ts";
import {
  FILM_FRAMES,
  type FrameChoice,
  type GuideFrame,
  type Guides,
  type GuidesChoice,
  SOCIAL_FRAMES,
  toggleFrame,
} from "../lib/videoGuides.ts";
import { LOOKS, type LutChoice, type LutName } from "../lib/videoLut.ts";
import type { ContextMenuService, MenuItem, MenuTile } from "./menus.ts";
import { videoGuides, videoLut } from "./settings.ts";

// Each frame's glyph: its shape cut from a wider box. 1.77 is 16:9.
const FRAME_GLYPHS: Record<GuideFrame, string> = {
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
 * hid them. Each frame turns on and off by itself, and None, lit while no
 * frame is on, turns them all off. */
export function guidesMenuItem(guides: GuidesChoice = videoGuides): MenuItem {
  const change = (patch: Partial<Guides>) => guides.set({ ...guides.get(), ...patch, shown: true });
  const frameTiles = (frames: readonly FrameChoice[]): MenuTile[] =>
    frames.map((frame) => ({
      label: frame.label,
      glyph: FRAME_GLYPHS[frame.id],
      checked: () => guides.get().frames.includes(frame.id),
      pick: () => change({ frames: toggleFrame(guides.get().frames, frame.id) }),
    }));
  const none: MenuTile = {
    label: "None",
    glyph: "var(--icon-frame)",
    radio: true,
    checked: () => guides.get().frames.length === 0,
    pick: () => change({ frames: [] }),
  };
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
      { label: "Broadcast and film", tiles: [none, ...frameTiles(FILM_FRAMES)] },
      { label: "Safe area", tiles: safeTiles() },
    ],
  };
}

/** The Looks row under Guides, in their section: a flyout of the LUTs a
 * viewer with a LOOK badge shows its picture through. Picking the one on
 * turns it off and keeps it, for the badge to turn back on. A vector image
 * has no pixels to grade, so its menu leaves the row out, as does a viewer
 * with no badge. */
export function lutsMenuItem(lut: LutChoice = videoLut): MenuItem {
  const isOn = (name: LutName) => lut.get().on && lut.get().lut === name;
  return {
    label: "Looks",
    group: "guides",
    when: (_, arg) => showsLooks(arg),
    submenu: LOOKS.map(({ lut: name, label }) => ({
      label,
      checked: () => isOn(name),
      run: () => lut.set({ lut: name, on: !isOn(name) }),
    })),
  };
}

// Whether a menu's argument comes from a viewer that shows looks, over a
// file with pixels to grade.
function showsLooks(arg: unknown): boolean {
  if (typeof arg !== "object" || arg === null) return true;
  const { file, looks } = arg as { file?: unknown; looks?: unknown };
  return looks !== false && (typeof file !== "string" || vectorImageMediaTypeForPath(file) === undefined);
}

/** The menu a media file's ⋮ opens, given `{ file, bookmark, looks? }`. */
export const MEDIA_MENU = "media.more";

/** Opens `menu` for the file at `path` under its ⋮, or closes it there. A
 * viewer with no LOOK badge passes `looks: false`. */
export function moreOptionsMenu(
  contextMenu: ContextMenuService,
  path: string,
  { menu = MEDIA_MENU, looks = true }: { menu?: string; looks?: boolean } = {},
): (anchor: HTMLElement) => void {
  const arg = looks ? { file: path, bookmark: path } : { file: path, bookmark: path, looks: false };
  return (anchor) => {
    if (contextMenu.isOpen(anchor)) contextMenu.close();
    else {
      contextMenu.open({
        menu,
        arg,
        anchor,
        align: "end",
        ariaLabel: "More options",
      });
    }
  };
}
