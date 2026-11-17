// @vitest-environment jsdom
// The stored font is read at load, so a test of what it starts as needs a
// fresh module: vi.resetModules() + a dynamic import.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseScreenplayFont,
  SCREENPLAY_ZOOM_LEVELS,
  type ScreenplayFont,
  screenplayFontAttribute,
  screenplaySettings,
  screenplayZoomProperty,
} from "../../../../web/formats/screenplay/settings.ts";
import { must } from "../../../../web/lib/dom.ts";
import { Emitter } from "../../../../web/lib/emitter.ts";
import type { InstalledFonts } from "../../../../web/lib/fontPicker.ts";
import type { Setting, ZoomSetting } from "../../../../web/services/settings.ts";
import { polyfillRangeRects } from "../../support/codemirrorJsdom.ts";
import { fakeContextMenu } from "../../support/fakeContextMenu.ts";

polyfillRangeRects();

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

function fakeFont(initial: ScreenplayFont): Setting<ScreenplayFont> {
  const value = new Emitter<ScreenplayFont>(initial);
  return {
    get: () => value.get(),
    set: (next) => value.set(next),
    subscribe: (listener) => value.subscribe(listener),
  };
}

function fakeZoom(initial: number): ZoomSetting {
  const value = new Emitter<number>(initial);
  return {
    levels: SCREENPLAY_ZOOM_LEVELS,
    get: () => value.get(),
    set: (next) => value.set(next),
    subscribe: (listener) => value.subscribe(listener),
  };
}

describe("the screenplay font", () => {
  it("reads none, or a blank, as Courier Prime, and anything else as a built-in font or an installed one's name", () => {
    expect(parseScreenplayFont("system")).toBe("system");
    expect(parseScreenplayFont("Courier New")).toBe("Courier New");
    expect(parseScreenplayFont(null)).toBe("courier-prime");
    expect(parseScreenplayFont(" ")).toBe("courier-prime");
  });

  it("starts from what was stored, under its own key, and stores a pick", async () => {
    vi.resetModules();
    const absent = await import("../../../../web/formats/screenplay/settings.ts");
    expect(absent.screenplayFont.get()).toBe("courier-prime");

    localStorage.setItem("pragma:screenplay-font", "system");
    vi.resetModules();
    const stored = await import("../../../../web/formats/screenplay/settings.ts");
    expect(stored.screenplayFont.get()).toBe("system");

    stored.screenplayFont.set("courier-prime");
    expect(localStorage.getItem("pragma:screenplay-font")).toBe("courier-prime");
  });

  it("puts the pick on each screenplay editor, follows it, and takes it off when the editor goes", () => {
    const font = fakeFont("system");
    const view = new EditorView({ state: EditorState.create({ extensions: screenplayFontAttribute(font) }) });
    const family = () => view.dom.style.getPropertyValue("--screenplay-font-family");
    expect(view.dom.dataset.screenplayFont).toBe("system");
    font.set("Courier New");
    expect([view.dom.dataset.screenplayFont, family()]).toEqual(["named", '"Courier New"']);
    font.set("courier-prime");
    expect([view.dom.dataset.screenplayFont, family()]).toEqual(["courier-prime", ""]);
    font.set("courier-prime-sans");
    expect([view.dom.dataset.screenplayFont, family()]).toEqual(["courier-prime-sans", ""]);
    font.set("Courier New");
    view.destroy();
    expect([view.dom.dataset.screenplayFont, family()]).toEqual([undefined, ""]);
  });
});

describe("the screenplay page zoom", () => {
  it("starts at 100%, or at a step stored under its own key, and stores a pick", async () => {
    vi.resetModules();
    const absent = await import("../../../../web/formats/screenplay/settings.ts");
    expect(absent.screenplayZoom.get()).toBe(100);

    localStorage.setItem("pragma:screenplay-zoom", "150");
    vi.resetModules();
    const stored = await import("../../../../web/formats/screenplay/settings.ts");
    expect(stored.screenplayZoom.get()).toBe(150);

    // 175 is a step of the window's zoom, not the page's.
    for (const off of ["133", "175"]) {
      localStorage.setItem("pragma:screenplay-zoom", off);
      vi.resetModules();
      expect((await import("../../../../web/formats/screenplay/settings.ts")).screenplayZoom.get()).toBe(100);
    }

    stored.screenplayZoom.set(120);
    expect(localStorage.getItem("pragma:screenplay-zoom")).toBe("120");
  });

  it("steps 10 at a time from 80% to 150%", () => {
    expect(SCREENPLAY_ZOOM_LEVELS).toEqual([80, 90, 100, 110, 120, 130, 140, 150]);
  });

  it("puts the zoom on each screenplay editor, measures again on a change, and takes it off when the editor goes", () => {
    const zoom = fakeZoom(150);
    const view = new EditorView({ state: EditorState.create({ extensions: screenplayZoomProperty(zoom) }) });
    const measure = vi.spyOn(view, "requestMeasure");
    const property = () => view.dom.style.getPropertyValue("--screenplay-zoom");
    expect(property()).toBe("1.5");
    zoom.set(80);
    expect(property()).toBe("0.8");
    expect(measure).toHaveBeenCalledTimes(1);
    view.destroy();
    expect(property()).toBe("");
  });
});

describe("the Screenplay settings page", () => {
  // Courier New is the one installed font that is monospaced.
  function open(initial: ScreenplayFont, installed?: string[], zoomed = 100) {
    const font = fakeFont(initial);
    const contextMenu = fakeContextMenu();
    const fonts: InstalledFonts = {
      list: async () => installed,
      warm: vi.fn(),
      draws: (family) => ["Courier New", "Arial"].includes(family),
      monospaced: (family) => family === "Courier New",
    };
    const zoom = fakeZoom(zoomed);
    const settings = screenplaySettings(font, zoom, contextMenu, fonts);
    const page = settings.page();
    document.body.append(page);
    const [fontRow, zoomRow] = page.querySelectorAll<HTMLElement>(".field-row");
    const picker = must<HTMLButtonElement>(".picker", fontRow);
    const name = () => must(".picker-name", picker).textContent;
    const reset = must<HTMLButtonElement>('button[aria-label="Reset screenplay font to default"]', page);
    const openMenu = async () => {
      picker.click();
      await vi.waitFor(() => expect(contextMenu.isOpen(picker)).toBe(true));
    };
    return { font, zoom, fonts, settings, page, fontRow, zoomRow, picker, name, reset, openMenu, contextMenu };
  }

  it("is named by the label its files go by", () => {
    const { settings } = open("courier-prime");
    expect(settings.label).toBe("Screenplay");
    expect(settings.detail).toBe("Fountain files (.fountain)");
  });

  it("offers to change the font at the default, with no description and nothing to reset", () => {
    const { fontRow, picker, name, reset } = open("courier-prime");
    expect(fontRow.querySelector(".field-row-title")?.textContent).toBe("Font");
    expect(fontRow.querySelector(".field-row-description")).toBeNull();
    expect(name()).toBe("Change font");
    expect(picker.hasAttribute("aria-label")).toBe(false);
    expect(reset.style.visibility).toBe("hidden");
  });

  it("names a font picked over the default, offers the reset, and stores a pick from its menu", async () => {
    const { font, picker, name, reset, openMenu, contextMenu } = open("system");
    expect(name()).toBe("System monospace");
    expect(picker.getAttribute("aria-label")).toBe("Font: System monospace");
    expect(reset.style.visibility).toBe("");
    await openMenu();
    expect(contextMenu.labels()).toEqual(["Courier Prime", "Courier Prime Sans", "System monospace"]);
    contextMenu.pick("Courier Prime");
    expect(font.get()).toBe("courier-prime");
    expect([name(), reset.style.visibility]).toEqual(["Change font", "hidden"]);
  });

  it("lists its own fonts among the installed ones, the monospaced first, and stores one by name", async () => {
    const { font, name, openMenu, contextMenu } = open("courier-prime", ["Arial", "Courier New"]);
    await openMenu();
    expect(contextMenu.labels()).toEqual([
      "Monospaced",
      "Courier New",
      "Courier Prime",
      "Courier Prime Sans",
      "Other fonts",
      "Arial",
    ]);
    expect(contextMenu.rows().find((row) => row.label === "Courier Prime")?.mark).toBe("Default");
    contextMenu.pick("Courier New");
    expect(font.get()).toBe("Courier New");
    expect(name()).toBe("Courier New");
  });

  it("takes a typed font's name where the browser lists none", async () => {
    const { font, openMenu, contextMenu } = open("courier-prime");
    await openMenu();
    expect(contextMenu.rows("Nope").at(-1)).toMatchObject({ label: "Nope", detail: "Not installed" });
    contextMenu.pick("Courier New", "Courier New");
    expect(font.get()).toBe("Courier New");
  });

  it("warms the font list as the pointer or the keyboard reaches its button", () => {
    const { picker, fonts } = open("courier-prime");
    picker.dispatchEvent(new Event("pointerenter"));
    picker.dispatchEvent(new FocusEvent("focus"));
    expect(fonts.warm).toHaveBeenCalledTimes(2);
  });

  it("puts Courier Prime back from the reset button, which then goes", () => {
    const { font, name, reset } = open("system");
    reset.click();
    expect(font.get()).toBe("courier-prime");
    expect([name(), reset.style.visibility]).toEqual(["Change font", "hidden"]);
  });

  it("offers Page zoom under the font, at the zoom stored, and stores a pick from its menu", () => {
    const { zoom, zoomRow, contextMenu } = open("courier-prime", undefined, 150);
    expect(zoomRow.querySelector(".field-row-title")?.textContent).toBe("Page zoom");
    expect(zoomRow.querySelector(".field-row-description")?.textContent).toBe(
      "Size of every screenplay's page, 12pt at 100%.",
    );
    const button = must<HTMLButtonElement>(".picker", zoomRow);
    expect(button.getAttribute("aria-label")).toBe("Page zoom: 150%");
    button.click();
    expect(contextMenu.labels()).toEqual(["80%", "90%", "100%", "110%", "120%", "130%", "140%", "150%"]);
    contextMenu.pick("120%");
    expect(zoom.get()).toBe(120);
    zoom.set(90);
    expect(button.getAttribute("aria-label")).toBe("Page zoom: 90%");
  });
});
