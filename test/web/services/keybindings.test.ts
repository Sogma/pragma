// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import {
  chordOf,
  codeMirrorChords,
  createKeybindings,
  isBindable,
  isPartialChord,
  normalizeChord,
} from "../../../web/services/keybindings.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

function key(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("chords", () => {
  it("normalizes a binding's text and an event to the same string", () => {
    expect(normalizeChord("mod+shift+k".replace("mod", "Mod").replace("shift", "Shift"), false)).toBe("Ctrl+Shift+K");
    expect(normalizeChord("Mod+K", true)).toBe("Meta+K");
    expect(normalizeChord("Shift + Ctrl + Enter", false)).toBe("Ctrl+Shift+Enter");
    expect(normalizeChord("Escape", true)).toBe("Escape");
    expect(normalizeChord("Space", false)).toBe("Space");
    expect(() => normalizeChord("Hyper+K", false)).toThrow('Unknown modifier "Hyper"');

    expect(chordOf(key({ key: "k", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
    expect(chordOf(key({ key: " " }))).toBe("Space");
    expect(chordOf(key({ key: "Escape" }))).toBe("Escape");
  });

  it("names the plus key, so a chord holding it still splits on +", () => {
    const chord = chordOf(key({ key: "+", ctrlKey: true, shiftKey: true }));
    expect(chord).toBe("Ctrl+Shift+Plus");
    expect(normalizeChord(chord, false)).toBe(chord);
  });

  it("binds only a chord holding Ctrl, Alt or Meta, or a function key", () => {
    expect(["Ctrl+K", "Alt+Shift+K", "Meta+,", "F2", "Shift+F5", "Ctrl+Escape"].filter(isBindable)).toHaveLength(6);
    expect(["K", "Shift+K", "Escape", "Enter", "Ctrl+Control", "Alt+Dead", "F"].filter(isBindable)).toEqual([]);
    expect(isPartialChord("Ctrl+Shift+Shift")).toBe(true);
    expect(isPartialChord("Ctrl+Shift+K")).toBe(false);
  });

  it("reads a CodeMirror keymap in this grammar, for the platform it runs on", () => {
    const keymap = [
      { key: "Mod-d" },
      { key: "Alt-A", mac: "Ctrl-A" },
      { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[" },
      { key: "Mod-ArrowLeft", shift: () => true },
      { linux: "Ctrl-Shift-z" },
      { key: "Ctrl-k Ctrl-c" },
      { key: "Mod--" },
    ];
    expect([...codeMirrorChords(keymap, "windows")]).toEqual([
      "Ctrl+D",
      "Alt+Shift+A",
      "Ctrl+Shift+[",
      "Ctrl+ArrowLeft",
      "Ctrl+Shift+ArrowLeft",
      "Ctrl+-",
    ]);
    expect(codeMirrorChords(keymap, "linux").has("Ctrl+Shift+Z")).toBe(true);
    expect([...codeMirrorChords(keymap, "mac")].slice(0, 3)).toEqual(["Meta+D", "Ctrl+Shift+A", "Alt+Meta+["]);
  });

  it("leaves out a binding scoped to a panel alone, which typing in the text never reaches", () => {
    const keymap = [
      { key: "Mod-h", scope: "editor search-panel" },
      { key: "Alt-c", scope: "search-panel" },
      { key: "F3" },
    ];
    expect([...codeMirrorChords(keymap, "windows")]).toEqual(["Ctrl+H", "F3"]);
  });
});

describe("keybindings", () => {
  function setup(mac = false) {
    const commands = createCommands();
    const ran: string[] = [];
    for (const id of ["a", "b", "c"]) commands.register({ id, label: id, run: () => void ran.push(id) });
    commands.register({ id: "disabled", label: "d", run: () => void ran.push("disabled"), when: () => false });
    const keybindings = createKeybindings(commands, { mac });
    return { commands, keybindings, ran };
  }

  it("resolves the highest weight whose when holds, the latest registration winning a tie", () => {
    const { keybindings } = setup();
    keybindings.register({ key: "Escape", command: "a" });
    keybindings.register({ key: "Escape", command: "b" });
    expect(keybindings.resolve(key({ key: "Escape" }), context)?.command).toBe("b");

    keybindings.register({ key: "Escape", command: "c", weight: 5, when: () => false });
    expect(keybindings.resolve(key({ key: "Escape" }), context)?.command).toBe("b");

    const heavy = keybindings.register({ key: "Escape", command: "a", weight: 5 });
    expect(keybindings.resolve(key({ key: "Escape" }), context)?.command).toBe("a");
    heavy.dispose();
    expect(keybindings.resolve(key({ key: "Escape" }), context)?.command).toBe("b");

    keybindings.register({ key: "Mod+K", command: "disabled", weight: 9 });
    keybindings.register({ key: "Mod+K", command: "c" });
    expect(keybindings.resolve(key({ key: "k", ctrlKey: true }), context)?.command).toBe("c");
    expect(keybindings.resolve(key({ key: "k", metaKey: true }), context)).toBeUndefined();
  });

  it("Mod is Meta on macOS", () => {
    const { keybindings } = setup(true);
    keybindings.register({ key: "Mod+K", command: "a" });
    expect(keybindings.resolve(key({ key: "k", metaKey: true }), context)?.command).toBe("a");
    expect(keybindings.resolve(key({ key: "k", ctrlKey: true }), context)).toBeUndefined();
  });

  it("the attached listener runs the command, prevents default, and skips handled or editable keys", async () => {
    const { keybindings, ran } = setup();
    const contextFn = vi.fn(() => context);
    const root = document.createElement("div");
    const input = document.createElement("input");
    root.append(input);
    document.body.append(root);
    const disposable = keybindings.attach(root, contextFn);
    keybindings.register({ key: "Escape", command: "a" });
    keybindings.register({ key: "Mod+K", command: "b" });
    keybindings.register({ key: "Delete", command: "c" });

    const escapeKey = key({ key: "Escape" });
    root.dispatchEvent(escapeKey);
    await Promise.resolve();
    expect(ran).toEqual(["a"]);
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(contextFn).toHaveBeenCalledTimes(1);

    const handled = key({ key: "Escape" });
    handled.preventDefault();
    root.dispatchEvent(handled);
    const unbound = key({ key: "x" });
    root.dispatchEvent(unbound);
    expect(unbound.defaultPrevented).toBe(false);

    // In a field: a plain key stays with the field, Escape and Mod chords don't.
    input.dispatchEvent(key({ key: "Delete" }));
    input.dispatchEvent(key({ key: "k", ctrlKey: true }));
    input.dispatchEvent(key({ key: "Escape" }));
    await Promise.resolve();
    expect(ran).toEqual(["a", "b", "a"]);

    disposable.dispose();
    root.dispatchEvent(key({ key: "Escape" }));
    await Promise.resolve();
    expect(ran).toHaveLength(3);
  });

  it("dispatches a function key from a field, since it types nothing there", async () => {
    const { keybindings, ran } = setup();
    const input = document.createElement("input");
    document.body.append(input);
    const disposable = keybindings.attach(document.body, () => context);
    keybindings.register({ key: "F2", command: "a" });
    input.dispatchEvent(key({ key: "F2" }));
    await Promise.resolve();
    expect(ran).toEqual(["a"]);
    disposable.dispose();
    input.remove();
  });

  it("a person's chords replace a command's defaults, and win a tie with another's", () => {
    const { keybindings } = setup();
    keybindings.register({ key: "Mod+K", command: "a" });
    keybindings.register({ key: "F1", command: "a" });
    keybindings.register({ key: "Mod+J", command: "b" });
    keybindings.setUserChords({ a: ["Ctrl+J"] });

    expect(keybindings.resolve(key({ key: "k", ctrlKey: true }), context)).toBeUndefined();
    expect(keybindings.resolve(key({ key: "F1" }), context)).toBeUndefined();
    expect(keybindings.resolve(key({ key: "j", ctrlKey: true }), context)?.command).toBe("a");
    expect(keybindings.chordsFor("a")).toEqual(["Ctrl+J"]);
    expect(keybindings.defaultChordsFor("a")).toEqual(["Ctrl+K", "F1"]);
    expect(keybindings.labelFor("a")).toBe("Ctrl + J");
    expect(keybindings.chordsFor("b")).toEqual(["Ctrl+J"]);

    // An empty list unbinds, and text the grammar can't read binds nothing.
    keybindings.setUserChords({ a: [], b: ["Hyper+J", "Alt+B"] });
    expect(keybindings.chordsFor("a")).toEqual([]);
    expect(keybindings.labelFor("a")).toBeUndefined();
    expect(keybindings.chordsFor("b")).toEqual(["Alt+B"]);

    keybindings.setUserChords({});
    expect(keybindings.chordsFor("a")).toEqual(["Ctrl+K", "F1"]);
    expect(keybindings.resolve(key({ key: "j", ctrlKey: true }), context)?.command).toBe("b");
  });

  it("formats a chord with spaced pluses and an arrow key as its arrow, and macOS in its own symbols", () => {
    const pc = setup().keybindings;
    expect(pc.format("Ctrl+Alt+ArrowLeft")).toBe("Ctrl + Alt + ←");
    expect(pc.format("Shift+ArrowDown")).toBe("Shift + ↓");
    expect(pc.format("F2")).toBe("F2");
    const mac = setup(true).keybindings;
    expect(mac.format("Alt+Meta+ArrowRight")).toBe("⌥⌘→");
    expect(mac.format("Ctrl+ArrowUp")).toBe("⌃↑");
  });

  it("labels the chord that runs a command, the latest binding winning, in the platform's notation", () => {
    const pc = setup().keybindings;
    pc.register({ key: "Mod+Shift+P", command: "a" });
    pc.register({ key: "F1", command: "a" });
    expect(pc.labelFor("a")).toBe("F1");
    expect(pc.labelFor("b")).toBeUndefined();
    const mac = setup(true).keybindings;
    mac.register({ key: "Mod+Shift+P", command: "a" });
    expect(mac.labelFor("a")).toBe("⇧⌘P");
  });
});
