// @vitest-environment jsdom
import type { InternalNodeBase, PanZoomInstance, Transform } from "@xyflow/system";
import { describe, expect, it, vi } from "vitest";
import { createCanvasZoom } from "../../../web/flow/canvasZoom.ts";
import { createFlowElements } from "../../../web/flow/flowElements.ts";

// An 800x600 pane whose top-left sits at (100, 50) on the page, so its
// center is pane point (400, 300).
function mountZoom(transform: Transform, nodeLookup = new Map<string, InternalNodeBase>()) {
  const elements = createFlowElements();
  elements.pane.getBoundingClientRect = () => new DOMRect(100, 50, 800, 600);
  const panZoom = {
    setViewport: vi.fn<PanZoomInstance["setViewport"]>(async () => undefined),
    scaleTo: vi.fn<PanZoomInstance["scaleTo"]>(async () => true),
  };
  createCanvasZoom({
    elements,
    panZoom: panZoom as unknown as PanZoomInstance,
    nodeLookup,
    transform: () => transform,
  });
  return { elements, panZoom };
}

// A card with its top-left at (x, y), 400x300 unless sized.
function card(id: string, x: number, y: number, width = 400, height = 300): InternalNodeBase {
  return {
    id,
    position: { x, y },
    data: {},
    measured: { width, height },
    internals: { positionAbsolute: { x, y }, z: 0, userNode: {} },
  } as unknown as InternalNodeBase;
}

function doubleClick(target: Element, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX, clientY }));
}

describe("double-clicking the canvas", () => {
  it("brings the clicked spot to the pane's center at 100%", () => {
    // At 50%, panned by (40, 20): page (400, 300) is pane (300, 250), which
    // shows flow point ((300 - 40) / 0.5, (250 - 20) / 0.5) = (520, 460).
    const { elements, panZoom } = mountZoom([40, 20, 0.5]);
    doubleClick(elements.pane, 400, 300);
    expect(panZoom.setViewport).toHaveBeenCalledWith({ x: 400 - 520, y: 300 - 460, zoom: 1 }, { duration: 200 });
    expect(panZoom.scaleTo).not.toHaveBeenCalled();
  });

  it.each([1, 1.3])("does a Fit View at zoom %s, whatever spot was clicked", (zoom) => {
    // Framed, the card's center (300, 350) sits on the pane's center.
    const { elements, panZoom } = mountZoom([0, 0, zoom], new Map([["a", card("a", 100, 200)]]));
    doubleClick(elements.pane, 150, 100);
    const [viewport] = panZoom.setViewport.mock.calls[0];
    expect(viewport.x + 300 * viewport.zoom).toBeCloseTo(400);
    expect(viewport.y + 350 * viewport.zoom).toBeCloseTo(300);
    expect(viewport.zoom).not.toBe(1);
  });

  it("centers the clicked spot at 100% once the view is fitted, even above 100%", () => {
    // A lone 400x300 card fits at about 182%.
    const transform: Transform = [0, 0, 1];
    const { elements, panZoom } = mountZoom(transform, new Map([["a", card("a", 100, 200)]]));
    doubleClick(elements.pane, 150, 100);
    const [fit] = panZoom.setViewport.mock.calls[0];
    expect(fit.zoom).toBeGreaterThan(1);
    transform.splice(0, 3, fit.x, fit.y, fit.zoom);
    // Page (500, 350) is the pane's center, the card's center (300, 350).
    doubleClick(elements.pane, 500, 350);
    const [viewport] = panZoom.setViewport.mock.calls[1];
    expect(viewport.x).toBeCloseTo(100);
    expect(viewport.y).toBeCloseTo(-50);
    expect(viewport.zoom).toBe(1);
  });

  it("keeps a spot whose 100% view already shows a node whole", () => {
    // At 50%, page (300, 200) is pane (200, 150), flow (400, 300): a view
    // spanning (0, 0)-(800, 600), around the card's (100, 200)-(500, 500).
    const { elements, panZoom } = mountZoom([0, 0, 0.5], new Map([["a", card("a", 100, 200)]]));
    doubleClick(elements.pane, 300, 200);
    expect(panZoom.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
  });

  it("centers the nearest node for a spot out in empty canvas", () => {
    // At 20%, page (480, 70) is pane (380, 20), flow (1900, 100), whose 100%
    // view shows neither card. The nearer card spans (100, 200)-(500, 500),
    // so its center (300, 350) goes to the pane's center.
    const nodes = new Map([
      ["a", card("a", 100, 200)],
      ["b", card("b", -2000, 200)],
    ]);
    const { elements, panZoom } = mountZoom([0, 0, 0.2], nodes);
    doubleClick(elements.pane, 480, 70);
    expect(panZoom.setViewport).toHaveBeenCalledWith({ x: 400 - 300, y: 300 - 350, zoom: 1 }, { duration: 200 });
  });

  it("fills the pane from the near edge of a node too wide to center", () => {
    // At 20%, page (700, 250) is pane (600, 200), flow (3000, 1000). The
    // 2000x300 card spans (0, 0)-(2000, 300). Too wide to center, it fills
    // the pane out to 24px past its right edge: center x 2024 - 400 = 1624.
    // Its height fits, so center y is its middle, 150.
    const { elements, panZoom } = mountZoom([0, 0, 0.2], new Map([["a", card("a", 0, 0, 2000, 300)]]));
    doubleClick(elements.pane, 700, 250);
    expect(panZoom.setViewport).toHaveBeenCalledWith({ x: 400 - 1624, y: 300 - 150, zoom: 1 }, { duration: 200 });
  });

  it("leaves a double-click on a node to the node", () => {
    const { elements, panZoom } = mountZoom([0, 0, 0.5]);
    const card = document.createElement("div");
    card.className = "flow-node";
    elements.viewport.append(card);
    doubleClick(card, 400, 300);
    expect(panZoom.setViewport).not.toHaveBeenCalled();
    expect(panZoom.scaleTo).not.toHaveBeenCalled();
  });
});
