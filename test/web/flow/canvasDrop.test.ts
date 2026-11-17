// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { wireCanvasDrop } from "../../../web/flow/canvasDrop.ts";

function drop(pane: HTMLElement, path: string): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => path, files: [] } });
  pane.dispatchEvent(event);
}

describe("a tree drop onto empty canvas", () => {
  // A vector image is not a raster image, and no Load node takes one.
  it("makes a Load Image node for a raster image, and nothing for a vector image", () => {
    const pane = document.createElement("div");
    const createNode = vi.fn();
    wireCanvasDrop(pane, { transform: () => [0, 0, 1], flowPath: () => "story.flow.html", createNode });

    drop(pane, "art/cover.png");
    expect(createNode).toHaveBeenCalledExactlyOnceWith("loadImage", expect.any(Number), expect.any(Number), {
      imagePath: "art/cover.png",
    });

    createNode.mockClear();
    drop(pane, "art/logo.svg");
    expect(createNode).not.toHaveBeenCalled();
  });
});
