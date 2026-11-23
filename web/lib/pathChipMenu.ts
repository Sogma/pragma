// A path chip's right-click: Copy path, the chip's whole path as its tooltip
// shows it, `lib:<id>/…` for a library's, however much of it the chip shows.
// A chip whose surface takes its own right-click, a Flow node's, adds the
// command to that menu; every other path label boxed in running text gets
// this one. A standalone label is a value, not a chip, and gets none.

import type { CommandRegistry } from "../services/commands.ts";
import type { ContextMenuService, MenuRegistry } from "../services/menus.ts";
import { type Disposable, DisposableStore, listen } from "./disposable.ts";

export const COPY_PATH = "path.copy";
const PATH_CHIP_MENU = "pathChip";

// The entry a chip's menu is opened on, `{ file }` or `{ folder }`, as the
// open commands beside this one read it.
function chipPathOf(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("file" in arg && typeof arg.file === "string") return arg.file;
  if ("folder" in arg && typeof arg.folder === "string") return arg.folder;
  return undefined;
}

export interface PathChipMenuDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  menu: Pick<ContextMenuService, "open">;
}

export function installPathChipMenu(deps: PathChipMenuDeps): Disposable {
  const store = new DisposableStore();
  store.add(
    deps.commands.register({
      id: COPY_PATH,
      label: "Copy path",
      when: (_, arg) => chipPathOf(arg) !== undefined,
      // A refused clipboard is swallowed, as the copy buttons do.
      run: (_, arg) => {
        const path = chipPathOf(arg);
        if (path !== undefined) void navigator.clipboard.writeText(path).catch(() => undefined);
      },
    }),
  );
  store.add(deps.menus.register(PATH_CHIP_MENU, [{ command: COPY_PATH }]));
  store.add(
    listen(document, "contextmenu", (event) => {
      if (!(event instanceof MouseEvent) || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
      const label = target?.closest<HTMLElement>(".path-label:not(.path-label-standalone)");
      const path = label?.dataset.path;
      if (!label || !path) return;
      event.preventDefault();
      const folder = label.dataset.pathType === "directory";
      deps.menu.open({
        menu: PATH_CHIP_MENU,
        arg: folder ? { folder: path } : { file: path },
        at: { x: event.clientX, y: event.clientY },
        ariaLabel: folder ? "Folder" : "File",
      });
    }),
  );
  return store;
}
