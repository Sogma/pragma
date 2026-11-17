// A video's "K" sizes by short side: 4K is UHD's 3840 × 2160, and 2K sits
// above 1080p wherever a model lists both, so it is 2560 × 1440. An image
// model's 2K is a 2048 long side instead; this never reads one.
const K_SHORT_SIDES: Record<string, number> = { "2": 1440, "4": 2160 };

/** The short side, in pixels, a video resolution is written as: `720p` and
 * a bare `768` by their number, `2K` and `4K` by their sizes, and a frame
 * size such as `1280x720` by its smaller side. A portrait clip's 720p is 720
 * across. Undefined for anything else. */
export function resolutionShortSide(text: string): number | undefined {
  const written = text.trim();
  const size = /^(\d+)x(\d+)$/i.exec(written);
  if (size) return Math.min(Number(size[1]), Number(size[2])) || undefined;
  const lines = /^(\d+)p?$/i.exec(written);
  if (lines) return Number(lines[1]) || undefined;
  const k = /^(\d)k$/i.exec(written);
  return k ? K_SHORT_SIDES[k[1]] : undefined;
}

/** How a short side is said: `4K` and `2K` by name, any other as `720p`. */
export function resolutionName(shortSide: number): string {
  const k = Object.keys(K_SHORT_SIDES).find((digit) => K_SHORT_SIDES[digit] === shortSide);
  return k ? `${k}K` : `${shortSide}p`;
}

/** A resolution as the AI SDK takes one, a frame size: the 16:9 landscape
 * frame of that short side, `1280x720` for 720p, whatever the aspect ratio.
 * The SDK's own Veo adapter reads exactly those sizes as its tiers. */
export function resolutionSize(shortSide: number): `${number}x${number}` {
  return `${2 * Math.round((shortSide * 8) / 9)}x${shortSide}`;
}

/** The name in `listed` nearest `shortSide`, the smaller of two as near; a
 * listed name that is no size is passed over. */
export function nearestResolution(shortSide: number, listed: readonly string[]): string | undefined {
  let best: { name: string; side: number } | undefined;
  for (const name of listed) {
    const side = resolutionShortSide(name);
    if (side === undefined) continue;
    const gap = Math.abs(side - shortSide);
    const bestGap = best ? Math.abs(best.side - shortSide) : Infinity;
    if (gap < bestGap || (best && gap === bestGap && side < best.side)) best = { name, side };
  }
  return best?.name;
}
