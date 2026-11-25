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

// jsdom draws nothing, so each canvas gets a context that takes every call
// and reads back a blank strip.
function stubCanvases(addColorStop: (offset: number, color: string) => void = () => {}): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const calls = () => {};
    return {
      canvas: this,
      scale: calls,
      clearRect: calls,
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
  Object.defineProperties(box, { offsetWidth: { value: 240 }, offsetHeight: { value: 120 } });
  box.getBoundingClientRect = () => ({ width: 240 * scale }) as DOMRect;
  document.body.append(box);
  return box;
}

const canvasesOf = (box: HTMLElement) => [...box.querySelectorAll("canvas")].map((canvas) => canvas.className);

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
    frames.set(nextFrame, frame);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
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
  it("lights the box, fades on it, then leaves it as it was", () => {
    const box = boxOf("#cc004e, rgb(13, 177, 76)");
    sweep(box);
    expect(canvasesOf(box)).toEqual(["sweep-glow", "sweep-line"]);
    expect(box.firstElementChild?.className).toBe("sweep-glow");
    expect(box.dataset.sweep).toBe("lit");
    // The last 45% of the 950ms pass, in whole milliseconds.
    expect(box.style.getPropertyValue("--sweep-fade")).toMatch(/^\d+ms$/);
    expect(Number.parseFloat(box.style.getPropertyValue("--sweep-fade"))).toBeCloseTo(950 * 0.45, -1);

    runFrame(500);
    expect(box.dataset.sweep).toBe("lit");
    runFrame(560);
    expect(box.dataset.sweep).toBe("fading");

    runFrame(950);
    expect(canvasesOf(box)).toEqual([]);
    expect(box.dataset.sweep).toBeUndefined();
    expect(box.style.getPropertyValue("--sweep-fade")).toBe("");
    expect(frames.size).toBe(0);
  });

  it("hangs both canvases off the box's edge, the line as sharp as the box's scale on screen", () => {
    const box = boxOf("#cc004e", 2);
    sweep(box);
    const [glow, line] = box.querySelectorAll("canvas");
    expect([glow.style.left, glow.style.top, glow.style.width, glow.style.height]).toEqual([
      "-31px",
      "-31px",
      "300px",
      "180px",
    ]);
    expect([glow.width, glow.height]).toEqual([300, 180]);
    expect([line.width, line.height]).toEqual([600, 360]);
  });

  it("starts over when the box is swept again while it plays", () => {
    const box = boxOf("#cc004e");
    sweep(box);
    vi.mocked(performance.now).mockReturnValue(700);
    runFrame(700);
    expect(box.dataset.sweep).toBe("fading");

    sweep(box);
    expect(canvasesOf(box)).toEqual(["sweep-glow", "sweep-line"]);
    expect(box.dataset.sweep).toBe("lit");
    expect(frames.size).toBe(1);
  });

  it("stops once the box leaves the page", () => {
    const box = boxOf("#cc004e");
    sweep(box);
    box.remove();
    runFrame(100);
    expect(canvasesOf(box)).toEqual([]);
    expect(box.dataset.sweep).toBeUndefined();
    expect(frames.size).toBe(0);
  });

  it("leaves out a color the canvas can't read, rather than throw into the work it marks", () => {
    stubCanvases((_offset, color) => {
      if (color === "not-a-color") throw new SyntaxError("The value provided could not be parsed as a color.");
    });
    const box = boxOf("#cc004e, not-a-color");
    expect(() => sweep(box)).not.toThrow();
    expect(box.dataset.sweep).toBe("lit");
  });

  it("plays nothing under reduced motion, round a box with no size, or with no colors listed", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
    const still = boxOf("#cc004e");
    sweep(still);
    vi.unstubAllGlobals();

    const hidden = document.createElement("div");
    hidden.style.setProperty("--sweep-colors", "#cc004e");
    document.body.append(hidden);
    sweep(hidden);

    const bare = boxOf("");
    sweep(bare);

    for (const box of [still, hidden, bare]) {
      expect(canvasesOf(box)).toEqual([]);
      expect(box.dataset.sweep).toBeUndefined();
    }
  });
});
