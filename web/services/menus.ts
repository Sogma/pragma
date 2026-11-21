// Menus as data: a menu is an id that modules contribute items to, and an
// item names a command — or, for an action local to the surface that opened
// it (a pane's own column, a flow node), carries the action itself.
//
// view/contextMenu.ts renders; this module only decides what a menu holds
// right now — each item's own `when`, then its command's — so visibility is
// expressed once, next to the action, never in DOM toggling.
import type { EntryIcon } from "../core/paths.ts";
import { type Disposable, toDisposable } from "../lib/disposable.ts";
import type { CommandContext, CommandRegistry } from "./commands.ts";

export interface MenuItem {
  // Absent for a static row (a heading, a notice), a submenu's parent, or
  // an item that carries `run` instead.
  command?: string;
  // A local action, in place of a command.
  run?(context: CommandContext, arg: unknown): void | Promise<void>;
  // Defaults to the command's label.
  label?: string | ((context: CommandContext, arg: unknown) => string);
  // Passed to the command in place of the menu's own argument.
  arg?: unknown;
  when?(context: CommandContext, arg: unknown): boolean;
  // Consecutive items of different groups get a separator between them.
  group?: string;
  danger?: boolean;
  // Renders as a checkbox item.
  checked?(context: CommandContext, arg: unknown): boolean;
  // In a picker's menu, a checkable row on or off by itself: a checkbox item
  // there too, where the picker's values are radio items.
  toggle?: boolean;
  // Shown but not pickable — for a choice the context rules out, where
  // hiding it would leave the person guessing why. Absent means pickable.
  disabled?(context: CommandContext, arg: unknown): boolean;
  // A flyout; shown only when at least one child resolves. Built per open
  // when what it holds depends on the argument.
  submenu?: MenuItem[] | ((context: CommandContext, arg: unknown) => MenuItem[]);
  // A flyout of tiles under headings, in place of `submenu`'s rows.
  tiles?: MenuTileSection[] | ((context: CommandContext, arg: unknown) => MenuTileSection[]);
  className?: string;
  // An icon slot before the label, styled through `className` and `data`.
  icon?: boolean;
  // The entry the icon slot draws, as every surface draws that entry.
  entryIcon?: EntryIcon;
  // Trailing muted text: a value, a hint.
  detail?: string;
  // A second line under the label: what picking the row means.
  description?: string;
  // What picking the row means, shown on hover instead, for a list too long
  // to give every row a second line.
  tooltip?: string;
  // A chord's label, trailing like `detail`, its arrow keys drawn as icons.
  shortcut?: string;
  // A sort's direction, drawn after the label.
  direction?: "ascending" | "descending";
  // data-* attributes on the row (`nodeType` becomes data-node-type).
  data?: Record<string, string>;
  style?: Record<string, string>;
  // A CSS font-family list the label alone is drawn in: a font's own row
  // in a font picker.
  font?: string;
  // A small dot after the label, this text its tooltip and part of the
  // row's name: what sets the row apart, a font picker's default, said
  // without a word in the row.
  mark?: string;
  // A search box atop this item's flyout. Typing swaps its rows for the
  // matches, which the arrow keys walk and Enter picks; the flyout stays
  // open while the box has focus, and a key typed while it shows goes there.
  search?: MenuSearch | ((context: CommandContext, arg: unknown) => MenuSearch);
  // Shown while the row is pointed at or reached by the arrow keys, and
  // ended as they move on or the menu closes: a look tried on the picture
  // before it is picked.
  preview?: MenuPreview;
}

export interface MenuPreview {
  show(): void;
  end(): void;
}

export type MenuContribution = MenuItem[] | ((context: CommandContext, arg: unknown) => MenuItem[]);

export interface ResolvedMenuItem {
  label: string;
  command?: string;
  run?(context: CommandContext, arg: unknown): void | Promise<void>;
  arg: unknown;
  group?: string;
  danger: boolean;
  checked?: boolean;
  toggle?: boolean;
  disabled?: boolean;
  className?: string;
  icon: boolean;
  entryIcon?: EntryIcon;
  detail?: string;
  description?: string;
  tooltip?: string;
  shortcut?: string;
  direction?: "ascending" | "descending";
  data?: Record<string, string>;
  style?: Record<string, string>;
  font?: string;
  mark?: string;
  submenu?: ResolvedMenuItem[];
  tiles?: MenuTileSection[];
  search?: MenuSearch;
  preview?: MenuPreview;
}

// Choices made at once, as a viewer's guides are picked: a tile applies on
// click and leaves the menu open, as the slider does, and every tile in the
// flyout redraws whether it is on, since one pick can turn another off.
export interface MenuTileSection {
  label: string;
  tiles: MenuTile[];
  // Under the tiles, applied as it moves.
  range?: MenuRange;
}

// A number set along a slider, its value after the label.
export interface MenuRange {
  label: string;
  min: number;
  max: number;
  step: number;
  tooltip?: string;
  value(): number;
  // The value as the label shows it.
  format(value: number): string;
  change(value: number): void;
}

export interface MenuTile {
  label: string;
  // The icon's glyph, a token from styles/icons.css: `var(--icon-…)`.
  glyph: string;
  // One of its section's choices, or on and off by itself.
  radio?: boolean;
  tooltip?: string;
  checked(): boolean;
  pick(): void;
}

export interface ResolveOptions {
  // An item whose command doesn't apply right now stays, disabled, instead
  // of leaving the menu: the desktop menu bar keeps every item in its place.
  // A command nothing registered still leaves.
  keepInapplicable?: boolean;
}

export interface MenuRegistry {
  register(menuId: string, contribution: MenuContribution): Disposable;
  // What `menuId` shows for this context and argument, contributions in
  // registration order.
  resolve(menuId: string, context: CommandContext, arg?: unknown): ResolvedMenuItem[];
  // The same resolution over items handed in directly.
  resolveItems(items: MenuItem[], context: CommandContext, arg?: unknown, options?: ResolveOptions): ResolvedMenuItem[];
  // Every command `menuId` names, whether or not it applies now, labelled
  // as the menu labels it; a command named twice keeps its first label. An
  // item carrying its own `arg` is left out: a key press has none to pass.
  commandsIn(menuId: string, context: CommandContext): { command: string; label: string }[];
}

// A search box atop a menu: typing replaces the items with `filter`'s
// matches, a flat list the arrow keys walk and Enter picks.
export interface MenuSearch {
  placeholder: string;
  filter(query: string): MenuItem[];
  // Typed into the box as the menu opens.
  query?: string;
}

export interface MenuOpenOptions {
  // A registered menu, inline items, or both: inline items first, then the
  // menu's, then `itemsAfter`.
  menu?: string;
  items?: MenuItem[];
  itemsAfter?: MenuItem[];
  arg?: unknown;
  // Either a point (a right-click's client coordinates), or "top" —
  // centred near the top of the window, for a menu no click placed…
  at?: { x: number; y: number } | "top";
  // …or an element to open under, its left or right edge aligned…
  anchor?: HTMLElement;
  align?: "start" | "end";
  // …or left of, its first row level with the anchor: a column's menu,
  // which under the anchor would cover the buttons below it.
  beside?: boolean;
  ariaLabel?: string;
  // Shown when nothing resolves.
  empty?: string;
  search?: MenuSearch;
  // Pinned under the list, outside its scroll, and kept while a search
  // filters the list.
  slider?: MenuSlider;
  // Added to the menu element, for a surface that sizes itself.
  className?: string;
  // A picker's menu, of the values its anchor names: at least as wide as
  // the anchor, as a select's list is, and holding focus itself when it has
  // no search box, so its rows answer the arrow keys, Enter and Escape.
  picker?: boolean;
}

// A labelled slider over a few named stops, the current stop's name after
// the label. Moving it applies at once and leaves the menu open, where a
// picked row closes it.
export interface MenuSlider {
  label: string;
  stops: MenuSliderStop[];
  value: string;
  change(value: string): void;
}

export interface MenuSliderStop {
  value: string;
  label: string;
  // Drawn as a ring, not a dot: the stop that leaves the choice elsewhere.
  ring?: boolean;
}

// The menu the command palette lists, and Settings → Shortcuts with it. A
// command contributes here the way it does to a context menu, but runs with
// no argument, so it acts on the focused tab rather than a clicked row. A
// label here is a fixed name: the Shortcuts page lists it with nothing open.
export const COMMAND_PALETTE = "commandPalette";

// The one component that draws menus (view/contextMenu.ts), as its users
// see it: a pane or the flow canvas opens a menu here and never builds one.
export interface ContextMenuService {
  open(options: MenuOpenOptions): void;
  close(): void;
  // Whether a menu is open — for `anchor`, the one opened under it, so a
  // click on the anchor can toggle.
  isOpen(anchor?: HTMLElement): boolean;
}

export function createMenus(commands: CommandRegistry): MenuRegistry {
  const contributions = new Map<string, MenuContribution[]>();

  function resolveItems(
    items: MenuItem[],
    context: CommandContext,
    menuArg: unknown,
    options: ResolveOptions = {},
  ): ResolvedMenuItem[] {
    const resolved: ResolvedMenuItem[] = [];
    for (const item of items) {
      const arg = item.arg !== undefined ? item.arg : menuArg;
      if (item.when && !item.when(context, arg)) continue;
      const command = item.command !== undefined ? commands.get(item.command) : undefined;
      const inapplicable = item.command !== undefined && !commands.isEnabled(item.command, context, arg);
      if (inapplicable && !(options.keepInapplicable && command)) continue;
      const children = typeof item.submenu === "function" ? item.submenu(context, arg) : item.submenu;
      const submenu = children ? resolveItems(children, context, menuArg, options) : undefined;
      if (submenu && submenu.length === 0) continue;
      const tiles = typeof item.tiles === "function" ? item.tiles(context, arg) : item.tiles;
      if (tiles && tiles.length === 0) continue;
      const label = typeof item.label === "function" ? item.label(context, arg) : (item.label ?? command?.label ?? "");
      resolved.push({
        label,
        command: item.command,
        run: item.run,
        arg,
        group: item.group,
        danger: item.danger ?? false,
        checked: item.checked ? item.checked(context, arg) : undefined,
        toggle: item.toggle,
        disabled: inapplicable || (item.disabled ? item.disabled(context, arg) : undefined),
        className: item.className,
        icon: item.icon ?? false,
        entryIcon: item.entryIcon,
        detail: item.detail,
        description: item.description,
        tooltip: item.tooltip,
        shortcut: item.shortcut,
        direction: item.direction,
        data: item.data,
        style: item.style,
        font: item.font,
        mark: item.mark,
        submenu,
        tiles,
        search: typeof item.search === "function" ? item.search(context, arg) : item.search,
        preview: item.preview,
      });
    }
    return resolved;
  }

  return {
    register(menuId, contribution) {
      const list = contributions.get(menuId) ?? [];
      list.push(contribution);
      contributions.set(menuId, list);
      return toDisposable(() => {
        const index = list.indexOf(contribution);
        if (index >= 0) list.splice(index, 1);
      });
    },
    resolve(menuId, context, arg) {
      const resolved: ResolvedMenuItem[] = [];
      for (const contribution of contributions.get(menuId) ?? []) {
        const items = typeof contribution === "function" ? contribution(context, arg) : contribution;
        resolved.push(...resolveItems(items, context, arg));
      }
      return resolved;
    },
    resolveItems,
    commandsIn(menuId, context) {
      const labels = new Map<string, string>();
      for (const contribution of contributions.get(menuId) ?? []) {
        const items = typeof contribution === "function" ? contribution(context, undefined) : contribution;
        for (const item of items) {
          const command = item.command !== undefined ? commands.get(item.command) : undefined;
          if (!command || item.arg !== undefined || labels.has(command.id)) continue;
          const label = typeof item.label === "function" ? item.label(context, undefined) : item.label;
          labels.set(command.id, label ?? command.label);
        }
      }
      return [...labels].map(([command, label]) => ({ command, label }));
    },
  };
}
