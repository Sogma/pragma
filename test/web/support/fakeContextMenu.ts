// A context menu that draws nothing: it keeps what each open asked it to
// show, so a test picks a row by its label the way a click on it would.
// The menu's own drawing and keys are contextMenu.test.ts's.
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService, MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

export interface FakeContextMenu extends ContextMenuService {
  opened: MenuOpenOptions[];
  // The open menu's rows, or those a query typed into its search box shows.
  rows(query?: string): MenuItem[];
  labels(query?: string): string[];
  // Closes the open menu and runs its row labelled `label`, as a pick does.
  pick(label: string, query?: string): void;
}

const labelOf = (item: MenuItem) => (typeof item.label === "function" ? item.label(context, undefined) : item.label);

export function fakeContextMenu(): FakeContextMenu {
  const opened: MenuOpenOptions[] = [];
  let current: MenuOpenOptions | undefined;
  const menu: FakeContextMenu = {
    opened,
    open(options) {
      menu.close();
      opened.push(options);
      current = options;
      options.anchor?.setAttribute("aria-expanded", "true");
    },
    close() {
      current?.anchor?.setAttribute("aria-expanded", "false");
      current = undefined;
    },
    isOpen: (anchor) => current !== undefined && (anchor === undefined || current.anchor === anchor),
    rows(query = "") {
      if (!current) throw new Error("no menu is open");
      return query ? (current.search?.filter(query) ?? []) : (current.items ?? []);
    },
    labels: (query) => menu.rows(query).map((item) => labelOf(item) ?? ""),
    pick(label, query) {
      const item = menu.rows(query).find((row) => labelOf(row) === label);
      if (!item?.run || item.disabled?.(context, undefined)) throw new Error(`no row "${label}" to pick`);
      menu.close();
      void item.run(context, undefined);
    },
  };
  return menu;
}
