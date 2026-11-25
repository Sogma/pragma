// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { formatFileSize } from "../../../web/lib/dom.ts";
import {
  fitHud,
  guidesSwitch,
  hudBadges,
  hudCells,
  hudRoot,
  lookBadge,
  mediaMenuOn,
  thumbnailHud,
} from "../../../web/lib/mediaHud.ts";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { NO_LOOK } from "../../../web/lib/videoLut.ts";
import { memoryLook, memorySetting } from "../support/editorLayout.ts";

const noMenu = () => {};

// A badge's menu as the real opener keeps it: open at a point, standing for
// it, and closed by a call with none.
const badgeMenu = () =>
  vi.fn((anchor: HTMLElement, at?: { x: number; y: number }) => {
    anchor.setAttribute("aria-expanded", String(at !== undefined));
  });

// A badge on a frame whose right-click opens the media's menu.
function onFrame(badge: HTMLElement) {
  const frame = document.createElement("div");
  frame.append(badge);
  const mediaMenu = vi.fn();
  mediaMenuOn(frame, () => frame, mediaMenu);
  const rightClick = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 40,
    clientY: 12,
  });
  badge.dispatchEvent(rightClick);
  return { mediaMenu, rightClick };
}

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
    const { element } = lookBadge(look, noMenu);
    expect([element.type, element.className, element.tabIndex]).toEqual(["button", "media-hud-badge", -1]);
    expect(element.textContent).toBe("");

    look.set({ lut: "panchromatic", on: true });
    expect(element.textContent).toBe("LOOK");
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.getAttribute("aria-label")).toBe("Panchromatic look");
    expect(element.dataset.tooltip).toBe("[Panchromatic] on, click to turn off (D)");

    look.set({ lut: "orthochromatic", on: false });
    expect(element.getAttribute("aria-pressed")).toBe("false");
    expect(element.dataset.tooltip).toBe("[Orthochromatic] off, click to turn on (D)");

    // As a viewer moves to a context with no look picked.
    look.set({ lut: "panchromatic", on: true });
    look.set(NO_LOOK);
    expect(element.textContent).toBe("");
    expect(["aria-label", "aria-pressed", "data-tooltip"].map((name) => element.hasAttribute(name))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("turns the look off and back on at each click, a press leaving focus where it was, until disposed", () => {
    const look = memoryLook({ lut: "panchromatic", on: true });
    const badge = lookBadge(look, noMenu);
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

  it("opens the looks at a right-click, where the frame's would open the media's menu, and a click closes them as it turns", () => {
    const look = memoryLook({ lut: "panchromatic", on: true });
    const menu = badgeMenu();
    const { element } = lookBadge(look, menu);
    const { mediaMenu, rightClick } = onFrame(element);
    expect([menu.mock.calls, rightClick.defaultPrevented, mediaMenu.mock.calls]).toEqual([
      [[element, { x: 40, y: 12 }]],
      true,
      [],
    ]);

    element.click();
    expect([menu.mock.lastCall, element.getAttribute("aria-expanded"), look.get().on]).toEqual([
      [element],
      "false",
      false,
    ]);
    element.click();
    expect([menu.mock.calls.length, look.get().on]).toEqual([2, true]);
  });
});

describe("the guides switch", () => {
  it("stays hidden until a guide is picked, then says whether the guides show, out of the tab order", () => {
    const guides = memorySetting(NO_GUIDES);
    const { element } = guidesSwitch(guides, noMenu);
    const name = [element.type, element.className, element.tabIndex, element.getAttribute("aria-label")];
    expect(name).toEqual(["button", "icon-button media-hud-guides", -1, "Guides"]);
    expect(element.hidden).toBe(true);

    guides.set({ ...NO_GUIDES, frames: ["2.39"] });
    expect(element.hidden).toBe(false);
    expect(element.getAttribute("aria-pressed")).toBe("true");
    expect(element.dataset.tooltip).toBe("Guides on, click to turn off (G)");

    // Hidden, the picks are kept, and so is the switch.
    guides.set({ ...guides.get(), shown: false });
    expect(element.hidden).toBe(false);
    expect(element.getAttribute("aria-pressed")).toBe("false");
    expect(element.dataset.tooltip).toBe("Guides off, click to turn on (G)");

    guides.set(NO_GUIDES);
    expect(element.hidden).toBe(true);
  });

  it("hides and shows the guides at each click, a press leaving focus where it was, until disposed", () => {
    const guides = memorySetting({ ...NO_GUIDES, title: true });
    const toggle = guidesSwitch(guides, noMenu);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    toggle.element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    toggle.element.click();
    expect(guides.get()).toEqual({ ...NO_GUIDES, title: true, shown: false });
    toggle.element.click();
    expect(guides.get().shown).toBe(true);

    toggle.dispose();
    guides.set({ ...guides.get(), shown: false });
    expect(toggle.element.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the guides to pick at a right-click, where the frame's would open the media's menu, and a click closes them as it turns", () => {
    const guides = memorySetting({ ...NO_GUIDES, title: true });
    const menu = badgeMenu();
    const { element } = guidesSwitch(guides, menu);
    const { mediaMenu, rightClick } = onFrame(element);
    expect([menu.mock.calls, rightClick.defaultPrevented, mediaMenu.mock.calls]).toEqual([
      [[element, { x: 40, y: 12 }]],
      true,
      [],
    ]);

    element.click();
    expect([menu.mock.lastCall, element.getAttribute("aria-expanded"), guides.get().shown]).toEqual([
      [element],
      "false",
      false,
    ]);
    element.click();
    expect([menu.mock.calls.length, guides.get().shown]).toEqual([2, true]);
  });

  // jsdom lays nothing out: the boxes a laid-out bar gives.
  const placeAt = (element: Element, left: number, width: number) => {
    const box = { left, right: left + width, width, top: 0, bottom: 19, height: 19 } as DOMRect;
    element.getBoundingClientRect = () => box;
    element.getClientRects = () => [box] as unknown as DOMRectList;
  };

  it("shares a cell with LOOK, before it, and stays out of sight where it would touch a fact beside the cell", () => {
    const toggle = guidesSwitch(memorySetting({ ...NO_GUIDES, center: true }), noMenu);
    const look = lookBadge(memoryLook({ lut: "panchromatic", on: true }), noMenu);
    const [dimensions, scale] = hudCells(2);
    const cell = hudBadges(toggle.element, look.element);
    expect([...cell.children]).toEqual([toggle.element, look.element]);
    const hud = hudRoot([dimensions, cell, scale]);
    placeAt(dimensions, 0, 124);
    placeAt(scale, 452, 28);

    placeAt(toggle.element, 160, 32);
    fitHud(hud, 480, 300);
    expect(toggle.element.classList.contains("is-cramped")).toBe(false);

    placeAt(toggle.element, 126, 32); // 2px off the dimensions
    fitHud(hud, 480, 300);
    expect(toggle.element.classList.contains("is-cramped")).toBe(true);

    placeAt(toggle.element, 160, 32);
    fitHud(hud, 480, 300);
    expect(toggle.element.classList.contains("is-cramped")).toBe(false);
  });
});

describe("mediaMenuOn", () => {
  const rig = () => {
    const surface = document.createElement("div");
    const frame = document.createElement("div");
    const media = document.createElement("img");
    const bar = document.createElement("div");
    const margin = document.createElement("div");
    frame.append(media, bar);
    surface.append(margin, frame);
    document.body.append(surface);
    surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    media.getBoundingClientRect = () => new DOMRect(100, 50, 400, 300);
    const open = vi.fn();
    const stop = mediaMenuOn(surface, () => media, open);
    const rightClick = (target: Element, init: MouseEventInit) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    return { surface, media, frame, bar, margin, open, stop, rightClick };
  };

  it("opens at a right-click on the media itself, and leaves one on its frame, a bar or beside it to the surface's menus", () => {
    const { media, frame, bar, margin, open, rightClick } = rig();
    const onMedia = rightClick(media, { button: 2, clientX: 220, clientY: 140 });
    expect([open.mock.calls, onMedia.defaultPrevented]).toEqual([[[{ x: 220, y: 140 }]], true]);
    const elsewhere = [frame, bar, margin].map(
      (target) => rightClick(target, { button: 2, clientX: 5, clientY: 5 }).defaultPrevented,
    );
    expect([open.mock.calls.length, elsewhere]).toEqual([1, [false, false, false]]);
  });

  // A key's right-click lands on what has focus, with no button pressed.
  it("opens at the media's centre for the menu key on the focused surface, until stopped", () => {
    const { surface, open, stop, rightClick } = rig();
    rightClick(surface, { button: -1 });
    expect(open).toHaveBeenLastCalledWith({ x: 300, y: 200 });
    // The pointer's on the surface's own padding is no key's.
    rightClick(surface, { button: 2, clientX: 1, clientY: 1 });
    expect(open).toHaveBeenCalledTimes(1);
    stop();
    rightClick(surface, { button: -1 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens in the middle of the part in view for the menu key, where a zoomed picture runs past the surface", () => {
    const { surface, media, open, rightClick } = rig();
    media.getBoundingClientRect = () => new DOMRect(-400, 200, 2000, 1500);
    rightClick(surface, { button: -1 });
    expect(open).toHaveBeenLastCalledWith({ x: 400, y: 400 });
  });
});
