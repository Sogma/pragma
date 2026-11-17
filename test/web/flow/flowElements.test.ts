// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFlowElements } from "../../../web/flow/flowElements.ts";

describe("createFlowElements", () => {
  it("builds the pane's subtree with classes only, the popover and form hidden", () => {
    const elements = createFlowElements();
    expect(elements.root.className).toBe("editor-flow");
    expect(elements.root.querySelector("[id]")).toBeNull();
    expect(elements.root.contains(elements.pane)).toBe(true);
    expect(elements.pane.querySelector("svg.flow-edges g.flow-edge-group")).toBe(elements.edgeGroup);
    // Over the viewport, not inside the edge SVG under it — the drag line
    // has to paint above the cards (flowElements.ts).
    expect(elements.pane.querySelector("svg.flow-connection-layer path.flow-connection-path")).toBe(
      elements.connectionPath,
    );
    expect(elements.pane.lastElementChild?.getAttribute("class")).toBe("flow-connection-layer");
    expect(elements.viewport.className).toBe("flow-viewport");
    expect(elements.appModePane.hidden).toBe(true);
    expect(elements.canvasToolbar.classList.contains("floating-toolbar")).toBe(true);
    expect(elements.canvasToolbarZoom.textContent).toBe("100%");
    expect(elements.canvasToolbarZoom.getAttribute("aria-expanded")).toBe("false");
    expect(elements.canvasToolbarZoomPopover.hidden).toBe(true);
    expect(elements.canvasToolbarZoomSlider.type).toBe("range");
    expect([elements.canvasToolbarZoomSlider.min, elements.canvasToolbarZoomSlider.max]).toEqual(["25", "200"]);
    expect(elements.canvasToolbarZoomReset.querySelector("svg")).not.toBeNull();
    expect(elements.canvasToolbarFit.getAttribute("aria-label")).toBe("Fit view");
    expect(elements.host).toBe(elements.root);
  });

  it("every call is an independent tree, so a second flow pane can exist", () => {
    const first = createFlowElements();
    const second = createFlowElements();
    expect(second.root).not.toBe(first.root);
    expect(second.pane).not.toBe(first.pane);
    expect(first.root.contains(second.pane)).toBe(false);
  });
});
