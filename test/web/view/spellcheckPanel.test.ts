// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../web/lib/dom.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService, MenuOpenOptions } from "../../../web/services/menus.ts";
import { wireSpellcheckPanel } from "../../../web/view/spellcheckPanel.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

afterEach(() => {
  delete window.pragmaElectron;
});

interface Desktop {
  platform?: string;
  words?: string[];
  chosen?: string[];
  available?: string[];
}

// Settings → Editor's spellcheck rows and their subpages as web/index.html has them.
function setup(desktop: Desktop | undefined) {
  const root = document.createElement("div");
  root.innerHTML = `
    <section class="settings-category" data-settings-category="editor">
      <div class="settings-card">
        <button id="setting-spellcheck-languages" type="button" class="list-item settings-open-row" hidden>Spellcheck languages</button>
        <div id="setting-spellcheck-languages-mac" class="field-row" hidden>macOS detects the language as you type.</div>
        <button id="setting-added-words" type="button" class="list-item settings-open-row" hidden>Custom dictionary</button>
      </div>
    </section>
    <section class="settings-subpage" data-settings-subpage="added-words" data-settings-parent="editor" hidden>
      <div class="settings-subpage-head"><button type="button" class="settings-subpage-back">Editor</button></div>
      <div class="settings-card">
        <div id="added-words-list" class="settings-card-list"></div>
        <p id="added-words-empty" class="settings-intro" hidden>No added words.</p>
      </div>
    </section>
    <section class="settings-subpage" data-settings-subpage="spellcheck-languages" data-settings-parent="editor" hidden>
      <div class="settings-subpage-head"><button type="button" class="settings-subpage-back">Editor</button></div>
      <div class="settings-card">
        <div id="spellcheck-language-list" class="settings-card-list"></div>
        <button id="spellcheck-language-add" type="button" class="list-item settings-add-row">Add language</button>
      </div>
    </section>`;
  document.body.replaceChildren(root);
  const words = [...(desktop?.words ?? [])];
  let chosen = [...(desktop?.chosen ?? ["en-US"])];
  const bridge = {
    platform: desktop?.platform ?? "linux",
    addedWords: vi.fn(async () => [...words]),
    removeFromDictionary: vi.fn(async (word: string) => {
      words.splice(words.indexOf(word), 1);
    }),
    spellcheckLanguages: vi.fn(async () => ({ chosen: [...chosen], available: [...(desktop?.available ?? chosen)] })),
    setSpellcheckLanguages: vi.fn(async (codes: string[]) => {
      chosen = [...codes];
    }),
  };
  if (desktop) window.pragmaElectron = bridge as unknown as NonNullable<Window["pragmaElectron"]>;
  const opened: MenuOpenOptions[] = [];
  const contextMenu = { open: (options) => void opened.push(options), close() {}, isOpen: () => false } as Pick<
    ContextMenuService,
    "open" | "close" | "isOpen"
  > as ContextMenuService;
  // Shows the subpage, as settingsPanel.ts does: a button inside a hidden
  // subpage can't take focus, so the focus-after-Remove checks need it shown.
  const openSettingsSubpage = vi.fn((id: string) => {
    must<HTMLElement>(`[data-settings-subpage="${id}"]`, root).hidden = false;
  });
  wireSpellcheckPanel(root, { openSettingsSubpage, contextMenu });
  const names = (list: string) =>
    [...root.querySelectorAll(`#${list} .settings-row-name`)].map((name) => name.textContent);
  const button = (label: string) => must<HTMLButtonElement>(`[aria-label="${label}"]`, root);
  return { root, bridge, opened, openSettingsSubpage, names, button };
}

describe("wireSpellcheckPanel", () => {
  it("shows none of its rows outside the desktop app", () => {
    const { root } = setup(undefined);
    for (const id of ["setting-spellcheck-languages", "setting-spellcheck-languages-mac", "setting-added-words"]) {
      expect(must<HTMLElement>(`#${id}`, root).hidden).toBe(true);
    }
  });

  describe("Spellcheck languages", () => {
    // macOS's own spellchecker takes no list, so a Mac gets a line instead.
    it("shows a Mac the line saying macOS detects the language, and no row", () => {
      const { root } = setup({ platform: "darwin" });
      expect(must<HTMLElement>("#setting-spellcheck-languages-mac", root).hidden).toBe(false);
      expect(must<HTMLElement>("#setting-spellcheck-languages", root).hidden).toBe(true);
    });

    it("reads the languages before opening their page, each by name, the last one with no Remove", async () => {
      const { root, names, openSettingsSubpage } = setup({ chosen: ["en-US"], available: ["de-DE", "en-US"] });
      expect(must<HTMLElement>("#setting-spellcheck-languages-mac", root).hidden).toBe(true);
      must<HTMLButtonElement>("#setting-spellcheck-languages", root).click();
      expect(openSettingsSubpage).not.toHaveBeenCalled();
      await tick();
      expect(openSettingsSubpage).toHaveBeenCalledWith("spellcheck-languages");
      expect(names("spellcheck-language-list")).toEqual(["English (United States)"]);
      expect(root.querySelector("#spellcheck-language-list button")).toBeNull();
    });

    it("adds a language from a picker of the ones not chosen yet, searched by name or code", async () => {
      const { root, bridge, opened, names } = setup({ chosen: ["en-US"], available: ["pt-BR", "en-US", "de-DE"] });
      must<HTMLButtonElement>("#setting-spellcheck-languages", root).click();
      await tick();
      must<HTMLButtonElement>("#spellcheck-language-add", root).click();
      const menu = opened.at(-1);
      expect(menu?.items?.map((item) => item.label)).toEqual(["German (Germany)", "Portuguese (Brazil)"]);
      expect(menu?.search?.filter("portu").map((item) => item.label)).toEqual(["Portuguese (Brazil)"]);
      expect(menu?.search?.filter("de-").map((item) => item.label)).toEqual(["German (Germany)"]);

      await menu?.items?.find((item) => item.label === "Portuguese (Brazil)")?.run?.(context, undefined);
      await tick();
      expect(bridge.setSpellcheckLanguages).toHaveBeenCalledWith(["en-US", "pt-BR"]);
      expect(names("spellcheck-language-list")).toEqual(["English (United States)", "Portuguese (Brazil)"]);
    });

    it("removes a language, handing focus to the next Remove or, with one left, to Add language", async () => {
      const { root, bridge, names, button } = setup({ chosen: ["en-US", "pt-BR"], available: ["en-US", "pt-BR"] });
      must<HTMLButtonElement>("#setting-spellcheck-languages", root).click();
      await tick();
      button("Remove English (United States)").click();
      await tick();
      expect(bridge.setSpellcheckLanguages).toHaveBeenCalledWith(["pt-BR"]);
      expect(names("spellcheck-language-list")).toEqual(["Portuguese (Brazil)"]);
      expect(document.activeElement).toBe(must<HTMLElement>("#spellcheck-language-add", root));
    });
  });

  describe("Custom dictionary", () => {
    it("reads the words before opening their page, in alphabetical order", async () => {
      const { root, names, openSettingsSubpage } = setup({ words: ["zorbly", "Pragma", "applet"] });
      const row = must<HTMLButtonElement>("#setting-added-words", root);
      expect(row.hidden).toBe(false);
      row.click();
      expect(openSettingsSubpage).not.toHaveBeenCalled();
      await tick();
      expect(names("added-words-list")).toEqual(["applet", "Pragma", "zorbly"]);
      expect(openSettingsSubpage).toHaveBeenCalledWith("added-words");
    });

    it("removes a word and hands focus to the next one's Remove, then to Back once none are left", async () => {
      const { root, names, bridge, button } = setup({ words: ["alpha", "beta"] });
      must<HTMLButtonElement>("#setting-added-words", root).click();
      await tick();

      button("Remove alpha").click();
      await tick();
      expect(bridge.removeFromDictionary).toHaveBeenCalledWith("alpha");
      expect(names("added-words-list")).toEqual(["beta"]);
      expect(document.activeElement).toBe(button("Remove beta"));

      button("Remove beta").click();
      await tick();
      expect(names("added-words-list")).toEqual([]);
      expect(must<HTMLElement>("#added-words-empty", root).hidden).toBe(false);
      expect(must<HTMLElement>("#added-words-list", root).hidden).toBe(true);
      const back = must<HTMLElement>('[data-settings-subpage="added-words"] .settings-subpage-back', root);
      expect(document.activeElement).toBe(back);
    });
  });
});
