// Settings → Shortcuts: every command the palette lists, the chords that run
// it, and a person's own chords in place of its defaults. A chord another
// listed command also has, or one the document editor takes first, is
// marked rather than refused: two commands that never apply at once can
// share a chord.
import { scoreLabel } from "../core/quickOpenMatch.ts";
import { keyLabel, must } from "../lib/dom.ts";
import type { CommandContext } from "../services/commands.ts";
import {
  chordOf,
  isBindable,
  isPartialChord,
  type KeybindingRegistry,
  type Platform,
} from "../services/keybindings.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../services/menus.ts";
import type { Setting, ShortcutOverrides } from "../services/settings.ts";

export interface ShortcutsPanelDeps {
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  context(): CommandContext;
  shortcuts: Setting<ShortcutOverrides>;
  platform: Platform;
  /** The chords the document editor handles before the app sees them. */
  editorChords: ReadonlySet<string>;
}

interface Row {
  command: string;
  label: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function iconButton(className: string, title: string, ariaLabel: string): HTMLButtonElement {
  const button = el("button", `icon-button ${className}`);
  button.type = "button";
  button.dataset.tooltip = title;
  button.setAttribute("aria-label", ariaLabel);
  button.append(el("span", `${className}-icon`));
  return button;
}

/** Wires the category's static markup in `root` (`#settings-body`) and
 * returns its redraw, run each time the category is shown. */
export function wireShortcutsPanel(root: HTMLElement, deps: ShortcutsPanelDeps): () => void {
  const filter = must<HTMLInputElement>("#shortcuts-filter", root);
  const byKey = must<HTMLButtonElement>("#shortcuts-by-key", root);
  const list = must<HTMLDivElement>("#shortcuts-list", root);
  const { keybindings } = deps;
  const hint =
    deps.platform === "mac"
      ? "Hold ⌘, ⌃ or ⌥ with the key, or press a function key"
      : "Hold Ctrl or Alt with the key, or press a function key";

  let rows: Row[] = [];
  // The command whose + was pressed, waiting for a chord.
  let recording: string | undefined;
  // Search by key: on, and the chord pressed since (undefined until one is).
  let searchingByKey = false;
  let searchedChord: string | undefined;

  const chordMap = () => new Map(rows.map((row) => [row.command, keybindings.chordsFor(row.command)]));
  const rowElement = (command: string) =>
    list.querySelector<HTMLElement>(`.shortcut-row[data-command="${CSS.escape(command)}"]`);

  function warningFor(row: Row, chord: string, chords: Map<string, string[]>): string | undefined {
    const shared = rows.filter((other) => other !== row && chords.get(other.command)?.includes(chord));
    const notes = shared.length > 0 ? [`Shared with ${shared.map((other) => other.label).join(", ")}`] : [];
    if (deps.editorChords.has(chord)) notes.push("While you type in a document, the editor takes it first");
    return notes.length > 0 ? notes.join("\n") : undefined;
  }

  // A list matching the defaults is stored as no override, so Reset shows
  // only where the chords really differ.
  function save(command: string, chords: string[]): void {
    const next: Record<string, readonly string[]> = { ...deps.shortcuts.get() };
    const defaults = keybindings.defaultChordsFor(command);
    if (chords.length === defaults.length && chords.every((chord) => defaults.includes(chord))) delete next[command];
    else next[command] = chords;
    deps.shortcuts.set(next);
    draw();
  }

  function chip(row: Row, chord: string, own: string[], chords: Map<string, string[]>): HTMLElement {
    const element = el("span", "shortcut-chip");
    const text = keybindings.format(chord);
    const key = el("kbd", "shortcut-chip-key");
    key.append(keyLabel(text));
    const remove = iconButton("shortcut-chip-remove", "Remove", `Remove ${text} from ${row.label}`);
    const rest = own.filter((other) => other !== chord);
    remove.addEventListener("click", () => save(row.command, rest));
    element.append(key, remove);
    const warning = warningFor(row, chord, chords);
    if (warning) {
      element.classList.add("shortcut-chip-warning");
      element.dataset.tooltip = warning;
    }
    return element;
  }

  function stopRecording(command: string): void {
    recording = undefined;
    redrawRow(command);
  }

  // The recorder takes every key but Tab, so Escape cancels here instead of
  // closing Settings, and a chord bound elsewhere doesn't run its command.
  function recorder(row: Row, own: string[]): HTMLElement {
    const element = el("span", "shortcut-recorder");
    element.tabIndex = 0;
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-label", `Shortcut for ${row.label}`);
    element.textContent = "Press a shortcut…";
    element.addEventListener("keydown", (event) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      const chord = chordOf(event);
      if (chord === "Escape") {
        stopRecording(row.command);
        focusAdd(row.command);
      } else if (isBindable(chord)) {
        recording = undefined;
        save(row.command, own.includes(chord) ? own : [...own, chord]);
        focusAdd(row.command);
      } else if (!isPartialChord(chord)) {
        element.textContent = hint;
      }
    });
    element.addEventListener("blur", () => {
      if (recording === row.command) stopRecording(row.command);
    });
    return element;
  }

  function drawRow(row: Row, chords: Map<string, string[]>): HTMLElement {
    const own = chords.get(row.command) ?? [];
    const element = el("div", "field-row shortcut-row");
    element.dataset.command = row.command;
    const title = el("div", "field-row-title");
    title.textContent = row.label;
    const keys = el("div", "shortcut-keys");
    for (const chord of own) keys.append(chip(row, chord, own, chords));
    if (recording === row.command) {
      keys.append(recorder(row, own));
    } else {
      const add = iconButton("shortcut-add", "Add shortcut", `Add a shortcut for ${row.label}`);
      add.addEventListener("click", () => {
        recording = row.command;
        redrawRow(row.command)?.querySelector<HTMLElement>(".shortcut-recorder")?.focus();
      });
      keys.append(add);
    }
    if (row.command in deps.shortcuts.get()) {
      const reset = iconButton("shortcut-reset", "Reset to default", `Reset ${row.label} to its default shortcuts`);
      reset.addEventListener("click", () => save(row.command, keybindings.defaultChordsFor(row.command)));
      keys.append(reset);
    }
    element.append(title, keys);
    return element;
  }

  // One row only, so a press on another row's + that ends this recording
  // still lands on a button that is in the page.
  function redrawRow(command: string): HTMLElement | undefined {
    const row = rows.find((candidate) => candidate.command === command);
    const current = rowElement(command);
    if (!row || !current) return undefined;
    const next = drawRow(row, chordMap());
    current.replaceWith(next);
    return next;
  }

  function focusAdd(command: string): void {
    rowElement(command)?.querySelector<HTMLElement>(".shortcut-add")?.focus();
  }

  function draw(): void {
    const chords = chordMap();
    const query = filter.value.trim();
    const shown = rows.filter((row) => {
      if (searchingByKey) return searchedChord === undefined || chords.get(row.command)?.includes(searchedChord);
      return !query || scoreLabel(row.label, query) !== undefined;
    });
    list.replaceChildren(...shown.map((row) => drawRow(row, chords)));
    if (shown.length === 0) {
      const empty = el("p", "settings-intro");
      empty.textContent = searchingByKey ? "No command uses that shortcut." : "No command matches.";
      list.append(empty);
    }
  }

  function setSearchingByKey(on: boolean): void {
    searchingByKey = on;
    searchedChord = undefined;
    byKey.setAttribute("aria-pressed", String(on));
    filter.value = "";
    filter.placeholder = on ? "Press a shortcut" : "Search commands";
    filter.focus();
    draw();
  }

  filter.addEventListener("input", () => {
    if (!searchingByKey) draw();
  });
  filter.addEventListener("keydown", (event) => {
    if (!searchingByKey || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const chord = chordOf(event);
    if (chord === "Escape") return setSearchingByKey(false);
    if (isPartialChord(chord)) return;
    searchedChord = chord === "Backspace" || chord === "Delete" ? undefined : chord;
    filter.value = searchedChord === undefined ? "" : keybindings.format(searchedChord);
    draw();
  });
  byKey.addEventListener("click", () => setSearchingByKey(!searchingByKey));

  return () => {
    recording = undefined;
    rows = deps.menus.commandsIn(COMMAND_PALETTE, deps.context()).sort((a, b) => a.label.localeCompare(b.label));
    draw();
  };
}
