// The shared menu component over registries of its own, drawn and keyed as
// the app's is. A test that only reads what a menu asked to show uses
// fakeContextMenu.ts.
import { createCommands } from "../../../web/services/commands.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createContextMenu } from "../../../web/view/contextMenu.ts";

export function testContextMenu() {
  const commands = createCommands();
  const keybindings = createKeybindings(commands);
  return createContextMenu({
    commands,
    menus: createMenus(commands),
    keybindings,
    context: () => ({ tab: { kind: "empty" }, pane: undefined }),
  });
}
