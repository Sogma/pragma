// The flow pane's DOM, built here rather than declared in index.html, so a
// second flow pane is one more call and no element is id-keyed. `root` is
// what the editor group mounts; the rest are the pieces createFlowView
// (xyflowAdapter.ts) wires, and `host` is where its scoped dialogs anchor.

const SVG_NS = "http://www.w3.org/2000/svg";

import { iconButton } from "../lib/dom.ts";

const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>';

export interface FlowElements {
  root: HTMLDivElement;
  pane: HTMLDivElement;
  // The banner for a Flow this pane won't save: a locked file, or a save
  // refused for dropping nodes. Hidden otherwise.
  lockNotice: HTMLElement;
  viewport: HTMLDivElement;
  edgeGroup: SVGGElement;
  connectionPath: SVGPathElement;
  hud: HTMLDivElement;
  // The HUD's two lines: the frame stats, hidden unless Stats is on, over
  // the viewport's position.
  hudStats: HTMLSpanElement;
  hudPosition: HTMLSpanElement;
  appModePane: HTMLDivElement;
  canvasToolbar: HTMLDivElement;
  canvasToolbarZoom: HTMLButtonElement;
  canvasToolbarZoomPopover: HTMLDivElement;
  canvasToolbarZoomSlider: HTMLInputElement;
  canvasToolbarZoomValue: HTMLSpanElement;
  canvasToolbarZoomReset: HTMLButtonElement;
  canvasToolbarFit: HTMLButtonElement;
  // The pane element the view's dialogs anchor to (the confirmation to
  // remove a node, the capability prompt, the permissions panel).
  host: HTMLElement;
}

function div(className: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  return node;
}

function button(className: string, title: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.dataset.tooltip = title;
  node.setAttribute("aria-label", title);
  return node;
}

export function createFlowElements(): FlowElements {
  const root = div("editor-flow");

  // The canvas: edges drawn in an SVG under the nodes' viewport, both
  // panned and zoomed as one.
  const pane = div("flow-pane");
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.setAttribute("class", "flow-edges");
  const edgeGroup = document.createElementNS(SVG_NS, "g");
  edgeGroup.setAttribute("class", "flow-edge-group");
  edges.append(edgeGroup);
  const viewport = div("flow-viewport");
  // The drag-in-progress connection line gets its own layer *over* the
  // viewport, not a slot in the edge SVG under it: settled edges belong
  // behind the cards they join, but a line being dragged has to stay
  // visible right up to its target pin, which sits on top of a card. React
  // Flow splits its edge and connection-line layers the same way.
  //
  // The layer stays outside the viewport's pan/zoom transform, so the line
  // is drawn in screen space.
  const connectionLayer = document.createElementNS(SVG_NS, "svg");
  connectionLayer.setAttribute("class", "flow-connection-layer");
  const connectionPath = document.createElementNS(SVG_NS, "path");
  connectionPath.setAttribute("class", "flow-connection-path");
  connectionLayer.append(connectionPath);
  pane.append(edges, viewport, connectionLayer);
  // Focusable, so a click on the canvas or a card takes the keyboard there:
  // the canvas's keys (flowKeys.ts) act only while it has focus.
  pane.tabIndex = -1;

  // The graph's alternate view (docs/protocol.md, App mode): a plain form
  // of only the exposed fields, built by the view, never static markup.
  const appModePane = div("flow-app-pane");
  appModePane.hidden = true;

  const hud = div("flow-hud canvas-stat");
  const hudStats = document.createElement("span");
  hudStats.hidden = true;
  const hudPosition = document.createElement("span");
  hud.append(hudStats, hudPosition);

  // The bottom-right viewport controls: zoom (with its popover) and fit.
  const canvasToolbar = div("editor-canvas-toolbar floating-toolbar");
  const canvasToolbarZoom = button("flat-button flow-canvas-toolbar-zoom", "Zoom");
  canvasToolbarZoom.setAttribute("aria-haspopup", "true");
  canvasToolbarZoom.setAttribute("aria-expanded", "false");
  canvasToolbarZoom.textContent = "100%";
  const canvasToolbarFit = iconButton("flow-canvas-toolbar-fit", "Fit view");
  canvasToolbarFit.append(document.createElement("span"));
  (canvasToolbarFit.firstElementChild as HTMLElement).className = "flow-canvas-toolbar-fit-icon";

  const canvasToolbarZoomPopover = div("floating-toolbar flow-canvas-toolbar-zoom-popover");
  canvasToolbarZoomPopover.hidden = true;
  const popoverRow = div("flow-canvas-toolbar-zoom-popover-row");
  const canvasToolbarZoomReset = iconButton("flow-canvas-toolbar-zoom-reset", "Reset zoom to 100%", "Reset to 100%");
  canvasToolbarZoomReset.innerHTML = RESET_ICON;
  const canvasToolbarZoomValue = document.createElement("span");
  canvasToolbarZoomValue.className = "flow-canvas-toolbar-zoom-popover-value";
  canvasToolbarZoomValue.textContent = "100%";
  popoverRow.append(canvasToolbarZoomReset, canvasToolbarZoomValue);
  const canvasToolbarZoomSlider = document.createElement("input");
  canvasToolbarZoomSlider.type = "range";
  canvasToolbarZoomSlider.className = "settings-slider flow-canvas-toolbar-zoom-slider";
  canvasToolbarZoomSlider.min = "25";
  canvasToolbarZoomSlider.max = "200";
  canvasToolbarZoomSlider.step = "1";
  canvasToolbarZoomSlider.value = "100";
  canvasToolbarZoomSlider.setAttribute("aria-label", "Zoom percentage");
  canvasToolbarZoomPopover.append(popoverRow, canvasToolbarZoomSlider);
  canvasToolbar.append(canvasToolbarZoom, canvasToolbarFit, canvasToolbarZoomPopover);

  // Hidden, and empty until a flow is open, unless that flow is locked or a
  // save of it is refused; the view fills in the text. Built here with the
  // rest of the pane's furniture rather than constructed on demand.
  const lockNotice = document.createElement("div");
  lockNotice.className = "document-locked-notice flow-locked-notice inline-warning";
  lockNotice.hidden = true;

  root.append(pane, appModePane, hud, canvasToolbar, lockNotice);

  return {
    root,
    lockNotice,
    pane,
    viewport,
    edgeGroup,
    connectionPath,
    hud,
    hudStats,
    hudPosition,
    appModePane,
    canvasToolbar,
    canvasToolbarZoom,
    canvasToolbarZoomPopover,
    canvasToolbarZoomSlider,
    canvasToolbarZoomValue,
    canvasToolbarZoomReset,
    canvasToolbarFit,
    host: root,
  };
}
