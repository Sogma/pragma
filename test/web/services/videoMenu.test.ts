// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { type Look, NO_LOOK } from "../../../web/lib/videoLut.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuTileSection } from "../../../web/services/menus.ts";
import { guidesMenuItem, lutsMenuItem, videoMoreOptions } from "../../../web/services/videoMenu.ts";
import { memorySetting } from "../support/editorLayout.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

describe("videoMoreOptions", () => {
  // Guides and Looks, then the Bookmark items the tree's and a tab's menus offer, for the clip's file.
  it("opens Guides and Looks above the clip's Bookmark items under its button, and closes them from it", () => {
    const contextMenu = fakeContextMenu();
    const anchor = document.createElement("button");
    const open = videoMoreOptions(contextMenu, "lib:takes/a.mp4");

    open(anchor);
    expect(contextMenu.opened).toHaveLength(1);
    const [options] = contextMenu.opened;
    expect(options.items?.[0]).toMatchObject({ label: "Guides", group: "guides" });
    expect(options.items?.[1]).toMatchObject({ label: "Looks", group: "guides" });
    expect(options.items?.slice(2)).toEqual([
      { command: "bookmarks.add", group: "bookmark" },
      { command: "bookmarks.remove", group: "bookmark" },
    ]);
    expect(options).toMatchObject({
      arg: { file: "lib:takes/a.mp4", bookmark: "lib:takes/a.mp4" },
      anchor,
      align: "end",
      ariaLabel: "More options",
    });
    expect(contextMenu.isOpen(anchor)).toBe(true);

    open(anchor);
    expect(contextMenu.isOpen()).toBe(false);
    expect(contextMenu.opened).toHaveLength(1);
  });
});

describe("lutsMenuItem", () => {
  // A look grades pixels, which a vector image has none of.
  it("offers Looks for a clip or a raster still, never for a vector image", () => {
    const { when } = lutsMenuItem(memorySetting<Look>(NO_LOOK));
    const offered = (file: string) => when?.(context, { file, bookmark: file });
    expect([offered("takes/a.mp4"), offered("stills/a.png"), offered("art/logo.svg")]).toEqual([true, true, false]);
    expect(when?.(context, undefined)).toBe(true);
  });

  it("opens Looks onto Panchromatic and Orthochromatic, the one on checked, turning it on and off for every player", () => {
    const lut = memorySetting<Look>(NO_LOOK);
    const { label, submenu } = lutsMenuItem(lut);
    const rows = typeof submenu === "function" ? submenu(context, undefined) : (submenu ?? []);
    expect(label).toBe("Looks");
    expect(rows.map((row) => row.label)).toEqual(["Panchromatic", "Orthochromatic"]);
    const [panchromatic, orthochromatic] = rows;
    expect(panchromatic.checked?.(context, undefined)).toBe(false);

    panchromatic.run?.(context, undefined);
    expect(lut.get()).toEqual({ lut: "panchromatic", on: true });
    expect(panchromatic.checked?.(context, undefined)).toBe(true);

    orthochromatic.run?.(context, undefined);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: true });
    expect(panchromatic.checked?.(context, undefined)).toBe(false);
    expect(orthochromatic.checked?.(context, undefined)).toBe(true);

    // Off, the look is kept for the LOOK badge and D to bring back.
    orthochromatic.run?.(context, undefined);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: false });
    expect(orthochromatic.checked?.(context, undefined)).toBe(false);

    panchromatic.run?.(context, undefined);
    expect(lut.get()).toEqual({ lut: "panchromatic", on: true });
  });
});

describe("guidesMenuItem", () => {
  function sections(guides = memorySetting(NO_GUIDES)): MenuTileSection[] {
    const { tiles } = guidesMenuItem(guides);
    return typeof tiles === "function" ? tiles(context, undefined) : (tiles ?? []);
  }

  it("holds Social media, Broadcast and film, and Safe area, each tile with its glyph", () => {
    const [social, film, safe] = sections();
    expect([social.label, film.label, safe.label]).toEqual(["Social media", "Broadcast and film", "Safe area"]);
    expect([social, film, safe].map((section) => section.tiles.map((tile) => tile.label))).toEqual([
      ["1:1", "4:5", "9:16", "1.91:1", "16:9"],
      ["None", "1.33", "1.77", "1.85", "2.39"],
      ["Extents", "Social", "Action", "Title", "Center"],
    ]);
    // 1.77 is 16:9 by another name, drawn the same.
    expect(film.tiles[2].glyph).toBe(social.tiles[4].glyph);
    expect(film.tiles[0].glyph).toBe("var(--icon-frame)");
    // Frames turn on and off by themselves, as the safe areas do; None is the one choice.
    const radios = (tiles: { radio?: boolean }[]) => tiles.map((tile) => tile.radio ?? false);
    expect([radios(social.tiles), radios(film.tiles), radios(safe.tiles)]).toEqual([
      [false, false, false, false, false],
      [true, false, false, false, false],
      [false, false, false, false, false],
    ]);
  });

  // With no frame on, None is lit and the guides keep the picture's own shape.
  it("turns frames of either row on and off by themselves, and None turns them all off", () => {
    const guides = memorySetting({ ...NO_GUIDES, shown: false });
    const [social, film] = sections(guides);
    const lit = () => [...social.tiles, ...film.tiles].filter((tile) => tile.checked()).map((tile) => tile.label);
    expect(lit()).toEqual(["None"]);

    social.tiles[2].pick();
    expect([guides.get().frames, lit(), guides.get().shown]).toEqual([["9:16"], ["9:16"], true]);
    film.tiles[4].pick();
    expect([guides.get().frames, lit()]).toEqual([
      ["9:16", "2.39"],
      ["9:16", "2.39"],
    ]);
    social.tiles[2].pick();
    expect([guides.get().frames, lit()]).toEqual([["2.39"], ["2.39"]]);

    social.tiles[0].pick();
    film.tiles[0].pick();
    expect([guides.get().frames, lit()]).toEqual([[], ["None"]]);
  });

  it("turns each safe area on and off by itself, a pick showing guides that G hid", () => {
    const guides = memorySetting({ ...NO_GUIDES, shown: false });
    const [, , safe] = sections(guides);
    const [, social, , title, center] = safe.tiles;

    title.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, title: true });
    center.pick();
    title.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true });
    expect([title.checked(), center.checked()]).toEqual([false, true]);
    social.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, social: true });
    expect(social.checked()).toBe(true);
  });
});
