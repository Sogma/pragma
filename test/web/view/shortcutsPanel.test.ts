// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { COMMAND_PALETTE, createMenus } from "../../../web/services/menus.ts";
import type { Setting, ShortcutOverrides } from "../../../web/services/settings.ts";
import { wireShortcutsPanel } from "../../../web/view/shortcutsPanel.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

function setup() {
  const root = document.createElement("div");
  root.innerHTML = `
    <input id="shortcuts-filter" />
    <button id="shortcuts-by-key" aria-pressed="false"></button>
    <div id="shortcuts-list"></div>`;
  document.body.replaceChildren(root);

  const commands = createCommands();
  for (const [id, label] of [
    ["zeta", "Zeta"],
    ["alpha", "Alpha"],
    ["mid", "Mid"],
  ]) {
    commands.register({ id, label, run: vi.fn() });
  }
  const keybindings = createKeybindings(commands, { mac: false });
  keybindings.register({ key: "Mod+K", command: "zeta" });
  keybindings.register({ key: "Mod+K", command: "alpha" });
  keybindings.register({ key: "F1", command: "alpha" });
  const menus = createMenus(commands);
  menus.register(COMMAND_PALETTE, [{ command: "zeta" }, { command: "alpha" }, { command: "mid" }]);

  // As main.ts wires it: the stored overrides feed the registry.
  const stored = new Emitter<ShortcutOverrides>({});
  const shortcuts: Setting<ShortcutOverrides> = {
    get: () => stored.get(),
    set: (value) => stored.set(value),
    subscribe: (listener) => stored.subscribe(listener),
  };
  shortcuts.subscribe((chords) => keybindings.setUserChords(chords));

  const show = wireShortcutsPanel(root, {
    menus,
    keybindings,
    context: () => context,
    shortcuts,
    platform: "windows",
    editorChords: new Set(["Ctrl+D"]),
  });
  show();

  const row = (label: string) => {
    const found = [...root.querySelectorAll<HTMLElement>(".shortcut-row")].find(
      (element) => element.querySelector(".field-row-title")?.textContent === label,
    );
    if (!found) throw new Error(`no row ${label}`);
    return found;
  };
  const chips = (label: string) =>
    [...row(label).querySelectorAll<HTMLElement>(".shortcut-chip")].map((chip) => ({
      key: chip.querySelector(".shortcut-chip-key")?.textContent,
      warning: chip.dataset.tooltip || undefined,
    }));
  const labels = () => [...root.querySelectorAll(".shortcut-row .field-row-title")].map((title) => title.textContent);
  const press = (target: Element, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const recorder = () => root.querySelector<HTMLElement>(".shortcut-recorder");
  const startRecording = (label: string) => {
    row(label).querySelector<HTMLButtonElement>(".shortcut-add")?.click();
    const element = recorder();
    if (!element) throw new Error("no recorder");
    return element;
  };
  const filter = root.querySelector<HTMLInputElement>("#shortcuts-filter") as HTMLInputElement;
  const byKey = root.querySelector<HTMLButtonElement>("#shortcuts-by-key") as HTMLButtonElement;
  return { root, keybindings, shortcuts, row, chips, labels, press, recorder, startRecording, filter, byKey };
}

describe("Settings → Shortcuts", () => {
  it("lists the palette's commands by name, each with its chords, marking one another command shares", () => {
    const { labels, chips, row } = setup();
    expect(labels()).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(chips("Alpha")).toEqual([
      { key: "Ctrl + K", warning: "Shared with Zeta" },
      { key: "F1", warning: undefined },
    ]);
    expect(chips("Zeta")).toEqual([{ key: "Ctrl + K", warning: "Shared with Alpha" }]);
    expect(chips("Mid")).toEqual([]);
    expect(row("Alpha").querySelector(".shortcut-reset")).toBeNull();
  });

  it("records a chord pressed after +, which then runs the command, and Reset takes it back", () => {
    const { startRecording, recorder, press, shortcuts, chips, keybindings, row } = setup();
    const element = startRecording("Mid");
    expect(document.activeElement).toBe(element);

    // A modifier alone waits; a key that types is refused with a hint.
    press(element, { key: "Control", ctrlKey: true });
    expect(recorder()?.textContent).toBe("Press a shortcut…");
    press(element, { key: "k" });
    expect(recorder()?.textContent).toBe("Hold Ctrl or Alt with the key, or press a function key");

    const chord = press(element, { key: "d", ctrlKey: true });
    expect(chord.defaultPrevented).toBe(true);
    expect(recorder()).toBeNull();
    expect(shortcuts.get()).toEqual({ mid: ["Ctrl+D"] });
    expect(chips("Mid")).toEqual([
      { key: "Ctrl + D", warning: "While you type in a document, the editor takes it first" },
    ]);
    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true });
    expect(keybindings.resolve(event, context)?.command).toBe("mid");
    expect(document.activeElement).toBe(row("Mid").querySelector(".shortcut-add"));

    row("Mid").querySelector<HTMLButtonElement>(".shortcut-reset")?.click();
    expect(shortcuts.get()).toEqual({});
    expect(chips("Mid")).toEqual([]);
  });

  it("draws an arrow key in a chord as its icon", () => {
    const { startRecording, press, shortcuts, row } = setup();
    press(startRecording("Mid"), { key: "ArrowLeft", ctrlKey: true, altKey: true });
    expect(shortcuts.get()).toEqual({ mid: ["Ctrl+Alt+ArrowLeft"] });
    const key = row("Mid").querySelector(".shortcut-chip-key");
    expect(key?.textContent).toBe("Ctrl + Alt + ");
    expect(key?.querySelector(".key-arrow-left")?.getAttribute("aria-label")).toBe("Left arrow");
    expect(row("Mid").querySelector(".shortcut-chip-remove")?.getAttribute("aria-label")).toBe(
      "Remove Ctrl + Alt + ← from Mid",
    );
  });

  it("keeps Escape from the dialog while recording, and cancels", () => {
    const { startRecording, recorder, press, shortcuts } = setup();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    const escapePress = press(startRecording("Mid"), { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(escapePress.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    expect(recorder()).toBeNull();
    expect(shortcuts.get()).toEqual({});
  });

  it("removing a chord stores the rest, and the defaults again store nothing", () => {
    const { row, shortcuts, chips, startRecording, press } = setup();
    const remove = [...row("Alpha").querySelectorAll<HTMLButtonElement>(".shortcut-chip-remove")];
    remove[1]?.click();
    expect(shortcuts.get()).toEqual({ alpha: ["Ctrl+K"] });
    expect(chips("Alpha").map((chip) => chip.key)).toEqual(["Ctrl + K"]);
    expect(row("Alpha").querySelector(".shortcut-reset")).not.toBeNull();

    press(startRecording("Alpha"), { key: "F1" });
    expect(shortcuts.get()).toEqual({});
    expect(row("Alpha").querySelector(".shortcut-reset")).toBeNull();
  });

  it("filters by name, or by a pressed chord", () => {
    const { filter, byKey, labels, press } = setup();
    filter.value = "zet";
    filter.dispatchEvent(new Event("input"));
    expect(labels()).toEqual(["Zeta"]);

    byKey.click();
    expect(byKey.getAttribute("aria-pressed")).toBe("true");
    expect(labels()).toEqual(["Alpha", "Mid", "Zeta"]);
    press(filter, { key: "k", ctrlKey: true });
    expect(filter.value).toBe("Ctrl + K");
    expect(labels()).toEqual(["Alpha", "Zeta"]);
    press(filter, { key: "F2" });
    expect(labels()).toEqual([]);

    const escapePress = press(filter, { key: "Escape" });
    expect(escapePress.defaultPrevented).toBe(true);
    expect(byKey.getAttribute("aria-pressed")).toBe("false");
    expect(labels()).toEqual(["Alpha", "Mid", "Zeta"]);
  });
});
