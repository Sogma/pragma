import { afterEach, describe, expect, it } from "vitest";
import { setPresets } from "../../../web/core/presets.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuItem } from "../../../web/services/menus.ts";
import {
  countPresets,
  type PresetRow,
  presetFolderItems,
  presetMenuItems,
  presetSearch,
  presetSources,
} from "../../../web/services/presetMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
const leaf = (row: PresetRow): MenuItem => ({ label: row.label, run: () => undefined });
const shown = (items: MenuItem[]) =>
  items.map((item) => [item.label, item.detail, item.submenu ? "flyout" : item.run ? "pick" : "heading"]);

const PRAGMA: PresetRow[] = [{ path: "panchromatic", label: "Panchromatic", icon: { glyph: "lut" }, pragma: true }];

afterEach(() => setPresets({ folders: [] }));

describe("the preset menu", () => {
  it("lists each source under its heading, in the file's order, Pragma's own last", () => {
    setPresets({
      folders: [
        {
          kind: "luts",
          written: "lib:film/",
          path: "lib:film",
          library: { id: "film", label: "Film Emulation" },
          luts: [
            {
              kind: "group",
              name: "Print",
              path: "lib:film/Print",
              entries: [{ kind: "lut", name: "2383.cube", path: "lib:film/Print/2383.cube" }],
            },
            { kind: "lut", name: "Bleach.cube", path: "lib:film/Bleach.cube" },
          ],
        },
        {
          kind: "luts",
          written: "looks/",
          path: "looks",
          luts: [{ kind: "lut", name: "warm.cube", path: "looks/warm.cube" }],
        },
        { kind: "luts", written: "gone/", path: "gone", missing: "folder" },
      ],
    });
    const sources = presetSources("luts", PRAGMA);
    expect(shown(presetMenuItems(sources, leaf))).toEqual([
      ["Film Emulation", undefined, "heading"],
      ["Print", undefined, "flyout"],
      ["Bleach", undefined, "pick"],
      ["This space", undefined, "heading"],
      ["looks", undefined, "flyout"],
      ["gone", "Missing", "heading"],
      ["Pragma", undefined, "heading"],
      ["Panchromatic", undefined, "pick"],
    ]);
    expect(countPresets(sources)).toBe(3);
    const items = presetMenuItems(sources, leaf);
    const setIn = items.filter((item) => item.className?.split(" ").includes("context-menu-indented"));
    expect(setIn.map((item) => item.label)).toEqual(["Print", "Bleach", "looks", "gone", "Panchromatic"]);
    expect((items[1].submenu as MenuItem[])[0].className).toBeUndefined();
  });

  it("searches every source, each match saying where it sits", () => {
    setPresets({
      folders: [
        {
          kind: "luts",
          written: "looks/",
          path: "looks",
          luts: [{ kind: "lut", name: "warm.cube", path: "looks/warm.cube" }],
        },
      ],
    });
    const matches = presetSearch(presetSources("luts", PRAGMA), "Search looks", leaf).filter("a");
    expect(matches.map((item) => [item.label, item.detail])).toEqual([
      ["warm", "This space › looks"],
      ["Panchromatic", "Pragma"],
    ]);
  });
});

describe("a folder's Presets items", () => {
  const items = presetFolderItems(
    (arg) => (arg as { folder?: string }).folder,
    () => undefined,
  );
  const visible = (arg: unknown) => items.filter((item) => item.when?.(context, arg) ?? true).map((item) => item.label);

  it("offers Add to Presets for a folder the space lists for nothing, Remove from Presets for one it lists", () => {
    setPresets({ folders: [{ kind: "templates", written: "kit/", path: "kit", templates: [] }] });
    expect(visible({ folder: "notes" })).toEqual(["Add to Presets"]);
    expect(visible({ folder: "Kit" })).toEqual(["Remove from Presets"]);
    expect(visible({})).toEqual([]);
  });
});
