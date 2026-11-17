// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInstalledFonts,
  cssFamily,
  type FontMenu,
  fontMenuItems,
  type InstalledFonts,
  type MeasureText,
  toggleFontMenu,
} from "../../../web/lib/fontPicker.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { MenuItem } from "../../../web/services/menus.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

beforeEach(() => {
  document.body.replaceChildren();
});

// A canvas stand-in: an installed font draws at its own widths, monospaced
// or not, and a missing one at the width of the generic family after it.
function fakeMeasure(installed: Record<string, "mono" | "proportional">): MeasureText {
  const generic: Record<string, number> = { monospace: 9, "sans-serif": 7, serif: 6 };
  return (text, font) => {
    const family = font.match(/^72px "((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1");
    const kind = family === undefined ? undefined : installed[family];
    if (kind === "mono") return text.length * 10;
    if (kind === "proportional") return [...text].reduce((sum, char) => sum + (char === "i" ? 3 : 12), 0);
    return text.length * (generic[font.split(", ").pop() ?? ""] ?? generic[font.replace("72px ", "")] ?? 5);
  };
}

const faces = (...families: string[]) => families.map((family) => ({ family }));

describe("cssFamily", () => {
  it("quotes a family, escaping what would end the string", () => {
    expect(cssFamily("Courier New")).toBe('"Courier New"');
    expect(cssFamily('Odd "Name" \\ here')).toBe('"Odd \\"Name\\" \\\\ here"');
  });
});

describe("createInstalledFonts", () => {
  it("lists each family once, sorted, leaving out the hidden and vertical faces, and asks only once", async () => {
    const query = vi.fn(async () => faces("Courier New", "Arial", "Courier New", "@MS Gothic", ".SF NS", ""));
    const fonts = createInstalledFonts({ query });
    expect(await fonts.list()).toEqual(["Arial", "Courier New"]);
    expect(await fonts.list()).toEqual(["Arial", "Courier New"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("lists nothing where the browser can't list fonts", async () => {
    expect(await createInstalledFonts({ query: undefined }).list()).toBeUndefined();
  });

  it("keeps no refusal, so the next open asks again", async () => {
    const query = vi
      .fn<() => Promise<{ family: string }[]>>()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce(faces("Arial"));
    const fonts = createInstalledFonts({ query });
    expect(await fonts.list()).toBeUndefined();
    expect(await fonts.list()).toEqual(["Arial"]);
  });

  it("takes an empty answer, as a dismissed prompt can give, for no list, and asks again", async () => {
    const query = vi
      .fn<() => Promise<{ family: string }[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(faces("Arial"));
    const fonts = createInstalledFonts({ query });
    expect(await fonts.list()).toBeUndefined();
    expect(await fonts.list()).toEqual(["Arial"]);
  });

  it("turns a query that throws into no list", async () => {
    const fonts = createInstalledFonts({
      query: () => {
        throw new DOMException("no click", "SecurityError");
      },
    });
    expect(await fonts.list()).toBeUndefined();
  });

  it("warms where listing asks nothing: lists, then measures every font a few at a time", async () => {
    const measure = vi.fn(fakeMeasure({ Arial: "proportional" }));
    const query = vi.fn(async () => faces(...Array.from({ length: 20 }, (_, index) => `Font ${index}`)));
    const fonts = createInstalledFonts({ query, measure, permitted: async () => true });
    fonts.warm();
    fonts.warm();
    await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(40));
    expect(query).toHaveBeenCalledTimes(1);
    expect(fonts.monospaced("Font 3")).toBe(true);
    expect(measure).toHaveBeenCalledTimes(40);
  });

  it("warms nothing where listing would ask first, and tries again on the next approach", async () => {
    const query = vi.fn(async () => faces("Arial"));
    let allowed = false;
    const fonts = createInstalledFonts({ query, measure: fakeMeasure({}), permitted: async () => allowed });
    fonts.warm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(query).not.toHaveBeenCalled();
    allowed = true;
    fonts.warm();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  });

  it("tells a font that draws from one that falls back, and a monospaced one from the rest", () => {
    const measure = vi.fn(fakeMeasure({ "Courier New": "mono", Arial: "proportional" }));
    const fonts = createInstalledFonts({ query: undefined, measure });
    expect([fonts.draws("Courier New"), fonts.draws("Arial"), fonts.draws("Nope")]).toEqual([true, true, false]);
    expect([fonts.monospaced("Courier New"), fonts.monospaced("Arial")]).toEqual([true, false]);
    const calls = measure.mock.calls.length;
    fonts.draws("Nope");
    fonts.monospaced("Arial");
    expect(measure.mock.calls.length).toBe(calls);
  });
});

// The fonts as fontMenuItems asks about them.
function stubFonts(families: { draws?: string[]; mono?: string[] } = {}): InstalledFonts {
  return {
    list: async () => undefined,
    warm: () => {},
    draws: (family) => (families.draws ?? []).includes(family),
    monospaced: (family) => (families.mono ?? []).includes(family),
  };
}

const BUILT_IN = [
  { value: "courier-prime", label: "Courier Prime", font: '"Courier Prime", monospace', monospaced: true },
  { value: "system", label: "System monospace", font: "monospace", monospaced: true, standIn: true },
];

function menu(overrides: Partial<FontMenu> = {}): FontMenu {
  return {
    stored: "courier-prime",
    pick: vi.fn(),
    defaultValue: "courier-prime",
    builtIn: BUILT_IN,
    fonts: stubFonts({ draws: ["Courier New", "Arial"], mono: ["Courier New"] }),
    monospace: true,
    ...overrides,
  };
}

const labels = (items: MenuItem[]) => items.map((item) => item.label);
const checked = (items: MenuItem[]) => items.filter((item) => item.checked?.(context, undefined)).map((i) => i.label);

describe("fontMenuItems", () => {
  it("lists the built-in fonts among the installed ones, monospaced first, each drawn in itself", () => {
    const items = fontMenuItems(menu(), ["Arial", "Courier New", "courier prime"]);
    expect(labels(items)).toEqual(["Monospaced", "Courier New", "Courier Prime", "Other fonts", "Arial"]);
    expect(items.map((item) => item.font)).toEqual([
      undefined,
      '"Courier New", var(--font-system)',
      '"Courier Prime", monospace',
      undefined,
      '"Arial", var(--font-system)',
    ]);
    // A heading names no action; a group change draws the separator.
    expect(items[0].run).toBeUndefined();
    expect(new Set(items.map((item) => item.group)).size).toBe(2);
    expect(checked(items)).toEqual(["Courier Prime"]);
  });

  it("marks the default with a dot, whatever is checked", () => {
    const items = fontMenuItems(menu({ stored: "Courier New" }), ["Courier New"]);
    expect(items.map((item) => [item.label, item.mark])).toEqual([
      ["Monospaced", undefined],
      ["Courier New", undefined],
      ["Courier Prime", "Default"],
    ]);
    expect(checked(items)).toEqual(["Courier New"]);
  });

  it("offers the stand-in only where nothing is listed, or while it is stored", () => {
    expect(labels(fontMenuItems(menu(), ["Arial"]))).not.toContain("System monospace");
    expect(labels(fontMenuItems(menu(), undefined))).toEqual(["Courier Prime", "System monospace"]);
    const stored = fontMenuItems(menu({ stored: "system" }), ["Arial"]);
    expect(labels(stored)).toEqual(["Monospaced", "Courier Prime", "System monospace", "Other fonts", "Arial"]);
    expect(checked(stored)).toEqual(["System monospace"]);
  });

  it("lists every font as one group for a setting with no need of monospace", () => {
    const items = fontMenuItems(menu({ monospace: false }), ["Courier New", "Arial"]);
    expect(labels(items)).toEqual(["Arial", "Courier New", "Courier Prime"]);
  });

  it("picks a font by its value, an installed one by its name", () => {
    const pick = vi.fn();
    const items = fontMenuItems(menu({ pick }), ["Arial"]);
    void items.find((item) => item.label === "Courier Prime")?.run?.(context, undefined);
    void items.find((item) => item.label === "Arial")?.run?.(context, undefined);
    expect(pick.mock.calls).toEqual([["courier-prime"], ["Arial"]]);
  });

  it("puts the stored font first when nothing else lists it, saying what's wrong with it", () => {
    expect(labels(fontMenuItems(menu({ stored: "Courier New" }), undefined))).toEqual([
      "Courier New",
      "Courier Prime",
      "System monospace",
    ]);
    const gone = fontMenuItems(menu({ stored: "Fira Code" }), ["Arial"]);
    expect(gone[0]).toMatchObject({ label: "Fira Code", detail: "Not installed" });
    expect(checked(gone)).toEqual(["Fira Code"]);
    // Listed already, in a case of its own.
    const listed = fontMenuItems(menu({ stored: "courier new" }), ["Courier New"]);
    expect(labels(listed)).toEqual(["Monospaced", "Courier New", "Courier Prime"]);
    expect(checked(listed)).toEqual(["Courier New"]);
  });

  it("filters every group by a query, keeping the headings over what matches", () => {
    const items = fontMenuItems(menu(), ["Arial", "Courier New"], "cour");
    expect(labels(items)).toEqual(["Monospaced", "Courier New", "Courier Prime"]);
    expect(fontMenuItems(menu(), ["Arial"], "zzz")).toEqual([]);
  });

  it("where nothing lists the installed fonts, offers the name typed, flagged when it isn't monospaced and unpickable when nothing draws it", () => {
    const typed = (query: string) => fontMenuItems(menu(), undefined, query).at(-1);
    expect(typed("Courier New")).toMatchObject({ label: "Courier New", font: '"Courier New", var(--font-system)' });
    expect(typed("Courier New")?.detail).toBeUndefined();
    expect(typed("Arial")).toMatchObject({ label: "Arial", detail: "Not monospaced" });
    expect(typed("Arial")?.disabled).toBeUndefined();
    expect(typed("Nope")).toMatchObject({ label: "Nope", detail: "Not installed" });
    expect(typed("Nope")?.disabled?.(context, undefined)).toBe(true);
    expect(typed("  Arial  ")?.label).toBe("Arial");
  });

  it("offers no typed row for a name already listed or stored", () => {
    expect(labels(fontMenuItems(menu(), ["Arial"], "arial"))).toEqual(["Other fonts", "Arial"]);
    expect(labels(fontMenuItems(menu(), undefined, "system monospace"))).toEqual(["System monospace"]);
    expect(labels(fontMenuItems(menu({ stored: "Arial" }), undefined, "ARIAL"))).toEqual(["Arial"]);
  });
});

describe("toggleFontMenu", () => {
  it("lists the installed fonts, then opens the searchable menu under its button", async () => {
    const contextMenu = fakeContextMenu();
    const button = document.createElement("button");
    document.body.append(button);
    const fonts = { ...stubFonts({ mono: ["Courier New"] }), list: vi.fn(async () => ["Courier New"]) };
    toggleFontMenu(contextMenu, button, menu({ fonts }), "Font");
    expect(fonts.list).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(contextMenu.isOpen(button)).toBe(true));
    expect(contextMenu.opened[0]).toMatchObject({
      anchor: button,
      align: "end",
      ariaLabel: "Font",
      className: "picker-menu font-menu",
      picker: true,
    });
    expect(contextMenu.opened[0].search?.placeholder).toBe("Search or type a font name");
    expect(contextMenu.labels()).toEqual(["Monospaced", "Courier New", "Courier Prime"]);

    toggleFontMenu(contextMenu, button, menu({ fonts }), "Font");
    expect(contextMenu.isOpen()).toBe(false);
  });

  it("opens nothing when its button went away while the browser asked", async () => {
    const contextMenu = fakeContextMenu();
    const button = document.createElement("button");
    let answer: (families: string[]) => void = () => {};
    const fonts = { ...stubFonts(), list: () => new Promise<string[]>((resolve) => (answer = resolve)) };
    document.body.append(button);
    toggleFontMenu(contextMenu, button, menu({ fonts }), "Font");
    button.remove();
    answer([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(contextMenu.opened).toHaveLength(0);
  });
});
