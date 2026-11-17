// The desktop app's first run, and any launch whose spaces have all gone
// (electron/main.ts): Manage Spaces' create and open pages under Settings'
// logo and wordmark, beside the registered spaces when there are any. No
// server runs before a space exists, so the page reaches nothing but the
// preload bridge.
import type { ListedSpace, PragmaElectronBridge } from "./core/apiClient.ts";
import { must } from "./lib/dom.ts";
import { createListItemMenuButton, locateSpaceCommand } from "./lib/listItemMenu.ts";
import { createSpaceForm } from "./lib/spaceForm.ts";
import { createSpaceRow } from "./lib/spaceRow.ts";
import { type CommandContext, createCommands } from "./services/commands.ts";
import { createKeybindings } from "./services/keybindings.ts";
import { createMenus } from "./services/menus.ts";
import type { Setting } from "./services/settings.ts";
import { mountAnimatedMark } from "./view/animatedMark.ts";
import { createContextMenu } from "./view/contextMenu.ts";
import { wireWindowControls } from "./view/windowControls.ts";

// Nothing here zooms the page.
const NO_ZOOM: Setting<number> = {
  get: () => 100,
  set: () => undefined,
  subscribe(listener) {
    listener(100);
    return () => undefined;
  },
};

// Nothing here is a tab or a pane.
const NO_TAB: CommandContext = { tab: { kind: "empty" }, pane: undefined };

// The registered spaces, every one's folder gone when this window opens:
// a row offers Locate… on its ⋮, and once located opens on a click.
function wireSpaceList(bridge: PragmaElectronBridge, first: ListedSpace[]): void {
  const list = must<HTMLElement>(".welcome-space-list");
  const error = must<HTMLElement>(".welcome-spaces-error");
  const report = (thrown: unknown, fallback: string): void => {
    error.textContent = thrown instanceof Error ? thrown.message : fallback;
    error.hidden = false;
  };

  const commands = createCommands();
  const menus = createMenus(commands);
  const keybindings = createKeybindings(commands);
  const contextMenu = createContextMenu({ commands, menus, keybindings, context: () => NO_TAB });
  keybindings.attach(document, () => NO_TAB);

  const render = (spaces: ListedSpace[]): void => {
    list.replaceChildren(
      ...spaces.map((space) => {
        const id = space.id;
        return createSpaceRow({
          space,
          location: space.parent,
          current: false,
          menu:
            id && space.missing
              ? createListItemMenuButton(contextMenu, "Space options", {
                  kind: "space",
                  id,
                  label: space.label || space.name,
                  missing: true,
                  isCurrent: false,
                  trusted: space.trusted === true,
                })
              : undefined,
          open: () => {
            if (!id) return;
            error.hidden = true;
            bridge.openSpace(id).catch((thrown: unknown) => report(thrown, "Failed to open space."));
          },
        });
      }),
    );
  };

  const relocate = async (id: string): Promise<string | undefined> => {
    error.hidden = true;
    try {
      return await bridge.relocateSpace(id);
    } catch (thrown) {
      report(thrown, "Failed to locate the space.");
      return undefined;
    }
  };
  commands.register(locateSpaceCommand(relocate, async () => render(await bridge.listSpaces())));
  menus.register("listItem", [{ command: "space.locate" }]);
  render(first);
}

async function start(): Promise<void> {
  // welcome.html set the first paint's theme; this keeps it with the OS.
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  systemDark.addEventListener("change", () => {
    document.documentElement.setAttribute("data-theme", systemDark.matches ? "dark" : "light");
  });

  const bridge = window.pragmaElectron;
  if (!bridge) return;
  wireWindowControls(bridge, NO_ZOOM);

  const [spaces, version] = await Promise.all([
    bridge.listSpaces().catch((): ListedSpace[] => []),
    bridge.appVersion().catch(() => undefined),
  ]);
  // A first run shows the still logo over the version; once there are
  // spaces, the logo plays and the version goes.
  if (spaces.length > 0) {
    must<HTMLElement>(".welcome-spaces").hidden = false;
    wireSpaceList(bridge, spaces);
    mountAnimatedMark(must<HTMLImageElement>(".settings-logo"));
  } else if (version) {
    const line = must<HTMLElement>(".welcome-version");
    line.textContent = `version ${version}`;
    line.hidden = false;
  }

  // Nothing takes focus on load: a focused button would wear its ring before
  // anyone reached for the keyboard.
  const form = createSpaceForm(bridge, { examples: spaces.length === 0 });
  must<HTMLElement>(".welcome-main").append(form.element);
}

void start();
