// Keybindings: a chord mapped to a command id, resolved by the one document
// keydown listener the app has. The chord grammar is "Mod+Shift+K": Mod is
// ⌘ on macOS and Ctrl elsewhere; Ctrl, Alt, Shift, and Meta are explicit;
// keys are KeyboardEvent.key values with letters upper-cased, the space
// bar as "Space" and the plus key as "Plus".
//
// Several bindings may claim one chord — the highest weight whose `when`
// holds and whose command applies wins, the latest registration breaking
// ties — so a transient surface (a menu, a dialog) claims Escape while it is
// open and hands it back when it closes.
//
// A person's own chords for a command replace its defaults, never add to
// them, and count as registered after every default, so they win a tie.
import { type Disposable, listen, toDisposable } from "../lib/disposable.ts";
import type { CommandContext, CommandRegistry } from "./commands.ts";

export interface Keybinding {
  key: string;
  command: string;
  when?(context: CommandContext): boolean;
  weight?: number;
}

export interface KeybindingRegistry {
  register(binding: Keybinding): Disposable;
  // The binding an event resolves to, if any — pure, so the dispatch rule
  // is testable without a DOM.
  resolve(event: KeyboardEvent, context: CommandContext): Keybinding | undefined;
  // The chord that runs `command`, as a person reads it — the latest
  // binding's, since that one wins a tie.
  labelFor(command: string): string | undefined;
  // The person's own chords by command id, replacing the whole previous
  // set. A command listed with no chords has none, its defaults included.
  setUserChords(chords: Readonly<Record<string, readonly string[]>>): void;
  // Canonical chords: the ones that run `command` now, and the ones code
  // registered for it.
  chordsFor(command: string): string[];
  defaultChordsFor(command: string): string[];
  // A canonical chord as a person reads it: "Ctrl + Alt + ←", or macOS's
  // own "⌥⌘←". An arrow key reads as its arrow, which a key label draws
  // as an icon where markup can hold one.
  format(chord: string): string;
  // The one keydown listener. A matched chord runs its command and
  // prevents the default; an unmatched one is left alone. A key the
  // browser or an editor already handled (defaultPrevented) is never
  // re-dispatched.
  attach(target: EventTarget, context: () => CommandContext): Disposable;
}

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const ARROWS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

function keyName(key: string): string {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The canonical form of a chord — modifiers in a fixed order, then the
 * key — so a binding's text and an event's chord compare as strings. */
export function normalizeChord(chord: string, mac: boolean): string {
  const parts = chord.split("+").map((part) => part.trim());
  const key = keyName(parts[parts.length - 1] ?? "");
  const held = new Set(parts.slice(0, -1).map((part) => (part === "Mod" ? (mac ? "Meta" : "Ctrl") : part)));
  for (const part of held) {
    if (!(MODIFIERS as readonly string[]).includes(part)) throw new Error(`Unknown modifier "${part}" in "${chord}"`);
  }
  return [...MODIFIERS.filter((modifier) => held.has(modifier)), key].join("+");
}

/** A canonical chord as a person reads it, as a registry formats one: for a
 * CodeMirror key, which no registry holds. */
export function formatChord(chord: string, mac: boolean): string {
  const parts = chord.split("+").map((part) => ARROWS[part] ?? part);
  if (!mac) return parts.join(" + ");
  const symbols: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
  return parts.map((part) => symbols[part] ?? part).join("");
}

export function chordOf(event: KeyboardEvent): string {
  const held = [
    event.ctrlKey ? "Ctrl" : undefined,
    event.altKey ? "Alt" : undefined,
    event.shiftKey ? "Shift" : undefined,
    event.metaKey ? "Meta" : undefined,
  ].filter((part): part is string => part !== undefined);
  return [...held, keyName(event.key)].join("+");
}

const NOT_A_KEY = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "Fn",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
]);

/** Whether a press is only on its way to a chord: a modifier held alone, a
 * dead key, a composition in progress. */
export function isPartialChord(chord: string): boolean {
  return NOT_A_KEY.has(chord.slice(chord.lastIndexOf("+") + 1));
}

/** Whether a person can bind `chord`: one holding Ctrl, Alt or Meta, or a
 * function key. A plain or Shift-only key types, and Escape is every
 * dismissal's. The PDF frame (view/panes/pdfFrame.js) keeps its own copy to
 * pick the keys it hands up, so a change here goes there too. */
export function isBindable(chord: string): boolean {
  if (isPartialChord(chord)) return false;
  return /(^|\+)F\d{1,2}$/.test(chord) || /(^|\+)(Ctrl|Alt|Meta)\+/.test(chord);
}

// A chord that would type into a field is left to the field: only Escape
// and the chords a person can bind dispatch from an editable target.
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function bypassesEditable(chord: string): boolean {
  return chord === "Escape" || isBindable(chord);
}

export type Platform = "mac" | "windows" | "linux";

export function currentPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return "mac";
  return /Win/.test(navigator.platform) ? "windows" : "linux";
}

// A CodeMirror key binding, as far as naming its chord goes.
export interface CodeMirrorBinding {
  key?: string;
  mac?: string;
  win?: string;
  linux?: string;
  shift?: unknown;
  scope?: string;
}

const CODEMIRROR_MODIFIERS: Record<string, string> = {
  shift: "Shift",
  s: "Shift",
  ctrl: "Ctrl",
  control: "Ctrl",
  c: "Ctrl",
  alt: "Alt",
  a: "Alt",
  meta: "Meta",
  cmd: "Meta",
  m: "Meta",
  mod: "Mod",
};

/** The chords a CodeMirror keymap takes on `platform`, canonical: keys an
 * editor with focus handles before the app's listener sees them. A
 * multi-stroke binding is left out, since this grammar has no sequences, and
 * so is one scoped to a panel alone, which the editor's text never sees. */
export function codeMirrorChords(keymap: readonly CodeMirrorBinding[], platform: Platform): Set<string> {
  const mac = platform === "mac";
  const chords = new Set<string>();
  for (const binding of keymap) {
    if (binding.scope && !binding.scope.split(" ").includes("editor")) continue;
    const name =
      (mac && binding.mac) ||
      (platform === "windows" && binding.win) ||
      (platform === "linux" && binding.linux) ||
      binding.key;
    if (!name || name.includes(" ")) continue;
    const parts = name.split(/-(?!$)/);
    const key = parts.pop() ?? "";
    const held = parts.map((part) => CODEMIRROR_MODIFIERS[part.toLowerCase()] ?? part);
    // CodeMirror names a shifted letter by its capital: "Alt-A" is Alt+Shift+A.
    if (/^[A-Z]$/.test(key)) held.push("Shift");
    const text = [...held, keyName(key)].join("+");
    try {
      chords.add(normalizeChord(text, mac));
      if (binding.shift) chords.add(normalizeChord(`Shift+${text}`, mac));
    } catch {
      // A modifier this grammar lacks claims nothing a person can record.
    }
  }
  return chords;
}

export function createKeybindings(commands: CommandRegistry, options: { mac?: boolean } = {}): KeybindingRegistry {
  const mac = options.mac ?? currentPlatform() === "mac";
  type Entry = { chord: string; binding: Keybinding };
  // In registration order; resolve scans from the end so the latest wins a tie.
  const bindings: Entry[] = [];
  let personal: Entry[] = [];
  let overridden = new Set<string>();

  const unique = (chords: string[]) => [...new Set(chords)];
  const chordsOf = (entries: Entry[], command: string) =>
    unique(entries.filter(({ binding }) => binding.command === command).map(({ chord }) => chord));

  function resolve(event: KeyboardEvent, context: CommandContext): Keybinding | undefined {
    const chord = chordOf(event);
    const entries = [...bindings.filter(({ binding }) => !overridden.has(binding.command)), ...personal];
    let best: { weight: number; binding: Keybinding } | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const { chord: bound, binding } = entries[i];
      if (bound !== chord) continue;
      const weight = binding.weight ?? 0;
      if (best && weight <= best.weight) continue;
      if (!(binding.when?.(context) ?? true)) continue;
      if (!commands.isEnabled(binding.command, context)) continue;
      best = { weight, binding };
    }
    return best?.binding;
  }

  function chordsFor(command: string): string[] {
    return overridden.has(command) ? chordsOf(personal, command) : chordsOf(bindings, command);
  }

  const format = (chord: string) => formatChord(chord, mac);

  return {
    register(binding) {
      const entry = { chord: normalizeChord(binding.key, mac), binding };
      bindings.push(entry);
      return toDisposable(() => {
        const index = bindings.indexOf(entry);
        if (index >= 0) bindings.splice(index, 1);
      });
    },
    resolve,
    labelFor(command) {
      const chords = chordsFor(command);
      return chords.length > 0 ? format(chords[chords.length - 1]) : undefined;
    },
    setUserChords(chords) {
      overridden = new Set(Object.keys(chords));
      personal = Object.entries(chords).flatMap(([command, list]) =>
        list.flatMap((text) => {
          try {
            return [{ chord: normalizeChord(text, mac), binding: { key: text, command } }];
          } catch {
            // Stored text this grammar can't read binds nothing, rather than failing startup.
            return [];
          }
        }),
      );
    },
    chordsFor,
    defaultChordsFor: (command) => chordsOf(bindings, command),
    format,
    attach(target, context) {
      return listen(target, "keydown", (event) => {
        const keyboard = event as KeyboardEvent;
        if (keyboard.defaultPrevented || keyboard.isComposing) return;
        if (isEditable(keyboard.target) && !bypassesEditable(chordOf(keyboard))) return;
        const current = context();
        const binding = resolve(keyboard, current);
        if (!binding) return;
        keyboard.preventDefault();
        void commands.run(binding.command, current);
      });
    },
  };
}
