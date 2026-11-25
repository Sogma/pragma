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
import type { VideoFormatResponse } from "../../src/protocol/api.ts";
import { formatAspectRatio } from "../../src/protocol/aspectRatio.ts";
import { rasterImageMediaTypeForPath, vectorImageMediaTypeForPath } from "../../src/protocol/types.ts";
import { formatDimensions, formatDuration, formatFileSize, formatFrameRate } from "./dom.ts";
import { shownPercent } from "./pictureZoom.ts";
import { anyGuide, type GuidesChoice, toggleGuides } from "./videoGuides.ts";
import { type LutChoice, lookLabel, toggleLook } from "./videoLut.ts";

// Below this, in CSS pixels, the bars would cover most of the picture they
// describe, so the overlay stays off.
const HUD_MIN_WIDTH = 200;
const HUD_MIN_HEIGHT = 120;

// The least room, in CSS pixels, between the guides switch and a fact.
const SWITCH_CLEARANCE = 4;

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

/** Opens a badge's own menu at `at`, a right-click on the badge, which
 * stands for the menu while it shows; given no point, closes it. */
export type BadgeMenu = (anchor: HTMLElement, at?: { x: number; y: number }) => void;

// A click turns what the badge names, and a right-click opens its own menu
// ahead of the media's. The menu stays open through a press on the badge
// standing for it, where a press anywhere else closes it, so the click
// closes it before turning.
function pressBadge(element: HTMLButtonElement, turn: () => void, menu: BadgeMenu): void {
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", () => {
    if (element.getAttribute("aria-expanded") === "true") menu(element);
    turn();
  });
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    menu(element, { x: event.clientX, y: event.clientY });
  });
}

export interface LookBadge {
  readonly element: HTMLButtonElement;
  /** Stops following the look every player shares. */
  dispose(): void;
}

/** A clip's LOOK badge (web/styles/media-panes.css): empty until a look has
 * been picked, then pressed while it is on, and a click turns it off and back
 * on; a right-click opens `menu`, the looks. It names a look being tried, and
 * says when the kept look's file is missing. Out of the tab order, and a
 * press leaves focus on the surface whose keys turn it with D. */
export function lookBadge(choice: LutChoice, menu: BadgeMenu): LookBadge {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "media-hud-badge";
  element.tabIndex = -1;
  pressBadge(element, () => toggleLook(choice), menu);
  const dispose = choice.subscribe(({ lut, on }) => {
    const trying = choice.trying?.() ?? false;
    const missing = choice.missing?.() ?? false;
    const kept = choice.kept?.() ?? { lut, on };
    const named = trying ? lut : kept.lut;
    element.classList.toggle("is-missing", missing);
    element.textContent = named === null ? "" : "LOOK";
    // A viewer moved to a context with no look keeps no word of the last.
    if (named === null) {
      for (const name of ["aria-label", "aria-pressed", "data-tooltip"]) element.removeAttribute(name);
      return;
    }
    const name = lookLabel(named);
    element.setAttribute("aria-label", missing ? `${name} look, missing` : `${name} look`);
    element.setAttribute("aria-pressed", String(on));
    // The LUT's name in brackets, so a name that reads as words stays apart
    // from the hint around it.
    const tag = `[${name}]`;
    element.dataset.tooltip = trying
      ? `Trying ${tag}`
      : missing
        ? `${tag}'s file is missing, so the picture shows no look`
        : `${tag} ${kept.on ? "on, click to turn off" : "off, click to turn on"} (D)`;
  });
  return { element, dispose };
}

export interface GuidesSwitch {
  readonly element: HTMLButtonElement;
  /** Stops following the guides it turns. */
  dispose(): void;
}

/** The guides' switch (web/styles/media-hud-badges.css): hidden until a
 * guide is picked, then drawn as the ⋮ is, muted while the guides are
 * hidden. A click hides or shows them, keeping the picks; a right-click
 * opens `menu`, the guides to pick. Out of the tab order, and a press leaves
 * focus on the surface whose keys turn it with G. */
export function guidesSwitch(choice: GuidesChoice, menu: BadgeMenu): GuidesSwitch {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "icon-button media-hud-guides";
  element.tabIndex = -1;
  element.setAttribute("aria-label", "Guides");
  pressBadge(element, () => toggleGuides(choice), menu);
  const dispose = choice.subscribe((guides) => {
    element.hidden = !anyGuide(guides);
    element.setAttribute("aria-pressed", String(guides.shown));
    element.dataset.tooltip = `Guides ${guides.shown ? "on, click to turn off" : "off, click to turn on"} (G)`;
    fitGuidesSwitch(element);
  });
  return { element, dispose };
}

/** A top bar's cell for how the media is shown: the guides switch, then the
 * LOOK badge where a look can apply. The cell is as wide as the badge, so
 * the bar keeps LOOK on the media's centre (web/styles/media-hud-badges.css). */
export function hudBadges(guides: HTMLElement, look?: HTMLElement): HTMLSpanElement {
  const cell = document.createElement("span");
  cell.className = "media-hud-badges";
  cell.append(guides, ...(look ? [look] : []));
  return cell;
}

// The nearest fact beside `cell` the bar shows, toward `side`.
function shownFact(cell: Element, side: "previous" | "next"): Element | null {
  let fact = side === "previous" ? cell.previousElementSibling : cell.nextElementSibling;
  while (fact && fact.getClientRects().length === 0) {
    fact = side === "previous" ? fact.previousElementSibling : fact.nextElementSibling;
  }
  return fact;
}

// Where a fact's text is drawn. Never its own box: a bar's grid stretches
// that across the fact's column, up to the badges' cell.
function drawnBox(fact: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(fact);
  const drawn = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : undefined;
  return drawn && drawn.width > 0 ? drawn : fact.getBoundingClientRect();
}

// Hides the guides switch while it would touch a fact beside its cell. It
// hangs outside the bar's flow, beside LOOK or over the bar's middle, so the
// bar itself never keeps them apart. Measuring decides only that.
function fitGuidesSwitch(element: HTMLElement): void {
  element.classList.remove("is-cramped");
  const cell = element.parentElement;
  const box = element.getBoundingClientRect();
  if (!cell || box.width === 0) return; // hidden, or not laid out
  const previous = shownFact(cell, "previous");
  const next = shownFact(cell, "next");
  const before = previous ? drawnBox(previous) : undefined;
  const after = next ? drawnBox(next) : undefined;
  const cramped =
    (before !== undefined && box.left < before.right + SWITCH_CLEARANCE) ||
    (after !== undefined && box.right > after.left - SWITCH_CLEARANCE);
  element.classList.toggle("is-cramped", cramped);
}

/** Opens the shown media's menu through `open`: at a right-click on the
 * `media` itself, or at the middle of its part in view for the menu key on
 * `surface`, which holds focus for its keys. One on what takes the pointer
 * around or over it (its mat, a bar in a band, a player's controls) is left
 * to the surface's own menus. Returns the removal. */
export function mediaMenuOn(
  surface: HTMLElement,
  media: () => HTMLElement | undefined,
  open: (at: { x: number; y: number }) => void,
): () => void {
  const onMenu = (event: MouseEvent) => {
    const shown = media();
    if (!shown || event.defaultPrevented) return;
    // A key's right-click lands on what has focus, with no button pressed.
    const fromKey = event.target === surface && event.button !== 2;
    if (!fromKey && event.target !== shown) return;
    event.preventDefault();
    event.stopPropagation();
    open(fromKey ? middleInView(shown, surface) : { x: event.clientX, y: event.clientY });
  };
  surface.addEventListener("contextmenu", onMenu);
  return () => surface.removeEventListener("contextmenu", onMenu);
}

// Zoomed, a picture runs past the pane, so its own middle can lie out of
// sight: the middle of the part `surface` shows, else of the whole.
function middleInView(media: HTMLElement, surface: HTMLElement): { x: number; y: number } {
  const box = media.getBoundingClientRect();
  const room = surface.getBoundingClientRect();
  const left = Math.max(box.left, room.left);
  const right = Math.min(box.right, room.right);
  const top = Math.max(box.top, room.top);
  const bottom = Math.min(box.bottom, room.bottom);
  if (right <= left || bottom <= top) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
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

/** The scale a picture of `width` × `height` pixels is drawn at, contained
 * whole in `box`: at the box's width or its height, whichever it reaches
 * first. A whole percent, empty until both sizes are known. */
export function containedScale(box: HTMLElement, width: number, height: number): string {
  const drawn = width > 0 && height > 0 ? Math.min(box.clientWidth, (box.clientHeight * width) / height) : 0;
  return drawn > 0 ? `${shownPercent(drawn, width)}%` : "";
}

/** Whether a picture shown this size, in CSS pixels, has room for the bars.
 * Measuring decides only that; the bars' place is the frame's. */
function hudFits(width: number, height: number): boolean {
  return width >= HUD_MIN_WIDTH && height >= HUD_MIN_HEIGHT;
}

/** Shows `hud` over media shown this size: its bars where they fit, and
 * otherwise nothing, or its ⋮ alone where it has one, so the file's menu
 * stays within reach on a picture of any size. Its facts are filled first:
 * the guides switch is fitted between them. */
export function fitHud(hud: HTMLElement, width: number, height: number): void {
  const fits = hudFits(width, height);
  const keepsMore = hud.querySelector(".media-hud-more") !== null;
  hud.hidden = !fits && !keepsMore;
  hud.classList.toggle("is-bare", !fits && keepsMore);
  for (const toggle of hud.querySelectorAll<HTMLElement>(".media-hud-guides")) fitGuidesSwitch(toggle);
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
}

export interface ThumbnailHud {
  fill(facts: ThumbnailFacts): void;
  /** Shows the scale the picture is drawn at in its box. The box follows its
   * pane's size, so the hover that shows the bars calls this. */
  measure(): void;
  /** Whether the box is wide enough to show the bars at all. */
  shown(): boolean;
}

/** Hover bars on a thumbnail's own box (web/styles/thumbnail-hud.css): the
 * dimensions with their ratio, then the display scale, and the ratio alone
 * for a narrow box, along the top; a clip's length and frame rate, then the
 * size, along the bottom. The box's width decides what they hold. They
 * repeat the Info tab, so assistive technology skips them. */
export function thumbnailHud(box: HTMLElement): ThumbnailHud {
  box.classList.add("thumbnail-box");
  const root = document.createElement("span");
  root.className = "thumbnail-hud";
  root.setAttribute("aria-hidden", "true");
  const [dimensions, scale, ratio, clip, duration, rate, size] = hudCells(7);
  dimensions.className = "thumbnail-hud-dimensions";
  scale.className = "thumbnail-hud-scale";
  ratio.className = "thumbnail-hud-ratio";
  clip.className = "thumbnail-hud-clip";
  rate.className = "thumbnail-hud-rate";
  clip.append(duration, rate);
  const bar = (edge: "top" | "bottom", ...cells: HTMLElement[]) => {
    const row = document.createElement("span");
    row.className = `thumbnail-hud-bar is-${edge}`;
    row.append(...cells);
    root.append(row);
    return row;
  };
  const top = bar("top", dimensions, scale, ratio);
  const bottom = bar("bottom", clip, size);
  box.append(root);
  let width = 0;
  let height = 0;
  // Once the picture has been measured, facts that arrive later, while its
  // bars may be up, are measured at once rather than at the next hover.
  let scaled = false;
  // Every thumbnail box with room for the bars contains its picture whole.
  const measure = () => {
    scaled = true;
    scale.textContent = containedScale(box, width, height);
  };
  return {
    fill(facts) {
      width = facts.width ?? 0;
      height = facts.height ?? 0;
      const measured = width > 0 && height > 0;
      dimensions.textContent = measured ? formatDimensions(width, height, "") : "";
      if (scaled) measure();
      ratio.textContent = measured ? formatAspectRatio(width, height) : "";
      duration.textContent = facts.duration === undefined ? "" : formatDuration(facts.duration);
      rate.textContent = facts.clip ? (formatFrameRate(facts.clip) ?? "") : "";
      size.textContent = facts.size === undefined ? "" : formatFileSize(facts.size);
      top.hidden = !measured;
      bottom.hidden = !duration.textContent && !rate.textContent && !size.textContent;
    },
    measure,
    shown: () => getComputedStyle(root).display !== "none",
  };
}
