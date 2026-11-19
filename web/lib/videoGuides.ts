// The guides a player or a still lays over its picture, as an editor's
// viewer does: frames cut from the picture's middle, each outlined and named
// by its ratio, a matte over what none of them shows, and the edge, safe
// areas and center mark of the area they all share. Drawn over the picture
// only; the file is never touched.
//
// The lines are one SVG drawn in the media's own pixels, its viewBox the
// media's size. An SVG fits its viewBox to its box as a video fits its
// picture, so the lines land on the picture at any size, letterboxed with it
// in full screen, with nothing measured.
//
// A ratio is text, which the SVG would scale with the picture, so the names
// lie in a box of the picture's shape fitted the same way, at one size.

/** A frame the guides cut from the middle of the picture. */
export type GuideFrame = "1:1" | "4:5" | "9:16" | "1.91:1" | "16:9" | "1.33" | "1.77" | "1.85" | "2.39";

export interface Guides {
  /** Off hides every guide and keeps the picks, for G to bring back. */
  shown: boolean;
  /** The frames cut from the picture, in the menu's order. With none the
   * guides keep the picture's own shape. */
  frames: readonly GuideFrame[];
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
  frames: [],
  extents: false,
  action: false,
  title: false,
  center: false,
  social: false,
};

export interface FrameChoice {
  id: GuideFrame;
  label: string;
  /** Width over height. */
  aspect: number;
}

// The frames, in the two rows the Guides menu shows them in, any number of
// them on at once.
export const SOCIAL_FRAMES: readonly FrameChoice[] = [
  { id: "1:1", label: "1:1", aspect: 1 },
  { id: "4:5", label: "4:5", aspect: 4 / 5 },
  { id: "9:16", label: "9:16", aspect: 9 / 16 },
  { id: "1.91:1", label: "1.91:1", aspect: 1.91 },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
];
export const FILM_FRAMES: readonly FrameChoice[] = [
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

/** Hides every guide or shows them again, keeping the picks: G's turn. */
export function toggleGuides(choice: GuidesChoice): void {
  const current = choice.get();
  choice.set({ ...current, shown: !current.shown });
}

export function frameAspect(frame: GuideFrame): number {
  return FRAMES.find((choice) => choice.id === frame)?.aspect ?? 0;
}

/** `frames` with `frame` turned on, or off where it was on, in the menu's
 * order. */
export function toggleFrame(frames: readonly GuideFrame[], frame: GuideFrame): GuideFrame[] {
  const on = !frames.includes(frame);
  return FRAMES.filter((choice) => (choice.id === frame ? on : frames.includes(choice.id))).map((choice) => choice.id);
}

/** Where every box of `boxes`, each cut from the middle of the same picture,
 * overlaps: the whole picture for none. */
export function sharedBox(width: number, height: number, boxes: readonly Box[]): Box {
  const shared = { x: 0, y: 0, width, height };
  for (const box of boxes) {
    if (box.width < shared.width) Object.assign(shared, { x: box.x, width: box.width });
    if (box.height < shared.height) Object.assign(shared, { y: box.y, height: box.height });
  }
  return shared;
}

const round = (value: number) => Math.round(value * 100) / 100;
const rect = (x0: number, y0: number, x1: number, y1: number) => `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;

/** The matte's path over what none of `boxes` shows, or nothing where one
 * of them is the whole picture or there are none. Frames cut from the middle
 * are full height or full width, so the widest of the one and the tallest
 * of the other hold all the rest, and what lies outside both is two bands,
 * or the four corners between them. */
export function matteOutside(width: number, height: number, boxes: readonly (Box & { cut: boolean })[]): string {
  if (boxes.length === 0 || boxes.some((box) => !box.cut)) return "";
  const tall = boxes.filter((box) => box.y === 0).reduce((widest, box) => Math.max(widest, box.width), 0);
  const wide = boxes.filter((box) => box.x === 0).reduce((tallest, box) => Math.max(tallest, box.height), 0);
  const left = round((width - tall) / 2);
  const top = round((height - wide) / 2);
  const [right, bottom] = [round(width - left), round(height - top)];
  if (!wide) return [rect(0, 0, left, height), rect(right, 0, width, height)].join(" ");
  if (!tall) return [rect(0, 0, width, top), rect(0, bottom, width, height)].join(" ");
  return [
    rect(0, 0, left, top),
    rect(right, 0, width, top),
    rect(0, bottom, left, height),
    rect(right, bottom, width, height),
  ].join(" ");
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
  const picked: unknown[] = Array.isArray(record.frames) ? record.frames : [];
  return {
    shown: flag("shown", true),
    frames: FRAMES.filter((choice) => picked.includes(choice.id)).map((choice) => choice.id),
    extents: flag("extents", false),
    action: flag("action", false),
    title: flag("title", false),
    center: flag("center", false),
    social: flag("social", false),
  };
}

export interface GuidesOverlay {
  /** The lines' SVG, and the ratios' box over it. */
  readonly element: HTMLElement;
  /** The media's size in pixels, once it is known. */
  setSize(width: number, height: number): void;
  dispose(): void;
}

const SVG = "http://www.w3.org/2000/svg";

export function createGuidesOverlay(guides: GuidesChoice): GuidesOverlay {
  const element = document.createElement("div");
  element.className = "video-guides";
  element.setAttribute("aria-hidden", "true");
  const lines = document.createElementNS(SVG, "svg");
  lines.setAttribute("class", "video-guides-lines");
  const names = document.createElement("div");
  names.className = "video-guides-names";
  element.append(lines, names);
  const shape = (tag: string, className: string) => {
    const node = document.createElementNS(SVG, tag);
    node.setAttribute("class", className);
    lines.append(node);
    return node;
  };
  const matte = shape("path", "video-guides-matte");
  const cuts = shape("g", "video-guides-cuts");
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
      current.frames.length > 0 ||
      current.extents ||
      current.action ||
      current.title ||
      current.center ||
      current.social;
    const visible = current.shown && any && width > 0 && height > 0;
    element.toggleAttribute("hidden", !visible);
    if (!visible) return;
    lines.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const boxes = current.frames.map((id) => ({ id, ...frameBox(width, height, frameAspect(id)) }));
    const path = matteOutside(width, height, boxes);
    matte.setAttribute("d", path);
    show(matte, path !== "");
    // A frame of the picture's own shape is its edge: no line, no name.
    const drawn = boxes.filter((box) => box.cut);
    cuts.replaceChildren(
      ...drawn.map((box) => {
        const outline = document.createElementNS(SVG, "rect");
        outline.setAttribute("class", "video-guides-line is-cut");
        place(outline, box);
        return outline;
      }),
    );
    names.style.setProperty("--guides-aspect", String(width / height));
    names.replaceChildren(
      ...drawn.map((box) => {
        const name = document.createElement("span");
        name.className = "video-guides-name";
        name.textContent = FRAMES.find((choice) => choice.id === box.id)?.label ?? box.id;
        name.style.left = `${(box.x / width) * 100}%`;
        name.style.top = `${(box.y / height) * 100}%`;
        return name;
      }),
    );
    const frame = sharedBox(width, height, boxes);
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
