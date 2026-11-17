// The logo's segment colors, as the mark paints them. mark.svg and
// icons.css's --icon-mark-pragma paint these hexes and can't import them,
// so a change to the logo's colors lands in all three, and tokens.css's
// --pragma-* palette is derived from them again.
export const LOGO_COLORS = {
  green: "#0db14c",
  teal: "#4dc4ca",
  cyan: "#11d1e0",
  blue: "#0189d2",
  yellow: "#ecb72b",
  orange: "#f3701f",
  red: "#f0353b",
  crimson: "#cc004e",
} as const;
