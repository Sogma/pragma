// What a file Pragma can't open offers in place of a tab: its name, then the
// system's default app and file manager, which only the desktop app reaches.
// Whether the default app may have the file is the main process's answer
// (src/server/defaultApp.ts), asked as the menu opens and again by the open.
//
// In the browser the menu says why the file stays closed, except beside a
// row or tile whose tooltip already says so.
import { basenameOf, isLibraryPath } from "../../src/protocol/rootedPath.ts";
import type { PragmaElectronBridge } from "../core/apiClient.ts";
import { CANT_OPEN } from "../core/paths.ts";
import type { CommandContext, CommandRegistry } from "../services/commands.ts";
import { COMMAND_PALETTE, type ContextMenuService, type MenuItem, type MenuRegistry } from "../services/menus.ts";
import type { OpenSource } from "../services/tabs.ts";

export type DefaultAppBridge = Pick<
  PragmaElectronBridge,
  "platform" | "defaultAppRefusal" | "openInDefaultApp" | "showInFolder"
>;

export interface DefaultAppMenuDeps {
  /** Absent in the browser. */
  bridge: DefaultAppBridge | undefined;
  contextMenu: Pick<ContextMenuService, "open">;
  /** The space tree's rows: an open that came from no element, such as Quick
   * Open's, has revealed the file's row by the time the menu draws. */
  tree: HTMLElement;
}

export function createDefaultAppMenu(deps: DefaultAppMenuDeps): (path: string, from?: OpenSource) => void {
  const { bridge } = deps;

  function rowFor(path: string): HTMLElement | undefined {
    const row = deps.tree.querySelector<HTMLElement>(`.node-label[data-path="${CSS.escape(path)}"]`);
    return row && row.getClientRects().length > 0 ? row : undefined;
  }

  // `refusal` is why the default app can't have the file, or null when it can.
  function show(path: string, anchor: HTMLElement | undefined, refusal: string | null): void {
    const place = anchor?.isConnected ? anchor : rowFor(path);
    const name = basenameOf(path);
    const items: MenuItem[] = [
      { label: name, group: "file" },
      {
        label: "Open in the default app",
        group: "open",
        run: () => void openInApp(path, place),
        disabled: () => refusal !== null,
        ...(refusal === null ? {} : { description: refusal }),
      },
    ];
    if (bridge) {
      items.push({
        label: showInFolderLabel(bridge.platform),
        group: "open",
        run: () => void bridge.showInFolder(path),
      });
    }
    deps.contextMenu.open({ items, ...(place ? { anchor: place } : { at: "top" }), ariaLabel: name });
  }

  // A failed open shows the menu again with the system's reason in place.
  async function openInApp(path: string, anchor: HTMLElement | undefined): Promise<void> {
    if (!bridge) return;
    const failure = await bridge.openInDefaultApp(path).catch(() => CANT_OPEN);
    if (failure !== null) show(path, anchor, failure);
  }

  return (path, from) => {
    if (!bridge) {
      if (!from?.marked) show(path, from?.anchor, "Only in the desktop app");
      return;
    }
    void bridge
      .defaultAppRefusal(path)
      .catch(() => CANT_OPEN)
      .then((refusal) => show(path, from?.anchor, refusal));
  };
}

// Each system's own name for its file manager. Linux has no single one to
// name, so its label says what happens instead.
function showInFolderLabel(platform: string): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in File Explorer";
  return "Open containing folder";
}

/** The file or folder open in the focused group, shown in the system's file
 * manager. Never a library's, which the main process won't show
 * (src/server/defaultApp.ts). */
export function registerShowInFolder(
  bridge: Pick<PragmaElectronBridge, "platform" | "showInFolder"> | undefined,
  deps: { commands: CommandRegistry; menus: MenuRegistry },
): void {
  if (!bridge) return;
  const shownPath = ({ tab }: CommandContext): string | undefined =>
    tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version" || isLibraryPath(tab.path)
      ? undefined
      : tab.path;
  deps.commands.register({
    id: "file.showInFolder",
    label: showInFolderLabel(bridge.platform),
    when: (context) => shownPath(context) !== undefined,
    run: (context) => {
      const path = shownPath(context);
      if (path !== undefined) void bridge.showInFolder(path);
    },
  });
  deps.menus.register(COMMAND_PALETTE, [{ command: "file.showInFolder" }]);
}
