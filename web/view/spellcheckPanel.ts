// Settings → Editor's spellcheck pages: Spellcheck languages, the
// dictionaries a word is checked against, and Custom dictionary, the words
// the text menu's Add to Dictionary put there, each with Remove. Only the
// desktop app shows them; a browser keeps both out of a page's reach.
import { buildRemoveButton, must } from "../lib/dom.ts";
import { togglePickerMenu } from "../lib/picker.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";

export interface SpellcheckPanelDeps {
  openSettingsSubpage: (id: string) => void;
  // Draws the picker Add language opens.
  contextMenu: ContextMenuService;
}

type Bridge = NonNullable<Window["pragmaElectron"]>;

export function wireSpellcheckPanel(root: HTMLElement, deps: SpellcheckPanelDeps): void {
  const bridge = window.pragmaElectron;
  if (!bridge) return;
  wireLanguages(root, bridge, deps);
  wireCustomDictionary(root, bridge, deps);
}

// A list's rows rebuilt after a removal: focus moves to the next row's
// Remove, so several go without the pointer, or to `fallback` when none is
// left.
function focusAfterRemoval(list: HTMLElement, index: number, fallback: HTMLElement): void {
  const buttons = list.querySelectorAll<HTMLButtonElement>("button");
  (buttons[Math.min(index, buttons.length - 1)] ?? fallback).focus();
}

function textRow(name: string, sub?: string): HTMLElement {
  const label = document.createElement("span");
  label.className = "settings-row-name";
  label.textContent = name;
  const meta = document.createElement("span");
  meta.className = "settings-list-row-meta";
  meta.append(label);
  if (sub !== undefined) {
    const detail = document.createElement("span");
    detail.className = "settings-row-sub";
    detail.textContent = sub;
    meta.append(detail);
  }
  const row = document.createElement("div");
  row.className = "settings-list-row";
  row.append(meta);
  return row;
}

// macOS's own spellchecker detects the language as you type and takes no
// list, so a Mac shows a line saying so in place of the row.
function wireLanguages(root: HTMLElement, bridge: Bridge, deps: SpellcheckPanelDeps): void {
  if (bridge.platform === "darwin") {
    must<HTMLElement>("#setting-spellcheck-languages-mac", root).hidden = false;
    return;
  }
  const row = must<HTMLButtonElement>("#setting-spellcheck-languages", root);
  const list = must<HTMLElement>("#spellcheck-language-list", root);
  const add = must<HTMLButtonElement>("#spellcheck-language-add", root);
  const display = new Intl.DisplayNames(undefined, { type: "language", languageDisplay: "standard" });
  // A code Intl can't name, such as a dictionary variant, shows as itself.
  const nameOf = (code: string): string => {
    try {
      return display.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const byName = (codes: readonly string[]) => [...codes].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  let chosen: string[] = [];
  let available: string[] = [];
  row.hidden = false;

  async function load(): Promise<void> {
    const languages = await bridge.spellcheckLanguages();
    chosen = byName(languages.chosen);
    available = byName(languages.available);
    list.replaceChildren(...chosen.map(languageRow));
  }

  async function choose(codes: string[]): Promise<void> {
    await bridge.setSpellcheckLanguages(codes);
    await load();
  }

  // The last language has no Remove: with none, nothing would be checked
  // while the Spellcheck switch says it is.
  function languageRow(code: string, index: number): HTMLElement {
    const item = textRow(nameOf(code), code);
    if (chosen.length > 1) {
      const remove = async () => {
        await choose(chosen.filter((other) => other !== code));
        focusAfterRemoval(list, index, add);
      };
      item.append(buildRemoveButton(nameOf(code), () => void remove()));
    }
    return item;
  }

  function addable(query: string): MenuItem[] {
    const typed = query.trim().toLowerCase();
    return available
      .filter((code) => !chosen.includes(code))
      .filter((code) => !typed || nameOf(code).toLowerCase().includes(typed) || code.toLowerCase().includes(typed))
      .map((code) => ({ label: nameOf(code), detail: code, run: () => void choose([...chosen, code]) }));
  }

  add.addEventListener("click", () =>
    togglePickerMenu(deps.contextMenu, add, {
      items: addable,
      search: "Search languages",
      ariaLabel: "Languages",
      empty: "No language matches.",
    }),
  );

  // Read before the page shows, so it never opens on an earlier visit's list.
  const open = () => deps.openSettingsSubpage("spellcheck-languages");
  row.addEventListener("click", () => void load().then(open, open));
}

function wireCustomDictionary(root: HTMLElement, bridge: Bridge, deps: SpellcheckPanelDeps): void {
  const row = must<HTMLButtonElement>("#setting-added-words", root);
  const list = must<HTMLElement>("#added-words-list", root);
  const empty = must<HTMLElement>("#added-words-empty", root);
  const back = must<HTMLElement>('[data-settings-subpage="added-words"] .settings-subpage-back', root);
  row.hidden = false;

  async function load(): Promise<void> {
    const words = await bridge.addedWords();
    words.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    list.replaceChildren(...words.map(wordRow));
    list.hidden = words.length === 0;
    empty.hidden = words.length > 0;
  }

  async function remove(word: string, index: number): Promise<void> {
    await bridge.removeFromDictionary(word);
    await load();
    focusAfterRemoval(list, index, back);
  }

  function wordRow(word: string, index: number): HTMLElement {
    const item = textRow(word);
    item.append(buildRemoveButton(word, () => void remove(word, index)));
    return item;
  }

  const open = () => deps.openSettingsSubpage("added-words");
  row.addEventListener("click", () => void load().then(open, open));
}
