// @vitest-environment jsdom
// The stored settings are read at load, so a test of what they start as
// needs a fresh module: vi.resetModules() + a dynamic import.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeSettings, wireCodeFont, wireCodeSettings } from "../../../../web/formats/code/settings.ts";
import { must } from "../../../../web/lib/dom.ts";
import { Emitter } from "../../../../web/lib/emitter.ts";
import type { InstalledFonts } from "../../../../web/lib/fontPicker.ts";
import type { Setting } from "../../../../web/services/settings.ts";
import { testLayout } from "../../support/editorLayout.ts";
import { fakeContextMenu } from "../../support/fakeContextMenu.ts";

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--font-code");
});

function fakeFont(initial: string): Setting<string> {
  const value = new Emitter(initial);
  return { get: () => value.get(), set: (next) => value.set(next), subscribe: (listener) => value.subscribe(listener) };
}

async function freshModule() {
  vi.resetModules();
  const { codeLayout, codeFont } = await import("../../../../web/formats/code/settings.ts");
  const { readableLineLength, lineNumbers, foldMarkers, indentGuides } = codeLayout;
  const layout = [readableLineLength, lineNumbers, foldMarkers, indentGuides].map((setting) => setting?.get());
  return { layout, font: codeFont.get() };
}

describe("the Code page's settings", () => {
  it("start code at the pane's width, with line numbers and folding markers, in the system's code font", async () => {
    expect(await freshModule()).toEqual({ layout: [false, true, true, true], font: "monospace" });
  });

  it("start from what was stored, under keys of their own", async () => {
    localStorage.setItem("pragma:code-readable-line-length", "true");
    localStorage.setItem("pragma:code-line-numbers", "false");
    localStorage.setItem("pragma:code-fold-markers", "false");
    localStorage.setItem("pragma:code-indent-guides", "false");
    localStorage.setItem("pragma:code-font", "Fira Code");
    expect(await freshModule()).toEqual({ layout: [true, false, false, false], font: "Fira Code" });
  });

  it("put the font picked on :root, an installed one falling back to the system's code font", () => {
    const font = fakeFont("monospace");
    wireCodeFont(font);
    const property = () => document.documentElement.style.getPropertyValue("--font-code");
    expect(property()).toBe("var(--font-monospace)");
    font.set("Fira Code");
    expect(property()).toBe('"Fira Code", var(--font-monospace)');
  });
});

describe("wireCodeSettings", () => {
  it("puts the code font on :root and hands Formats the Code page", () => {
    const entry = wireCodeSettings({
      font: fakeFont("Fira Code"),
      contextMenu: fakeContextMenu(),
      onFoldMarkersHidden: vi.fn(),
    });
    expect([entry.id, entry.settings.label]).toEqual(["code", "Code"]);
    expect(document.documentElement.style.getPropertyValue("--font-code")).toBe('"Fira Code", var(--font-monospace)');
  });
});

describe("the Code settings page", () => {
  function open() {
    const layout = testLayout({ readableLineLength: false, lineNumbers: true, foldMarkers: true, indentGuides: true });
    const onFoldMarkersHidden = vi.fn();
    const fonts: InstalledFonts = {
      list: async () => undefined,
      warm: vi.fn(),
      draws: () => false,
      monospaced: () => false,
    };
    const settings = codeSettings({
      layout,
      font: fakeFont("monospace"),
      contextMenu: fakeContextMenu(),
      fonts,
      onFoldMarkersHidden,
    });
    const page = settings.page();
    document.body.append(page);
    const toggle = (title: string) => must<HTMLButtonElement>(`button.toggle-switch[aria-label="${title}"]`, page);
    return { layout, onFoldMarkersHidden, settings, page, toggle };
  }

  it("is named for an applet's Source mode", () => {
    const { settings } = open();
    expect([settings.label, settings.detail]).toEqual(["Code", "An applet in Source mode"]);
  });

  it("holds the Editor page's three layout switches and the guides', each showing its setting, then a font", () => {
    const { page, toggle } = open();
    const titles = [...page.querySelectorAll(".field-row-title")].map((title) => title.textContent);
    expect(titles).toEqual(["Readable line length", "Line numbers", "Folding markers", "Indentation guides", "Font"]);
    const switches = titles.slice(0, 4).map((title) => toggle(title ?? "").getAttribute("aria-checked"));
    expect(switches).toEqual(["false", "true", "true", "true"]);
  });

  it("unfolds Source mode when its folding markers are turned off, and only then", () => {
    const { layout, toggle, onFoldMarkersHidden } = open();
    toggle("Line numbers").click();
    expect(layout.lineNumbers.get()).toBe(false);
    expect(onFoldMarkersHidden).not.toHaveBeenCalled();
    toggle("Folding markers").click();
    expect(layout.foldMarkers.get()).toBe(false);
    expect(onFoldMarkersHidden).toHaveBeenCalledTimes(1);
    toggle("Folding markers").click();
    expect(onFoldMarkersHidden).toHaveBeenCalledTimes(1);
  });
});
