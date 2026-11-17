// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../../web/lib/emitter.ts";
import { bindFrameStats } from "../../../web/lib/frameStats.ts";

// The page's frames, driven by hand: each call to frame() runs the callback
// waiting at that moment.
let waiting: ((now: number) => void) | undefined;
let seen: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
const frame = (now: number) => {
  const callback = waiting;
  waiting = undefined;
  callback?.(now);
};

beforeEach(() => {
  waiting = undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
    waiting = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    waiting = undefined;
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        seen = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a canvas's frame stats", () => {
  it("shows the rate and the longest gap of each half second, while on and on screen", () => {
    const readout = document.createElement("div");
    const on = new Emitter(true);
    bindFrameStats(readout, on);
    seen?.([{ isIntersecting: true }]);
    expect(readout.hidden).toBe(false);

    // 30 frames 16 ms apart, then one that took 52 ms: 31 in 532 ms.
    frame(1000);
    for (let i = 1; i <= 30; i++) frame(1000 + 16 * i);
    frame(1000 + 16 * 30 + 52);
    expect(readout.textContent).toBe("58 fps · 52 ms");
  });

  it("asks for no frames while switched off, and hides", () => {
    const readout = document.createElement("div");
    const on = new Emitter(false);
    bindFrameStats(readout, on);
    seen?.([{ isIntersecting: true }]);
    expect(readout.hidden).toBe(true);
    expect(waiting).toBeUndefined();

    on.set(true);
    expect(waiting).toBeDefined();
  });

  it("stops counting while off screen, and starts afresh when back", () => {
    const readout = document.createElement("div");
    const stats = bindFrameStats(readout, new Emitter(true));
    seen?.([{ isIntersecting: true }]);
    seen?.([{ isIntersecting: false }]);
    expect(waiting).toBeUndefined();

    seen?.([{ isIntersecting: true }]);
    expect(readout.textContent).toBe("-- fps · -- ms");
    stats.dispose();
    expect(waiting).toBeUndefined();
  });
});
