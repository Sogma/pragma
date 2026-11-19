// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPictureLayers } from "../../../web/lib/pictureLayers.ts";
import { type Guides, NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { type Look, NO_LOOK } from "../../../web/lib/videoLut.ts";
import { memorySetting } from "../support/editorLayout.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPictureLayers", () => {
  it("lays the look under the guides, out of the accessibility tree, and the guides alone without a look", () => {
    const guides = memorySetting<Guides>(NO_GUIDES);
    const img = document.createElement("img");
    const raster = createPictureLayers(img, { guides, lut: memorySetting<Look>(NO_LOOK), type: "image/png" });
    expect(raster.element.className).toBe("picture-layers");
    expect(raster.element.getAttribute("aria-hidden")).toBe("true");
    expect([...raster.element.children].map((layer) => layer.getAttribute("class"))).toEqual([
      "video-lut",
      "video-guides",
    ]);

    const vector = createPictureLayers(img, { guides });
    expect([...vector.element.children].map((layer) => layer.getAttribute("class"))).toEqual(["video-guides"]);
  });

  it("draws the guides in the picture's own pixels, and stops following them once disposed", () => {
    const guides = memorySetting<Guides>({ ...NO_GUIDES, frames: ["1:1"] });
    const layers = createPictureLayers(document.createElement("img"), { guides });
    const overlay = layers.element.querySelector(".video-guides") as HTMLElement;
    layers.setSize(1600, 900);
    const viewBox = overlay.querySelector("svg")?.getAttribute("viewBox");
    expect([viewBox, overlay.hasAttribute("hidden")]).toEqual(["0 0 1600 900", false]);

    layers.dispose();
    guides.set({ ...NO_GUIDES });
    expect(overlay.hasAttribute("hidden")).toBe(false);
  });
});
