// Color math on hex colors: the text color that reads on a picked
// background, and a color's OKLab coordinates for averaging two of them.

const DARK_TEXT = "#1a1a1a";
const LIGHT_TEXT = "#f5f5f5";

// The readable text color against an arbitrary background hex — used wherever
// a user-picked color fills the whole element a text label sits on (a flow
// node's title bar, a tag pill), as opposed to a swatch that sits beside
// always-muted label text and so never needs this.
//
// Chosen by APCA lightness contrast, not the WCAG 2 ratio, which rates dark
// text above light on saturated mid-tones (red, orange, green, blue) where
// light reads better. LIGHT_TEXT_LEAN tilts it further: dark text wins only
// with that many times light text's contrast. Both were tuned by eye against
// the color picker's presets, so 1 is not the neutral "correct" value.
const LIGHT_TEXT_LEAN = 1.68;

export function readableTextColor(hex: string): string {
  return apcaContrast(DARK_TEXT, hex) >= LIGHT_TEXT_LEAN * apcaContrast(LIGHT_TEXT, hex) ? DARK_TEXT : LIGHT_TEXT;
}

// |Lc| from APCA-W3 0.0.98G-4g. Its own luminance (a plain 2.4 power curve,
// its own coefficients) is not WCAG's relative luminance; the constants only
// hold together as a set.
function apcaContrast(text: string, background: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255) ** 2.4);
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: APCA's exponent is 1.414, not √2.
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  };
  const textY = luminance(text);
  const backgroundY = luminance(background);
  if (Math.abs(backgroundY - textY) < 0.0005) return 0;
  const sapc =
    backgroundY > textY ? (backgroundY ** 0.56 - textY ** 0.57) * 1.14 : (textY ** 0.62 - backgroundY ** 0.65) * 1.14;
  return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
}

function linearRgb(hex: string): number[] {
  return [1, 3, 5].map((at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

// OKLab is perceptual: an average of two colors taken in it passes through the
// hues between them, where an sRGB average of opposite hues goes muddy grey.
export function hexToOklab(hex: string): [number, number, number] {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
