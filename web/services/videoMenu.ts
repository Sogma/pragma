// The More options menu of a media file, the one every ⋮ over a clip or a
// still opens: in the preview, the video and image tabs and a Flow's clips.
// One registered menu, so no surface's list drifts from another's: the ways
// to open the file, Guides and Looks, then Bookmark or Remove from Bookmarks.
//
// The argument names the file twice, as a Bookmarks row's does: `file` for
// the open commands, `bookmark` for the bookmark ones. A command that finds
// no file in it hides its item. `looks: false` comes from a viewer with no
// LOOK badge, whose picture shows no look, and leaves Looks out, and
// `guides: false` from one that draws no guides, leaving Guides out.
//
// A player adds `frame` once a frame is on screen, for Save frame to take.
import { vectorImageMediaTypeForPath } from "../../src/protocol/types.ts";
import {
  FILM_FRAMES,
  type FrameChoice,
  type GuideFrame,
  type Guides,
  type GuidesChoice,
  MAX_PROTECTION,
  SOCIAL_FRAMES,
  toggleFrame,
} from "../lib/videoGuides.ts";
import { LOOKS, type LutChoice, lookLabel } from "../lib/videoLut.ts";
import type { FrameGrab } from "../lib/videoPlayer.ts";
import { looks } from "./looks.ts";
import type { ContextMenuService, MenuItem, MenuRange, MenuTile } from "./menus.ts";
import { type PresetRow, presetMenuItems, presetSearch, presetSources } from "./presetMenu.ts";
import { videoGuides } from "./settings.ts";

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

interface GuideTile {
  key: "extents" | "action" | "title" | "center" | "social" | "cross" | "level";
  label: string;
  glyph: string;
  tooltip: string;
}

const SAFE_AREAS: GuideTile[] = [
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

// Marks of the whole picture, whatever frames are cut from it.
const FRAME_MARKERS: GuideTile[] = [
  {
    key: "cross",
    label: "Cross",
    glyph: "var(--icon-marker-cross)",
    tooltip: "Lines across the whole picture, through its center",
  },
  {
    key: "level",
    label: "Level",
    glyph: "var(--icon-marker-level)",
    tooltip: "A camera's level display: horizon line, tilt marks and focus area",
  },
];

/** The Guides row above Bookmark in the More options of a player that draws
 * guides: tiles setting the guides those players share. A pick shows the
 * guides again if G hid them. Each frame turns on and off by itself, and
 * None, lit while no frame is on, turns them all off. Protection, under the
 * frames, keeps a share of every frame around its framing. */
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
  const protection: MenuRange = {
    label: "Protection",
    min: 0,
    max: Math.round(MAX_PROTECTION * 100),
    step: 1,
    tooltip: "Room kept around each frame",
    value: () => Math.round(guides.get().protection * 100),
    format: (percent) => `${percent}%`,
    change: (percent) => change({ protection: percent / 100 }),
  };
  const toggleTiles = (list: readonly GuideTile[]): MenuTile[] =>
    list.map((guide) => ({
      label: guide.label,
      glyph: guide.glyph,
      tooltip: guide.tooltip,
      checked: () => guides.get()[guide.key],
      pick: () => {
        const next: Guides = { ...guides.get(), shown: true };
        next[guide.key] = !next[guide.key];
        guides.set(next);
      },
    }));
  return {
    label: "Guides",
    group: "guides",
    when: (_, arg) => drawsGuides(arg),
    tiles: () => [
      { label: "Social media", tiles: frameTiles(SOCIAL_FRAMES) },
      { label: "Broadcast and film", tiles: [none, ...frameTiles(FILM_FRAMES)], range: protection },
      { label: "Safe area", tiles: toggleTiles(SAFE_AREAS) },
      { label: "Frame markers", tiles: toggleTiles(FRAME_MARKERS) },
    ],
  };
}

// Pragma's own looks, after the space's and its libraries'.
const PRAGMA_LOOKS: PresetRow[] = LOOKS.map(({ lut, label }) => ({
  path: lut,
  label,
  icon: { glyph: "lut" },
  pragma: true,
}));

/** The Looks row under Guides: a flyout of the LUTs a viewer with a LOOK
 * badge shows its picture through, searched by name. Pointing at one tries
 * it on the picture; picking the one on turns it off and keeps it, for the
 * badge to turn back on. A vector image has no pixels to grade, so its menu
 * leaves the row out, as does a viewer with no badge. */
export function lutsMenuItem(lut: LutChoice & { tryLook(lut: string | null): void } = looks): MenuItem {
  const kept = () => lut.kept?.() ?? lut.get();
  const isOn = (name: string) => kept().on && kept().lut === name;
  const leaf = (row: PresetRow): MenuItem => ({
    label: row.label,
    checked: () => isOn(row.path),
    run: () => lut.set({ lut: row.path, on: !isOn(row.path) }),
    preview: { show: () => lut.tryLook(row.path), end: () => lut.tryLook(null) },
    ...(row.pragma ? {} : { tooltip: row.path }),
  });
  const sources = () => presetSources("luts", PRAGMA_LOOKS);
  // A kept look whose file is gone heads the list, saying so.
  const missing = (): MenuItem[] => {
    const name = kept().lut;
    if (!lut.missing?.() || name === null) return [];
    const row = { label: lookLabel(name), icon: true, entryIcon: { glyph: "lut" as const }, detail: "Missing" };
    return [{ ...row, group: "missing", className: "is-missing" }];
  };
  return {
    label: "Looks",
    group: "guides",
    when: (_, arg) => showsLooks(arg),
    search: () => presetSearch(sources(), "Search looks", leaf),
    submenu: () => [...missing(), ...presetMenuItems(sources(), leaf)],
  };
}

// Whether a menu's argument comes from a viewer that draws guides.
function drawsGuides(arg: unknown): boolean {
  return typeof arg !== "object" || arg === null || (arg as { guides?: unknown }).guides !== false;
}

// Whether a menu's argument comes from a viewer that shows looks, over a
// file with pixels to grade.
function showsLooks(arg: unknown): boolean {
  if (typeof arg !== "object" || arg === null) return true;
  const { file, looks } = arg as { file?: unknown; looks?: unknown };
  return looks !== false && (typeof file !== "string" || vectorImageMediaTypeForPath(file) === undefined);
}

/** The menu a media file's ⋮ opens, given `{ file, bookmark, looks?, guides?, frame? }`. */
export const MEDIA_MENU = "media.more";

/** Opens `menu` for the file at `path` under its ⋮, or closes it there. A
 * viewer with no LOOK badge passes `looks: false`, and one that draws no
 * guides `guides: false`; a player passes `frame` with each open. */
export function moreOptionsMenu(
  contextMenu: ContextMenuService,
  path: string,
  { menu = MEDIA_MENU, looks = true, guides = true }: { menu?: string; looks?: boolean; guides?: boolean } = {},
): (anchor: HTMLElement, frame?: () => FrameGrab) => void {
  const base = { file: path, bookmark: path, ...(looks ? {} : { looks: false }), ...(guides ? {} : { guides: false }) };
  return (anchor, frame) => {
    if (contextMenu.isOpen(anchor)) contextMenu.close();
    else {
      contextMenu.open({
        menu,
        arg: frame ? { ...base, frame } : base,
        anchor,
        align: "end",
        ariaLabel: "More options",
      });
    }
  };
}
