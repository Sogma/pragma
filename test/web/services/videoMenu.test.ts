// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuRange, MenuTileSection } from "../../../web/services/menus.ts";
import {
  badgeMenus,
  guidesMenuItem,
  lutsMenuItem,
  MEDIA_MENU,
  menuContext,
  moreOptionsMenu,
} from "../../../web/services/videoMenu.ts";
import { memorySetting, memoryViews } from "../support/editorLayout.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

describe("moreOptionsMenu", () => {
  // The one menu every media file's ⋮ opens; editorArea.test.ts resolves its rows.
  it("opens the media menu for the file under its button, and closes it from there", () => {
    const contextMenu = fakeContextMenu();
    const anchor = document.createElement("button");
    const open = moreOptionsMenu(contextMenu, "lib:takes/a.mp4", { context: () => "projects/film" });

    open(anchor);
    expect(contextMenu.opened).toEqual([
      {
        menu: MEDIA_MENU,
        arg: { file: "lib:takes/a.mp4", bookmark: "lib:takes/a.mp4", context: "projects/film" },
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

  // A right-click on the media opens it where it lands, even over one opened before.
  it("opens the menu at a right-click's point, still standing for its button", () => {
    const contextMenu = fakeContextMenu();
    const anchor = document.createElement("button");
    const open = moreOptionsMenu(contextMenu, "art/a.png", { context: () => "" });
    open(anchor, undefined, { x: 40, y: 60 });
    expect(contextMenu.opened[0]).toMatchObject({ menu: MEDIA_MENU, anchor, at: { x: 40, y: 60 } });
    expect(anchor.getAttribute("aria-expanded")).toBe("true");

    open(anchor, undefined, { x: 80, y: 90 });
    expect([contextMenu.opened.length, contextMenu.opened[1]?.at, contextMenu.isOpen(anchor)]).toEqual([
      2,
      { x: 80, y: 90 },
      true,
    ]);
  });

  // Read as it opens: the viewer's tab may be seen in another context by then.
  it("names the context the viewer is seen in as the menu opens", () => {
    const contextMenu = fakeContextMenu();
    let context = "a";
    const open = moreOptionsMenu(contextMenu, "takes/a.mp4", { context: () => context });
    context = "b";
    open(document.createElement("button"));
    expect(menuContext(contextMenu.opened[0]?.arg)).toBe("b");
    // An argument naming none is the space's own.
    expect([menuContext(undefined), menuContext({ file: "takes/a.mp4" })]).toEqual(["", ""]);
  });

  it("says so in the menu's argument for a viewer that shows no look", () => {
    const contextMenu = fakeContextMenu();
    moreOptionsMenu(contextMenu, "takes/a.mp4", { looks: false, context: () => "" })(document.createElement("button"));
    expect(contextMenu.opened[0]).toMatchObject({
      menu: MEDIA_MENU,
      arg: { file: "takes/a.mp4", bookmark: "takes/a.mp4", looks: false },
    });
  });

  it("says so in the menu's argument for a viewer that draws no guides", () => {
    const contextMenu = fakeContextMenu();
    moreOptionsMenu(contextMenu, "takes/a.mp4", { guides: false, context: () => "" })(document.createElement("button"));
    expect(contextMenu.opened[0]?.arg).toEqual({
      file: "takes/a.mp4",
      bookmark: "takes/a.mp4",
      guides: false,
      context: "",
    });
  });

  // Save frame reads it from there; a still's ⋮ passes none.
  it("carries the frame a player offers in the menu's argument", () => {
    const contextMenu = fakeContextMenu();
    const frame = vi.fn();
    const open = moreOptionsMenu(contextMenu, "takes/a.mp4", { looks: false, context: () => "" });
    open(document.createElement("button"), frame);
    expect(contextMenu.opened[0]?.arg).toEqual({
      file: "takes/a.mp4",
      bookmark: "takes/a.mp4",
      looks: false,
      context: "",
      frame,
    });
    expect(frame).not.toHaveBeenCalled();
  });
});

describe("lutsMenuItem", () => {
  // A look grades pixels, which a vector image has none of.
  it("offers Looks for a clip or a raster still, never for a vector image", () => {
    const { when } = lutsMenuItem(memoryViews().views);
    const offered = (file: string) => when?.(context, { file, bookmark: file });
    expect([offered("takes/a.mp4"), offered("stills/a.png"), offered("art/logo.svg")]).toEqual([true, true, false]);
    expect(when?.(context, undefined)).toBe(true);
  });

  // A Flow's clip shows no look, having no LOOK badge to say one is on.
  it("leaves Looks out of a viewer that shows no look", () => {
    const { when } = lutsMenuItem(memoryViews().views);
    expect(when?.(context, { file: "takes/a.mp4", bookmark: "takes/a.mp4", looks: false })).toBe(false);
  });

  it("opens Looks onto Pragma's own Panchromatic and Orthochromatic, the one on checked, turning it on and off for every player in the context", () => {
    const held = memoryViews();
    const lut = held.of("projects/film").look;
    const { label, submenu } = lutsMenuItem(held.views);
    const arg = { file: "takes/a.mp4", bookmark: "takes/a.mp4", context: "projects/film" };
    const rows = typeof submenu === "function" ? submenu(context, arg) : (submenu ?? []);
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
    // Another context's look is its own.
    expect(held.of("").look.get()).toEqual({ lut: null, on: false });
  });
});

describe("lutsMenuItem's preview", () => {
  it("tries a look on the picture while it is pointed at, and ends the try after", () => {
    const held = memoryViews();
    const lut = held.of("").look;
    const { submenu } = lutsMenuItem(held.views);
    const rows = typeof submenu === "function" ? submenu(context, undefined) : (submenu ?? []);
    rows[1].preview?.show();
    expect(lut.tryLook).toHaveBeenLastCalledWith("panchromatic");
    rows[1].preview?.end();
    expect(lut.tryLook).toHaveBeenLastCalledWith(null);
  });
});

describe("guidesMenuItem", () => {
  // The tiles of the menu opened in `at`, setting `guides` there.
  function sections(guides = memorySetting(NO_GUIDES), at = "projects/film"): MenuTileSection[] {
    const held = memoryViews();
    const { tiles } = guidesMenuItem((asked) => (asked === at ? { ...held.of(asked), guides } : held.of(asked)));
    const arg = { file: "takes/a.mp4", bookmark: "takes/a.mp4", context: at };
    return typeof tiles === "function" ? tiles(context, arg) : (tiles ?? []);
  }

  // A Flow's clip draws no guides, so a pick there would change nothing on it.
  it("is offered on every viewer but one that draws no guides", () => {
    const { when } = guidesMenuItem(memoryViews().views);
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
      ["Cross", "Angles", "3x3"],
    ]);
    expect(markers.tiles.map((tile) => tile.glyph)).toEqual([
      "var(--icon-marker-cross)",
      "var(--icon-marker-level)",
      "var(--icon-marker-thirds)",
    ]);
    // 1.77 is 16:9 by another name, drawn the same.
    expect(film.tiles[2].glyph).toBe(social.tiles[4].glyph);
    expect(film.tiles[0].glyph).toBe("var(--icon-frame)");
    // Frames turn on and off by themselves, as the safe areas do; None is the one choice.
    const radios = (tiles: { radio?: boolean }[]) => tiles.map((tile) => tile.radio ?? false);
    expect([radios(social.tiles), radios(film.tiles), radios(safe.tiles), radios(markers.tiles)]).toEqual([
      [false, false, false, false, false],
      [true, false, false, false, false],
      [false, false, false, false, false],
      [false, false, false],
    ]);
  });

  // With no frame on, None is lit and the guides keep the picture's own shape.
  it("sets the guides of the context the menu was opened in, and no other's", () => {
    const held = memoryViews();
    const { tiles } = guidesMenuItem(held.views);
    const opened = (at: string) => {
      const arg = { file: "takes/a.mp4", bookmark: "takes/a.mp4", context: at };
      return typeof tiles === "function" ? tiles(context, arg) : (tiles ?? []);
    };
    opened("projects/film")[1].tiles[4].pick();
    opened("projects/social")[0].tiles[2].pick();
    expect(held.of("projects/film").guides.get().frames).toEqual(["2.39"]);
    expect(held.of("projects/social").guides.get().frames).toEqual(["9:16"]);
    expect(held.of("").guides.get().frames).toEqual([]);
  });

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

  // Under both rows of frames, since it frames every one of them.
  it("sets the protection kept around every frame, 0 to 25%, under Broadcast and film", () => {
    const guides = memorySetting({ ...NO_GUIDES, shown: false });
    const all = sections(guides);
    expect(all.map((section) => section.range?.label)).toEqual([undefined, "Protection", undefined, undefined]);
    const range = all[1].range as MenuRange;
    expect([range.min, range.max, range.step, range.value(), range.format(7)]).toEqual([0, 25, 1, 0, "7%"]);
    range.change(7);
    expect(guides.get()).toEqual({ ...NO_GUIDES, protection: 0.07 });
    expect(range.value()).toBe(7);
  });

  it("turns each safe area and frame marker on and off by itself, a pick showing guides that G hid", () => {
    const guides = memorySetting({ ...NO_GUIDES, shown: false });
    const [, , safe, markers] = sections(guides);
    const [, social, , title, center] = safe.tiles;
    const [cross, level, thirds] = markers.tiles;

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
    thirds.pick();
    expect(guides.get()).toEqual({ ...NO_GUIDES, center: true, social: true, cross: true, level: true, thirds: true });
    expect(thirds.checked()).toBe(true);
  });
});

describe("badgeMenus", () => {
  // A right-click on a viewer's guides switch or LOOK badge opens that row's
  // flyout from the ⋮'s menu, alone.
  it("opens the Guides tiles or the Looks list alone where the badge is right-clicked, for the context it is seen in then", () => {
    const contextMenu = fakeContextMenu();
    const held = memoryViews();
    let seen = "projects/film";
    const menus = badgeMenus(contextMenu, () => seen, held.views);
    const [guides, look] = [document.createElement("button"), document.createElement("button")];

    seen = "projects/social";
    menus.guides(guides, { x: 40, y: 12 });
    const tilesOpen = contextMenu.opened.at(-1);
    expect(tilesOpen).toMatchObject({ anchor: guides, at: { x: 40, y: 12 }, arg: { context: "projects/social" } });
    const tiles = tilesOpen?.flyoutOf?.tiles;
    const sections = typeof tiles === "function" ? tiles(context, tilesOpen?.arg) : (tiles ?? []);
    expect([tilesOpen?.flyoutOf?.label, sections.map((section) => section.label)]).toEqual([
      "Guides",
      ["Social media", "Broadcast and film", "Safe area", "Frame markers"],
    ]);
    sections[0].tiles[2].pick();
    expect(held.of("projects/social").guides.get().frames).toEqual(["9:16"]);

    menus.looks(look, { x: 80, y: 12 });
    const listOpen = contextMenu.opened.at(-1);
    const submenu = listOpen?.flyoutOf?.submenu;
    const rows = typeof submenu === "function" ? submenu(context, listOpen?.arg) : (submenu ?? []);
    expect([listOpen?.flyoutOf?.label, rows.map((row) => row.label), guides.getAttribute("aria-expanded")]).toEqual([
      "Looks",
      ["Pragma", "Panchromatic", "Orthochromatic"],
      "false",
    ]);
    expect(typeof listOpen?.flyoutOf?.search).toBe("function");
    rows[1].run?.(context, undefined);
    expect(held.of("projects/social").look.get()).toEqual({ lut: "panchromatic", on: true });
  });

  // A press on the badge, which the menu leaves open as it stands for it.
  it("closes a badge's own menu when called with no point, and opens none", () => {
    const contextMenu = fakeContextMenu();
    const menus = badgeMenus(contextMenu, () => "", memoryViews().views);
    const [guides, look] = [document.createElement("button"), document.createElement("button")];
    menus.looks(look, { x: 0, y: 0 });
    menus.guides(guides);
    expect(contextMenu.isOpen(look)).toBe(true);
    menus.looks(look);
    expect([contextMenu.isOpen(), contextMenu.opened.length]).toEqual([false, 1]);
  });
});
