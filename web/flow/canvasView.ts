// Where the canvas is panned to and how far it is zoomed: drawn onto the
// nodes' layer, the edges and the readouts, and reported once a gesture
// leaves it somewhere new. Never saved here: the file keeps only the Flow's
// default view, which a person sets on purpose (docs/protocol.md, Graph shape).
import {
  infiniteExtent,
  PanOnScrollMode,
  type PanZoomInstance,
  type Transform,
  type Viewport,
  XYPanZoom,
} from "@xyflow/system";
import { FLOW_MAX_ZOOM, FLOW_MIN_ZOOM } from "./canvasZoom.ts";
import type { FlowElements } from "./flowElements.ts";

// Where a Flow with no viewport of its own opens.
const ORIGIN: Viewport = { x: 0, y: 0, zoom: 1 };

export interface CanvasView {
  readonly panZoom: PanZoomInstance;
  // [x, y, zoom], as the canvas draws it.
  transform(): Transform;
  current(): Viewport;
  // Puts the canvas at `viewport`, or the origin at 100%, as a render does:
  // nothing is reported for it.
  show(viewport: Viewport | undefined): void;
  differsFrom(viewport: Viewport | undefined): boolean;
}

export function createCanvasView(elements: FlowElements, onMove: (viewport: Viewport) => void): CanvasView {
  let transform: Transform = [0, 0, 1];
  // The viewport last reported or shown. d3-zoom also ends a gesture on a
  // plain click and on a show's own sync, and those must report nothing.
  let reported: Viewport = ORIGIN;

  function apply(viewport: Viewport): void {
    transform = [viewport.x, viewport.y, viewport.zoom];
    elements.viewport.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
    elements.edgeGroup.setAttribute("transform", `translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`);
    // No zoom here — the canvas toolbar's zoom button already
    // shows it more prominently; this HUD is the only place x/y ever show.
    elements.hudPosition.textContent = `x: ${viewport.x.toFixed(0)}  y: ${viewport.y.toFixed(0)}`;
    // The slider's min/max (25-200, flowElements.ts) is a curated range
    // narrower than FLOW_MIN_ZOOM/FLOW_MAX_ZOOM (20-300, what scroll/pinch/
    // Fit View allow) — a zoom outside it just pins the thumb to the nearer
    // end, while the text readouts show the true percentage.
    const zoomPercent = Math.round(viewport.zoom * 100);
    elements.canvasToolbarZoom.textContent = `${zoomPercent}%`;
    elements.canvasToolbarZoomValue.textContent = `${zoomPercent}%`;
    elements.canvasToolbarZoomSlider.value = String(zoomPercent);
  }

  const panZoom = XYPanZoom({
    domNode: elements.pane,
    minZoom: FLOW_MIN_ZOOM,
    maxZoom: FLOW_MAX_ZOOM,
    viewport: ORIGIN,
    translateExtent: infiniteExtent,
    onDraggingChange: () => {},
    onPanZoom: (_event, viewport) => apply(viewport),
    // End, not onPanZoom: that one fires per mouse-move and wheel tick, and
    // each report saves the layout.
    onPanZoomEnd: (_event, viewport) => {
      if (viewport.x === reported.x && viewport.y === reported.y && viewport.zoom === reported.zoom) return;
      reported = viewport;
      onMove(viewport);
    },
  });
  panZoom.update({
    noWheelClassName: "nowheel",
    noPanClassName: "nopan",
    preventScrolling: true,
    panOnScroll: false,
    panOnDrag: true,
    panOnScrollMode: PanOnScrollMode.Free,
    panOnScrollSpeed: 0.5,
    userSelectionActive: false,
    zoomOnPinch: true,
    zoomOnScroll: true,
    // Off: d3-zoom's own dblclick behavior just zooms in on the click point
    // (compounding on repeat clicks). The pane's own "dblclick" listener
    // (canvasZoom.ts) replaces it with the 100%/Fit View toggle instead.
    zoomOnDoubleClick: false,
    panActivationKeyPressed: false,
    zoomActivationKeyPressed: false,
    lib: "system",
    onTransformChange: (t) => {
      transform = t;
    },
    connectionInProgress: false,
    paneClickDistance: 0,
    selectionOnDrag: false,
  });
  apply(ORIGIN);

  return {
    panZoom,
    transform: () => transform,
    current: () => ({ x: transform[0], y: transform[1], zoom: transform[2] }),
    show(viewport) {
      const shown = viewport ?? ORIGIN;
      reported = shown;
      apply(shown);
      // d3-zoom computes every gesture from its own stored transform, not the
      // CSS set above: without this the first gesture would jump to where the
      // previous flow left it, and report that jump as this one's place.
      panZoom.syncViewport(shown);
    },
    differsFrom(viewport) {
      const { x, y, zoom } = viewport ?? ORIGIN;
      return transform[0] !== x || transform[1] !== y || transform[2] !== zoom;
    },
  };
}
