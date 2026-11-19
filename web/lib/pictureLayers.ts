// What a still shows over itself, as a player shows over a clip: the picture
// through the look every viewer shares, and the guides, drawn in the
// picture's own pixels in a box that is the picture's own
// (web/styles/media-panes.css). The file is never touched.
import { createGuidesOverlay, type GuidesChoice } from "./videoGuides.ts";
import { createLutLayer, type LutChoice } from "./videoLut.ts";

export interface PictureLayers {
  /** Goes in the picture's frame, after its overlay. */
  readonly element: HTMLElement;
  /** The picture's size in pixels, once it has decoded. */
  setSize(width: number, height: number): void;
  dispose(): void;
}

export interface PictureLayerChoices {
  guides: GuidesChoice;
  /** Left out for a vector image, which has no pixels to grade. */
  lut?: LutChoice;
  /** The still's media type, which lets an animated one play through the look. */
  type?: string;
}

export function createPictureLayers(img: HTMLImageElement, choices: PictureLayerChoices): PictureLayers {
  const element = document.createElement("div");
  element.className = "picture-layers";
  element.setAttribute("aria-hidden", "true");
  const guides = createGuidesOverlay(choices.guides);
  const look = choices.lut === undefined ? undefined : createLutLayer(img, choices.lut, choices.type);
  if (look) element.append(look.element);
  element.append(guides.element);
  return {
    element,
    setSize: (width, height) => guides.setSize(width, height),
    dispose() {
      guides.dispose();
      look?.dispose();
    },
  };
}
