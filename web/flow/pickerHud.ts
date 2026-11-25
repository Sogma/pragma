// A Load Image picker's picture, on the graph card and in App mode alike,
// with the gallery's hover bars: the picture's dimensions with their aspect
// ratio and the scale it is shown at along its top edge, or the ratio alone
// in a narrow App mode tile, and the file's name and size along its bottom.

import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import { treePath } from "../core/paths.ts";
import { formatDimensions, formatFileSize } from "../lib/dom.ts";
import { containedScale, hudCells, hudRoot, mediaFrame } from "../lib/mediaHud.ts";

/** What the bars say about the file behind a picture. */
export interface PickedFile {
  name: string;
  size: number;
}

/** A stored path's file, sized from the base64 data it was read as. */
export function storedFile(storedPath: string, base64: string): PickedFile {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return { name: basenameOf(treePath(storedPath)), size: Math.floor((base64.length * 3) / 4) - padding };
}

// The bars share the picture's frame (mediaHud.ts), a box of the picture's
// own shape. It takes that shape once the picture decodes; CSS fits it to
// the drop zone (web/styles/flow/widgets.css).
export function createPickedPicture(src: string, file: PickedFile): { el: HTMLElement; img: HTMLImageElement } {
  const img = document.createElement("img");
  const [facts, dimensions, scale, ratio, name, size] = hudCells(6);
  // The dimensions and the scale share one box beside the ratio, so the top
  // bar never holds three facts: the overlay would centre the middle one
  // (media-panes.css), counting a ratio that CSS hides.
  facts.className = "flow-picture-facts";
  facts.append(dimensions, scale);
  ratio.className = "flow-picture-ratio";
  name.className = "media-hud-name";
  name.textContent = file.name;
  size.textContent = formatFileSize(file.size);
  const bars = hudRoot([facts, ratio], [name, size]);
  bars.hidden = false;
  const el = mediaFrame(img, bars, "flow-picture");
  // The picture's own box counts, as the bars' size rules read it, so the
  // canvas's zoom leaves the scale as it is. Measured again as the bars are
  // about to show, since a card or a tile is resized with the pointer
  // elsewhere.
  const measure = () => {
    scale.textContent = containedScale(img, img.naturalWidth, img.naturalHeight);
  };
  img.addEventListener("load", () => {
    const { naturalWidth: width, naturalHeight: height } = img;
    if (!width || !height) return;
    el.style.aspectRatio = `${width} / ${height}`;
    el.style.setProperty("--picture-ratio", String(width / height));
    dimensions.textContent = formatDimensions(width, height, "");
    ratio.textContent = formatAspectRatio(width, height);
    measure();
  });
  img.addEventListener("pointerenter", measure);
  img.src = src;
  return { el, img };
}
