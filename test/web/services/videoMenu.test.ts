// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuTileSection } from "../../../web/services/menus.ts";
import { guidesMenuItem, lutsMenuItem, MEDIA_MENU, moreOptionsMenu } from "../../../web/services/videoMenu.ts";
import { memoryLook, memorySetting } from "../support/editorLayout.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

describe("moreOptionsMenu", () => {
  // The one menu every media file's ⋮ opens; editorArea.test.ts resolves its rows.
  it("opens the media menu for the file under its button, and closes it from there", () => {
    const contextMenu = fakeContextMenu();
    const anchor = document.createElement("button");
    const open = moreOptionsMenu(contextMenu, "lib:takes/a.mp4");

    open(anchor);
    expect(contextMenu.opened).toEqual([
      {
        menu: MEDIA_MENU,
        arg: { file: "lib:takes/a.mp4", bookmark: "lib:takes/a.mp4" },
        anchor,
        align: "end",
        ariaLabel: "More options",
      },
    ]);
    expect(contextMenu.isOpen(anchor)).toBe(true);

    open(anchor);
    expect(contextMenu.isOpen()).toBe(false);
    expect(contextMenu.opened).toHaveLength(1);
  });

  it("says so in the menu's argument for a viewer that shows no look", () => {
    const contextMenu = fakeContextMenu();
    moreOptionsMenu(contextMenu, "takes/a.mp4", { looks: false })(document.createElement("button"));
    expect(contextMenu.opened[0]).toMatchObject({
      menu: MEDIA_MENU,
      arg: { file: "takes/a.mp4", bookmark: "takes/a.mp4", looks: false },
    });
  });

  it("says so in the menu's argument for a viewer that draws no guides", () => {
    const contextMenu = fakeContextMenu();
    moreOptionsMenu(contextMenu, "takes/a.mp4", { guides: false })(document.createElement("button"));
    expect(contextMenu.opened[0]?.arg).toEqual({ file: "takes/a.mp4", bookmark: "takes/a.mp4", guides: false });
  });
});

describe("lutsMenuItem", () => {
  // A look grades pixels, which a vector image has none of.
  it("offers Looks for a clip or a raster still, never for a vector image", () => {
    const { when } = lutsMenuItem(Object.assign(memoryLook(), { tryLook: vi.fn() }));
    const offered = (file: string) => when?.(context, { file, bookmark: file });
    expect([offered("takes/a.mp4"), offered("stills/a.png"), offered("art/logo.svg")]).toEqual([true, true, false]);
    expect(when?.(context, undefined)).toBe(true);
  });

  // A Flow's clip shows no look, having no LOOK badge to say one is on.
  it("leaves Looks out of a viewer that shows no look", () => {
    const { when } = lutsMenuItem(Object.assign(memoryLook(), { tryLook: vi.fn() }));
    expect(when?.(context, { file: "takes/a.mp4", bookmark: "takes/a.mp4", looks: false })).toBe(false);
  });

  it("opens Looks onto Pragma's own Panchromatic and Orthochromatic, the one on checked, turning it on and off for every player", () => {
    const lut = Object.assign(memoryLook(), { tryLook: vi.fn() });
    const { label, submenu } = lutsMenuItem(lut);
    const rows = typeof submenu === "function" ? submenu(context, undefined) : (submenu ?? []);
    expect(label).toBe("Looks");
    expect(rows.map((row) => row.label)).toEqual(["Pragma", "Panchromatic", "Orthochromatic"]);
    const [, panchromatic, orthochromatic] = rows;
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

describe("lutsMenuItem's preview", () => {
  it("tries a look on the picture while it is pointed at, and ends the try after", () => {
    const lut = Object.assign(memoryLook(), { tryLook: vi.fn() });
    const { submenu } = lutsMenuItem(lut);
    const rows = typeof submenu === "function" ? submenu(context, undefined) : (submenu ?? []);
    rows[1].preview?.show();
    expect(lut.tryLook).toHaveBeenLastCalledWith("panchromatic");
    rows[1].preview?.end();
    expect(lut.tryLook).toHaveBeenLastCalledWith(null);
  });
});

describe("guidesMenuItem", () => {
  function sections(guides = memorySetting(NO_GUIDES)): MenuTileSection[] {
    const { tiles } = guidesMenuItem(guides);
    return typeof tiles === "function" ? tiles(context, undefined) : (tiles ?? []);
  }

  // A Flow's clip draws no guides, so a pick there would change nothing on it.
  it("is offered on every viewer but one that draws no guides", () => {
    const { when } = guidesMenuItem(memorySetting(NO_GUIDES));
    const offered = (arg: unknown) => when?.(context, arg);
    expect([
      offered({ file: "takes/a.mp4", bookmark: "takes/a.mp4" }),
      offered({ file: "stills/a.png", bookmark: "stills/a.png", looks: false }),
      offered(undefined),
      offered({ file: "takes/a.mp4", bookmark: "takes/a.mp4", looks: false, guides: false }),
    ]).toEqual([true, true, true, false]);
  });

  it("holds Social media, Broadcast and film, Safe area and Frame markers, each tile with its glyph", () => {
    const [social, film, safe, markers] = sections();
    expect(sections().map((section) => section.label)).toEqual([
      "Social media",
      "Broadcast and film",
      "Safe area",
      "Frame markers",
    ]);
    expect([social, film, safe, markers].map((section) => section.tiles.map((tile) => tile.label))).toEqual([
      ["1:1", "4:5", "9:16", "1.91:1", "16:9"],
      ["None", "1.33", "1.77", "1.85", "2.39"],
      ["Extents", "Social", "Action", "Title", "Center"],
      ["Cross", "Level"],
    ]);
    expect(markers.tiles.map((tile) => tile.glyph)).toEqual(["var(--icon-marker-cross)", "var(--icon-marker-level)"]);
    // 1.77 is 16:9 by another name, drawn the same.
    expect(film.tiles[2].glyph).toBe(social.tiles[4].glyph);
    expect(film.tiles[0].glyph).toBe("var(--icon-frame)");
    // Frames turn on and off by themselves, as the safe areas do; None is the one choice.
    const radios = (tiles: { radio?: boolean }[]) => tiles.map((tile) => tile.radio ?? false);
    expect([radios(social.tiles), radios(film.tiles), radios(safe.tiles), radios(markers.tiles)]).toEqual([
      [false, false, false, false, false],
      [true, false, false, false, false],
      [false, false, false, false, false],
      [false, false],
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

  it("turns each safe area and frame marker on and off by itself, a pick showing guides that G hid", () => {
    const guides = memorySetting({ ...NO_GUIDES, shown: false });
    const [, , safe, markers] = sections(guides);
    const [, social, , title, center] = safe.tiles;
    const [cross, level] = markers.tiles;

    title.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, title: true });
    center.pick();
    title.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true });
    expect([title.checked(), center.checked()]).toEqual([false, true]);
    social.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, social: true });
    expect(social.checked()).toBe(true);
    cross.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, social: true, cross: true });
    expect(cross.checked()).toBe(true);
    level.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, social: true, cross: true, level: true });
    expect(level.checked()).toBe(true);
  });
});
