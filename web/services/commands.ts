// The command registry: every action the app exposes through a menu or a
// keybinding is a command — an id, a label, a run function, and an optional
// `when` saying whether it applies right now. `arg` is what the invoking menu
// or binding carries — the right-clicked tree node, the space to switch to.
//
// A command never reads the active document itself: the caller hands in the
// context (the focused group's active tab and pane), so "run flow" targets
// the group that has focus, never a global.
import type { Tab } from "../core/apiClient.ts";
import { type Disposable, toDisposable } from "../lib/disposable.ts";
import type { EditorPane } from "./editorPanes.ts";

export interface CommandContext {
  tab: Tab;
  pane: EditorPane | undefined;
}

export interface Command<A = unknown> {
  id: string;
  label: string;
  run(context: CommandContext, arg: A): void | Promise<void>;
  // Whether the command applies to this context: a menu hides an item
  // whose command doesn't, a keybinding passes it over.
  when?(context: CommandContext, arg: A): boolean;
}

export interface CommandRegistry {
  // An id registers once; a second registration is a programming error.
  register(command: Command): Disposable;
  get(id: string): Command | undefined;
  isEnabled(id: string, context: CommandContext, arg?: unknown): boolean;
  // Runs `id` when it exists and applies. Resolves to whether it ran.
  run(id: string, context: CommandContext, arg?: unknown): Promise<boolean>;
}

export function createCommands(): CommandRegistry {
  const commands = new Map<string, Command>();

  function isEnabled(id: string, context: CommandContext, arg?: unknown): boolean {
    const command = commands.get(id);
    return command !== undefined && (command.when?.(context, arg) ?? true);
  }

  return {
    register(command) {
      if (commands.has(command.id)) throw new Error(`Command "${command.id}" is already registered`);
      commands.set(command.id, command);
      return toDisposable(() => {
        if (commands.get(command.id) === command) commands.delete(command.id);
      });
    },
    get: (id) => commands.get(id),
    isEnabled,
    async run(id, context, arg) {
      const command = commands.get(id);
      if (!command || !isEnabled(id, context, arg)) return false;
      await command.run(context, arg);
      return true;
    },
  };
}
