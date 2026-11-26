// A header lying over the top of a scroller, which scrolls on under it and
// shows through frosted; the header lifts off once the scroller's rows reach
// it (web/styles/frost-header.css).
import { el } from "./dom.ts";

/** A header for `scroller`, laid just before it in the parent that holds
 * both. `className` gives the header its own layout. The scroller's own rule
 * pads its top, and its scroll padding, to clear the header. */
export function createFrostHeader(scroller: HTMLElement, className: string): HTMLDivElement {
  if (!scroller.parentElement) throw new Error(`no parent to lay the ${className} in: place its scroller first`);
  scroller.classList.add("frost-header-scroller");
  const header = el("div", `frost-header ${className}`);
  scroller.before(header);
  return header;
}
