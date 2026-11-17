// The canvas's right-click add-node palette: a pure mapping from
// FLOW_NODE_REGISTRY to menu rows that reads no graph state, mutates
// nothing, and reaches the canvas only through the callback it's handed.
//
// A leaf keys the same per-type icon rule a placed node's title-bar dot
// uses (`[data-node-type="X"] .context-menu-icon`, web/styles/flow/nodes.css),
// so each type has one shared glyph.
import { FLOW_NODE_CATEGORIES, FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";

// Where the picked node lands — the click position, not a fixed cascade.
export interface AddNodeMenuPosition {
  clientX: number;
  clientY: number;
  flowX: number;
  flowY: number;
}

function nodeLeaf(type: string, at: AddNodeMenuPosition, createNode: (type: string, x: number, y: number) => void) {
  return {
    label: FLOW_NODE_REGISTRY[type].label,
    tooltip: FLOW_NODE_REGISTRY[type].description,
    icon: true,
    data: { nodeType: type },
    run: () => {
      createNode(type, at.flowX, at.flowY);
    },
  } satisfies MenuItem;
}

// A search box first (typing filters to a flat, keyword-matched list), then
// categories as the first browsing level and a hover flyout of that
// category's node types as the second.
export function openAddNodeMenu(
  contextMenu: ContextMenuService,
  at: AddNodeMenuPosition,
  createNode: (type: string, x: number, y: number) => void,
): void {
  contextMenu.open({
    at: { x: at.clientX, y: at.clientY },
    ariaLabel: "Add node",
    items: FLOW_NODE_CATEGORIES.map((category) => ({
      label: category,
      submenu: Object.entries(FLOW_NODE_REGISTRY)
        .filter(([, definition]) => definition.category === category)
        .map(([type]) => nodeLeaf(type, at, createNode)),
    })),
    search: {
      placeholder: "Search nodes…",
      filter: (query) => {
        const needle = query.toLowerCase();
        return Object.entries(FLOW_NODE_REGISTRY)
          .filter(([type, definition]) =>
            [definition.label, type, ...(definition.keywords ?? [])].join(" ").toLowerCase().includes(needle),
          )
          .map(([type]) => nodeLeaf(type, at, createNode));
      },
    },
  });
}
