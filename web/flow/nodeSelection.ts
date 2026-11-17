// The single clicked-on node, cleared on Escape or a click on empty pane.
// Deliberately not @xyflow/system's selection primitives: the canvas's
// XYDrag store sets selectNodesOnDrag: false and stubs unselectNodesAndEdges
// out, and a plain id plus a CSS class avoids reverse-engineering another
// undocumented internal.

export interface NodeSelection {
  /** The selected node's id; null while none is. */
  readonly id: string | null;
  /** Moves the selection, and its card's `selected` class, to a node, or
   * to none. */
  select(nodeId: string | null): void;
  /** A node leaving the canvas leaves the selection; its card goes too, so
   * no class is moved. */
  forget(nodeId: string): void;
}

export function createNodeSelection(
  pane: HTMLElement,
  cardOf: (nodeId: string) => HTMLElement | undefined,
): NodeSelection {
  let id: string | null = null;
  function select(nodeId: string | null): void {
    if (id === nodeId) return;
    if (id) cardOf(id)?.classList.remove("selected");
    id = nodeId;
    if (id) cardOf(id)?.classList.add("selected");
  }
  // In the capture phase: a mousedown on the pane also starts a d3-zoom pan,
  // which calls stopImmediatePropagation, and a pin's connection drag and
  // the resize grip stop propagation too. A bubble listener would miss all
  // of those.
  document.addEventListener(
    "mousedown",
    (event) => {
      const target = event.target as HTMLElement;
      // Only a press inside the canvas moves the selection. A toolbar, a
      // popover, the sidebar, the chat or a floating menu (all mounted
      // outside the pane) leave it alone, so the copilot still hears which
      // node is selected while the writer types to it.
      if (!pane.contains(target)) return;
      const card = target.closest(".flow-node");
      select(card instanceof HTMLElement ? (card.dataset.nodeId ?? null) : null);
    },
    true,
  );
  return {
    get id() {
      return id;
    },
    select,
    forget(nodeId) {
      if (id === nodeId) id = null;
    },
  };
}
