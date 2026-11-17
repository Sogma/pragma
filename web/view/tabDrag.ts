// A tab carried along the strips by the pointer: the pills it passes step
// aside, it may cross into the other group's strip, and it settles into its
// slot when let go. The tab model hears of the move only once the tab has
// landed (onDrop); until then the strips' DOM is the drag's, and a strip
// redrawn under it ends the drag (release).
import { DisposableStore, listen } from "../lib/disposable.ts";

export interface TabDragStrip {
  /** The strip, whose box the carried tab may cross into. */
  readonly strip: HTMLElement;
  /** The strip's pills as laid out, in order, a carried one excluded. */
  pills(): HTMLButtonElement[];
  /** The pill's place among the strip's tabs, or -1. */
  indexOf(pill: HTMLButtonElement): number;
  /** Finishes any motion midway, a width hold or a pill growing or
   * shrinking, so the layout read next is the one that stays. */
  settle(): void;
}

export interface TabDrop {
  from: TabDragStrip;
  /** The carried tab's place in `from` when it was picked up. */
  index: number;
  to: TabDragStrip;
  /** Its slot among `to`'s other tabs. */
  at: number;
}

export interface TabDragOptions {
  /** Holds the strips, the carried tab's layer, and the pointer while a tab
   * is carried. */
  host: HTMLElement;
  /** The strips shown, left to right. */
  strips(): TabDragStrip[];
  /** A press on a pill, other than on its ×: a browser selects on press. */
  onPress(strip: TabDragStrip, index: number): void;
  onDrop(drop: TabDrop): void;
}

export interface TabDrag {
  /** Ends a drag through `strip` at once, a carried tab back in its place
   * and a landing one placed: for a strip about to be redrawn. */
  release(strip: HTMLElement): void;
  dispose(): void;
}

// How far the pointer travels before a press becomes a drag.
const LIFT_PX = 4;
// How far past its edges the strip holding the tab keeps it, so a pointer on
// the line between two strips can't flip the tab to and fro.
const STICK_PX = 16;
// How far off the strips the tab is pulled before it tears loose and floats.
const PULL_PX = 24;

interface Zone {
  strip: TabDragStrip;
  left: number;
  right: number;
  top: number;
  bottom: number;
  // An edge another strip adjoins is open: the tab follows the pointer
  // straight across it, as the row goes on there. At the other edges it
  // stops at the end of the row, as a browser's tabs do.
  leftOpen: boolean;
  rightOpen: boolean;
}

// Where a strip's pills sit for each slot the carried tab's gap can take.
// The pills keep their DOM places for the whole drag and only ever shift by
// the gap's width, so it all follows from their widths, measured once.
interface Geometry {
  zone: Zone;
  pills: HTMLButtonElement[];
  gap: HTMLElement;
  n: number;
  p: number;
  k: number;
  width: number;
  // The gap's width in whole device pixels: how far the pills step aside.
  // All of them step the same, so no seam opens between two that stepped.
  step: number;
  start: number;
  sums: Float64Array;
  // The gap passes pill k once the carried tab's centre crosses bounds[k]:
  // its leading edge has then covered half of that pill.
  bounds: Float64Array;
  minX: number;
  maxX: number;
  grow: Animation | undefined;
}

interface Gesture {
  id: number;
  pill: HTMLButtonElement;
  strip: TabDragStrip;
  index: number;
  x0: number;
  y0: number;
  onClose: boolean;
  lifted: boolean;
}

interface Drag {
  pill: HTMLButtonElement;
  home: Zone;
  homeIndex: number;
  zones: Zone[];
  // The layer's box in viewport px: every position below is relative to it.
  ox: number;
  oy: number;
  layerW: number;
  layerH: number;
  vw: number;
  dpr: number;
  // The pointer from the pill's left edge, and the pill's bottom from the pointer.
  grabX: number;
  grabB: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  at: Zone | undefined;
  geo: Geometry | undefined;
  glide: { dx: number; dy: number; t0: number } | undefined;
  jumped: boolean;
  cancelled: boolean;
  widthAnim: Animation | undefined;
  landing: Animation | undefined;
}

interface Timing {
  duration: number;
  land: number;
  easing: string;
}

const clamp = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value);

// The tokens are read as each drag starts, so a change to scale.css reaches
// the next drag. WAAPI sits outside the stylesheet's reduced-motion override,
// so the preference is read here.
function motion(): Timing {
  const tokens = getComputedStyle(document.documentElement);
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const animates = typeof Element.prototype.animate === "function" && !reduced;
  const ms = (name: string): number => {
    const value = tokens.getPropertyValue(name).trim();
    return animates ? Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000) || 0 : 0;
  };
  return {
    duration: ms("--tab-move-duration"),
    land: ms("--tab-land-duration"),
    easing: tokens.getPropertyValue("--tab-move-easing").trim() || "ease-out",
  };
}

function makeGap(): HTMLElement {
  const gap = document.createElement("div");
  gap.className = "editor-tab-gap";
  return gap;
}

// A gap boxed like a pill takes a pill's share of the strip; held, it keeps a
// width of its own, so it can ease to or from none.
function hold(gap: HTMLElement, width: number): void {
  gap.classList.add("held");
  gap.style.flex = `0 0 ${width}px`;
}

export function createTabDrag(options: TabDragOptions): TabDrag {
  const { host } = options;
  const layer = document.createElement("div");
  layer.className = "editor-tab-drag-layer";
  host.append(layer);

  let gesture: Gesture | undefined;
  let drag: Drag | undefined;
  let landing: Drag | undefined;
  let raf = 0;
  let timing: Timing = { duration: 0, land: 0, easing: "ease-out" };
  // Listened to only while a pill is pressed.
  let pressed: DisposableStore | undefined;
  const pointer = { x: 0, y: 0 };
  // Gaps easing shut, so a return to their strip reopens them where they are.
  const closing = new Map<HTMLElement, Animation>();

  // Positions snapped to the device pixel grid the strips' boxes are painted
  // on: a pill moved by a fraction of a device pixel blurs, lines and text
  // alike. Measured from the layer's own snapped edge.
  const snap = (d: Drag, value: number) => Math.round(value * d.dpr) / d.dpr;
  const snapX = (d: Drag, x: number) => snap(d, d.ox + x) - snap(d, d.ox);
  const snapY = (d: Drag, y: number) => snap(d, d.oy + y) - snap(d, d.oy);

  // A slot's left edge as painted: the edge of the pill before it, which the
  // strip snapped to a device pixel before any step moved it.
  function slotEdge(d: Drag, g: Geometry, k: number): number {
    const laidOut = g.start + g.sums[k] + (k > g.p ? g.width : 0);
    return snapX(d, laidOut) - (k > g.p ? g.step : 0);
  }

  function geometry(
    d: Drag,
    zone: Zone,
    pills: HTMLButtonElement[],
    widths: number[],
    gap: HTMLElement,
    gapLeft: number,
    width: number,
    p: number,
  ): Geometry {
    const n = pills.length;
    const sums = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + widths[i];
    const start = gapLeft - sums[p];
    const bounds = new Float64Array(n);
    for (let k = 0; k < n; k++) bounds[k] = start + sums[k] + (widths[k] + width) / 2;
    const step = Math.round(width * d.dpr) / d.dpr;
    const g: Geometry = {
      zone,
      pills,
      gap,
      n,
      p,
      k: p,
      width,
      step,
      start,
      sums,
      bounds,
      minX: 0,
      maxX: 0,
      grow: undefined,
    };
    // The row's closed ends pin the carried tab on a slot's painted edge, so
    // pinned, it meets its neighbour's separator exactly.
    g.minX = zone.leftOpen ? 0 : Math.max(slotEdge(d, g, 0), zone.left);
    const end = zone.rightOpen ? Number.POSITIVE_INFINITY : Math.min(slotEdge(d, g, n), zone.right - width);
    g.maxX = Math.max(g.minX, Math.min(end, d.layerW - width));
    return g;
  }

  function slotAt(g: Geometry, centre: number): number {
    let k = g.k;
    while (k < g.n && centre > g.bounds[k]) k++;
    while (k > 0 && centre <= g.bounds[k - 1]) k--;
    return k;
  }

  // Only the pills the gap just passed change sides, so only they are
  // written. A 2D translate: once its slide is over, a pill is painted with
  // its strip again, crisp text and all.
  function moveGap(g: Geometry, k: number): void {
    const low = Math.min(k, g.k);
    const high = Math.max(k, g.k);
    for (let i = low; i < high; i++) {
      const dx = g.step * (Number(i >= k) - Number(i >= g.p));
      g.pills[i].style.transform = dx ? `translate(${dx}px, 0)` : "";
    }
    markSlot(g, k);
    g.k = k;
  }

  // The pill after the slot draws the slot's right-hand line (editor-tabs.css);
  // a slot at the end of the row has none.
  function markSlot(g: Geometry, k: number): void {
    unmarkSlot(g);
    if (k < g.n) g.pills[k].classList.add("after-slot");
  }
  function unmarkSlot(g: Geometry): void {
    if (g.k < g.n) g.pills[g.k].classList.remove("after-slot");
  }

  // The strip the pointer is over, or none once it is pulled far enough off
  // every strip. The strip holding the tab keeps it a little longer than
  // another takes it, and keeps it however far the pointer overshoots the
  // row's end: a tab tears off only when pulled away from the row.
  function pick(d: Drag, px: number, py: number): Zone | undefined {
    let best: Zone | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const zone of d.zones) {
      const own = zone === d.at;
      const dx = Math.max(zone.left - px, 0, px - zone.right);
      const dy = Math.max(zone.top - py, 0, py - zone.bottom);
      if (dx > 0 && !own) continue;
      if (dy > (own ? PULL_PX : PULL_PX / 2)) continue;
      const score = dx + dy - (own ? STICK_PX : 0);
      if (score < bestScore) {
        bestScore = score;
        best = zone;
      }
    }
    return best;
  }

  // The new strip is entered before the old one is left: entering reads the
  // layout, leaving only writes to it.
  function transfer(d: Drag, to: Zone | undefined, px: number): void {
    const old = d.geo;
    d.at = to;
    d.geo = undefined;
    if (to) enter(d, to, px);
    else d.pill.classList.add("floating");
    if (old) leave(old);
    d.jumped = true;
  }

  function closeGap(gap: HTMLElement, from: number): void {
    hold(gap, 0);
    if (!timing.duration) {
      gap.remove();
      return;
    }
    const anim = gap.animate([{ flexBasis: `${from}px` }, { flexBasis: "0px" }], timing);
    closing.set(gap, anim);
    const done = () => {
      if (closing.get(gap) !== anim) return;
      closing.delete(gap);
      gap.remove();
    };
    anim.finished.then(done, () => {});
  }

  // The gap eases shut while the pills that stepped aside step back, on the
  // same curve, so the two motions add up to one. A gap still opening closes
  // from where it got to, read from its animated style: no layout needed.
  function leave(g: Geometry): void {
    let width = g.width;
    if (g.grow?.playState === "running") width = Number.parseFloat(getComputedStyle(g.gap).flexBasis) || width;
    g.grow?.cancel();
    closeGap(g.gap, width);
    for (const pill of g.pills) if (pill.style.transform) pill.style.transform = "";
    unmarkSlot(g);
  }

  function enter(d: Drag, zone: Zone, px: number, forceK?: number): void {
    zone.strip.settle();
    const strip = zone.strip.strip;
    let gap = strip.querySelector<HTMLElement>(":scope > .editor-tab-gap");
    let from = 0;
    if (gap) {
      from = Number.parseFloat(getComputedStyle(gap).flexBasis) || 0;
      closing.get(gap)?.cancel();
      closing.delete(gap);
      gap.classList.remove("held");
      gap.style.flex = "";
    } else {
      gap = makeGap();
      const last = zone.strip.pills().at(-1);
      if (last) last.after(gap);
      else strip.prepend(gap);
    }

    // The row as it will be once the gap is open: the gap takes this strip's
    // share, and every pill's width is read beside it.
    const pills = zone.strip.pills();
    const box = gap.getBoundingClientRect();
    const widths = pills.map((pill) => pill.getBoundingClientRect().width);
    const after = pills.findIndex((pill) => gap.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING);
    const p = after === -1 ? pills.length : after;
    const width = box.width;
    hold(gap, width);
    const g = geometry(d, zone, pills, widths, gap, box.left - d.ox, width, p);
    if (timing.duration) g.grow = gap.animate([{ flexBasis: `${from}px` }, { flexBasis: `${width}px` }], timing);
    d.geo = g;

    // The tab takes this strip's width exactly, or the row would shift by
    // the difference when it lands; the pointer keeps its place along it.
    if (width !== d.width) {
      let was = d.width;
      if (d.widthAnim?.playState === "running") was = d.pill.getBoundingClientRect().width;
      d.widthAnim?.cancel();
      d.grabX *= width / d.width;
      d.width = width;
      d.pill.style.width = `${width}px`;
      const eases = timing.duration > 0 && Math.abs(width - was) > 0.5;
      d.widthAnim = eases ? d.pill.animate([{ width: `${was}px` }, { width: `${width}px` }], timing) : undefined;
    }
    d.pill.classList.remove("floating");
    const x = clamp(px - d.grabX, g.minX, g.maxX);
    moveGap(g, forceK ?? slotAt(g, x + width / 2));
  }

  function requestFrame(): void {
    if (!raf && drag) raf = requestAnimationFrame(frame);
  }

  // Once a frame while a tab is carried: no layout reads, one transform for
  // the carried tab, and a write to another pill only when the gap passes it.
  function frame(now: number): void {
    raf = 0;
    const d = drag;
    if (!d) return;
    const px = pointer.x - d.ox;
    const py = pointer.y - d.oy;
    const over = pick(d, px, py);
    if (over !== d.at) transfer(d, over, px);

    const g = d.geo;
    let x: number;
    let y: number;
    if (g) {
      x = clamp(px - d.grabX, g.minX, g.maxX);
      y = 0;
      const k = slotAt(g, x + g.width / 2);
      if (k !== g.k) moveGap(g, k);
    } else {
      x = clamp(px - d.grabX, 0, d.layerW - d.width);
      y = clamp(py + d.grabB - d.layerH, d.height - d.oy - d.layerH, window.innerHeight - d.oy - d.layerH);
    }

    // Lifting, attaching, tearing off or changing strips moves where the tab
    // belongs all at once. It glides there instead, still following the pointer.
    if (d.jumped) {
      d.jumped = false;
      d.glide = timing.duration ? { dx: d.vx - x, dy: d.vy - y, t0: now } : undefined;
    }
    if (d.glide) {
      const t = Math.min(1, (now - d.glide.t0) / timing.duration);
      const rest = (1 - t) ** 3;
      x += d.glide.dx * rest;
      y += d.glide.dy * rest;
      if (t < 1) requestFrame();
      else d.glide = undefined;
    }

    x = snapX(d, x);
    y = snapY(d, y);
    if (x !== d.vx || y !== d.vy) {
      d.vx = x;
      d.vy = y;
      d.pill.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }

  // The pointer is captured on the host, not the pill: the pill moves between
  // parents during the drag, and an element taken out of the DOM loses its
  // capture. Captured at the lift rather than the press, or the click that
  // ends a plain press would land on the host and never on a ×.
  function lift(): void {
    const g = gesture;
    if (!g) return;
    if (typeof host.setPointerCapture === "function") {
      try {
        host.setPointerCapture(g.id);
      } catch {
        return;
      }
    }
    timing = motion();
    const strips = options.strips();
    for (const strip of strips) strip.settle();

    // Reads: the layout as it stands, once. Nothing reads it again until the
    // tab changes strips.
    const box = layer.getBoundingClientRect();
    const zones: Zone[] = strips.map((strip, i) => {
      const r = strip.strip.getBoundingClientRect();
      return {
        strip,
        left: r.left - box.left,
        right: r.right - box.left,
        top: r.top - box.top,
        bottom: r.bottom - box.top,
        leftOpen: i > 0,
        rightOpen: i < strips.length - 1,
      };
    });
    const home = zones[strips.indexOf(g.strip)];
    const pills = g.strip.pills();
    const p = pills.indexOf(g.pill);
    if (!home || p === -1) return;
    const rects = pills.map((pill) => pill.getBoundingClientRect());
    const r = rects[p];
    const others = pills.filter((pill) => pill !== g.pill);
    const widths = rects.filter((_, i) => i !== p).map((rect) => rect.width);

    // Writes: a gap keeps the pill's place while the pill itself rides the
    // layer, above both strips and clipped by neither.
    g.lifted = true;
    if (g.onClose) options.onPress(g.strip, g.index);
    const gap = makeGap();
    hold(gap, r.width);
    g.pill.before(gap);
    layer.append(g.pill);
    g.pill.classList.add("carried");
    g.pill.style.width = `${r.width}px`;
    host.classList.add("tab-dragging");

    const d: Drag = {
      pill: g.pill,
      home,
      homeIndex: p,
      zones,
      ox: box.left,
      oy: box.top,
      layerW: box.width,
      layerH: box.height,
      vw: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
      grabX: g.x0 - r.left,
      grabB: r.bottom - g.y0,
      width: r.width,
      height: r.height,
      vx: 0,
      vy: 0,
      at: home,
      geo: undefined,
      glide: undefined,
      // The pointer is already a threshold away: the tab catches up by
      // gliding, as it does after any other jump in where it belongs.
      jumped: true,
      cancelled: false,
      widthAnim: undefined,
      landing: undefined,
    };
    drag = d;
    d.vx = snapX(d, r.left - box.left);
    d.pill.style.transform = `translate3d(${d.vx}px, 0, 0)`;
    d.geo = geometry(d, home, others, widths, gap, r.left - box.left, r.width, p);
    markSlot(d.geo, p);
  }

  // The tab eases from wherever it is into its slot, still in the layer. It
  // lands quicker than the row moves, so let go just after a pill stepped
  // aside, it is home first: the DOM changes only once the row is still too,
  // or that pill would jump the rest of its way. The fill holds the tab there.
  function land(d: Drag, cancelled: boolean, animated: boolean): void {
    d.cancelled = cancelled;
    if (cancelled || !d.at) {
      if (d.at === d.home && d.geo) {
        moveGap(d.geo, d.homeIndex);
      } else {
        const old = d.geo;
        d.at = d.home;
        d.geo = undefined;
        enter(d, d.home, 0, d.homeIndex);
        if (old) leave(old);
      }
    }
    const g = d.geo;
    if (!g) return;
    const to = `translate3d(${slotEdge(d, g, g.k)}px, 0, 0)`;
    d.pill.classList.remove("floating");
    d.pill.style.transform = to;
    drag = undefined;
    if (!animated || !timing.land) {
      commit(d);
      return;
    }
    const anim = d.pill.animate([{ transform: `translate3d(${d.vx}px, ${d.vy}px, 0)` }, { transform: to }], {
      duration: timing.land,
      easing: timing.easing,
      fill: "forwards",
    });
    d.landing = anim;
    landing = d;
    const row = rowMotion(d).map((each) => each.finished.catch(() => {}));
    Promise.all([anim.finished, ...row]).then(
      () => {
        if (landing === d) commit(d);
      },
      () => {},
    );
  }

  // What a commit cuts short: the pills stepping aside or back, the gap
  // opening, the tab easing to a strip's width.
  function rowMotion(d: Drag): Animation[] {
    const steps = options
      .strips()
      .flatMap((strip) => strip.pills())
      .flatMap((pill) =>
        pill.getAnimations().filter((each) => each instanceof CSSTransition && each.transitionProperty === "transform"),
      );
    return [...steps, d.geo?.grow, d.widthAnim].filter((each): each is Animation => each?.playState === "running");
  }

  // The transition goes with the transforms, so nothing slides back: the new
  // DOM order puts each pill where its transform held it.
  function commit(d: Drag): void {
    if (landing === d) landing = undefined;
    d.landing?.cancel();
    d.widthAnim?.cancel();
    const g = d.geo;
    if (!g) return;
    const pill = d.pill;
    if (g.k < g.n) g.pills[g.k].before(pill);
    else if (g.n) g.pills[g.n - 1].after(pill);
    else g.zone.strip.strip.prepend(pill);
    g.grow?.cancel();
    closing.delete(g.gap);
    g.gap.remove();
    pill.classList.remove("carried", "floating");
    pill.style.removeProperty("transform");
    pill.style.removeProperty("width");
    host.classList.remove("tab-dragging");
    for (const each of g.pills) each.style.transform = "";
    unmarkSlot(g);
    const moved = g.zone !== d.home || g.k !== d.homeIndex;
    if (!d.cancelled && moved) options.onDrop({ from: d.home.strip, index: d.homeIndex, to: g.zone.strip, at: g.k });
  }

  // The press is over: dropped where the pointer is, or cancelled and sent
  // home. A drop first draws the frame the pointer's last move was owed.
  function finish(cancelled: boolean, animated = true): void {
    const g = gesture;
    if (!g) return;
    endGesture();
    if (!g.lifted || !drag) return;
    if (!cancelled) frame(performance.now());
    land(drag, cancelled, animated);
  }

  function endGesture(): void {
    const g = gesture;
    if (!g) return;
    gesture = undefined;
    pressed?.dispose();
    pressed = undefined;
    if (typeof host.hasPointerCapture === "function" && host.hasPointerCapture(g.id)) host.releasePointerCapture(g.id);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const g = gesture;
    if (!g || event.pointerId !== g.id) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!g.lifted) {
      if (Math.hypot(event.clientX - g.x0, event.clientY - g.y0) < LIFT_PX) return;
      lift();
      if (!g.lifted) return;
    }
    requestFrame();
  }

  // A press on a pill's × is a press on the pill too: moved, it picks the
  // pill up; released in place, its click closes the tab as ever.
  function onPointerDown(event: PointerEvent): void {
    if (gesture || event.button !== 0 || !(event.target instanceof Element)) return;
    let target: Element = event.target;
    // A tab still easing into its slot can be caught: it lands at once, and
    // the press reads what is under the pointer then.
    if (landing) {
      commit(landing);
      target = document.elementFromPoint?.(event.clientX, event.clientY) ?? target;
    }
    const pill = target.closest<HTMLButtonElement>(".editor-tab");
    const strip = pill ? options.strips().find((each) => each.strip === pill.parentElement) : undefined;
    const index = pill && strip ? strip.indexOf(pill) : -1;
    if (!pill || !strip || index === -1) return;
    const onClose = target.closest(".editor-tab-close") !== null;
    gesture = { id: event.pointerId, pill, strip, index, x0: event.clientX, y0: event.clientY, onClose, lifted: false };
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!onClose) options.onPress(strip, index);
    const store = new DisposableStore();
    pressed = store;
    store.add(listen(window, "pointermove", (e) => onPointerMove(e as PointerEvent)));
    store.add(
      listen(window, "pointerup", (e) => {
        if (gesture && (e as PointerEvent).pointerId === gesture.id) finish(false);
      }),
    );
    store.add(
      listen(window, "pointercancel", (e) => {
        if (gesture && (e as PointerEvent).pointerId === gesture.id) finish(true);
      }),
    );
    // Only the host's own loss: a touch gives the pressed pill an implicit
    // capture, which it loses, bubbling, when the host takes over at the lift.
    store.add(
      listen(host, "lostpointercapture", (e) => {
        if (e.target === host && gesture?.lifted && (e as PointerEvent).pointerId === gesture.id) finish(true);
      }),
    );
    store.add(
      listen(
        window,
        "keydown",
        (e) => {
          if ((e as KeyboardEvent).key !== "Escape" || !gesture?.lifted) return;
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        },
        true,
      ),
    );
    // The layout read at the lift no longer holds once the window's width
    // changes: the tab goes home at once.
    store.add(
      listen(window, "resize", () => {
        if (drag && window.innerWidth !== drag.vw) finish(true, false);
      }),
    );
    store.add(listen(window, "blur", () => finish(true)));
  }

  const down = listen(host, "pointerdown", (e) => onPointerDown(e as PointerEvent));

  const involves = (d: Drag, strip: HTMLElement) =>
    d.home.strip.strip === strip || d.at?.strip.strip === strip || d.geo?.zone.strip.strip === strip;

  return {
    release(strip) {
      if (drag && involves(drag, strip)) {
        endGesture();
        land(drag, true, false);
      } else if (landing && involves(landing, strip)) {
        commit(landing);
      }
    },
    dispose() {
      endGesture();
      if (drag) land(drag, true, false);
      if (landing) commit(landing);
      down.dispose();
      layer.remove();
    },
  };
}
