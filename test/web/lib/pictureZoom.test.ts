// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dragToScroll, frameZoom, keepClickedPoint, shownPercent, zoomFrom } from "../../../web/lib/pictureZoom.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pointer(type: string, target: EventTarget, x: number, y: number, extra: PointerEventInit = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height }) as DOMRect;

// jsdom runs no animations: each one started here is kept, with its
// keyframes, and the test says when it finishes.
function animated(element: HTMLElement) {
  const runs: { keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn>; finish(): void }[] = [];
  element.animate = ((keyframes: Keyframe[]) => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = { keyframes, cancel: vi.fn(), finish };
    runs.push(run);
    return { finished, cancel: run.cancel } as unknown as Animation;
  }) as HTMLElement["animate"];
  return runs;
}

// The system's motion preference, for the length of `body`.
function reducingMotion(body: () => void): void {
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduce") })) as typeof window.matchMedia;
  try {
    body();
  } finally {
    Reflect.deleteProperty(window, "matchMedia");
  }
}

// A drag's release swallows clicks until the next task, which the next test
// would otherwise start in.
afterEach(async () => {
  await settle();
  document.body.replaceChildren();
});

describe("shownPercent", () => {
  it("counts the share of its full width a picture is shown at, in whole percent", () => {
    expect(shownPercent(450, 600)).toBe(75);
    expect(shownPercent(599.6, 600)).toBe(100);
    expect(shownPercent(651.5, 2412)).toBe(27);
  });
});

describe("keepClickedPoint", () => {
  it("scrolls the point clicked back under the pointer once the picture has grown", () => {
    const scroller = document.createElement("div");
    const img = document.createElement("img");
    img.getBoundingClientRect = () => rect(24, 24, 2400, 1600);
    // A quarter of the way across the fitted picture, and half way down.
    keepClickedPoint(img, rect(40, 30, 600, 400), scroller, new MouseEvent("click", { clientX: 190, clientY: 230 }));
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([24 + 600 - 190, 24 + 800 - 230]);
  });
});

describe("dragToScroll", () => {
  function setup(grabs: (event: MouseEvent) => boolean = () => true) {
    const scroller = document.createElement("div");
    const img = document.createElement("img");
    scroller.append(img);
    document.body.append(scroller);
    scroller.scrollLeft = 100;
    scroller.scrollTop = 50;
    dragToScroll(scroller, grabs);
    const clicked = vi.fn();
    img.addEventListener("click", clicked);
    img.addEventListener("dblclick", clicked);
    return { scroller, img, clicked };
  }

  it("moves what the box shows by the pointer's travel, past a few pixels' slop", () => {
    const { scroller, img } = setup();
    pointer("pointerdown", img, 200, 200);
    pointer("pointermove", window, 202, 201);
    expect([scroller.scrollLeft, scroller.scrollTop, scroller.className]).toEqual([100, 50, ""]);
    pointer("pointermove", window, 230, 180);
    expect([scroller.scrollLeft, scroller.scrollTop, scroller.className]).toEqual([70, 70, "is-panning"]);
    pointer("pointermove", window, 150, 260);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([150, -10]);
    pointer("pointerup", window, 150, 260);
    expect(scroller.className).toBe("");
    pointer("pointermove", window, 0, 0);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([150, -10]);
  });

  // Released over the gallery preview's backdrop, that click would close it.
  it("swallows the clicks a drag's release sends, wherever they land, and no later one", async () => {
    const { img, clicked } = setup();
    const backdrop = vi.fn();
    document.body.addEventListener("click", backdrop);
    pointer("pointerdown", img, 200, 200);
    pointer("pointermove", window, 260, 200);
    pointer("pointerup", window, 260, 200);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect([clicked.mock.calls.length, backdrop.mock.calls.length]).toEqual([0, 0]);

    await settle();
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  // Chromium can deliver a quick next click before a zero-delay timer runs.
  it("lets the next press's click through at once", () => {
    const { img, clicked } = setup();
    pointer("pointerdown", img, 200, 200);
    pointer("pointermove", window, 260, 200);
    pointer("pointerup", window, 260, 200);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    pointer("pointerdown", img, 260, 200);
    pointer("pointerup", window, 260, 200);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("leaves a press that stays within the slop its click", () => {
    const { scroller, img, clicked } = setup();
    pointer("pointerdown", img, 200, 200);
    pointer("pointermove", window, 203, 198);
    pointer("pointerup", window, 203, 198);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([100, 50]);
  });

  it("leaves touch, pen, other buttons and the presses it isn't given to the browser", () => {
    const { scroller, img } = setup((event) => event.target === img);
    for (const extra of [{ pointerType: "touch" }, { pointerType: "pen" }, { button: 1 }]) {
      pointer("pointerdown", img, 200, 200, extra);
      pointer("pointermove", window, 260, 260, extra);
      pointer("pointerup", window, 260, 260, extra);
    }
    pointer("pointerdown", scroller, 200, 200);
    pointer("pointermove", window, 260, 260);
    pointer("pointerup", window, 260, 260);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([100, 50]);
  });

  it("follows only the pointer that pressed", () => {
    const { scroller, img } = setup();
    pointer("pointerdown", img, 200, 200);
    pointer("pointermove", window, 260, 260, { pointerId: 2 });
    expect(scroller.scrollLeft).toBe(100);
    pointer("pointercancel", window, 260, 260);
    pointer("pointermove", window, 300, 300);
    expect(scroller.scrollLeft).toBe(100);
  });

  it("stops the picture's own drag while a press would grab it", () => {
    let grabbing = true;
    const { img } = setup(() => grabbing);
    const drag = () => {
      const event = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
      img.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(drag()).toBe(true);
    grabbing = false;
    expect(drag()).toBe(false);
  });

  // The picture's own listener writes its entry, which a claimed drag must
  // never carry.
  it("claims the drag before a listener on the picture hears it", () => {
    const { img } = setup(() => true);
    let heard: boolean | undefined;
    img.addEventListener("dragstart", (event) => {
      heard = event.defaultPrevented;
    });
    img.dispatchEvent(new MouseEvent("dragstart", { bubbles: true, cancelable: true }));
    expect(heard).toBe(true);
  });
});

describe("frameZoom", () => {
  // A 2400 × 1600 picture in its frame, an 8px mat around it: fitted at a
  // quarter of its size, or zoomed with the frame grown to a 1000 × 700
  // stage, the picture at full size under it before any scroll.
  function setup(full: [number, number] = [2400, 1600]) {
    const frame = document.createElement("div");
    const img = document.createElement("img");
    frame.append(img);
    document.body.append(frame);
    const zoomedIn = () => frame.classList.contains("is-zoomed");
    img.getBoundingClientRect = () =>
      zoomedIn() ? rect(108, 58, full[0], full[1]) : rect(208, 158, full[0] / 4, full[1] / 4);
    frame.getBoundingClientRect = () =>
      zoomedIn() ? rect(100, 50, 1016, 716) : rect(200, 150, full[0] / 4 + 16, full[1] / 4 + 16);
    const measured = vi.fn(() => zoom.fit(img.getBoundingClientRect().width, full[0]));
    const zoom = frameZoom(frame, img, measured);
    zoom.fit(full[0] / 4, full[0]);
    return { frame, img, zoom, measured };
  }

  const click = (x = 0, y = 0) => new MouseEvent("click", { clientX: x, clientY: y });

  it("zooms a shrunk picture in on the point clicked, and fits it on the next click", () => {
    const { frame, zoom, measured } = setup();
    expect(frame.className).toBe("is-zoomable");
    // At the middle of the fitted picture, whose middle then shows under it.
    expect(zoom.click(click(208 + 300, 158 + 200))).toBe(true);
    expect(frame.className).toBe("is-zoomed");
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([108 + 1200 - 508, 58 + 800 - 358]);
    expect(measured).toHaveBeenCalledTimes(1);

    expect(zoom.click(click())).toBe(true);
    expect(frame.className).toBe("is-zoomable");
    expect(measured).toHaveBeenCalledTimes(2);
  });

  it("leaves a picture already at full size to the click's other use", () => {
    const { frame, zoom } = setup();
    zoom.fit(600, 600);
    expect(zoom.click(click())).toBe(false);
    expect(frame.className).toBe("");
  });

  // A toolbar's button has no point on the picture to give.
  it("zooms in on the picture's middle given no point", () => {
    const { frame, zoom } = setup();
    expect(zoom.click()).toBe(true);
    expect(frame.className).toBe("is-zoomed");
    expect([frame.scrollLeft, frame.scrollTop]).toEqual([108 + 1200 - 508, 58 + 800 - 358]);
  });

  it("says what a click does: zooms in, out to fit, or nothing at full size", () => {
    const { zoom } = setup();
    expect(zoom.clickZooms()).toBe("in");
    zoom.click(click());
    expect(zoom.clickZooms()).toBe("out");
    zoom.click(click());
    expect(zoom.clickZooms()).toBe("in");
    zoom.fit(600, 600);
    expect(zoom.clickZooms()).toBeUndefined();
  });

  it("is grabbed by a drag only while zoomed", () => {
    const { frame, img, zoom } = setup();
    pointer("pointerdown", img, 300, 300);
    pointer("pointermove", window, 200, 200);
    pointer("pointerup", window, 200, 200);
    expect(frame.scrollLeft).toBe(0);
    zoom.click(click(208, 158));
    const left = frame.scrollLeft;
    pointer("pointerdown", img, 300, 300);
    pointer("pointermove", window, 200, 250);
    pointer("pointerup", window, 200, 250);
    expect(frame.scrollLeft).toBe(left + 100);
  });

  // The browser scrolls a zoomed picture by the wheel, Shift+wheel sideways;
  // one that runs off the sides only takes the plain wheel sideways too.
  it("takes the plain wheel sideways for a picture that runs off the sides only", () => {
    const { frame, zoom } = setup([4800, 400]);
    zoom.click(click(208, 158));
    frame.scrollLeft = 0;
    const box = { scrollWidth: 4816, clientWidth: 1016, scrollHeight: 416, clientHeight: 416 };
    for (const [key, value] of Object.entries(box)) Object.defineProperty(frame, key, { value, configurable: true });
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      frame.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(wheel({ deltaY: 100 })).toBe(true);
    expect(wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(true);
    expect(frame.scrollLeft).toBe(220);
    expect(wheel({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE })).toBe(true);
    expect(frame.scrollLeft).toBe(220 - 1016);

    frame.scrollLeft = 0;
    expect(wheel({ deltaY: 100, shiftKey: true })).toBe(false);
    expect(wheel({ deltaY: 100, ctrlKey: true })).toBe(false);
    expect(wheel({ deltaX: 40, deltaY: 10 })).toBe(false);
    Object.defineProperty(frame, "scrollHeight", { value: 900, configurable: true });
    expect(wheel({ deltaY: 100 })).toBe(false);
    expect(frame.scrollLeft).toBe(0);
  });

  describe("with motion", () => {
    it("grows the frame and the picture together from the fitted picture to the point clicked", async () => {
      const { frame, img, zoom, measured } = setup();
      const sizes = animated(frame);
      const places = animated(img);
      zoom.click(click(208 + 300, 158 + 200));
      expect(frame.className).toBe("is-zoomed is-zooming");
      expect(sizes[0].keyframes).toEqual([
        { width: "616px", height: "416px" },
        { width: "1016px", height: "716px" },
      ]);
      expect(places[0].keyframes).toEqual([
        { transform: "translate(0px, 0px) scale(0.25)" },
        { transform: "translate(-800px, -500px) scale(1)" },
      ]);
      expect(measured).not.toHaveBeenCalled();

      frame.scrollLeft = 0;
      frame.scrollTop = 0;
      sizes[0].finish();
      await settle();
      expect(frame.className).toBe("is-zoomed");
      expect([frame.scrollLeft, frame.scrollTop]).toEqual([800, 500]);
      expect([sizes[0].cancel, places[0].cancel].map((cancel) => cancel.mock.calls.length)).toEqual([1, 1]);
      expect(measured).toHaveBeenCalledTimes(1);
    });

    it("shrinks it back from where it was scrolled to", () => {
      const { frame, img, zoom } = setup();
      zoom.click(click(208, 158));
      const places = animated(img);
      animated(frame);
      frame.scrollLeft = 640;
      frame.scrollTop = 320;
      zoom.click(click());
      expect(frame.className).toBe("is-zoomed is-zooming");
      expect(places[0].keyframes).toEqual([
        { transform: "translate(-640px, -320px) scale(1)" },
        { transform: "translate(0px, 0px) scale(0.25)" },
      ]);
    });

    // Measured mid-run, the picture is still shrunk by its transform.
    it("marks nothing zoomable from a measure taken while zooming or zoomed", async () => {
      const { frame, img, zoom } = setup();
      const sizes = animated(frame);
      animated(img);
      zoom.click(click());
      zoom.fit(600, 2400);
      expect(frame.className).toBe("is-zoomed is-zooming");
      sizes[0].finish();
      await settle();
      zoom.fit(600, 2400);
      expect(frame.className).toBe("is-zoomed");
    });

    // A click acts on the picture as it will stand, as a key or a click on
    // the tree ends its slide first.
    it("ends a zoom still running before acting on the next click", () => {
      const { frame, img, zoom } = setup();
      animated(frame);
      animated(img);
      zoom.click(click(208, 158));
      expect(frame.className).toBe("is-zoomed is-zooming");
      zoom.click(click());
      expect(frame.className).toBe("is-zoomed is-zooming");
      zoom.click(click(208, 158));
      expect(frame.className).toBe("is-zoomed is-zooming");
      const panned = frame.scrollLeft;
      pointer("pointerdown", img, 300, 300);
      pointer("pointermove", window, 200, 300);
      pointer("pointerup", window, 200, 300);
      expect(frame.scrollLeft).toBe(panned);
    });

    // Mid-run, the picture's box is the run's, not the one the zoom starts
    // from once the run ends.
    it("finds the middle of the picture as it stands once a running zoom ends", () => {
      const { frame, img, zoom } = setup();
      animated(frame);
      animated(img);
      zoom.click(click(208, 158));
      zoom.click(click());
      frame.scrollLeft = 0;
      frame.scrollTop = 0;
      zoom.click();
      expect([frame.scrollLeft, frame.scrollTop]).toEqual([108 + 1200 - 508, 58 + 800 - 358]);
    });

    it("zooms at once when the system asks for reduced motion", () => {
      reducingMotion(() => {
        const { frame, zoom } = setup();
        const sizes = animated(frame);
        zoom.click(click());
        expect([frame.className, sizes.length]).toEqual(["is-zoomed", 0]);
      });
    });
  });
});

describe("zoomFrom", () => {
  // Laid out at full size, scrolled to (300, 200) of it; shown before at a
  // quarter of that size.
  function setup() {
    const img = document.createElement("img");
    document.body.append(img);
    img.getBoundingClientRect = () => rect(-300, -200, 2400, 1600);
    const end = vi.fn();
    return { img, end, before: rect(40, 24, 600, 400) };
  }

  it("runs the picture from the box it filled to its layout, by a transform alone", async () => {
    const { img, end, before } = setup();
    const runs = animated(img);
    const stop = zoomFrom(img, before, end);
    expect(runs[0].keyframes).toEqual([
      { transform: "translate(340px, 224px) scale(0.25)", transformOrigin: "0 0" },
      { transform: "none", transformOrigin: "0 0" },
    ]);
    expect(stop).toBeTypeOf("function");
    expect(end).not.toHaveBeenCalled();

    runs[0].finish();
    await settle();
    expect(runs[0].cancel).toHaveBeenCalledTimes(1);
    stop?.();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends a run early once, where it was going", () => {
    const { img, end, before } = setup();
    const runs = animated(img);
    const stop = zoomFrom(img, before, end);
    stop?.();
    stop?.();
    expect([end.mock.calls.length, runs[0].cancel.mock.calls.length]).toEqual([1, 1]);
  });

  it("ends at once with no run: reduced motion, or nothing laid out", () => {
    const { img, end, before } = setup();
    const runs = animated(img);
    reducingMotion(() => {
      expect(zoomFrom(img, before, end)).toBeUndefined();
    });
    img.getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(zoomFrom(img, before, end)).toBeUndefined();
    expect([end.mock.calls.length, runs.length]).toEqual([2, 0]);
  });
});
