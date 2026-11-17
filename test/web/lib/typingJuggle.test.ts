// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUpJuggle } from "../../../web/lib/typingJuggle.ts";

const TOP_RATE = 1.4 / 1.2;

// Frames run by hand, each at the time a test gives it.
let frames: FrameRequestCallback[] = [];
function runFrame(now: number): void {
  const due = frames;
  frames = [];
  for (const frame of due) frame(now);
}

// Stand-ins for the dots' CSS animations, which jsdom doesn't run.
function dotsIn(thread: HTMLElement, runs: () => { playbackRate: number }[]): HTMLElement {
  const dots = document.createElement("div");
  thread.append(dots);
  dots.getAnimations = () => runs() as unknown as Animation[];
  return dots;
}
const arcOf = (dots: HTMLElement): number => Number(dots.style.getPropertyValue("--juggle-arc"));

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the typing dots' build-up", () => {
  it("quickens the loop and raises the throws over ten seconds, then holds", () => {
    const runs = [{ playbackRate: 1 }, { playbackRate: 1 }];
    const dots = dotsIn(document.createElement("div"), () => runs);
    buildUpJuggle(dots);

    runFrame(0);
    expect(runs.map((run) => run.playbackRate)).toEqual([1, 1]);
    expect(arcOf(dots)).toBe(1);

    runFrame(5000);
    expect(runs[0].playbackRate).toBeCloseTo(1 + (TOP_RATE - 1) / 2);
    expect(arcOf(dots)).toBeCloseTo(1.25);

    for (const now of [10_000, 60_000]) {
      runFrame(now);
      expect(runs.every((run) => Math.abs(run.playbackRate - TOP_RATE) < 1e-9)).toBe(true);
      expect(arcOf(dots)).toBeCloseTo(1.5);
    }
  });

  it("speeds up the animations that start when the dots show again", () => {
    let runs = [{ playbackRate: 1 }];
    const dots = dotsIn(document.createElement("div"), () => runs);
    buildUpJuggle(dots);
    runFrame(12_000);

    runs = [{ playbackRate: 1 }, { playbackRate: 1 }, { playbackRate: 1 }];
    runFrame(12_016);
    expect(runs.every((run) => Math.abs(run.playbackRate - TOP_RATE) < 1e-9)).toBe(true);
  });

  it("stops once the dots leave their thread", () => {
    const dots = dotsIn(document.createElement("div"), () => [{ playbackRate: 1 }]);
    buildUpJuggle(dots);
    runFrame(1000);
    expect(frames).toHaveLength(1);

    dots.remove();
    runFrame(2000);
    expect(frames).toHaveLength(0);
  });

  it("leaves the dots as they are under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
    const dots = dotsIn(document.createElement("div"), () => [{ playbackRate: 1 }]);
    buildUpJuggle(dots);
    expect(frames).toHaveLength(0);
    expect(dots.style.getPropertyValue("--juggle-arc")).toBe("");
  });
});
