import { must } from "./dom.ts";

// Pragma's signature, so where it's lit (the rail while the Space view is
// open, a dialog's title) its rings and arcs take the palette's colours
// (sidebar.css). Each arc ends under the next ring's stroke and comes first,
// so the ring, in another colour, covers the arc's round end.
export const SPACE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path class="space-icon-arc-right" d="M16.493 6.381A8 8 0 0 1 19.768 14.913" />
  <path class="space-icon-arc-bottom" d="M15.486 20.201A8 8 0 0 1 6.46 18.771" />
  <path class="space-icon-arc-left" d="M4.021 12.419A8 8 0 0 1 9.772 5.316" />
  <circle cx="12" cy="13" r="2.25" />
  <circle class="space-icon-ring-top" cx="12" cy="5" r="2.25" />
  <circle class="space-icon-ring-right" cx="18.928" cy="17" r="2.25" />
  <circle class="space-icon-ring-left" cx="5.072" cy="17" r="2.25" />
</svg>`;

/** The Space icon as an element, for a surface that takes a node. */
export function createSpaceIcon(): SVGSVGElement {
  const template = document.createElement("template");
  // Without the markup's line breaks, which as text would join the text of
  // whatever it sits in, a dialog's title.
  template.innerHTML = SPACE_ICON.replace(/>\s+</g, "><");
  return must<SVGSVGElement>("svg", template.content);
}
