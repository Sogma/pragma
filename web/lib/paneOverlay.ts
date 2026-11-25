// What a pane shows over itself, one item of its list at a time: a backdrop
// dimming the pane, arrows stepping through the list, and a stage holding
// the item. It lies inside the pane's box, so closing it returns to the same
// scroll and selection. The caller builds each item and decides what else
// closes it; a gallery's file and a row's card both show this way.

import { canAnimate } from "./pictureZoom.ts";

export interface PaneOverlayDeps {
  /** The pane's box, which the overlay fills. */
  host: HTMLElement;
  /** The caller's class stem, beside the overlay's own: `<stem>` on the
   * backdrop, `<stem>-stage` and `<stem>-nav` on its parts. */
  stem: string;
  count(): number;
  /** Whether the list's item at `index` shows; one that doesn't is stepped
   * past. */
  showable(index: number): boolean;
  /** Builds the item at `index` for the stage. */
  render(index: number): HTMLElement;
  /** Lets the shown item go: before another replaces it, and once a close
   * has faded. */
  release(): void;
  /** The item at `index` is the one shown. */
  shown?(index: number): void;
  /** A close is starting, before its fade. */
  closing?(): void;
  /** Puts focus back when a close asks for it. */
  refocus(): void;
}

export interface PaneOverlay {
  /** The backdrop, its stage and its arrows. */
  readonly element: HTMLElement;
  readonly stage: HTMLElement;
  readonly prev: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  /** The index of the item shown, or undefined while closed. */
  shownIndex(): number | undefined;
  show(index: number): void;
  step(direction: 1 | -1): void;
  close(refocus?: boolean): void;
  /** The list changed under the overlay, and its item is at `index` now. */
  moved(index: number): void;
  /** Ends a close's fade at once. */
  settle(): void;
  dispose(): void;
}

// Out of the tab order, and a click never takes focus: the pane's keys step
// the overlay only while the pane itself is focused.
function arrowButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.tabIndex = -1;
  button.setAttribute("aria-label", label);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

/** The rest of a click run whose first click closed an overlay lands on
 * whatever lies there now: what the pane lists, or a button of the group's
 * toolbar the backdrop covered. None of it may press anything, so the
 * window takes it until a press starts a new run. */
export function swallowRest(): void {
  const swallow = (event: MouseEvent) => {
    if (event.detail < 2) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const disarm = (event: MouseEvent) => {
    if (event.detail > 1) return;
    for (const type of ["click", "dblclick"] as const) window.removeEventListener(type, swallow, true);
    window.removeEventListener("mousedown", disarm, true);
  };
  for (const type of ["click", "dblclick"] as const) window.addEventListener(type, swallow, true);
  window.addEventListener("mousedown", disarm, true);
}

// Opening, the backdrop and its controls fade in as the item grows from just
// under its size; closing runs the same way back, a little quicker. A step
// to another item swaps at once, so browsing stays quick.
const OPENING: KeyframeAnimationOptions = { duration: 150, easing: "cubic-bezier(0.33, 1, 0.68, 1)" };
const CLOSING: KeyframeAnimationOptions = { duration: 120, easing: "cubic-bezier(0.32, 0, 0.67, 0)", fill: "forwards" };
const AWAY: Keyframe = { opacity: 0, transform: "scale(0.95)" };
const ARRIVED: Keyframe = { opacity: 1, transform: "none" };

export function createPaneOverlay(deps: PaneOverlayDeps): PaneOverlay {
  const { stem } = deps;
  const element = document.createElement("div");
  element.className = `pane-overlay ${stem}`;
  element.hidden = true;
  const stage = document.createElement("div");
  stage.className = `pane-overlay-stage ${stem}-stage`;
  const prev = arrowButton(`pane-overlay-nav ${stem}-nav is-prev`, "Previous");
  const next = arrowButton(`pane-overlay-nav ${stem}-nav is-next`, "Next");
  element.append(prev, stage, next);
  deps.host.append(element);

  let shownIndex: number | undefined;
  // A close's fade, until it ends or a new item cuts it short.
  let closing: Animation[] | undefined;

  function releaseStage(): void {
    deps.release();
    stage.replaceChildren();
  }

  function showableFrom(index: number, direction: 1 | -1): number | undefined {
    for (let at = index + direction; at >= 0 && at < deps.count(); at += direction) {
      if (deps.showable(at)) return at;
    }
    return undefined;
  }

  function markEnds(index: number): void {
    prev.setAttribute("aria-disabled", String(showableFrom(index, -1) === undefined));
    next.setAttribute("aria-disabled", String(showableFrom(index, 1) === undefined));
  }

  function show(index: number): void {
    if (!deps.showable(index)) return;
    const opening = shownIndex === undefined;
    settle();
    releaseStage();
    const frame = deps.render(index);
    stage.append(frame);
    element.hidden = false;
    shownIndex = index;
    markEnds(index);
    deps.shown?.(index);
    if (opening && canAnimate(element)) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], OPENING);
      frame.animate([AWAY, ARRIVED], OPENING);
    }
  }

  // Closing, the overlay takes no pointer or focus and hands focus back at
  // once, so its fade never catches what follows (dialog.css says why a
  // dialog doesn't fade out). The item is let go, and the fade's held end
  // dropped, once it ends.
  function close(refocus = true): void {
    if (shownIndex === undefined) return;
    shownIndex = undefined;
    deps.closing?.();
    const frame = stage.firstElementChild;
    if (frame instanceof HTMLElement && canAnimate(element)) {
      element.inert = true;
      const fades = [element.animate([{ opacity: 0 }], CLOSING), frame.animate([AWAY], CLOSING)];
      closing = fades;
      Promise.all(fades.map((fade) => fade.finished)).then(
        () => {
          if (closing === fades) settle();
        },
        () => undefined,
      );
    } else {
      releaseStage();
      element.hidden = true;
    }
    if (refocus) deps.refocus();
  }

  function settle(): void {
    const fades = closing;
    if (!fades) return;
    closing = undefined;
    releaseStage();
    element.hidden = true;
    element.inert = false;
    for (const fade of fades) fade.cancel();
  }

  function step(direction: 1 | -1): void {
    const at = shownIndex === undefined ? undefined : showableFrom(shownIndex, direction);
    if (at !== undefined) show(at);
  }

  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));

  return {
    element,
    stage,
    prev,
    next,
    shownIndex: () => shownIndex,
    show,
    step,
    close,
    moved(index) {
      shownIndex = index;
      markEnds(index);
    },
    settle,
    dispose() {
      close(false);
      settle();
      element.remove();
    },
  };
}
