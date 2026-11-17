// A canvas's frame stats (Settings → Advanced → Show stats): how many
// frames the page drew in the last half second, as a rate, and the longest
// gap between two of them, the number a stall shows up in. It counts only
// while the readout is on screen and the switch is on, so a hidden one asks
// for no frames at all.
import type { Disposable } from "./disposable.ts";

export interface StatsSwitch {
  subscribe(listener: (on: boolean) => void): () => void;
}

const WINDOW_MS = 500;

export function bindFrameStats(readout: HTMLElement, enabled: StatsSwitch): Disposable {
  let on = false;
  // Without an observer to ask (a test's DOM), the readout counts as seen.
  let seen = typeof IntersectionObserver === "undefined";
  let raf = 0;
  let last = 0;
  let windowStart = 0;
  let frames = 0;
  let longest = 0;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (last !== 0) {
      frames++;
      longest = Math.max(longest, now - last);
    } else {
      windowStart = now;
    }
    last = now;
    if (now - windowStart < WINDOW_MS || frames === 0) return;
    readout.textContent = `${Math.round((frames * 1000) / (now - windowStart))} fps · ${Math.round(longest)} ms`;
    windowStart = now;
    frames = 0;
    longest = 0;
  };

  const update = () => {
    if (on && seen && raf === 0) {
      last = 0;
      frames = 0;
      longest = 0;
      readout.textContent = "-- fps · -- ms";
      raf = requestAnimationFrame(tick);
    } else if (!(on && seen) && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          seen = entries.some((entry) => entry.isIntersecting);
          update();
        });
  observer?.observe(readout);
  const unsubscribe = enabled.subscribe((value) => {
    on = value;
    readout.hidden = !value;
    update();
  });

  return {
    dispose() {
      unsubscribe();
      observer?.disconnect();
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
