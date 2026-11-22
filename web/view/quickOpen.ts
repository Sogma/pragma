// Quick Open and the command palette: one searchable menu near the top of
// the window, drawn by the context menu like any other. An empty box lists
// recently opened files, a query ranks every file the tree shows, and a
// leading `>` switches to the commands contributed to COMMAND_PALETTE.
//
// Picking a file opens it exactly as a tree click does, replacing the
// current tab. There is deliberately no modifier to open it in a new tab:
// the tree has none either, and "+" is how a tab is added.
import { basenameOf, dirnameOf } from "../../src/protocol/rootedPath.ts";
import { hasKnownKind } from "../../src/protocol/types.ts";
import { displayName } from "../core/paths.ts";
import { rankPaths, scoreLabel } from "../core/quickOpenMatch.ts";
import { entryIconAt } from "../core/spaceTree.ts";
import type { CommandContext, CommandRegistry } from "../services/commands.ts";
import type { KeybindingRegistry } from "../services/keybindings.ts";
import { COMMAND_PALETTE, type ContextMenuService, type MenuItem, type MenuRegistry } from "../services/menus.ts";
import * as settings from "../services/settings.ts";

export interface QuickOpenDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  keybindings: KeybindingRegistry;
  contextMenu: ContextMenuService;
  context: () => CommandContext;
  // Every file the space tree shows, space-relative.
  files: () => string[];
  // Newest first; may name paths that have since moved or gone.
  recentPaths: () => readonly string[];
  openPath: (path: string) => void;
  // The app's setting for names, unless a test hands in another.
  showExtensions?(): boolean;
}

const COMMAND_PREFIX = ">";
const MAX_FILES = 50;
const MAX_RECENT = 20;

export function createQuickOpen(deps: QuickOpenDeps): void {
  const showExtensions = deps.showExtensions ?? (() => settings.showExtensions.get());

  function fileItem(path: string): MenuItem {
    const name = basenameOf(path);
    const known = hasKnownKind(name);
    return {
      label: displayName({ name, type: "file" }, showExtensions()),
      ...(known ? {} : { className: "cant-open" }),
      detail: dirnameOf(path) || undefined,
      icon: true,
      entryIcon: entryIconAt(path, "file"),
      run: () => deps.openPath(path),
    };
  }

  function commandItems(query: string): MenuItem[] {
    const scored: { item: MenuItem; score: number }[] = [];
    for (const resolved of deps.menus.resolve(COMMAND_PALETTE, deps.context())) {
      const score = query ? scoreLabel(resolved.label, query) : 0;
      if (score === undefined) continue;
      const item: MenuItem = { command: resolved.command, run: resolved.run, label: resolved.label, arg: resolved.arg };
      if (resolved.command !== undefined) item.shortcut = deps.keybindings.labelFor(resolved.command);
      scored.push({ item, score });
    }
    return scored.sort((a, b) => b.score - a.score).map(({ item }) => item);
  }

  function open(query: string): void {
    const files = deps.files();
    const known = new Set(files);
    const tab = deps.context().tab;
    const active = tab.kind === "empty" ? undefined : tab.path;
    const recent = deps.recentPaths().filter((path) => known.has(path));
    const items = recent
      .filter((path) => path !== active)
      .slice(0, MAX_RECENT)
      .map(fileItem);
    deps.contextMenu.open({
      at: "top",
      className: "quick-open",
      ariaLabel: "Quick Open",
      items: items.length > 0 ? items : [{ label: "Type a file name, or > for commands" }],
      search: {
        placeholder: "Go to file, or type > for commands",
        query,
        filter: (typed) => {
          if (typed.startsWith(COMMAND_PREFIX)) {
            const commands = commandItems(typed.slice(COMMAND_PREFIX.length).trim());
            return commands.length > 0 ? commands : [{ label: "No matching commands" }];
          }
          const matches = rankPaths(files, typed, recent).slice(0, MAX_FILES);
          return matches.length > 0 ? matches.map(fileItem) : [{ label: "No matching files" }];
        },
      },
    });
  }

  deps.commands.register({ id: "quickOpen.files", label: "Go to File…", run: () => open("") });
  deps.commands.register({ id: "quickOpen.commands", label: "Show All Commands", run: () => open(COMMAND_PREFIX) });
  deps.keybindings.register({ key: "Mod+P", command: "quickOpen.files" });
  deps.keybindings.register({ key: "Mod+Shift+P", command: "quickOpen.commands" });
  // Firefox keeps Ctrl+Shift+P for a private window and never lets a page
  // have it, so the palette needs a key no browser claims.
  deps.keybindings.register({ key: "F1", command: "quickOpen.commands" });
  deps.menus.register(COMMAND_PALETTE, [{ command: "quickOpen.files" }, { command: "quickOpen.commands" }]);
}
