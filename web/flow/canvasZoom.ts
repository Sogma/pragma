// The canvas's zoom controls: the toolbar's zoom button and its popover (a
// slider and Reset to 100%), Fit View, and double-clicking empty canvas.
//
// Programmatic zooms go through panZoom.setViewport/scaleTo, never a bare
// CSS viewport write: d3-zoom keeps its own transform, and a write that
// skips it makes the next drag/scroll jump from d3's stale one. onPanZoom
// still fires either way, so the HUD, zoom text, slider, and persisted
// viewport update exactly as for a manual gesture.
import {
  getInternalNodesBounds,
  getViewportForBounds,
  type InternalNodeBase,
  nodeToRect,
  type PanZoomInstance,
  type Transform,
  type Viewport,
  type XYPosition,
} from "@xyflow/system";
import { paneFlowPosition } from "./canvasDrop.ts";
import type { FlowElements } from "./flowElements.ts";

// Shared between the canvas's own scroll/pinch clamping (xyflowAdapter.ts)
// and Fit View's framing below — one pair of limits, not two that could
// silently drift apart.
export const FLOW_MIN_ZOOM = 0.2;
export const FLOW_MAX_ZOOM = 3;

// The room a node needs between it and the pane's edge for a double-click's
// 100% view to count as showing it whole.
const SPOT_MARGIN = 24;

// The centers, along one axis, of a window `size` long that holds the span
// [start, end] whole; for a span longer than the window, the centers that
// keep the window inside the span. `value` clamped to them.
function clampToSpan(value: number, start: number, end: number, size: number): number {
  const a = end - size / 2;
  const b = start + size / 2;
  return Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b));
}

export interface CanvasZoomDeps {
  elements: FlowElements;
  panZoom: PanZoomInstance;
  nodeLookup: Map<string, InternalNodeBase>;
  transform(): Transform;
}

export interface CanvasZoom {
  // The popover is the pane's first transient for Escape.
  isOpen(): boolean;
  // Closes the popover and hands focus back to its button.
  dismiss(): void;
}

export function createCanvasZoom({ elements, panZoom, nodeLookup, transform }: CanvasZoomDeps): CanvasZoom {
  function closeZoomPopover(): void {
    elements.canvasToolbarZoomPopover.hidden = true;
    elements.canvasToolbarZoom.setAttribute("aria-expanded", "false");
  }
  elements.canvasToolbarZoom.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = elements.canvasToolbarZoomPopover.hidden;
    elements.canvasToolbarZoomPopover.hidden = !opening;
    elements.canvasToolbarZoom.setAttribute("aria-expanded", String(opening));
  });
  // Closing on an outside click/Escape rather than e.g. blur: the slider
  // itself needs to keep focus while being dragged, and a click on Fit View
  // (a sibling in the same toolbar, not "inside" this popover or its own
  // trigger) should still dismiss it same as any other outside click.
  document.addEventListener("click", (event) => {
    if (elements.canvasToolbarZoomPopover.hidden) return;
    const target = event.target as Node;
    if (elements.canvasToolbarZoomPopover.contains(target) || elements.canvasToolbarZoom.contains(target)) return;
    closeZoomPopover();
  });
  // No { duration } here unlike every other panZoom call in this file — the
  // slider drag itself is already the smooth, incremental motion; animating
  // each intermediate "input" tick on top of that would lag a half-step
  // behind the user's own thumb position instead of tracking it directly.
  elements.canvasToolbarZoomSlider.addEventListener("input", () => {
    const percent = Number(elements.canvasToolbarZoomSlider.value);
    elements.canvasToolbarZoomValue.textContent = `${percent}%`;
    void panZoom.scaleTo(percent / 100);
  });
  // scaleTo (not setViewport) here: d3-zoom's own center-preserving zoom, so
  // resetting to 100% keeps the current view's center in place, where
  // setViewport({x:0, y:0, zoom:1}) would recenter on the graph's origin.
  elements.canvasToolbarZoomReset.addEventListener("click", () => {
    void panZoom.scaleTo(1, { duration: 200 });
  });
  function fitViewport(): Viewport | undefined {
    if (nodeLookup.size === 0) return undefined;
    const bounds = getInternalNodesBounds(nodeLookup);
    const paneRect = elements.pane.getBoundingClientRect();
    return getViewportForBounds(bounds, paneRect.width, paneRect.height, FLOW_MIN_ZOOM, FLOW_MAX_ZOOM, 0.1);
  }
  function fitView(): void {
    const viewport = fitViewport();
    if (viewport) void panZoom.setViewport(viewport, { duration: 200 });
  }
  elements.canvasToolbarFit.addEventListener("click", fitView);
  // A spot whose 100% view already shows a node whole, or is filled by one,
  // stays put. Out in empty canvas the spot holds nothing to keep, so the
  // view centers the node it would travel least to show: moving only that
  // far would leave the node at the pane's edge with blank canvas beyond.
  //
  // Along an axis where that node outsizes the pane, its part nearest the
  // spot fills the pane, rather than a middle that shows none of its edges.
  function doubleClickCenter(spot: XYPosition, width: number, height: number): XYPosition {
    let best = spot;
    let bestDistance = Infinity;
    for (const node of nodeLookup.values()) {
      const rect = nodeToRect(node);
      const x = clampToSpan(spot.x, rect.x - SPOT_MARGIN, rect.x + rect.width + SPOT_MARGIN, width);
      const y = clampToSpan(spot.y, rect.y - SPOT_MARGIN, rect.y + rect.height + SPOT_MARGIN, height);
      const distance = Math.hypot(x - spot.x, y - spot.y);
      if (distance === 0) return spot;
      if (distance < bestDistance) {
        best = {
          x: rect.width + 2 * SPOT_MARGIN > width ? x : rect.x + rect.width / 2,
          y: rect.height + 2 * SPOT_MARGIN > height ? y : rect.y + rect.height / 2,
        };
        bestDistance = distance;
      }
    }
    return best;
  }
  // Double-clicking empty canvas is a round trip: out to everything, in on a
  // spot. At or above 100% it does a Fit View; below 100%, or when the view
  // is already fitted, it centers the clicked spot at 100%.
  //
  // The "already fitted" test is for a small graph, whose Fit View lands
  // above 100%: without it, every double-click there would refit in place.
  //
  // Ignored on a node itself (.flow-node, "nopan") rather than the pane at
  // large, matching every other pane-vs-node gesture split on the canvas
  // (its context menu, the node selection).
  elements.pane.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest(".flow-node")) return;
    const [x, y, zoom] = transform();
    const fit = fitViewport();
    const fitted =
      fit !== undefined && Math.abs(fit.zoom - zoom) < 0.001 && Math.abs(fit.x - x) < 0.5 && Math.abs(fit.y - y) < 0.5;
    if (fit && zoom > 1 - 0.001 && !fitted) {
      void panZoom.setViewport(fit, { duration: 200 });
      return;
    }
    const paneRect = elements.pane.getBoundingClientRect();
    const spot = paneFlowPosition(elements.pane, transform(), event);
    const center = doubleClickCenter(spot, paneRect.width, paneRect.height);
    const viewport = { x: paneRect.width / 2 - center.x, y: paneRect.height / 2 - center.y, zoom: 1 };
    void panZoom.setViewport(viewport, { duration: 200 });
  });

  return {
    isOpen: () => !elements.canvasToolbarZoomPopover.hidden,
    dismiss() {
      closeZoomPopover();
      elements.canvasToolbarZoom.focus();
    },
  };
}
