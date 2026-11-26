import { describe, expect, it, vi } from "vitest";
import { FLOW_NODE_CATEGORIES, FLOW_NODE_REGISTRY } from "../../../src/protocol/flowNodes.ts";
import { openAddNodeMenu } from "../../../web/flow/addNodeMenu.ts";
import type { MenuOpenOptions } from "../../../web/services/menus.ts";

function openMenu(): MenuOpenOptions {
  const opened: MenuOpenOptions[] = [];
  const contextMenu = {
    open: (options: MenuOpenOptions) => {
      opened.push(options);
    },
    close: vi.fn(),
    isOpen: () => false,
  };
  openAddNodeMenu(contextMenu, { clientX: 0, clientY: 0, flowX: 0, flowY: 0 }, vi.fn());
  return opened[0];
}

describe("addNodeMenu", () => {
  it("lists the categories in their declared order", () => {
    expect(openMenu().items?.map((item) => item.label)).toEqual([...FLOW_NODE_CATEGORIES]);
  });

  it("files every type once, under its own category", () => {
    const filed = (openMenu().items ?? []).flatMap((category) =>
      (Array.isArray(category.submenu) ? category.submenu : []).map((leaf) => ({
        type: leaf.data?.nodeType ?? "",
        category: category.label,
      })),
    );
    expect(filed.map(({ type }) => type).sort()).toEqual(Object.keys(FLOW_NODE_REGISTRY).sort());
    for (const { type, category } of filed) expect(category).toBe(FLOW_NODE_REGISTRY[type].category);
  });

  it("shows each type's description over its row, when browsing and when searching", () => {
    const menu = openMenu();
    const browsed = (menu.items ?? []).flatMap((category) => (Array.isArray(category.submenu) ? category.submenu : []));
    const found = menu.search?.filter("row") ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const leaf of [...browsed, ...found]) {
      expect(leaf.tooltip).toBe(FLOW_NODE_REGISTRY[leaf.data?.nodeType ?? ""].description);
    }
  });

  it('finds every node that reads or writes a Table when searching "table"', () => {
    const found = (openMenu().search?.filter("table") ?? []).map((leaf) => leaf.data?.nodeType);
    expect(found).toEqual(expect.arrayContaining(["loadRow", "loadRandomRow", "loadTableRows", "addRow"]));
  });
});
