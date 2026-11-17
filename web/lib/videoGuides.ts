// The guides a video player lays over its picture, as an editor's viewer
// does: a frame cut from the picture's middle, outlined, with a matte
// outside it, and the frame's edge, safe areas and center mark inside it.
// Drawn over the picture only; the file is never touched.
//
// One SVG drawn in the clip's own pixels, its viewBox the clip's size. An
// SVG fits its viewBox to its box as a video fits its picture, so the lines
// land on the picture at any size, letterboxed with it in full screen, with
// nothing measured.

export type GuideFrame = "default" | "1:1" | "4:5" | "9:16" | "1.91:1" | "16:9" | "1.33" | "1.77" | "1.85" | "2.39";

export interface Guides {
  /** Off hides every guide and keeps the picks, for G to bring back. */
  shown: boolean;
  frame: GuideFrame;
  extents: boolean;
  action: boolean;
  title: boolean;
  center: boolean;
  social: boolean;
}

/** The guides every player shares: changed in one, they change in all. */
export interface GuidesChoice {
  get(): Guides;
  set(guides: Guides): void;
  subscribe(listener: (guides: Guides) => void): () => void;
}

export const NO_GUIDES: Guides = {
  shown: true,
  frame: "default",
  extents: false,
  action: false,
  title: false,
  center: false,
  social: false,
};

export interface FrameChoice {
  id: GuideFrame;
  label: string;
  /** Width over height; 0 for the clip's own. */
  aspect: number;
}

// The frames, in the two rows the Guides menu shows them in. A pick is one
// frame of either row.
export const SOCIAL_FRAMES: readonly FrameChoice[] = [
  { id: "1:1", label: "1:1", aspect: 1 },
  { id: "4:5", label: "4:5", aspect: 4 / 5 },
  { id: "9:16", label: "9:16", aspect: 9 / 16 },
  { id: "1.91:1", label: "1.91:1", aspect: 1.91 },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
];
export const FILM_FRAMES: readonly FrameChoice[] = [
  { id: "default", label: "Default", aspect: 0 },
  { id: "1.33", label: "1.33", aspect: 4 / 3 },
  { id: "1.77", label: "1.77", aspect: 16 / 9 },
  { id: "1.85", label: "1.85", aspect: 1.85 },
  { id: "2.39", label: "2.39", aspect: 2.39 },
];
const FRAMES = [...SOCIAL_FRAMES, ...FILM_FRAMES];

/** The share of a frame's size a safe area leaves out on each side. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const everySide = (share: number): Insets => ({ top: share, right: share, bottom: share, left: share });

// HD's safe areas (SMPTE ST 2046-1): action within 93% of the frame, titles
// within 90%, as a share cut from each side.
export const ACTION_SAFE = everySide(0.035);
export const TITLE_SAFE = everySide(0.05);
// Clear of what a vertical feed lays over the video: its tabs along the top,
// its buttons down the right, its caption along the bottom.
export const SOCIAL_SAFE: Insets = { top: 0.2, right: 0.17, bottom: 0.35, left: 0.05 };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The widest box of shape `aspect` cut from the middle of a picture
 * `width` by `height`, or the whole picture for its own shape. */
export function frameBox(width: number, height: number, aspect: number): Box & { cut: boolean } {
  const whole = { x: 0, y: 0, width, height, cut: false };
  if (!aspect || !width || !height) return whole;
  const own = width / height;
  // Within a hair of the clip's own shape, a matte would be a stray line.
  if (Math.abs(aspect - own) / own < 0.01) return whole;
  if (aspect < own) {
    const cutWidth = height * aspect;
    return { x: (width - cutWidth) / 2, y: 0, width: cutWidth, height, cut: true };
  }
  const cutHeight = width / aspect;
  return { x: 0, y: (height - cutHeight) / 2, width, height: cutHeight, cut: true };
}

/** `box` with each side's share of its size taken from that side. */
export function insetBox(box: Box, insets: Insets): Box {
  return {
    x: box.x + box.width * insets.left,
    y: box.y + box.height * insets.top,
    width: box.width * (1 - (insets.left + insets.right)),
    height: box.height * (1 - (insets.top + insets.bottom)),
  };
}

export function frameAspect(frame: GuideFrame): number {
  return FRAMES.find((choice) => choice.id === frame)?.aspect ?? 0;
}

/** Guides read back from storage, where anything missing or unknown reads
 * as no guide. */
export function readGuides(stored: string | null): Guides {
  let value: unknown;
  try {
    value = stored ? JSON.parse(stored) : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null) return NO_GUIDES;
  const record = value as Record<string, unknown>;
  const flag = (key: keyof Guides, fallback: boolean) =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : fallback;
  const frame = FRAMES.find((choice) => choice.id === record.frame)?.id ?? "default";
  return {
    shown: flag("shown", true),
    frame,
    extents: flag("extents", false),
    action: flag("action", false),
    title: flag("title", false),
    center: flag("center", false),
    social: flag("social", false),
  };
}

export interface GuidesOverlay {
  readonly element: SVGSVGElement;
  /** The clip's size in pixels, once its header names it. */
  setSize(width: number, height: number): void;
  dispose(): void;
}

const SVG = "http://www.w3.org/2000/svg";
const round = (value: number) => Math.round(value * 100) / 100;

export function createGuidesOverlay(guides: GuidesChoice): GuidesOverlay {
  const element = document.createElementNS(SVG, "svg");
  element.setAttribute("class", "video-guides");
  element.setAttribute("aria-hidden", "true");
  const shape = (tag: string, className: string) => {
    const node = document.createElementNS(SVG, tag);
    node.setAttribute("class", className);
    element.append(node);
    return node;
  };
  const matte = shape("path", "video-guides-matte");
  const cut = shape("rect", "video-guides-line is-cut");
  const extents = shape("rect", "video-guides-line is-extents");
  const action = shape("rect", "video-guides-line");
  const title = shape("rect", "video-guides-line");
  const center = shape("path", "video-guides-line");
  const social = shape("rect", "video-guides-line");
  let width = 0;
  let height = 0;

  const show = (node: SVGElement, on: boolean) => node.setAttribute("display", on ? "inline" : "none");
  const place = (node: SVGElement, box: Box) => {
    node.setAttribute("x", String(round(box.x)));
    node.setAttribute("y", String(round(box.y)));
    node.setAttribute("width", String(round(box.width)));
    node.setAttribute("height", String(round(box.height)));
  };

  function draw(): void {
    const current = guides.get();
    const any =
      current.frame !== "default" ||
      current.extents ||
      current.action ||
      current.title ||
      current.center ||
      current.social;
    const visible = current.shown && any && width > 0 && height > 0;
    element.toggleAttribute("hidden", !visible);
    if (!visible) return;
    element.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const frame = frameBox(width, height, frameAspect(current.frame));
    const [left, top] = [round(frame.x), round(frame.y)];
    const [right, bottom] = [round(frame.x + frame.width), round(frame.y + frame.height)];
    // The picture with the frame cut out of it, which even-odd filling leaves clear.
    matte.setAttribute("d", `M0 0H${width}V${height}H0Z M${left} ${top}V${bottom}H${right}V${top}Z`);
    show(matte, frame.cut);
    place(cut, frame);
    show(cut, frame.cut);
    place(extents, frame);
    show(extents, current.extents);
    place(action, insetBox(frame, ACTION_SAFE));
    show(action, current.action);
    place(title, insetBox(frame, TITLE_SAFE));
    show(title, current.title);
    const arm = Math.min(frame.width, frame.height) * 0.035;
    const [x, y] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    center.setAttribute(
      "d",
      `M${round(x - arm)} ${round(y)}H${round(x + arm)}M${round(x)} ${round(y - arm)}V${round(y + arm)}`,
    );
    show(center, current.center);
    place(social, insetBox(frame, SOCIAL_SAFE));
    show(social, current.social);
  }

  const unsubscribe = guides.subscribe(draw);
  return {
    element,
    setSize(clipWidth, clipHeight) {
      width = clipWidth;
      height = clipHeight;
      draw();
    },
    dispose: unsubscribe,
  };
}
