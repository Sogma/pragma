// The hover overlay over a picture or a player: bars of glanceable facts
// laid over the media's own box. The image and video views, the gallery's
// preview and a Flow's image picker share it, so they read as one thing.
//
// The bars share a box with the media and nothing else, so the browser lays
// out and rounds both from the same edges. Never place them by measuring the
// media: a measured box rounds apart from it at fractional sizes and display
// scales, and leaves a seam between picture and bar.
//
// A thumbnail's bars are the small form, on a gallery tile and a media
// field alike, holding what their box's width has room for.
import type { PictureDetails, VideoFormatResponse } from "../../src/protocol/api.ts";
import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { rasterImageMediaTypeForPath, vectorImageMediaTypeForPath } from "../../src/protocol/types.ts";
import { formatDimensions, formatDuration, formatFileSize, formatFrameRate } from "./dom.ts";
import { pixelFormatText } from "./mediaDetails.ts";
import { type LutChoice, lookLabel, toggleLook } from "./videoLut.ts";

// Below this, in CSS pixels, the bars would cover most of the picture they
// describe, so the overlay stays off.
const HUD_MIN_WIDTH = 200;
const HUD_MIN_HEIGHT = 120;

/** An overlay holding `bars`, each a row of cells, hidden until shown. */
export function hudRoot(...bars: HTMLElement[][]): HTMLElement {
  const root = document.createElement("div");
  root.className = "media-hud";
  root.hidden = true;
  for (const cells of bars) {
    const bar = document.createElement("div");
    bar.className = "media-hud-bar";
    bar.append(...cells);
    root.append(bar);
  }
  return root;
}

export const hudCells = (count: number): HTMLSpanElement[] =>
  Array.from({ length: count }, () => document.createElement("span"));

export interface LookBadge {
  readonly element: HTMLButtonElement;
  /** Stops following the look every player shares. */
  dispose(): void;
}

/** A clip's LOOK badge (web/styles/media-panes.css): empty until a look has
 * been picked, then pressed while it is on, and a click turns it off and back
 * on. Out of the tab order, and a press leaves focus on the surface whose
 * keys turn it with D. */
export function lookBadge(choice: LutChoice): LookBadge {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "media-hud-badge";
  element.tabIndex = -1;
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", () => toggleLook(choice));
  const dispose = choice.subscribe(({ lut, on }) => {
    element.textContent = lut === null ? "" : "LOOK";
    if (lut === null) return;
    const name = lookLabel(lut);
    element.setAttribute("aria-label", `${name} look`);
    element.setAttribute("aria-pressed", String(on));
    element.dataset.tooltip = `${name} ${on ? "on, click to turn off" : "off, click to turn on"} (D)`;
  });
  return { element, dispose };
}

/** The box `media` and its `hud` share (web/styles/media-panes.css): it
 * hugs the media, and the bars cover it. */
export function mediaFrame(media: HTMLElement, hud: HTMLElement, className: string): HTMLDivElement {
  const frame = document.createElement("div");
  frame.className = `media-frame ${className}`;
  frame.append(media, hud);
  return frame;
}

/** Puts a vector image or a PNG on the checkerboard
 * (web/styles/media-panes.css), since either may be transparent: its clear
 * parts then read as clear, not as the pane's color, which hides white
 * artwork in the light theme.
 *
 * Only once the picture is decoded. Its box is sized before its pixels
 * arrive, so a board drawn sooner flashes there, and an opaque picture
 * shows it until painted over. A picture that never decodes gets none. */
export function showTransparency(img: HTMLImageElement, path: string): void {
  if (vectorImageMediaTypeForPath(path) === undefined && rasterImageMediaTypeForPath(path) !== "image/png") return;
  img.addEventListener("load", () => {
    img.decode().then(
      () => img.classList.add("shows-transparency"),
      () => {},
    );
  });
}

/** Whether a picture shown this size, in CSS pixels, has room for the bars.
 * Measuring decides only that; the bars' place is the frame's. */
export function hudFits(width: number, height: number): boolean {
  return width >= HUD_MIN_WIDTH && height >= HUD_MIN_HEIGHT;
}

/** Shows `hud` over media shown this size: its bars where they fit, and
 * otherwise nothing, or its ⋮ alone where it has one, so the file's menu
 * stays within reach on a picture of any size. */
export function fitHud(hud: HTMLElement, width: number, height: number): void {
  const fits = hudFits(width, height);
  const keepsMore = hud.querySelector(".media-hud-more") !== null;
  hud.hidden = !fits && !keepsMore;
  hud.classList.toggle("is-bare", !fits && keepsMore);
}

/** What a thumbnail's bars say of its file, each where it is known. */
export interface ThumbnailFacts {
  width?: number;
  height?: number;
  /** Bytes. */
  size?: number;
  /** Seconds, for a clip. */
  duration?: number;
  /** What a clip's header says, which gives its frame rate. */
  clip?: VideoFormatResponse;
  /** What a still's header says, which gives its color mode. */
  picture?: PictureDetails;
}

export interface ThumbnailHud {
  fill(facts: ThumbnailFacts): void;
  /** Whether the box is wide enough to show the bars at all. */
  shown(): boolean;
}

/** Hover bars on a thumbnail's own box (web/styles/thumbnail-hud.css): the
 * dimensions with their ratio, then a clip's frame rate or a still's color
 * mode, and the ratio alone for a narrow box, along the top; a clip's
 * duration and the size along the bottom. The box's width decides what they
 * hold. They repeat the Info tab, so assistive technology skips them. */
export function thumbnailHud(box: HTMLElement): ThumbnailHud {
  box.classList.add("thumbnail-box");
  const root = document.createElement("span");
  root.className = "thumbnail-hud";
  root.setAttribute("aria-hidden", "true");
  const [dimensions, format, ratio, duration, size] = hudCells(5);
  dimensions.className = "thumbnail-hud-dimensions";
  format.className = "thumbnail-hud-format";
  ratio.className = "thumbnail-hud-ratio";
  const bar = (edge: "top" | "bottom", ...cells: HTMLElement[]) => {
    const row = document.createElement("span");
    row.className = `thumbnail-hud-bar is-${edge}`;
    row.append(...cells);
    root.append(row);
    return row;
  };
  const top = bar("top", dimensions, format, ratio);
  const bottom = bar("bottom", duration, size);
  box.append(root);
  return {
    fill(facts) {
      const width = facts.width ?? 0;
      const height = facts.height ?? 0;
      const measured = width > 0 && height > 0;
      dimensions.textContent = measured ? formatDimensions(width, height, "") : "";
      const pixels = facts.picture?.pixels;
      format.textContent = facts.clip ? (formatFrameRate(facts.clip) ?? "") : pixels ? pixelFormatText(pixels) : "";
      ratio.textContent = measured ? formatAspectRatio(width, height) : "";
      duration.textContent = facts.duration === undefined ? "" : formatDuration(facts.duration);
      size.textContent = facts.size === undefined ? "" : formatFileSize(facts.size);
      top.hidden = !measured;
      bottom.hidden = facts.duration === undefined && facts.size === undefined;
    },
    shown: () => getComputedStyle(root).display !== "none",
  };
}
