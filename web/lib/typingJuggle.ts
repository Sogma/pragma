// The typing dots' build-up while a reply is on its way: over ten seconds
// chat.css's juggle quickens from its 1.4s loop to 1.2s and its throws rise
// by half, then it holds. Both are multiples of the stylesheet's own, and its
// box is sized for throws raised by half: a higher top needs a taller box.
const BUILD_MS = 10_000;
const TOP_RATE = 1.4 / 1.2;
const TOP_ARC = 1.5;

// playbackRate quickens the loop and keeps each dot's place in it, where a
// new duration would make the dots jump. Showing another chat drops the dots'
// animations and showing theirs again starts new ones, so every frame sets
// the rate on whichever run, until the dots leave their thread.
export function buildUpJuggle(dots: HTMLElement): void {
  if (typeof dots.getAnimations !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    return;
  }
  const start = performance.now();
  const step = (now: number): void => {
    if (!dots.parentNode) return;
    const t = Math.max(0, Math.min(1, (now - start) / BUILD_MS));
    const ease = t * t * (3 - 2 * t);
    const rate = 1 + (TOP_RATE - 1) * ease;
    for (const animation of dots.getAnimations({ subtree: true })) {
      if (animation.playbackRate !== rate) animation.playbackRate = rate;
    }
    dots.style.setProperty("--juggle-arc", String(1 + (TOP_ARC - 1) * ease));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
