// The light that marks a model's result arriving: it runs once round a box's
// edge, a sharp line over a blurred glow, in the colors sweep.css lists. It
// keeps to the box's size as it plays, so a box that grows as the result
// loads, as a card does when its picture comes in, is traced at its new size.
//
// Both canvases hang outside the box's edge: the box must be positioned and
// must let its overflow show.

const DURATION_MS = 950;
// Shares of the pass: the fade in, and where the fade out starts.
const FADE_IN = 0.08;
const FADE_AT = 0.55;
// Shares of the edge, clockwise from the top-left corner: how far the head
// goes, and how long its tail is.
const HEAD_END = 0.74;
const TAIL = 0.3;
// CSS pixels: room round the box for the glow and its blur (sweep.css), the
// edge each drawn segment covers, and the glow's and the line's widths.
const PAD = 30;
const STEP = 3;
const GLOW_WIDTH = 7;
const LINE_WIDTH = 2.2;
const COLOR_STEPS = 256;

// How far round the head is a share `t` into the pass: quick, then easing.
const reach = (t: number) => HEAD_END * (1 - (1 - t) ** 1.7);

const playing = new WeakMap<HTMLElement, () => void>();

/** Plays the sweep once round `box`, from the start if it is playing there. */
export function sweep(box: HTMLElement): void {
  playing.get(box)?.();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  if (!box.offsetWidth || !box.offsetHeight) return;
  const style = getComputedStyle(box);
  const colors = colorSteps(style.getPropertyValue("--sweep-colors"));
  const glow = colors && layer("sweep-glow");
  const line = glow && layer("sweep-line");
  if (!colors || !glow || !line) return;
  // The line at the box's scale on screen, so a zoomed canvas keeps it sharp;
  // the glow at a pixel per CSS pixel, which its blur hides.
  const layers = [
    { context: glow, lineWidth: GLOW_WIDTH, lineCap: "round", onScreen: false },
    { context: line, lineWidth: LINE_WIDTH, lineCap: "butt", onScreen: true },
  ] as const;

  // The edge as last measured, measured again when the box's size changes.
  let edge = { width: 0, height: 0, count: 0, points: new Float32Array(0), strokes: [] as string[] };
  // Placed from the box's padding edge, which sits inside its border.
  const offset = (border: string) => `${-PAD - (Number.parseFloat(border) || 0)}px`;
  const measure = (): boolean => {
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    if (!width || !height || (width === edge.width && height === edge.height)) return false;
    const radius = cornerRadius(style.borderTopLeftRadius, Math.min(width, height));
    // The line runs down the middle of the box's border.
    const points = edgePoints(width, height, radius, (Number.parseFloat(style.borderTopWidth) || 0) / 2);
    const count = points.length / 2 - 1;
    const strokes = Array.from({ length: count }, (_, i) => colors[Math.round((i / count) * (COLOR_STEPS - 1))]);
    edge = { width, height, count, points, strokes };
    const scale = (box.getBoundingClientRect().width / width) * (window.devicePixelRatio || 1);
    const place = `left: ${offset(style.borderLeftWidth)}; top: ${offset(style.borderTopWidth)}`;
    for (const { context, lineWidth, lineCap, onScreen } of layers) {
      const ratio = onScreen ? scale : 1;
      // Sizing a canvas clears it, its stroke and scale too.
      context.canvas.width = Math.round((width + 2 * PAD) * ratio);
      context.canvas.height = Math.round((height + 2 * PAD) * ratio);
      context.canvas.style.cssText = `${place}; width: ${width + 2 * PAD}px; height: ${height + 2 * PAD}px`;
      context.scale(ratio, ratio);
      context.lineWidth = lineWidth;
      context.lineCap = lineCap;
    }
    // Shown outside the box only, as though the glow shone from under it.
    const hole = roundedRect(PAD, PAD, width, height, radius);
    glow.canvas.style.clipPath = `path(evenodd, "M0 0H${width + 2 * PAD}V${height + 2 * PAD}H0Z${hole}")`;
    return true;
  };

  let progress = 0;
  const paint = (): void => {
    const { width, height, count, points, strokes } = edge;
    const alpha = Math.min(1, progress / FADE_IN, (1 - progress) / (1 - FADE_AT));
    const head = reach(progress) * count;
    const tail = Math.max(0, head - TAIL * count);
    for (const { context } of layers) {
      context.clearRect(0, 0, width + 2 * PAD, height + 2 * PAD);
      for (let i = Math.floor(tail); i <= head && i < count; i++) {
        // Brightest at the head, fading to nothing down the tail.
        context.globalAlpha = alpha * Math.max(0, (i - tail) / (head - tail || 1)) ** 1.3;
        context.strokeStyle = strokes[i];
        context.beginPath();
        context.moveTo(points[2 * i], points[2 * i + 1]);
        context.lineTo(points[2 * i + 2], points[2 * i + 3]);
        context.stroke();
      }
    }
  };

  // Painted again at once: the resize cleared the canvases, and this frame
  // paints before the next tick would draw them.
  const resized = new ResizeObserver(() => {
    if (measure()) paint();
  });
  let frame = 0;
  const stop = (): void => {
    cancelAnimationFrame(frame);
    resized.disconnect();
    glow.canvas.remove();
    line.canvas.remove();
    playing.delete(box);
  };
  const start = performance.now();
  const tick = (now: number): void => {
    // Gone with its box, or with the box's contents drawn afresh.
    if (!line.canvas.isConnected) {
      stop();
      return;
    }
    progress = Math.min(1, Math.max(0, (now - start) / DURATION_MS));
    paint();
    if (progress < 1) frame = requestAnimationFrame(tick);
    else stop();
  };
  measure();
  box.prepend(glow.canvas, line.canvas);
  resized.observe(box, { box: "border-box" });
  playing.set(box, stop);
  frame = requestAnimationFrame(tick);
}

function layer(className: string): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  return canvas.getContext("2d");
}

// A corner's radius in pixels, at most half the box's shorter side. A
// percentage is of that side, near enough for an edge.
function cornerRadius(corner: string, shorter: number): number {
  const value = Number.parseFloat(corner) || 0;
  return Math.min(corner.endsWith("%") ? (value * shorter) / 100 : value, shorter / 2);
}

// The colors along the edge in steps, for the last list read: it changes only
// with the theme. The canvas blends them, so any color it reads will do.
let cache: { list: string; colors: string[] } | undefined;

function colorSteps(list: string): string[] | undefined {
  if (cache?.list === list) return cache.colors;
  // Split at the commas outside a color's parentheses.
  const stops = list
    .split(/,(?![^(]*\))/)
    .map((color) => color.trim())
    .filter(Boolean);
  if (stops.length === 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = COLOR_STEPS;
  canvas.height = 1;
  const strip = canvas.getContext("2d", { willReadFrequently: true });
  if (!strip) return undefined;
  // Spread over the stretch the head crosses at full strength, so each color
  // shows at its brightest: the first holds before it, the last after.
  const from = reach(FADE_IN);
  const to = reach(FADE_AT);
  const gradient = strip.createLinearGradient(0, 0, COLOR_STEPS, 0);
  stops.forEach((color, index) => {
    try {
      gradient.addColorStop(from + ((to - from) * index) / Math.max(1, stops.length - 1), color);
    } catch {
      // A color the canvas can't read is left out: the sweep never throws into the work it marks.
    }
  });
  strip.fillStyle = gradient;
  strip.fillRect(0, 0, COLOR_STEPS, 1);
  const { data } = strip.getImageData(0, 0, COLOR_STEPS, 1);
  const colors = Array.from({ length: COLOR_STEPS }, (_, i) => `rgb(${data.subarray(4 * i, 4 * i + 3).join(" ")})`);
  cache = { list, colors };
  return colors;
}

// Points spaced evenly round the rounded rect `inset` into the box, clockwise
// from the top of its left side and back, shifted by PAD into the canvas.
function edgePoints(width: number, height: number, radius: number, inset: number): Float32Array<ArrayBuffer> {
  const bend = Math.max(0, radius - inset);
  const near = inset + bend;
  const centers = [
    [near, near],
    [width - near, near],
    [width - near, height - near],
    [near, height - near],
  ];
  // Each corner, then the side that leaves it along its last tangent.
  const pieces = centers.flatMap(([x, y], index) => {
    const from = Math.PI * (1 + index / 2);
    const to = from + Math.PI / 2;
    return [
      {
        length: (bend * Math.PI) / 2,
        point: (s: number) => {
          const angle = from + (bend ? s / bend : 0);
          return [x + bend * Math.cos(angle), y + bend * Math.sin(angle)];
        },
      },
      {
        length: Math.max(0, (index % 2 ? height : width) - 2 * near),
        point: (s: number) => [x + bend * Math.cos(to) - s * Math.sin(to), y + bend * Math.sin(to) + s * Math.cos(to)],
      },
    ];
  });
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const count = Math.max(4, Math.ceil(length / STEP));
  const points = new Float32Array(2 * (count + 1));
  let piece = 0;
  let start = 0;
  for (let i = 0; i < count; i++) {
    const along = (i / count) * length;
    while (piece < pieces.length - 1 && along > start + pieces[piece].length) start += pieces[piece++].length;
    const [x, y] = pieces[piece].point(along - start);
    points[2 * i] = PAD + x;
    points[2 * i + 1] = PAD + y;
  }
  points.copyWithin(2 * count, 0, 2);
  return points;
}

// A rounded rect as path data, clockwise from the end of its top-left corner.
function roundedRect(x: number, y: number, width: number, height: number, r: number): string {
  const arc = (toX: number, toY: number) => `A${r} ${r} 0 0 1 ${toX} ${toY}`;
  const right = x + width;
  const bottom = y + height;
  return `M${x + r} ${y}H${right - r}${arc(right, y + r)}V${bottom - r}${arc(right - r, bottom)}H${x + r}${arc(x, bottom - r)}V${y + r}${arc(x + r, y)}Z`;
}
