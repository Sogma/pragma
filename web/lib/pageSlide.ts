// A subpage slides in over the page it opened from, which drifts a fifth of
// the way left and dims; Back runs the other way. Settings and the space form
// (spaceForm.ts) share it, so their pages move alike.
//
// The page leaving stays painted, inert, under the one arriving until the
// slide ends, so the caller hides it first and this shows it for the ride.

export interface PageSlide {
  /** Slides from `from` to `to`, `opening` when `to` is the subpage, and
   * hides `from` again once the slide ends. */
  run(from: HTMLElement, to: HTMLElement, opening: boolean): void;
  /** Ends a slide at once, as a page change mid-slide must. */
  stop(): void;
}

/** Whether `page` can slide. WAAPI sits outside the stylesheet's
 * reduced-motion override, so the preference is read here. */
export function canSlide(page: HTMLElement): boolean {
  return typeof page.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

export function createPageSlide(): PageSlide {
  let sliding: { animations: Animation[]; leaving: HTMLElement } | undefined;

  function stop(): void {
    if (!sliding) return;
    for (const animation of sliding.animations) animation.cancel();
    sliding.leaving.inert = false;
    sliding = undefined;
  }

  function run(from: HTMLElement, to: HTMLElement, opening: boolean): void {
    stop();
    const [subpage, page] = opening ? [to, from] : [from, to];
    const offscreen = "translateX(100%)";
    const drifted = { transform: "translateX(-20%)", opacity: 0.65 };
    const settled = { transform: "none", opacity: 1 };
    const timing = { duration: 150, fill: "forwards" } as const;
    from.hidden = false;
    from.inert = true;
    const over = subpage.animate(
      { transform: opening ? [offscreen, "none"] : ["none", offscreen] },
      { ...timing, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
    );
    const under = page.animate(opening ? [settled, drifted] : [drifted, settled], {
      ...timing,
      easing: "ease-out",
    });
    sliding = { animations: [over, under], leaving: from };
    over.onfinish = () => {
      from.hidden = true;
      stop();
    };
  }

  return { run, stop };
}
