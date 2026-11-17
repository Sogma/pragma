// Drag-to-resize for a panel edge. Every resizable edge in the app — the
// sidebar's trailing edge, the assistant's leading edge, the console's top
// edge — is the same interaction: press a thin handle, track the pointer on
// `document` until mouseup, write a floored size. Only the axis, the floor,
// where the size is written and whether a drag can hide the panel differ.
import { type Disposable, DisposableStore, listen, toDisposable } from "./disposable.ts";

// How close to a panel's outer edge, in px, the pointer comes before the drag
// hides the panel.
const HIDE_SIZE = 50;

// Holds the resize cursor across the whole document for a drag's duration.
// Tracking happens on `document`, not the handle's 8px strip, so the pointer
// routinely outruns the handle; without this the cursor flips to whatever is
// underneath mid-drag. The class names are the contract with the
// `html.resizing-*` rules in web/styles/panel-resize.css, which pin it.
function lockResizeCursor(axis: ResizeAxis): Disposable {
  const className = `resizing-${axis}`;
  document.documentElement.classList.add(className);
  return toDisposable(() => document.documentElement.classList.remove(className));
}

// The panel floors and caps are tokens rather than literals, so the
// stylesheet and the code that clamps to them cannot drift apart.
export function pixelToken(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

// Named for the cursor keywords they map to (`ew-resize`/`ns-resize`, the
// plain double-headed arrows) rather than "horizontal"/"vertical", which is
// ambiguous about whether it means the handle or the movement.
export type ResizeAxis = "ew" | "ns";

export interface PanelResizeOptions {
  // The thin strip a drag starts on, or the parts of one edge drawn as
  // separate elements: a press on any part that takes the pointer starts the
  // drag, and the parts light as one. Every part gets `.dragging` for the
  // drag's duration, which keeps its accent highlight lit once the pointer
  // has left it.
  handle: HTMLElement | HTMLElement[];
  axis: ResizeAxis;
  // Floor, in px, applied to every size before it reaches apply().
  minSize: number;
  // Called once, at mousedown; the function it returns runs on every
  // mousemove and gives the size the pointer implies, in px. Anything
  // costly that can't change mid-drag — a bounding rect, whose re-layout
  // the drag's own writes would otherwise thrash — belongs in the outer
  // call rather than the returned one.
  beginDrag(): (event: MouseEvent) => number;
  // Writes the floored size wherever this panel keeps it: an element's own
  // width/height, or a CSS custom property when more than one element has
  // to follow it.
  apply(size: number): void;
  // Called once when a drag ends, with the last size apply() got: where a
  // panel remembers it. A press that never moved saves nothing.
  commit?(size: number): void;
  // A side panel the drag can hide, as its toggle does. It hides once the
  // pointer is under HIDE_SIZE from its outer edge, and shows again only back
  // at minSize: one line for both would flicker it under a resting hand. A
  // drag that ends with it hidden commits nothing and hands apply() the size
  // it started at, for the panel to reopen at.
  hide?: {
    isHidden(): boolean;
    setHidden(hidden: boolean): void;
    // Read once, at mousedown, before the drag has written anything.
    size(): number;
  };
}

export function wirePanelResize(options: PanelResizeOptions): Disposable {
  const store = new DisposableStore();
  const parts = [options.handle].flat();
  const mark = (className: string, on: boolean) => {
    for (const part of parts) part.classList.toggle(className, on);
  };
  let drag: DisposableStore | undefined;

  for (const part of parts) {
    store.add(
      listen(part, "mousedown", (event) => {
        event.preventDefault();
        // A second mousedown with no mouseup between (the pointer left the
        // window mid-drag and came back still pressed) would otherwise stack
        // a second set of document listeners on top of the live one.
        drag?.dispose();
        const active = new DisposableStore();
        drag = active;
        mark("dragging", true);
        active.add(() => mark("dragging", false));
        active.add(lockResizeCursor(options.axis));
        const sizeFor = options.beginDrag();
        const { hide } = options;
        const start = hide?.size();
        let last: number | undefined;
        active.add(
          listen(document, "mousemove", (moveEvent) => {
            const size = sizeFor(moveEvent as MouseEvent);
            if (hide) {
              if (!hide.isHidden() && size < HIDE_SIZE) hide.setHidden(true);
              else if (hide.isHidden() && size >= options.minSize) hide.setHidden(false);
              if (hide.isHidden()) return;
            }
            last = Math.max(options.minSize, size);
            options.apply(last);
          }),
        );
        active.add(
          listen(document, "mouseup", () => {
            active.dispose();
            if (hide?.isHidden()) {
              if (start !== undefined) options.apply(start);
            } else if (last !== undefined) {
              options.commit?.(last);
            }
          }),
        );
      }),
    );
    // Parts drawn apart pass the pointer's hover to one another as `.hover`,
    // so they light as one line.
    if (parts.length > 1) {
      store.add(listen(part, "mouseenter", () => mark("hover", true)));
      store.add(listen(part, "mouseleave", () => mark("hover", false)));
    }
  }

  // A drag in flight is deliberately not parented to `store` — one child per
  // mousedown would accumulate there for the widget's whole life, since a
  // store keeps what it is given even after that item disposes itself. This
  // teardown is what still ends a live drag when the widget goes away.
  store.add(() => drag?.dispose());

  return store;
}
