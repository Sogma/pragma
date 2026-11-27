// Where wires meet on a card whose own pins are hidden, a collapsed card's
// title or a folded settings group's summary: a small pin per wire, stacked
// along the card's edge in its type's color, each its own wire's end. The
// canvas measures them as it measures pins, ahead of the hidden ones.
import { getHandleBounds, type Handle, Position, type HandleType as XYHandleType } from "@xyflow/system";
import type { FlowPortType } from "../../src/protocol/types.ts";

export interface JoinedPin {
  id: string;
  type: FlowPortType;
}

// Each pin sits this far below the last, overlapping it.
const STEP = 8;

/** One side's joined pins, centered on where the wires meet. */
export function joinedPins(pins: readonly JoinedPin[], side: XYHandleType): HTMLElement[] {
  return pins.map((pin, index) => {
    const el = document.createElement("span");
    el.className = `flow-joined-pin ${side} type-${pin.type}`;
    el.dataset.handleid = pin.id;
    el.style.setProperty("--join-offset", `${(index - (pins.length - 1) / 2) * STEP}px`);
    return el;
  });
}

// Whether a pin shows. One the card hides stays out of the measure, or a
// connection drag ending near where it measures would snap to it.
// checkVisibility is missing where nothing is laid out, as in jsdom.
function shows(pin: Element): boolean {
  return typeof pin.checkVisibility !== "function" || pin.checkVisibility();
}

/** A card's pins as the canvas places wire ends: its joined pins first, then
 * each of its own that shows, so a wire never ends on a hidden pin. */
export function measureHandles(
  el: HTMLDivElement,
  rect: DOMRect,
  scale: number,
  nodeId: string,
  type: XYHandleType,
): Handle[] {
  const joined = [...el.querySelectorAll<HTMLElement>(`.flow-joined-pin.${type}`)].map((pin): Handle => {
    const box = pin.getBoundingClientRect();
    return {
      id: pin.dataset.handleid ?? null,
      nodeId,
      type,
      position: type === "target" ? Position.Left : Position.Right,
      x: (box.left - rect.left) / scale,
      y: (box.top - rect.top) / scale,
      width: box.width / scale,
      height: box.height / scale,
    };
  });
  // getHandleBounds measures the same query, so its entries line up with it.
  const pins = el.querySelectorAll(`.${type}`);
  const own = (getHandleBounds(type, el, rect, scale, nodeId) ?? []).filter((_, index) => shows(pins[index]));
  return [...joined, ...own];
}

/** One point per side where every wire into a collapsed card meets when no
 * joined pin names its port: the handle lookup falls back to an id-less entry. */
export function meetingPoint(nodeId: string, type: XYHandleType, x: number, y: number): Handle {
  const position = type === "target" ? Position.Left : Position.Right;
  return { id: null, nodeId, type, position, x, y, width: 0, height: 0 };
}
