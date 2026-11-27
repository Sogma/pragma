// The Flow canvas's right-click menus: empty pane (add a node), a pin, an
// exposable field, a node's title bar, and a Load node's chip.
//
// The canvas (xyflowAdapter.ts) owns the graph and the node DOM; this owns
// what a right-click offers over them and calls back. services/menus.ts
// draws the rows and owns placement, dismissal and Escape.
import type { Transform } from "@xyflow/system";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import type { FlowEdgeInstance, FlowGraph, FlowNodeInstance, FlowPortType } from "../../src/protocol/types.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import { openAddNodeMenu } from "./addNodeMenu.ts";
import { type NodeConfig, paneFlowPosition } from "./canvasDrop.ts";

// A Load node's chip menu, registered with the editor's open commands, and
// what it opens on: the chip's path as the space tree spells it.
export const CHIP_MENU = "flow.chip";
export type ChipTarget = { file: string } | { folder: string };

// The chip menu's Clear, which runs the chip's own clearing: what a node
// forgets with its path differs by node.
export const CLEAR_CHIP = "flow.clearChip";

export function chipClearOf(arg: unknown): (() => void) | undefined {
  if (typeof arg !== "object" || arg === null || !("clear" in arg)) return undefined;
  return typeof arg.clear === "function" ? (arg.clear as () => void) : undefined;
}

// The visibility corrections a disconnect leaves behind — the subset of
// nodeCard.ts's surface these menus need. A getter rather than the object,
// because the cards are built with the menus and so don't exist yet when
// this is constructed.
export interface FlowMenuCards {
  updateInputWidgetVisibility(nodeId: string, handleId: string): void;
  updateOutputHandleVisibility(nodeId: string, handleId: string): void;
  updateSourceDependents(nodeId: string): void;
  syncUnusedPins(nodeId: string): void;
}

export interface FlowMenuDeps {
  contextMenu: ContextMenuService;
  // The canvas, whose empty right-click opens Add Node where it lands.
  pane: HTMLElement;
  transform: () => Transform;
  // A flow whose format this build can't write: every menu that would start
  // an edit refuses. Expose stays open — it only toggles a field's own flag
  // through a callback the caller has already gated.
  locked: () => boolean;
  graph: () => FlowGraph;
  cards: () => FlowMenuCards;
  flowNodeById: Map<string, FlowNodeInstance>;
  renderEdges: () => void;
  persistGraph: () => void;
  createNode: (type: string, x: number, y: number, seed?: NodeConfig) => Promise<void>;
  cloneNode: (nodeId: string) => void;
  removeNode: (nodeId: string) => void;
}

export interface FlowMenus {
  openContextMenu(clientX: number, clientY: number, flowX: number, flowY: number): void;
  openHandleMenu(clientX: number, clientY: number, portType: FlowPortType | null, edges: FlowEdgeInstance[]): void;
  openExposeMenu(
    clientX: number,
    clientY: number,
    portType: FlowPortType,
    exposed: boolean,
    onToggle: () => void,
    actions?: MenuItem[],
  ): void;
  openNodeMenu(
    clientX: number,
    clientY: number,
    nodeId: string,
    onRename: () => void,
    onColor: () => void,
    onComment: () => void,
  ): void;
  openChipMenu(clientX: number, clientY: number, target: ChipTarget, clear?: () => void): void;
  // The node menu's Disable or Enable, which Mod+M gives the selected node.
  toggleDisabled(nodeId: string): void;
  // The node menu's Hide or Show unused pins, which Ctrl+H gives the selected
  // node and the card's count of hidden pins gives its own.
  toggleUnusedPins(nodeId: string): void;
}

export function createFlowMenus(deps: FlowMenuDeps): FlowMenus {
  // A read-only row naming a pin's type, colored by the type-<port type>
  // class the pin itself carries on the canvas (web/styles/value-types.css),
  // so the label and the pin always agree.
  function pinTypeRow(portType: FlowPortType): MenuItem {
    return { label: portType.toUpperCase(), className: `pin-type-label type-${portType}` };
  }

  function openContextMenu(clientX: number, clientY: number, flowX: number, flowY: number): void {
    if (deps.locked()) return;
    openAddNodeMenu(deps.contextMenu, { clientX, clientY, flowX, flowY }, deps.createNode);
  }

  deps.pane.addEventListener("contextmenu", (event) => {
    // Text that selects, a config field's or a Prompt/Note box's, is left to
    // the text menu (lib/textMenu.ts) rather than suppressed below.
    if ((event.target as HTMLElement).closest("input, textarea, .cm-content")) return;
    // Suppress the browser's own menu everywhere else in the pane, node
    // cards included — a native menu over a card reads as a bug.
    event.preventDefault();
    // The title bar and pins have their own menus and the rest of a card
    // has none; this pane-level listener only ever handles empty canvas.
    if ((event.target as HTMLElement).closest(".flow-node")) return;
    const position = paneFlowPosition(deps.pane, deps.transform(), event);
    openContextMenu(event.clientX, event.clientY, position.x, position.y);
  });

  // A handle's right-click — left-click-drag is reserved for drawing
  // connections, even from a connected handle. `edges` is every edge on the
  // clicked handle — one for a target (an input takes at most one edge),
  // possibly several for a fanned-out source — and one Disconnect removes
  // them all; an unconnected handle gets only the type row.
  //
  // A pin whose type isn't known, one its node lacks with nothing typed at
  // the wire's other end, gets no type row rather than a guessed one.
  function openHandleMenu(
    clientX: number,
    clientY: number,
    portType: FlowPortType | null,
    edges: FlowEdgeInstance[],
  ): void {
    if (deps.locked()) return;
    const disconnect = (): void => {
      const graph = deps.graph();
      const cards = deps.cards();
      const edgeIds = new Set(edges.map((e) => e.id));
      graph.edges = graph.edges.filter((e) => !edgeIds.has(e.id));
      deps.renderEdges();
      deps.persistGraph();
      for (const edge of edges) {
        cards.updateInputWidgetVisibility(edge.target, edge.targetPort);
        cards.updateSourceDependents(edge.target);
        cards.updateOutputHandleVisibility(edge.source, edge.sourcePort);
      }
    };
    deps.contextMenu.open({
      at: { x: clientX, y: clientY },
      ariaLabel: "Pin",
      items: [
        ...(portType ? [pinTypeRow(portType)] : []),
        ...(edges.length > 0 ? [{ label: "Disconnect", run: disconnect }] : []),
      ],
    });
  }

  // A field's right-click: the same type row a pin's menu leads with, then
  // Expose or Unexpose, named for whichever way the toggle is about to go,
  // then what the field itself offers.
  function openExposeMenu(
    clientX: number,
    clientY: number,
    portType: FlowPortType,
    exposed: boolean,
    onToggle: () => void,
    actions: MenuItem[] = [],
  ): void {
    deps.contextMenu.open({
      at: { x: clientX, y: clientY },
      ariaLabel: "Field",
      items: [pinTypeRow(portType), { label: exposed ? "Unexpose" : "Expose", run: onToggle }, ...actions],
    });
  }

  // A node title's right-click. The header always names the type, never the
  // custom label (a renamed Toggle still reads TOGGLE).
  //
  // Info holds facts only, as the inspector's Info tab does; Properties there
  // means values you edit. The edits, this menu's most used items, stay at
  // the top level rather than in a flyout.
  //
  // "Current version" is the type's definition; "Saved version" is the
  // instance's typeVersion stamped at creation (absent counts as current) —
  // a flag that its config may predate the type's shape, not a claim about
  // which code ran.
  function openNodeMenu(
    clientX: number,
    clientY: number,
    nodeId: string,
    onRename: () => void,
    onColor: () => void,
    onComment: () => void,
  ): void {
    if (deps.locked()) return;
    const flowNode = deps.flowNodeById.get(nodeId);
    const definition = flowNode ? FLOW_NODE_REGISTRY[flowNode.type] : undefined;
    deps.contextMenu.open({
      at: { x: clientX, y: clientY },
      ariaLabel: "Node",
      items: [
        {
          label: (definition?.label ?? "").toUpperCase(),
          className: "node-name-label",
          icon: true,
          data: flowNode ? { nodeType: flowNode.type } : undefined,
          style: flowNode?.color ? { color: flowNode.color } : undefined,
        },
        { label: "Color…", run: onColor },
        { label: "Rename…", run: onRename },
        { label: "Comment…", run: onComment },
        {
          label: flowNode?.unusedPinsHidden ? "Show unused pins" : "Hide unused pins",
          run: () => toggleUnusedPins(nodeId),
        },
        {
          label: "Info",
          group: "info",
          submenu: [
            { label: "Id", detail: nodeId },
            { label: "Current version", detail: definition?.version ?? "Unknown" },
            { label: "Saved version", detail: flowNode?.typeVersion ?? definition?.version ?? "Unknown" },
          ],
        },
        // Named for where it goes, as Expose and Unexpose are.
        {
          label: flowNode?.mode === "disabled" ? "Enable" : "Disable",
          group: "graph",
          run: () => toggleDisabled(nodeId),
        },
        {
          label: "Clone",
          group: "graph",
          run: () => {
            deps.cloneNode(nodeId);
          },
        },
        { label: "Remove", group: "graph", danger: true, run: () => deps.removeNode(nodeId) },
      ],
    });
  }

  // A run leaves a disabled node out, and every node it feeds, which the
  // wires' redraw marks on the cards (docs/protocol.md, Execution).
  function toggleDisabled(nodeId: string): void {
    const flowNode = deps.flowNodeById.get(nodeId);
    if (!flowNode || deps.locked()) return;
    if (flowNode.mode === "disabled") delete flowNode.mode;
    else flowNode.mode = "disabled";
    deps.renderEdges();
    deps.persistGraph();
  }

  // Display only: the card hides or shows the pins nothing flows through
  // (nodeCard.ts), and the run is the same either way.
  function toggleUnusedPins(nodeId: string): void {
    const flowNode = deps.flowNodeById.get(nodeId);
    if (!flowNode || deps.locked()) return;
    if (flowNode.unusedPinsHidden) delete flowNode.unusedPinsHidden;
    else flowNode.unusedPinsHidden = true;
    deps.cards().syncUnusedPins(nodeId);
    deps.persistGraph();
  }

  // Opening or copying edits nothing in the Flow, so a locked one still
  // offers them; Clear edits it, so a locked one leaves it out.
  function openChipMenu(clientX: number, clientY: number, target: ChipTarget, clear?: () => void): void {
    deps.contextMenu.open({
      menu: CHIP_MENU,
      arg: clear && !deps.locked() ? { ...target, clear } : target,
      at: { x: clientX, y: clientY },
      ariaLabel: "file" in target ? "File" : "Folder",
    });
  }

  return {
    openContextMenu,
    openHandleMenu,
    openExposeMenu,
    openNodeMenu,
    openChipMenu,
    toggleDisabled,
    toggleUnusedPins,
  };
}
