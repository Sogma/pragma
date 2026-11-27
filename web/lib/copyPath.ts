// Copy path, one control wherever a menu names an entry or a path chip: a
// flyout holding the entry's Pragma link, in the desktop app, which alone
// opens one; the path from the space's or the library's folder; and the path
// from the system root, which the server works out, for a missing file too.
//
// A chip copies its whole path as its tooltip shows it, `lib:<id>/…` for a
// library's, however much of it the chip shows. A chip whose surface takes
// its own right-click, a Flow node's, adds Copy path to that menu; every
// other path label boxed in running text gets this one. A standalone label
// is a value, not a chip, and gets none.

import { formatPragmaUrl } from "../../src/protocol/pragmaUrl.ts";
import { isLibraryPath } from "../../src/protocol/rootedPath.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { ContextMenuService, MenuItem, MenuRegistry } from "../services/menus.ts";
import { type Disposable, DisposableStore, listen } from "./disposable.ts";

export const COPY_PATH = "path.copy";
export const COPY_SYSTEM_PATH = "path.copySystemPath";
export const COPY_PRAGMA_URL = "path.copyPragmaUrl";
const PATH_CHIP_MENU = "pathChip";

/** The entry a menu's argument names, as Copy path copies it: `{ file }` or
 * `{ folder }` (a chip, a tab, a Bookmarks row), or a tree row's `{ node }`,
 * its path rooted. Undefined for a tree's empty area, which hides the items. */
export function copiedPathOf(arg: unknown): string | undefined {
  return copiedEntryOf(arg)?.path;
}

/** The same entry, and whether it is a folder, which its link marks. */
export function copiedEntryOf(arg: unknown): { path: string; folder: boolean } | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const named =
    "file" in arg
      ? { path: arg.file, folder: false }
      : "folder" in arg
        ? { path: arg.folder, folder: true }
        : rowOf(arg);
  return typeof named?.path === "string" && named.path !== "" ? { path: named.path, folder: named.folder } : undefined;
}

function rowOf(arg: object): { path: string; folder: boolean } | undefined {
  if (!("node" in arg)) return undefined;
  const { node } = arg as { node?: { path?: unknown; type?: unknown } | null };
  if (typeof node?.path !== "string" || node.path === "") return undefined;
  return { path: node.path, folder: node.type === "directory" };
}

/** Copy path as an entry's menu holds it, in `group`. `arg` names the entry
 * for a menu whose own argument names something else, as a tab's does. */
export function copyPathItem(options: { group?: string; arg?: unknown } = {}): MenuItem {
  const { group, arg } = options;
  // A flyout's rows read the menu's argument, not the flyout's, so each
  // carries `arg` itself.
  const rows: MenuItem[] = [
    { command: COPY_PRAGMA_URL, arg, label: "as Pragma URL" },
    {
      command: COPY_PATH,
      arg,
      label: (_, entry) => (isLibraryPath(copiedPathOf(entry) ?? "") ? "from library folder" : "from space folder"),
    },
    { command: COPY_SYSTEM_PATH, arg, label: "from system root" },
  ];
  return { label: "Copy path", group, arg, submenu: rows };
}

// A refused clipboard is swallowed, as the copy buttons do.
function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch(() => undefined);
}

export interface CopyPathDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  menu: Pick<ContextMenuService, "open">;
  /** Where a space or `lib:` path sits on disk, as the system spells it,
   * whether or not anything is there. */
  systemPath(path: string): Promise<string>;
  /** The open space's name, for its Pragma links: undefined where nothing
   * opens one, in the browser. */
  spaceName: (() => Promise<string>) | undefined;
}

export function installCopyPath(deps: CopyPathDeps): Disposable {
  const store = new DisposableStore();
  store.add(
    deps.commands.register({
      id: COPY_PATH,
      label: "Copy path",
      when: (_, arg) => copiedPathOf(arg) !== undefined,
      run: (_, arg) => {
        const path = copiedPathOf(arg);
        if (path !== undefined) void copy(path);
      },
    }),
  );
  store.add(
    deps.commands.register({
      id: COPY_SYSTEM_PATH,
      label: "Copy path from system root",
      when: (_, arg) => copiedPathOf(arg) !== undefined,
      run: async (_, arg) => {
        const path = copiedPathOf(arg);
        const full = path === undefined ? undefined : await deps.systemPath(path).catch(() => undefined);
        if (full !== undefined) await copy(full);
      },
    }),
  );
  const { spaceName } = deps;
  if (spaceName) {
    store.add(
      deps.commands.register({
        id: COPY_PRAGMA_URL,
        label: "Copy as Pragma URL",
        when: (_, arg) => copiedEntryOf(arg) !== undefined,
        run: async (_, arg) => {
          const entry = copiedEntryOf(arg);
          const space = entry === undefined ? undefined : await spaceName().catch(() => undefined);
          if (entry !== undefined && space !== undefined) await copy(formatPragmaUrl({ space, ...entry }));
        },
      }),
    );
  }
  store.add(deps.menus.register(PATH_CHIP_MENU, [copyPathItem()]));
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
