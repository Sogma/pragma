// The guides a player or a still lays over its picture, as an editor's
// viewer does: frames cut from the picture's middle, each outlined and named
// by its ratio, a matte over what none of them shows, the edge, safe areas
// and center mark of the area they all share, and markers over the whole
// picture. Drawn over the picture only; the file is never touched.
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
  cross: boolean;
  level: boolean;
  /** The share of each frame kept around its framing, in whole percents up
   * to a quarter. */
  protection: number;
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
  cross: false,
  level: false,
  protection: 0,
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
const ACTION_SAFE = everySide(0.035);
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

export const MAX_PROTECTION = 0.25;

// From this protection, in whole percents, it is named inside the picture's
// top left corner. Below it, the dark band a frame of the picture's shape
// leaves there is too thin for the name on a picture fitted to its pane, so
// the outer frame's own name carries its framing's share of the cut instead.
const PROTECTION_IN_CORNER = 7;

/** The framing of a frame cut as `box`, shrunk inside it by `protection` of
 * its size: the cut holds the protection, so it never runs past the picture
 * as protection grown outward from the frame would. */
export function framingBox(box: Box, protection: number): Box {
  return insetBox(box, everySide(protection / 2));
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

function frameAspect(frame: GuideFrame): number {
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

// Sizes alone decide it: every box here is centered on the picture.
const holds = (outer: Box, inner: Box) => outer.width >= inner.width && outer.height >= inner.height;

/** The matte's path over what none of `boxes`, each centered on the
 * picture, shows: nothing where one of them is the whole picture or there
 * are none. Centered boxes overlap in a stepped cross, so what lies outside
 * them is a band down each side past the widest, and a strip above and
 * below each step, out to the next narrower one. */
export function matteOutside(width: number, height: number, boxes: readonly Box[]): string {
  // Widest first, each taller than the one before: a box another one is as
  // wide and as tall as lies inside it.
  const steps: Box[] = [];
  for (const box of [...boxes].sort((a, b) => b.width - a.width || b.height - a.height)) {
    if (box.height > (steps.at(-1)?.height ?? 0)) steps.push(box);
  }
  if (steps.length === 0) return "";
  const inset = (box: Box) => ({ left: round((width - box.width) / 2), top: round((height - box.height) / 2) });
  const shapes: string[] = [];
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 > x0 && y1 > y0) shapes.push(rect(x0, y0, x1, y1));
  };
  const side = inset(steps[0]).left;
  add(0, 0, side, height);
  add(round(width - side), 0, width, height);
  const lefts = steps.map((box, index) => {
    const { left, top } = inset(box);
    const next = steps[index + 1];
    return { x0: left, x1: next ? inset(next).left : round(width - left), top };
  });
  const rights = lefts
    .slice(0, -1)
    .reverse()
    .map(({ x0, x1, top }) => ({ x0: round(width - x1), x1: round(width - x0), top }));
  const columns = [...lefts, ...rights];
  for (const { x0, x1, top } of columns) add(x0, 0, x1, top);
  for (const { x0, x1, top } of columns) add(x0, round(height - top), x1, height);
  return shapes.join(" ");
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
    cross: flag("cross", false),
    level: flag("level", false),
    protection: storedProtection(record.protection),
  };
}

// In whole percents within its range; anything else keeps none.
function storedProtection(value: unknown): number {
  return typeof value === "number" && value >= 0 && value <= MAX_PROTECTION ? Math.round(value * 100) / 100 : 0;
}

// The cross's mark as measured on a 1920 by 1080 picture, scaled with the
// picture's shorter side: four bars from a small gap at the middle out to
// where the lines take over.
const CROSS_REACH = 32.5 / 1080;
const CROSS_GAP = 4.5 / 1080;
const CROSS_BAR = 7 / 1080;

/** The cross through the middle of a picture `width` by `height`: its lines
 * out to the picture's edges, the bars they stop short of, and the line's
 * way on through the bars. */
function crossPaths(width: number, height: number): { lines: string; bars: string; cut: string } {
  const side = Math.min(width, height);
  const [reach, gap, halfWidth] = [side * CROSS_REACH, side * CROSS_GAP, (side * CROSS_BAR) / 2];
  const [x, y] = [width / 2, height / 2];
  const [midX, midY] = [round(x), round(y)];
  const lines =
    `M${midX} 0V${round(y - reach)}M${midX} ${round(y + reach)}V${round(height)}` +
    `M0 ${midY}H${round(x - reach)}M${round(x + reach)} ${midY}H${round(width)}`;
  const bars = [
    rect(round(x - halfWidth), round(y - reach), round(x + halfWidth), round(y - gap)),
    rect(round(x - halfWidth), round(y + gap), round(x + halfWidth), round(y + reach)),
    rect(round(x - reach), round(y - halfWidth), round(x - gap), round(y + halfWidth)),
    rect(round(x + gap), round(y - halfWidth), round(x + reach), round(y + halfWidth)),
  ].join(" ");
  const cut = `M${midX} ${round(y - reach)}V${round(y + reach)}M${round(x - reach)} ${midY}H${round(x + reach)}`;
  return { lines, bars, cut };
}

// Ids are page-wide, so each overlay names its own mask: a second player's
// bars would otherwise take the first one's.
let overlayCount = 0;

// A camera's level display as measured on a 1920 by 1080 picture, in its
// pixels from the middle; drawn scaled with the picture's shorter side.
const LEVEL_DOTS = [
  [220.23, 59.01],
  [197.45, 114],
].flatMap(([x, y]) => [
  [-x, -y],
  [-x, y],
  [x, -y],
  [x, y],
]);
const LEVEL_MARKS: readonly { className: string; d: string }[] = [
  { className: "video-guides-level-horizon", d: "" },
  { className: "video-guides-level-ends", d: "M-260 0H-215M215 0H260" },
  {
    className: "video-guides-level-brackets",
    d: "M-269 -155V-195H-229M229 -195H269V-155M269 155V195H229M-229 195H-269V155",
  },
  { className: "video-guides-level-pitch", d: "M-110.5 -104H-98.5M-110.5 104H-98.5M98.5 -104H110.5M98.5 104H110.5" },
  { className: "video-guides-level-indicator", d: "M-111.5 0H-97.5M97.5 0H111.5" },
  {
    className: "video-guides-level-roll",
    d: "M-156.78 -147.98L-180.82 -172.02M-156.78 147.98L-180.82 172.02M156.78 -147.98L180.82 -172.02M156.78 147.98L180.82 172.02",
  },
  {
    className: "video-guides-level-dots",
    d: LEVEL_DOTS.map(([x, y]) => `M${round(x - 2.6)} ${y}a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0`).join(""),
  },
];
// The horizon runs from each edge of the picture to this far from the middle.
const LEVEL_GAP = 215;

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
  const shape = (tag: string, className: string, parent: Element = lines) => {
    const node = document.createElementNS(SVG, tag);
    node.setAttribute("class", className);
    parent.append(node);
    return node;
  };
  const matte = shape("path", "video-guides-matte");
  const cuts = shape("g", "video-guides-cuts");
  const extents = shape("rect", "video-guides-line is-extents");
  const action = shape("rect", "video-guides-line");
  const title = shape("rect", "video-guides-line");
  const center = shape("path", "video-guides-line");
  const social = shape("rect", "video-guides-line");
  const crossLines = shape("path", "video-guides-line is-cross");
  const crossBars = shape("path", "video-guides-cross-bars");
  // The cross's line runs on through its bars as a see-through slit: their
  // mask keeps them all but where the line passes.
  const crossMask = shape("mask", "video-guides-cross-mask", shape("defs", "video-guides-defs"));
  crossMask.id = `video-guides-cross-mask-${++overlayCount}`;
  const crossKeep = shape("path", "video-guides-cross-keep", crossMask);
  const crossCut = shape("path", "video-guides-cross-cut", crossMask);
  crossBars.setAttribute("mask", `url(#${crossMask.id})`);
  const level = shape("g", "video-guides-level");
  const [levelHorizon] = LEVEL_MARKS.map((mark) => {
    const node = shape("path", mark.className, level);
    if (mark.d) node.setAttribute("d", mark.d);
    return node;
  });
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
      current.social ||
      current.cross ||
      current.level ||
      current.protection > 0;
    const visible = current.shown && any && width > 0 && height > 0;
    element.toggleAttribute("hidden", !visible);
    if (!visible) return;
    lines.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const boxes = current.frames.map((id) => ({ id, ...frameBox(width, height, frameAspect(id)) }));
    // With no frame lit, the picture is the frame. Each frame's framing is
    // outlined and named, and the matte shades what no framing holds.
    const kept = current.protection;
    const whole = { x: 0, y: 0, width, height, cut: false };
    const frames: (Box & { id?: GuideFrame; cut: boolean })[] = boxes.length > 0 ? boxes : [whole];
    const framed = frames.map((box, index) => {
      // Protection is measured on the largest lit frame: one inside a larger
      // lit one, or an equal one lit before it, is not outer, and its cut
      // gets no line.
      const outer = !frames.some(
        (other, at) => at !== index && holds(other, box) && (at < index || !holds(box, other)),
      );
      return { ...box, framing: framingBox(box, kept), outer, outlinesCut: box.cut && kept > 0 && outer };
    });
    const path = matteOutside(
      width,
      height,
      framed.map((box) => box.framing),
    );
    matte.setAttribute("d", path);
    show(matte, path !== "");
    const drawn = framed.filter((box) => box.cut || kept > 0);
    const outline = (kind: string, box: Box) => {
      const node = document.createElementNS(SVG, "rect");
      node.setAttribute("class", `video-guides-line ${kind}`);
      place(node, box);
      return node;
    };
    cuts.replaceChildren(
      ...drawn.flatMap((box) => [
        ...(box.outlinesCut ? [outline("is-protection", box)] : []),
        outline("is-frame", box.framing),
      ]),
    );
    names.style.setProperty("--guides-aspect", String(width / height));
    const name = (text: string, corner: Box) => {
      const node = document.createElement("span");
      node.className = "video-guides-name";
      node.textContent = text;
      node.style.left = `${(corner.x / width) * 100}%`;
      node.style.top = `${(corner.y / height) * 100}%`;
      return node;
    };
    // The protection is named once: inside the picture's top left corner,
    // dark whenever protection is on, or, too thin there, after the first
    // outer frame's ratio as its framing's share.
    const percent = Math.round(kept * 100);
    const inCorner = percent >= PROTECTION_IN_CORNER;
    const shared = percent > 0 && !inCorner ? framed.find((box) => box.outer) : undefined;
    names.replaceChildren(
      ...drawn.flatMap((box) => {
        const own = box.id === undefined ? "" : (FRAMES.find((choice) => choice.id === box.id)?.label ?? box.id);
        const text = box === shared ? [own, `${100 - percent}%`].filter(Boolean).join(" ") : own;
        return text ? [name(text, box.framing)] : [];
      }),
      ...(inCorner ? [name(`${percent}%`, whole)] : []),
    );
    const frame = framingBox(sharedBox(width, height, boxes), kept);
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
    const cross = crossPaths(width, height);
    crossLines.setAttribute("d", cross.lines);
    show(crossLines, current.cross);
    crossBars.setAttribute("d", cross.bars);
    show(crossBars, current.cross);
    crossKeep.setAttribute("d", rect(0, 0, width, height));
    crossCut.setAttribute("d", cross.cut);
    const scale = Math.min(width, height) / 1080;
    level.setAttribute(
      "transform",
      `translate(${round(width / 2)} ${round(height / 2)}) scale(${Math.round(scale * 1e4) / 1e4})`,
    );
    const end = round(width / 2 / scale);
    levelHorizon.setAttribute("d", `M${-end} 0H${-LEVEL_GAP}M${LEVEL_GAP} 0H${end}`);
    show(level, current.level);
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
