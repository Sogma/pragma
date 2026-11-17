import { describe, expect, it } from "vitest";
import { boundsOnScreen, type Rect } from "../../electron/windowBounds.ts";

// A laptop screen with a taskbar along its bottom, and a monitor to its right.
const laptop: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const monitor: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };
const fallback = { width: 1280, height: 800 };

describe("boundsOnScreen", () => {
  it("keeps a window that sits on a screen as it was saved", () => {
    const saved = { width: 1400, height: 900, x: 2100, y: 120 };
    expect(boundsOnScreen(saved, [laptop, monitor], laptop, fallback)).toEqual(saved);
  });

  it("drops the place of a window saved on a screen since unplugged, keeping its size", () => {
    const saved = { width: 1400, height: 900, x: 2100, y: 120 };
    expect(boundsOnScreen(saved, [laptop], laptop, fallback)).toEqual({ width: 1400, height: 900 });
  });

  it("drops the place Windows gives a minimized window", () => {
    const saved = { width: 1400, height: 900, x: -32000, y: -32000 };
    expect(boundsOnScreen(saved, [laptop, monitor], laptop, fallback)).toEqual({ width: 1400, height: 900 });
  });

  it("shrinks a window bigger than the screen it lands on", () => {
    const saved = { width: 2400, height: 1300, x: 0, y: 0 };
    expect(boundsOnScreen(saved, [laptop], laptop, fallback)).toEqual({ width: 1920, height: 1040, x: 0, y: 0 });
  });

  it("brings the header back down onto the screen, and enough of the window into view", () => {
    expect(boundsOnScreen({ width: 1000, height: 700, x: 300, y: -200 }, [laptop], laptop, fallback)).toEqual({
      width: 1000,
      height: 700,
      x: 300,
      y: 0,
    });
    expect(boundsOnScreen({ width: 1000, height: 700, x: 1900, y: 1000 }, [laptop], laptop, fallback)).toEqual({
      width: 1000,
      height: 700,
      x: 1920 - 128,
      y: 1040 - 128,
    });
  });

  it("goes by the screen a window spanning two overlaps most", () => {
    const saved = { width: 1600, height: 900, x: 1500, y: 100 };
    expect(boundsOnScreen(saved, [laptop, monitor], laptop, fallback)).toEqual(saved);
    expect(boundsOnScreen({ ...saved, y: -300 }, [laptop, monitor], laptop, fallback)).toEqual({ ...saved, y: 0 });
  });

  it("opens at the default size, centered, with nothing saved or something unreadable saved", () => {
    expect(boundsOnScreen(undefined, [laptop], laptop, fallback)).toEqual(fallback);
    expect(boundsOnScreen({ width: Number.NaN, height: 900 }, [laptop], laptop, fallback)).toEqual(fallback);
    expect(boundsOnScreen({ width: 1400, height: 900, x: Number.NaN, y: 4 }, [laptop], laptop, fallback)).toEqual({
      width: 1400,
      height: 900,
    });
    expect(
      boundsOnScreen(
        undefined,
        [{ ...laptop, width: 1024, height: 700 }],
        { ...laptop, width: 1024, height: 700 },
        fallback,
      ),
    ).toEqual({
      width: 1024,
      height: 700,
    });
  });
});
