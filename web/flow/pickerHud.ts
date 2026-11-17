// A Load Image picker's picture, on the graph card and in App Mode alike,
// with the gallery's hover bars: the picture's dimensions with their aspect
// ratio along its top edge, or the ratio alone in a narrow App Mode tile,
// and the file's name and size along its bottom.

import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import { treePath } from "../core/paths.ts";
import { formatDimensions, formatFileSize } from "../lib/dom.ts";
import { hudCells, hudRoot, mediaFrame } from "../lib/mediaHud.ts";

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
  const [dimensions, ratio, name, size] = hudCells(4);
  ratio.className = "flow-picture-ratio";
  name.className = "media-hud-name";
  name.textContent = file.name;
  size.textContent = formatFileSize(file.size);
  const bars = hudRoot([dimensions, ratio], [name, size]);
  bars.hidden = false;
  const el = mediaFrame(img, bars, "flow-picture");
  img.addEventListener("load", () => {
    const { naturalWidth: width, naturalHeight: height } = img;
    if (!width || !height) return;
    el.style.aspectRatio = `${width} / ${height}`;
    el.style.setProperty("--picture-ratio", String(width / height));
    dimensions.textContent = formatDimensions(width, height, "");
    ratio.textContent = formatAspectRatio(width, height);
  });
  img.src = src;
  return { el, img };
}
