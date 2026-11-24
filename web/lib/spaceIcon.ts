import { must } from "./dom.ts";

// Pragma's signature, a cube inside a hexagon. Where it's lit (the rail while
// the Space view is open, a dialog's title) sidebar.css shades each part by its
// class: the hexagon and spokes in blue, the cube in crimson.
//
// Each part is its own round-ended stroke, not a clip of one shape, so the icon
// in one colour shows no seams and two copies on a page share no ids. Where two
// parts meet, the later one's round end covers the earlier's, so this order
// sets the colour at each corner, and the spokes and the cube's inner edges go
// under the outlines they end on.
export const SPACE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path class="space-icon-spoke-top" d="M12 7.25V2.482" />
  <path class="space-icon-spoke-top-right" d="M16.114 9.625L20.243 7.241" />
  <path class="space-icon-spoke-bottom-right" d="M16.114 14.375L20.243 16.759" />
  <path class="space-icon-spoke-bottom" d="M12 16.75V21.518" />
  <path class="space-icon-spoke-bottom-left" d="M7.886 14.375L3.757 16.759" />
  <path class="space-icon-spoke-top-left" d="M7.886 9.625L3.757 7.241" />
  <path class="space-icon-side-top-left" d="M8.449 4.3L11.25 2.683A1.5 1.5 0 0 1 12 2.482" />
  <path class="space-icon-side-top-right" d="M12 2.482A1.5 1.5 0 0 1 12.75 2.683L19.694 6.692A1.5 1.5 0 0 1 20.243 7.241" />
  <path class="space-icon-side-right" d="M20.243 7.241A1.5 1.5 0 0 1 20.444 7.991V16.009A1.5 1.5 0 0 1 20.243 16.759" />
  <path class="space-icon-side-bottom-right" d="M20.243 16.759A1.5 1.5 0 0 1 19.694 17.308L18.582 17.95M15.551 19.7L12.75 21.317A1.5 1.5 0 0 1 12 21.518" />
  <path class="space-icon-side-bottom-left" d="M12 21.518A1.5 1.5 0 0 1 11.25 21.317L4.306 17.308A1.5 1.5 0 0 1 3.757 16.759" />
  <path class="space-icon-side-left" d="M3.757 16.759A1.5 1.5 0 0 1 3.556 16.009V7.991A1.5 1.5 0 0 1 3.757 7.241" />
  <path class="space-icon-side-top-left" d="M3.757 7.241A1.5 1.5 0 0 1 4.306 6.692L5.418 6.05" />
  <path class="space-icon-edge-top-left" d="M12 12L7.886 9.625" />
  <path class="space-icon-edge-top-right" d="M12 12L16.114 9.625" />
  <path class="space-icon-edge-bottom" d="M12 12V16.75" />
  <path class="space-icon-face-top" d="M12 7.25L16.114 9.625" />
  <path class="space-icon-face-right" d="M16.114 9.625V14.375L12 16.75" />
  <path class="space-icon-face-left" d="M12 16.75L7.886 14.375V9.625" />
  <path class="space-icon-face-top" d="M7.886 9.625L12 7.25" />
</svg>`;

/** The Space icon as an element, for a surface that takes a node. */
export function createSpaceIcon(): SVGSVGElement {
  const template = document.createElement("template");
  // Without the markup's line breaks, which as text would join the text of
  // whatever it sits in, a dialog's title.
  template.innerHTML = SPACE_ICON.replace(/>\s+</g, "><");
  return must<SVGSVGElement>("svg", template.content);
}
