// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../../../web/core/apiClient.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createMenus, type MenuItem, type MenuOpenOptions } from "../../../web/services/menus.ts";
import { createDefaultAppMenu, type DefaultAppBridge, registerShowInFolder } from "../../../web/view/defaultAppMenu.ts";

// `null` for the browser, where there is no bridge.
function setup(desktop: Partial<DefaultAppBridge> | null = {}) {
  const opened: MenuOpenOptions[] = [];
  const contextMenu = { open: vi.fn((options: MenuOpenOptions) => void opened.push(options)) };
  const tree = document.createElement("div");
  const anchor = document.createElement("span");
  document.body.replaceChildren(tree, anchor);
  const bridge: DefaultAppBridge | undefined =
    desktop === null
      ? undefined
      : {
          platform: "linux",
          defaultAppRefusal: vi.fn(async () => null),
          openInDefaultApp: vi.fn(async () => null),
          showInFolder: vi.fn(async () => undefined),
          ...desktop,
        };
  return { open: createDefaultAppMenu({ bridge, contextMenu, tree }), opened, tree, anchor, bridge };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));
const context = {} as CommandContext;
const item = (options: MenuOpenOptions | undefined, label: string): MenuItem | undefined =>
  options?.items?.find((entry) => entry.label === label);

describe("the menu a file Pragma can't open shows", () => {
  it("offers the default app and the file manager, beside where the open came from", async () => {
    const { open, opened, anchor, bridge } = setup();
    open("data/budget.zip", { anchor, marked: true });
    await settle();

    expect(opened[0]?.anchor).toBe(anchor);
    expect(opened[0]?.items?.map((entry) => entry.label)).toEqual([
      "budget.zip",
      "Open in the default app",
      "Show in folder",
    ]);
    expect(item(opened[0], "Open in the default app")?.disabled?.(context, undefined)).toBe(false);
    item(opened[0], "Open in the default app")?.run?.(context, undefined);
    item(opened[0], "Show in folder")?.run?.(context, undefined);
    expect(bridge?.openInDefaultApp).toHaveBeenCalledWith("data/budget.zip");
    expect(bridge?.showInFolder).toHaveBeenCalledWith("data/budget.zip");
  });

  it("names Finder on macOS", async () => {
    const { open, opened, anchor } = setup({ platform: "darwin" });
    open("budget.zip", { anchor });
    await settle();
    expect(item(opened[0], "Show in Finder")).toBeDefined();
  });

  it("shows why the default app can't have the file", async () => {
    const { open, opened, anchor } = setup({
      defaultAppRefusal: vi.fn(async () => "Blocked: .exe files can run code"),
    });
    open("setup.exe", { anchor });
    await settle();

    const openItem = item(opened[0], "Open in the default app");
    expect(openItem?.disabled?.(context, undefined)).toBe(true);
    expect(openItem?.description).toBe("Blocked: .exe files can run code");
    expect(item(opened[0], "Show in folder")?.disabled).toBeUndefined();
  });

  it("shows itself again with the system's reason when the open fails", async () => {
    const { open, opened, anchor } = setup({ openInDefaultApp: vi.fn(async () => "No app opens this file") });
    open("budget.zip", { anchor });
    await settle();
    item(opened[0], "Open in the default app")?.run?.(context, undefined);
    await settle();

    expect(opened).toHaveLength(2);
    expect(item(opened[1], "Open in the default app")?.description).toBe("No app opens this file");
  });

  it("draws beside the file's tree row when the open came from no element, else near the top", async () => {
    const { open, opened, tree } = setup();
    const row = document.createElement("span");
    row.className = "node-label";
    row.dataset.path = "data/budget.zip";
    row.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    tree.append(row);

    open("data/budget.zip");
    open("elsewhere.zip");
    await settle();
    expect(opened[0]?.anchor).toBe(row);
    expect(opened[1]?.at).toBe("top");
  });
});

describe("in the browser", () => {
  it("adds nothing beside a row or tile that already says Pragma can't open the file", async () => {
    const { open, opened, anchor } = setup(null);
    open("budget.zip", { anchor, marked: true });
    await settle();
    expect(opened).toEqual([]);
  });

  it("says the file opens only in the desktop app, from anywhere else", async () => {
    const { open, opened, anchor } = setup(null);
    open("budget.zip", { anchor });
    await settle();

    expect(opened[0]?.items?.map((entry) => entry.label)).toEqual(["budget.zip", "Open in the default app"]);
    expect(item(opened[0], "Open in the default app")?.disabled?.(context, undefined)).toBe(true);
    expect(item(opened[0], "Open in the default app")?.description).toBe("Only in the desktop app");
  });
});

describe("showing the open file in the file manager", () => {
  function registered(platform: string) {
    const commands = createCommands();
    const bridge = { platform, showInFolder: vi.fn(async () => undefined) };
    registerShowInFolder(bridge, { commands, menus: createMenus(commands) });
    return { commands, bridge };
  }
  const on = (tab: Tab): CommandContext => ({ tab, pane: undefined });

  it("shows the focused tab's file, named for the system's file manager", async () => {
    const { commands, bridge } = registered("darwin");
    expect(commands.get("file.showInFolder")?.label).toBe("Show in Finder");
    await commands.run("file.showInFolder", on({ kind: "image", path: "pictures/cat.png" }));
    expect(bridge.showInFolder).toHaveBeenCalledWith("pictures/cat.png");
  });

  it("doesn't apply to a library's file or a tab without one", () => {
    const { commands } = registered("linux");
    expect(commands.get("file.showInFolder")?.label).toBe("Show in folder");
    expect(commands.isEnabled("file.showInFolder", on({ kind: "image", path: "lib:photos/cat.png" }))).toBe(false);
    expect(commands.isEnabled("file.showInFolder", on({ kind: "empty" }))).toBe(false);
  });

  it("isn't offered in the browser", () => {
    const commands = createCommands();
    registerShowInFolder(undefined, { commands, menus: createMenus(commands) });
    expect(commands.get("file.showInFolder")).toBeUndefined();
  });
});
