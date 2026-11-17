// Hover hints pragma draws itself instead of the browser's `title` tooltip:
// one shared, themed element, shown for the nearest element under the
// pointer that has something to say. An element opts in by attribute alone,
// so a view that rebuilds its rows needs no wiring:
//
//   .icon-button[aria-label]   its accessible name, so the two can't drift
//   data-tooltip="…"           fixed text, over the name where they differ
//   data-tooltip-overflow      its own text, or a field's value, while cut off
//   data-tooltip-side          "right" or "left": beside the element, not below
//   data-tooltip-wait          on a list: each hint in it waits out the delay
//
// Never `title` beside them: the browser would draw its own on top.

import { type Disposable, DisposableStore, listen } from "./disposable.ts";

const SELECTOR = "[data-tooltip], [data-tooltip-overflow], .icon-button[aria-label]";
export const TOOLTIP_DELAY_MS = 500;
// After a tooltip closes because the pointer moved on, the next one opens at
// once, so sliding along a row of icons reads each without waiting again.
const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

function tooltipText(el: HTMLElement): string {
  if (el.dataset.tooltip) return el.dataset.tooltip;
  if (el.dataset.tooltipOverflow !== undefined && el.scrollWidth > el.clientWidth) return ownText(el);
  if (el.classList.contains("icon-button")) return el.getAttribute("aria-label") ?? "";
  return "";
}

// A field's text is its value, and one being typed in shows it already.
function ownText(el: HTMLElement): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return el.textContent ?? "";
  return el === document.activeElement ? "" : el.value;
}

// Walks past an overflow element that isn't cut off, so a name inside a row
// that has a hint of its own falls back to the row's.
function anchorFor(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? target.closest<HTMLElement>(SELECTOR) : null;
  while (el && !tooltipText(el)) el = el.parentElement?.closest<HTMLElement>(SELECTOR) ?? null;
  return el;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

// Centered below the anchor, above it where it won't fit, and never past the
// window's edges. Beside it in a column of icons, the rail on the left or
// the Format column on the right, where one below would cover the next
// icon, unless there's no room on that side.
function place(tip: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const side = anchor.dataset.tooltipSide;
  let beside: number | undefined;
  if (side === "right" && rect.right + GAP + width <= window.innerWidth - MARGIN) beside = rect.right + GAP;
  if (side === "left" && rect.left - GAP - width >= MARGIN) beside = rect.left - GAP - width;
  if (beside !== undefined) {
    const top = clamp(rect.top + rect.height / 2 - height / 2, MARGIN, window.innerHeight - MARGIN - height);
    tip.style.left = `${beside}px`;
    tip.style.top = `${top}px`;
    return;
  }
  const left = clamp(rect.left + rect.width / 2 - width / 2, MARGIN, window.innerWidth - MARGIN - width);
  let top = rect.bottom + GAP;
  if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, rect.top - GAP - height);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// The installed tooltip, for a control a drag brings in under a held button,
// which a hover never reaches.
let installed: { show(anchor: HTMLElement): void; close(): void } | undefined;

/** Shows `anchor`'s tooltip at once, as a hover would after its delay. */
export function showTooltipFor(anchor: HTMLElement): void {
  installed?.show(anchor);
}

export function closeTooltip(): void {
  installed?.close();
}

/** Starts drawing tooltips for the whole document. Call once, at boot. */
export function installTooltips(): Disposable {
  const store = new DisposableStore();
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.id = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  store.add(() => tip.remove());

  let anchor: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let timer = 0;
  let closedAt = Number.NEGATIVE_INFINITY;
  let describes = false;
  // A click or a key closes the tooltip on that element until the pointer
  // moves to another one, as the browser's own does.
  let dismissed: HTMLElement | null = null;

  // While one is showing: an anchor a re-render removed takes its tooltip
  // with it, and a hint that changes underneath it (a save status) updates.
  const watcher = new MutationObserver(() => {
    if (!anchor) return;
    const text = anchor.isConnected ? tooltipText(anchor) : "";
    if (!text) close();
    else if (text !== tip.textContent) {
      tip.textContent = text;
      place(tip, anchor);
    }
  });
  store.add(() => watcher.disconnect());

  // `instant` skips the fade, for a tooltip that follows another closely.
  function show(next: HTMLElement, instant = false): void {
    pending = null;
    const text = tooltipText(next);
    if (!text) return;
    tip.textContent = text;
    tip.classList.toggle("is-instant", instant);
    tip.hidden = false;
    place(tip, next);
    anchor = next;
    // A tip that repeats the name would be read out twice.
    describes = !next.hasAttribute("aria-describedby") && text !== next.getAttribute("aria-label");
    if (describes) next.setAttribute("aria-describedby", tip.id);
    watcher.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-tooltip", "aria-label"],
    });
  }

  function close(): void {
    window.clearTimeout(timer);
    pending = null;
    if (!anchor) return;
    if (describes) anchor.removeAttribute("aria-describedby");
    anchor = null;
    tip.hidden = true;
    closedAt = performance.now();
    watcher.disconnect();
  }

  function hover(next: HTMLElement | null): void {
    if (next && (next === anchor || next === pending)) return;
    if (next !== dismissed) dismissed = null;
    const warm = anchor !== null || performance.now() - closedAt < WARM_MS;
    close();
    if (!next || next === dismissed) return;
    if (warm && !next.closest("[data-tooltip-wait]")) {
      show(next, true);
    } else {
      pending = next;
      timer = window.setTimeout(() => show(next), TOOLTIP_DELAY_MS);
    }
  }

  function dismiss(): void {
    dismissed = anchor ?? pending;
    close();
    closedAt = Number.NEGATIVE_INFINITY;
  }

  // Touch has no hover, and a pressed button is a selection or a drag in
  // progress, not a pause over a control.
  store.add(
    listen(document, "pointerover", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === "touch" || pointer.buttons !== 0) return;
      hover(anchorFor(pointer.target));
    }),
  );
  store.add(
    listen(document, "pointerout", (event) => {
      if ((event as PointerEvent).relatedTarget === null) hover(null);
    }),
  );
  for (const type of ["pointerdown", "keydown", "wheel", "scroll", "dragstart"]) {
    store.add(listen(document, type, dismiss, { capture: true, passive: true }));
  }
  store.add(listen(window, "blur", close));

  // Keyboard focus shows a control's own hint at once; a click's focus does
  // not, since :focus-visible is false for it.
  store.add(
    listen(document, "focusin", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      if (!target.matches(SELECTOR) || !tooltipText(target)) return;
      close();
      show(target);
    }),
  );
  store.add(
    listen(document, "focusout", (event) => {
      if (event.target === anchor) close();
    }),
  );

  installed = { show: (next) => show(next, true), close };
  store.add(() => {
    installed = undefined;
  });
  store.add(close);
  return store;
}
