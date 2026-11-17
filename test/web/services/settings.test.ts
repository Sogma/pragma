// @vitest-environment jsdom
// This module reads localStorage eagerly at load (see the "load-time default"
// tests below), so each pre-existing localStorage state needs a fresh module
// instance: vi.resetModules() + a dynamic import, rather than the one static
// import the plain get/set/subscribe round-trips use.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settings from "../../../web/services/settings.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("boolean settings — get/set/subscribe", () => {
  it("set() persists to localStorage and updates get()", () => {
    settings.showLineNumbers.set(true);
    expect(settings.showLineNumbers.get()).toBe(true);
    expect(localStorage.getItem("pragma:show-line-numbers")).toBe("true");
    settings.showLineNumbers.set(false);
    expect(settings.showLineNumbers.get()).toBe(false);
    expect(localStorage.getItem("pragma:show-line-numbers")).toBe("false");
  });

  it("subscribe() fires immediately with the current value, then on every set()", () => {
    const seen: boolean[] = [];
    settings.showConsole.set(false);
    const unsubscribe = settings.showConsole.subscribe((value) => seen.push(value));
    settings.showConsole.set(true);
    settings.showConsole.set(false);
    unsubscribe();
    settings.showConsole.set(true);
    expect(seen).toEqual([false, true, false]);
  });
});

describe("boolean settings — load-time default", () => {
  it("defaults false for an absent show-extensions key", async () => {
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.showExtensions.get()).toBe(false);
  });

  it("reads a stored true value for show-extensions", async () => {
    localStorage.setItem("pragma:show-extensions", "true");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.showExtensions.get()).toBe(true);
  });

  it("defaults true for an absent show-fold-markers key (the inverted default)", async () => {
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.showFoldMarkers.get()).toBe(true);
  });

  it("show-fold-markers is only false for the literal string 'false', not any other value", async () => {
    localStorage.setItem("pragma:show-fold-markers", "garbage");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.showFoldMarkers.get()).toBe(true);

    localStorage.setItem("pragma:show-fold-markers", "false");
    vi.resetModules();
    const fresh2 = await import("../../../web/services/settings.ts");
    expect(fresh2.showFoldMarkers.get()).toBe(false);
  });

  it("readable-line-length follows the same inverted-default rule as show-fold-markers", async () => {
    localStorage.setItem("pragma:readable-line-length", "false");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.readableLineLength.get()).toBe(false);
  });
});

describe("theme", () => {
  it("defaults to system when absent", async () => {
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.theme.get()).toBe("system");
  });

  it("reads a value it doesn't know as system", async () => {
    localStorage.setItem("pragma:theme", "sepia");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.theme.get()).toBe("system");
  });

  it.each(["light", "dark", "system"] as const)("reads a stored %s value", async (stored) => {
    localStorage.setItem("pragma:theme", stored);
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.theme.get()).toBe(stored);
  });

  it("set() persists and updates get()", () => {
    settings.theme.set("dark");
    expect(settings.theme.get()).toBe("dark");
    expect(localStorage.getItem("pragma:theme")).toBe("dark");
  });
});

describe("editorFontSize", () => {
  it("defaults to DEFAULT_EDITOR_FONT_SIZE when absent", async () => {
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.editorFontSize.get()).toBe(fresh.DEFAULT_EDITOR_FONT_SIZE);
    expect(fresh.DEFAULT_EDITOR_FONT_SIZE).toBe(16);
  });

  it("defaults to DEFAULT_EDITOR_FONT_SIZE for a non-numeric stored value", async () => {
    localStorage.setItem("pragma:editor-font-size", "not-a-number");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.editorFontSize.get()).toBe(fresh.DEFAULT_EDITOR_FONT_SIZE);
  });

  it("clamps an out-of-range stored value on load", async () => {
    localStorage.setItem("pragma:editor-font-size", "999");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.editorFontSize.get()).toBe(24);

    localStorage.setItem("pragma:editor-font-size", "1");
    vi.resetModules();
    const fresh2 = await import("../../../web/services/settings.ts");
    expect(fresh2.editorFontSize.get()).toBe(10);
  });

  it("reads an in-range stored value as-is", async () => {
    localStorage.setItem("pragma:editor-font-size", "20");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.editorFontSize.get()).toBe(20);
  });

  it("set() does not clamp — matches the range input's own min/max instead", () => {
    settings.editorFontSize.set(999);
    expect(settings.editorFontSize.get()).toBe(999);
  });
});

describe("editorFont", () => {
  it("reads none, or a blank, as the system sans-serif, and keeps any other value as stored", async () => {
    vi.resetModules();
    const absent = await import("../../../web/services/settings.ts");
    expect(absent.editorFont.get()).toBe("sans-serif");

    localStorage.setItem("pragma:editor-font", " ");
    vi.resetModules();
    const blank = await import("../../../web/services/settings.ts");
    expect(blank.editorFont.get()).toBe("sans-serif");

    localStorage.setItem("pragma:editor-font", "Iowan Old Style");
    vi.resetModules();
    const named = await import("../../../web/services/settings.ts");
    expect(named.editorFont.get()).toBe("Iowan Old Style");
  });

  it("stores a pick under its own key", () => {
    settings.editorFont.set("serif");
    expect(localStorage.getItem("pragma:editor-font")).toBe("serif");
  });
});

describe("interfaceFont", () => {
  it("reads none, or a blank, as the system sans-serif, and keeps any other value as stored", async () => {
    vi.resetModules();
    const absent = await import("../../../web/services/settings.ts");
    expect(absent.interfaceFont.get()).toBe("sans-serif");

    localStorage.setItem("pragma:interface-font", " ");
    vi.resetModules();
    const blank = await import("../../../web/services/settings.ts");
    expect(blank.interfaceFont.get()).toBe("sans-serif");

    localStorage.setItem("pragma:interface-font", "Inter");
    vi.resetModules();
    const named = await import("../../../web/services/settings.ts");
    expect(named.interfaceFont.get()).toBe("Inter");
  });

  it("stores a pick under its own key, apart from the Editor's Font", () => {
    settings.interfaceFont.set("serif");
    expect(localStorage.getItem("pragma:interface-font")).toBe("serif");
    expect(localStorage.getItem("pragma:editor-font")).toBeNull();
  });
});

describe("createSetting", () => {
  const parse = (stored: string | null) => (stored === "b" ? "b" : "a");

  it("reads what its key holds through the parser, a value it doesn't know as the parser's default", () => {
    localStorage.setItem("pragma:test-choice", "b");
    expect(settings.createSetting("pragma:test-choice", parse).get()).toBe("b");
    localStorage.setItem("pragma:test-choice", "z");
    expect(settings.createSetting("pragma:test-choice", parse).get()).toBe("a");
  });

  it("stores a pick under its key and tells its subscribers", () => {
    const choice = settings.createSetting("pragma:test-choice", parse);
    const seen: string[] = [];
    choice.subscribe((value) => seen.push(value));
    choice.set("b");
    expect(localStorage.getItem("pragma:test-choice")).toBe("b");
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("shortcuts", () => {
  it("round-trips a person's chords by command, an empty list included", () => {
    settings.shortcuts.set({ "tab.close": ["Ctrl+Alt+W"], "quickOpen.files": [] });
    expect(JSON.parse(localStorage.getItem("pragma:shortcuts") ?? "")).toEqual({
      "tab.close": ["Ctrl+Alt+W"],
      "quickOpen.files": [],
    });
    expect(settings.shortcuts.get()["quickOpen.files"]).toEqual([]);
  });

  it("reads a stored value of any other shape as none set, keeping the entries that fit", async () => {
    for (const stored of ["not json", "[]", "null", '"text"']) {
      localStorage.setItem("pragma:shortcuts", stored);
      vi.resetModules();
      const fresh = await import("../../../web/services/settings.ts");
      expect(fresh.shortcuts.get()).toEqual({});
    }
    localStorage.setItem("pragma:shortcuts", JSON.stringify({ a: ["Ctrl+A"], b: "Ctrl+B", c: [1], d: [] }));
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.shortcuts.get()).toEqual({ a: ["Ctrl+A"], d: [] });
  });
});

describe("panel sizes", () => {
  it("are absent until a drag saves one, then round-trip", () => {
    expect(settings.sidebarWidth.get()).toBeUndefined();
    settings.sidebarWidth.set(312);
    expect(localStorage.getItem("pragma:sidebar-width")).toBe("312");
    expect(settings.sidebarWidth.get()).toBe(312);
    settings.sidebarWidth.set(undefined);
    expect(localStorage.getItem("pragma:sidebar-width")).toBeNull();
  });

  it("read back what was saved", async () => {
    localStorage.setItem("pragma:console-height", "260.5");
    localStorage.setItem("pragma:editor-split", "0.35");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.consoleHeight.get()).toBe(260.5);
    expect(fresh.editorSplit.get()).toBe(0.35);
  });

  it("read anything but a positive size as absent, and a share only below 1", async () => {
    for (const stored of ["", "wide", "0", "-40", "Infinity"]) {
      localStorage.setItem("pragma:assistant-width", stored);
      vi.resetModules();
      const fresh = await import("../../../web/services/settings.ts");
      expect(fresh.assistantWidth.get()).toBeUndefined();
    }
    localStorage.setItem("pragma:editor-split", "1");
    vi.resetModules();
    const fresh = await import("../../../web/services/settings.ts");
    expect(fresh.editorSplit.get()).toBeUndefined();
  });
});

describe("pdfZoom", () => {
  it("starts at Fit to width, or at a PDF step stored under its own key, and stores a pick", async () => {
    vi.resetModules();
    expect((await import("../../../web/services/settings.ts")).pdfZoom.get()).toBe("fit");

    localStorage.setItem("pragma:pdf-zoom", "200");
    vi.resetModules();
    const stored = await import("../../../web/services/settings.ts");
    expect(stored.pdfZoom.get()).toBe(200);

    // 90 is a step of the window's zoom, not a PDF's.
    for (const off of ["133", "90", "fit"]) {
      localStorage.setItem("pragma:pdf-zoom", off);
      vi.resetModules();
      expect((await import("../../../web/services/settings.ts")).pdfZoom.get()).toBe("fit");
    }

    stored.pdfZoom.set(75);
    expect(localStorage.getItem("pragma:pdf-zoom")).toBe("75");
    stored.pdfZoom.set("fit");
    expect(localStorage.getItem("pragma:pdf-zoom")).toBe("fit");
  });
});
