// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweep } from "../../../web/lib/sweep.ts";

// Frames run by hand, each at the time a test gives it.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function runFrame(now: number): void {
  const due = [...frames.values()];
  frames = new Map();
  for (const frame of due) frame(now);
}

// jsdom has no ResizeObserver: a test resizes a box and reports it by hand.
let observers: { callback: ResizeObserverCallback; boxes: Set<Element> }[] = [];
class FakeResizeObserver {
  private readonly watch: { callback: ResizeObserverCallback; boxes: Set<Element> };
  constructor(callback: ResizeObserverCallback) {
    this.watch = { callback, boxes: new Set() };
    observers.push(this.watch);
  }
  observe(box: Element): void {
    this.watch.boxes.add(box);
  }
  unobserve(box: Element): void {
    this.watch.boxes.delete(box);
  }
  disconnect(): void {
    this.watch.boxes.clear();
  }
}
const watched = (box: Element) => observers.filter((watch) => watch.boxes.has(box));
function resize(box: HTMLElement, height: number): void {
  Object.defineProperty(box, "offsetHeight", { value: height, configurable: true });
  for (const watch of watched(box)) watch.callback([], watch as unknown as ResizeObserver);
}

// jsdom draws nothing, so each canvas gets a context that takes every call,
// counts its clears, and reads back a blank strip.
let clears = 0;
function stubCanvases(addColorStop: (offset: number, color: string) => void = () => {}): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const calls = () => {};
    return {
      canvas: this,
      scale: calls,
      clearRect: () => clears++,
      beginPath: calls,
      moveTo: calls,
      lineTo: calls,
      stroke: calls,
      fillRect: calls,
      createLinearGradient: () => ({ addColorStop }),
      getImageData: (_x: number, _y: number, width: number) => ({ data: new Uint8ClampedArray(width * 4) }),
    } as unknown as CanvasRenderingContext2D;
  });
}

// A 240 by 120 box with a 1px border and 8px corners, its colors given, at
// `scale` on screen.
function boxOf(colors: string, scale = 1): HTMLElement {
  const box = document.createElement("div");
  box.style.setProperty("--sweep-colors", colors);
  box.style.border = "1px solid";
  box.style.borderTopLeftRadius = "8px";
  Object.defineProperties(box, {
    offsetWidth: { value: 240, configurable: true },
    offsetHeight: { value: 120, configurable: true },
  });
  box.getBoundingClientRect = () => ({ width: 240 * scale }) as DOMRect;
  document.body.append(box);
  return box;
}

const canvasesOf = (box: HTMLElement) => [...box.querySelectorAll("canvas")];
const classesOf = (box: HTMLElement) => canvasesOf(box).map((canvas) => canvas.className);

beforeEach(() => {
  frames = new Map();
  observers = [];
  clears = 0;
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
    frames.set(nextFrame, frame);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.spyOn(performance, "now").mockReturnValue(0);
  stubCanvases();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the sweep", () => {
  it("plays once round the box, then leaves it as it was", () => {
    const box = boxOf("#cc004e, rgb(13, 177, 76)");
    sweep(box);
    expect(classesOf(box)).toEqual(["sweep-glow", "sweep-line"]);
    expect(box.firstElementChild?.className).toBe("sweep-glow");

    runFrame(500);
    expect(frames.size).toBe(1);
    runFrame(950);
    expect(classesOf(box)).toEqual([]);
    expect(frames.size).toBe(0);
    expect(watched(box)).toEqual([]);
  });

  it("hangs both canvases off the box's edge, the line as sharp as the box's scale on screen", () => {
    const box = boxOf("#cc004e", 2);
    sweep(box);
    const [glow, line] = canvasesOf(box);
    expect([glow.style.left, glow.style.top, glow.style.width, glow.style.height]).toEqual([
      "-31px",
      "-31px",
      "300px",
      "180px",
    ]);
    expect([glow.width, glow.height]).toEqual([300, 180]);
    expect([line.width, line.height]).toEqual([600, 360]);
  });

  it("keeps to the box's size as it grows mid-sweep, and paints it again at once", () => {
    const box = boxOf("#cc004e");
    sweep(box);
    runFrame(300);
    const painted = clears;

    resize(box, 200);
    const [glow, line] = canvasesOf(box);
    expect([glow.style.height, glow.height, line.height]).toEqual(["260px", 260, 260]);
    expect(clears).toBe(painted + 2);

    // The same size again draws nothing new.
    resize(box, 200);
    expect(clears).toBe(painted + 2);
  });

  it("starts over when the box is swept again while it plays", () => {
    const box = boxOf("#cc004e");
    sweep(box);
    vi.mocked(performance.now).mockReturnValue(700);
    runFrame(700);

    sweep(box);
    expect(classesOf(box)).toEqual(["sweep-glow", "sweep-line"]);
    expect(frames.size).toBe(1);
    expect(watched(box)).toHaveLength(1);
  });

  it("stops once the box leaves the page", () => {
    const box = boxOf("#cc004e");
    sweep(box);
    box.remove();
    runFrame(100);
    expect(classesOf(box)).toEqual([]);
    expect(frames.size).toBe(0);
    expect(watched(box)).toEqual([]);
  });

  it("leaves out a color the canvas can't read, rather than throw into the work it marks", () => {
    stubCanvases((_offset, color) => {
      if (color === "not-a-color") throw new SyntaxError("The value provided could not be parsed as a color.");
    });
    const box = boxOf("#cc004e, not-a-color");
    expect(() => sweep(box)).not.toThrow();
    expect(classesOf(box)).toEqual(["sweep-glow", "sweep-line"]);
  });

  it("plays nothing under reduced motion, round a box with no size, or with no colors listed", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
    const still = boxOf("#cc004e");
    sweep(still);
    vi.unstubAllGlobals();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const hidden = document.createElement("div");
    hidden.style.setProperty("--sweep-colors", "#cc004e");
    document.body.append(hidden);
    sweep(hidden);

    const bare = boxOf("");
    sweep(bare);

    for (const box of [still, hidden, bare]) expect(classesOf(box)).toEqual([]);
  });
});
