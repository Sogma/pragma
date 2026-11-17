// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCommands } from "../../../web/services/commands.ts";
import { type ContextMenuService, createMenus } from "../../../web/services/menus.ts";
import { createSpaceSwitcher } from "../../../web/view/spaceSwitcher.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const contextMenu = {
    open: vi.fn<ContextMenuService["open"]>(),
    close: vi.fn<ContextMenuService["close"]>(),
    isOpen: vi.fn<ContextMenuService["isOpen"]>(() => false),
    dispose: vi.fn(),
  };
  const anchor = document.createElement("button");
  const commands = createCommands();
  const current = { id: "spc_current", name: "Current", path: "/spaces/current" };
  const switcher = createSpaceSwitcher({
    commands,
    menus: createMenus(commands),
    contextMenu,
    anchor,
    fetchSpaceList: vi.fn(async () => ({ current, spaces: [current], recent: [current] })),
    switchSpace: vi.fn(async () => undefined),
  });
  return { anchor, contextMenu, switcher };
}

describe("spaceSwitcher", () => {
  it("opens the click's menu on a right-click, and a right-click while it is open leaves it open", async () => {
    const { anchor, contextMenu } = setup();
    anchor.click();
    await tick();
    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(rightClick);
    await tick();
    expect(rightClick.defaultPrevented).toBe(true);
    const [clicked, rightClicked] = contextMenu.open.mock.calls.map(([options]) => options);
    expect(rightClicked.anchor).toBe(anchor);
    expect(rightClicked).toEqual(clicked);

    contextMenu.isOpen.mockReturnValue(true);
    anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await tick();
    expect(contextMenu.open).toHaveBeenCalledTimes(2);
    expect(contextMenu.close).not.toHaveBeenCalled();
  });

  it("opens the same menu at a point for a right-click away from the space name", async () => {
    const { anchor, contextMenu, switcher } = setup();
    anchor.click();
    await tick();
    switcher.openAt({ x: 12, y: 34 });
    await tick();
    const [{ anchor: clickAnchor, ...clicked }, atPoint] = contextMenu.open.mock.calls.map(([options]) => options);
    expect(clickAnchor).toBe(anchor);
    expect(atPoint).toEqual({ ...clicked, at: { x: 12, y: 34 } });
  });
});
