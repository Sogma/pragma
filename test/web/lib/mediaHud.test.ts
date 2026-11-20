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

  // The top bar's cells: the dimensions, a clip's frame rate, then the ratio
  // alone that a narrow box shows in their place.
  it("hide each bar while it has nothing to say, and fill as facts come", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    hud.fill({});
    expect(bars(box)).toEqual(["(hidden)", "(hidden)"]);

    hud.fill({ width: 1920, height: 1080 });
    expect(bars(box)).toEqual(["1920 × 1080 (16:9) |  | 16:9", "(hidden)"]);

    hud.fill({ width: 1920, height: 1080, duration: 7, size: 2048 });
    expect(bars(box)).toEqual(["1920 × 1080 (16:9) |  | 16:9", `0:07 | ${formatFileSize(2048)}`]);
  });

  it("put a clip's frame rate after its dimensions, where its header gives one, and never its codec", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    hud.fill({
      width: 1188,
      height: 2112,
      clip: { codec: "ProRes 4444 XQ", frameRate: 30_000 / 1001, variableFrameRate: false },
    });
    expect(bars(box)[0]).toBe("1188 × 2112 (9:16) | 29.97 fps | 9:16");

    hud.fill({ width: 1280, height: 720, clip: { codec: "VP9", frameRate: null, variableFrameRate: false } });
    expect(bars(box)[0]).toBe("1280 × 720 (16:9) |  | 16:9");
  });

  it("put a still's color mode and bit depth after its dimensions, where its header gives them", () => {
    const box = document.createElement("div");
    const hud = thumbnailHud(box);
    const pixels = { colorModel: "grayscale" as const, alpha: true, bitDepth: 16 };
    hud.fill({ width: 1024, height: 1024, picture: { sourceType: null, pixels } });
    expect(bars(box)[0]).toBe("1024 × 1024 (1:1) | Grayscale + alpha 16-bit | 1:1");

    hud.fill({ width: 1024, height: 1024, picture: { sourceType: null, pixels: null } });
    expect(bars(box)[0]).toBe("1024 × 1024 (1:1) |  | 1:1");
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
