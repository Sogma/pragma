// Every link out of Pragma goes through here: a new browser tab, or the
// system browser in the desktop app (electron/main.ts). It gets neither this
// page as its opener nor its address as the referrer, so a site never learns
// that a Pragma is served at that local address.

/** Makes `link` open outside Pragma. Any element, so a MathJax link counts. */
export function markExternalLink<T extends Element>(link: T): T {
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  return link;
}

/** Opens `url` outside Pragma. */
export function openExternalLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
