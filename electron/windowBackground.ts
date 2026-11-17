// The colour a window shows until its page first paints, and at an edge it
// grows into before the page catches up. Left to Electron it is white, a
// flash on the dark theme, so it is the page's own background instead. No
// electron import, so the unit tests hold it to the stylesheet.

/** web/styles/tokens.css's `--bg-primary` in the theme Electron resolved. */
export function windowBackground(theme: { shouldUseDarkColors: boolean }): string {
  return theme.shouldUseDarkColors ? "#101111" : "#fff";
}
