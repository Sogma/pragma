// A picture shrunk to fit shows at full size on a click, and fits again on
// the next. The image view and the gallery's preview zoom alike: on the
// point clicked, to the picture's size in CSS pixels as a browser's own
// image view counts it, over the same short run, and at full size a mouse
// drag moves it about.

/** The share of its full width a picture is shown at, as a whole percent;
 * below 100, a click shows it at full size. */
export function shownPercent(shownWidth: number, fullWidth: number): number {
  return Math.round((shownWidth / fullWidth) * 100);
}

/** A point on the screen, as a click gives one. */
type Point = Pick<MouseEvent, "clientX" | "clientY">;

/** Scrolls `scroller` so the point a click at `at` landed on, in `media` as
 * it filled `before`, is under the pointer again now the picture has grown,
 * rather than the picture's corner. */
export function keepClickedPoint(media: Element, before: DOMRect, scroller: Element, at: Point): void {
  const after = media.getBoundingClientRect();
  const x = (at.clientX - before.left) / before.width;
  const y = (at.clientY - before.top) / before.height;
  scroller.scrollLeft += after.left + x * after.width - at.clientX;
  scroller.scrollTop += after.top + y * after.height - at.clientY;
}

// A press that travels less than this, in CSS pixels, stays a click.
const DRAG_SLOP = 4;

/** Lets a mouse drag move what `scroller` shows, as a hand moves a sheet,
 * for each press `grabs` takes. Touch and pen are left to the browser,
 * whose own panning scrolls the same box. */
export function dragToScroll(scroller: HTMLElement, grabs: (event: MouseEvent) => boolean): void {
  // The picture's own drag would carry its file off instead. Claimed while
  // capturing, so a listener on the picture already sees it taken.
  scroller.addEventListener(
    "dragstart",
    (event) => {
      if (grabs(event)) event.preventDefault();
    },
    { capture: true },
  );
  scroller.addEventListener("pointerdown", (press) => {
    if (press.pointerType !== "mouse" || press.button !== 0 || !grabs(press)) return;
    const from = { left: scroller.scrollLeft, top: scroller.scrollTop };
    let dragging = false;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== press.pointerId) return;
      const dx = event.clientX - press.clientX;
      const dy = event.clientY - press.clientY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        dragging = true;
        scroller.classList.add("is-panning");
        capture(scroller, press.pointerId);
      }
      scroller.scrollLeft = from.left - dx;
      scroller.scrollTop = from.top - dy;
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== press.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragging) return;
      scroller.classList.remove("is-panning");
      if (event.type === "pointerup") swallowRelease();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}

// Captured once the drag starts, not at the press: captured there, a plain
// click's release would land on the scroller rather than on the picture.
function capture(scroller: HTMLElement, pointerId: number): void {
  if (typeof scroller.setPointerCapture !== "function") return;
  try {
    scroller.setPointerCapture(pointerId);
  } catch {
    // The pointer is gone; the window still hears its release.
  }
}

// The release that ends a drag still clicks, wherever it lands: on the
// picture, which would fit it again, or on the gallery preview's backdrop,
// which would close it. Its clicks come in the release's own task, so a
// window listener takes them, until the next press: Chromium can run a quick
// next click before a zero-delay timer, which only ends a release with none.
function swallowRelease(): void {
  const types = ["click", "dblclick"];
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  const disarm = () => {
    for (const type of types) window.removeEventListener(type, swallow, true);
    window.removeEventListener("pointerdown", disarm, true);
  };
  for (const type of types) window.addEventListener(type, swallow, true);
  window.addEventListener("pointerdown", disarm, true);
  setTimeout(disarm);
}

const ZOOM: KeyframeAnimationOptions = { duration: 150, easing: "cubic-bezier(0.33, 1, 0.68, 1)" };

// WAAPI sits outside the stylesheet's reduced-motion override, so the
// preference is read here.
export function canAnimate(element: HTMLElement): boolean {
  return typeof element.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/** Runs `media` from the box it filled, `before`, to where it is laid out
 * now, by a transform alone: the layout is the zoom's end from the start.
 * `end` runs as the run finishes, at once with none; what is returned ends
 * a run early. */
export function zoomFrom(media: HTMLElement, before: DOMRect, end: () => void): (() => void) | undefined {
  const after = media.getBoundingClientRect();
  if (!canAnimate(media) || after.width === 0) {
    end();
    return undefined;
  }
  const from = `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width})`;
  const animation = media.animate(
    [
      { transform: from, transformOrigin: "0 0" },
      { transform: "none", transformOrigin: "0 0" },
    ],
    ZOOM,
  );
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    animation.cancel();
    end();
  };
  animation.finished.then(finish, () => {});
  return finish;
}

// A wheel's line, for a mouse whose wheel counts lines rather than pixels.
const WHEEL_LINE = 40;

// One end of a zoom: the frame's box, and where the picture sits in it.
interface Pose {
  box: DOMRect;
  x: number;
  y: number;
  scale: number;
}

export interface FrameZoom {
  /** Measures the picture again, shown `shownWidth` wide of `fullWidth`. */
  fit(shownWidth: number, fullWidth: number): void;
  /** A click on the picture: zooms in on the point clicked, on its middle
   * with none, or fits it again. False when there is nothing to zoom, the
   * picture at full size. */
  click(at?: Point): boolean;
  /** What a click does now: zooms "in", or "out" to fit the picture again;
   * undefined at full size, where it does nothing. */
  clickZooms(): "in" | "out" | undefined;
}

const middleOf = (box: DOMRect): Point => ({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });

/** Zooms the picture in `frame`, the box it shares with its overlay
 * (mediaHud.ts), inside a size container: zoomed, the frame grows with the
 * picture up to the container's room and scrolls it, by the wheel or a
 * drag. `measured` runs as each zoom settles. */
export function frameZoom(frame: HTMLElement, img: HTMLImageElement, measured: () => void): FrameZoom {
  let zoomable = false;
  let zoomed = false;
  // Ends the zoom that is running, where it was going.
  let settle: (() => void) | undefined;

  dragToScroll(frame, () => zoomed && !settle);

  // A picture that runs off the sides only takes the plain wheel sideways,
  // which would move nothing; the browser scrolls it every other way.
  frame.addEventListener(
    "wheel",
    (event) => {
      if (!zoomed || settle || event.shiftKey || event.ctrlKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (frame.scrollHeight > frame.clientHeight || frame.scrollWidth <= frame.clientWidth) return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? frame.clientWidth
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? WHEEL_LINE
            : 1;
      frame.scrollLeft += event.deltaY * unit;
    },
    { passive: false },
  );

  // While a zoom runs the frame clips rather than scrolls, and the picture's
  // place in it is a transform. In a scroller, the transformed picture would
  // change how far the frame can scroll, and pull its scroll back mid-zoom.
  function animate(from: Pose, to: Pose, end: () => void): void {
    const done = () => {
      settle = undefined;
      end();
      measured();
    };
    if (!canAnimate(frame)) {
      done();
      return;
    }
    frame.classList.add("is-zooming");
    const size = ({ box }: Pose) => ({ width: `${box.width}px`, height: `${box.height}px` });
    const place = ({ x, y, scale }: Pose) => ({ transform: `translate(${x}px, ${y}px) scale(${scale})` });
    const animations = [frame.animate([size(from), size(to)], ZOOM), img.animate([place(from), place(to)], ZOOM)];
    const finish = () => {
      if (settle !== finish) return;
      for (const animation of animations) animation.cancel();
      frame.classList.remove("is-zooming");
      done();
    };
    settle = finish;
    animations[0].finished.then(finish, () => {});
  }

  function zoomIn(at: Point | undefined): void {
    const box = frame.getBoundingClientRect();
    const fitted = img.getBoundingClientRect();
    zoomed = true;
    frame.classList.remove("is-zoomable");
    frame.classList.add("is-zoomed");
    const full = img.getBoundingClientRect();
    keepClickedPoint(img, fitted, frame, at ?? middleOf(fitted));
    const { scrollLeft: left, scrollTop: top } = frame;
    const from = { box, x: 0, y: 0, scale: fitted.width / full.width };
    animate(from, { box: frame.getBoundingClientRect(), x: -left, y: -top, scale: 1 }, () => {
      frame.scrollLeft = left;
      frame.scrollTop = top;
    });
  }

  // The fitted frame is measured with the zoom off, then the zoom goes back
  // on for the run: the picture shrinks by its transform, at full size.
  function zoomOut(): void {
    const full = img.getBoundingClientRect();
    const from = { box: frame.getBoundingClientRect(), x: -frame.scrollLeft, y: -frame.scrollTop, scale: 1 };
    zoomed = false;
    frame.classList.remove("is-zoomed");
    const fitted = img.getBoundingClientRect();
    const to = { box: frame.getBoundingClientRect(), x: 0, y: 0, scale: fitted.width / full.width };
    frame.classList.add("is-zoomed");
    animate(from, to, () => frame.classList.remove("is-zoomed"));
  }

  return {
    fit(shownWidth, fullWidth) {
      if (zoomed || settle) return;
      zoomable = shownPercent(shownWidth, fullWidth) < 100;
      frame.classList.toggle("is-zoomable", zoomable);
    },
    click(at) {
      settle?.();
      if (zoomed) zoomOut();
      else if (zoomable) zoomIn(at);
      else return false;
      return true;
    },
    clickZooms: () => (zoomed ? "out" : zoomable ? "in" : undefined),
  };
}
