// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { formatFileSize } from "../../../web/lib/dom.ts";
import { fitHud, hudRoot, lookBadge, thumbnailHud } from "../../../web/lib/mediaHud.ts";
import { NO_LOOK } from "../../../web/lib/videoLut.ts";
import { memoryLook } from "../support/editorLayout.ts";

const bars = (box: HTMLElement) =>
  [...box.querySelectorAll<HTMLElement>(".thumbnail-hud-bar")].map((bar) =>
    bar.hidden ? "(hidden)" : [...bar.children].map((cell) => cell.textContent).join(" | "),
  );

describe("a thumbnail's hover bars", () => {
  it("lie last on the box they describe, which their size rule reads, unheard by assistive technology", () => {
    const box = document.createElement("div");
    box.append(document.createElement("img"));
    thumbnailHud(box);
    expect(box.classList.contains("thumbnail-box")).toBe(true);
    expect(box.lastElementChild?.classList.contains("thumbnail-hud")).toBe(true);
    expect(box.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  // The top bar's cells: the dimensions, a clip's frame rate, a still's
  // scale, then the ratio alone that a narrow box shows in their place.
  it("hide each bar while it has nothing to say, and fill as facts come", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    hud.fill({});
    expect(bars(box)).toEqual(["(hidden)", "(hidden)"]);

    hud.fill({ width: 1920, height: 1080 });
    expect(bars(box)).toEqual(["1920 × 1080 (16:9) |  |  | 16:9", "(hidden)"]);

    hud.fill({ width: 1920, height: 1080, duration: 7, size: 2048 });
    expect(bars(box)).toEqual(["1920 × 1080 (16:9) |  |  | 16:9", `0:07 | ${formatFileSize(2048)}`]);
  });

  it("put a clip's frame rate after its dimensions, where its header gives one, and never its codec", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    hud.fill({
      width: 1188,
      height: 2112,
      clip: { codec: "ProRes 4444 XQ", frameRate: 30_000 / 1001, variableFrameRate: false },
    });
    expect(bars(box)[0]).toBe("1188 × 2112 (9:16) | 29.97 fps |  | 9:16");

    hud.fill({ width: 1280, height: 720, clip: { codec: "VP9", frameRate: null, variableFrameRate: false } });
    expect(bars(box)[0]).toBe("1280 × 720 (16:9) |  |  | 16:9");
  });

  // jsdom lays nothing out: the box gets the inside a laid-out one has.
  const sized = (width: number, height: number) => {
    const box = document.createElement("div");
    Object.defineProperties(box, { clientWidth: { value: width }, clientHeight: { value: height } });
    return box;
  };

  // Contained whole, a picture is drawn at the box's width or its height,
  // whichever it reaches first, and a small one grows to fill it.
  it("put a still's scale after its dimensions, measured in its box when asked", () => {
    const wide = sized(300, 200);
    const hud = thumbnailHud(wide);
    hud.fill({ width: 3840, height: 2160 });
    expect(bars(wide)[0]).toBe("3840 × 2160 (16:9) |  |  | 16:9");
    hud.measure();
    expect(bars(wide)[0]).toBe("3840 × 2160 (16:9) |  | 8% | 16:9");

    const measured = (width: number, height: number) => {
      const box = sized(300, 200);
      const other = thumbnailHud(box);
      other.fill({ width, height });
      other.measure();
      return bars(box)[0];
    };
    expect(measured(1080, 1920)).toBe("1080 × 1920 (9:16) |  | 10% | 9:16");
    expect(measured(64, 64)).toBe("64 × 64 (1:1) |  | 313% | 1:1");
  });

  // A still loading under the pointer gets its facts while its bars are up.
  it("measure a still's facts that land after it was measured, at once", () => {
    const box = sized(300, 200);
    const hud = thumbnailHud(box);
    hud.fill({});
    hud.measure();
    hud.fill({ width: 3840, height: 2160 });
    expect(bars(box)[0]).toBe("3840 × 2160 (16:9) |  | 8% | 16:9");
  });

  it("call a picture that decoded to nothing unmeasured", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    hud.fill({ width: 0, height: 0, size: 10 });
    expect(bars(box)).toEqual(["(hidden)", ` | ${formatFileSize(10)}`]);
  });
});

// Over media too small for its bars, an overlay with a ⋮ keeps the ⋮ alone,
// and one without hides.
describe("fitHud", () => {
  it("shows the bars where they fit, the ⋮ alone where they don't, and nothing in an overlay with no ⋮", () => {
    const more = document.createElement("button");
    more.className = "media-hud-more";
    const withMore = hudRoot([document.createElement("span")], [more]);
    const facts = hudRoot([document.createElement("span")]);
    const state = (hud: HTMLElement) => [hud.hidden, hud.classList.contains("is-bare")];

    fitHud(withMore, 600, 400);
    fitHud(facts, 600, 400);
    expect([state(withMore), state(facts)]).toEqual([
      [false, false],
      [false, false],
    ]);
    fitHud(withMore, 120, 400);
    fitHud(facts, 600, 100);
    expect([state(withMore), state(facts)]).toEqual([
      [false, true],
      [true, false],
    ]);
  });
});

describe("a clip's LOOK badge", () => {
  it("stays empty until a look is picked, then reads LOOK, pressed while on, naming the look", () => {
    const look = memoryLook(NO_LOOK);
    const { element } = lookBadge(look);
    expect([element.type, element.className, element.tabIndex]).toEqual(["button", "media-hud-badge", -1]);
    expect(element.textContent).toBe("");

    look.set({ lut: "panchromatic", on: true });
    expect(element.textContent).toBe("LOOK");
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.getAttribute("aria-label")).toBe("Panchromatic look");
    expect(element.dataset.tooltip).toBe("Panchromatic on, click to turn off (D)");

    look.set({ lut: "orthochromatic", on: false });
    expect(element.getAttribute("aria-pressed")).toBe("false");
    expect(element.dataset.tooltip).toBe("Orthochromatic off, click to turn on (D)");
  });

  it("turns the look off and back on at each click, a press leaving focus where it was, until disposed", () => {
    const look = memoryLook({ lut: "panchromatic", on: true });
    const badge = lookBadge(look);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    badge.element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    badge.element.click();
    expect(look.get()).toEqual({ lut: "panchromatic", on: false });
    badge.element.click();
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });

    badge.dispose();
    look.set({ lut: "panchromatic", on: false });
    expect(badge.element.getAttribute("aria-pressed")).toBe("true");
  });
});
