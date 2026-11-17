// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJoinWatch,
  createNeckGlows,
  type MarkFrame,
  markFrame,
  mountAnimatedMark,
} from "../../../web/view/animatedMark.ts";

const MID = 919 / 2;

function* samples(): Generator<[number, number, number, number]> {
  for (let t = 0; t < 600; t += 0.37) {
    const { circles } = markFrame(t);
    for (let i = 0; i < circles.length; i += 4) yield [circles[i], circles[i + 1], circles[i + 2], circles[i + 3]];
  }
}

describe("markFrame", () => {
  it("starts on the logo's own pose and eases into motion", () => {
    const rest = markFrame(0);
    expect(rest.circles[0]).toBeCloseTo(710, 0);
    expect(rest.circles[1]).toBeCloseTo(207, 0);
    expect(rest.circles[2]).toBeCloseTo(81, 0);
    expect(rest.join).toBe(30);
    expect(markFrame(10).join).toBe(60);
  });

  it("never lets a circle reach into the other half", () => {
    for (const [x, , r, side] of samples()) {
      if (side === 0) expect(x - r).toBeGreaterThan(MID);
      else expect(x + r).toBeLessThan(MID);
    }
  });

  it("keeps every circle inside the mark", () => {
    for (const [x, y, r] of samples()) expect(Math.hypot(x - MID, y - MID) + r).toBeLessThanOrEqual(459 + 1e-3);
  });
});

/** Circles as [x, y, r, half], packed the way markFrame packs them. */
const frame = (join: number, ...circles: number[][]): MarkFrame => ({
  circles: new Float32Array(circles.flat()),
  join,
});

describe("createJoinWatch", () => {
  // At a join reach of 60, two circles bridge once their gap is under 30.
  const pair = (gap: number): MarkFrame => frame(60, [100, 100, 50, 0], [200 + gap, 100, 50, 0]);

  it("reports two blobs meeting once, when their gap closes", () => {
    const watch = createJoinWatch();
    expect(watch(pair(40))).toEqual([]);
    expect(watch(pair(25))).toEqual([{ a: 0, b: 1, blob: 0b11 }]);
    expect(watch(pair(20))).toEqual([]);
  });

  it("takes the first frame as it finds it", () => {
    expect(createJoinWatch()(pair(25))).toEqual([]);
  });

  it("joins a pair hovering at the reach only once", () => {
    const watch = createJoinWatch();
    expect([40, 25, 32, 25, 34, 25].map((gap) => watch(pair(gap)).length)).toEqual([0, 1, 0, 0, 0, 1]);
  });

  it("never joins circles across the midline", () => {
    const watch = createJoinWatch();
    watch(frame(60, [100, 100, 50, 0], [240, 100, 50, 1]));
    expect(watch(frame(60, [100, 100, 50, 0], [210, 100, 50, 1]))).toEqual([]);
  });

  it("counts a bridge inside one blob as a loop, not a join", () => {
    const watch = createJoinWatch();
    watch(frame(60, [100, 100, 50, 0], [220, 100, 50, 0], [340, 100, 50, 0]));
    expect(watch(frame(60, [100, 100, 50, 0], [220, 100, 50, 0], [160, 190, 50, 0]))).toEqual([]);
  });

  it("reports two blobs meeting in two places as one join", () => {
    const watch = createJoinWatch();
    watch(frame(60, [100, 100, 50, 0], [100, 220, 50, 0], [240, 100, 50, 0], [240, 220, 50, 0]));
    const joins = watch(frame(60, [100, 100, 50, 0], [100, 220, 50, 0], [220, 100, 50, 0], [220, 220, 50, 0]));
    expect(joins).toEqual([{ a: 0, b: 2, blob: 0b1111 }]);
  });
});

describe("createNeckGlows", () => {
  const apart = frame(60, [100, 100, 50, 0], [240, 100, 50, 0]);
  const met = frame(60, [100, 100, 50, 0], [225, 100, 50, 0]);
  /** Animation time `ms` of real time past t = 10, at 3.5 animation seconds a second. */
  const atMs = (ms: number): number => 10 + (ms / 1000) * 3.5;

  it("lights a join's neck a beat after it, then fades it out", () => {
    const glows = createNeckGlows();
    glows(apart, atMs(-20));
    expect(glows(met, atMs(0)).lights[2]).toBe(0);
    expect(glows(met, atMs(90)).lights[2]).toBe(0);
    const peak = glows(met, atMs(150));
    expect(peak.lights[0]).toBeCloseTo(162.5);
    expect(peak.lights[1]).toBeCloseTo(100);
    expect(peak.lights[2]).toBeCloseTo(3);
    expect(peak.blobs[0]).toBe(0b11);
    const fading = glows(met, atMs(600)).lights[2];
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    expect(glows(met, atMs(1300)).lights[2]).toBe(0);
  });

  it("follows the neck as the circles drift", () => {
    const glows = createNeckGlows();
    glows(apart, atMs(-20));
    glows(met, atMs(0));
    expect(glows(frame(60, [100, 100, 50, 0], [215, 100, 50, 0]), atMs(150)).lights[0]).toBeCloseTo(157.5);
  });

  it("leaves a join dark while the mark eases in as it opens", () => {
    const glows = createNeckGlows();
    glows(apart, 0.2);
    glows(met, 0.3);
    for (const ms of [150, 400]) expect(glows(met, 0.3 + (ms / 1000) * 3.5).lights[2]).toBe(0);
  });

  it("leaves a join within 450 ms of the last glowing one dark", () => {
    const glows = createNeckGlows();
    // Three pairs of circles a row apart, each closing on its own.
    const rows = (...gaps: number[]): MarkFrame =>
      frame(
        60,
        ...gaps.flatMap((gap, row) => [
          [100, 100 + 200 * row, 50, 0],
          [200 + gap, 100 + 200 * row, 50, 0],
        ]),
      );
    glows(rows(40, 40, 40), atMs(-20));
    glows(rows(25, 40, 40), atMs(0));
    glows(rows(25, 25, 40), atMs(300));
    glows(rows(25, 25, 25), atMs(500));
    const { lights } = glows(rows(25, 25, 25), atMs(650));
    const lit = [0, 1, 2].filter((slot) => lights[slot * 3 + 2] > 0).map((slot) => lights[slot * 3 + 1]);
    expect(lit).toEqual([500, 100]);
  });
});

describe("mountAnimatedMark", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(reduced: boolean) {
    let report: (visible: boolean) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          report = (visible) => callback([{ isIntersecting: visible }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const row = document.createElement("div");
    const still = document.createElement("img");
    row.append(still);
    const mark = mountAnimatedMark(still);
    return { row, still, getContext, mark, show: () => report(true) };
  }

  it("leaves the official logo up when WebGL2 is unavailable", () => {
    const { row, still, getContext, show } = setup(false);
    show();
    expect(getContext).toHaveBeenCalledWith("webgl2", expect.anything());
    expect(still.hidden).toBe(false);
    expect(row.querySelector("canvas")).toBeNull();
  });

  it("never starts under reduced motion", () => {
    const { row, still, getContext, show } = setup(true);
    show();
    expect(getContext).not.toHaveBeenCalled();
    expect(still.hidden).toBe(false);
    expect(row.querySelector("canvas")).toBeNull();
  });
});
