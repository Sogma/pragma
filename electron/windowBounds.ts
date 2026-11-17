// Where a window saved last session opens now. The screen it was on may be
// gone, a monitor unplugged, or smaller than it was, and a frameless window
// whose header is out of reach can't be dragged back: the saved size and
// place are held to the screens there are now. No electron import, so the
// rule runs under the unit tests.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

// How much of a window stays on its screen at each edge but the top, which
// keeps the header: enough of the header to grab and drag the window back.
const REACH = 128;

/** The saved bounds as the window can open at them: on the screen whose work
 * area it overlaps most, sized to fit it, its header inside and `REACH` of it
 * in view at the other edges. A window on no screen keeps its size, held to
 * the primary screen, and no place, so the system centers it. */
export function boundsOnScreen(
  saved: WindowBounds | undefined,
  screens: readonly Rect[],
  primary: Rect,
  fallback: { width: number; height: number },
): WindowBounds {
  const fitted = (width: number, height: number, area: Rect) => ({
    width: Math.min(width, area.width),
    height: Math.min(height, area.height),
  });
  if (!saved || !isLength(saved.width) || !isLength(saved.height)) {
    return fitted(fallback.width, fallback.height, primary);
  }
  const { width, height, x, y } = saved;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fitted(width, height, primary);
  const area = mostOverlapped({ x: x as number, y: y as number, width, height }, screens);
  if (!area) return fitted(width, height, primary);
  const size = fitted(width, height, area);
  return {
    ...size,
    x: Math.min(Math.max(x as number, area.x - size.width + REACH), area.x + area.width - REACH),
    y: Math.min(Math.max(y as number, area.y), area.y + area.height - REACH),
  };
}

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function mostOverlapped(window: Rect, screens: readonly Rect[]): Rect | undefined {
  let best: Rect | undefined;
  let most = 0;
  for (const screen of screens) {
    const width = Math.min(window.x + window.width, screen.x + screen.width) - Math.max(window.x, screen.x);
    const height = Math.min(window.y + window.height, screen.y + screen.height) - Math.max(window.y, screen.y);
    if (width > 0 && height > 0 && width * height > most) {
      most = width * height;
      best = screen;
    }
  }
  return best;
}
