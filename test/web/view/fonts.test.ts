// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../web/lib/dom.ts";
import { Emitter } from "../../../web/lib/emitter.ts";
import type { InstalledFonts } from "../../../web/lib/fontPicker.ts";
import type { Setting } from "../../../web/services/settings.ts";
import { wireFonts } from "../../../web/view/fonts.ts";
import { type FakeContextMenu, fakeContextMenu } from "../support/fakeContextMenu.ts";

const root = document.documentElement.style;

beforeEach(() => {
  document.body.replaceChildren();
  root.removeProperty("--font-interface");
  root.removeProperty("--font-text");
  localStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

function fakeFont(initial: string): Setting<string> {
  const value = new Emitter<string>(initial);
  return {
    get: () => value.get(),
    set: (next) => value.set(next),
    subscribe: (listener) => value.subscribe(listener),
  };
}

interface Wired {
  interfaceFont?: Setting<string>;
  editorFont?: Setting<string>;
  installed?: string[];
}

// Each row's slot sits in a card of its own page, as in index.html. Consolas
// is the one installed font that is monospaced.
function wire(options: Wired = {}) {
  const interfaceFont = options.interfaceFont ?? fakeFont("sans-serif");
  const editorFont = options.editorFont ?? fakeFont("sans-serif");
  const contextMenu = fakeContextMenu();
  const fonts: InstalledFonts = {
    list: async () => options.installed,
    warm: vi.fn(),
    draws: (family) => ["Consolas", "Georgia"].includes(family),
    monospaced: (family) => family === "Consolas",
  };
  const card = (slotId: string) => {
    const element = document.createElement("div");
    const slot = document.createElement("div");
    slot.id = slotId;
    slot.hidden = true;
    element.append(slot);
    document.body.append(element);
    return element;
  };
  const appearance = card("setting-interface-font");
  const editor = card("setting-editor-font");
  wireFonts({ interfaceFont, editorFont, contextMenu, fonts });
  return { interfaceFont, editorFont, contextMenu, appearance, editor };
}

function fontRow(card: HTMLElement, resetLabel: string, contextMenu: FakeContextMenu) {
  const row = must<HTMLElement>(".field-row", card);
  const picker = must<HTMLButtonElement>(".picker", row);
  const name = () => must(".picker-name", picker).textContent;
  const reset = must<HTMLButtonElement>(`button[aria-label="${resetLabel}"]`, row);
  const openMenu = async () => {
    picker.click();
    await vi.waitFor(() => expect(contextMenu.isOpen(picker)).toBe(true));
  };
  return { row, picker, name, reset, openMenu };
}

const textFont = () => root.getPropertyValue("--font-text");
const interfaceFamily = () => root.getPropertyValue("--font-interface");

describe("the Editor's Font", () => {
  function open(initial: string, installed?: string[]) {
    const wired = wire({ editorFont: fakeFont(initial), installed });
    return { ...wired, ...fontRow(wired.editor, "Reset font to default", wired.contextMenu) };
  }

  it("sets a note's text in a system font's own stack, or an installed one's over the system's", () => {
    const { editorFont } = open("sans-serif");
    expect(textFont()).toBe("var(--font-system)");
    editorFont.set("serif");
    expect(textFont()).toBe("var(--font-serif)");
    editorFont.set("monospace");
    expect(textFont()).toBe("var(--font-monospace)");
    editorFont.set("Georgia");
    expect(textFont()).toBe('"Georgia", var(--font-system)');
  });

  it("takes the slot's place as a Font row that says what it covers", () => {
    const { editor, row } = open("sans-serif");
    expect([...editor.children]).toEqual([row]);
    expect(row.querySelector(".field-row-title")?.textContent).toBe("Font");
    expect(row.querySelector(".field-row-description")?.textContent).toBe("Font for notes.");
  });

  it("offers to change the font at the default, with nothing to reset", () => {
    const { picker, name, reset } = open("sans-serif");
    expect(name()).toBe("Change font");
    expect(picker.hasAttribute("aria-label")).toBe(false);
    expect(reset.style.visibility).toBe("hidden");
  });

  it("offers the system's three fonts where the browser lists none, the sans-serif as the default", async () => {
    const { openMenu, contextMenu } = open("sans-serif");
    await openMenu();
    expect(contextMenu.labels()).toEqual(["System monospace", "System sans-serif", "System serif"]);
    expect(contextMenu.rows().find((row) => row.label === "System sans-serif")?.mark).toBe("Default");
  });

  it("lists the installed fonts in one list, and the system's serif and code fonts only by their names", async () => {
    const { editorFont, name, openMenu, contextMenu } = open("sans-serif", ["Consolas", "Georgia"]);
    await openMenu();
    expect(contextMenu.labels()).toEqual(["Consolas", "Georgia", "System sans-serif"]);
    contextMenu.pick("Georgia");
    expect([editorFont.get(), name(), textFont()]).toEqual(["Georgia", "Georgia", '"Georgia", var(--font-system)']);
  });

  it("takes a typed font's name where the browser lists none, monospaced or not", async () => {
    const { editorFont, openMenu, contextMenu } = open("sans-serif");
    await openMenu();
    expect(contextMenu.rows("Georgia").at(-1)).toMatchObject({ label: "Georgia", detail: undefined });
    expect(contextMenu.rows("Nope").at(-1)).toMatchObject({ label: "Nope", detail: "Not installed" });
    contextMenu.pick("Georgia", "Georgia");
    expect(editorFont.get()).toBe("Georgia");
  });

  it("puts the system sans-serif back from the reset, which then goes", () => {
    const { editorFont, picker, name, reset } = open("serif");
    expect([name(), picker.getAttribute("aria-label")]).toEqual(["System serif", "Font: System serif"]);
    reset.click();
    expect([editorFont.get(), name(), reset.style.visibility, textFont()]).toEqual([
      "sans-serif",
      "Change font",
      "hidden",
      "var(--font-system)",
    ]);
  });
});

describe("Appearance's Interface font", () => {
  function open(initial: string, installed?: string[]) {
    const wired = wire({ interfaceFont: fakeFont(initial), installed });
    return { ...wired, ...fontRow(wired.appearance, "Reset interface font to default", wired.contextMenu) };
  }

  it("takes the slot's place as an Interface font row that says what it covers", () => {
    const { appearance, row } = open("sans-serif");
    expect([...appearance.children]).toEqual([row]);
    expect(row.querySelector(".field-row-title")?.textContent).toBe("Interface font");
    expect(row.querySelector(".field-row-description")?.textContent).toBe("Font for menus and panels.");
  });

  it("sets the interface in a picked font over the system's, and leaves the stylesheet's at the default", () => {
    const { interfaceFont } = open("sans-serif");
    expect(interfaceFamily()).toBe("");
    interfaceFont.set("Georgia");
    expect(interfaceFamily()).toBe('"Georgia", var(--font-system)');
    interfaceFont.set("monospace");
    expect(interfaceFamily()).toBe("var(--font-monospace)");
    interfaceFont.set("sans-serif");
    expect(interfaceFamily()).toBe("");
  });

  it("sets Segoe UI, by any case, in the default's centred face", () => {
    const { interfaceFont } = open("Segoe UI");
    expect(interfaceFamily()).toBe('"Segoe UI Centred", "Segoe UI", var(--font-system)');
    interfaceFont.set("segoe ui");
    expect(interfaceFamily()).toBe('"Segoe UI Centred", "Segoe UI", var(--font-system)');
  });

  it("leaves a note's font alone, the Editor's picks falling back to the system's", () => {
    const wired = wire({ interfaceFont: fakeFont("Georgia"), editorFont: fakeFont("sans-serif") });
    expect(textFont()).toBe("var(--font-system)");
    wired.interfaceFont.set("monospace");
    expect(textFont()).toBe("var(--font-system)");
    wired.editorFont.set("Consolas");
    expect(textFont()).toBe('"Consolas", var(--font-system)');
  });

  it("offers the same three system fonts as the Editor's Font, the sans-serif as the default", async () => {
    const { openMenu, contextMenu } = open("sans-serif");
    await openMenu();
    expect(contextMenu.labels()).toEqual(["System monospace", "System sans-serif", "System serif"]);
    expect(contextMenu.rows().find((row) => row.label === "System sans-serif")?.mark).toBe("Default");
    expect(contextMenu.opened.at(-1)?.ariaLabel).toBe("Interface font");
  });

  it("names a picked font as the interface's, and puts the system sans-serif back from its reset", async () => {
    const { interfaceFont, picker, name, reset, openMenu, contextMenu } = open("sans-serif", ["Consolas", "Georgia"]);
    await openMenu();
    contextMenu.pick("Georgia");
    expect([name(), picker.getAttribute("aria-label"), reset.style.visibility]).toEqual([
      "Georgia",
      "Interface font: Georgia",
      "",
    ]);
    reset.click();
    expect([interfaceFont.get(), name(), reset.style.visibility, interfaceFamily()]).toEqual([
      "sans-serif",
      "Change font",
      "hidden",
      "",
    ]);
  });
});

describe("index.html's first-paint script", () => {
  // Node's URL: under jsdom the global one is jsdom's, which Node's fs
  // refuses.
  const html = readFileSync(new NodeURL("../../../web/index.html", import.meta.url), "utf8");
  const firstPaint = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  it.each([
    "",
    " ",
    "sans-serif",
    "serif",
    "monospace",
    "Segoe UI",
    "segoe ui",
    "Georgia",
    'My "Book" Font',
    "constructor",
  ])("paints the stored interface font %j as Settings sets it", async (stored) => {
    localStorage.setItem("pragma:interface-font", stored);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    new Function(firstPaint)();
    const painted = interfaceFamily();
    root.removeProperty("--font-interface");

    vi.resetModules();
    const { interfaceFont } = await import("../../../web/services/settings.ts");
    wire({ interfaceFont });
    expect(interfaceFamily()).toBe(painted);
  });
});
